// Integration test for Meal Prep: who may build a plan, who may be put on one,
// which week a client lands on, and that a client's swap is private to them.
//
// The parts that would actually hurt if they broke, in order:
//   1. A trainer must not be able to put ANOTHER trainer's client on a plan.
//   2. A client must not be able to touch the plan itself — only their own
//      option and their own swaps.
//   3. The week has to be counted from the start date, or a plan that is
//      supposed to advance by itself silently stops advancing.
//   4. A swap is stored against the assignment, so two clients on the same plan
//      never see each other's changes.
//   5. A swap names the ELEMENT it replaces, so two changes to one plate coexist
//      and neither overwrites the other.
//
// The scaling itself — which element moves with which goal — is pure and lives
// in scripts/test-meal-items.mjs.
//
// Needs an ISOLATED server and database. NEVER point it at production:
//
//   MONGO_URI=mongodb://localhost:27018/fbs_recipes ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> PORT=3030 NODE_ENV=development node server.js
//   MONGO_URI=mongodb://localhost:27018/fbs_recipes BASE=http://localhost:3030 node scripts/test-meal-plans.mjs
//
// Creates its own users and plans in that database and removes them afterwards.

import { MongoClient } from 'mongodb';
import bcrypt from 'bcryptjs';

const BASE = process.env.BASE || 'http://localhost:3030';
const URI = process.env.MONGO_URI;
if (!URI || !/fbs_recipes|test/i.test(URI)) {
    console.error('Refusing to run: MONGO_URI must point at an isolated test database (name containing "test" or "fbs_recipes").');
    process.exit(2);
}

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(76), extra);
};

const PW = 'MealPrep!Test-2026';
const mongo = await MongoClient.connect(URI);
const db = mongo.db();
const tag = `mpl${Date.now()}`;
const mk = async (role, extra = {}) => {
    const email = `${tag}-${role}-${Math.random().toString(36).slice(2, 6)}@example.test`.toLowerCase();
    const _id = (await db.collection('users').insertOne({
        name: role, lastName: 'Tester', email, password: await bcrypt.hash(PW, 8), role,
        isFirstLogin: false, isActive: true, isDeleted: false, createdAt: new Date(), ...extra,
    })).insertedId;
    return { _id, email };
};

// 'YYYY-MM-DD' n days before today, which is how the week count is exercised.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

// Two elements per plate, so a plate can be half-changed: a protein that moves
// with the client's goal and a vegetable that never does.
const plate = (slot, food, suffix) => ({
    slot,
    items: [
        { name: `${food} ${suffix}`, amount: 5, unit: 'oz', role: 'protein',
            alternatives: [{ name: `${food} alt`, amount: 4, unit: 'oz', role: 'protein' }] },
        { name: `Ensalada ${suffix}`, amount: 2, unit: 'tazas', role: 'veg', alternatives: [] },
    ],
});
const week = (n, kcal, meals) => ({
    week: n, objective: `Objetivo ${n}`, calories: kcal, protein: 125, carbs: 150, fat: 40, deficit: (n - 1) * 70,
    options: [
        { key: 'A', label: 'Prep A', meals: meals.map(([slot, food]) => plate(slot, food, 'A')) },
        { key: 'B', label: 'Prep B', meals: meals.map(([slot, food]) => plate(slot, food, 'B')) },
    ],
});
const SLOTS = [['Desayuno', 'Avena'], ['Almuerzo', 'Pollo'], ['Merienda', 'Yogur'], ['Cena', 'Salmón']];

