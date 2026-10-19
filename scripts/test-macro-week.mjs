// Tests public/macro-week.js against scripts/macro-week-cases.json (the phone's copy is
// tested against the same file). No server, no database:  node scripts/test-macro-week.mjs
import { readFileSync } from 'node:fs';

// public/macro-week.js is a plain browser script (this package is "type":"module", so it
// cannot be require()d). Run it the way a browser does and take what it puts on `self`.
const sandbox = {};
new Function('self', readFileSync(new URL('../public/macro-week.js', import.meta.url), 'utf8'))(sandbox);
const MW = sandbox.MacroWeek;
const cases = JSON.parse(readFileSync(new URL('./macro-week-cases.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const check = (ok, label, extra = '') => {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL').padEnd(5), label.padEnd(72), extra);
};
const close = (a, b, tol = 0.001) => Math.abs(a - b) <= tol;
const expand = (t) => ({ date: t[0], calories: t[1] || 0, protein: t[2] || 0, carbs: t[3] || 0, fat: t[4] || 0, water: t[5] || 0 });

for (const c of cases.weekRange) {
    const r = MW.weekRange(c.today);
    check(r.start === c.start && r.end === c.end && r.days.length === 7, `weekRange: ${c.label}`, `${r.start} → ${r.end}`);
    check(MW.rangeLabel(r.start, r.end) === c.rangeLabel, `rangeLabel: ${c.label}`, MW.rangeLabel(r.start, r.end));
}

for (const c of cases.maintenanceFrom) {
    const r = MW.maintenanceFrom(c.weight, c.bodyFat);
    const ok = c.expect === null ? r === null : r !== null && close(r, c.expect, 0.01);
    check(ok, `maintenanceFrom: ${c.label}`, String(r));
}

for (const c of cases.summarise) {
    const s = MW.summarise({
        logs: (c.logs || []).map(expand),
        today: c.today,
        dailyGoals: c.dailyGoals || {},
        maintenance: c.maintenance,
        goal: c.goal
    });
    const e = c.expect || {};
    for (const k of ['elapsed', 'loggedDays', 'missingDays', 'label']) {
        if (e[k] === undefined) continue;
        check(s[k] === e[k], `${c.label} → ${k}`, `${s[k]}`);
    }
    for (const group of ['totals', 'goals']) {
        if (!e[group]) continue;
        const bad = Object.keys(e[group]).filter((k) => s[group][k] !== e[group][k]);
        check(bad.length === 0, `${c.label} → ${group}`, bad.length ? JSON.stringify(s[group]) : '');
    }
    if (e.balance === null) {
        check(s.balance === null, `${c.label} → no balance`, JSON.stringify(s.balance));
    } else if (e.balance) {
        const bad = Object.keys(e.balance).filter((k) => {
            const want = e.balance[k], got = s.balance ? s.balance[k] : undefined;
            if (want === null) return got !== null;
            return typeof want === 'number' ? !close(got, want, 0.001) : got !== want;
        });
        check(bad.length === 0, `${c.label} → balance`, bad.length ? `${bad.join(',')} in ${JSON.stringify(s.balance)}` : '');
    }
    const v = MW.verdict(s);
    check(v === c.verdict, `${c.label} → verdict`, v === c.verdict ? '' : v);
}

// ── Properties that must hold for ANY week, not just the listed ones ──────────────
{
    // Every day belongs to exactly one Monday→Sunday week, and the week is 7 days long.
    let contiguous = true, containsToday = true, mondayFirst = true;
    for (let i = 0; i < 400; i++) {
        const d = new Date(2026, 0, 1 + i);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const { start, days } = MW.weekRange(day);
        if (days.length !== 7) contiguous = false;
        if (!days.includes(day)) containsToday = false;
        const [y, m, dd] = start.split('-').map(Number);
        if (new Date(y, m - 1, dd).getDay() !== 1) mondayFirst = false;
    }
    check(contiguous, 'property: every week is exactly 7 days');
    check(containsToday, 'property: a date is always inside its own week');
    check(mondayFirst, 'property: every week starts on a Monday');
}
{
    // A week eaten exactly at "maintenance + delta" always lands exactly on the target —
    // this is the promise the card makes, for every objective and every maintenance.
    let exact = true;
    for (const [goal, delta] of Object.entries(MW.DAILY_DELTA)) {
        for (const maintenance of [1800, 2098, 2598, 3100]) {
            const logs = MW.weekRange('2026-10-18').days.map((d) => ({ date: d, calories: maintenance + delta }));
            const s = MW.summarise({ logs, today: '2026-10-18', maintenance, goal });
            if (s.balance.actual !== delta * 7 || s.balance.status !== 'met') exact = false;
        }
    }
    check(exact, 'property: eating the plan exactly hits the weekly target exactly');
}
{
    // The projection is what the week WOULD be at this pace: logging the same day N
    // times must give the same projection, whatever N is.
    const week = MW.weekRange('2026-10-18').days;
    const projections = new Set();
    for (let n = 1; n <= 7; n++) {
        const logs = week.slice(0, n).map((d) => ({ date: d, calories: 2300 }));
        const s = MW.summarise({ logs, today: week[n - 1], maintenance: 2598, goal: 'cut250' });
        projections.add(s.balance.projected);
    }
    check(projections.size === 1 && projections.has(-2086), 'property: the pace projection does not depend on how many days are in', [...projections].join(','));
}
{
    // Nothing from outside the week can ever move the week's numbers.
    const inside = MW.weekRange('2026-10-14').days.slice(0, 3).map((d) => ({ date: d, calories: 2348 }));
    const base = MW.summarise({ logs: inside, today: '2026-10-14', maintenance: 2598, goal: 'cut250' });
    const noise = [{ date: '2026-10-11', calories: 9000 }, { date: '2026-10-19', calories: 9000 }, { date: '2026-10-16', calories: 9000 }];
    const withNoise = MW.summarise({ logs: [...inside, ...noise], today: '2026-10-14', maintenance: 2598, goal: 'cut250' });
    check(JSON.stringify(base) === JSON.stringify(withNoise), 'property: days outside the elapsed week change nothing');
}
{
    // The headline must never contradict itself: "met" and a gap of 0 go together on a
    // closed week, and a closed week never reports a projection different from the total.
    let consistent = true;
    for (const cal of [1800, 2100, 2348, 2598, 2900, 3400]) {
        const logs = MW.weekRange('2026-10-18').days.map((d) => ({ date: d, calories: cal }));
        const s = MW.summarise({ logs, today: '2026-10-18', maintenance: 2598, goal: 'cut250' });
        if (s.balance.projected !== s.balance.actual) consistent = false;
        if (s.balance.status === 'met' && s.balance.actual > -1750) consistent = false;
        if (s.balance.status === 'short' && !(s.balance.actual > -1750 && s.balance.actual < 0)) consistent = false;
    }
    check(consistent, 'property: a closed week reports its real total, and the status matches it');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
