// =============================================================================
// signaling.js — WebRTC signaling over WebSocket
// =============================================================================
// Live sessions (trainer <-> client video calls) need a low-latency, two-way
// channel so the two browsers can exchange SDP offers/answers and ICE candidates
// before they connect directly to each other. HTTP can't do that: the server has
// no way to push "you have an incoming call" to a browser that isn't asking.
//
// The MEDIA never touches this server. Once the two peers have swapped their SDP
// and ICE candidates, audio/video flows browser-to-browser (or via TURN). This
// file only handles introductions and bookkeeping — a few KB per call.
//
// DAY 1: authenticated upgrade, peer registry, heartbeat.
// DAY 2: the message protocol — validation, per-frame authorization, relay.
// DAY 3: call lifecycle (invite/accept/decline/end) writes to CallSession.
//
// ─── PROTOCOL ────────────────────────────────────────────────────────────────
//
// CLIENT -> SERVER
//   { t:'ping' }                                  liveness probe visible to browser JS
//   { t:'call:invite',  toUserId }                start a call
//   { t:'call:accept',  callId }
//   { t:'call:decline', callId, reason? }
//   { t:'call:end',     callId }
//   { t:'call:stats',   callId, connectionType }   'p2p' | 'relay' | 'unknown'
//   { t:'call:peerstate', callId, state }         'background' | 'foreground'
//   { t:'rtc:offer',    callId, sdp }             SDP offer      -> peer
//   { t:'rtc:answer',   callId, sdp }             SDP answer     -> peer
//   { t:'rtc:ice',      callId, candidate }       ICE candidate  -> peer
//
// SERVER -> CLIENT
//   { t:'hello', userId, role }                   sent on connect
//   { t:'pong', at }
//   { t:'call:incoming', callId, from:{id,name} }  -> every socket the callee has
//   { t:'call:ringing',  callId }                  -> caller: the callee is alerting
//   { t:'call:accepted', callId }                  -> caller
//   { t:'call:declined', callId, reason }          -> caller
//   { t:'call:ended',    callId, by, status, durationSec, reason? }
//   { t:'call:handled',  callId, bySocket }        -> the callee's OTHER tabs: stop
//                                                    ringing, someone else took it
//   { t:'rtc:offer' | 'rtc:answer' | 'rtc:ice', callId, from, ... }     relayed
//   { t:'call:peerstate', callId, from, state }                         relayed
//   { t:'error', code, message }
//
// THE RULE THAT MATTERS: the server never relays a frame just because it arrived.
// Every rtc:* message re-loads the CallSession and proves the sender is one of its
// two participants, then forwards ONLY to the other one. Skip that and any logged-in
// user can inject an SDP offer into any call by guessing an ObjectId — and an SDP
// offer controls where media flows. That is a real hijack, not a theoretical one.
//
// See docs/07-live-sessions-webrtc.md for the full plan.
// =============================================================================

import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

// Read JWT_SECRET at call time, not module-load time. ES module imports are
// hoisted, so dotenv.config() in server.js has NOT run when this module is first
// evaluated — process.env.JWT_SECRET would be undefined at the top level. Same
// reasoning as middleware/auth.js.
const getJwtSecret = () => process.env.JWT_SECRET || 'CHANGE_ME_IN_PRODUCTION';

const DEBUG = () => process.env.DEBUG === 'true';

// A browser cannot be trusted about size. ws defaults maxPayload to 100 MB, which
// means one client can make the server allocate 100 MB per frame. A big SDP is a
// few KB; an ICE candidate is bytes. 64 KB is generous and caps the damage.
const MAX_PAYLOAD_BYTES = 64 * 1024;

// Invites are expensive (DB writes, notifications, a ringing phone). ICE candidates
// are NOT — dozens arrive per second during negotiation and must not be throttled.
// So the limits are per-type, not global.
// Counts REJECTED invites too (bad target, not-allowed, busy). That's deliberate —
// those are the cheap probes worth throttling — but it means the ceiling has to be
// high enough that a trainer who mistypes twice isn't locked out of a real session.
const inviteLimit = () => Number(process.env.RTC_INVITE_LIMIT) || 10;   // per user
const INVITE_WINDOW_MS = 60 * 1000;
// Blanket per-socket ceiling. Generous enough for an ICE flood, low enough that a
// tight while(true) send loop gets cut off.
const MSG_LIMIT = 300;
const MSG_WINDOW_MS = 10 * 1000;

