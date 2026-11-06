// Tests public/meal-item.js — the parsing, the display amounts, and the macro
// scaling that rewrites a plate for one client. No server, no database:
//
//   node scripts/test-meal-items.mjs
//
// The parts that would actually hurt if they broke:
//   1. A fraction has to survive. Meal plans are written in cups and quarters,
//      and "0.75 taza de avena" is not what anybody types.
//   2. A role decides what scales. A vegetable that grows with a protein goal
//      is a bug a client would notice before a test did.
//   3. The clamp. A goal typed into the wrong box must not tell someone to eat
//      eleven eggs.

import { readFileSync } from 'node:fs';

// Both files are plain browser scripts, run the way a browser runs them.
const sandbox = {};
for (const f of ['../public/food-scale.js', '../public/food-state.js', '../public/meal-item.js'])
    new Function('self', readFileSync(new URL(f, import.meta.url), 'utf8'))(sandbox);
const M = sandbox.MealItem;

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(68), extra);
};
const close = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

// ── Parsing one typed line ─────────────────────────────────────────────────
const P = [
    ['3/4 taza de avena en seco', 0.75, 'taza', 'avena en seco'],
    ['1 1/2 taza arroz integral',  1.5, 'taza', 'arroz integral'],
    ['5 oz pechuga de pollo',        5, 'oz',   'pechuga de pollo'],
    ['150 g salmón',               150, 'g',    'salmón'],
    ['0,5 taza quinoa',            0.5, 'taza', 'quinoa'],
    // "huevos" is not a unit FoodScale knows, so it stays part of the food —
    // which is what the client reads anyway.
    ['3 huevos revueltos con espinaca', 3, '', 'huevos revueltos con espinaca'],
    // A scoop IS one, though. The manufacturer defined it and printed the
    // macros for it, so the food here is "whey" measured in scoops — not a
    // food called "scoop whey" with no unit at all.
    ['1 scoop whey',                 1, 'scoop', 'whey'],
    ['2 medidas de proteína',        2, 'medidas', 'proteína'],
    ['1/4 aguacate',              0.25, '',   'aguacate'],
    // The glyphs this file PRINTS have to parse back, or the editor turns an
    // amount it rendered itself into part of the food's name.
    ['4 ½ oz pechuga de pollo',    4.5, 'oz',   'pechuga de pollo'],
    ['¾ taza queso cottage',      0.75, 'taza', 'queso cottage'],
    ['1 ¼ cda linaza',            1.25, 'cda',  'linaza'],
    ['½ guineo',                   0.5, '',     'guineo'],
];
for (const [line, amount, unit, name] of P) {
    const r = M.parseLine(line);
    check(r && close(r.amount, amount) && r.unit === unit && r.name === name,
        `parse: ${line}`, JSON.stringify(r));
}
check(M.parseLine('Café negro')?.amount === 0, 'parse: a line with no number is all food');
check(M.parseLine('   ') === null, 'parse: an empty line is not an element');

// ── The amount a person reads ──────────────────────────────────────────────
const A = [
    [{ amount: 0.75, unit: 'taza' }, '¾ taza'],
    [{ amount: 1.5,  unit: 'taza' }, '1 ½ taza'],
    [{ amount: 2,    unit: 'oz' },   '2 oz'],
    [{ amount: 0.25, unit: '' },     '¼'],
    [{ amount: 3,    unit: '' },     '3'],
    [{ amount: 0,    unit: 'taza' }, ''],
    // A third of a cup is written as one, because ⅓ IS a third of a cup. But
    // 0.4 is not, and is written as 0.4 — the app no longer decides that what
    // somebody meant was the nearest measure it likes.
    [{ amount: 1 / 3, unit: 'taza' }, '⅓ taza'],
    [{ amount: 0.4,   unit: 'taza' }, '0.4 taza'],
    [{ amount: 1.7,   unit: 'taza' }, '1.7 taza'],
    // Grams, ounces and the rest of the scale units are written as decimals,
    // because that is how a scale reads them.
    [{ amount: 6.4,   unit: 'oz' },   '6.4 oz'],
    [{ amount: 153,   unit: 'g' },    '153 g'],
    [{ amount: 12.4,  unit: 'g' },    '12.4 g'],
];
for (const [it, want] of A) check(M.amountLabel(it) === want, `amount: ${JSON.stringify(it)}`, M.amountLabel(it));

check(M.itemText({ amount: 5, unit: 'oz', name: 'pollo' }) === '5 oz pollo', 'itemText joins amount and food');
check(M.plateText([{ amount: 5, unit: 'oz', name: 'pollo' }, { name: 'ensalada' }]) === '5 oz pollo · ensalada',
    'plateText rebuilds the plate sentence');

