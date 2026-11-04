// Tests public/food-state.js — dry versus cooked, and nothing else. No server:
//
//   node scripts/test-food-state.mjs
//
// The parts that would actually hurt if they broke:
//   1. '' and 'na' must stay different things. '' is nobody having answered;
//      'na' is somebody saying the question is meaningless for this food. Fold
//      them together and 172 unanswered foods silently become "doesn't matter".
//   2. fromName() must not guess. It only reports what a name already says, and
//      it is wired into the template, the ingredient picker and the backfill —
//      a loose match there writes a wrong state into real data.
//   3. matters() decides who gets asked. Too loose and the question becomes
//      noise people tap through; too tight and the rice goes out unlabelled.

import { readFileSync } from 'node:fs';

// The name-reading and who-gets-asked cases live in their own file because the
// phone has its own copy of this module (lib/foodState.ts in FitBySuarez-mobile)
// and reads the SAME cases — the arrangement food-scale.js already uses. Two
// copies of a rule that quietly disagree is the failure worth engineering out.
const CASES = JSON.parse(readFileSync(new URL('./food-state-cases.json', import.meta.url), 'utf8'));

const sandbox = {};
for (const f of ['../public/food-scale.js', '../public/food-state.js', '../public/meal-item.js'])
    new Function('self', readFileSync(new URL(f, import.meta.url), 'utf8'))(sandbox);
const F = sandbox.FoodState;

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(72), extra);
};

// ── The shared cases, the ones the phone runs too ─────────────────────────
let bad = CASES.stateOf.filter((c) => F.stateOf(c.in) !== c.out);
check(bad.length === 0, 'every value reads back as itself, or as unknown — never as a near miss',
    bad.map((c) => `${JSON.stringify(c.in)}→${F.stateOf(c.in)}`).join(' '));

bad = CASES.badge.filter((c) => F.badgeOf(c.state) !== c.badge);
check(bad.length === 0, 'only the two that change a number earn a chip', bad.map((c) => c.state).join(' '));

bad = CASES.fromName.filter((c) => F.fromName(c.name) !== c.out);
check(bad.length === 0, 'a name is read for what it says and nothing more',
    bad.map((c) => `"${c.name}"→${F.fromName(c.name)} (want ${c.out || 'nothing'})`).join(' | '));

// The bug this caught for real: 'res' matched inside "fresas", so strawberries
// were being asked whether they had been weighed raw or cooked.
bad = CASES.matters.filter((c) => F.matters(c.name) !== c.out);
check(bad.length === 0, 'the question is put only to foods that have an answer',
    bad.map((c) => `"${c.name}"→${F.matters(c.name)}`).join(' | '));

bad = CASES.shouldAsk.filter((c) => F.shouldAsk(c.name, c.state) !== c.out);
check(bad.length === 0, 'and only until somebody has answered it',
    bad.map((c) => `"${c.name}"/${c.state}`).join(' | '));

// ── The distinctions the cases cannot express ─────────────────────────────
check(F.isSet('na') === true && F.isSet('') === false,
    '"no aplica" is an answer; blank is not');
check(F.choices().length === 3 && F.choices().every((c) => c.key && c.label && c.help),
    'every option offered has a word and an explanation', `${F.choices().length}`);
check(F.fromName('arroz cocido en seco') === '',
    'a name that says both says nothing — that is a typo, not a food');

// ── Every element of the shipped template ─────────────────────────────────
// The template is the plan most clients will actually be handed, so a grain in
// it with no state is the bug reaching a real kitchen.
sandbox.window = sandbox;
new Function('window', readFileSync(new URL('../public/meal-plan-template.js', import.meta.url), 'utf8'))(sandbox);
const tpl = sandbox.MEAL_PLAN_TEMPLATE;
let total = 0, stated = 0;
const unstated = [];
for (const w of tpl.weeks) for (const o of w.options) for (const m of o.meals) for (const it of m.items) {
    for (const el of [it, ...(it.alternatives || [])]) {
        total += 1;
        if (F.isSet(el.state)) stated += 1;
        else if (F.matters(el.name)) unstated.push(el.name);
    }
}
check(unstated.length === 0,
    'no food in the template leaves the question open where it has an answer',
    unstated.slice(0, 4).join(' | '));
check(stated > 250, 'and most of the template says which', `${stated} of ${total}`);

// An annotation must never override a name. "1 taza quinoa cocida | 1 taza
// arroz integral" is one line: the rice inherits cooked, the quinoa keeps it.
const almuerzo = tpl.weeks[0].options[0].meals.find((m) => m.slot === 'Almuerzo');
const carb = (almuerzo?.items || []).find((i) => i.role === 'carb');
check(carb?.state === 'cocido', "a line's first element keeps what its own name said", carb?.state);
check((carb?.alternatives || []).every((a) => a.state === 'cocido'),
    'and its alternatives are weighed the same way unless they say otherwise');

// ── The state is not part of the name ─────────────────────────────────────
// itemText/parseLine is what the plan editor writes and reads back, and a state
// leaking into it would turn "arroz (cocido)" into the food's name on next save.
const M = sandbox.MealItem;
const el = { name: 'arroz integral', amount: 1, unit: 'taza', role: 'carb', state: 'cocido' };
check(M.itemText(el) === '1 taza arroz integral',
    'the editor line carries no state — it is a field, not a word in the name', M.itemText(el));
check(M.parseLine(M.itemText(el)).name === 'arroz integral',
    'so the round trip gives the name back unchanged');

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
