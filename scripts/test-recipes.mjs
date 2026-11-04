// Integration test for the trainer's recipe book: who may read whose recipes, who
// may write them, that the macros are summed per serving rather than trusted from
// the request, and that "add to diary" lands in the day through the normal
// atomic food-append path.
//
// Most of this is about the SCOPE rule — a client must see their own trainer's
// book and nobody else's — because that is the part that leaks if it is wrong.
//
// Needs an ISOLATED server and database. NEVER point it at production:
//
//   MONGO_URI=mongodb://localhost:27018/fbs_recipes ADMIN_SEED_PASSWORD='TestPass!2026' \
//   JWT_SECRET=<32+ chars> PORT=3030 NODE_ENV=development node server.js
//   MONGO_URI=mongodb://localhost:27018/fbs_recipes BASE=http://localhost:3030 node scripts/test-recipes.mjs
//
// Creates its own users and recipes in that database and removes them afterwards.
// See TECHNICAL.md § 54.

import { MongoClient, ObjectId } from 'mongodb';
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

const PW = 'Recipe!Test-2026';
const mongo = await MongoClient.connect(URI);
const db = mongo.db();
const tag = `rcp${Date.now()}`;
const mk = async (role, extra = {}) => {
    const email = `${tag}-${role}-${Math.random().toString(36).slice(2, 6)}@example.test`.toLowerCase();
    const _id = (await db.collection('users').insertOne({
        name: role, lastName: 'Tester', email, password: await bcrypt.hash(PW, 8), role,
        isFirstLogin: false, isActive: true, isDeleted: false, createdAt: new Date(), ...extra,
    })).insertedId;
    return { _id, email };
};
const made = [];