// How long a call rings before it becomes a missed call. Enforced on the SERVER:
// the caller can close their laptop mid-ring, and a browser setTimeout would die
// with the tab, leaving the CallSession stuck at 'ringing' forever — which then
// blocks every future call via the busy check below.
// Read at CALL time, not module-load time — same reason as getJwtSecret() above.
// ES module imports are hoisted, so anything that sets these env vars in an
// importing file runs AFTER this module is evaluated; a top-level const would bake
// in the default and silently ignore the configured value.
const ringTimeoutMs = () => Number(process.env.RTC_RING_TIMEOUT_MS) || 45 * 1000;

// A dropped socket is not a hang-up. A tab reload, a Wi-Fi->cellular switch, or a
// tunnel change all disconnect briefly and reconnect. Only end the call if the user
// is still gone after this long.
const disconnectGraceMs = () => Number(process.env.RTC_GRACE_MS) || 20 * 1000;

// A Mongo ObjectId is exactly 24 hex characters. Checking the SHAPE before querying
// means a garbage callId costs a regex instead of a database round-trip — and
// findById() THROWS a CastError on a malformed id rather than returning null, which
// inside an async event listener is an unhandled rejection.
const isObjectId = (v) => typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);

// SDP and ICE payloads are forwarded to another browser's RTCPeerConnection, so they
// get shape-checked first. We do NOT parse or rewrite the SDP itself — that is the
// peers' business — but we refuse anything that isn't the expected object shape.
const isSdp = (v) => !!v && typeof v === 'object'
    && typeof v.type === 'string' && ['offer', 'answer'].includes(v.type)
    && typeof v.sdp === 'string' && v.sdp.length > 0;

const isIceCandidate = (v) => !!v && typeof v === 'object'
    && typeof v.candidate === 'string';

// iOS Safari suspends video when a tab backgrounds, so the peer sees a frozen
// frame with no explanation. This lets the backgrounded side say so.
const isPeerState = (v) => v === 'background' || v === 'foreground';

/** Sliding-window counter. Returns true when the action is allowed. */
const allow = (store, key, limit, windowMs) => {
    const now = Date.now();
    const hits = (store.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) { store.set(key, hits); return false; }
    hits.push(now);
    store.set(key, hits);
    return true;
};

// userId -> timestamps. Module scope, so it survives reconnects: otherwise a client
// could reset its own limit just by dropping and reopening the socket.
const inviteHits = new Map();

// ── Peer registry ────────────────────────────────────────────────────────────
// userId (string) -> Set<WebSocket>
//
// A Set, not a single socket: one user legitimately has several connections —
// a laptop tab and a phone browser, or two tabs of the dashboard. An incoming
// call has to ring ALL of them, and accepting on one has to stop the others.
//
// NOTE (scaling): this Map lives in THIS process's memory. If the app is ever
// run on more than one Railway instance, two users on different instances cannot
// find each other and calls silently fail to ring. The fix is a Redis pub/sub
// adapter so instances can relay to one another. Single instance today — this is
// a documented limit, not a bug to chase.
const peers = new Map();

/** Parse a raw Cookie header into an object. */
const parseCookies = (header = '') =>
    Object.fromEntries(
        header
            .split(';')
            .map((c) => c.trim().split('='))
            .filter((p) => p.length === 2)
            .map(([k, v]) => {
                try { return [k, decodeURIComponent(v)]; }
                catch { return [k, v]; }   // malformed %-escape: keep it raw
            })
    );

/** Send a JSON message to one socket, if it's still open. */
export const send = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

/**
 * Send to EVERY socket a user has open.
 * Returns false when the user has no live connection (i.e. they're offline) so
 * callers can fail fast instead of ringing into the void.
 */
export const sendToUser = (userId, obj) => {
    const set = peers.get(String(userId));
    if (!set || set.size === 0) return false;
    set.forEach((ws) => send(ws, obj));
    return true;
};

/** Is this user connected right now? */
export const isOnline = (userId) => (peers.get(String(userId))?.size ?? 0) > 0;

// ── Call lifecycle ───────────────────────────────────────────────────────────

