# 7. Live Sessions (WebRTC) — Two-Week Build Plan

**Goal:** a trainer can start a 1:1 video call with one of their clients from inside the web
app. The client gets a ringing overlay anywhere in the SPA, accepts, and the two talk
face-to-face with sub-200ms latency. Media flows peer-to-peer; the server only introduces them.

**Scope (deliberately tight):**

| In | Out (v2) |
|---|---|
| Web app only | Mobile app (`react-native-webrtc` needs an EAS dev build) |
| 1:1 trainer ↔ client | Group / bootcamp calls (needs an SFU) |
| Audio + video, mute, camera toggle, hang up | Recording, in-call chat, virtual background |
| Ring / accept / decline / missed | Scheduled calls with reminders |
| Call history row per session | Screen share (stretch goal, Day 10) |

**Why these are out:** recording adds storage cost, egress cost, and a consent question on top
of the progress photos you already hold. Group calls need a Selective Forwarding Unit because
mesh P2P scales quadratically. Mobile is blocked on the same EAS dev build that blocks push
notifications — when you pay the Apple $99/yr, do both in one pass.

---

## 7.0 The four findings that shape everything

Read these before writing a line. Each one is a half-day you don't have to lose.

### 1. `app.listen()` has to go

`server.js:5737` ends with:

```js
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
```

`app.listen()` creates an `http.Server` internally and never hands it to you. WebSockets need
that server object to attach an `upgrade` listener. This is Day 1, step 1.

### 2. The call UI cannot be a module

`updateContent()` (`public/app.js:1724`) does `mainContentArea.innerHTML = ...` on every single
navigation. If the call lives inside `mainContentArea`, clicking "Nutrición" mid-call destroys
the `<video>` elements, which drops the `MediaStream`, which kills the call.

**The call overlay must be appended to `document.body` and positioned `fixed`.** Your
force-password-change modal (`public/app.js:~2053`) already does exactly this with
`document.body.insertAdjacentHTML('beforeend', ...)`. Copy that shape. Use `z-[200]` so it sits
above the password modal's `z-[100]`.

This is a feature, not a workaround: the trainer can navigate to the client's program or
nutrition log *while on the call* and talk them through it. That is the actual product value.

### 3. Helmet CSP will block the socket silently

`server.js:148`:

```js
connectSrc: ["'self'", "https://api.nal.usda.gov", "https://cdn.jsdelivr.net",
             "https://world.openfoodfacts.org", "https://search.openfoodfacts.org"],
```

`'self'` does not reliably cover `ws:`/`wss:` across browsers. You will get a console CSP
violation and a socket that never opens, with no server-side error to find. Add the scheme
explicitly on Day 1 — before you write the client — so you never debug this.

### 4. `canTouchClient` is the authorization primitive

`server.js:~390` already resolves: clients may only touch themselves; superadmins may touch
anyone; trainers may touch their own roster **and legacy clients with a null `trainerId`**.

Use it. Do **not** use `assertOwnership` (`server.js:374`) — it only blocks clients acting on
other clients and would happily let trainer A ring trainer B's client.

---

## 7.1 Data model

One new model. Add it near the other schemas in `server.js` (after `NotificationSchema`,
around line 537).

```js
const CallSessionSchema = new mongoose.Schema({
    callerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    calleeId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Denormalised so call history can be listed per trainer without a join.
    trainerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    callerName: { type: String, default: '' },
    calleeName: { type: String, default: '' },
    status: {
        type: String,
        enum: ['ringing', 'active', 'ended', 'declined', 'missed', 'failed'],
        default: 'ringing'
    },
    startedAt:  { type: Date, default: Date.now }, // invite sent
    answeredAt: { type: Date, default: null },     // callee accepted
    endedAt:    { type: Date, default: null },
    durationSec:{ type: Number, default: 0 },
    endedBy:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Filled from the client's selected ICE candidate pair — tells you what
    // fraction of your real calls need TURN, which is what TURN costs money on.
    connectionType: { type: String, enum: ['p2p', 'relay', 'unknown'], default: 'unknown' },
    failureReason: { type: String, default: '' },
});
CallSessionSchema.index({ trainerId: 1, startedAt: -1 });
CallSessionSchema.index({ calleeId: 1, startedAt: -1 });
const CallSession = mongoose.model('CallSession', CallSessionSchema);
```

