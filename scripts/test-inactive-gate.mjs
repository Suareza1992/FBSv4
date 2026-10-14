// Integration test for the DEACTIVATED-CLIENT gate (middleware/auth.js + /api/me).
//
// A deactivated client must still be able to sign in, read /api/me and read their own
// invoices — and nothing else. Reactivating must take effect immediately, not when the
// gate's few-second cache expires. Trainers and other clients must be untouched.
//
// Needs an ISOLATED server and database. NEVER point it at production:
//
//   MONGO_URI=mongodb://localhost:27017/fbs_inact ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> PORT=3028 node server.js
//   MONGO_URI=mongodb://localhost:27017/fbs_inact node scripts/test-inactive-gate.mjs
//
// It creates its own users and one invoice in that database and removes them afterwards.
// See TECHNICAL.md § 42.

import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const BASE = process.env.BASE || 'http://localhost:3028';
const URI = process.env.MONGO_URI;
if (!URI || !/fbs_inact|test/i.test(URI)) {
    console.error('Refusing to run: MONGO_URI must point at an isolated test database (name containing "test" or "fbs_inact").');
    process.exit(2);
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(72), extra);
};

const PW = 'Gate!Test-2026';
const mongo = await MongoClient.connect(URI);
const db = mongo.db();
const users = db.collection('users');
const tag = `gate${Date.now()}`;
const hash = await bcrypt.hash(PW, 8);
const mk = (role, extra = {}) => ({
    // Login lower-cases the address it is given, so the stored one must be lower-case too.
    name: role, lastName: tag, email: `${tag}.${role}${extra.n || ''}@example.test`.toLowerCase(), password: hash,
    role, isFirstLogin: false, createdAt: new Date(), ...extra,
});

const trainer = (await users.insertOne(mk('trainer', {
    paymentHandles: { athMovilBusiness: '', athMovil: '@testcoach', athMovilPhone: '', venmo: 'testcoach', paypal: '' },
}))).insertedId;
const clientA = (await users.insertOne(mk('client', { n: 'A', trainerId: trainer, isActive: true }))).insertedId;
const clientB = (await users.insertOne(mk('client', { n: 'B', trainerId: trainer, isActive: true }))).insertedId;
const legacy  = (await users.insertOne(mk('client', { n: 'L', trainerId: trainer }))).insertedId;   // no isActive field at all
const deadTrainer = (await users.insertOne(mk('trainer', { n: 'D', isActive: false }))).insertedId;
const pay = (await db.collection('payments').insertOne({
    clientId: clientA, trainerId: trainer, amount: 99, status: 'pending', dueDate: '2026-11-01',
    periodLabel: 'Test', stripePaymentLink: 'https://example.test/pay', type: 'manual', createdAt: new Date(),
})).insertedId;

const emailOf = async (id) => (await users.findOne({ _id: id })).email;
async function login(id) {
    const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: await emailOf(id), password: PW }),
    });
    const body = await r.json().catch(() => ({}));
    const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('auth_token='));
    return { status: r.status, cookie, body };
}
const call = (cookie, method, path, body) => fetch(`${BASE}${path}`, {
    method, headers: { 'Content-Type': 'application/json', Cookie: cookie || '' },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
});
const code = async (r) => (await r.clone().json().catch(() => ({}))).code;