try {
    const trainerA = await mk('trainer');
    const trainerB = await mk('trainer');
    // Goals above the week's, so the client's side has something to scale against.
    const clientA1 = await mk('client', { trainerId: trainerA._id,
        macroSettings: { targetCal: 2000, goalProtein: 160, goalCarbs: 150, goalFat: 40 } });
    const clientA2 = await mk('client', { trainerId: trainerA._id });
    const clientB  = await mk('client', { trainerId: trainerB._id });

    const signIn = async (who) => {
        const r = await fetch(`${BASE}/api/auth/login`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: who.email, password: PW }),
        });
        const cookie = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('auth_token='));
        if (!cookie) throw new Error(`cannot sign in as ${who.email} (${r.status}) — the login limiter is 10 / 15 min; restart the test server`);
        return (m, p, body) => fetch(`${BASE}${p}`, {
            method: m, headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: body ? JSON.stringify(body) : undefined,
        });
    };
    const [asA, asB, asC1, asC2, asCB] = await Promise.all(
        [trainerA, trainerB, clientA1, clientA2, clientB].map(signIn));

    // ── Building a plan ────────────────────────────────────────────────────
    const payload = {
        name: `${tag} Déficit progresivo`,
        description: 'Ocho semanas.',
        weeks: [1, 2, 3, 4].map((n) => week(n, 1700 - (n - 1) * 70, SLOTS)),
    };
    let r = await asA('POST', '/api/meal-plans', payload);
    const plan = await r.json();
    check(r.status === 201, 'a trainer can create a plan', String(r.status));
    check(plan.weeks?.length === 4, 'all four weeks are stored', `${plan.weeks?.length}`);
    check(plan.weeks?.[0]?.options?.length === 2, 'each week keeps both preps', `${plan.weeks?.[0]?.options?.length}`);
    check(plan.weeks?.[0]?.options?.[0]?.meals?.length === 4, 'each prep keeps its four plates',
        `${plan.weeks?.[0]?.options?.[0]?.meals?.length}`);

    const m0 = plan.weeks?.[0]?.options?.[0]?.meals?.[0];
    check(m0?.items?.length === 2, 'a plate is stored as its elements', `${m0?.items?.length}`);
    check(m0?.items?.[0]?.role === 'protein' && m0?.items?.[1]?.role === 'veg',
        'each element keeps the role that decides whether it scales');
    check(m0?.items?.[0]?.amount === 5 && m0?.items?.[0]?.unit === 'oz', 'amount and unit survive the round trip');
    check(m0?.items?.[0]?.alternatives?.length === 1, 'per-element alternatives survive the round trip');
    check(m0?.text === 'Avena A · Ensalada A' || /Avena A/.test(m0?.text || ''),
        'the plate sentence is rebuilt from the elements, not stored twice', m0?.text);

    // A role nobody recognises must not become a scaling rule by accident.
    r = await asA('PUT', `/api/meal-plans/${plan._id}`, {
        weeks: [{ ...payload.weeks[0], options: [{ key: 'A', label: 'Prep A', meals: [
            { slot: 'Desayuno', items: [{ name: 'Algo', amount: 1, unit: 'taza', role: 'esteroides' }] }] }] }],
    });
    check((await r.json())?.weeks?.[0]?.options?.[0]?.meals?.[0]?.items?.[0]?.role === 'free',
        'an unknown role is stored as free, so it simply never scales');
    await asA('PUT', `/api/meal-plans/${plan._id}`, payload);  // put the real plan back

    r = await asC1('POST', '/api/meal-plans', payload);
    check(r.status === 403, 'a client cannot create a plan', String(r.status));

    r = await asB('PUT', `/api/meal-plans/${plan._id}`, { name: 'secuestrado' });
    check(r.status === 403, "another trainer cannot edit someone else's plan", String(r.status));

    r = await asB('GET', '/api/meal-plans');
    const bPlans = await r.json();
    check(!bPlans.some((p) => String(p._id) === String(plan._id)),
        "another trainer's plan is not in the list");

    // A week with no options is not a week; it should be dropped, not stored empty.
    r = await asA('PUT', `/api/meal-plans/${plan._id}`, {
        weeks: [...payload.weeks, { week: 5, calories: 1400, options: [] }],
    });
    const trimmed = await r.json();
    check(trimmed.weeks?.length === 4, 'a week with no preps is dropped rather than stored', `${trimmed.weeks?.length}`);

    // ── Assigning ──────────────────────────────────────────────────────────
    r = await asA('PUT', `/api/meal-plans/${plan._id}/assignments`, {
        clientIds: [String(clientA1._id), String(clientA2._id), String(clientB._id)],
        startDate: daysAgo(15),
    });
    const assigned = await r.json();
    check(r.status === 200, 'the roster saves', String(r.status));
    check(assigned.assigned === 2, "another trainer's client is refused, silently and safely",
        `${assigned.assigned} assigned (expected 2)`);

    r = await asCB('GET', '/api/my-meal-plan');
    check((await r.json()) === null, "the other trainer's client is not on the plan");

    // ── Which week ─────────────────────────────────────────────────────────
    r = await asC1('GET', '/api/my-meal-plan');
    const mine = await r.json();
    check(mine?.currentWeek === 3, '15 days in is week 3', `week ${mine?.currentWeek}`);
    check(mine?.option === 'A', 'a new assignment starts on prep A', String(mine?.option));
    check(mine?.plan?.name === payload.name, 'the client reads the whole plan');
    // The client's own macro goals ride along, because the amounts on the plate
    // are rewritten against them.
    check(mine?.goals?.protein === 160 && mine?.goals?.carbs === 150,
        "the client's macro goals come with the plan", JSON.stringify(mine?.goals));

    // Past the end, a client holds on the last week rather than falling off it.
    await db.collection('mealplanassignments').updateOne(
        { clientId: clientA2._id }, { $set: { startDate: daysAgo(400) } });
    r = await asC2('GET', '/api/my-meal-plan');
    check((await r.json())?.currentWeek === 4, 'past the last week, the client stays on the last week');

    // Before the start date there is no week zero.
    await db.collection('mealplanassignments').updateOne(
        { clientId: clientA2._id }, { $set: { startDate: daysAgo(-10) } });
    r = await asC2('GET', '/api/my-meal-plan');
    check((await r.json())?.currentWeek === 1, 'before the start date the client sees week 1');

    // ── The client's own two knobs ─────────────────────────────────────────
    r = await asC1('PUT', '/api/my-meal-plan', { option: 'B' });
    check((await r.json())?.option === 'B', 'the client can switch prep');

    const swapIn = (body) => asC1('PUT', '/api/my-meal-plan', { swap: { week: 3, slot: 'Cena', ...body } });

    r = await swapIn({ from: 'Salmón A', text: 'Salmón alt', amount: 4, unit: 'oz', role: 'protein' });
    let state = await r.json();
    check(state.swaps?.length === 1, 'a swap is stored', `${state.swaps?.length}`);
    check(state.swaps?.[0]?.text === 'Salmón alt', 'the swap holds the chosen element');
    check(state.swaps?.[0]?.from === 'Salmón A', 'and names the element it replaces');
    check(state.swaps?.[0]?.amount === 4 && state.swaps?.[0]?.role === 'protein',
        "the replacement's own amount and role come with it, so it scales too");

    // The whole point of naming the element: two changes to one plate coexist.
    r = await swapIn({ from: 'Ensalada A', text: 'Brócoli', amount: 2, unit: 'tazas', role: 'veg' });
    state = await r.json();
    check(state.swaps?.length === 2, 'a second element in the same plate is a second swap, not a replacement',
        `${state.swaps?.length}`);

    // Same element twice must replace, not pile up — otherwise the list grows
    // forever and the last write stops being the one that shows.
    r = await swapIn({ from: 'Salmón A', text: 'Salmón B', amount: 5, unit: 'oz', role: 'protein' });
    state = await r.json();
    check(state.swaps?.length === 2, 'swapping the same element again replaces it', `${state.swaps?.length}`);
    check(state.swaps?.find((x) => x.from === 'Salmón A')?.text === 'Salmón B', 'the newest choice wins');

    r = await swapIn({ from: 'Salmón A', text: '' });
    state = await r.json();
    check(state.swaps?.length === 1, 'an empty text puts that one element back', `${state.swaps?.length}`);
    check(state.swaps?.[0]?.from === 'Ensalada A', 'and leaves the other change alone');
    await swapIn({ from: 'Ensalada A', text: '' });

    // A plan written before elements existed still swaps a whole plate: no
    // `from` at all, which is its own key.
    r = await swapIn({ text: 'Toda la cena distinta' });
    state = await r.json();
    check(state.swaps?.length === 1 && (state.swaps[0].from || '') === '',
        'a plate-level swap is still accepted, keyed by an empty from');
    await swapIn({ text: '' });

    await asC1('PUT', '/api/my-meal-plan', { swap: { week: 2, slot: 'Almuerzo', from: 'Pollo A', text: 'Pollo alt' } });
    r = await asC2('GET', '/api/my-meal-plan');
    const other = await r.json();
    check((other?.swaps || []).length === 0, "one client's swap is invisible to another on the same plan",
        `${(other?.swaps || []).length}`);

    r = await asC1('PUT', `/api/meal-plans/${plan._id}`, { name: 'secuestrado' });
    check(r.status === 403, 'a client cannot edit the plan itself', String(r.status));

    r = await asC1('GET', `/api/meal-plans/${plan._id}/assignments`);
    check(r.status === 403, 'a client cannot read the roster', String(r.status));

    // ── Counting ───────────────────────────────────────────────────────────
    r = await asA('GET', '/api/meal-plans');
    const list = await r.json();
    const row = list.find((p) => String(p._id) === String(plan._id));
    check(row?.assignedCount === 2, 'the card shows how many clients are on it', `${row?.assignedCount}`);

    // ── Retiring it ────────────────────────────────────────────────────────
    r = await asA('DELETE', `/api/meal-plans/${plan._id}`);
    check(r.status === 200, 'the owning trainer can retire a plan', String(r.status));
    r = await asC1('GET', '/api/my-meal-plan');
    check((await r.json()) === null, 'retiring it takes the clients off it too');

    // ── Signed out ─────────────────────────────────────────────────────────
    const anon = await fetch(`${BASE}/api/meal-plans`);
    check(anon.status === 401, 'plans are not readable signed out', String(anon.status));
    const anonMine = await fetch(`${BASE}/api/my-meal-plan`);
    check(anonMine.status === 401, 'a client plan is not readable signed out', String(anonMine.status));
} finally {
    const users = await db.collection('users').find({ email: new RegExp(`^${tag}-`) }).project({ _id: 1 }).toArray();
    const ids = users.map((u) => u._id);
    await db.collection('mealplans').deleteMany({ name: new RegExp(`^${tag}`) });
    await db.collection('mealplanassignments').deleteMany({ clientId: { $in: ids } });
    await db.collection('users').deleteMany({ email: new RegExp(`^${tag}-`) });
    await mongo.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
