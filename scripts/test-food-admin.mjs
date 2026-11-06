// The shared food library: who may add, who may CHANGE, and who may remove.
//
// The library is the one piece of data every client reads and, until now, every
// client could overwrite — logging "Arroz blanco" with the wrong numbers silently
// changed what all the others saw, and nothing in the app could put it back. These
// checks are mostly about that: adding stays open, changing does not.
//
// Needs an ISOLATED server and database. NEVER point it at production:
//
//   MONGO_URI=mongodb://localhost:27018/fbs_foodadmin ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> PORT=3030 NODE_ENV=development node server.js
//   MONGO_URI=mongodb://localhost:27018/fbs_foodadmin BASE=http://localhost:3030 node scripts/test-food-admin.mjs
//
// See TECHNICAL.md § 55.

import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcryptjs';

const BASE = process.env.BASE || 'http://localhost:3030';
const URI = process.env.MONGO_URI;
if (!URI || !/fbs_foodadmin|test/i.test(URI)) {
    console.error('Refusing to run: MONGO_URI must point at an isolated test database.');
    process.exit(2);
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(74), extra);
};

const PW = 'FoodAdmin!2026';
const mongo = await MongoClient.connect(URI);
const db = mongo.db();
const tag = `fa${Date.now()}`;
const FOOD = `Zz ${tag} arroz`;
const mk = async (role, extra = {}) => {
    const email = `${tag}-${role}-${Math.random().toString(36).slice(2, 6)}@example.test`.toLowerCase();
    await db.collection('users').insertOne({
        name: role, lastName: 'T', email, password: await bcrypt.hash(PW, 8), role,
        isFirstLogin: false, isActive: true, isDeleted: false, createdAt: new Date(), ...extra,
    });
    const r = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PW }),
    });
    const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('auth_token='));
    if (!cookie) throw new Error(`cannot sign in as ${email} (${r.status}) — login limiter is 10 / 15 min; restart the server`);
    return (m, p, body) => fetch(`${BASE}${p}`, {
        method: m, headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
    });
};