// callId -> timeout. Both are IN-PROCESS: see finishCall()'s note about restarts.
const ringTimers  = new Map();
const graceTimers = new Map();

const clearTimer = (store, callId) => {
    const t = store.get(String(callId));
    if (t) { clearTimeout(t); store.delete(String(callId)); }
};

/** Both parties, minus whoever is excluded. */
const notifyBoth = (call, obj, exceptUserId = null) => {
    [call.callerId, call.calleeId]
        .map(String)
        .filter((id) => id !== String(exceptUserId))
        .forEach((id) => sendToUser(id, obj));
};

/**
 * Terminal state transition. Guarded by a CONDITIONAL update: the `status` filter
 * means only one caller can ever win.
 *
 * Without that guard, two things racing to end the same call — the callee declining
 * at the same moment the 45s ring timer fires — would both succeed, both notify, and
 * the second would overwrite the first's status. A findOneAndUpdate filtered on the
 * status we expect makes the loser a no-op.
 */
const finishCall = async (callId, { status, endedBy = null, reason = '' }) => {
    const CallSession = deps.CallSession;
    clearTimer(ringTimers, callId);
    clearTimer(graceTimers, callId);

    // Read first, only to learn answeredAt — duration counts from when the call was
    // ANSWERED, not from when it started ringing. A 45-second ring is not 45 seconds
    // of call.
    const current = await CallSession.findById(callId).select('answeredAt status').lean();
    if (!current || !['ringing', 'active'].includes(current.status)) return null;

    const now = new Date();
    const durationSec = current.answeredAt
        ? Math.max(0, Math.floor((now - new Date(current.answeredAt)) / 1000))
        : 0;

    // The `status` filter is the race guard, and it is the important part: the callee
    // declining at the exact moment the 45s ring timer fires would otherwise BOTH
    // succeed, both notify, and the second would overwrite the first. Filtering on the
    // status we expect makes the loser a no-op that returns null.
    return CallSession.findOneAndUpdate(
        { _id: callId, status: { $in: ['ringing', 'active'] } },
        { $set: { status, endedAt: now, endedBy, failureReason: reason, durationSec } },
        { new: true }
    );
};

/** Fire a missed-call notification into the trainer's existing feed. */
const notifyMissed = async (call) => {
    if (!deps.createNotification) return;
    try {
        await deps.createNotification({
            clientId:   call.calleeId,
            clientName: call.calleeName || 'Cliente',
            type:       'live_session_missed',
            title:      'Sesión en vivo no contestada',
            message:    `${call.calleeName || 'El cliente'} no contestó la llamada.`,
            data:       { callId: String(call._id) },
        });
    } catch (err) {
        // Never let a notification failure break the call flow.
        if (DEBUG()) console.error('[rtc] missed-call notification failed:', err.message);
    }
};

/** Arm the server-side ring timeout. */
const armRingTimer = (call) => {
    const id = String(call._id);
    clearTimer(ringTimers, id);
    const t = setTimeout(async () => {
        ringTimers.delete(id);
        try {
            const ended = await finishCall(id, { status: 'missed', reason: 'ring_timeout' });
            if (!ended) return;                       // already answered/declined — fine
            notifyBoth(ended, { t: 'call:ended', callId: id, status: 'missed', by: null, durationSec: 0, reason: 'no_answer' });
            // Only file a notification when the CLIENT failed to answer. If the
            // trainer walked away from their own outgoing call, telling them about
            // it is noise.
            if (String(ended.calleeId) !== String(ended.trainerId)) await notifyMissed(ended);
        } catch (err) {
            if (DEBUG()) console.error('[rtc] ring timer failed:', err);
        }
    }, ringTimeoutMs());
    t.unref?.();
    ringTimers.set(id, t);
};

/**
 * Load a call and prove this socket is a participant. Same four-step check the relay
 * path uses — every lifecycle message re-authorizes, exactly like every rtc:* frame.
 */
