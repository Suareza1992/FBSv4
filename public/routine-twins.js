// Finding the copies of a routine — "did I change this day in every week?"
//
// A program is built by writing one week and pasting it into the rest. Then the
// trainer refines a day — swaps an exercise, fixes the sets — and every copy of that
// day in the other weeks is silently stale, to be fixed by hand, one at a time, from
// memory. That is how a twelve-week program drifts out of sync with itself.
//
// Nothing in the data says two days are copies of each other, and nothing can: the
// programs already in the database carry no lineage, and adding some now would only
// help programs built from tomorrow on. But a copy is recognisable without lineage —
// before the edit, the copies were IDENTICAL to the day being edited. So this file
// compares each day's content against what the edited day looked like a moment ago.
//
// The rules are deliberately conservative, because the wrong answer here overwrites
// work:
//   • A day that was ALREADY different is not a copy. Someone made it different on
//     purpose; it is left alone and never offered.
//   • A day already identical to the NEW version needs nothing, so it is not offered.
//   • A day that was EMPTY before the edit has no copies worth the name — otherwise
//     filling in one blank day would offer to fill every blank day in the program.
//   • Case and runs of whitespace are ignored, so "Press  de Banca" still matches
//     "Press de banca". Everything else is compared exactly, VIDEOS INCLUDED: if one
//     copy has a demo video attached and another does not, they are not
//     interchangeable and must not be written over each other. (The website stores a
//     clip on `video`, the phone on `videoUrl`; both are read.)
//   • Generated item ids and the day's nutrition are not part of the routine and are
//     left out of the comparison.
//
// Nothing here writes anything. It answers "which days were this same routine", and
// the caller asks the trainer before touching any of them.
//
// Tested by scripts/test-routine-twins.mjs — no server, no database.

// A plain browser script: it puts RoutineTwins on `self`. (The Node test runs it the
// same way — this package is "type":"module", so it cannot be require()d.)
(function (root, factory) {
    root.RoutineTwins = factory();
})(self, function () {
    'use strict';

    /** Does this day hold anything worth keeping? A blank day has no copies. */
    function dayHasContent(day) {
        if (!day) return false;
        return !!(
            (Array.isArray(day.exercises) && day.exercises.length > 0)
            || (typeof day.warmup === 'string' && day.warmup.trim())
            || (typeof day.cooldown === 'string' && day.cooldown.trim())
            || (Array.isArray(day.warmupItems) && day.warmupItems.length > 0)
            || (Array.isArray(day.cooldownItems) && day.cooldownItems.length > 0)
            || day.isRest
        );
    }

    const t = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase();

    /** A day's routine reduced to one comparable string. Same signature = same routine. */
    function signature(day) {
        if (!day) return '';
        const items = (list) => (Array.isArray(list) ? list : [])
            .map((i) => `${t(i && i.name)}|${t(i && i.videoUrl)}`).join('~');
        // The phone writes a clip to `videoUrl`, the website to `video`. Read both, or
        // a day with a demo video saved on one of them would look identical to a day
        // without one saved on the other.
        const exercises = (Array.isArray(day.exercises) ? day.exercises : [])
            .map((e) => `${t(e && e.name)}|${t(e && e.stats)}|${t(e && (e.video || e.videoUrl))}|${e && e.isSuperset ? 1 : 0}`)
            .join('~');
        return [
            t(day.name),
            day.isRest ? (day.isActiveRest ? 'rest:active' : 'rest') : 'work',
            exercises,
            t(day.warmup), t(day.cooldown),
            t(day.warmupVideo), t(day.cooldownVideo),
            items(day.warmupItems), items(day.cooldownItems),
        ].join('§');
    }

    /**
     * Every OTHER day in this program that was the same routine and still needs the change.
     *   prog        the whole program ({ weeks: [{ weekNumber, days: { "1": {...} } }] })
     *   skipWeekIdx / skipDayNum   the day just edited, never included
     *   beforeSig / afterSig       signatures of that day before and after the edit
     * → [{ weekIdx, dayNum, weekNumber, name }]
     */
    function find(prog, skipWeekIdx, skipDayNum, beforeSig, afterSig) {
        const twins = [];
        if (!beforeSig || beforeSig === afterSig) return twins;   // nothing changed, nothing to carry
        const weeks = (prog && prog.weeks) || [];
        weeks.forEach((week, weekIdx) => {
            const days = (week && week.days) || {};
            for (let d = 1; d <= 7; d++) {
                if (weekIdx === skipWeekIdx && String(d) === String(skipDayNum)) continue;
                const day = days[String(d)] || days[d];
                if (!day) continue;
                const sig = signature(day);
                if (sig !== beforeSig) continue;   // never was this routine — left alone
                if (sig === afterSig) continue;    // already says what the edit says
                twins.push({
                    weekIdx,
                    dayNum: String(d),
                    weekNumber: (week && week.weekNumber) || weekIdx + 1,
                    name: day.name || `Día ${d}`,
                });
            }
        });
        return twins;
    }

    /**
     * The whole decision in one call, so the caller cannot get the order wrong.
     * → { offer: boolean, twins: [...] }
     */
    function plan(prog, weekIdx, dayNum, before, after) {
        if (!dayHasContent(before)) return { offer: false, twins: [] };
        const beforeSig = signature(before);
        const afterSig  = signature(after);
        if (beforeSig === afterSig) return { offer: false, twins: [] };
        const twins = find(prog, weekIdx, dayNum, beforeSig, afterSig);
        return { offer: twins.length > 0, twins };
    }

    return { dayHasContent, signature, find, plan };
});
