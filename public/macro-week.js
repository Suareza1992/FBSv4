// Weekly macro roll-up — "did I actually hit my 1,750 / 3,500 kcal for the week?"
//
// The daily rings answer "how am I doing today". They cannot answer the question the
// plan is actually written around: a −250 kcal/day deficit is a 1,750 kcal week, and
// −500 is 3,500 — one half-pound and one pound of fat. A client can land every single
// day "close enough" and still miss the week, or blow it on one Saturday and never see
// why the scale did not move.
//
// So this file rolls the nutrition logs up Monday → Sunday and compares the total
// against the SAME deficit/surplus the trainer picked in "Macros Recomendados".
// The weekly number is never typed in: it is the chosen daily delta × 7.
//
// Rules worth knowing:
//   • The week runs Monday → Sunday, the same week the Inicio stats already use.
//   • Only days up to and including today count. A client who pre-writes tomorrow's
//     lunch must not see it inflate this week's totals.
//   • A day with no calories on it is NOT counted as "ate nothing" — that would invent
//     a whole maintenance day of fake deficit. Such days simply do not contribute to
//     the balance, and the card says how many are missing so the number can be read
//     for what it is. (Their water still counts toward the water ring.)
//   • Mid-week the verdict is a PROJECTION from the days actually logged. Once the
//     week is complete it is the real total, and says so.
//   • Maintenance comes from the same formula as the calculator (LBM × 11 + 800), or
//     is backed out of a saved target when no measurement exists.
//
// This file is the web's copy. The phone has the same thing in
// FitBySuarez-mobile/lib/macroWeek.ts; both are tested against the same cases in
// scripts/macro-week-cases.json, so they cannot drift apart unnoticed.