try {
    const t = await login(trainer);
    const a = await login(clientA);
    const b = await login(clientB);
    const l = await login(legacy);
    const d = await login(deadTrainer);
    check([t, a, b, l, d].every((x) => x.status === 200 && x.cookie), 'setup: every test account can sign in',
        [t, a, b, l, d].map((x) => x.status).join(','));
    if (![t, a, b, l, d].every((x) => x.cookie)) throw new Error('cannot sign in — the login limiter allows 10 per 15 min; restart the test server');
    check(a.body?.user?.isActive === true, 'login response says isActive:true for an active client');

    const dayPath = `/api/client-workouts/${clientA}/2026-10-14`;
    const NOT_GATED = [['GET', dayPath], ['GET', '/api/library'], ['PUT', '/api/me', { nickname: 'x' }], ['POST', '/api/me/active', { date: '2026-10-14' }]];

    // ── active: nothing is blocked ──
    for (const [m, p, body] of NOT_GATED) {
        const r = await call(a.cookie, m, p, body);
        // Strict: it must get PAST auth. 401/403 would both mean it was stopped.
        check(r.status !== 401 && r.status !== 403, `active client: ${m} ${p} is not gated`, `HTTP ${r.status}`);
    }
    let me = await (await call(a.cookie, 'GET', '/api/me')).json();
    check(!me.accountInactive && !me.contact && !me.payHandles, 'active client: /api/me carries no inactive extras');

    // ── trainer deactivates client A ──
    const off = await call(t.cookie, 'PUT', `/api/clients/${clientA}`, { isActive: false });
    check(off.status === 200, 'trainer deactivates the client', `HTTP ${off.status}`);

    // Immediately — the call above warmed the cache while active, so this also proves
    // the cache is cleared on the flip.
    for (const [m, p, body] of NOT_GATED) {
        const r = await call(a.cookie, m, p, body);
        check(r.status === 403 && (await code(r)) === 'ACCOUNT_INACTIVE', `inactive client: ${m} ${p} -> 403 ACCOUNT_INACTIVE`, `HTTP ${r.status}`);
    }
    const more = [['GET', '/api/clients'], ['GET', '/api/payments'], ['POST', '/api/log', {}], ['GET', '/api/trainers'], ['POST', '/api/auth/update-password', {}]];
    for (const [m, p, body] of more) {
        const r = await call(a.cookie, m, p, body);
        check(r.status === 403 || r.status === 401, `inactive client: ${m} ${p} stays closed`, `HTTP ${r.status}`);
    }

    // ── what they CAN do ──
    const re = await login(clientA);
    check(re.status === 200 && re.body?.user?.isActive === false, 'inactive client can still sign in (isActive:false in response)');
    const meR = await call(a.cookie, 'GET', '/api/me');
    me = await meR.json();
    check(meR.status === 200 && me.accountInactive === true, '/api/me works and says accountInactive:true');
    check(typeof me.contact?.whatsapp === 'string' && /^\d{10,15}$/.test(me.contact.whatsapp), '/api/me carries a digits-only WhatsApp number', me.contact?.whatsapp);
    check(/@/.test(me.contact?.email || ''), '/api/me carries a contact email', me.contact?.email);
    check(me.payHandles?.athMovil === '@testcoach' && me.payHandles?.venmo === 'testcoach', "/api/me carries the TRAINER's payment handles");
    check(!('password' in me) && !('resetPasswordToken' in me), '/api/me still leaks no secrets');
    const inv = await call(a.cookie, 'GET', '/api/payments/mine');
    const invBody = await inv.json();
    check(inv.status === 200 && invBody.length === 1 && invBody[0].stripePaymentLink === 'https://example.test/pay', 'inactive client can read their own invoices incl. pay link');
    const lo = await call(a.cookie, 'POST', '/api/auth/logout');
    check(lo.status === 200, 'inactive client can sign out');

    // ── path tricks must not widen the allow-list ──
    for (const p of ['/api/me/active', '/api/me/', '/api/payments/mine/x', '/api/me?x=1']) {
        const r = await call(a.cookie, p === '/api/me/' || p === '/api/me?x=1' ? 'GET' : 'POST', p, {});
        const okShape = p === '/api/me/' || p === '/api/me?x=1' ? r.status === 200 : r.status === 403 || r.status === 404;
        check(okShape, `allow-list is exact: ${p}`, `HTTP ${r.status}`);
    }

    // ── nobody else is affected ──
    check((await call(b.cookie, 'GET', '/api/library')).status === 200, 'another (active) client is unaffected');
    check((await call(l.cookie, 'GET', '/api/library')).status === 200, 'a legacy client with NO isActive field counts as active');
    check((await call(t.cookie, 'GET', '/api/clients')).status === 200, 'the trainer is unaffected');
    check((await call(d.cookie, 'GET', '/api/clients')).status === 200, 'a deactivated TRAINER is not gated (client-only, as designed)');
    check((await call(l.cookie, 'GET', '/api/me')).status === 200, 'legacy client /api/me works');

    // ── reactivate: effective immediately ──
    const on = await call(t.cookie, 'PUT', `/api/clients/${clientA}`, { isActive: true });
    check(on.status === 200, 'trainer reactivates the client');
    const back = await call(a.cookie, 'GET', '/api/library');
    check(back.status === 200, 'reactivated client regains access immediately (cache cleared)', `HTTP ${back.status}`);
    me = await (await call(a.cookie, 'GET', '/api/me')).json();
    check(!me.accountInactive, '/api/me no longer says inactive');

    // ── bad tokens still 401 ──
    check((await call('auth_token=garbage', 'GET', '/api/me')).status === 401, 'garbage token -> 401');
    check((await call('', 'GET', '/api/me')).status === 401, 'no token -> 401');
} catch (e) {
    fail++;
    console.error('TEST CRASHED:', e);
} finally {
    await users.deleteMany({ _id: { $in: [trainer, clientA, clientB, legacy, deadTrainer] } });
    await db.collection('payments').deleteOne({ _id: pay });
    await mongo.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