**Why persist calls at all?** Three reasons, in order of importance: (a) the callee needs a
"llamada perdida" record when they miss one, (b) `connectionType` tells you your real TURN
relay rate so you can budget, (c) call history on the client detail page is genuinely useful
to a coach.

### One-line change that will otherwise bite you

`NotificationSchema.type` (`server.js:514`) is a strict `enum`. Add two values:

```js
'live_session_missed', 'live_session_ended',
```

If you skip this, `Notification.create()` throws a Mongoose ValidationError, and
`createNotification` (`server.js:794`) swallows it in its own `try/catch`. You get **no
notification and no error** — the hardest possible bug to find.

---

## 7.2 Architecture at a glance

```
  Trainer browser                 Your Express server              Client browser
  ───────────────                 ───────────────────              ──────────────
  RTCPeerConnection                                                RTCPeerConnection
        │                                                                 │
        │  ── WS: call:invite ──▶  validate canTouchClient()              │
        │                          create CallSession(ringing)            │
        │                          ── WS: call:incoming ──────────────▶   │
        │                                                                 │
        │  ◀────────────────────── WS: call:accept ───────────────────    │
        │                                                                 │
        │  ── WS: rtc:offer ────▶  relay (verify sender ∈ call) ──────▶   │
        │  ◀── WS: rtc:answer ───  relay ◀────────────────────────────    │
        │  ── WS: rtc:ice ⇄ ────▶  relay ⇄ ──────────────────────────▶   │
        │                                                                 │
        │◀════════════ SRTP media, DIRECT (or via TURN) ═════════════════▶│
```

The server never touches media. It handles introductions and bookkeeping only. Total server
bandwidth per call: a few KB.

---

# Week 1 — Get two browsers talking

## Day 1 — Server foundation: HTTP upgrade + authenticated WebSocket

**Install:**

```bash
npm install ws
```

**Step 1 — Replace `app.listen`.** At the top of `server.js` add `import http from 'http';`,
then rewrite the last two lines:

```js
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
attachSignaling(server);              // you'll write this today
server.listen(PORT, () => { console.log(`Server running on http://localhost:${PORT}`); });
```

Restart and confirm the app still works exactly as before. **Commit here.** This refactor is
independently safe and you want it isolated in history.

**Step 2 — Create `signaling.js`** at the repo root (a sibling of `server.js`). Keeping it out
of the 5,700-line `server.js` is the right call; it has a genuinely separate lifecycle.

Its job on Day 1 is only: accept an upgrade, authenticate it, keep the socket alive.

```js
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';

// Multiple sockets per user is normal — two tabs, or phone browser + laptop.
const peers = new Map();          // userId(string) -> Set<WebSocket>

const parseCookies = (header = '') =>
    Object.fromEntries(
        header.split(';')
              .map(c => c.trim().split('='))
              .filter(p => p.length === 2)
              .map(([k, v]) => [k, decodeURIComponent(v)])
    );

