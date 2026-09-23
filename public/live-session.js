/* =============================================================================
 * live-session.js — Sesiones en vivo (WebRTC), browser side
 * =============================================================================
 * DAY 4: camera/mic capture, permission-error handling, and the call overlay.
 * DAY 5: the signaling client + RTCPeerConnection — real media between browsers.
 * DAY 6: ringtone, <title> flash, vibration, and the SPA entry points.
 * DAY 7: TURN — ICE servers fetched from the server, never hardcoded.
 * DAY 8: resilience — ICE restart, stall detection, backgrounding.
 *
 * WHY THIS IS A SEPARATE FILE AND NOT PART OF app.js
 * app.js is ~16,700 lines and owns the SPA. This owns one long-lived, stateful
 * thing that outlives every page in it. Keeping it separate means the call's
 * lifecycle can't be tangled with module navigation.
 *
 * ── THE ARCHITECTURAL CONSTRAINT ────────────────────────────────────────────
 * app.js's updateContent() does `mainContentArea.innerHTML = ...` on EVERY
 * navigation. Any <video> inside mainContentArea would be destroyed the moment
 * the user clicks a nav item, taking the MediaStream with it and killing the
 * call.
 *
 * So the overlay is appended to document.body and positioned `fixed`, exactly
 * like the force-password-change modal in app.js. It is not a module and it is
 * not routed.
 *
 * That constraint is also the feature: the trainer can navigate to the client's
 * program, history or nutrition log WHILE talking to them.
 *
 * z-index: 150. Above everything in app.js (max z-[120]) and the password modal
 * (z-[100]), but BELOW toasts (z-[200]) so feedback stays visible mid-call.
 * ========================================================================== */

