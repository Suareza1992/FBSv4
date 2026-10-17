// Integration test for "a food remembers what its numbers are FOR" on the server:
// the community library's servingAmount/servingUnit, /api/food-search's per-100 g
// normalisation of library foods, and the personal-food -> community path.
//
// Needs an ISOLATED server and database. NEVER point it at production:
//
//   MONGO_URI=mongodb://localhost:27017/fbs_food ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> PORT=3030 NODE_ENV=development node server.js
//   MONGO_URI=mongodb://localhost:27017/fbs_food BASE=http://localhost:3030 node scripts/test-food-serving.mjs
//
// Creates its own user and foods in that database and removes them afterwards.
// See TECHNICAL.md § 43.

import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const BASE = process.env.BASE || 'http://localhost:3030';
const URI = process.env.MONGO_URI;
if (!URI || !/fbs_food|test/i.test(URI)) {
    console.error('Refusing to run: MONGO_URI must point at an isolated test database (name containing "test" or "fbs_food").');
    process.exit(2);
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(76), extra);
};
const near = (a, b, tol = 0.15) => Math.abs(a - b) <= tol;

const PW = 'Food!Test-2026';
const mongo = await MongoClient.connect(URI);
const db = mongo.db();
const tag = `food${Date.now()}`;
const email = `${tag}@example.test`.toLowerCase();
const uid = (await db.collection('users').insertOne({
    name: 'Food', lastName: 'Tester', email, password: await bcrypt.hash(PW, 8), role: 'client',
    isFirstLogin: false, isActive: true, createdAt: new Date(),
})).insertedId;
const names = [`Zzm ${tag} beer`, `Zzm ${tag} eggs`, `Zzm ${tag} legacy`, `Zzm ${tag} bad`, `Zzm ${tag} personal`];