export function attachSignaling(server) {
    // noServer:true so WE decide whether to complete the handshake.
    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
        if (!req.url.startsWith('/rtc')) return socket.destroy();

        // cookieParser() is Express middleware — it does NOT run on an upgrade
        // request. Parse the raw header ourselves.
        const token = parseCookies(req.headers.cookie)['auth_token'];
        if (!token) return socket.destroy();

        let decoded;
        try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
        catch { return socket.destroy(); }

        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.user = decoded;        // { id, email, role }
            ws.isAlive = true;
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws) => {
        const uid = String(ws.user.id);
        if (!peers.has(uid)) peers.set(uid, new Set());
        peers.get(uid).add(ws);

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('close', () => {
            peers.get(uid)?.delete(ws);
            if (peers.get(uid)?.size === 0) peers.delete(uid);
        });
        ws.on('message', (raw) => handleMessage(ws, raw));   // Day 2
    });

    // Railway's proxy drops idle connections. Without this, calls die after
    // ~60s of silence and you will blame WebRTC for a proxy problem.
    setInterval(() => {
        wss.clients.forEach((ws) => {
            if (!ws.isAlive) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);
}
```

**Step 3 — CSP.** In `server.js:148`, extend `connectSrc`:

```js
connectSrc: ["'self'", "ws://localhost:3000", "wss://api.fitbysuarez.com",
             "https://api.nal.usda.gov", /* …existing… */],
```

Also add `mediaSrc: ["'self'", "blob:"]` to the same directives block as cheap insurance —
you don't strictly need it for `srcObject`, but you will the moment you touch
`URL.createObjectURL`.

**Acceptance:** in the browser console on a logged-in page, `new WebSocket('ws://localhost:3000/rtc')`
opens and stays open past 60 seconds. With cookies cleared, it closes immediately.

**Concept to internalise today:** an HTTP upgrade is a one-way door. You authenticate *before*
`handleUpgrade`, because after it you're speaking a different protocol and there's no clean
way to send a 401.

---

## Day 2 — The signaling protocol

Define every message once, at the top of `signaling.js`, as a comment block. A sloppy protocol
is where WebRTC projects go to die.

```
CLIENT → SERVER
  { t:'call:invite',  toUserId }             start a call
  { t:'call:accept',  callId }
  { t:'call:decline', callId, reason? }
  { t:'call:end',     callId }
  { t:'rtc:offer',    callId, sdp }
  { t:'rtc:answer',   callId, sdp }
  { t:'rtc:ice',      callId, candidate }
  { t:'call:stats',   callId, connectionType }   reported once on connect

SERVER → CLIENT
  { t:'call:incoming', callId, from:{id,name,profilePicture} }
  { t:'call:ringing',  callId }                  callee's device is alerting
  { t:'call:accepted', callId }
  { t:'call:declined', callId, reason }
  { t:'call:ended',    callId, by }
  { t:'rtc:offer' | 'rtc:answer' | 'rtc:ice', … }  relayed verbatim
  { t:'error', code, message }
```

**The security rule, and it is the whole lesson of this day:**

> The server must never relay a message just because it arrived. For every `rtc:*` message, load
> the `CallSession` by `callId` and confirm the sender is `callerId` or `calleeId`. Then forward
> it **only** to the other participant.

Without that check, any logged-in client can inject SDP into any call by guessing an ObjectId.
An SDP offer can redirect where media flows — this is a real hijack, not a theoretical one.

Sketch:

```js
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

const sendToUser = (userId, obj) => {
    const set = peers.get(String(userId));
    if (!set || set.size === 0) return false;     // user offline
    set.forEach(ws => send(ws, obj));
    return true;
};

const relayToPeer = async (ws, msg) => {
    const call = await CallSession.findById(msg.callId);
    if (!call) return send(ws, { t:'error', code:'NO_CALL' });

    const me = String(ws.user.id);
    const a = String(call.callerId), b = String(call.calleeId);
    if (me !== a && me !== b) return send(ws, { t:'error', code:'FORBIDDEN' });

    sendToUser(me === a ? b : a, msg);            // forward verbatim
};
```

**Rate-limit invites.** A loop calling `call:invite` would spam notifications and create
`CallSession` rows forever. Cap it in memory: max 5 invites per user per minute, drop the rest
with `{t:'error', code:'RATE_LIMIT'}`.

**Acceptance:** two browser consoles (normal window + incognito, so you get two cookie jars),
both connected. Sending `rtc:ice` with a forged `callId` returns `FORBIDDEN`.

---

## Day 3 — Call lifecycle

Now wire `call:invite / accept / decline / end` to the `CallSession` model.

**`call:invite` handler, in order:**

1. `canTouchClient(fakeReq, toUserId)` — you'll need a small shim since `canTouchClient` expects
   `req.user`. Pass `{ user: ws.user }`. It only reads `req.user` and `req._actor`, so this works.
   Refactor it to take `(actor, clientId)` if you prefer clean over quick — your call.
2. Reject self-calls (`toUserId === ws.user.id`).
3. Reject if an `active` or `ringing` call already exists for either party.
4. Create `CallSession({status:'ringing'})`.
5. `sendToUser(toUserId, {t:'call:incoming', ...})`. If it returns `false`, the callee is
   offline → immediately mark `status:'missed'` and tell the caller. Don't leave them ringing
   into the void.
6. Start a **45-second server-side timer**. If still `ringing` when it fires: set `missed`,
   notify both sides, `createNotification({type:'live_session_missed', ...})`.

**Why server-side and not a browser `setTimeout`:** the caller can close their laptop. The
`CallSession` would sit at `ringing` forever and block every future call by rule 3. Server-side
timers are the only ones you control. Keep them in a `Map<callId, timeoutId>` and always clear
on accept/decline/end.

**`call:end`:** set `endedAt`, compute `durationSec` from `answeredAt`, set `endedBy`, relay
`call:ended` to the other side.

**Also handle socket `close`:** if a user with an `active` call disconnects, don't end the call
instantly — a tab reload or a tunnel change is normal. Give a **20-second grace period**; if
they haven't reconnected, end the call as `ended` with `failureReason:'peer_disconnected'`.

**Acceptance:** drive a full lifecycle by hand from two consoles. Check the DB: statuses and
`durationSec` are correct for accepted, declined, missed, and hung-up calls.

---

## Day 4 — Frontend: media capture and the overlay shell

No peer connection yet. Today is only: get the camera, and build the UI that will hold it.

Create `public/live-session.js`, loaded from `index.html` **after** `app.js`. It's ~600 lines
by the end and does not belong in a 16,000-line file.

Expose exactly one thing on `window`, matching how `app.js` exposes `openClientProfile`:

```js
window.LiveSession = { start(userId, name), incoming(payload), end(), isActive() };
```

**Get media:**

```js
const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
});
```

Those three audio flags are not optional. Without `echoCancellation` a trainer on laptop
speakers creates a feedback loop the moment the client unmutes.

**Handle every `getUserMedia` rejection by `err.name`,** with Spanish strings — this is where
real users get stuck, and a generic "Error" teaches them nothing:

| `err.name` | Spanish message |
|---|---|
| `NotAllowedError` | "Necesitamos acceso a tu cámara y micrófono. Actívalo en los ajustes del navegador." |
| `NotFoundError` | "No encontramos una cámara o micrófono en este dispositivo." |
| `NotReadableError` | "Otra aplicación está usando tu cámara. Ciérrala e intenta de nuevo." |
| `OverconstrainedError` | Retry with `{video:true, audio:true}` before showing anything. |

**Build the overlay** — `document.body.insertAdjacentHTML('beforeend', ...)`, `fixed inset-0`,
`z-[200]`, brand `#FFDB89` on `#030303`, all strings in Spanish, **zero emoji** (Font Awesome
only — `index.html` already loads it).

