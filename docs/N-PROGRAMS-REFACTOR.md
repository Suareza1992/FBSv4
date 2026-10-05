# Scope — unlimited programs per client per day

**Status:** not started. Written 2026-10-04, after shipping the two-program version (TECHNICAL.md § 34).

Today a client's day can hold **two** routines: the main block and the `alternative` block. This
document scopes removing that limit.

---

## 1. Why the limit exists

`ClientWorkout` has a unique index on `{ clientId, date }`. One document owns the day. Two routines
fit because the second one lives in a sub-object on that same document.

That index is not decoration — it is what makes the concurrent upserts safe, and every read in the
system assumes one workout per date.

## 2. What actually has to change — measured, not estimated

| Surface | Count | What they are |
|---|---|---|
| `ClientWorkout.findOne` (server) | 10 | all keyed `{clientId, date}` |
| `ClientWorkout.find` / `aggregate` / `findOneAndUpdate` / `deleteOne` | 9 | lists, upserts, the summary projection |
| Workout routes | 11 | `/api/client-workouts*`, `/api/exercise-history*`, `/api/log*` |
| Web `_calendarWorkouts[date] = …` | 10 | the calendar's one-cell-one-workout map |
| Web `workout.exercises` reads | 11 | cell render, expand, editor, client detail |
| Web `/api/client-workouts` calls | 31 | assign, copy/paste, editor, client views |
| Mobile `byDate[date]` | 5 | Inicio strip + streaks |
| Mobile exercise reads | 11 | `hoy.tsx` (10), `programa.tsx` (1) |
| Mobile `/api/client-workouts` calls | 15 | Hoy, Inicio, Programa, client detail |

Count the production rows before planning the migration window:

```bash
mongosh "$MONGO_URI" --quiet --eval 'db.clientworkouts.countDocuments({})'
```

## 3. Two designs

### Design A — drop the unique index, N documents per date

**Good:** `exercises` stays top-level, so `exercise-history`'s `$elemMatch` query and the `/swap`
route barely change. Each routine gets its own `_id`.

**The blocker: day-level fields have nowhere to live.** `mood`, `isComplete`, `isMissed`, `rpe`
describe the *day*, not a routine. With three documents for one date you either duplicate them and
keep them in sync, or introduce a second `ClientDay` model — a new collection, a second migration,
and a join on every read.

Also: every `findOneAndUpdate({clientId, date}, …, {upsert:true})` becomes ambiguous (which
document?), so every write needs a routine identifier, and the concurrency guarantees the unique
index was providing have to be rebuilt by hand.

### Design B — one document, `routines: []`  ← **recommended**

```js
routines: [{
    label, exercises: [WorkoutExerciseFields],
    sourceProgramId, sourceWeek, sourceDayNum, manualEdit,
}],
chosenRoutine: { type: Number, default: 0 },
```

Day-level stays day-level: `date`, `isRest`, `restType`, `mood`, `isComplete`, `isMissed`, `rpe`,
warm-up and cooldown.

**Good:** the unique index stays, so all concurrency safety is preserved. One `findOne` per day, so
the 10 server lookups keep their shape. `_calendarWorkouts[date]` stays one object — only the
*render* iterates. And it is a straight generalization of the `alternative` block that already
ships, so the migration is mechanical: `exercises` → `routines[0]`, `alternative` → `routines[1]`.

**Cost:** every `workout.exercises` read becomes `workout.routines[i].exercises` — roughly 30 sites
across both clients.

**Recommendation: Design B.** Design A looks simpler until the `mood` question, and then it costs
more than B everywhere.

## 4. The genuinely hard parts

1. **`exercise-history` queries Mongo, not JS.** It filters with
   `exercises: { $elemMatch: { name: … } }`. Under B that becomes a query into a doubly-nested
   array (`routines.exercises`), which Mongo supports but with different semantics — `$elemMatch`
   will not correlate the two levels. Needs rewriting as an aggregation with `$unwind`, and tests:
   "did this client ever log Press banca" must find it in *any* routine.

