// Meal-plan ELEMENTS — one food at a time, and what the amount becomes for a
// client whose macros are not the plan's.
//
// A plate used to be one sentence. It is now a short list of foods, because the
// two things a client actually wants are per-food: "swap THIS one, not the whole
// dinner", and "that is written for 125 g of protein and I eat 160".
//
// Each element carries a ROLE — what it is in the plate — and the role decides
// which of the week's targets it scales against. A client who needs a third more
// protein gets a third more chicken and exactly the same broccoli, which is how
// a coach would rewrite it by hand.
//
// Nothing here invents a macro number. Scaling works off the week's targets and
// the client's own goals, both of which a human typed; what the client actually
// ate is still counted in the diary against the food database.
//
// A plain browser script, same shape as food-scale.js, so the Node tests can run
// it with `new Function('self', src)(sandbox)`. It needs FoodScale on the same
// object: load food-scale.js first.

(function (root, factory) {
    root.MealItem = factory(root.FoodScale);
})(self, function (FS) {
    'use strict';

    // What an element IS, and which weekly target it follows. Vegetables and
    // "free" items (coffee, spices, a squeeze of lemon) never scale: doubling
    // the spinach to hit a protein goal would be nonsense.
    const ROLES = {
        protein: { label: 'Proteína', target: 'protein', color: '#F87171' },
        carb:    { label: 'Carbo',    target: 'carbs',   color: '#FACC15' },
        fat:     { label: 'Grasa',    target: 'fat',     color: '#FB923C' },
        veg:     { label: 'Vegetal',  target: null,      color: '#4ADE80' },
        free:    { label: 'Libre',    target: null,      color: '#FFDB89' },
    };
    const ROLE_KEYS = Object.keys(ROLES);
    const roleOf = (r) => (ROLES[r] ? r : 'free');

    // The amounts this file WRITES have to be amounts it can read again: the
    // editor shows a trainer "4 ½ oz pollo" and parses whatever they leave
    // behind, so a glyph we print and cannot parse quietly turns the amount into
    // part of the food's name.
    const GLYPHS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
    const GLYPH_CLASS = '[¼½¾⅓⅔⅛]';
    const AMOUNT_RE = new RegExp(`^(\\d+\\s*${GLYPH_CLASS}|${GLYPH_CLASS}|\\d+\\s+\\d+/\\d+|\\d+/\\d+|\\d+(?:[.,]\\d+)?)\\s*(.*)$`);

    // "1 1/2", "1 ½", "¾", "0,75", "2" → a number. Fractions matter: nobody
    // writes "0.75 taza de avena" on a meal plan.
    const toNumber = (raw) => {
        const s = String(raw == null ? '' : raw).trim().replace(',', '.');
        let m = s.match(new RegExp(`^(\\d+)?\\s*(${GLYPH_CLASS})$`));
        if (m) return (m[1] ? Number(m[1]) : 0) + GLYPHS[m[2]];
        m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
        if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
        m = s.match(/^(\d+)\/(\d+)$/);
        if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : NaN;
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : NaN;
    };

    const unitKeyOf = (unit) => (String(unit || '').trim() ? (FS.parseUnit(unit) || {}).key || '' : '');

    /**
     * One typed line → one element. "3/4 taza de avena en seco" becomes
     * { amount: 0.75, unit: 'taza', name: 'avena en seco' }.
     *
     * A word is only taken as a unit when FoodScale recognises it, so "3 huevos
     * revueltos con espinaca" keeps "huevos revueltos con espinaca" as the name
     * and just counts 3 — which is what the client reads anyway. A line with no
     * leading number is all name, and an element with no amount simply never
     * scales.
     */
    function parseLine(line) {
        const raw = String(line == null ? '' : line).trim();
        if (!raw) return null;
        const lead = raw.match(AMOUNT_RE);
        const amount = lead ? toNumber(lead[1]) : NaN;
        if (!lead || !(amount > 0)) return { name: raw, amount: 0, unit: '' };

        const rest = lead[2].trim();
        const u = rest.match(/^(fl\s*oz|[a-zA-ZáéíóúñÁÉÍÓÚÑ]+)\.?\s*(.*)$/);
        if (u && FS.isRecognisedUnit(u[1]) && u[2].trim()) {
            return { amount, unit: u[1].toLowerCase().replace(/\s+/g, ' '), name: u[2].trim().replace(/^de\s+/i, '') };
        }
        return { amount, unit: '', name: rest || raw };
    }

    // An amount a person would actually measure.
    //
    //   • grams and millilitres → the nearest 5, once 1 g stops meaning anything
    //   • ounces, pounds, litres → the nearest quarter, the way a scale reads
    //   • cups, spoons and counted things → the ladder a cook actually uses,
    //     which has a third on it. Snapping ⅓ taza to ¼ taza would be the app
    //     quietly rewriting a measure the trainer chose.
    const SPOON = new Set(['cup', 'tbsp', 'tsp', 'serving', '']);
    const LADDER = [0, 0.125, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1];
    const snap = (frac) => LADDER.reduce((a, b) => (Math.abs(b - frac) < Math.abs(a - frac) ? b : a));

    const roundAmount = (n, unitKey) => {
        if (!(n > 0)) return 0;
        if (unitKey === 'g' || unitKey === 'ml') return n >= 20 ? Math.round(n / 5) * 5 : Math.round(n);
        if (!SPOON.has(unitKey) && !unitKey.startsWith('count:')) return Math.round(n * 4) / 4;
        const whole = Math.floor(n);
        const f = snap(n - whole);
        return f === 1 ? whole + 1 : whole + f;
    };

    // The reverse of GLYPHS, matched with a tolerance because a third is not a
    // number that comes back exactly.
    const numberLabel = (n, unitKey) => {
        if (unitKey === 'g' || unitKey === 'ml') return String(Math.round(n));
        const whole = Math.floor(n + 1e-9);
        const rest = n - whole;
        const glyph = Object.keys(GLYPHS).find((g) => Math.abs(GLYPHS[g] - rest) < 1e-6);
        if (!glyph) return String(Math.round(n * 100) / 100);
        return whole ? `${whole} ${glyph}` : glyph;
    };

    /**
     * The chip that sits beside the name: "¾ taza", "150 g", "3". '' when there
     * is no amount.
     *
     * `exact` skips the rounding, and is for an amount a trainer TYPED for one
     * client. Rounding exists to turn arithmetic into something measurable; an
     * amount somebody chose is already measurable, and quietly moving 5.3 oz to
     * 5 ¼ would be the app overruling the person who wrote the plan.
     */
    function amountLabel(item, exact) {
        const a = Number(item && item.amount) || 0;
        if (!(a > 0)) return '';
        const unit = String((item && item.unit) || '').trim();
        const key = unitKeyOf(unit);
        const label = numberLabel(exact ? a : roundAmount(a, key), key);
        return unit ? `${label} ${unit}` : label;
    }

    /** The element as one line of text again — what a swap stores and what the plate's prose is built from. */
    const itemText = (item) => [amountLabel(item), String((item && item.name) || '').trim()].filter(Boolean).join(' ');

    /** A plate's prose, rebuilt from its elements, for anything that still reads `text`. */
    const plateText = (items) => (Array.isArray(items) ? items : []).map(itemText).filter(Boolean).join(' · ');

    /**
     * How much of each role this client eats compared with the week as written.
     *
     * Clamped to half and double on purpose: a goal typed into the wrong box must
     * never tell somebody to eat eleven eggs. A missing goal, or a week with no
     * target for that macro, means 1 — no scaling rather than a guess.
     */
    function factorsFor(week, goals) {
        const one = (goal, target) => {
            const g = Number(goal) || 0;
            const t = Number(target) || 0;
            if (!(g > 0) || !(t > 0)) return 1;
            return Math.min(2, Math.max(0.5, Math.round((g / t) * 100) / 100));
        };
        return {
            protein: one(goals && goals.protein, week && week.protein),
            carb:    one(goals && goals.carbs,   week && week.carbs),
            fat:     one(goals && goals.fat,     week && week.fat),
            veg: 1,
            free: 1,
        };
    }

    /** Is anything actually being moved? Used to decide whether to say so in the UI. */
    const isAdjusted = (factors) => ROLE_KEYS.some((r) => (factors && factors[r]) !== undefined && factors[r] !== 1);

    /**
     * Where ONE element sits, as a string: week, prep, slot, food.
     *
     * This is the address a trainer's per-client amount is filed under, and the
     * name is part of it on purpose — the same address the client's swaps use.
     * Lower-cased and trimmed so "Pechuga de pollo " and "pechuga de pollo" are
     * the same food, which is the mistake a typed plan actually makes.
     */
    const overrideKey = (week, option, slot, name) =>
        [week, option, slot, name].map((x) => String(x == null ? '' : x).trim().toLowerCase()).join('|');

    /** A list of per-client amounts as a lookup. Anything unnamed addresses nothing. */
    const overrideIndex = (list) => {
        const map = new Map();
        (Array.isArray(list) ? list : []).forEach((a) => {
            const amount = Number(a && a.amount) || 0;
            if (a && a.name && amount > 0) map.set(overrideKey(a.week, a.option, a.slot, a.name), amount);
        });
        return map;
    };

    /** The element as this client should cook it. Rounding happens at display time, once. */
    function scaleItem(item, factors) {
        const f = (factors && factors[roleOf(item && item.role)]) || 1;
        const a = Number(item && item.amount) || 0;
        if (f === 1 || !(a > 0)) return item;
        return Object.assign({}, item, { amount: a * f });
    }

    return { ROLES, ROLE_KEYS, roleOf, toNumber, parseLine, amountLabel, itemText, plateText,
        factorsFor, isAdjusted, scaleItem, roundAmount, unitKeyOf, overrideKey, overrideIndex };
});