Layout: remote video full-bleed, local video picture-in-picture bottom-right, a control bar
with mute / camera / hang up, and a status line ("Llamando…", "Conectando…", "Conectado",
"Reconectando…"). Add a **minimise** button that shrinks it to a small floating pill — that's
what makes "talk while browsing their program" actually usable.

Remember `escHtml` (`app.js:15`) on the peer's name. It comes from the DB.

**Acceptance:** a button shows the overlay with your own face in both slots. Minimise, restore,
close, and reopen without leaking a `MediaStream` — check that the camera light goes out when
you close (call `stream.getTracks().forEach(t => t.stop())`).

---

## Day 5 — The actual peer connection

The core day. Public STUN only; TURN comes Day 7.

```js
const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

pc.ontrack = (e) => { remoteVideoEl.srcObject = e.streams[0]; };
pc.onicecandidate = (e) => {
    if (e.candidate) ws.send(JSON.stringify({ t:'rtc:ice', callId, candidate: e.candidate }));
};
```

**Caller** (after `call:accepted` arrives):

```js
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
ws.send(JSON.stringify({ t:'rtc:offer', callId, sdp: pc.localDescription }));
```

**Callee** (on `rtc:offer`):

```js
await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);
ws.send(JSON.stringify({ t:'rtc:answer', callId, sdp: pc.localDescription }));
```

