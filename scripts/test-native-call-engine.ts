// Integration test for the NATIVE call engine (FitBySuarez-mobile/lib/live/session.ts).
//
// Runs TWO instances of the engine — a trainer and a client — against the REAL signaling
// server, with a fake peer connection that behaves like a strict browser (it rejects an ICE
// candidate that arrives before the remote description, which is how the candidate queue is
// exercised for real). There is no phone in this loop: that is the point. It proves the
// protocol, the state machine and the teardown; it cannot prove anything about a camera.
//
// Needs the mobile repo checked out NEXT TO this one, and an isolated server:
//
//   MONGO_URI=mongodb://localhost:27017/fbs_eng ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> LIVE_SESSIONS_ENABLED=true PORT=3027 node server.js
//   npx -y tsx scripts/test-native-call-engine.ts
//
// It creates and deletes its own client user and workouts in that database. NEVER point it
// at production. See TECHNICAL.md § 41.

// Drives TWO instances of the native call engine (trainer + client) against the REAL
// signaling server, with a fake peer connection that behaves like a strict browser.
import WebSocket from 'ws';
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';
import { LiveSession, type LivePlatform, type LiveTiming } from '../../FitBySuarez-mobile/lib/live/session';
import { localDateStr } from '../../FitBySuarez-mobile/lib/live/protocol';

const BASE = 'http://localhost:3027';
const WS_URL = 'ws://localhost:3027/rtc';
let pass = 0, fail = 0;
const check = (ok: boolean, label: string, extra = '') => {
  ok ? pass++ : fail++;
  console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(72), extra);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, ms = 4000, label = '') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  if (label) console.log('   (timed out waiting for: ' + label + ')');
  return false;
}

// ── fake WebRTC, one world per side ─────────────────────────────────────────
type Side = 'trainer' | 'client';
const world: Record<Side, any> = {} as any;
let bytesMode: 'growing' | 'frozen' = 'growing';
let failGetUserMedia: string | null = null;
let recoverAfterRestart = true;