(function () {
    'use strict';

    // app.js keeps its escHtml private inside its own IIFE, so we need our own.
    // Peer names come from the database and are rendered with innerHTML.
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const toast = (msg, kind = 'info') => {
        if (typeof window.showToast === 'function') window.showToast(msg, kind);
        else console.log(`[live-session] ${msg}`);
    };

    // ── Spanish strings, in one place ───────────────────────────────────────
    const T = {
        calling:      'Llamando…',
        ringing:      'Sonando…',
        connecting:   'Conectando…',
        connected:    'Conectado',
        reconnecting: 'Reconectando…',
        ended:        'Llamada finalizada',
        declined:     'Llamada rechazada',
        noAnswer:     'No contestó',
        busy:         'Ocupado en otra sesión',
        offline:      'No está disponible en este momento',
        mute:         'Silenciar',
        unmute:       'Activar micrófono',
        cameraOff:    'Apagar cámara',
        cameraOn:     'Encender cámara',
        hangUp:       'Colgar',
        minimise:     'Minimizar',
        expand:       'Volver a la llamada',
        you:          'Tú',
        incoming:     'Sesión en vivo entrante',
        accept:       'Aceptar',
        decline:      'Rechazar',
        cameraIsOff:  'Cámara apagada',
        backgrounded: 'La otra persona puso la app en segundo plano.',
        returned:     'La otra persona volvió.',
        lostForGood:  'Se perdió la conexión. Intenta llamar de nuevo.',
        weak:         'Conexión inestable…',
    };

    // getUserMedia rejects with a DOMException whose .name says what went wrong.
    // A generic "Error" teaches the user nothing — these are the four they can
    // actually act on.
    const MEDIA_ERRORS = {
        NotAllowedError:  'Necesitamos acceso a tu cámara y micrófono. Actívalo en los ajustes del navegador y vuelve a intentar.',
        NotFoundError:    'No encontramos una cámara o micrófono en este dispositivo.',
        NotReadableError: 'Otra aplicación está usando tu cámara. Ciérrala e intenta de nuevo.',
        SecurityError:    'Tu navegador bloqueó el acceso a la cámara por seguridad.',
        AbortError:       'No se pudo iniciar la cámara. Intenta de nuevo.',
    };
    const MEDIA_FALLBACK = 'No se pudo acceder a tu cámara o micrófono.';
    // getUserMedia only exists in a secure context. http://localhost counts;
    // http://192.168.x.x does NOT — which is exactly what you hit the first time
    // you test phone-to-laptop over the LAN.
    const INSECURE_MSG = 'Las sesiones en vivo requieren una conexión segura (HTTPS).';

    const CONSTRAINTS = {
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        // These three are not optional. Without echoCancellation, a trainer on
        // laptop speakers creates a feedback loop the moment the client unmutes.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    };

    // ── State ───────────────────────────────────────────────────────────────
    const state = {
        active: false,
        cleanedUp: true,
        mode: null,            // 'outgoing' | 'incoming'
        callId: null,
        peerId: null,
        peerName: '',
        status: 'idle',
        localStream: null,
        muted: false,
        cameraOff: false,
        minimised: false,
        answeredAt: null,
        durationTimer: null,
        el: {},                // cached DOM refs

        // ── WebRTC ──
        pc: null,
        remoteStream: null,
        isCaller: false,
        // True once setRemoteDescription() has RESOLVED. Until then, incoming ICE
        // candidates must be queued — see applyRemoteDescription().
        remoteReady: false,
        pendingIce: [],
        statsReported: false,

        // ── Day 8: resilience ──
        recoveryTimer: null,   // the 5s grace before escalating a 'disconnected'
        iceRestarts: 0,        // capped — a dead network must not loop forever
        restarting: false,
        stallTimer: null,
        lastBytes: 0,
        stallTicks: 0,
        peerBackgrounded: false,
    };

    // How long 'disconnected' is tolerated before escalating to an ICE restart.
    // Most disconnects self-heal well inside this: a brief packet-loss burst, a
    // Wi-Fi roam between access points. Restarting immediately would tear down a
    // connection that was about to recover on its own.
    const RECOVERY_GRACE_MS = 5000;

    // A dead network cannot be fixed by trying harder. After this many attempts,
    // tell the user plainly instead of spinning forever.
    const MAX_ICE_RESTARTS = 3;

    // 'connected' means ICE found a path — NOT that media is arriving. An encoder
    // can wedge, or a path can black-hole packets while staying nominally up, and
    // the state machine will happily report success over a frozen frame.
    const STALL_CHECK_MS = 3000;
    const STALL_TICKS_TO_ACT = 3;      // ~9s of zero inbound bytes

    // ── Signaling transport ─────────────────────────────────────────────────
    // Day 6 calls LiveSession.connect() from the SPA router at login. Keeping the
    // socket open for the whole session (not just during a call) is what lets an
    // incoming call reach someone who is simply using the app.
    const sock = {
        ws: null,
        socketId: null,       // this tab's id, from the server's `hello`
        attempt: 0,
        retryTimer: null,
        outbox: [],           // frames queued while the socket is down
        wantOpen: false,
    };

    // ── Media ───────────────────────────────────────────────────────────────

    function mediaMessage(err) {
        if (!err) return MEDIA_FALLBACK;
        if (err.__insecure) return INSECURE_MSG;
        return MEDIA_ERRORS[err.name] || MEDIA_FALLBACK;
    }

    async function getLocalMedia() {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
            const e = new Error('insecure context');
            e.__insecure = true;
            throw e;
        }
        try {
            return await navigator.mediaDevices.getUserMedia(CONSTRAINTS);
        } catch (err) {
            // A device that can't do 1280x720 fails the whole request. Retry with
            // the simplest constraints before telling the user anything — most
            // "my camera doesn't work" reports are really this.
            if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
                return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            }
            throw err;
        }
    }

    /**
     * Is there anything to call with? Checked BEFORE inviting, because failing
     * before you ring is much better than failing after.
     * Labels are empty until permission is granted, so we only count kinds.
     */
    async function hasDevices() {
        if (!navigator.mediaDevices?.enumerateDevices) return { video: false, audio: false };
        try {
            const list = await navigator.mediaDevices.enumerateDevices();
            return {
                video: list.some((d) => d.kind === 'videoinput'),
                audio: list.some((d) => d.kind === 'audioinput'),
            };
        } catch { return { video: false, audio: false }; }
    }

    // ── Overlay ─────────────────────────────────────────────────────────────

    const ICON_BTN = 'w-14 h-14 rounded-full flex items-center justify-center text-xl transition ' +
                     'focus:outline-none focus:ring-2 focus:ring-[#FFDB89]/50';

    function overlayHtml(peerName) {
        return `
<div id="fbs-live" class="fixed inset-0 z-[150] bg-[#030303] flex flex-col" role="dialog"
     aria-modal="true" aria-label="Sesión en vivo">

  <!-- Remote video, full bleed. object-cover so it fills without letterboxing. -->
  <video id="fbs-live-remote" class="absolute inset-0 w-full h-full object-cover bg-[#030303]"
         autoplay playsinline></video>

  <!-- Placeholder shown until remote media arrives (Day 5). -->
  <div id="fbs-live-waiting" class="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-6">
    <div class="w-24 h-24 rounded-full bg-[#FFDB89]/10 border border-[#FFDB89]/25 flex items-center justify-center">
      <i class="fas fa-user text-[#FFDB89]/70 text-4xl"></i>
    </div>
    <p class="text-[#FFDB89] text-xl font-bold">${esc(peerName)}</p>
    <p id="fbs-live-status" class="text-[#FFDB89]/60 text-sm">${T.calling}</p>
  </div>

  <!-- Top bar -->
  <div class="relative z-10 flex items-start justify-between p-4 pt-[max(1rem,env(safe-area-inset-top))]
              bg-gradient-to-b from-black/70 to-transparent">
    <div class="min-w-0">
      <p class="text-[#FFDB89] font-bold text-base truncate">${esc(peerName)}</p>
      <p id="fbs-live-substatus" class="text-[#FFDB89]/60 text-xs mt-0.5">${T.calling}</p>
    </div>
    <button id="fbs-live-min" title="${T.minimise}" aria-label="${T.minimise}"
            class="shrink-0 w-10 h-10 rounded-full bg-black/50 border border-[#FFDB89]/20
                   text-[#FFDB89] flex items-center justify-center hover:bg-black/70 transition">
      <i class="fas fa-compress"></i>
    </button>
  </div>

  <div class="flex-grow"></div>

  <!-- Local preview (picture-in-picture). MUTED is mandatory: an unmuted local
       video plays your own microphone back through your speakers. -->
  <div id="fbs-live-localwrap"
       class="absolute right-4 w-28 h-40 sm:w-36 sm:h-52 rounded-2xl overflow-hidden
              border border-[#FFDB89]/25 bg-[#1C1C1E] shadow-2xl z-10"
       style="bottom: calc(7.5rem + env(safe-area-inset-bottom))">
    <video id="fbs-live-local" class="w-full h-full object-cover" autoplay playsinline muted></video>
    <div id="fbs-live-localoff" class="absolute inset-0 hidden flex-col items-center justify-center
                                        bg-[#1C1C1E] gap-1.5 text-center px-1">
      <i class="fas fa-video-slash text-[#FFDB89]/50"></i>
      <span class="text-[#FFDB89]/50 text-[10px] leading-tight">${T.cameraIsOff}</span>
    </div>
  </div>

  <!-- Controls -->
  <div class="relative z-10 flex items-center justify-center gap-4 sm:gap-6 px-4 pt-6
              pb-[max(1.5rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/80 to-transparent">
    <button id="fbs-live-mute" title="${T.mute}" aria-label="${T.mute}" aria-pressed="false"
            class="${ICON_BTN} bg-[#1C1C1E] border border-[#FFDB89]/25 text-[#FFDB89] hover:bg-[#2C2C2E]">
      <i class="fas fa-microphone"></i>
    </button>
    <button id="fbs-live-hangup" title="${T.hangUp}" aria-label="${T.hangUp}"
            class="w-16 h-16 rounded-full flex items-center justify-center text-2xl bg-red-600
                   hover:bg-red-500 text-white shadow-lg transition focus:outline-none
                   focus:ring-2 focus:ring-red-400">
      <i class="fas fa-phone-slash"></i>
    </button>
    <button id="fbs-live-cam" title="${T.cameraOff}" aria-label="${T.cameraOff}" aria-pressed="false"
            class="${ICON_BTN} bg-[#1C1C1E] border border-[#FFDB89]/25 text-[#FFDB89] hover:bg-[#2C2C2E]">
      <i class="fas fa-video"></i>
    </button>
  </div>
</div>`;
    }

    function ringHtml(peerName) {
        return `
<div id="fbs-live-ring" class="fixed inset-0 z-[150] bg-[#030303] flex flex-col items-center
     justify-center gap-6 px-6 text-center" role="dialog" aria-modal="true"
     aria-label="Llamada entrante">
  <div class="w-28 h-28 rounded-full bg-[#FFDB89]/10 border border-[#FFDB89]/25 flex items-center justify-center">
    <i class="fas fa-user text-[#FFDB89]/70 text-5xl"></i>
  </div>
  <div>
    <p class="text-[#FFDB89] text-2xl font-bold">${esc(peerName)}</p>
    <p class="text-[#FFDB89]/60 text-sm mt-1">${T.incoming}</p>
  </div>
  <div class="flex items-center gap-10 mt-4 pb-[env(safe-area-inset-bottom)]">
    <div class="flex flex-col items-center gap-2">
      <button id="fbs-live-decline" aria-label="${T.decline}"
              class="w-16 h-16 rounded-full bg-red-600 hover:bg-red-500 text-white text-2xl
                     flex items-center justify-center shadow-lg transition">
        <i class="fas fa-phone-slash"></i>
      </button>
      <span class="text-[#FFDB89]/50 text-xs">${T.decline}</span>
    </div>
    <div class="flex flex-col items-center gap-2">
      <button id="fbs-live-accept" aria-label="${T.accept}"
              class="w-16 h-16 rounded-full bg-green-600 hover:bg-green-500 text-white text-2xl
                     flex items-center justify-center shadow-lg transition animate-pulse">
        <i class="fas fa-phone"></i>
      </button>
      <span class="text-[#FFDB89]/50 text-xs">${T.accept}</span>
    </div>
  </div>
</div>`;
    }

    function pillHtml(peerName) {
        return `
<button id="fbs-live-pill" aria-label="${T.expand}"
        class="fixed z-[150] right-4 bottom-4 mb-[env(safe-area-inset-bottom)] flex items-center gap-3
               rounded-full bg-[#1C1C1E] border border-[#FFDB89]/30 shadow-2xl pl-4 pr-5 py-3
               hover:bg-[#2C2C2E] transition max-w-[calc(100vw-2rem)]">
  <span class="relative flex h-2.5 w-2.5 shrink-0">
    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60"></span>
    <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500"></span>
  </span>
  <span class="text-[#FFDB89] text-sm font-bold truncate">${esc(peerName)}</span>
  <span id="fbs-live-pilltime" class="text-[#FFDB89]/60 text-xs tabular-nums shrink-0">00:00</span>
</button>`;
    }

    function cacheEls() {
        const $ = (id) => document.getElementById(id);
        state.el = {
            root: $('fbs-live'), remote: $('fbs-live-remote'), local: $('fbs-live-local'),
            localOff: $('fbs-live-localoff'), waiting: $('fbs-live-waiting'),
            status: $('fbs-live-status'), substatus: $('fbs-live-substatus'),
            mute: $('fbs-live-mute'), cam: $('fbs-live-cam'),
            hangup: $('fbs-live-hangup'), min: $('fbs-live-min'),
        };
    }

    function setStatus(key) {
        state.status = key;
        const text = T[key] || key;
        if (state.el.status) state.el.status.textContent = text;
        if (state.el.substatus) state.el.substatus.textContent = text;
    }

    // ── Controls ────────────────────────────────────────────────────────────

    function toggleMute() {
        if (!state.localStream) return;
        state.muted = !state.muted;
        // enabled=false keeps the track in the peer connection but sends silence.
        // Calling stop() instead would need a renegotiation to undo.
        state.localStream.getAudioTracks().forEach((t) => { t.enabled = !state.muted; });
        const b = state.el.mute;
        if (!b) return;
        b.querySelector('i').className = state.muted ? 'fas fa-microphone-slash' : 'fas fa-microphone';
        b.setAttribute('aria-pressed', String(state.muted));
        b.setAttribute('aria-label', state.muted ? T.unmute : T.mute);
        b.title = state.muted ? T.unmute : T.mute;
        b.classList.toggle('bg-[#FFDB89]', state.muted);
        b.classList.toggle('text-[#030303]', state.muted);
        b.classList.toggle('bg-[#1C1C1E]', !state.muted);
        b.classList.toggle('text-[#FFDB89]', !state.muted);
    }

    function toggleCamera() {
        if (!state.localStream) return;
        state.cameraOff = !state.cameraOff;
        state.localStream.getVideoTracks().forEach((t) => { t.enabled = !state.cameraOff; });
        const b = state.el.cam;
        state.el.localOff?.classList.toggle('hidden', !state.cameraOff);
        state.el.localOff?.classList.toggle('flex', state.cameraOff);
        if (!b) return;
        b.querySelector('i').className = state.cameraOff ? 'fas fa-video-slash' : 'fas fa-video';
        b.setAttribute('aria-pressed', String(state.cameraOff));
        b.setAttribute('aria-label', state.cameraOff ? T.cameraOn : T.cameraOff);
        b.title = state.cameraOff ? T.cameraOn : T.cameraOff;
        b.classList.toggle('bg-[#FFDB89]', state.cameraOff);
        b.classList.toggle('text-[#030303]', state.cameraOff);
        b.classList.toggle('bg-[#1C1C1E]', !state.cameraOff);
        b.classList.toggle('text-[#FFDB89]', !state.cameraOff);
    }

    function setMinimised(min) {
        if (!state.active) return;
        state.minimised = min;
        if (min) {
            // The overlay is REMOVED, not hidden — but the MediaStream lives on
            // `state.localStream`, not in the DOM, so nothing is lost. Re-attaching
            // srcObject on expand restores the picture.
            state.el.root?.remove();
            document.body.insertAdjacentHTML('beforeend', pillHtml(state.peerName));
            document.getElementById('fbs-live-pill')
                ?.addEventListener('click', () => setMinimised(false));
        } else {
            document.getElementById('fbs-live-pill')?.remove();
            document.body.insertAdjacentHTML('beforeend', overlayHtml(state.peerName));
            cacheEls();
            wireControls();
            attachLocalStream();
            setStatus(state.status);
            // Re-apply toggles so the buttons match reality after a re-render.
            if (state.muted)     { state.muted = false;     toggleMute(); }
            if (state.cameraOff) { state.cameraOff = false; toggleCamera(); }
        }
    }

    function wireControls() {
        state.el.mute?.addEventListener('click', toggleMute);
        state.el.cam?.addEventListener('click', toggleCamera);
        state.el.min?.addEventListener('click', () => setMinimised(true));
        state.el.hangup?.addEventListener('click', () => window.LiveSession.end('hangup'));
    }

    function attachLocalStream() {
        if (state.el.local && state.localStream) state.el.local.srcObject = state.localStream;
    }

    // ── Duration ────────────────────────────────────────────────────────────

    const mmss = (sec) => {
        const m = Math.floor(sec / 60), s = sec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    function startDurationTimer() {
        state.answeredAt = Date.now();
        clearInterval(state.durationTimer);
        state.durationTimer = setInterval(() => {
            const sec = Math.floor((Date.now() - state.answeredAt) / 1000);
            const pill = document.getElementById('fbs-live-pilltime');
            if (pill) pill.textContent = mmss(sec);
            if (state.el.substatus && state.status === 'connected') {
                state.el.substatus.textContent = `${T.connected} · ${mmss(sec)}`;
            }
        }, 1000);
    }

    // ── Ringer ──────────────────────────────────────────────────────────────
    // Synthesised with the Web Audio API rather than an audio file: no asset to
    // ship or cache, no decode latency, and it cannot 404.
    const ringer = {
        ctx: null, timer: null, titleTimer: null, originalTitle: null, running: false,
    };

    /**
     * An AudioContext created without a prior user gesture starts SUSPENDED, and
     * resume() only works from within a gesture. So we create it lazily, try to
     * resume, and treat failure as normal — the visual ring and the vibration are
     * the real notification; sound is a bonus.
     */
    function ensureAudio() {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        if (!ringer.ctx) { try { ringer.ctx = new AC(); } catch { return null; } }
        if (ringer.ctx.state === 'suspended') ringer.ctx.resume().catch(() => {});
        return ringer.ctx.state === 'running' ? ringer.ctx : null;
    }

    // Called from any earlier click so the AudioContext is already running by the
    // time a call actually arrives. Day 6 wires this to the first app interaction.
    function primeAudio() { ensureAudio(); }

    /** One two-tone chirp — the classic ring cadence. */
    function chirp() {
        const ctx = ensureAudio();
        if (!ctx) return;
        const t0 = ctx.currentTime;
        [[440, 0], [554.37, 0.4]].forEach(([freq, offset]) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            // Ramp the gain: a raw start/stop on an oscillator produces an audible
            // click, because the waveform is cut mid-cycle.
            gain.gain.setValueAtTime(0, t0 + offset);
            gain.gain.linearRampToValueAtTime(0.18, t0 + offset + 0.02);
            gain.gain.linearRampToValueAtTime(0, t0 + offset + 0.38);
            osc.connect(gain).connect(ctx.destination);
            osc.start(t0 + offset);
            osc.stop(t0 + offset + 0.4);
        });
    }

    function startRinging() {
        if (ringer.running) return;
        ringer.running = true;

        chirp();
        ringer.timer = setInterval(() => {
            chirp();
            // Phones that are silenced still buzz. navigator.vibrate is a no-op on
            // desktop and unsupported on iOS Safari — both fine.
            try { navigator.vibrate?.([400, 200, 400]); } catch { /* not supported */ }
        }, 2500);

        // A backgrounded tab shows no overlay, so flash the tab title instead.
        ringer.originalTitle = document.title;
        let on = false;
        ringer.titleTimer = setInterval(() => {
            on = !on;
            document.title = on ? 'Llamada entrante — FitBySuárez' : ringer.originalTitle;
        }, 1000);
    }

    function stopRinging() {
        if (!ringer.running) return;
        ringer.running = false;
        clearInterval(ringer.timer);     ringer.timer = null;
        clearInterval(ringer.titleTimer); ringer.titleTimer = null;
        if (ringer.originalTitle !== null) { document.title = ringer.originalTitle; ringer.originalTitle = null; }
        try { navigator.vibrate?.(0); } catch { /* not supported */ }
    }

    // Any click anywhere unlocks audio for the rest of the session, so a call that
    // arrives later can actually make a sound. Passive + capture so it never
    // interferes with the app's own handlers.
    document.addEventListener('click', primeAudio, { capture: true, passive: true });

    // ── Signaling client ────────────────────────────────────────────────────

    const wsUrl = () =>
        `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/rtc`;

    /**
     * Exponential backoff with JITTER.
     *
     * The jitter is not cosmetic. Without it, a Railway restart makes every client
     * reconnect on the same tick — a thundering herd that can knock the server over
     * again the moment it comes up. Randomising 0.5x-1.5x spreads them out.
     */
    const backoffMs = () => {
        const base = Math.min(30000, 1000 * Math.pow(2, sock.attempt));
        return Math.round(base * (0.5 + Math.random()));
    };

    function connect() {
        sock.wantOpen = true;
        if (sock.ws && (sock.ws.readyState === WebSocket.OPEN || sock.ws.readyState === WebSocket.CONNECTING)) return;

        let ws;
        try { ws = new WebSocket(wsUrl()); }
        catch { return scheduleReconnect(); }
        sock.ws = ws;

        ws.onopen = () => {
            sock.attempt = 0;
            prefetchIce();          // warm the ICE cache while the user is idle
            // Anything that piled up while we were down goes out now, in order.
            const pending = sock.outbox.splice(0);
            pending.forEach((m) => ws.send(JSON.stringify(m)));
        };
        ws.onmessage = (e) => {
            let msg;
            // The server is ours, but a malformed frame must never take down the UI.
            try { msg = JSON.parse(e.data); } catch { return; }
            handleSignal(msg);
        };
        ws.onclose = () => { sock.ws = null; if (sock.wantOpen) scheduleReconnect(); };
        ws.onerror = () => { /* onclose always follows; handle it there */ };
    }

    function scheduleReconnect() {
        clearTimeout(sock.retryTimer);
        const delay = backoffMs();
        sock.attempt += 1;
        sock.retryTimer = setTimeout(() => { if (sock.wantOpen) connect(); }, delay);
    }

    function disconnect() {
        sock.wantOpen = false;
        clearTimeout(sock.retryTimer);
        try { sock.ws?.close(); } catch { /* already gone */ }
        sock.ws = null;
    }

    /** Send, or queue if the socket is down. Returns true if it went out now. */
    function sendMsg(obj) {
        if (sock.ws?.readyState === WebSocket.OPEN) { sock.ws.send(JSON.stringify(obj)); return true; }
        // Never queue ICE: by the time we reconnect the candidates are stale and the
        // negotiation has moved on. An ICE restart (Day 8) re-gathers fresh ones.
        if (obj.t !== 'rtc:ice') sock.outbox.push(obj);
        return false;
    }

    // ── RTCPeerConnection ───────────────────────────────────────────────────

    // Fallback only. The real list comes from GET /api/rtc/ice, which mints
    // short-lived TURN credentials server-side — they must never be hardcoded in
    // the bundle, because anyone holding one can use the relay as free bandwidth
    // on your bill.
    const STUN_ONLY = [{ urls: 'stun:stun.l.google.com:19302' }];

    const ice = {
        servers: null,
        expires: 0,
        inflight: null,
        turn: false,        // did we actually get relay servers?
        // Test hook: 'relay' forces every candidate through TURN. On one LAN, ICE
        // will always find a direct path and never touch the relay — so without
        // this you cannot tell working TURN from unused TURN.
        policy: 'all',
    };

    const ICE_TTL_MS = 4 * 60 * 1000;   // under the server's 5-minute cache

    /**
     * Resolve the ICE server list, cached for the session.
     *
     * Deduped via `inflight`: a call being placed fires start() and the peer
     * connection build in quick succession, and two parallel fetches would burn
     * two upstream provider calls for one answer.
     */
    async function getIceServers() {
        if (ice.servers && Date.now() < ice.expires) return ice.servers;
        if (ice.inflight) return ice.inflight;

        ice.inflight = (async () => {
            try {
                const res = await fetch('/api/rtc/ice', { credentials: 'include' });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                const list = Array.isArray(body.iceServers) ? body.iceServers.filter((x) => x && x.urls) : [];
                ice.servers = list.length ? list : STUN_ONLY;
                ice.turn = !!body.turn;
                ice.expires = Date.now() + ICE_TTL_MS;
            } catch (err) {
                // Degrade, never block. A STUN-only call still connects on the same
                // network, which is most of local testing and a good share of
                // same-house sessions.
                console.warn('[live-session] ICE config unavailable, using STUN only:', err.message);
                ice.servers = STUN_ONLY;
                ice.turn = false;
                ice.expires = Date.now() + 30000;   // retry sooner than a good fetch
            } finally {
                ice.inflight = null;
            }
            return ice.servers;
        })();
        return ice.inflight;
    }

    /** Warm the cache at login so call setup never waits on an HTTP round trip. */
    function prefetchIce() { getIceServers().catch(() => {}); }

    function createPeerConnection() {
        const config = { iceServers: ice.servers || STUN_ONLY };
        // Only set it when forcing relay: passing iceTransportPolicy:'all'
        // explicitly is harmless but noisy in about:webrtc dumps.
        if (ice.policy === 'relay') config.iceTransportPolicy = 'relay';
        const pc = new RTCPeerConnection(config);

        // addTrack BEFORE creating the offer — the SDP is generated from whatever
        // senders exist at that moment. Adding a track afterwards needs a whole
        // renegotiation.
        state.localStream?.getTracks().forEach((t) => pc.addTrack(t, state.localStream));

        pc.ontrack = (e) => {
            // e.streams[0] is the remote MediaStream. Audio and video arrive as
            // separate track events but belong to the same stream, so this fires
            // twice with the same object — assigning twice is harmless.
            state.remoteStream = e.streams[0] || new MediaStream([e.track]);
            attachRemoteStream();
        };

        pc.onicecandidate = (e) => {
            if (!e.candidate) return;          // null = gathering finished
            // toJSON() gives a plain object. Passing the RTCIceCandidate straight to
            // JSON.stringify works in modern browsers but is not guaranteed.
            sendMsg({ t: 'rtc:ice', callId: state.callId, candidate: e.candidate.toJSON() });
        };

        pc.oniceconnectionstatechange = () => onIceState(pc.iceConnectionState);
        pc.onconnectionstatechange   = () => onIceState(pc.connectionState);

        return pc;
    }

    /**
     * The connection state machine.
     *
     *   connected/completed -> healthy: cancel any recovery, start the stall watchdog
     *   disconnected        -> WAIT. Most of these heal on their own.
     *   failed              -> ICE restart immediately; waiting will not help
     *   closed              -> gone
     */
    function onIceState(st) {
        if (!state.active) return;

        if (st === 'connected' || st === 'completed') {
            clearTimeout(state.recoveryTimer); state.recoveryTimer = null;
            state.restarting = false;
            state.iceRestarts = 0;              // a good connection resets the budget
            window.LiveSession.markConnected();
            reportConnectionType();
            startStallWatch();
            return;
        }

        if (st === 'disconnected') {
            // Do NOT restart yet. A Wi-Fi roam or a packet-loss burst looks exactly
            // like this and recovers in a second or two; restarting would tear down
            // a connection that was about to come back.
            setStatus('reconnecting');
            stopStallWatch();
            if (!state.recoveryTimer) {
                state.recoveryTimer = setTimeout(() => {
                    state.recoveryTimer = null;
                    const s = state.pc?.iceConnectionState;
                    if (s === 'disconnected' || s === 'failed') attemptIceRestart('grace_expired');
                }, RECOVERY_GRACE_MS);
            }
            return;
        }

        if (st === 'failed') {
            setStatus('reconnecting');
            stopStallWatch();
            clearTimeout(state.recoveryTimer); state.recoveryTimer = null;
            attemptIceRestart('ice_failed');     // waiting cannot help a failed state
        }
    }

    /**
     * Re-gather ICE on an existing connection, keeping the same media tracks.
     * This is what saves a call when someone walks out of Wi-Fi onto cellular:
     * the network path changes, the peers do not.
     *
     * ONLY THE CALLER restarts. If both sides send a restart offer at the same
     * moment you get glare — two competing offers, setRemoteDescription throwing
     * because the connection is in have-local-offer, and a negotiation that never
     * completes. The callee simply waits; the caller owns renegotiation.
     */
    async function attemptIceRestart(reason) {
        if (!state.active || !state.pc || state.restarting) return;

        if (!state.isCaller) {
            // Callee: the caller will restart. If it does not, the server's own
            // disconnect grace ends the call — no need to race it here.
            setStatus('reconnecting');
            return;
        }

        if (state.iceRestarts >= MAX_ICE_RESTARTS) {
            console.warn('[live-session] giving up after', state.iceRestarts, 'ICE restarts');
            // Pass the reason INTO finish() rather than toasting separately — it
            // emits its own "Llamada finalizada" otherwise, and two toasts for one
            // event means the vaguer message is the one left on screen.
            finish('lostForGood', true);
            return;
        }

        state.restarting = true;
        state.iceRestarts += 1;
        setStatus('reconnecting');
        console.warn(`[live-session] ICE restart ${state.iceRestarts}/${MAX_ICE_RESTARTS} (${reason})`);

        try {
            // Refresh the ICE config first: a TURN credential may have expired
            // during a long call, and restarting with a dead one guarantees failure.
            await getIceServers();
            try { state.pc.setConfiguration?.({ iceServers: ice.servers }); } catch { /* not supported */ }

            const offer = await state.pc.createOffer({ iceRestart: true });
            await state.pc.setLocalDescription(offer);
            // The remote description is about to be replaced, so candidates for the
            // OLD generation must not be applied to the new one.
            state.remoteReady = false;
            state.pendingIce.length = 0;
            sendMsg({ t: 'rtc:offer', callId: state.callId, sdp: { type: offer.type, sdp: offer.sdp } });
        } catch (err) {
            console.error('[live-session] ICE restart failed:', err);
            state.restarting = false;
        }
    }

    // ── Stall watchdog ──────────────────────────────────────────────────────
    // ICE says 'connected' the moment it finds a working candidate pair, and it
    // keeps saying so while a path black-holes media. Watch the bytes instead.

    function startStallWatch() {
        stopStallWatch();
        state.lastBytes = 0;
        state.stallTicks = 0;
        state.stallTimer = setInterval(checkStall, STALL_CHECK_MS);
    }

    function stopStallWatch() {
        clearInterval(state.stallTimer);
        state.stallTimer = null;
        state.stallTicks = 0;
    }

    async function checkStall() {
        if (!state.active || !state.pc) return stopStallWatch();
        // A backgrounded peer legitimately stops sending video — that is not a
        // stall, and restarting on it would be actively wrong.
        if (state.peerBackgrounded || document.visibilityState === 'hidden') { state.stallTicks = 0; return; }

        let bytes = 0;
        try {
            (await state.pc.getStats()).forEach((r) => {
                if (r.type === 'inbound-rtp' && !r.isRemote) bytes += (r.bytesReceived || 0);
            });
        } catch { return; }

        if (state.lastBytes && bytes <= state.lastBytes) {
            state.stallTicks += 1;
            if (state.stallTicks === 1) setStatus('weak');
            if (state.stallTicks >= STALL_TICKS_TO_ACT) {
                console.warn('[live-session] media stalled with ICE still "connected"');
                stopStallWatch();
                attemptIceRestart('media_stalled');
            }
        } else if (state.stallTicks) {
            // Recovered on its own.
            state.stallTicks = 0;
            if (state.status === 'weak') setStatus('connected');
        }
        state.lastBytes = bytes;
    }

    function attachRemoteStream() {
        if (!state.el.remote || !state.remoteStream) return;

        // ontrack fires ONCE PER TRACK — audio and video arrive separately but carry
        // the same MediaStream. Re-assigning srcObject aborts any play() already in
        // flight and rejects its promise with AbortError, which would otherwise trip
        // the autoplay fallback over a video that is playing perfectly.
        if (state.el.remote.srcObject !== state.remoteStream) {
            state.el.remote.srcObject = state.remoteStream;
        }
        state.el.waiting?.classList.add('hidden');

        // Autoplay WITH AUDIO is blocked outside a user gesture. start() and the
        // accept button are gestures, so this usually succeeds — but when it is
        // genuinely blocked, offer a tap rather than showing a silent black frame.
        state.el.remote.play?.().catch((err) => {
            // ONLY a real autoplay block deserves the fallback. AbortError means
            // another play()/load interrupted this one, which is harmless.
            if (err?.name === 'NotAllowedError') showTapToPlay();
        });
    }

    function showTapToPlay() {
        if (document.getElementById('fbs-live-tap')) return;
        state.el.root?.insertAdjacentHTML('beforeend', `
<button id="fbs-live-tap" class="absolute inset-0 z-20 flex flex-col items-center justify-center
        gap-3 bg-black/70 text-[#FFDB89]">
  <i class="fas fa-play text-3xl"></i>
  <span class="text-sm font-bold">Toca para escuchar</span>
</button>`);
        document.getElementById('fbs-live-tap')?.addEventListener('click', () => {
            state.el.remote?.play?.().catch(() => {});
            document.getElementById('fbs-live-tap')?.remove();
        });
    }

    /**
     * THE ICE CANDIDATE QUEUE — the single most important function in this file.
     *
     * Candidates start arriving the instant the peer begins gathering, which is
     * BEFORE its SDP has crossed the wire and been applied here. Calling
     * addIceCandidate() before setRemoteDescription() resolves throws
     * InvalidStateError and the candidate is LOST.
     *
     * Lose the wrong candidate and the call connects sometimes and hangs other
     * times — the worst kind of bug, because it looks like a network problem.
     */
    async function applyRemoteDescription(desc) {
        await state.pc.setRemoteDescription(new RTCSessionDescription(desc));
        state.remoteReady = true;
        const queued = state.pendingIce.splice(0);
        for (const c of queued) {
            try { await state.pc.addIceCandidate(new RTCIceCandidate(c)); }
            catch (err) { console.warn('[live-session] queued ICE rejected:', err.name); }
        }
    }

    function handleRemoteIce(candidate) {
        if (!state.pc) return;
        if (!state.remoteReady) { state.pendingIce.push(candidate); return; }
        state.pc.addIceCandidate(new RTCIceCandidate(candidate))
            .catch((err) => console.warn('[live-session] ICE rejected:', err.name));
    }

    /** Caller side: once the callee accepts, make the offer. */
    async function makeOffer() {
        state.pc = state.pc || createPeerConnection();
        const offer = await state.pc.createOffer();
        await state.pc.setLocalDescription(offer);
        sendMsg({ t: 'rtc:offer', callId: state.callId, sdp: { type: offer.type, sdp: offer.sdp } });
    }

    /**
     * Callee side: answer an offer. This handles BOTH the initial offer and an ICE
     * restart offer — the flow is identical, which is the nice part of ICE restart:
     * it is an ordinary renegotiation carrying fresh ICE credentials.
     */
    async function makeAnswer(sdp) {
        const isRestart = !!state.pc && state.remoteReady;
        if (isRestart) {
            // Candidates already queued belong to the OLD ICE generation and would
            // be applied against new credentials. Drop them.
            state.pendingIce.length = 0;
            state.remoteReady = false;
            setStatus('reconnecting');
        }
        state.pc = state.pc || createPeerConnection();
        await applyRemoteDescription(sdp);
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        sendMsg({ t: 'rtc:answer', callId: state.callId, sdp: { type: answer.type, sdp: answer.sdp } });
    }

    /**
     * Report which ICE candidate pair actually won. This is the ONLY way to learn
     * your real TURN relay rate — and TURN bills by relayed bandwidth, so it is the
     * difference between guessing at the cost and knowing it.
     */
    async function reportConnectionType() {
        if (state.statsReported || !state.pc) return;
        state.statsReported = true;
        try {
            const stats = await state.pc.getStats();
            let type = 'unknown';
            stats.forEach((r) => {
                if (r.type !== 'candidate-pair') return;
                if (r.state !== 'succeeded') return;
                if (!r.nominated && !r.selected) return;
                const local = stats.get(r.localCandidateId);
                if (local) type = local.candidateType === 'relay' ? 'relay' : 'p2p';
            });
            sendMsg({ t: 'call:stats', callId: state.callId, connectionType: type });
        } catch { /* stats are diagnostic only — never break a working call */ }
    }

    // ── Signal dispatch ─────────────────────────────────────────────────────

    // Table, mirroring the server's. An unknown type is ignored, not thrown on:
    // an older tab must not break when the server learns a new message.
    const SIGNALS = {
        hello: (m) => { sock.socketId = m.socketId; },

        'call:ringing':  (m) => { state.callId = m.callId; setStatus('ringing'); },
        'call:accepted': (m) => {
            state.callId = m.callId;
            setStatus('connecting');
            // Only the CALLER offers. Both sides offering simultaneously is "glare"
            // and leaves the negotiation permanently broken.
            if (state.isCaller && !m.self) makeOffer().catch(onNegotiationError);
        },
        // All three are the SERVER reporting a terminal state. notify=false: do not
        // send call:end back in response to being told the call already ended.
        'call:declined': ()  => finish('declined', false),
        'call:ended':    (m) => finish(
            m.reason === 'no_answer' ? 'noAnswer'
            : m.reason === 'offline' ? 'offline'
            : 'ended', false),
        // Another of this user's tabs took the call.
        'call:handled':  (m) => { if (m.bySocket !== sock.socketId) finish(null, false); },
        'call:incoming': (m) => window.LiveSession.incoming(m),   // Day 6

        'rtc:offer':  (m) => { state.callId = m.callId; makeAnswer(m.sdp).catch(onNegotiationError); },
        'rtc:answer': (m) => applyRemoteDescription(m.sdp)
            .then(() => { state.restarting = false; })
            .catch(onNegotiationError),
        // The peer backgrounded their tab (iOS Safari suspends video), so the frozen
        // frame has an explanation rather than looking like a broken call.
        'call:peerstate': (m) => {
            state.peerBackgrounded = m.state === 'background';
            if (state.peerBackgrounded) { toast(T.backgrounded, 'info'); setStatus('weak'); }
            else if (state.status === 'weak') { setStatus('connected'); }
        },
        'rtc:ice':    (m) => handleRemoteIce(m.candidate),

        error: (m) => onSignalError(m),
    };

    // Frames that are ABOUT a specific call, as opposed to ones that start or
    // describe the connection itself.
    const CALL_SCOPED = new Set([
        'call:ringing', 'call:accepted', 'call:declined', 'call:ended', 'call:handled',
        'call:peerstate', 'rtc:offer', 'rtc:answer', 'rtc:ice',
    ]);

    function handleSignal(msg) {
        const fn = SIGNALS[msg?.t];
        if (!fn) return;

        // Ignore anything about a DIFFERENT call than the one in progress.
        //
        // Concretely: while you are mid-call, a second invite arrives and incoming()
        // auto-declines it as busy. The server dutifully reports call:declined — for
        // that second call. Without this guard the handler tears down the call you
        // are actually on. Late frames from a just-ended call cause the same thing.
        if (CALL_SCOPED.has(msg.t) && state.callId && msg.callId && msg.callId !== state.callId) {
            return;
        }

        try { fn(msg); } catch (err) { console.error('[live-session] signal handler failed:', err); }
    }

    const SIGNAL_ERRORS = {
        ALREADY_IN_CALL: 'Ya estás en una llamada.',
        PEER_BUSY:       'Esa persona está ocupada en otra sesión.',
        NOT_ALLOWED:     'No puedes llamar a este usuario.',
        TARGET_INACTIVE: 'Esa cuenta está inactiva.',
        NO_TRAINER:      'Este cliente no tiene entrenador asignado.',
        RATE_LIMIT:      'Demasiadas llamadas. Espera un momento.',
        PEER_OFFLINE:    'Se perdió la conexión con la otra persona.',
        CALL_OVER:       'La llamada ya terminó.',
    };

    function onSignalError(m) {
        const msg = SIGNAL_ERRORS[m.code] || m.message;
        // Only fatal codes end the call. PEER_OFFLINE during negotiation is often
        // transient (a tab reloading), so it is surfaced without hanging up.
        const fatal = ['ALREADY_IN_CALL', 'PEER_BUSY', 'NOT_ALLOWED', 'TARGET_INACTIVE',
                       'NO_TRAINER', 'RATE_LIMIT', 'CALL_OVER', 'NO_CALL', 'FORBIDDEN'];
        if (msg) toast(msg, 'error');
        // The server already knows — it is the one that sent the error.
        if (state.active && fatal.includes(m.code)) finish(null, false);
    }

    /**
     * The single teardown path.
     *
     * `notify` is false when the SERVER is the one telling us the call is over.
     * Echoing call:end back at it is pointless, and — because a signal handler can
     * run synchronously inside sendMsg's own delivery — it recurses: end sends,
     * the echo arrives, end is re-entered while state.active is STILL true, and it
     * sends again. That produced 8 identical call:end frames in testing.
     *
     * Hence the ordering below: claim the transition (state.active = false) BEFORE
     * any I/O. Same principle as the server's conditional update — decide once,
     * atomically, then act.
     */
    function finish(reason, notify) {
        if (!state.active) return;
        state.active = false;                      // <- claimed before anything can re-enter
        const wasConnected = state.status === 'connected';
        const callId = state.callId;
        if (notify && callId) sendMsg({ t: 'call:end', callId });
        cleanup();
        if (reason && reason !== 'hangup') toast(T[reason] || T.ended, 'info');
        else if (wasConnected) toast(T.ended, 'info');
    }

    function onNegotiationError(err) {
        console.error('[live-session] negotiation failed:', err);
        toast('No se pudo establecer la conexión.', 'error');
        finish(null, true);
    }

    // ── Teardown ────────────────────────────────────────────────────────────

    /**
     * Idempotent, and it MUST be: this is called from hang-up, remote hang-up,
     * socket close, beforeunload, ICE failure and error paths — several of which
     * can fire together.
     *
     * The critical line is track.stop(). Without it the camera indicator light
     * stays on after the call, and users do not forgive that.
     */
    function cleanup() {
        if (state.cleanedUp) return;
        state.cleanedUp = true;
        state.active = false;

        // Belt and braces: every teardown path runs through here, so a call that
        // ends while still ringing (caller cancelled, timed out, another tab took
        // it) cannot leave the tone or the title flashing.
        stopRinging();

        clearInterval(state.durationTimer);
        state.durationTimer = null;
        clearTimeout(state.recoveryTimer);
        state.recoveryTimer = null;
        stopStallWatch();
        state.iceRestarts = 0;
        state.restarting = false;
        state.peerBackgrounded = false;
        state.lastBytes = 0;

        // Stop OUTGOING tracks via the senders too. A track attached to a sender
        // is not always the same object as the one in localStream (replaceTrack,
        // screen share), so stopping only the stream can leave one live.
        try {
            state.pc?.getSenders().forEach((sender) => { try { sender.track?.stop(); } catch { /* */ } });
            state.pc?.close();
        } catch { /* already closed */ }
        state.pc = null;
        state.remoteReady = false;
        state.pendingIce.length = 0;
        state.statsReported = false;
        state.remoteStream = null;

        state.localStream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* already gone */ } });
        state.localStream = null;

        if (state.el.remote) state.el.remote.srcObject = null;
        if (state.el.local)  state.el.local.srcObject = null;

        document.getElementById('fbs-live')?.remove();
        document.getElementById('fbs-live-ring')?.remove();
        document.getElementById('fbs-live-pill')?.remove();

        state.el = {};
        state.callId = null; state.peerId = null; state.peerName = '';
        state.muted = false; state.cameraOff = false; state.minimised = false;
        state.status = 'idle'; state.answeredAt = null; state.mode = null;
        state.isCaller = false;
    }

    // A tab closing mid-call must not leave the other side staring at a frozen frame
    // for the server's whole 20s grace period. Send call:end FIRST — the browser
    // flushes a pending WebSocket frame on unload, but will not wait for a promise.
    window.addEventListener('beforeunload', () => {
        if (!state.active) return;
        if (state.callId) sendMsg({ t: 'call:end', callId: state.callId });
        cleanup();
    });

    // iOS Safari suspends video encoding when a tab backgrounds, so the peer sees a
    // frozen frame. Telling them turns a "broken call" into a explained one.
    document.addEventListener('visibilitychange', () => {
        if (!state.active || !state.callId) return;
        const hidden = document.visibilityState === 'hidden';
        sendMsg({ t: 'call:peerstate', callId: state.callId, state: hidden ? 'background' : 'foreground' });

        if (!hidden) {
            // Coming back: timers were throttled while hidden, so re-check the real
            // connection state rather than trusting whatever the UI last showed.
            const st = state.pc?.iceConnectionState;
            if (st) onIceState(st);
        }
    });

    // Losing the network entirely is worth acting on immediately — no point waiting
    // out a 5-second grace when the OS already knows there is no route.
    window.addEventListener('offline', () => {
        if (state.active) { setStatus('reconnecting'); stopStallWatch(); }
    });
    window.addEventListener('online', () => {
        if (!state.active) return;
        const st = state.pc?.iceConnectionState;
        if (st === 'disconnected' || st === 'failed') attemptIceRestart('network_returned');
    });

    // ── Public API ──────────────────────────────────────────────────────────

    window.LiveSession = {
        /** Open (or re-open) the signaling socket. Day 6 calls this at login. */
        connect,
        disconnect,
        isConnected: () => sock.ws?.readyState === WebSocket.OPEN,

        /** Place an outgoing call. */
        async start(peerId, peerName) {
            if (state.active) { toast('Ya estás en una llamada.', 'info'); return false; }

            const devices = await hasDevices();
            if (!devices.video && !devices.audio) {
                toast(MEDIA_ERRORS.NotFoundError, 'error');
                return false;
            }

            let stream;
            try {
                stream = await getLocalMedia();
            } catch (err) {
                toast(mediaMessage(err), 'error');
                return false;
            }

            state.cleanedUp = false;
            state.active = true;
            state.mode = 'outgoing';
            state.peerId = peerId;
            state.peerName = peerName || '';
            state.localStream = stream;

            state.isCaller = true;

            // Must resolve BEFORE createPeerConnection(): RTCPeerConnection takes its
            // ICE servers at construction and ignores later changes. Normally a cache
            // hit and instant; only cold on the very first call of a session.
            await getIceServers();

            document.body.insertAdjacentHTML('beforeend', overlayHtml(state.peerName));
            cacheEls();
            wireControls();
            attachLocalStream();
            setStatus('calling');

            // Build the peer connection NOW, before the callee answers. ICE gathering
            // is the slow part (it needs a STUN round trip), so starting it during the
            // ring means candidates are ready the moment the offer goes out.
            state.pc = createPeerConnection();

            connect();
            sendMsg({ t: 'call:invite', toUserId: peerId });
            return true;
        },

        /**
         * An invite arrived. Show the ring. Day 6 adds the ringtone and the
         * <title> flash so a backgrounded tab is noticeable.
         *
         * NOTE: media is deliberately NOT acquired here. Asking for the camera
         * before the user has agreed to take the call is both rude and useless —
         * and acquiring it inside the accept CLICK is what makes the browser treat
         * the subsequent video playback as user-initiated (see accept()).
         */
        incoming(m) {
            if (!m?.callId) return;
            if (state.active) { sendMsg({ t: 'call:decline', callId: m.callId, reason: 'busy' }); return; }

            state.cleanedUp = false;
            state.active = true;
            state.mode = 'incoming';
            state.isCaller = false;
            state.callId = m.callId;
            state.peerId = m.from?.id || null;
            state.peerName = m.from?.name || '';
            state.status = 'incoming';

            document.body.insertAdjacentHTML('beforeend', ringHtml(state.peerName));
            startRinging();
            document.getElementById('fbs-live-accept')
                ?.addEventListener('click', () => window.LiveSession.accept());
            document.getElementById('fbs-live-decline')
                ?.addEventListener('click', () => window.LiveSession.decline('declined'));
        },

        /**
         * Answer. Must be called from a real click: acquiring media inside the
         * gesture is what lets the browser autoplay the remote video WITH audio.
         * Called outside a gesture, play() is blocked and you get a black frame.
         */
        async accept() {
            if (!state.active || state.mode !== 'incoming') return false;
            // Stop the noise immediately — before the permission prompt, which can
            // sit on screen for several seconds while the phone keeps ringing.
            stopRinging();

            let stream;
            try {
                stream = await getLocalMedia();
            } catch (err) {
                // No camera means no call — decline honestly rather than answering
                // into silence and letting the caller wonder.
                toast(mediaMessage(err), 'error');
                sendMsg({ t: 'call:decline', callId: state.callId, reason: 'no_media' });
                cleanup();
                return false;
            }

            state.localStream = stream;
            await getIceServers();      // same constraint as the caller side
            document.getElementById('fbs-live-ring')?.remove();
            document.body.insertAdjacentHTML('beforeend', overlayHtml(state.peerName));
            cacheEls();
            wireControls();
            attachLocalStream();
            setStatus('connecting');

            state.pc = createPeerConnection();
            sendMsg({ t: 'call:accept', callId: state.callId });
            return true;
        },

        decline(reason) {
            if (!state.active || state.mode !== 'incoming') return;
            stopRinging();
            sendMsg({ t: 'call:decline', callId: state.callId, reason: reason || 'declined' });
            cleanup();
        },

        /** Day 5/6 use this once media actually connects. */
        markConnected() {
            if (!state.active) return;
            setStatus('connected');
            state.el.waiting?.classList.add('hidden');
            startDurationTimer();
        },

        /** Hang up. Always tells the server. */
        end(reason) { finish(reason, true); },

        isActive: () => state.active,
        isMinimised: () => state.minimised,

        // Exposed for the test harness and for debugging from the console.
        _state: state,
        _sock: sock,
        _createPeerConnection: createPeerConnection,
        _applyRemoteDescription: applyRemoteDescription,
        _handleRemoteIce: handleRemoteIce,
        _handleSignal: handleSignal,
        _makeOffer: makeOffer,
        _makeAnswer: makeAnswer,
        _reportConnectionType: reportConnectionType,
        _ice: ice,
        _getIceServers: getIceServers,
        /** Force every candidate through TURN, to prove the relay actually works. */
        _forceRelay(on) { ice.policy = on ? 'relay' : 'all'; return ice.policy; },
        _onIceState: onIceState,
        _attemptIceRestart: attemptIceRestart,
        _checkStall: checkStall,
        _startStallWatch: startStallWatch,
        _stopStallWatch: stopStallWatch,
        _startRinging: startRinging,
        _stopRinging: stopRinging,
        _ringer: ringer,
        _mediaMessage: mediaMessage,
        _hasDevices: hasDevices,
        _toggleMute: toggleMute,
        _toggleCamera: toggleCamera,
        _setMinimised: setMinimised,
        _T: T,
    };
})();