### The one bug everyone hits

ICE candidates arrive *before* `setRemoteDescription` completes. Calling `addIceCandidate`
then throws `InvalidStateError` and you lose candidates — producing a call that connects
sometimes and hangs other times, which is the worst kind of bug.

**Queue them:**

```js
let remoteReady = false;
const pendingIce = [];

async function onRemoteDescriptionSet() {
    remoteReady = true;
    for (const c of pendingIce) await pc.addIceCandidate(new RTCIceCandidate(c));
    pendingIce.length = 0;
}

function onIceMessage(candidate) {
    if (remoteReady) pc.addIceCandidate(new RTCIceCandidate(candidate));
    else pendingIce.push(candidate);
}
```

### Testing setup — read before you start

- **Two cookie jars:** normal window (trainer) + incognito window (client). Same machine is fine.
- **`http://localhost` is a secure context**, so `getUserMedia` works without HTTPS.
- **`http://192.168.x.x:3000` is NOT.** The moment you test phone-to-laptop over LAN,
  `getUserMedia` returns `undefined` and you'll think your code is broken. Fix with `mkcert`:

```bash
brew install mkcert && mkcert -install && mkcert localhost 192.168.1.50
```

  then run an HTTPS listener locally, or launch Chrome with
  `--unsafely-treat-insecure-origin-as-secure=http://192.168.1.50:3000`.
- **`chrome://webrtc-internals`** is your debugger. It shows the ICE candidate pairs, which one
  was selected, and live bitrate. Open it before you start guessing.

**Acceptance:** two windows on one machine, both video and audio flowing, `webrtc-internals`
showing a selected candidate pair of type `host` or `srflx`.

**Commit. This is the milestone.**

---

# Week 2 — Make it survive contact with reality

## Day 6 — Ringing, and connecting the socket at login

Right now nothing tells a client a call is coming. Fix the plumbing.

**Connect the WebSocket at login, not at call time.** In `router()` (`public/app.js:~2010`),
right after the session resolves, for **both** roles:

```js
window.LiveSession.connect();   // opens /rtc, auto-reconnects with backoff
```

Reconnect with **exponential backoff and jitter** — 1s, 2s, 4s, 8s, capped at 30s, times a
random 0.5–1.5 factor. Without jitter, a Railway restart makes every client reconnect on the
same tick and you've built yourself a thundering herd.

**Caller entry point.** Add a "Sesión en vivo" button to the trainer's client detail view
(`clientes_content.html` / `openClientProfile` at `app.js:2637`), next to the existing tabs.
One line: `window.LiveSession.start(clientId, clientName)`.

**Callee ringing overlay.** On `call:incoming`, show a full-screen ring with caller name,
profile picture, Aceptar / Rechazar. Play a ringtone via the Web Audio API —
**`AudioContext` may start suspended until a user gesture**, so create it on any earlier click
and `resume()` it. If it's still suspended, fall back silently to the visual ring; never let
audio failure block the call.