// ── Which role follows which target ────────────────────────────────────────
const week = { calories: 1700, protein: 125, carbs: 180, fat: 50 };
let f = M.factorsFor(week, { protein: 160, carbs: 180, fat: 50 });
check(close(f.protein, 1.28), 'a protein goal above the week scales protein', String(f.protein));
check(f.carb === 1 && f.fat === 1, 'and leaves carbs and fat alone');
check(f.veg === 1 && f.free === 1, 'vegetables and free foods never scale');
check(M.isAdjusted(f) === true, 'that counts as adjusted');

check(M.isAdjusted(M.factorsFor(week, { protein: 125, carbs: 180, fat: 50 })) === false,
    'a client on the week\'s own numbers is not adjusted');
check(M.isAdjusted(M.factorsFor(week, {})) === false, 'no goals means no adjustment, not a guess');
check(M.factorsFor(week, { protein: 160 }).protein === 1.28, 'a partial set of goals still scales what it has');
check(M.factorsFor({ protein: 0 }, { protein: 160 }).protein === 1, 'a week with no protein target cannot be scaled against');

// The clamp, from both ends.
check(M.factorsFor(week, { protein: 500 }).protein === 2, 'an absurd goal is clamped to double');
check(M.factorsFor(week, { protein: 10 }).protein === 0.5, 'and a tiny one to half');

// ── Scaling an element ─────────────────────────────────────────────────────
f = M.factorsFor(week, { protein: 160, carbs: 90, fat: 50 });
const chicken = { name: 'pechuga de pollo', amount: 5, unit: 'oz', role: 'protein' };
const rice    = { name: 'arroz integral',   amount: 1, unit: 'taza', role: 'carb' };
const greens  = { name: 'espinaca',         amount: 2, unit: 'tazas', role: 'veg' };
check(M.amountLabel(M.scaleItem(chicken, f)) === '6.4 oz', 'more protein means more chicken',
    M.amountLabel(M.scaleItem(chicken, f)));
check(M.amountLabel(M.scaleItem(rice, f)) === '½ taza', 'fewer carbs means less rice',
    M.amountLabel(M.scaleItem(rice, f)));
check(M.amountLabel(M.scaleItem(greens, f)) === '2 tazas', 'and exactly the same spinach',
    M.amountLabel(M.scaleItem(greens, f)));
check(M.scaleItem({ name: 'canela', amount: 0, role: 'free' }, f).amount === 0,
    'an element with no amount has nothing to scale');
check(M.roleOf('nonsense') === 'free', 'an unknown role is free, so it simply never scales');

// ── The round trip, over every element in the shipped template ────────────
// The editor writes each element as one line and reads it back on save. Any
// element that does not survive that is an amount silently moved into a name,
// which is exactly the bug the glyph cases above came from.
sandbox.window = sandbox;
new Function('window', readFileSync(new URL('../public/meal-plan-template.js', import.meta.url), 'utf8'))(sandbox);
const tpl = sandbox.MEAL_PLAN_TEMPLATE;
let items = 0, alts = 0, broken = [];
for (const w of tpl.weeks) for (const o of w.options) for (const m of o.meals) for (const it of m.items) {
    const all = [it, ...(it.alternatives || [])];
    items++; alts += (it.alternatives || []).length;
    for (const el of all) {
        const back = M.parseLine(M.itemText(el));
        if (!back || !close(back.amount, el.amount) || back.unit !== el.unit || back.name !== el.name)
            broken.push(`${M.itemText(el)} → ${JSON.stringify(back)}`);
    }
}
check(tpl.weeks.length === 8, 'the template still ships eight weeks', String(tpl.weeks.length));
check(items > 150, 'every plate is written as elements', `${items} elements`);
check(alts > 150, 'and most of them come with alternatives already written', `${alts} alternatives`);
check(broken.length === 0, 'every template element survives being written and read back',
    broken.slice(0, 3).join(' | '));

// ── Per-client amounts: the address, and showing one as typed ─────────────
// A trainer's amount for one client is filed under where the element sits plus
// what it is called. Case and stray spaces must not make two addresses out of
// one food, because a typed plan is exactly where those come from.
check(M.overrideKey(2, 'A', 'Cena', 'Salmón al horno')
    === M.overrideKey('2', 'a', ' cena ', 'SALMÓN AL HORNO'),
    'an element address ignores case and stray spaces');
check(M.overrideKey(2, 'A', 'Cena', 'Salmón') !== M.overrideKey(2, 'B', 'Cena', 'Salmón'),
    'the same food in the other prep is a different address');
check(M.overrideKey(2, 'A', 'Cena', 'Salmón') !== M.overrideKey(3, 'A', 'Cena', 'Salmón'),
    'and in another week, another address again');

