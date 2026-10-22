// Tests public/routine-twins.js — which days in a program are copies of the one that
// was just edited. No server, no database:  node scripts/test-routine-twins.mjs
//
// The listed cases live in scripts/routine-twins-cases.json and the phone's copy
// (FitBySuarez-mobile/lib/routineTwins.ts) is run against the SAME file, so the two
// cannot drift apart. The property checks at the bottom are per-implementation.
//
// The wrong answer here overwrites a trainer's work, so most of this is about what
// must NOT be offered.
import { readFileSync } from 'node:fs';

// public/routine-twins.js is a plain browser script (this package is "type":"module",
// so it cannot be require()d). Run it the way a browser does and take what it leaves.
const sandbox = {};
new Function('self', readFileSync(new URL('../public/routine-twins.js', import.meta.url), 'utf8'))(sandbox);
const RT = sandbox.RoutineTwins;
const cases = JSON.parse(readFileSync(new URL('./routine-twins-cases.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(74), extra);
};
const fixture = (key) => JSON.parse(JSON.stringify(cases.fixtures[key]));
const buildProgram = (weeks) => ({
    name: 'Power & Mobility',
    weeks: weeks.map((days, i) => ({
        weekNumber: i + 1,
        days: Object.fromEntries(Object.entries(days).map(([d, key]) => [d, fixture(key)])),
    })),
});

// ── What counts as "the same routine" ───────────────────────────────────────────
for (const c of cases.sameRoutine) {
    const same = RT.signature(fixture(c.a)) === RT.signature(fixture(c.b));
    check(same === c.same, `sameRoutine: ${c.label}`);
}

// ── What counts as a day worth copying ──────────────────────────────────────────
for (const c of cases.hasContent) {
    check(RT.dayHasContent(fixture(c.day)) === c.expect, `hasContent: ${c.label}`);
}

// ── The whole decision, on real programs ────────────────────────────────────────
for (const c of cases.plan) {
    const prog   = buildProgram(c.weeks);
    const before = fixture(c.before);
    const after  = fixture(c.after);
    if (prog.weeks[c.editWeek]) prog.weeks[c.editWeek].days[c.editDay] = after;   // the edit itself
    const { offer, twins } = RT.plan(prog, c.editWeek, c.editDay, before, after);
    const got = twins.map((t) => `${t.weekIdx}:${t.dayNum}`);
    check(offer === c.offer, `plan: ${c.label} → offer`, String(offer));
    check(JSON.stringify(got) === JSON.stringify(c.twins), `plan: ${c.label} → twins`, got.join(' ') || '(none)');
}

// ── Properties that must hold for any program ───────────────────────────────────
{
    // Applying the change to every twin leaves nothing to offer the second time.
    const prog = buildProgram(Array.from({ length: 6 }, () => ({ '1': 'push' })));
    const before = fixture('push');
    const after  = fixture('pushEdited');
    prog.weeks[0].days['1'] = after;
    const first = RT.plan(prog, 0, '1', before, after);
    first.twins.forEach((t) => { prog.weeks[t.weekIdx].days[t.dayNum] = JSON.parse(JSON.stringify(after)); });
    const second = RT.plan(prog, 0, '1', before, after);
    check(first.twins.length === 5 && second.twins.length === 0,
        'property: after applying to all, there is nothing left to offer', `${first.twins.length} then ${second.twins.length}`);
}
{
    // Every day it offers really was identical to the pre-edit day.
    const prog = buildProgram([{ '1': 'push' }, { '1': 'pushTailored' }, { '1': 'push' }, { '1': 'legs' }, { '1': 'push' }]);
    const before = fixture('push');
    const after  = fixture('pushEdited');
    prog.weeks[0].days['1'] = after;
    const { twins } = RT.plan(prog, 0, '1', before, after);
    const allMatched = twins.every((t) => RT.signature(prog.weeks[t.weekIdx].days[t.dayNum]) === RT.signature(before));
    check(allMatched && twins.length === 2, 'property: every offered day really was identical before the edit', `${twins.length} offered`);
    check(!twins.some((t) => t.weekIdx === 0), 'property: the edited day is never offered to itself');
}
{
    // One program can never reach into another.
    const a = buildProgram([{ '1': 'push' }, { '1': 'push' }]);
    const b = buildProgram([{ '1': 'push' }, { '1': 'push' }]);
    const before = fixture('push');
    const after  = fixture('pushEdited');
    a.weeks[0].days['1'] = after;
    check(RT.plan(a, 0, '1', before, after).twins.length === 1, 'property: only the program it was given is searched');
    check(JSON.stringify(b.weeks[1].days['1']) === JSON.stringify(fixture('push')), 'property: another program is untouched');
}
{
    // Days keyed by number rather than string (older documents) are still found.
    const prog = { weeks: [{ weekNumber: 1, days: { 1: fixture('push') } }, { weekNumber: 2, days: { 1: fixture('push') } }] };
    prog.weeks[0].days[1] = fixture('pushEdited');
    check(RT.plan(prog, 0, '1', fixture('push'), fixture('pushEdited')).twins.length === 1, 'property: numeric day keys are found too');
}
{
    // Nothing is read that was not handed in.
    check(RT.plan({}, 0, '1', fixture('push'), fixture('pushEdited')).twins.length === 0, 'property: a program with no weeks array offers nothing');
    check(RT.find(null, 0, '1', 'a', 'b').length === 0, 'property: a missing program offers nothing');
    check(RT.signature(null) === '' && RT.signature(undefined) === '', 'property: a missing day has no signature');
    check(RT.dayHasContent(null) === false, 'property: a missing day is blank');
}
{
    // Every twin is reported with the week number a human reads, not the index.
    const prog = buildProgram([{ '1': 'push' }, { '1': 'push' }, { '1': 'push' }]);
    prog.weeks[0].days['1'] = fixture('pushEdited');
    const { twins } = RT.plan(prog, 0, '1', fixture('push'), fixture('pushEdited'));
    check(twins.every((t) => t.weekNumber === t.weekIdx + 1), 'property: weeks are reported 1-based for the dialog');
    check(twins.every((t) => t.name === 'Core, Chest & Back'), 'property: each twin carries its routine name');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