try {
    // Two trainers with a client each, so "my trainer's book only" can be proven.
    const trainerA = await mk('trainer');
    const trainerB = await mk('trainer');
    const clientA  = await mk('client', { trainerId: trainerA._id });
    const clientB  = await mk('client', { trainerId: trainerB._id });
    const orphan   = await mk('client');                       // no trainer assigned
    made.push(trainerA, trainerB, clientA, clientB, orphan);

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
    const [asA, asB, asCA, asCB, asOrphan] = await Promise.all(
        [trainerA, trainerB, clientA, clientB, orphan].map(signIn));

    // ── Writing ────────────────────────────────────────────────────────────
    const avena = {
        name: `${tag} Avena con proteína`,
        description: 'Dulce, rápida y con mucha proteína.',
        tags: ['Sin lactosa', 'Rápido'],
        mealSlot: 'Desayuno',
        servings: 2,
        ingredients: [
            { name: 'Avena',            amount: 80,  unit: 'g', calories: 300, protein: 10, carbs: 54, fat: 6, state: 'seco' },
            { name: 'Proteína en polvo', amount: 60, unit: 'g', calories: 220, protein: 48, carbs: 4,  fat: 2, state: 'na' },
        ],
    };
    let r = await asA('POST', '/api/recipes', avena);
    const recipe = await r.json();
    check(r.status === 201, 'a trainer can create a recipe', String(r.status));
    check(recipe.macros?.calories === 260, 'macros are summed and divided by servings', `${recipe.macros?.calories} kcal (expected 260)`);
    check(recipe.macros?.protein === 29, 'protein per serving', `${recipe.macros?.protein} g (expected 29)`);
    made.push({ recipeId: recipe._id });

    check(recipe.description === 'Dulce, rápida y con mucha proteína.', 'the short description is stored', JSON.stringify(recipe.description));

    // 80 g of oats is 300 kcal dry and about 100 g cooked, so the ingredient has
    // to say which — and "no aplica" has to survive as a real answer, not blank.
    check(recipe.ingredients?.[0]?.state === 'seco', 'an ingredient keeps how it is weighed', recipe.ingredients?.[0]?.state);
    check(recipe.ingredients?.[1]?.state === 'na', 'and "no aplica" is kept, not flattened to blank', recipe.ingredients?.[1]?.state);
    r = await asA('PUT', `/api/recipes/${recipe._id}`, { ingredients: [
        { ...avena.ingredients[0], state: 'tibio' }, avena.ingredients[1]] });
    check((await r.json()).ingredients?.[0]?.state === '', 'a value nobody recognises is stored as unknown');
    await asA('PUT', `/api/recipes/${recipe._id}`, { ingredients: avena.ingredients });

    r = await asA('PUT', `/api/recipes/${recipe._id}`, { description: '  Cambiada  ' });
    check((await r.json()).description === 'Cambiada', 'the description can be edited, and is trimmed');

    r = await asA('POST', '/api/recipes', { ...avena, name: `${tag} Larga`, description: 'x'.repeat(600) });
    const longOne = await r.json();
    check(longOne.description.length === 400, 'an over-long description is cut to 400 characters', `${longOne.description.length}`);
    made.push({ recipeId: longOne._id });

    // ── Portrait or landscape ──────────────────────────────────────────────
    // A phone shoots portrait; the frame has to follow the photo, and anything
    // unrecognised has to fall back to landscape rather than fail the save.
    check(recipe.imageAspect === 'landscape', 'a recipe defaults to a landscape frame', recipe.imageAspect);

    r = await asA('POST', '/api/recipes', { ...avena, name: `${tag} Vertical`, imageAspect: 'portrait' });
    const tall = await r.json();
    check(tall.imageAspect === 'portrait', 'a portrait frame is stored', tall.imageAspect);
    made.push({ recipeId: tall._id });

    r = await asA('PUT', `/api/recipes/${tall._id}`, { imageAspect: 'landscape' });
    check((await r.json()).imageAspect === 'landscape', 'the frame can be switched back');

    r = await asA('PUT', `/api/recipes/${tall._id}`, { imageAspect: 'diagonal' });
    check((await r.json()).imageAspect === 'landscape', 'an unknown frame falls back to landscape, it does not throw');

    r = await asA('PUT', `/api/recipes/${tall._id}`, { name: `${tag} Vertical` });
    check((await r.json()).imageAspect === 'landscape', 'an edit that omits the frame leaves it alone');

    // A recipe written before the field existed must still read as landscape.
    await db.collection('recipes').updateOne({ _id: new ObjectId(tall._id) }, { $unset: { imageAspect: '' } });
    r = await asA('GET', `/api/recipes`);
    const legacy = (await r.json()).find((x) => String(x._id) === String(tall._id));
    check((legacy.imageAspect ?? 'landscape') === 'landscape', 'a recipe saved before the field reads as landscape');

    r = await asCA('POST', '/api/recipes', avena);
    check(r.status === 403, 'a client cannot create a recipe', String(r.status));

    r = await asA('POST', '/api/recipes', { ...avena, name: '   ' });
    check(r.status === 400, 'a nameless recipe is refused', String(r.status));

    // Macros are never trusted from the body — they are summed from ingredients.
    r = await asA('POST', '/api/recipes', { ...avena, name: `${tag} Mentira`, macros: { calories: 5 } });
    const lied = await r.json();
    check(lied.macros?.calories === 260, 'macros sent in the body are ignored, not stored', `${lied.macros?.calories}`);
    made.push({ recipeId: lied._id });

    // Rubbish numbers cannot poison a client's day.
    r = await asA('POST', '/api/recipes', {
        name: `${tag} Basura`, servings: 1,
        ingredients: [{ name: 'X', amount: -5, unit: '', calories: -900, protein: 'abc', carbs: null, fat: 3 }],
    });
    const junk = await r.json();
    check(junk.macros?.calories === 0 && junk.macros?.protein === 0, 'negative and non-numeric macros are floored at zero', JSON.stringify(junk.macros));
    check(junk.ingredients?.[0]?.unit === 'g', 'a missing unit falls back to g');
    made.push({ recipeId: junk._id });

    // ── The promise on the card must equal what lands in the diary ─────────
    // Dividing by servings makes halves constantly, and the day's totals are
    // summed by MongoDB's $round — banker's rounding, so 194.5 becomes 194 while
    // a browser's Math.round makes it 195. Rounding calories PER INGREDIENT keeps
    // the two the same.
    r = await asA('POST', '/api/recipes', {
        name: `${tag} Media caloría`, servings: 2,
        ingredients: [{ name: 'Avena', amount: 100, unit: 'g', calories: 389, protein: 16.9, carbs: 66, fat: 6.9 }],
    });
    const halved = await r.json();
    check(halved.macros.calories === 195, 'a half-calorie serving rounds up once, on the card', `${halved.macros.calories}`);
    made.push({ recipeId: halved._id });

    const dayDate = new Date().toISOString().slice(0, 10);
    r = await asCA('POST', '/api/nutrition-logs/food', {
        clientId: String(clientA._id), date: dayDate, mealName: 'Snack',
        foods: halved.ingredients.map((i) => ({
            name: i.name,
            calories: Math.round(i.calories / halved.servings),       // what the UI sends
            protein: Math.round((i.protein / halved.servings) * 10) / 10,
            carbs: Math.round((i.carbs / halved.servings) * 10) / 10,
            fat: Math.round((i.fat / halved.servings) * 10) / 10,
        })),
    });
    const halfDay = await r.json();
    check(halfDay.calories === halved.macros.calories,
        'the diary records exactly what the card promised', `diary ${halfDay.calories} vs card ${halved.macros.calories}`);
    await db.collection('nutritionlogs').deleteMany({ clientId: clientA._id });

    // ── Reading: the scope rule ────────────────────────────────────────────
    const names = async (call) => ((await (await call('GET', '/api/recipes')).json()) || []).map((x) => x.name);
    check((await names(asA)).includes(avena.name), "the owning trainer sees their own recipe");
    check((await names(asCA)).includes(avena.name), "their client sees their trainer's recipe");
    check(!(await names(asB)).includes(avena.name), "another trainer does NOT see it");
    check(!(await names(asCB)).includes(avena.name), "another trainer's client does NOT see it");
    check((await names(asOrphan)).length === 0, 'a client with no trainer sees an empty book');

    // ── Editing and archiving ──────────────────────────────────────────────
    r = await asB('PUT', `/api/recipes/${recipe._id}`, { name: 'Secuestrada' });
    check(r.status === 403, "another trainer cannot edit someone else's recipe", String(r.status));

    r = await asA('PUT', `/api/recipes/${recipe._id}`, { servings: 1 });
    const edited = await r.json();
    check(r.ok && edited.macros.calories === 520, 'changing the servings re-divides the macros', `${edited.macros.calories} kcal`);

    r = await asB('DELETE', `/api/recipes/${recipe._id}`);
    check(r.status === 403, "another trainer cannot delete someone else's recipe", String(r.status));

    r = await asA('DELETE', `/api/recipes/${recipe._id}`);
    check(r.ok, 'the owner can delete their recipe', String(r.status));
    check(!(await names(asA)).includes(avena.name), 'a deleted recipe leaves the list');
    const stillThere = await db.collection('recipes').findOne({ _id: new ObjectId(recipe._id) });
    check(!!stillThere && stillThere.isArchived === true, 'delete ARCHIVES — the row is still in the database, not erased');

    // ── Add to diary: the existing atomic append path ──────────────────────
    const today = new Date().toISOString().slice(0, 10);
    r = await asCA('POST', '/api/nutrition-logs/food', {
        clientId: String(clientA._id), date: today, mealName: 'Desayuno',
        foods: lied.ingredients.map((i) => ({
            name: `${i.name} (${lied.name})`, calories: i.calories, protein: i.protein,
            carbs: i.carbs, fat: i.fat, servingAmount: i.amount, servingUnit: i.unit,
        })),
    });
    const day = await r.json();
    check(r.ok, 'a client can put a recipe into their own diary', String(r.status));
    check(day.calories === 520, "the day's totals are recomputed by the server", `${day.calories} kcal`);
    const slot = (day.meals || []).find((m) => m.name === 'Desayuno');
    check((slot?.foods || []).length === 2, 'both ingredients landed in the chosen meal', `${slot?.foods?.length}`);

    r = await asCB('POST', '/api/nutrition-logs/food', {
        clientId: String(clientA._id), date: today, mealName: 'Desayuno',
        foods: [{ name: 'intruso', calories: 999, protein: 0, carbs: 0, fat: 0 }],
    });
    check(r.status === 403, "a client cannot write into someone else's diary", String(r.status));

    // ── Signed out ─────────────────────────────────────────────────────────
    const anon = await fetch(`${BASE}/api/recipes`);
    check(anon.status === 401, 'the recipe book is not readable signed out', String(anon.status));
} finally {
    await db.collection('recipes').deleteMany({ name: new RegExp(`^${tag}`) });
    await db.collection('users').deleteMany({ email: new RegExp(`^${tag}-`) });
    const ids = made.filter((m) => m._id).map((m) => m._id);
    if (ids.length) await db.collection('nutritionlogs').deleteMany({ clientId: { $in: ids } });
    await mongo.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