try {
    const lr = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const cookie = (lr.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('auth_token='));
    if (!cookie) throw new Error(`cannot sign in (${lr.status}) — login limiter is 10 / 15 min; restart the test server`);
    const call = (m, p, body) => fetch(`${BASE}${p}`, { method: m, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const lib = (name, extra = {}) => call('POST', '/api/food-library', { name, calories: 99, protein: 1, carbs: 6, fat: 0, ...extra });
    const row = (name) => db.collection('foodlibraries').findOne({ name });
    const search = async (name) => (await (await call('GET', `/api/food-search?q=${encodeURIComponent(name)}`)).json()).find((r) => r.name === name);

    // ── saving ──
    check((await lib(names[0], { servingAmount: 10, servingUnit: 'oz' })).status === 200, 'POST /api/food-library accepts a serving');
    let r = await row(names[0]);
    check(r?.servingAmount === 10 && r?.servingUnit === 'oz' && r.calories === 99, 'the serving is stored next to the macros', `${r?.servingAmount} ${r?.servingUnit}`);
    const g = await (await call('GET', `/api/food-library?q=${encodeURIComponent(names[0])}`)).json();
    check(g[0]?.servingAmount === 10 && g[0]?.servingUnit === 'oz', 'GET /api/food-library returns the serving');

    // ── the reported bug: a library food logged as 10 oz must come back per 100 g ──
    let s = await search(names[0]);
    check(s?.fromLibrary === true && near(s.cal100, 99 * 100 / 283.495, 0.6), 'search: a 10 oz library food is converted to a true per-100 g', `${s?.cal100} cal/100g`);
    check(near(s?.p100, 1 * 100 / 283.495) && near(s?.c100, 6 * 100 / 283.495), 'search: protein and carbs are converted the same way', `P ${s?.p100} C ${s?.c100}`);
    check(s?.baseAmount === 10 && s?.baseUnit === 'oz' && s?.calories === 99, 'search: the original amount and absolute numbers ride along');
    const per100 = s.cal100;
    check(Math.round(per100 * 283.495 / 100) === 99, 'search: scaling the per-100 g back up to 10 oz returns the 99 cal that were logged');

    // ── a non-mass base cannot be per-100 g ──
    await lib(names[1], { servingAmount: 5, servingUnit: 'huevos', calories: 350 });
    s = await search(names[1]);
    check(s?.baseAmount === 5 && s?.baseUnit === 'huevos' && s?.calories === 350, 'search: 5 huevos carries its own amount (not forced into grams)');

    // ── unknown (older app / old data) ──
    await lib(names[2]);
    r = await row(names[2]);
    check((r.servingAmount || 0) === 0 && (r.servingUnit || '') === '', 'a save with no serving stores "unknown"');
    s = await search(names[2]);
    check(s?.baseAmount === undefined && s?.cal100 === 99, 'search: unknown stays exactly as before (raw number, no base)');

    // ── overwrite: macros from an older app must not keep the previous writer's serving ──
    await lib(names[0], { servingAmount: 10, servingUnit: 'oz' });
    await lib(names[0], { calories: 120 });   // no serving
    r = await row(names[0]);
    check(r.calories === 120 && (r.servingAmount || 0) === 0 && (r.servingUnit || '') === '', 'new macros without a serving clear the old serving (no stale pairing)');

    // ── bad input ──
    for (const [label, extra] of [
        ['negative amount', { servingAmount: -5, servingUnit: 'g' }],
        ['zero amount', { servingAmount: 0, servingUnit: 'g' }],
        ['amount with no unit', { servingAmount: 10 }],
        ['unit with no amount', { servingUnit: 'oz' }],
        ['absurd amount', { servingAmount: 1e9, servingUnit: 'g' }],
        ['non-numeric amount', { servingAmount: 'abc', servingUnit: 'g' }],
        ['blank unit', { servingAmount: 10, servingUnit: '   ' }],
        ['object as unit', { servingAmount: 10, servingUnit: { $gt: '' } }],
    ]) {
        await lib(names[3], extra);
        r = await row(names[3]);
        check((r.servingAmount || 0) === 0 && (r.servingUnit || '') === '', `bad serving is stored as unknown: ${label}`);
    }
    await lib(names[3], { servingAmount: 10, servingUnit: 'x'.repeat(80) });
    r = await row(names[3]);
    check(r.servingUnit.length === 30, 'an over-long unit is cut to 30 characters');
    await lib(names[3], { servingAmount: 2.345, servingUnit: 'oz' });
    r = await row(names[3]);
    check(r.servingAmount === 2.35, 'the amount is rounded to 2 decimals', String(r.servingAmount));

    // ── personal food -> community keeps its serving ──
    const pf = await (await call('POST', '/api/personal-foods', { name: names[4], calories: 99, protein: 1, carbs: 6, fat: 0, servingSize: 10, servingUnit: 'oz' })).json();
    const sub = await call('POST', `/api/personal-foods/${pf._id}/submit-community`);
    r = await row(names[4]);
    check(sub.status === 200 && r?.servingAmount === 10 && r?.servingUnit === 'oz', 'submit-community carries the personal food\'s serving', sub.status);

    // ── logged foods keep their serving through the append route ──
    const day = '2099-01-01';
    const ap = await call('POST', '/api/nutrition-logs/food', { clientId: String(uid), date: day, mealName: 'Cena',
        foods: [{ name: 'Medalla Light', calories: 99, protein: 1, carbs: 6, fat: 0, servingAmount: 10, servingUnit: 'oz' }] });
    const log = await db.collection('nutritionlogs').findOne({ clientId: uid, date: day });
    const f = log?.meals?.[0]?.foods?.[0];
    check(ap.status === 200 && f?.servingAmount === 10 && f?.servingUnit === 'oz' && f?.name === 'Medalla Light', 'a logged food keeps servingAmount/servingUnit', ap.status);
} catch (e) {
    fail++;
    console.error('TEST CRASHED:', e);
} finally {
    await db.collection('users').deleteOne({ _id: uid });
    await db.collection('foodlibraries').deleteMany({ name: { $in: names } });
    await db.collection('personalfoodlibraries').deleteMany({ clientId: uid });
    await db.collection('nutritionlogs').deleteMany({ clientId: uid });
    await mongo.close();
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
