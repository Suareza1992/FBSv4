// Integration test for POST /api/food-lookup ("Calcular macros").
//
// Needs an ISOLATED server and database. NEVER point it at production. The server MUST be started with
// FOOD_NLP_ENABLED=false so the AI weight estimate is off — otherwise a counted amount with no known
// weight would make a real (paid) model call, and the test would not be deterministic:
//
//   MONGO_URI=mongodb://localhost:27017/fbs_food ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> PORT=3031 NODE_ENV=development FOOD_NLP_ENABLED=false \
//   FOOD_LOOKUP_RATE_PER_MIN=45 node server.js
//   MONGO_URI=mongodb://localhost:27017/fbs_food BASE=http://localhost:3031 node scripts/test-food-lookup.mjs
//
// Creates its own user and library foods and removes them afterwards. USDA / Open Food Facts are
// FOOD_LOOKUP_RATE_PER_MIN=45 lifts the default (20 / min) just enough for the ~40 requests before the burst test.
// USDA / Open Food Facts are reachable from the server when online, but every case here is decided by the local DB or the seeded
// library, and the "not found" name is gibberish, so the result does not depend on them.
// See TECHNICAL.md § 44.

import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const BASE = process.env.BASE || 'http://localhost:3031';
const URI = process.env.MONGO_URI;
if (!URI || !/fbs_food|test/i.test(URI)) {
    console.error('Refusing to run: MONGO_URI must point at an isolated test database (name containing "test" or "fbs_food").');
    process.exit(2);
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(78), extra);
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const PW = 'Look!Test-2026';
const mongo = await MongoClient.connect(URI);
const db = mongo.db();
const tag = `look${Date.now()}`;
const email = `${tag}@example.test`.toLowerCase();
const uid = (await db.collection('users').insertOne({
    name: 'Look', lastName: 'Tester', email, password: await bcrypt.hash(PW, 8), role: 'client',
    isFirstLogin: false, isActive: true, createdAt: new Date(),
})).insertedId;
const lib = (name, extra) => db.collection('foodlibraries').insertOne({
    name, nameNorm: name.toLowerCase(), calories: 99, protein: 1, carbs: 6, fat: 0, timesUsed: 3,
    createdAt: new Date(), updatedAt: new Date(), ...extra,
});
const mass = `Zzl ${tag} cerveza`, eggs = `Zzl ${tag} revueltos`, unknown = `Zzl ${tag} sinbase`;
await lib(mass, { servingAmount: 10, servingUnit: 'oz' });                                   // 99 cal FOR 10 oz
await lib(eggs, { servingAmount: 5, servingUnit: 'huevos', calories: 350, protein: 30, carbs: 2, fat: 25 });
await lib(unknown, { calories: 120 });                                                       // no recorded amount