const idx = M.overrideIndex([
    { week: 2, option: 'A', slot: 'Cena', name: 'Salmón', amount: 9 },
    { week: 2, option: 'A', slot: 'Cena', name: '',       amount: 4 },
    { week: 2, option: 'A', slot: 'Cena', name: 'Arroz',  amount: 0 },
]);
check(idx.size === 1 && idx.get(M.overrideKey(2, 'A', 'Cena', 'salmón')) === 9,
    'an entry with no name or no amount addresses nothing', `${idx.size}`);

// NOTHING is rounded. A client could not enter their macros because the platform
// kept rewriting them, so the app no longer decides that somebody's 5.3 is 5.25.
check(M.amountLabel({ amount: 5.3, unit: 'oz' }) === '5.3 oz',
    'a computed amount is shown as it came out', M.amountLabel({ amount: 5.3, unit: 'oz' }));
check(M.amountLabel({ amount: 199.5, unit: 'g' }) === '199.5 g',
    'and a half gram stays a half gram', M.amountLabel({ amount: 199.5, unit: 'g' }));
check(M.amountLabel({ amount: 1.5, unit: 'taza' }) === '1 ½ taza',
    'a fraction is a SPELLING of the same number, so cups may still use one',
    M.amountLabel({ amount: 1.5, unit: 'taza' }));
check(M.amountLabel({ amount: 0.74, unit: 'taza' }) === '0.74 taza',
    'but only when it is exact — 0.74 is not three quarters',
    M.amountLabel({ amount: 0.74, unit: 'taza' }));
check(M.roundAmount === undefined, 'roundAmount is gone, not merely unused');

// ── The cases the phone is held to as well ────────────────────────────
// lib/mealItem.ts in FitBySuarez-mobile reads THIS file too, so the amount a
// client reads on the phone is the amount they read on the laptop. A rule
// changed in one copy and not the other fails on one side or the other.
const C = JSON.parse(readFileSync(new URL('./meal-item-cases.json', import.meta.url), 'utf8'));
const report = (bad, label, n) => check(bad.length === 0, label, bad.length ? bad.slice(0, 3).join(' | ') : `${n} cases`);

report(C.parseLine.filter((c) => {
    const got = M.parseLine(c.in);
    return !got || got.name !== c.out.name || !close(got.amount, c.out.amount) || got.unit !== c.out.unit;
}).map((c) => `${c.in} → ${JSON.stringify(M.parseLine(c.in))}`),
'every shared parseLine case reads back the same on both platforms', C.parseLine.length);

report(C.toNumber.filter((c) => !close(M.toNumber(c.in), c.out)).map((c) => `${c.in}→${M.toNumber(c.in)}`),
    'every shared toNumber case', C.toNumber.length);

report(C.amountLabel.filter((c) => M.amountLabel(c.item) !== c.out)
    .map((c) => `${JSON.stringify(c.item)}→${M.amountLabel(c.item)}`),
'every shared amountLabel case', C.amountLabel.length);

report(C.amountLabelNeverRounds.filter((c) => M.amountLabel(c.item) !== c.out)
    .map((c) => `${JSON.stringify(c.item)}→${M.amountLabel(c.item)}`),
'every shared case proving nothing is rounded', C.amountLabelNeverRounds.length);

report(C.itemText.filter((c) => M.itemText(c.item) !== c.out)
    .map((c) => `${JSON.stringify(c.item)}→${M.itemText(c.item)}`),
'every shared itemText case — and none of them carries a state', C.itemText.length);

report(C.roleOf.filter((c) => M.roleOf(c.in) !== c.out).map((c) => `${c.in}→${M.roleOf(c.in)}`),
    'every shared roleOf case', C.roleOf.length);

report(C.factorsFor.filter((c) => {
    const got = M.factorsFor(c.week, c.goals);
    return Object.keys(c.out).some((k) => !close(got[k], c.out[k]));
}).map((c) => `${c.why}: ${JSON.stringify(M.factorsFor(c.week, c.goals))}`),
'every shared factorsFor case, clamp included', C.factorsFor.length);

report(C.isAdjusted.filter((c) => M.isAdjusted(c.factors) !== c.out).map((c) => JSON.stringify(c.factors)),
    'every shared isAdjusted case', C.isAdjusted.length);

report(C.scaleItem.filter((c) => !close(M.scaleItem(c.item, c.factors).amount || 0, c.outAmount))
    .map((c) => `${c.item.name}→${M.scaleItem(c.item, c.factors).amount}`),
'every shared scaleItem case — the protein grows, the broccoli does not', C.scaleItem.length);

report(C.overrideKey.filter((c) => M.overrideKey(...c.in) !== c.out).map((c) => M.overrideKey(...c.in)),
    'every shared overrideKey case', C.overrideKey.length);

report(C.overrideIndex.filter((c) => {
    const map = M.overrideIndex(c.list);
    return map.size !== c.size || c.lookup.some((l) => map.get(l.key) !== l.out);
}).map((c) => `size ${M.overrideIndex(c.list).size}`),
'every shared overrideIndex case', C.overrideIndex.length);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