const loadAsParticipant = async (ws, callId, { allow = ['ringing', 'active'] } = {}) => {
    if (!deps.CallSession) { send(ws, { t: 'error', code: 'NOT_READY' }); return null; }
    if (!isObjectId(callId)) { send(ws, { t: 'error', code: 'BAD_CALL_ID' }); return null; }

    let call;
    try {
        call = await deps.CallSession.findById(callId).lean();
    } catch (err) {
        if (DEBUG()) console.error('[rtc] lookup failed:', err.message);
        send(ws, { t: 'error', code: 'LOOKUP_FAILED' });
        return null;
    }
    if (!call) { send(ws, { t: 'error', code: 'NO_CALL' }); return null; }

    const me = String(ws.user.id);
    if (me !== String(call.callerId) && me !== String(call.calleeId)) {
        if (DEBUG()) console.warn(`[rtc] FORBIDDEN lifecycle: ${ws.user.email} -> ${callId}`);
        send(ws, { t: 'error', code: 'FORBIDDEN' });
        return null;
    }
    if (!allow.includes(call.status)) {
        send(ws, { t: 'error', code: 'CALL_OVER', callId: String(callId), status: call.status });
        return null;
    }
    return call;
};

// ── Relay ────────────────────────────────────────────────────────────────────

/**
 * Forward an rtc:* frame to the OTHER participant of a call.
 *
 * This is the security core of the whole feature. Four things are checked, in this
 * order, and every one of them matters:
 *
 *   1. callId is a well-formed ObjectId   — cheap reject, and findById() throws a
 *                                            CastError on malformed input
 *   2. the call exists
 *   3. THE SENDER IS A PARTICIPANT        — the check that stops call hijacking
 *   4. the call is still live             — no injecting into a finished call
 *
 * Note what is NOT trusted: `msg.from`, or any other field the client may have put
 * in the frame. The recipient is told who sent it based on `ws.user.id`, which came
 * from the server's own jwt.verify() at upgrade time.
 */
const relayToPeer = async (ws, msg, payload) => {
    const CallSession = deps.CallSession;
    if (!CallSession) return send(ws, { t: 'error', code: 'NOT_READY', message: 'Signaling not initialised.' });

    if (!isObjectId(msg.callId)) {
        return send(ws, { t: 'error', code: 'BAD_CALL_ID', message: 'Invalid call id.' });
    }

    let call;
    try {
        call = await CallSession.findById(msg.callId).select('callerId calleeId status').lean();
    } catch (err) {
        if (DEBUG()) console.error('[rtc] relay lookup failed:', err.message);
        return send(ws, { t: 'error', code: 'LOOKUP_FAILED', message: 'Could not load the call.' });
    }
    if (!call) return send(ws, { t: 'error', code: 'NO_CALL', message: 'Call not found.' });

    const me = String(ws.user.id);
    const caller = String(call.callerId);
    const callee = String(call.calleeId);

    // THE check. Same generic error as NO_CALL would be even better (it stops an
    // attacker distinguishing "call exists but isn't yours" from "no such call"),
    // but a distinct code is far easier to debug and the ids are unguessable.
    if (me !== caller && me !== callee) {
        if (DEBUG()) console.warn(`[rtc] FORBIDDEN relay: ${ws.user.email} -> call ${msg.callId}`);
        return send(ws, { t: 'error', code: 'FORBIDDEN', message: 'Not a participant in this call.' });
    }

    if (call.status !== 'ringing' && call.status !== 'active') {
        return send(ws, { t: 'error', code: 'CALL_OVER', callId: msg.callId, status: call.status });
    }

    // Rebuild the outgoing frame from an ALLOWLIST. Forwarding the client's object
    // verbatim would pass through any extra keys it invented, straight into the
    // other browser's handler. Only these fields cross.
    const out = { t: msg.t, callId: msg.callId, from: me, ...payload };

    if (!sendToUser(me === caller ? callee : caller, out)) {
        // The peer has no live socket — a closed laptop, a dropped tunnel. Tell the
        // sender rather than letting them negotiate against silence.
        send(ws, { t: 'error', code: 'PEER_OFFLINE', callId: msg.callId });
    }
};

// ── Dispatch ─────────────────────────────────────────────────────────────────

// Codes that are the user's problem, mapped to Spanish. Anything else stays generic.
const TARGET_ERRORS = {
    BAD_TARGET:      'Usuario inválido.',
    SELF_CALL:       'No puedes llamarte a ti mismo.',
    NO_USER:         'Ese usuario no existe.',
    TARGET_INACTIVE: 'Esa cuenta está inactiva.',
    NOT_ALLOWED:     'No puedes llamar a este usuario.',
    NO_TRAINER:      'Este cliente no tiene entrenador asignado.',
};