try {
    const lr = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }) });
    const cookie = (lr.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('auth_token='));
    if (!cookie) throw new Error(`cannot sign in (${lr.status}) — login limiter is 10 / 15 min; restart the test server`);
    // Safety: refuse to run if the server's AI is on — a counted amount with no known weight would make a
    // real, paid model call (this is how a mistyped env var costs money). /api/me reports the flag.
    const me = await (await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
    if (me.foodNlpEnabled) throw new Error('the server has AI ON — restart it with FOOD_NLP_ENABLED=false (see the header)');
    const look = async (name, amount, unit, ck = cookie) => {
        const r = await fetch(`${BASE}/api/food-lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ name, amount, unit }) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    };

    // ── mass: exact arithmetic on a per-100 g food ──
    let r = await look('pechuga de pollo', 200, 'g');
    check(r.status === 200 && r.body.found && r.body.source === 'local', '200 g of a local food is found in the local DB', r.body.name);
    check(near(r.body.macros?.calories, 330) && near(r.body.macros?.protein, 62, 0.2), '  165 cal/100 g x 2 = 330 cal, 62 g protein', JSON.stringify(r.body.macros));
    check(r.body.approx === false, '  mass is exact, not "approximate"');
    r = await look('pechuga de pollo', 8, 'oz');
    check(near(r.body.macros?.calories, 165 * 8 * 28.3495 / 100, 1), '8 oz is converted through grams', String(r.body.macros?.calories));
    r = await look('PECHUGA de Pollo', 100, 'Gramos');
    check(r.body.found && near(r.body.macros?.calories, 165), 'name case and unit spelling do not matter', r.body.macros?.calories);

    // ── volume: approximate, and says so ──
    r = await look('leche', 240, 'ml');
    check(r.body.found && r.body.approx === true && /1 ml pesa 1 g/.test(r.body.note), 'millilitres are treated as grams and flagged approximate', r.body.name);

    // ── kitchen measures of a SOLID must not be treated as water ──
    r = await look('arroz blanco cocido', 1, 'taza');
    check(r.body.found === false && r.body.reason === 'cannot_convert', 'a cup of cooked rice is NOT weighed as 240 g of water (refused without the AI)', r.body.message);
    r = await look('pechuga de pollo', 1, 'cda');
    check(r.body.found === false && r.body.reason === 'cannot_convert', '  nor is a spoonful of anything');
    r = await look('leche', 8, 'fl oz');
    check(r.body.found && r.body.approx === true, 'fluid ounces ARE a liquid measure (water density, flagged)', r.body.note);

    // ── counted unit with a real unit weight in the database ──
    r = await look('huevo entero', 2, 'huevos');
    check(r.body.found && r.body.grams === 100 && near(r.body.macros?.calories, 155 * 100 / 100, 1), '2 huevos uses the 50 g-per-egg weight (100 g, 155 cal)', JSON.stringify([r.body.grams, r.body.macros?.calories]));
    check(r.body.approx === true && /por unidad/.test(r.body.note), '  and says it is an estimate');

    // ── counted unit nobody can weigh, AI off -> honest refusal, not a guess ──
    r = await look('pechuga de pollo', 1, 'pechuga');
    check(r.body.found === false && r.body.reason === 'cannot_convert' && /gramos u onzas/.test(r.body.message), 'an unweighable counted unit is refused with advice, never guessed', r.body.message);

    // ── library foods: scale from the amount they were logged with ──
    r = await look(mass, 5, 'oz');
    check(r.body.found && r.body.source === 'library' && near(r.body.macros?.calories, 50), 'library, mass base: 99 cal FOR 10 oz -> 5 oz is 50 cal', JSON.stringify(r.body.macros));
    r = await look(mass, 283.495, 'g');
    check(near(r.body.macros?.calories, 99), '  and 283.495 g is the original 10 oz', r.body.macros?.calories);
    r = await look(eggs, 10, 'huevos');
    check(r.body.found && near(r.body.macros?.calories, 700), 'library, counted base: 5 huevos = 350 cal -> 10 huevos = 700', JSON.stringify(r.body.macros));
    r = await look(eggs, 100, 'g');
    check(r.body.found === false && r.body.reason === 'cannot_convert', '  grams of a counted-base food cannot be converted', r.body.message);
    r = await look(unknown, 2, 'porción');
    check(r.body.found && near(r.body.macros?.calories, 240) && r.body.approx === true, 'library, no recorded amount: taken as 1 porción, flagged', JSON.stringify(r.body.macros));
    r = await look(unknown, 100, 'g');
    check(r.body.found === false, '  and not usable for grams');

    // ── matching must be strict ──
    r = await look(`Zzl ${tag} cerveza fuerte`, 5, 'oz');
    check(r.body.found !== true || r.body.name !== mass, 'a longer name does not match a shorter library food (every word must match)');
    r = await look(`zzqxv ${tag} gibberish`, 1, 'oz');
    check(r.body.found === false && r.body.reason === 'not_found', 'gibberish is "not found"', r.body.message);

    // ── shape ──
    r = await look('pechuga de pollo', 100, 'g');
    check(Array.isArray(r.body.alternatives) && r.body.alternatives.length <= 4, 'alternatives is a list of at most 4');
    check(typeof r.body.sourceLabel === 'string' && r.body.amount === 100 && r.body.unit === 'g', 'response echoes amount/unit and labels the source');
    check(r.body.macros && ['calories', 'protein', 'carbs', 'fat'].every(k => typeof r.body.macros[k] === 'number'), 'macros are numbers for all four values');

    // ── validation ──
    for (const [label, args] of [
        ['no name', ['', 1, 'g']], ['one-letter name', ['a', 1, 'g']], ['zero amount', ['arroz', 0, 'g']],
        ['negative amount', ['arroz', -1, 'g']], ['absurd amount', ['arroz', 1e9, 'g']], ['text amount', ['arroz', 'abc', 'g']],
        ['no unit', ['arroz', 1, '']], ['over-long unit', ['arroz', 1, 'x'.repeat(40)]], ['over-long name', ['x'.repeat(200), 1, 'g']],
    ]) {
        r = await look(...args);
        check(r.status === 400, `rejected: ${label}`, `HTTP ${r.status}`);
    }
    const raw = await fetch(`${BASE}/api/food-lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: { $gt: '' }, amount: 1, unit: 'g' }) });
    check(raw.status === 400, 'rejected: an object where the name should be');

    // ── auth ──
    r = await look('arroz', 1, 'g', '');
    check(r.status === 401, 'no login -> 401');

    // ── rate limit (last: it blocks this user for a minute) ──
    let limited = 0;
    for (let i = 0; i < 25; i++) { const x = await look('pechuga de pollo', 100, 'g'); if (x.status === 429) limited++; }
    check(limited > 0, 'a burst of lookups is rate-limited (429)', `${limited} of 25 refused`);
} catch (e) {
    fail++;
    console.error('TEST CRASHED:', e);
} finally {
    await db.collection('users').deleteOne({ _id: uid });
    await db.collection('foodlibraries').deleteMany({ name: { $in: [mass, eggs, unknown] } });
    await mongo.close();
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