try {
    const asAdmin   = await mk('trainer', { isSuperadmin: true });
    const asTrainer = await mk('trainer');
    const asClient  = await mk('client');
    const row = () => db.collection('foodlibraries').findOne({ name: FOOD });

    // ── Adding stays open ──────────────────────────────────────────────────
    let r = await asClient('POST', '/api/food-library', { name: FOOD, calories: 130, protein: 2.7, carbs: 28, fat: 0.3, servingAmount: 100, servingUnit: 'g' });
    let b = await r.json();
    check(r.ok && b.created === true, 'a client can ADD a food nobody has entered', JSON.stringify(b));
    check((await row())?.calories === 130, 'and the numbers are stored', `${(await row())?.calories}`);

    // ── Changing is not open ───────────────────────────────────────────────
    r = await asClient('POST', '/api/food-library', { name: FOOD, calories: 3000, protein: 0, carbs: 0, fat: 0 });
    b = await r.json();
    const after = await row();
    check(r.ok, 'a client re-logging an existing food still succeeds', String(r.status));
    check(b.changed === false, 'but the response says nothing was changed', JSON.stringify(b));
    check(after.calories === 130, 'THE NUMBERS ARE UNTOUCHED — 3000 kcal did not land', `${after.calories}`);
    check(after.timesUsed === 2, 'the use is still counted, so popularity stays honest', `timesUsed ${after.timesUsed}`);

    r = await asTrainer('POST', '/api/food-library', { name: FOOD, calories: 999 });
    await r.json();
    check((await row()).calories === 130, 'an ordinary trainer cannot change it either', `${(await row()).calories}`);

    // ── The superadmin can ─────────────────────────────────────────────────
    r = await asAdmin('POST', '/api/food-library', { name: FOOD, calories: 135, protein: 2.7, carbs: 28, fat: 0.3, servingAmount: 100, servingUnit: 'g' });
    b = await r.json();
    check(b.changed === true && (await row()).calories === 135, 'the superadmin CAN change it', `${(await row()).calories}`);

    // ── The admin routes ───────────────────────────────────────────────────
    for (const [who, call] of [['a client', asClient], ['an ordinary trainer', asTrainer]]) {
        const g = await call('GET', '/api/admin/foods');
        check(g.status === 403, `${who} cannot list the shared library`, String(g.status));
    }
    const anon = await fetch(`${BASE}/api/admin/foods`);
    check(anon.status === 401, 'signed out cannot list it', String(anon.status));

    // The listing answers { foods, counts, truncated } — it covers two
    // collections now, so a bare array could not say how many of each.
    const page = await (await asAdmin('GET', `/api/admin/foods?q=${encodeURIComponent(tag)}`)).json();
    const list = page.foods;
    check(Array.isArray(list) && list.length === 1 && list[0].name === FOOD, 'the superadmin can search it', `${list.length} hit(s)`);
    check(list[0].kind === 'shared' && list[0].owner === null, 'a shared food says which collection it is from', list[0].kind);
    check(!!list[0].createdAt && !!list[0].updatedAt, 'and carries both dates, so you can tell where you left off');
    check(typeof page.counts?.shared === 'number' && typeof page.counts?.personal === 'number',
        'the counts cover both collections', JSON.stringify(page.counts));
    const id = list[0]._id;

    // A search term full of regex metacharacters must be text, not a pattern.
    const weird = await asAdmin('GET', `/api/admin/foods?q=${encodeURIComponent('100% (vainilla) +*')}`);
    check(weird.ok, 'a search with regex characters does not blow up', String(weird.status));

    r = await asClient('PUT', `/api/admin/foods/${id}`, { calories: 1 });
    check(r.status === 403, 'a client cannot edit through the admin route', String(r.status));
    r = await asClient('DELETE', `/api/admin/foods/${id}`);
    check(r.status === 403, 'a client cannot delete through the admin route', String(r.status));
    check((await row()).calories === 135, 'and nothing moved', `${(await row()).calories}`);

    r = await asAdmin('PUT', `/api/admin/foods/${id}`, { calories: 128, protein: 2.4, servingAmount: 100, servingUnit: 'g' });
    const edited = await r.json();
    check(r.ok && edited.calories === 128 && edited.protein === 2.4, 'the superadmin can correct the macros', `${edited.calories} kcal`);

    r = await asAdmin('PUT', `/api/admin/foods/${id}`, { calories: -50 });
    check((await (await asAdmin('GET', `/api/admin/foods?q=${encodeURIComponent(tag)}`)).json()).foods[0].calories === 0, 'a negative is floored at zero, not stored');

    // Renaming onto a name that already exists must be refused, not a 500.
    await asAdmin('POST', '/api/food-library', { name: `Zz ${tag} otro`, calories: 50 });
    r = await asAdmin('PUT', `/api/admin/foods/${id}`, { name: `Zz ${tag} otro` });
    check(r.status === 409, 'renaming onto an existing food is refused with a clear 409', String(r.status));
    r = await asAdmin('PUT', `/api/admin/foods/${id}`, { name: '   ' });
    check(r.status === 400, 'a blank name is refused', String(r.status));

    // ── Seco o cocido ──────────────────────────────────────────────────────
    // The field is on the same data every client reads, so it follows the same
    // rule as the macros: anyone may ANSWER where nobody has, nobody may change
    // an answer that is already there.
    r = await asAdmin('PUT', `/api/admin/foods/${id}`, { state: 'cocido' });
    check((await r.json()).state === 'cocido', 'the superadmin can say how a food is weighed');

    r = await asAdmin('PUT', `/api/admin/foods/${id}`, { state: 'al dente' });
    check((await row()).state === '', 'a value nobody recognises is stored as unknown, not kept');

    await asAdmin('PUT', `/api/admin/foods/${id}`, { state: 'seco' });
    r = await asClient('POST', '/api/food-library', { name: FOOD, calories: 9999, state: 'cocido' });
    check(r.ok && (await row()).state === 'seco',
        "a client logging it cannot flip somebody else's answer", (await row()).state);
    check((await row()).calories === 0, 'and still cannot touch the macros');

    // …but a blank is a hole, and the client logging the food is the one person
    // who knows. Filling it is allowed; that is how the library stops being blank.
    await asAdmin('PUT', `/api/admin/foods/${id}`, { state: '' });
    r = await asClient('POST', '/api/food-library', { name: FOOD, calories: 1, state: 'cocido' });
    check((await r.json()).filledState === true, 'a client CAN answer a question nobody has answered');
    check((await row()).state === 'cocido', 'and the answer sticks', (await row()).state);
    check((await row()).calories === 0, 'while the macros stay exactly where they were');

    const newFood = `Zz ${tag} quinoa`;
    r = await asClient('POST', '/api/food-library', { name: newFood, calories: 120, state: 'cocido' });
    const fresh = await db.collection('foodlibraries').findOne({ name: newFood });
    check(fresh?.state === 'cocido', 'a food created by a client carries its state from the start');
    await db.collection('foodlibraries').deleteOne({ name: newFood });

    r = await asAdmin('DELETE', `/api/admin/foods/${id}`);
    check(r.ok, 'the superadmin can delete', String(r.status));
    check((await row()) === null, 'and it is really gone — a real delete, not an archive');
    r = await asAdmin('DELETE', `/api/admin/foods/${id}`);
    check(r.status === 404, 'deleting it twice says not found rather than erroring', String(r.status));

    // ── A client's PRIVATE shelf, seen and corrected by the superadmin ─────
    // A personal food is one client's. Ordinarily only they may touch it; the
    // superadmin needs the correction power because a client quietly eating
    // "Avena 1,200 kcal" every day cannot be expected to spot it.
    const PF = `Zz ${tag} personal`;
    let pr = await asClient('POST', '/api/personal-foods', { name: PF, calories: 1200, protein: 5, carbs: 200, fat: 3 });
    check(pr.ok, "a client saves a food on their own shelf", String(pr.status));
    const pfId = (await pr.json())._id;

    const all = await (await asAdmin('GET', `/api/admin/foods?scope=all&q=${encodeURIComponent(tag)}`)).json();
    const mine = all.foods.find((f) => f._id === pfId);
    check(!!mine, "the superadmin's list includes a client's private food");
    check(mine?.kind === 'personal', 'marked as personal, not shared', mine?.kind);
    check(mine?.owner?.email?.includes(tag), 'and says whose it is', mine?.owner?.email || '(none)');
    check(mine?.servingAmount !== undefined, "the shelf's servingSize is flattened to servingAmount");

    const onlyShared = await (await asAdmin('GET', `/api/admin/foods?scope=shared&q=${encodeURIComponent(tag)}`)).json();
    check(!onlyShared.foods.some((f) => f.kind === 'personal'), 'scope=shared leaves the private ones out');
    const onlyPersonal = await (await asAdmin('GET', `/api/admin/foods?scope=personal&q=${encodeURIComponent(tag)}`)).json();
    check(onlyPersonal.foods.every((f) => f.kind === 'personal'), 'and scope=personal leaves the shared ones out');

    // Sorting is what "where did I leave off" rests on.
    const stale = await (await asAdmin('GET', '/api/admin/foods?sort=stale')).json();
    const ordered = stale.foods.every((f, i, a) => i === 0 || new Date(a[i - 1].updatedAt) <= new Date(f.updatedAt));
    check(ordered, 'sort=stale really is oldest-edited first');

    for (const [who, call] of [['a client', asClient], ['an ordinary trainer', asTrainer]]) {
        const g = await call('PUT', `/api/admin/personal-foods/${pfId}`, { calories: 1 });
        check(g.status === 403, `${who} cannot edit somebody's private food`, String(g.status));
    }

    r = await asAdmin('PUT', `/api/admin/personal-foods/${pfId}`, { name: `${PF} corregida`, calories: 120 });
    const fixed = await r.json();
    check(r.ok && fixed.calories === 120 && fixed.name === `${PF} corregida`,
        "the superadmin can correct a client's private food", `${fixed.calories} kcal`);

    // Correcting a private food must NOT publish it to everyone.
    const leaked = await db.collection('foodlibraries').findOne({ name: `${PF} corregida` });
    check(!leaked, 'and correcting it does not publish it to the shared library');

    r = await asAdmin('DELETE', `/api/admin/personal-foods/${pfId}`);
    check(r.ok, "the superadmin can remove it from that client's shelf", String(r.status));
    check(await db.collection('personalfoodlibraries').findOne({ _id: new ObjectId(String(pfId)) }) === null,
        'and it is really gone');

} finally {
    await db.collection('personalfoodlibraries').deleteMany({ name: new RegExp(`^Zz ${tag}`) });
    await db.collection('foodlibraries').deleteMany({ name: new RegExp(`^Zz ${tag}`) });
    await db.collection('users').deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongo.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