const onInvite = async (ws, msg) => {
    const CallSession = deps.CallSession;
    if (!CallSession || !deps.resolveCallTarget) return send(ws, { t: 'error', code: 'NOT_READY' });

    // 1. May this user call that user, and who are they?
    const target = await deps.resolveCallTarget(ws.user, msg.toUserId);
    if (!target.ok) {
        return send(ws, { t: 'error', code: target.code, message: TARGET_ERRORS[target.code] || 'No se pudo iniciar la llamada.' });
    }

    const me = String(ws.user.id);
    const to = String(msg.toUserId);

    // 2. Is either party already busy?
    //
    // The `ringing` arm is time-bounded on purpose. ringTimers live in memory, so a
    // deploy or crash mid-ring leaves rows stuck at 'ringing' with no timer left to
    // clear them — and an unbounded query would then treat those ghosts as "busy"
    // and block both users from ever calling again. Ignoring stale rings makes the
    // system self-heal from a restart.
    const freshRing = new Date(Date.now() - ringTimeoutMs());
    const busy = await CallSession.findOne({
        $and: [
            { $or: [{ status: 'active' }, { status: 'ringing', startedAt: { $gte: freshRing } }] },
            { $or: [{ callerId: me }, { calleeId: me }, { callerId: to }, { calleeId: to }] },
        ]
    }).select('_id callerId calleeId').lean();

    if (busy) {
        const mine = String(busy.callerId) === me || String(busy.calleeId) === me;
        return send(ws, {
            t: 'error', code: mine ? 'ALREADY_IN_CALL' : 'PEER_BUSY',
            message: mine ? 'Ya estás en una llamada.' : 'Esa persona está ocupada en otra sesión.',
        });
    }

    // 3. Create the attempt. The row exists from the INVITE, not from the connection,
    //    because "nobody answered" is precisely the case worth recording.
    const call = await CallSession.create({
        callerId: me, calleeId: to, trainerId: target.trainerId,
        callerName: target.callerName, calleeName: target.calleeName,
        status: 'ringing',
    });
    const callId = String(call._id);

    // 4. Ring every device the callee has.
    const delivered = sendToUser(to, {
        t: 'call:incoming', callId,
        from: { id: me, name: target.callerName, role: ws.user.role },
    });

    if (!delivered) {
        // Offline: fail immediately rather than making the caller wait out 45 seconds
        // of silence for an answer that cannot come.
        const ended = await finishCall(callId, { status: 'missed', reason: 'callee_offline' });
        send(ws, { t: 'call:ended', callId, status: 'missed', by: null, durationSec: 0, reason: 'offline' });
        if (ended && String(ended.calleeId) !== String(ended.trainerId)) await notifyMissed(ended);
        return;
    }

    send(ws, { t: 'call:ringing', callId, to });
    armRingTimer(call);
};

const onAccept = async (ws, msg) => {
    const call = await loadAsParticipant(ws, msg.callId, { allow: ['ringing'] });
    if (!call) return;

    // Only the CALLEE accepts. A caller "accepting" their own invite would mark it
    // answered without anyone picking up.
    if (String(ws.user.id) !== String(call.calleeId)) {
        return send(ws, { t: 'error', code: 'NOT_CALLEE', message: 'Solo quien recibe puede aceptar.' });
    }

    const callId = String(call._id);
    // Conditional update again: two tabs tapping Aceptar at the same instant must
    // produce exactly one winner.
    const updated = await deps.CallSession.findOneAndUpdate(
        { _id: callId, status: 'ringing' },
        { $set: { status: 'active', answeredAt: new Date() } },
        { new: true }
    );
    if (!updated) return send(ws, { t: 'error', code: 'CALL_OVER', callId });

    clearTimer(ringTimers, callId);
    sendToUser(call.callerId, { t: 'call:accepted', callId });
    send(ws, { t: 'call:accepted', callId, self: true });
    // Stop the OTHER tabs ringing. They compare bySocket to their own id and know it
    // wasn't them.
    sendToUser(call.calleeId, { t: 'call:handled', callId, bySocket: ws._sid });
};