Also add a `<title>` flash ("📞" is banned by your no-emoji rule — use `"Llamada entrante —
FitBySuárez"` alternating with the normal title) so a backgrounded tab is noticeable.

**Missed calls** land in the trainer's existing notification feed via
`createNotification({type:'live_session_missed'})` — which works only if you added the enum
value in §7.1.

**Nav item (optional).** If you want a "Sesiones" history page, it's three edits, in this order:
1. `<a>` block in `trainer-dashboard.html` (copy the "Pagos" one)
2. `MODULE_TITLES` in `app.js:~1745`
3. the `else if (linkText === 'Sesiones')` branch in the nav dispatcher at `app.js:~10583`

Note that nav dispatch matches on **link text**, not a data attribute. Fragile, but it's the
house pattern — match it rather than introducing a second convention.

**Acceptance:** trainer clicks call; client, sitting on the Nutrición page, sees the ring,
accepts, and lands in a working call with the nutrition page still behind the overlay.

---

## Day 7 — TURN  ✅ BUILT (managed provider)

Roughly 10–20% of real connections can't go direct. Symmetric NAT on carrier mobile data is the
common cause — which in Puerto Rico means a meaningful share of your clients.

**Decision taken: managed provider (Metered by default), not self-hosted coturn.** Same cost at
this volume, ~30 minutes of setup, and no VPS to patch at 2am. The trade is that you don't learn
the HMAC ephemeral-credential scheme first-hand — that's written up in the crash course instead.

### What exists

`GET /api/rtc/ice` (`server.js`), `authenticateToken` required:

- Calls the provider server-side and returns `{ iceServers, turn, cached?, degraded? }`
- **Credentials never reach the bundle.** Anyone holding a TURN credential can use your relay as
  free bandwidth on your bill.
- **5-minute server-side cache** — one upstream call regardless of how many clients ask
- **4-second timeout** — a slow provider must never hold up call setup
- **Degrades to STUN-only** on any failure, and when unconfigured. A call that *might* work
  peer-to-peer beats no call at all, and local dev keeps working with no credentials.
- STUN is always kept **first** in the list: ICE prefers the cheap path when it works.

Browser side (`public/live-session.js`): fetches once per session, caches for 4 minutes, dedupes
concurrent requests, prefetches on socket open so call setup never waits, falls back to STUN.

### To go live