2. **Old mobile builds.** An app on a phone reads `workout.exercises`. Once that field is gone,
   every build that is not updated shows empty workouts — and you cannot force-update an app in the
   stores. **This is the single biggest reason to do this BEFORE the app ships, not after.**
   Mitigation either way: keep `exercises` as a mirror of `routines[0].exercises` for a transition
   window (§ 5, phase 1), so old clients see the primary routine and new ones see all.

3. **Program re-sync.** It finds client days with
   `ClientWorkout.find({ clientId, sourceProgramId })` and keys them `sourceWeek-sourceDayNum`.
   Under B the provenance is inside `routines[]`, so the match becomes (document, routine index).
   **Note this is already broken for the second program shipped in § 34** — re-sync matches only the
   top-level `sourceProgramId`, so editing a program assigned to the alternative slot does not
   propagate. See § 6; it is cheap to fix standalone.

4. **`/swap` takes an exercise index.** It needs a routine index too, and the body shape changes.

5. **`isComplete` / streaks / adherence.** Keeping these day-level (recommended) means "the client
   completed the routine they chose". That preserves every streak and adherence calculation
   unchanged. Moving them per-routine would be more precise and would touch mobile streaks,
   `programa.tsx` adherence, the calendar dot and the notification text.

6. **Copy/paste and the clipboard.** Copying a day: the whole day with all routines, or one routine?
   Needs a decision; the clipboard chip and the paste handler both change.

7. **Deleting.** `DELETE /api/client-workouts/:clientId/:date` removes the day. With N routines
   there must also be "remove this one routine", and the UI needs both.

8. **The calendar cell** already renders one card per block (§ 34), so going from 2 to N is small
   there — the loop just reads `routines` instead of two hard-coded blocks.

## 5. Phased plan

| Phase | Work | Shippable alone? |
|---|---|---|
| **0** | Migration script (`exercises`→`routines[0]`, `alternative`→`routines[1]`), dry-run mode, reversible. Count rows first. | yes |
| **1** | Schema + all 11 server routes. **Dual-write**: keep `exercises` mirroring `routines[0]` so nothing on an old client breaks. Rewrite `exercise-history` as an aggregation. Fix re-sync. | yes |
| **2** | Web: calendar render loop, expand, day editor tabs (N instead of 2), the assign chooser (pick a slot, not just main/alternative), copy/paste, delete-one-routine. | yes |
| **3** | Mobile: `hoy.tsx` toggle for N, `programa.tsx` row, Inicio streaks. Requires a new build. | yes |
| **4** | Drop the `exercises` mirror once every client is on a build that reads `routines`. | last |

Phases 1–3 each leave the product working, so this can be done over several sittings rather than
one risky landing.

## 6. ~~Cheap fix available now~~ — DONE 2026-10-05

Re-sync did not see programs assigned to the alternative slot. Fixed; see TECHNICAL.md § 35.

The cause was not the workout query, as guessed here — it was `User.assignedProgram` being
single-valued, so a client was never linked to their second program and sync never visited them.
A second link (`assignedProgramAlt`) now carries it.

That work also fixed a **data-loss bug**: removing a day from one program deleted the whole
ClientWorkout document, taking the other program's routine on that date with it.

**Impact on this scope:** § 4.3 is resolved, and the N refactor inherits the `assignedProgramAlt`
pattern — under Design B the links become an array too (`assignedPrograms: [{programId, startDate,
anchorOffset}]`), which is a small extension of what now exists rather than a new idea.

## 7. Effort

Roughly **five focused working sessions**, spread as the phases above — call it one to one and a
half weeks of real calendar time alongside everything else. The uncertainty is concentrated in
phase 2 (31 web call sites) and in `exercise-history`.

## 8. Is it worth it?

The shipped two-program version covers gym-vs-home, which is the case that prompted it. N is worth
doing when one of these becomes true:

- a client needs **three or more** parallel programs (e.g. strength + conditioning + rehab)
- you want each routine to track its own completion and RPE rather than the day's
- "second routine" starts feeling like a workaround in conversation with clients

Until then, the honest answer is that the limit is not costing anything. **But if you are going to
do it, doing it before the mobile app is in the stores is materially cheaper** — see § 4.2.