const onDecline = async (ws, msg) => {
    const call = await loadAsParticipant(ws, msg.callId, { allow: ['ringing'] });
    if (!call) return;
    if (String(ws.user.id) !== String(call.calleeId)) {
        return send(ws, { t: 'error', code: 'NOT_CALLEE', message: 'Solo quien recibe puede rechazar.' });
    }

    const callId = String(call._id);
    const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : 'declined';
    const ended = await finishCall(callId, { status: 'declined', endedBy: ws.user.id, reason });
    if (!ended) return send(ws, { t: 'error', code: 'CALL_OVER', callId });

    sendToUser(call.callerId, { t: 'call:declined', callId, reason });
    sendToUser(call.calleeId, { t: 'call:handled', callId, bySocket: ws._sid });
};

const onEnd = async (ws, msg) => {
    const call = await loadAsParticipant(ws, msg.callId);
    if (!call) return;

    const callId = String(call._id);
    const wasRinging = call.status === 'ringing';
    // Hanging up a call that never connected is a cancellation, not a completed call.
    const status = wasRinging ? 'missed' : 'ended';
    const reason = wasRinging
        ? (String(ws.user.id) === String(call.callerId) ? 'cancelled_by_caller' : 'cancelled_by_callee')
        : 'hangup';

    const ended = await finishCall(callId, { status, endedBy: ws.user.id, reason });
    if (!ended) return send(ws, { t: 'error', code: 'CALL_OVER', callId });

    notifyBoth(ended, {
        t: 'call:ended', callId, status,
        by: String(ws.user.id), durationSec: ended.durationSec, reason,
    });
};

/**
 * The browser reports which ICE candidate pair actually won. This is the only way to
 * learn your REAL TURN relay rate — which is the only thing TURN bills you for.
 */
const onStats = async (ws, msg) => {
    if (!['p2p', 'relay', 'unknown'].includes(msg.connectionType)) {
        return send(ws, { t: 'error', code: 'BAD_STATS' });
    }
    const call = await loadAsParticipant(ws, msg.callId);
    if (!call) return;
    await deps.CallSession.updateOne({ _id: call._id }, { $set: { connectionType: msg.connectionType } });
};

// Table, not an if/else chain: adding a message type is one line, and an unknown
// type can never fall through to something unintended.
const HANDLERS = {
    'ping': (ws) => send(ws, { t: 'pong', at: Date.now() }),

    'rtc:offer': (ws, msg) => isSdp(msg.sdp)
        ? relayToPeer(ws, msg, { sdp: msg.sdp })
        : send(ws, { t: 'error', code: 'BAD_SDP', message: 'Expected an SDP offer.' }),

    'rtc:answer': (ws, msg) => isSdp(msg.sdp)
        ? relayToPeer(ws, msg, { sdp: msg.sdp })
        : send(ws, { t: 'error', code: 'BAD_SDP', message: 'Expected an SDP answer.' }),

    'rtc:ice': (ws, msg) => isIceCandidate(msg.candidate)
        ? relayToPeer(ws, msg, { candidate: msg.candidate })
        : send(ws, { t: 'error', code: 'BAD_ICE', message: 'Expected an ICE candidate.' }),

    // Rate-limited here rather than inside onInvite so the cap applies before any
    // database work happens.
    'call:invite': (ws, msg) => {
        if (!allow(inviteHits, String(ws.user.id), inviteLimit(), INVITE_WINDOW_MS)) {
            return send(ws, { t: 'error', code: 'RATE_LIMIT', message: 'Demasiadas llamadas. Espera un momento.' });
        }
        return onInvite(ws, msg);
    },
    // Relay-only, and it goes through relayToPeer() like every rtc:* frame: same
    // participant check, same allowlist reconstruction. Adding a message type to
    // this design costs one line here and one validator — which was the point of
    // the dispatch table.
    'call:peerstate': (ws, msg) => isPeerState(msg.state)
        ? relayToPeer(ws, msg, { state: msg.state })
        : send(ws, { t: 'error', code: 'BAD_STATE', message: 'Estado inválido.' }),

    'call:accept':  onAccept,
    'call:decline': onDecline,
    'call:end':     onEnd,
    'call:stats':   onStats,
};

