// Food amount scaling — "macros are FOR an amount; change the amount and they scale".
//
// Every food the app remembers carries the amount its numbers describe ("99 cal for
// 10 oz"). Typing a different amount scales the numbers in proportion. Before this, a
// previously logged food was re-read as "per 100 g" no matter what it had been logged
// as, so re-picking "10 oz Medalla Light" showed 3.5 oz with the 10 oz numbers, and
// typing 10 oz scaled them up a second time.
//
// This file is the web's copy of the logic. The phone has the same thing in
// FitBySuarez-mobile/lib/foodScale.ts; both are tested against the same cases in
// scripts/food-scale-cases.json, so they cannot drift apart unnoticed.
//
// Rules worth knowing:
//   • Units convert only inside the same kind: mass (g oz lb kg), volume (ml fl oz cup
//     l tbsp tsp), or the SAME counted word (huevo = huevos). Anything else is
//     "not convertible" — the caller asks the person, it never guesses.
//   • "oz" is mass. Fluid ounces must be written "fl oz". (A beer in "10 oz" scales
//     against other "oz"/"g", not against ml.)
//   • Calories are scaled on their own and NEVER recomputed from protein/carbs/fat:
//     alcohol calories do not show up in those three.
//   • Always scale from the stored base, never from a previously scaled result, so
//     rounding cannot compound.

// A plain browser script: it puts FoodScale on `self`. (The Node test runs it the same way —
// this package is "type":"module", so it cannot be require()d.)
(function (root, factory) {
    root.FoodScale = factory();
})(self, function () {
    'use strict';

    const strip = (s) => String(s == null ? '' : s)
        .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\./g, '').replace(/\s+/g, ' ').trim();

    // canonical key -> grams (mass) or millilitres (volume)
    const MASS = { g: 1, oz: 28.3495, lb: 453.592, kg: 1000 };
    const VOLUME = { ml: 1, floz: 29.5735, cup: 236.588, l: 1000, tbsp: 14.7868, tsp: 4.92892 };

    const ALIASES = {
        g: ['g', 'gr', 'grs', 'gramo', 'gramos', 'gram', 'grams'],
        oz: ['oz', 'onza', 'onzas', 'ounce', 'ounces'],
        lb: ['lb', 'lbs', 'libra', 'libras', 'pound', 'pounds'],
        kg: ['kg', 'kgs', 'kilo', 'kilos', 'kilogramo', 'kilogramos'],
        ml: ['ml', 'mililitro', 'mililitros'],
        floz: ['fl oz', 'floz', 'onza liquida', 'onzas liquidas', 'onza fluida', 'onzas fluidas', 'fluid ounce', 'fluid ounces'],
        cup: ['cup', 'cups', 'taza', 'tazas'],
        l: ['l', 'lt', 'lts', 'litro', 'litros'],
        tbsp: ['tbsp', 'cda', 'cucharada', 'cucharadas'],
        tsp: ['tsp', 'cdta', 'cucharadita', 'cucharaditas'],
        // "one of the thing" — the generic unit foods get when nothing better is known.
        serving: ['porcion', 'porciones', 'serving', 'servings', 'racion', 'raciones', 'unidad', 'unidades', 'und', 'unit', 'units'],
    };
    const LOOKUP = {};
    for (const [key, list] of Object.entries(ALIASES)) for (const a of list) LOOKUP[strip(a)] = key;

    // "huevos" and "huevo" are the same counted unit.
    const singular = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

    /** { family, f, key } for a unit word, or null when empty. */
    function parseUnit(raw) {
        const s = strip(raw);
        if (!s) return null;
        const k = LOOKUP[s];
        if (k && MASS[k]) return { family: 'mass', f: MASS[k], key: k };
        if (k && VOLUME[k]) return { family: 'volume', f: VOLUME[k], key: k };
        if (k === 'serving') return { family: 'count:serving', f: 1, key: 'serving' };
        const w = singular(s);
        return { family: 'count:' + w, f: 1, key: w };
    }

    const isRecognisedUnit = (raw) => !!LOOKUP[strip(raw)];

    const num = (v) => { const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v; return Number.isFinite(n) ? n : NaN; };

    /**
     * How much bigger is `want` than `base`?  → { ok:true, factor } or { ok:false, reason }.
     * base/want are { amount, unit }.
     */
    function factor(base, want) {
        const ba = num(base && base.amount), wa = num(want && want.amount);
        if (!(ba > 0)) return { ok: false, reason: 'base-amount' };
        if (!(wa > 0)) return { ok: false, reason: 'amount' };
        const bu = parseUnit(base.unit), wu = parseUnit(want.unit);
        if (!bu || !wu) return { ok: false, reason: 'unit' };
        if (bu.family !== wu.family) return { ok: false, reason: 'units' };
        return { ok: true, factor: (wa * wu.f) / (ba * bu.f) };
    }

    /** Scale a { calories, protein, carbs, fat } by f. Calories whole, the rest to 0.1 g. */
    function scaleMacros(m, f) {
        const one = (v) => { const n = num(v); return Number.isFinite(n) ? n : 0; };
        const r1 = (v) => Math.round(v * 10) / 10;
        return {
            calories: Math.round(one(m.calories) * f),
            protein: r1(one(m.protein) * f),
            carbs: r1(one(m.carbs) * f),
            fat: r1(one(m.fat) * f),
        };
    }

    /** Tidy an amount for display / storage: up to 2 decimals, no trailing zeros. */
    const fmtAmount = (n) => { const v = num(n); return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : ''; };

    /**
     * Pull a leading "10 oz" / "1 porción" off a legacy name ("10 oz Medalla Light").
     * Only trusted when the unit word is a RECOGNISED one — "5 huevos" is left alone
     * rather than guessing that "huevos" is a unit and the rest is the name.
     * → { amount, unit, name } or null.
     */
    function parseLeadingAmount(text) {
        const m = String(text || '').match(/^\s*(\d+(?:[.,]\d+)?)\s*(fl\s*oz|[a-zA-ZáéíóúñÁÉÍÓÚÑ]+)\.?\s+(\S.*)$/);
        if (!m) return null;
        const amount = num(m[1]);
        if (!(amount > 0) || !isRecognisedUnit(m[2])) return null;
        return { amount, unit: m[2].toLowerCase().replace(/\s+/g, ' '), name: m[3].trim() };
    }

    /** A food's base from whatever it carries; the generic "1 porción" when nothing is known. */
    function baseOf(food) {
        const a = num(food && (food.servingAmount != null ? food.servingAmount : food.baseAmount));
        const u = food && (food.servingUnit || food.baseUnit);
        if (a > 0 && u) return { amount: a, unit: String(u), known: true };
        const lead = parseLeadingAmount(food && food.name);
        if (lead) return { amount: lead.amount, unit: lead.unit, known: true, name: lead.name };
        return { amount: 1, unit: 'porción', known: false };
    }

    return { factor, scaleMacros, fmtAmount, parseLeadingAmount, parseUnit, isRecognisedUnit, baseOf, strip, MASS, VOLUME };
});
