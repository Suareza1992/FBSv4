// Tests public/food-scale.js against scripts/food-scale-cases.json (the phone's copy is
// tested against the same file). No server, no database:  node scripts/test-food-scale.mjs
import { readFileSync } from 'node:fs';

// public/food-scale.js is a plain browser script (this package is "type":"module", so it
// cannot be require()d). Run it the way a browser does and take what it puts on `self`.
const sandbox = {};
new Function('self', readFileSync(new URL('../public/food-scale.js', import.meta.url), 'utf8'))(sandbox);
const FoodScale = sandbox.FoodScale;
const cases = JSON.parse(readFileSync(new URL('./food-scale-cases.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(70), extra);
};
const close = (a, b, tol = 0.001) => Math.abs(a - b) <= tol;

for (const c of cases.factor) {
    const r = FoodScale.factor({ amount: c.base[0], unit: c.base[1] }, { amount: c.want[0], unit: c.want[1] });
    if (c.ok === false) check(r.ok === false, `factor: ${c.label}`, r.reason || '');
    else check(r.ok === true && close(r.factor, c.factor, 0.0005), `factor: ${c.label}`, r.ok ? r.factor.toFixed(4) : r.reason);
}
for (const c of cases.scale) {
    const r = FoodScale.scaleMacros(c.macros, c.factor);
    check(Object.keys(c.expect).every((k) => close(r[k], c.expect[k], 0.051)), `scale: ${c.label}`, JSON.stringify(r));
}
for (const c of cases.parseLeading) {
    const r = FoodScale.parseLeadingAmount(c.text);
    const ok = c.expect === null ? r === null : r && close(r.amount, c.expect.amount) && r.unit === c.expect.unit && r.name === c.expect.name;
    check(!!ok, `parseLeading: ${JSON.stringify(c.text)}`, JSON.stringify(r));
}
for (const c of cases.baseOf) {
    const r = FoodScale.baseOf(c.food);
    check(close(r.amount, c.expect.amount) && r.unit === c.expect.unit && r.known === c.expect.known, `baseOf: ${c.label}`, JSON.stringify(r));
}

// Properties that must hold for ANY amounts, not just the listed ones.
const base = { amount: 10, unit: 'oz' };
let monotone = true, roundTrip = true;
for (let a = 0.5; a <= 40; a += 0.5) {
    const up = FoodScale.factor(base, { amount: a, unit: 'oz' }).factor;
    const dn = FoodScale.factor({ amount: a, unit: 'oz' }, base).factor;
    if (!close(up * dn, 1, 1e-9)) roundTrip = false;
    if (a > 0.5 && up <= FoodScale.factor(base, { amount: a - 0.5, unit: 'oz' }).factor) monotone = false;
}
check(monotone, 'property: a larger amount always gives a larger factor');
check(roundTrip, 'property: scaling there and back is exactly 1');
// Scaling always starts from the base, so a long series of edits cannot drift.
let drift = 0;
const m0 = { calories: 99, protein: 1, carbs: 6, fat: 0 };
for (const a of [3, 17, 4.5, 10, 22, 10]) {
    const r = FoodScale.scaleMacros(m0, FoodScale.factor(base, { amount: a, unit: 'oz' }).factor);
    if (a === 10) drift = Math.max(drift, Math.abs(r.calories - 99), Math.abs(r.carbs - 6));
}
check(drift === 0, 'property: returning to the base amount returns the base numbers exactly', `drift ${drift}`);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