/**
 * Entry point for every frame. Must NEVER throw: an uncaught error in a 'message'
 * listener kills the process, so any malformed frame from any client would be a
 * trivial denial of service. Note the .catch() on the async path too — an async
 * handler rejects rather than throws, and try/catch alone would not see it.
 */
const handleMessage = (ws, raw) => {
    if (!allow(ws._msgHits, 'm', MSG_LIMIT, MSG_WINDOW_MS)) {
        return send(ws, { t: 'error', code: 'RATE_LIMIT', message: 'Too many messages.' });
    }

    let msg;
    try {
        msg = JSON.parse(raw.toString());
    } catch {
        return send(ws, { t: 'error', code: 'BAD_JSON', message: 'Malformed message.' });
    }
    if (!msg || typeof msg.t !== 'string') {
        return send(ws, { t: 'error', code: 'BAD_SHAPE', message: 'Missing message type.' });
    }

    const handler = HANDLERS[msg.t];
    if (!handler) {
        if (DEBUG()) console.log('[rtc] unhandled message type:', msg.t);
        return send(ws, { t: 'error', code: 'UNKNOWN_TYPE', message: `Unknown type: ${msg.t}` });
    }

    try {
        const r = handler(ws, msg);
        if (r && typeof r.then === 'function') {
            r.catch((err) => {
                if (DEBUG()) console.error('[rtc] handler rejected:', err);
                send(ws, { t: 'error', code: 'SERVER_ERROR', message: 'Something went wrong.' });
            });
        }
    } catch (err) {
        if (DEBUG()) console.error('[rtc] handler threw:', err);
        send(ws, { t: 'error', code: 'SERVER_ERROR', message: 'Something went wrong.' });
    }
};

/**
 * Their last socket closed. Do NOT end their calls yet: a tab reload, a Wi-Fi to
 * cellular handover, or a tunnel change all look exactly like this and recover in a
 * second or two. Give them disconnectGraceMs() to come back.
 *
 * The timer re-checks isOnline() when it fires, so a reconnect on ANY socket cancels
 * the teardown without needing to track which call belongs to which connection.
 */
const onUserWentOffline = async (userId) => {
    const CallSession = deps.CallSession;
    if (!CallSession) return;

    let calls;
    try {
        calls = await CallSession.find({
            status: { $in: ['ringing', 'active'] },
            $or: [{ callerId: userId }, { calleeId: userId }],
        }).select('_id callerId calleeId status trainerId calleeName').lean();
    } catch (err) {
        if (DEBUG()) console.error('[rtc] offline sweep failed:', err.message);
        return;
    }

    for (const call of calls) {
        const id = String(call._id);
        if (graceTimers.has(id)) continue;

        const t = setTimeout(async () => {
            graceTimers.delete(id);
            if (isOnline(userId)) return;                 // they came back — leave it alone
            try {
                const wasRinging = call.status === 'ringing';
                const ended = await finishCall(id, {
                    status: wasRinging ? 'missed' : 'ended',
                    reason: 'peer_disconnected',
                });
                if (!ended) return;
                notifyBoth(ended, {
                    t: 'call:ended', callId: id, status: ended.status,
                    by: null, durationSec: ended.durationSec, reason: 'peer_disconnected',
                }, userId);
            } catch (err) {
                if (DEBUG()) console.error('[rtc] grace teardown failed:', err);
            }
        }, disconnectGraceMs());
        t.unref?.();
        graceTimers.set(id, t);
    }
};

/** Cancel pending teardowns for a user who just reconnected. */
const cancelGraceFor = async (userId) => {
    const CallSession = deps.CallSession;
    if (!CallSession || graceTimers.size === 0) return;
    try {
        const calls = await CallSession.find({
            _id: { $in: [...graceTimers.keys()] },
            $or: [{ callerId: userId }, { calleeId: userId }],
        }).select('_id').lean();
        calls.forEach((c) => clearTimer(graceTimers, String(c._id)));
    } catch (err) {
        if (DEBUG()) console.error('[rtc] grace cancel failed:', err.message);
    }
};

// Injected by server.js at boot. signaling.js must NOT import from server.js —
// server.js already imports this file, so that would be a circular import, and ESM
// hoisting would leave the model undefined at evaluation time anyway.
let deps = {};