function makeWebrtc(side: Side) {
  const w = { pcs: [] as FakePC[], streams: [] as FakeStream[], earlyIceRejected: 0, offersCreated: 0, restartOffers: 0, answersCreated: 0 };
  world[side] = w;
  class FakeTrack {
    enabled = true; readyState = 'live';
    constructor(public kind: string) {}
    stop() { this.readyState = 'ended'; }
  }
  class FakeStream {
    tracks: FakeTrack[]; released = false;
    constructor(tracks?: FakeTrack[]) { this.tracks = tracks ?? [new FakeTrack('audio'), new FakeTrack('video')]; w.streams.push(this); }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
    release() { this.released = true; }
  }
  class FakePC {
    iceConnectionState = 'new'; connectionState = 'new';
    localDescription: any = null; remoteDescription: any = null;
    senders: { track: FakeTrack }[] = []; added: any[] = []; closed = false;
    onicecandidate: any = null; ontrack: any = null;
    oniceconnectionstatechange: any = null; onconnectionstatechange: any = null;
    config: any; remoteStream = new FakeStream();
    constructor(config: any) { this.config = config; w.pcs.push(this); }
    addTrack(t: FakeTrack) { this.senders.push({ track: t }); }
    getSenders() { return this.senders; }
    async createOffer(opts?: any) { w.offersCreated++; if (opts?.iceRestart) w.restartOffers++; return { type: 'offer', sdp: `offer-${w.offersCreated}${opts?.iceRestart ? '-restart' : ''}` }; }
    async createAnswer() { w.answersCreated++; return { type: 'answer', sdp: `answer-${w.answersCreated}` }; }
    async setLocalDescription(d: any) {
      this.localDescription = d;
      // Real peers start gathering the instant a local description is set — i.e. BEFORE
      // the other side has the SDP. Two candidates, a few ms later.
      setTimeout(() => {
        if (this.closed) return;
        for (let i = 0; i < 2; i++) this.onicecandidate?.({ candidate: { candidate: `cand-${side}-${i}`, sdpMid: '0', sdpMLineIndex: 0, toJSON() { return { candidate: this.candidate, sdpMid: '0', sdpMLineIndex: 0 }; } } });
      }, 4);
      this.maybeConnect();
    }
    async setRemoteDescription(d: any) {
      await sleep(8 + Math.random() * 40);       // the window in which early ICE would arrive
      this.remoteDescription = d; this.added.length = 0;
      if (this.iceConnectionState === 'failed' && !recoverAfterRestart) {
        // A real browser retries the new ICE generation and, on a dead network, reports
        // `failed` AGAIN — that event is what drives the next restart attempt.
        setTimeout(() => { if (!this.closed) { this.setState('checking'); this.setState('failed'); } }, 30);
        return;
      }
      this.maybeConnect();
    }
    async addIceCandidate(c: any) {
      // A strict browser: this is InvalidStateError in Chrome/Safari.
      if (!this.remoteDescription) { w.earlyIceRejected++; throw new Error('InvalidStateError'); }
      this.added.push(c); this.maybeConnect();
    }
    maybeConnect() {
      if (this.closed || !this.localDescription || !this.remoteDescription || this.added.length < 1) return;
      if (this.iceConnectionState === 'connected') return;
      if (this.iceConnectionState === 'failed' && !recoverAfterRestart) return;
      this.iceConnectionState = 'connected'; this.connectionState = 'connected';
      this.ontrack?.({ track: this.remoteStream.tracks[0], streams: [this.remoteStream] });
      this.ontrack?.({ track: this.remoteStream.tracks[1], streams: [this.remoteStream] });
      this.oniceconnectionstatechange?.(); this.onconnectionstatechange?.();
    }
    setState(s: string) { this.iceConnectionState = s; this.connectionState = s; this.oniceconnectionstatechange?.(); this.onconnectionstatechange?.(); }
    private bytes = 0;
    async getStats() {
      if (bytesMode === 'growing') this.bytes += 5000;
      const m = new Map<string, any>();
      m.set('in', { type: 'inbound-rtp', isRemote: false, bytesReceived: this.bytes });
      m.set('lc', { type: 'local-candidate', candidateType: 'host' });
      m.set('pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'lc' });
      return m;
    }
    setConfiguration(c: any) { this.config = c; }
    close() { this.closed = true; this.iceConnectionState = 'closed'; }
  }
  return {
    RTCPeerConnection: FakePC as any,
    MediaStream: FakeStream as any,
    mediaDevices: { async getUserMedia() { if (failGetUserMedia) { const e: any = new Error('denied'); e.name = failGetUserMedia; throw e; } return new FakeStream(); } },
  };
}

// ── real sockets, with a log of every frame in both directions ──────────────
const frames: Record<Side, { in: any[]; out: any[] }> = { trainer: { in: [], out: [] }, client: { in: [], out: [] } };
const sockets: Record<Side, WebSocket[]> = { trainer: [], client: [] };

function makePlatform(side: Side, cookie: string): LivePlatform {
  return {
    webrtc: makeWebrtc(side),
    wsUrl: WS_URL,
    createSocket(url: string) {
      const ws = new WebSocket(url, { headers: { Cookie: cookie } });
      sockets[side].push(ws);
      const origSend = ws.send.bind(ws);
      (ws as any).send = (d: string) => { try { frames[side].out.push(JSON.parse(d)); } catch { /* */ } origSend(d); };
      // log inbound before the engine sees it
      ws.on('message', (m) => { try { frames[side].in.push(JSON.parse(String(m))); } catch { /* */ } });
      return ws as any;
    },
    async api(path, init) {
      const r = await fetch(BASE + path, { method: init?.method, body: init?.body, headers: { 'Content-Type': 'application/json', Cookie: cookie } });
      return { ok: r.ok, status: r.status, json: () => r.json() };
    },
  };
}

// ── set up users + a workout with the user's own example text ───────────────
const mongo = await new MongoClient('mongodb://localhost:27017').connect();
const db = mongo.db('fbs_eng');
const trainerDoc = await db.collection('users').findOne({ email: 'fitbysuarez@gmail.com' });
const clientId = new ObjectId();
await db.collection('users').insertOne({ _id: clientId, name: 'Jonathan', lastName: 'Maymí', email: 'jm@test.local',
  password: await bcrypt.hash('JonaTest!2026ab', 10), role: 'client', trainerId: trainerDoc!._id, group: 'General',
  isActive: true, isDeleted: false, isFirstLogin: false });
const today = localDateStr();
const mainEx = [
  { id: 1, name: 'Press de banca', instructions: '4 sets de 8 repeticiones.' },
  { id: 2, name: 'Remo con barra', instructions: '3 sets de 10 repeticiones.' },
  { id: 3, name: 'Fondos', instructions: '3 sets al fallo menos 2.' }];
const altEx = [
  { id: 11, name: 'Sentadilla en silla', instructions: 'Toca la silla/sofá y regresa arriba. 3 sets de 12 repeticiones.' },
  { id: 12, name: 'Flexiones inclinadas', instructions: '4 sets de 10 repeticiones.\nManos sobre el sofá.' },
  { id: 13, name: 'Plancha', instructions: '3 sets de 45 segundos.' },
  { id: 14, name: 'Puente de glúteos', instructions: '3 sets de 15 repeticiones.' }];
const seedWorkout = (chosen: string) => db.collection('clientworkouts').updateOne({ clientId, date: today },
  { $set: { clientId, date: today, title: 'Comeback — Full Body', isRest: false, exercises: mainEx,
    alternative: { label: 'At Home — Full Body Flow', exercises: altEx }, chosenBlock: chosen, updatedAt: new Date() } }, { upsert: true });
await seedWorkout('alternative');

const login = async (email: string, password: string) => {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
};
const cT = await login('fitbysuarez@gmail.com', 'TestPass!2026');
const cC = await login('jm@test.local', 'JonaTest!2026ab');

const FAST: LiveTiming = { recoveryGraceMs: 300, maxIceRestarts: 3, stallCheckMs: 120, stallTicksToAct: 3, iceTtlMs: 60000 };
const zero = () => 0;           // backoff jitter -> deterministic 500ms first retry
const T = new LiveSession(makePlatform('trainer', cT), FAST, Date.now, zero);
const C = new LiveSession(makePlatform('client', cC), FAST, Date.now, zero);
const sT = () => T.getSnapshot(), sC = () => C.getSnapshot();
const out = (side: Side, type: string) => frames[side].out.filter((f) => f.t === type);

T.connect(); C.connect();
await waitFor(() => sT().role !== null && sC().role !== null, 4000, 'hello');
check(sT().role === 'trainer' && sC().role === 'client', 'both sockets authenticated; roles come from the server', `${sT().role}/${sC().role}`);
check(sT().isTrainer === true && sC().isTrainer === false, 'isTrainer follows the server-verified role');

// ═══ CALL 1 — the whole happy path ═════════════════════════════════════════
const started = await T.start(String(clientId), 'Jonathan Maymí');
check(started === true, 'trainer.start() places the call');
await waitFor(() => sC().status === 'incoming', 3000, 'client ringing');
check(sC().status === 'incoming' && sC().peerName === 'Coach Suarez' && sC().mode === 'incoming', 'client sees an incoming call from the trainer', sC().peerName);
check(sC().localStream === null, 'client media is NOT acquired before they accept');
check(await C.accept(), 'client.accept()');
await waitFor(() => sT().status === 'connected' && sC().status === 'connected', 5000, 'both connected');
check(sT().status === 'connected' && sC().status === 'connected', 'both sides reach "connected"');
check(!!sT().remoteStream && !!sC().remoteStream, 'both sides have the other person\'s stream');
check(world.trainer.earlyIceRejected === 0 && world.client.earlyIceRejected === 0,
  'NO ICE candidate was applied before the remote description (the queue works)',
  `early rejected: ${world.trainer.earlyIceRejected}/${world.client.earlyIceRejected}`);
check(out('client', 'rtc:offer').length === 0, 'the CALLEE never sent an offer (no glare)');
check(out('trainer', 'rtc:offer').length === 1 && out('client', 'rtc:answer').length === 1, 'exactly one offer (caller) and one answer (callee)');
check(out('trainer', 'call:stats').length === 1, 'the connection type was reported once', JSON.stringify(out('trainer', 'call:stats')[0]?.connectionType));

// the exercise tile
await waitFor(() => sC().exercise !== null, 3000, 'client exercise');
const ex0 = sC().exercise!;
check(ex0.block === 'alternative' && ex0.label === 'At Home — Full Body Flow', "the client's choice (home) decides the routine", `${ex0.block} / ${ex0.label}`);
check(ex0.index === 0 && ex0.total === 4 && ex0.name === 'Sentadilla en silla', 'first exercise of the chosen routine, 1/4');
check(ex0.detail === 'Toca la silla/sofá y regresa arriba. 3 sets de 12 repeticiones.', "the text under the exercise name is delivered verbatim (the user's example)");
check(sT().exercise?.index === 0, "the trainer's own tile matches");

// trainer steps; client follows
await T.stepExercise(1); await waitFor(() => sC().exercise?.index === 1);
check(sC().exercise?.index === 1 && sC().exercise?.name === 'Flexiones inclinadas', 'trainer next -> client follows (2/4)');
check(sC().exercise?.detail.includes('\n'), 'multi-line instructions keep their line break');
await T.stepExercise(1); await T.stepExercise(1); await waitFor(() => sC().exercise?.index === 3);
await T.stepExercise(1); await sleep(150);
check(sC().exercise?.index === 3, 'stepping past the last exercise clamps at the end (4/4)');
await T.stepExercise(-1); await waitFor(() => sC().exercise?.index === 2);
check(sC().exercise?.index === 2 && sC().exercise?.name === 'Plancha', 'trainer previous -> client follows');

// the client cannot drive it
const trainerBefore = JSON.stringify(sT().exercise);
await C.stepExercise(1); await sleep(200);
check(out('client', 'call:exercise').length === 0, 'a client calling stepExercise sends NOTHING');
check(JSON.stringify(sT().exercise) === trainerBefore, "and the trainer's tile is untouched");

// the client switches routine mid-call -> the next tap restarts the new routine
await seedWorkout('main');
await T.stepExercise(1); await waitFor(() => sC().exercise?.block === 'main');
check(sC().exercise?.block === 'main' && sC().exercise?.index === 0 && sC().exercise?.total === 3 && sC().exercise?.name === 'Press de banca',
  'client switched to the gym routine -> restarts at its FIRST exercise (1/3)', `${sC().exercise?.block} ${sC().exercise?.index + 1}/${sC().exercise?.total}`);
await seedWorkout('alternative');

// mute / camera
C.toggleMute(); C.toggleCamera();
const cl = world.client.streams.find((s: any) => s.tracks && !s.released && s === sC().localStream);
check(sC().muted && sC().cameraOff && cl.getAudioTracks()[0].enabled === false && cl.getVideoTracks()[0].enabled === false, 'mute and camera-off disable the real tracks');
C.toggleMute(); C.toggleCamera();
check(!sC().muted && !sC().cameraOff && cl.getAudioTracks()[0].enabled === true, 'and toggle back');

// duration
await sleep(1300);
check(sT().durationSec >= 1 && sC().durationSec >= 1, 'the call duration counts up', `${sT().durationSec}s`);

// app backgrounding is explained to the other side
C.setAppActive(false); await waitFor(() => sT().status === 'weak', 2000, 'trainer sees weak');
check(sT().status === 'weak' && sT().notice?.text.includes('segundo plano'), 'client backgrounds the app -> trainer is told why the video froze');
C.setAppActive(true); await waitFor(() => sT().status === 'connected', 2000);
check(sT().status === 'connected', 'client returns -> back to connected');

// socket drop + reconnect -> the server replays the exercise
const replaysBefore = frames.client.in.filter((f) => f.t === 'call:exercise' && f.replay).length;
const tileAtDrop = JSON.stringify({ i: sT().exercise?.index, b: sT().exercise?.block, n: sT().exercise?.name });
sockets.client[sockets.client.length - 1].terminate();          // network loss, no close handshake
await waitFor(() => !sC().socketOpen, 2000, 'socket down');
check(!sC().socketOpen, "client's socket drops");
await waitFor(() => sC().socketOpen, 5000, 'socket back');
check(sC().socketOpen, 'client reconnects on its own');
await sleep(300);
const replays = frames.client.in.filter((f) => f.t === 'call:exercise' && f.replay);
const lastReplay = replays[replays.length - 1];
check(replays.length === replaysBefore + 1, 'the server replays the exercise exactly once on reconnect', `${replays.length - replaysBefore} replay(s)`);
check(JSON.stringify({ i: lastReplay.index, b: lastReplay.block, n: lastReplay.name }) === tileAtDrop, "...and it is the trainer's CURRENT tile, not a stale one", tileAtDrop);
check(sC().status === 'connected' && JSON.stringify({ i: sC().exercise?.index, b: sC().exercise?.block, n: sC().exercise?.name }) === tileAtDrop, 'the call and the tile survive the reconnect');

// ═══ ICE restart, glare-free ═══════════════════════════════════════════════
const tPc = world.trainer.pcs[0], cPc = world.client.pcs[0];
const restartsBefore = world.trainer.restartOffers;
cPc.setState('failed'); await sleep(250);
check(world.client.offersCreated === 0, 'CALLEE ice failed -> it does NOT restart (only the caller does)', `callee offers: ${world.client.offersCreated}`);
check(sC().status === 'reconnecting', 'callee shows "reconnecting" and waits');
cPc.iceConnectionState = 'connected'; cPc.connectionState = 'connected'; cPc.oniceconnectionstatechange();
await waitFor(() => sC().status === 'connected');

tPc.setState('failed');
await waitFor(() => world.trainer.restartOffers === restartsBefore + 1, 3000, 'restart offer');
check(world.trainer.restartOffers === restartsBefore + 1, 'CALLER ice failed -> exactly one ICE-restart offer');
check(world.client.offersCreated === 0, '...and the callee still never offers (glare-free)');
await waitFor(() => sT().status === 'connected' && T._internals().iceRestarts === 0, 3000, 'recovered');
check(sT().status === 'connected', 'the restart answer arrives and the call recovers');
check(T._internals().iceRestarts === 0, 'a good connection resets the restart budget');
check(world.client.earlyIceRejected === 0 && world.trainer.earlyIceRejected === 0, 'no early-ICE rejections through the restart either');

// 'disconnected' is waited out, not restarted at once
const r1 = world.trainer.restartOffers;
tPc.setState('disconnected'); await sleep(100);
check(world.trainer.restartOffers === r1, '"disconnected" does NOT restart immediately');
tPc.iceConnectionState = 'connected'; tPc.connectionState = 'connected'; tPc.oniceconnectionstatechange();
await sleep(450);
check(world.trainer.restartOffers === r1, '...and a self-healed blip never triggers a restart at all');
tPc.setState('disconnected'); await sleep(450);
check(world.trainer.restartOffers === r1 + 1, '"disconnected" that persists past the grace period DOES restart');
await waitFor(() => sT().status === 'connected', 3000);

// stall watchdog: ICE says connected but no bytes arrive
const r2 = world.trainer.restartOffers;
bytesMode = 'frozen';
await waitFor(() => world.trainer.restartOffers === r2 + 1, 3000, 'stall restart');
check(world.trainer.restartOffers === r2 + 1, 'frozen inbound bytes while "connected" -> the watchdog restarts ICE');
bytesMode = 'growing';
await waitFor(() => sT().status === 'connected', 3000);

// hang up
const trainerPcs = world.trainer.pcs.length;
const tStreams = world.trainer.streams.filter((s: any) => s === sT().localStream);
const cStreams = world.client.streams.filter((s: any) => s === sC().localStream);
const trainerLocal = sT().localStream, clientLocal = sC().localStream;
T.end();
await waitFor(() => !sT().active && !sC().active, 3000, 'both idle');
check(!sT().active && !sC().active && sT().status === 'idle' && sC().status === 'idle', 'trainer hangs up -> both sides return to idle');
check(trainerLocal.getTracks().every((t: any) => t.readyState === 'ended') && clientLocal.getTracks().every((t: any) => t.readyState === 'ended'), 'every camera/mic track is STOPPED on both sides');
check(trainerLocal.released && clientLocal.released, 'native media is released (not just stopped)');
check(world.trainer.pcs.every((p: any) => p.closed) && world.client.pcs.every((p: any) => p.closed), 'every peer connection is closed');
check(sT().localStream === null && sT().remoteStream === null && sT().exercise === null && sC().exercise === null, 'no stream or exercise state is left behind');
check(out('trainer', 'call:end').length === 1, 'exactly ONE call:end was sent (no echo loop)', String(out('trainer', 'call:end').length));
check(out('client', 'call:end').length === 0, "the other side did not echo call:end back");
void trainerPcs; void tStreams; void cStreams;

// ═══ CALL 2 — decline ═════════════════════════════════════════════════════
await T.start(String(clientId), 'Jonathan Maymí');
await waitFor(() => sC().status === 'incoming');
C.decline();
await waitFor(() => !sT().active, 3000);
check(!sT().active && !sC().active, 'client declines -> trainer returns to idle');
check(sT().notice?.text === 'Llamada rechazada', 'and the trainer is told it was declined', sT().notice?.text);
check(world.client.streams.filter((s: any) => s === sC().localStream).length === 0, 'declining never opened the client camera');

// ═══ CALL 3 — trainer cancels while it rings ══════════════════════════════
await T.start(String(clientId), 'Jonathan Maymí');
await waitFor(() => sC().status === 'incoming');
T.end();
await waitFor(() => !sC().active, 3000);
check(!sT().active && !sC().active, 'trainer cancels before answer -> the ringing client is dismissed');

// ═══ media failures ═══════════════════════════════════════════════════════
failGetUserMedia = 'NotAllowedError';
const callsBefore = await db.collection('callsessions').countDocuments({});
const ok = await T.start(String(clientId), 'Jonathan Maymí');
check(ok === false && !sT().active && sT().status === 'idle', 'camera permission denied -> start() fails cleanly');
check(sT().notice?.text.includes('cámara y micrófono'), 'with the Spanish permission message', sT().notice?.text.slice(0, 40));
check(await db.collection('callsessions').countDocuments({}) === callsBefore, 'and NO call was created on the server');
failGetUserMedia = null;

await T.start(String(clientId), 'Jonathan Maymí');
await waitFor(() => sC().status === 'incoming');
failGetUserMedia = 'NotAllowedError';
check(await C.accept() === false, 'client accepts but camera permission is denied -> accept() fails');
failGetUserMedia = null;
await waitFor(() => !sT().active, 3000);
check(!sC().active && !sT().active, 'the call is declined honestly rather than answered into silence');

// ═══ CALL 4 — nothing assigned today ══════════════════════════════════════
await db.collection('clientworkouts').deleteMany({ clientId });
await T.start(String(clientId), 'Jonathan Maymí');
await waitFor(() => sC().status === 'incoming');
await C.accept();
await waitFor(() => sC().exercise !== null, 4000, 'empty exercise');
check(sT().exercise?.total === 0 && sC().exercise?.total === 0 && sC().exercise?.index === -1, 'no workout today -> both tiles get the "nothing today" state');
await T.stepExercise(1); await sleep(150);
check(sC().exercise?.total === 0, 'stepping with nothing to step through stays on "nothing today"');

// ═══ max restarts -> give up cleanly ══════════════════════════════════════
recoverAfterRestart = false;
const restartsAtStart = world.trainer.restartOffers;
const tp = world.trainer.pcs[world.trainer.pcs.length - 1];
tp.setState('failed');
await waitFor(() => !sT().active, 6000, 'give up');
check(!sT().active && sT().notice?.text.includes('Se perdió la conexión'), 'after 3 failed restarts the caller gives up with a clear message', sT().notice?.text);
await waitFor(() => !sC().active, 3000);
check(!sC().active, 'and the other side is released too');
check(world.trainer.restartOffers - restartsAtStart === 3, 'it tried exactly the full budget of 3 restarts first, no more', `${world.trainer.restartOffers - restartsAtStart} restart offers`);
recoverAfterRestart = true;

// ═══ dispose ══════════════════════════════════════════════════════════════
C.dispose(); T.dispose();
await sleep(300);
check(!C.isConnected() && !T.isConnected(), 'dispose() closes both sockets');

for (const list of Object.values(sockets)) for (const s of list) try { s.terminate(); } catch { /* */ }
await db.collection('users').deleteOne({ _id: clientId });
await mongo.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