// A plain browser script: it puts MacroWeek on `self`. (The Node test runs it the same
// way — this package is "type":"module", so it cannot be require()d.)
(function (root, factory) {
    root.MacroWeek = factory();
})(self, function () {
    'use strict';

    const KCAL_PER_LB = 3500;

    // The deficit/surplus pills in "Macros Recomendados", in kcal per DAY.
    const DAILY_DELTA = { maintain: 0, cut250: -250, cut500: -500, bulk250: +250, bulk500: +500 };

    // How far from maintenance a "Mantener" week may land before it counts as drifting.
    const MAINTAIN_TOLERANCE = 500;

    const num = (v) => {
        const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.'));
        return Number.isFinite(n) ? n : 0;
    };

    /** '2026-10-19' → a LOCAL Date (never UTC — a UTC parse lands on the wrong day west of Greenwich). */
    function parseDate(dateStr) {
        const [y, m, d] = String(dateStr || '').split('-').map(Number);
        return new Date(y, (m || 1) - 1, d || 1);
    }

    function fmtDate(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function shift(dateStr, days) {
        const d = parseDate(dateStr);
        d.setDate(d.getDate() + days);
        return fmtDate(d);
    }

    /** The Monday→Sunday week that contains `dateStr`. */
    function weekRange(dateStr) {
        const dow = parseDate(dateStr).getDay();          // 0 = Sunday
        const back = dow === 0 ? 6 : dow - 1;             // Monday is day 0 of the week
        const start = shift(dateStr, -back);
        const days = [];
        for (let i = 0; i < 7; i++) days.push(shift(start, i));
        return { start, end: days[6], days };
    }

    const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

    /** '13 – 19 oct', or '29 sep – 5 oct' when the week straddles two months. */
    function rangeLabel(start, end) {
        const a = parseDate(start), b = parseDate(end);
        const am = MONTHS[a.getMonth()], bm = MONTHS[b.getMonth()];
        return am === bm
            ? `${a.getDate()} – ${b.getDate()} ${bm}`
            : `${a.getDate()} ${am} – ${b.getDate()} ${bm}`;
    }

    /** 1234.6 → '1,235'. Deterministic on purpose: the tests compare strings. */
    function fmtKcal(n) {
        const r = Math.round(Math.abs(num(n)));
        return String(r).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** -1988 → '−1,988' (true minus sign, matching the goal pills). */
    function fmtSigned(n) {
        const r = Math.round(num(n));
        if (r === 0) return '0';
        return (r < 0 ? '−' : '+') + fmtKcal(r);
    }

    /** kcal → pounds of bodyweight, one decimal. */
    function pounds(kcal) {
        return Math.round((num(kcal) / KCAL_PER_LB) * 10) / 10;
    }

    /** Maintenance the same way the calculator does it: lean mass × 11 + 800. */
    function maintenanceFrom(weightLbs, bodyFat) {
        const w = num(weightLbs);
        const bf = num(bodyFat);
        if (!(w > 0) || !(bf > 0)) return null;
        const decimal = bf > 1 ? bf / 100 : bf;           // stored as 24 OR 0.24
        if (decimal >= 1) return null;
        return w * (1 - decimal) * 11 + 800;
    }

    /**
     * Roll the week up.
     *   logs        [{ date, calories, protein, carbs, fat, water }]
     *   today       'YYYY-MM-DD'
     *   dailyGoals  { calories, protein, carbs, fat, water } — per day, 0/absent = no goal
     *   maintenance kcal/day, or null when there is no measurement to compute it from
     *   goal        'cut250' | 'cut500' | 'maintain' | 'bulk250' | 'bulk500' | null
     */
    function summarise({ logs = [], today, dailyGoals = {}, maintenance = null, goal = null } = {}) {
        const { start, end, days } = weekRange(today);
        const elapsedDays = days.filter((d) => d <= today);
        const byDate = {};
        (Array.isArray(logs) ? logs : []).forEach((l) => { if (l && l.date) byDate[l.date] = l; });

        const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, water: 0 };
        // "Logged" means the day has calories on it. A day where only water was ticked
        // off is NOT a logged day: counting it would read as "ate nothing today" and
        // invent a whole maintenance day of deficit out of thin air.
        const logged = [];
        elapsedDays.forEach((d) => {
            const l = byDate[d];
            if (!l) return;
            const cal = num(l.calories);
            if (cal > 0) logged.push(d);
            totals.calories += cal;
            totals.protein  += num(l.protein);
            totals.carbs    += num(l.carbs);
            totals.fat      += num(l.fat);
            totals.water    += num(l.water);
        });
        Object.keys(totals).forEach((k) => { totals[k] = Math.round(totals[k]); });

        // Ring goals are for the WHOLE week — the question is whether the week lands,
        // not whether today does. The "X de 7 días" footnote keeps that readable.
        const goals = {};
        ['calories', 'protein', 'carbs', 'fat', 'water'].forEach((k) => {
            goals[k] = Math.round(num(dailyGoals[k]) * 7);
        });

        // Calories eaten on days with no log are unknown, not zero: those days are left
        // out of the balance entirely (which is the same as calling them maintenance).
        let balance = null;
        if (maintenance > 0 && goal && Object.prototype.hasOwnProperty.call(DAILY_DELTA, goal)) {
            // Round maintenance BEFORE using it, to the whole number the card prints.
            // Otherwise a client who ate their prescribed 2,348 kcal every single day is
            // told they missed the week by 3 kcal — the error is in the half-calorie the
            // formula carries, not in anything they did.
            const maint      = Math.round(maintenance);
            const dailyDelta = DAILY_DELTA[goal];
            const target     = dailyDelta * 7;
            let actual = 0;
            logged.forEach((d) => { actual += num(byDate[d].calories) - maint; });
            actual = Math.round(actual);
            const complete  = elapsedDays.length === 7;
            const projected = logged.length ? Math.round((actual / logged.length) * 7) : null;
            // A week with nothing logged has a total of 0, but "0 kcal" is not a result —
            // it is an absence. Never let a closed, empty week read as a flat surplus.
            const reference = logged.length === 0 ? null : (complete ? actual : projected);

            let status = 'unknown';
            if (reference !== null) {
                if (target === 0)      status = Math.abs(reference) <= MAINTAIN_TOLERANCE ? 'met' : 'drifting';
                else if (target < 0)   status = reference <= target ? 'met' : (reference < 0 ? 'short' : 'reverse');
                else                   status = reference >= target ? 'met' : (reference > 0 ? 'short' : 'reverse');
            }
            balance = {
                dailyDelta, target, actual, projected, reference, complete, status,
                maintenance: maint,
                gap: reference === null ? null : Math.round(Math.abs(target - reference)),
                pounds: reference === null ? null : pounds(reference),
                targetPounds: pounds(target)
            };
        }

        return {
            start, end, days,
            elapsed: elapsedDays.length,
            loggedDays: logged.length,
            missingDays: elapsedDays.length - logged.length,
            label: rangeLabel(start, end),
            totals, goals, balance
        };
    }

    /** One Spanish sentence for the balance band. Shared so web and phone read alike. */
    function verdict(summary) {
        const b = summary && summary.balance;
        if (!b) return 'Agrega una evaluación para comparar la semana con tu meta.';
        if (b.status === 'unknown') return 'Registra tus comidas para ver el balance de la semana.';

        const ref  = b.reference;
        const word = b.target < 0 ? 'déficit' : 'superávit';
        const lbs  = Math.abs(b.pounds).toFixed(1);

        if (b.target === 0) {
            return b.status === 'met'
                ? `Te mantuviste: ${fmtKcal(ref)} kcal de diferencia en la semana.`
                : `Vas ${fmtKcal(ref)} kcal ${ref > 0 ? 'por encima' : 'por debajo'} del mantenimiento.`;
        }

        if (b.complete) {
            if (b.status === 'met')     return `Semana cerrada con un ${word} de ${fmtKcal(ref)} kcal (≈${lbs} lbs). Meta cumplida.`;
            if (b.status === 'short')   return `Semana cerrada con un ${word} de ${fmtKcal(ref)} kcal. Te quedaste a ${fmtKcal(b.gap)} de la meta.`;
            return `Semana cerrada con un ${b.target < 0 ? 'superávit' : 'déficit'} de ${fmtKcal(ref)} kcal. La meta era un ${word} de ${fmtKcal(b.target)}.`;
        }

        if (b.status === 'met')   return `Al ritmo de esta semana llegas a ${fmtSigned(ref)} kcal. Meta: ${fmtSigned(b.target)}.`;
        if (b.status === 'short') return `Al ritmo de esta semana llegas a ${fmtSigned(ref)} kcal. Te faltan ${fmtKcal(b.gap)} para la meta.`;
        return `Vas en ${b.target < 0 ? 'superávit' : 'déficit'} de ${fmtKcal(ref)} kcal. La meta era un ${word} de ${fmtKcal(b.target)}.`;
    }

    return {
        DAILY_DELTA, KCAL_PER_LB, MAINTAIN_TOLERANCE,
        weekRange, rangeLabel, fmtKcal, fmtSigned, pounds, maintenanceFrom, summarise, verdict
    };
});