/**
 * Attach the signaling WebSocket server to an existing http.Server.
 * Call this BEFORE server.listen().
 *
 * @param {http.Server} server
 * @param {{ CallSession: import('mongoose').Model }} dependencies
 */
export function attachSignaling(server, dependencies = {}) {
    deps = dependencies;
    // noServer:true means ws does NOT install its own upgrade listener. We handle
    // 'upgrade' ourselves so we can authenticate and REJECT before the handshake
    // completes. Once handleUpgrade() runs we're speaking the WebSocket protocol
    // and there is no clean way to send a 401 — the door only swings one way.
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

    server.on('upgrade', (req, socket, head) => {
        // Only our signaling path. Anything else gets dropped.
        const pathname = (req.url || '').split('?')[0];
        if (pathname !== '/rtc') return socket.destroy();

        // cookieParser() is Express middleware — it does NOT run on an upgrade
        // request, because an upgrade never enters the Express router. Parse the
        // raw header ourselves.
        const token = parseCookies(req.headers.cookie)['auth_token'];
        if (!token) {
            if (DEBUG()) console.log('[rtc] upgrade rejected: no auth_token cookie');
            return socket.destroy();
        }

        let decoded;
        try {
            decoded = jwt.verify(token, getJwtSecret());   // { id, email, role }
        } catch {
            if (DEBUG()) console.log('[rtc] upgrade rejected: invalid/expired token');
            return socket.destroy();
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            ws.user = decoded;
            ws.isAlive = true;
            // Identifies THIS tab. Used by call:handled so a user's other tabs can
            // tell "someone else answered" from "I answered".
            ws._sid = randomUUID();
            wss.emit('connection', ws, req);
        });
    });

    wss.on('connection', (ws) => {
        const uid = String(ws.user.id);
        if (!peers.has(uid)) peers.set(uid, new Set());
        peers.get(uid).add(ws);
        if (DEBUG()) console.log(`[rtc] connected: ${ws.user.email} (${peers.get(uid).size} socket(s))`);

        // Confirms to the browser that auth succeeded. Without this the client
        // only knows the socket opened, not that the server accepted the identity.
        send(ws, { t: 'hello', userId: uid, role: ws.user.role, socketId: ws._sid });

        // Reconnected inside the grace window? Cancel any pending teardown. Checking
        // isOnline() when the timer FIRES (rather than tracking reconnects) means this
        // is belt-and-braces, but it ends the grace period immediately instead of
        // leaving a call in limbo for the remainder of it.
        if (graceTimers.size) cancelGraceFor(uid);

        ws._msgHits = new Map();   // per-socket rate window, dies with the socket

        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', (raw) => handleMessage(ws, raw));
        ws.on('error', (err) => { if (DEBUG()) console.error('[rtc] socket error:', err.message); });

        ws.on('close', () => {
            const set = peers.get(uid);
            if (set) {
                set.delete(ws);
                if (set.size === 0) peers.delete(uid);   // don't leak empty Sets
            }
            if (DEBUG()) console.log(`[rtc] disconnected: ${ws.user.email}`);

            // Only when their LAST socket goes. Closing one of two tabs is not a
            // disconnect — the call is still reachable on the other one.
            if (!isOnline(uid)) onUserWentOffline(uid);
        });
    });

    // ── Heartbeat ────────────────────────────────────────────────────────────
    // Railway's proxy (like most) closes connections it believes are idle, and a
    // TCP socket can also die silently with no close frame — the peer just stops
    // existing. Without this, calls drop after ~60s of quiet and you blame WebRTC
    // for what is actually a proxy timeout.
    //
    // Each tick: terminate anyone who didn't answer the LAST ping, then ping
    // everyone and mark them dead-until-proven-alive. The browser answers pings
    // natively; no client code is needed.
    const heartbeat = setInterval(() => {
        wss.clients.forEach((ws) => {
            if (ws.isAlive === false) return ws.terminate();
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    // Don't hold the event loop open on shutdown.
    heartbeat.unref?.();
    wss.on('close', () => {
        clearInterval(heartbeat);
        ringTimers.forEach(clearTimeout);  ringTimers.clear();
        graceTimers.forEach(clearTimeout); graceTimers.clear();
    });

    console.log('WebSocket signaling attached at /rtc');
    return wss;
}
