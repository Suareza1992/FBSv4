// Seeds Angel's five published meals into the recipe book (TECHNICAL.md § 54).
//
// These come from his own posts, which give MEAL-level macros ("~560 Calories,
// ~40g Protein…"). The model computes a recipe's macros by summing its
// ingredients, so the per-ingredient numbers below are chosen to sum to exactly
// the published figure — the number his clients already saw. The script asserts
// that before writing anything; a recipe whose card disagreed with his post would
// be worse than not adding it at all.
//
// Idempotent: a recipe with the same name for the same trainer is UPDATED, not
// duplicated, so re-running after an edit is safe.
//
//   MONGO_URI=<db> TRAINER_EMAIL=you@example.com node scripts/seed-recipes.mjs
//   add --dry to print what it would do and write nothing.

import { MongoClient } from 'mongodb';

const URI   = process.env.MONGO_URI;
const EMAIL = (process.env.TRAINER_EMAIL || '').trim().toLowerCase();
const DRY   = process.argv.includes('--dry');
if (!URI)   { console.error('Set MONGO_URI.'); process.exit(2); }
if (!EMAIL) { console.error('Set TRAINER_EMAIL to the trainer who should own these recipes.'); process.exit(2); }

const g = (name, amount, unit, calories, protein, carbs, fat) =>
    ({ name, amount, unit, calories, protein, carbs, fat });

// Each entry carries `published` — the macros from the post — and the script
// refuses to write if the ingredients do not add up to it.
const RECIPES = [
    {
        name: 'Desayuno: yogur griego con granola y frutas',
        mealSlot: 'Desayuno',
        tags: ['Rápido', 'Alto en proteína'],
        servings: 1,
        published: { calories: 560, protein: 40, carbs: 80, fat: 10 },
        ingredients: [
            g('Yogur griego', 2, 'taza', 280, 34, 20, 1),
            g('Granola', 0.5, 'taza', 190, 4, 33, 8),
            g('Arándanos', 0.5, 'taza', 42, 1, 11, 0),
            g('Fresas', 1, 'taza', 48, 1, 16, 1),
        ],
    },
    {
        name: 'Almuerzo: pollo con arroz, batata y brócoli',
        mealSlot: 'Almuerzo',
        tags: ['Alto en proteína'],
        servings: 1,
        published: { calories: 900, protein: 60, carbs: 115, fat: 20 },
        ingredients: [
            g('Pollo', 8, 'oz', 370, 50, 0, 17),
            g('Arroz blanco (cocido)', 1.5, 'taza', 300, 6, 66, 1),
            g('Batata', 1, 'taza', 175, 2, 38, 1),
            g('Brócoli', 1, 'taza', 55, 2, 11, 1),
        ],
    },
    {
        name: 'Snack: 2 barras David',
        mealSlot: 'Merienda PM',
        tags: ['Rápido', 'Alto en proteína', 'Bajo en carbos'],
        servings: 1,
        published: { calories: 300, protein: 56, carbs: 4, fat: 6 },
        ingredients: [
            g('Barra de proteína David', 2, 'barra', 300, 56, 4, 6),
        ],
    },
    {
        name: 'Cena fuera: filete con brócoli y zanahorias',
        mealSlot: 'Cena',
        tags: ['Alto en proteína', 'Bajo en carbos'],
        servings: 1,
        published: { calories: 690, protein: 50, carbs: 20, fat: 45 },
        ingredients: [
            g('Filete (6 oz)', 6, 'oz', 450, 46, 0, 29),
            g('Brócoli al vapor', 1, 'taza', 55, 4, 11, 1),
            g('Zanahorias con aceite de oliva', 1, 'taza', 185, 0, 9, 15),
        ],
    },
    {
        name: 'Batido de la noche: whey, leche A2 y kéfir',
        mealSlot: 'Snack',
        tags: ['Rápido', 'Alto en proteína'],
        servings: 1,
        published: { calories: 400, protein: 40, carbs: 30, fat: 18 },
        ingredients: [
            g('Whey (1 scoop)', 1, 'scoop', 120, 25, 3, 1.5),
            g('Leche A2 entera', 1, 'taza', 150, 8, 12, 8),
            g('Kéfir', 1, 'taza', 130, 7, 15, 8.5),
        ],
    },
];

// The same arithmetic the server does (recipeServingOf + recipeTotals).
const totalsOf = (r) => {
    const per = Math.max(1, Number(r.servings) || 1);
    const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    r.ingredients.forEach((i) => {
        t.calories += Math.round(i.calories / per);
        t.protein  += Math.round((i.protein / per) * 10) / 10;
        t.carbs    += Math.round((i.carbs   / per) * 10) / 10;
        t.fat      += Math.round((i.fat     / per) * 10) / 10;
    });
    return { calories: t.calories, protein: Math.round(t.protein), carbs: Math.round(t.carbs), fat: Math.round(t.fat) };
};

let bad = 0;
for (const r of RECIPES) {
    const got = totalsOf(r);
    const ok = ['calories', 'protein', 'carbs', 'fat'].every((k) => got[k] === r.published[k]);
    console.log((ok ? 'OK  ' : 'MISMATCH').padEnd(9), r.name.padEnd(48),
        `${got.calories} kcal · P${got.protein} C${got.carbs} G${got.fat}`,
        ok ? '' : `← post says ${r.published.calories}/${r.published.protein}/${r.published.carbs}/${r.published.fat}`);
    if (!ok) bad++;
}
if (bad) { console.error(`\n${bad} recipe(s) do not match the published macros. Nothing written.`); process.exit(1); }

if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }

const mongo = await MongoClient.connect(URI);
try {
    const db = mongo.db();
    const trainer = await db.collection('users').findOne({ email: EMAIL });
    if (!trainer) throw new Error(`No user with email ${EMAIL} in this database.`);
    if (!['trainer', 'admin'].includes(trainer.role)) throw new Error(`${EMAIL} is not a trainer.`);

    let created = 0, updated = 0;
    for (const r of RECIPES) {
        const doc = {
            trainerId: trainer._id, name: r.name, image: '', imagePos: '50% 50%',
            tags: r.tags, mealSlot: r.mealSlot, servings: r.servings,
            ingredients: r.ingredients, isArchived: false, updatedAt: new Date(),
        };
        const res = await db.collection('recipes').updateOne(
            { trainerId: trainer._id, name: r.name },
            { $set: doc, $setOnInsert: { createdAt: new Date() } },
            { upsert: true },
        );
        if (res.upsertedCount) created++; else updated++;
    }
    console.log(`\n${created} created, ${updated} updated — owner: ${EMAIL}`);
} finally {
    await mongo.close();
}