1. Sign up at [metered.ca](https://metered.ca), create a TURN app
2. Set `TURN_APP` and `TURN_API_KEY` in Railway
3. Redeploy. `GET /api/rtc/ice` should return `turn: true`

Switching provider is **one function** — `fetchIceServers()` in `server.js`. Twilio and Cloudflare
endpoints are documented in `.env.example`; the response shape and the entire browser side are
unchanged.

### Verifying TURN actually works

This is the part people get wrong. **On one LAN, ICE always finds a direct path and never touches
the relay** — so a working call proves nothing about TURN.

Force it from the browser console:

```js
LiveSession._forceRelay(true);    // iceTransportPolicy: 'relay'
// ...place a call...
LiveSession._forceRelay(false);   // back to normal
```

With relay forced, **every** candidate must come from TURN. If the call connects, TURN works. If it
doesn't, your credentials or your provider config are wrong — and you've learned that at your desk
instead of from a client who couldn't connect.

*(Verified: with relay forced and no TURN configured, the call correctly fails — 0 ICE candidates
gathered, SDP still exchanged, no crash. With policy back to `all` it connects again. That
pair is what proves the switch is real.)*

Also test one leg on cellular with Wi-Fi off — that's the case TURN exists for.

### Measuring the bill

Every connected call reports its selected candidate pair via `call:stats`, stored as
`CallSession.connectionType` (`p2p` | `relay`). After a month:

```js
db.callsessions.aggregate([
  { $match: { status: 'ended' } },
  { $group: { _id: '$connectionType', n: { $sum: 1 } } }
])
```

That's your **real** relay rate, and therefore your real TURN bill. Everyone quotes 10–20%; your
users, your island, your carriers.

## Day 8 — Resilience

The gap between "works on my machine" and "works" is this day. Budget all of it.

**1. Connection state machine.** Handle `pc.oniceconnectionstatechange`:

| State | Do |
|---|---|
| `connected` / `completed` | Status → "Conectado". Clear any reconnect timer. |
| `disconnected` | Status → "Reconectando…". **Wait 5s** — this often self-heals. |
| `failed` | ICE restart (below). |
| `closed` | Tear down. |

**2. ICE restart** — recovers a call when someone switches Wi-Fi → cellular, instead of
dropping it:

```js
const offer = await pc.createOffer({ iceRestart: true });
await pc.setLocalDescription(offer);
ws.send(JSON.stringify({ t:'rtc:offer', callId, sdp: pc.localDescription }));
```

Only the **caller** should initiate a restart. If both sides restart simultaneously you get
glare — two competing offers and a permanently broken negotiation. One side owns it. (The
formal fix is "perfect negotiation" with a polite/impolite peer; for a fixed 1:1 caller/callee
pair, "caller restarts" is simpler and sufficient.)

**3. Teardown must be idempotent.** Write one `cleanup()` and call it from every exit path —
hang up, remote hang up, socket close, `beforeunload`, ICE failed, error:

```js
function cleanup() {
    if (cleanedUp) return;           // guard — this WILL be called twice
    cleanedUp = true;
    localStream?.getTracks().forEach(t => t.stop());   // camera light off
    pc?.getSenders().forEach(s => s.track?.stop());
    pc?.close();
    remoteVideoEl.srcObject = null;
    overlayEl?.remove();
    clearInterval(durationTimer);
    stopRingtone();
}
```

A leaked `MediaStream` leaves the camera light on after the call. Users notice, and they do not
forgive it.

**4. `beforeunload`** — send `call:end` before the tab closes, so the other side isn't left
staring at a frozen frame for 20 seconds.

**5. Mobile browser reality:** iOS Safari suspends video when the tab backgrounds. Detect via
`document.visibilitychange` and show "El otro participante puso la app en segundo plano." Also
set `playsinline` on both `<video>` elements or iOS force-fullscreens them.

**6. Autoplay:** call `remoteVideo.play()` inside the accept-button click handler. A `play()`
outside a user gesture is blocked, and you get audio with a black frame.

---

## Day 9 — Polish and integration

- **Spanish everywhere.** Every status, error, and button. You have a house style — match it.
- **Call duration timer** in the overlay, `mm:ss`, from `answeredAt`.
- **Call history.** `GET /api/calls?clientId=` → render a "Sesiones en vivo" panel in the
  trainer's client detail, next to Pagos. Show date, duration, status. Use `canTouchClient`.
- **Busy handling.** If the callee already has an `active` call, reply `call:declined` with
  `reason:'busy'` → "Ocupado en otra sesión."
- **Pre-call check.** Before inviting, `enumerateDevices()` and confirm a camera and a mic
  exist. Failing before you ring is much better than failing after.
- **Responsive.** Test at 375px. The control bar needs to clear the iOS home indicator —
  `padding-bottom: env(safe-area-inset-bottom)`.
- **Tailwind.** You use the CDN in dev but ship a compiled `output.css`. Run
  `npm run build:css` after adding classes, and commit it. New classes that only exist in
  `live-session.js` template strings need the content glob to cover `./public/**/*.js` — it
  already does.
- **`ADMIN-GUIDE.md`** — add a short "Sesiones en vivo" section for Ernesto-style operators:
  how to start one, what the statuses mean, what to do when a client can't connect.

---

## Day 10 — Deploy, verify, document

**Env vars (Railway):**

```
TURN_STATIC_AUTH_SECRET=<random>
TURN_HOST=turn.fitbysuarez.com
```

Add both to `.env.example` with comments.

**Railway notes:**
- WebSockets work on the same port as HTTP — no extra config, no second service.
- The proxy has an idle timeout; your 30-second `ping` from Day 1 handles it.
- **If you ever scale past one instance, the in-memory `peers` Map breaks** — two users on
  different instances can't find each other. The fix is a Redis pub/sub adapter. You're on one
  instance, so this is a note for later, not work for now. Write it down in `TECHNICAL.md` so
  future-you finds it before production does.

**Production verification script.** Follow the shape of
`docs/GO-LIVE-payments-test.md` — that file is a good pattern. Cover:

1. Trainer → client call on the same Wi-Fi (expect `p2p`)
2. Trainer on Wi-Fi → client on cellular (expect a real connection; check `connectionType`)
3. Decline path → caller sees "Rechazada"
4. Missed path (don't answer 45s) → notification appears in the trainer's feed
5. Mid-call Wi-Fi→cellular switch → ICE restart recovers it
6. Hang up from each side → `CallSession` correct in DB
7. Two tabs for the same client → both ring, accepting in one stops the other
8. **Clean up every test `CallSession` doc** — this is your production database

**Docs (your standing rule — same turn as the feature):**
- `TECHNICAL.md` — new section: the model, the protocol table, the auth flow, the single-instance
  `peers` limitation, the TURN credential scheme
- `README.md` — add live sessions to the feature list
- `docs/README.md` — add this file to "The parts"

**Stretch if you're ahead:** screen share is genuinely ~30 lines, because the hard part is
already built:

```js
const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
const sender = pc.getSenders().find(s => s.track?.kind === 'video');
await sender.replaceTrack(screen.getVideoTracks()[0]);
screen.getVideoTracks()[0].onended = () =>
    sender.replaceTrack(localStream.getVideoTracks()[0]);   // back to camera
```

`replaceTrack` swaps the outgoing track without renegotiating — no new offer/answer. A trainer
sharing a program grid while talking is a strong feature for 30 lines.

---

## What you'll actually have learned

This is the point of the exercise, so it's worth naming:

- **Protocol upgrade** — HTTP → WebSocket, and why auth must happen before the handshake
- **Stateful connections** — a peer registry, heartbeats, reconnection with backoff and jitter,
  and why in-memory state caps you at one instance (the natural bridge to your Redis and
  containerization questions)
- **Distributed state machines** — two clients and a server agreeing on one call's status, with
  either side able to vanish at any moment
- **NAT traversal** — STUN, TURN, ICE candidate types, and why ~15% of the internet can't talk
  to itself directly
- **Stateless credentials** — HMAC-signed, self-expiring TURN usernames with no DB lookup
- **Real-time media** — tracks, streams, renegotiation, device permissions, and the browser
  autoplay and secure-context rules that gate all of it
- **Authorization on a message bus** — the discipline of re-checking permission on every single
  relayed frame, not just at connection time

That list is a much better interview story than "I added a Zoom link."

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| CSP blocks the socket, silently | **High** | Fixed on Day 1, before any client code |
| ICE candidates arrive before remote SDP | **High** | The queue in Day 5 |
| Call UI destroyed by `updateContent()` | **High** | Body-level fixed overlay, Day 4 |
| `Notification` enum rejects the new type | **Medium** | Enum edit in §7.1 |
| Leaked `MediaStream`, camera light stays on | **Medium** | Idempotent `cleanup()`, Day 8 |
| Can't test TURN on one LAN | **Medium** | `iceTransportPolicy:'relay'`, Day 7 |
| Two weeks isn't enough | **Medium** | Days 1–5 are the milestone. If Week 2 slips, you still have a working call; ship it behind a flag for your own account only. |
| Railway multi-instance breaks `peers` | Low (today) | Documented; Redis adapter when it matters |

**If you have to cut:** Day 7 (TURN) is the one thing you cannot cut — without it, calls just
fail for a chunk of real users and you won't know why. Cut call history (Day 9) and screen
share (Day 10) first.
