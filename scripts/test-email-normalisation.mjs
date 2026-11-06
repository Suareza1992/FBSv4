// Integration test: an email is stored the way every lookup reads it.
//
// The bug this pins: `/api/clients` stored `req.body.email` verbatim while login,
// forgot-password and update-password all look up `email.toLowerCase().trim()`. A client
// created as "Alex@Gmail.com" was therefore unreachable — login missed, and
// forgot-password missed too but answers "si existe una cuenta..." by design, so the
// account looked fine and simply never worked. There was no self-service way out.
//
// Needs an ISOLATED server and database. NEVER point it at production:
//
//   MONGO_URI=mongodb://localhost:27018/fbs_email ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> PORT=3031 node server.js
//   MONGO_URI=mongodb://localhost:27018/fbs_email node scripts/test-email-normalisation.mjs
//
// It creates its own users in that database and removes them afterwards.

import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const BASE = process.env.BASE || 'http://localhost:3031';
const URI = process.env.MONGO_URI;
if (!URI || !/fbs_email|test/i.test(URI)) {
    console.error('Refusing to run: MONGO_URI must point at an isolated test database (name containing "test" or "fbs_email").');
    process.exit(2);
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(74), extra);
};

const PW = 'Email!Test-2026';
const mongo = await MongoClient.connect(URI);
const users = mongo.db().collection('users');
const tag = `email${Date.now()}`;

const trainerEmail = `${tag}.trainer@example.test`;
await users.insertOne({
    name: 'Trainer', lastName: tag, email: trainerEmail, password: await bcrypt.hash(PW, 8),
    role: 'trainer', isFirstLogin: false, createdAt: new Date(),
});

const login = async (email, password = PW) => {
    const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};

const { cookie, status: loginStatus } = await login(trainerEmail);
if (loginStatus !== 200 || !cookie) {
    console.error(`Could not sign the test trainer in (HTTP ${loginStatus}). Is the server on ${BASE} using this database?`);
    await users.deleteMany({ lastName: tag });
    await mongo.close();
    process.exit(2);
}

const api = (path, init = {}) => fetch(`${BASE}${path}`, {
    ...init, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers || {}) },
});

// ── An address typed with capitals and padding is stored the one way ────────────
const TYPED = `  ${tag}.Alex@Example.TEST  `;
const WANT = `${tag}.alex@example.test`;

const created = await api('/api/clients', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alex', lastName: tag, email: TYPED, sendInvite: false }),
});
check(created.status === 201 || created.status === 200, 'a client can be created with a messy address', `HTTP ${created.status}`);

const stored = await users.findOne({ lastName: tag, name: 'Alex' });
check(stored?.email === WANT, 'it is STORED lowercased and trimmed', `${JSON.stringify(stored?.email)} want ${JSON.stringify(WANT)}`);

// The real symptom. Before the fix this was a 401 for every client made this way.
await users.updateOne({ _id: stored._id }, { $set: { password: await bcrypt.hash(PW, 8), isFirstLogin: false } });
check((await login(WANT)).status === 200, 'and that client CAN SIGN IN — the whole point', '');
check((await login(TYPED)).status === 200, 'signing in with the messy spelling works too (login normalises)', '');

// ── The duplicate guard reads the same spelling ─────────────────────────────────
const dupe = await api('/api/clients', {
    method: 'POST',
    body: JSON.stringify({ name: 'Alex Again', lastName: tag, email: `${tag}.ALEX@example.test`, sendInvite: false }),
});
check(dupe.status === 400, 'a second account differing only in case is REFUSED', `HTTP ${dupe.status}`);
check(await users.countDocuments({ lastName: tag, name: 'Alex Again' }) === 0, 'and no second account was written', '');

// ── Editing an email is the same hazard ─────────────────────────────────────────
const edited = await api(`/api/clients/${stored._id}`, {
    method: 'PUT',
    body: JSON.stringify({ email: `  ${tag}.Moved@Example.TEST ` }),
});
check(edited.status === 200, 'a client email can be edited', `HTTP ${edited.status}`);
const after = await users.findOne({ _id: stored._id });
check(after?.email === `${tag}.moved@example.test`, 'the EDITED address is normalised too', JSON.stringify(after?.email));
check((await login(`${tag}.moved@example.test`)).status === 200, 'and they can still sign in afterwards', '');

await users.deleteMany({ lastName: tag });
await mongo.close();
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
