# FitBySuárez — Session Handoff / Onboarding Prompt

> **How to use:** paste this whole file as the first message of a new conversation. It brings a fresh
> session fully up to speed on both repos. Keep it updated as the project moves.
>
> Last updated: **2026-07-22**

---

I'm Angel Suárez. I run a personal-training business and built FitBySuárez, a fitness SaaS with
two clients sharing one API. I'm also learning to program through this project — I want to be able
to justify the code in job interviews and when selling my services, so explain the *why*, not just
the *what*.

## The two repos

| | Path | Stack |
|---|---|---|
| **Web** | `/Users/angelsuarez/Coding Projects/FitBySuarez-navbar-dashboard` | Node/Express + MongoDB Atlas (Mongoose), vanilla-JS SPA (`public/app.js`, ~15k lines), Tailwind via CDN |
| **Mobile** | `/Users/angelsuarez/Coding Projects/FitBySuarez-mobile` | Expo SDK 54 (**pinned**), expo-router, TypeScript |

Both hit the **same** API. The server lives only in the web repo (`server.js`).
UI is **in Spanish**. Brand: gold `#FFDB89` on black `#030303`. **No emojis in UI** — use Font Awesome
(web) / `@expo/vector-icons` (mobile).

## Hard rules

- **Never `git add`, `commit`, or `push` unless I ask in that exact message.** Editing/testing locally is fine.
- **Mobile: Expo SDK 54 is pinned.** Read `https://docs.expo.dev/versions/v54.0.0/` before writing any
  Expo code (see `AGENTS.md`). Don't bump SDK versions.
- The database is **production** with ~15 real clients in Puerto Rico. If you create test data, name it
  obviously (`ZZ_TEST_…`) and **delete it afterward**. Never overwrite a real client's day without asking.
- After a batch of features, update the docs: **`TECHNICAL.md`** (web — this is my study guide, so write
  it to teach) and the **mobile `README.md`**.

## Architecture essentials

- **Auth:** JWT in an HttpOnly `auth_token` cookie. `apiFetch` relies on the browser/native layer sending it.
  Roles: `trainer` | `client` | `admin`, set server-side and never client-writable.
- **Web SPA:** everything renders at `/`. `loadAndInitModule(name)` fetches `<name>.html` fragments into
  `#main-content`. Browser Back/Forward works via `pushState` with **hash** URLs (`#/clientes`).
- **Data model highlights:**
  - `Program.weeks[].days` is a **`Map<String, Mixed>`** keyed `"1".."7"`.
  - `ClientWorkout` = one doc per `{clientId, date}`, with program provenance
    (`sourceProgramId` / `sourceWeek` / `sourceDayNum`) that drives auto-sync.
  - Program day exercise: `{name, stats, video, isSuperset, supersetHead}`.
    Calendar workout exercise: `{name, instructions, videoUrl, isSuperset, supersetHead, isComplete, rpe}`.
    `pushSingleDay()` converts between them.

## Traps that already bit me — don't re-introduce

1. **Mongoose `toObject()` vs `toJSON()`.** `toJSON()` defaults to `flattenMaps: true`, `toObject()` does
   **not**. Building a response as `{ ...doc.toObject(), extra }` hides it from Express's `toJSON` path and
   `JSON.stringify` turns the `days` Map into `{}` — the DB saved fine but the response wiped every day, and
   the client cached that. Fixed with `toObject({ flattenMaps: true })`.
2. **Tailwind CDN doesn't JIT classes in dynamically-injected HTML.** `grid-cols-10` silently did nothing and
   a row collapsed to one 431px column. For critical layout in injected markup, use **inline styles**.
   Type-checks and console logs won't catch this — you must render and measure.
3. **Any save that rebuilds an array destroys fields it doesn't copy.** `performWorkoutSave` re-maps
   `exercises` and was dropping the client's `isComplete` and `rpe`. Audit every field another actor writes.
4. **Relative fetches constrain routing.** Module loading uses `` fetch(`${module}.html`) ``, so changing
   `location.pathname` breaks it — that's why routing is hash-based. Deep linking is therefore not supported.
5. **Mongoose strict mode strips unknown sub-schema fields.** Adding a per-exercise field requires editing the
   `exercises` sub-schema, not just the client.

## Program → client auto-sync (important, partly unresolved)

`syncProgramToClients` runs on every `PUT /api/programs/:id` and updates assigned clients' **future**
calendar days. It only reaches clients with an `assignedProgram.programId` **link**.

**As of 2026-07-22, 11 of 15 clients have no link** — they carry only a legacy `program` name string, and
their existing days have `sourceProgramId: null`. This can't be auto-repaired (the start-date anchor isn't
recoverable), so each must be **re-assigned once** via the client's "Asignar programa".
`GET /api/programs/:id/assignment-status` reports linked vs unlinked, and both builders show a warning banner.

## Recently built (all working, verified unless noted)

**Nutrition:** editable entries, personal food library, community library submission, AI nutrition-label
photo scanner (`POST /api/scan-label`, Claude Haiku vision + structured outputs, confirm/edit before logging),
client-side "Buscar en internet" (OpenFoodFacts → USDA fallback, runs on the *client's* connection),
+102 curated PR/US foods in `LOCAL_FOODS`.

**Program builder (web + mobile):** import a routine from pasted text (parses `Día N:` headers, `**bold**`
exercise names, `A + B` supersets, `(4 sets x 12 / 45 seg)` stat splitting), copy a day and paste it into
many days, auto-sync coverage banner.

**Web only:** paste a copied program day onto a client's calendar; browser Back/Forward.

**Both:** per-exercise RPE (1–10) logged next to results, shown to the trainer as a read-only badge.

**Landing page (web only, 2026-07-22):** new pre-login sections — *¿Por qué unirte?*, *Planes*
(mirrors `SIGNUP_PLANS`: $95/mes + $260 tres progresiones, linking to `/signup.html?plan=<id>`),
*Sobre mí*, *¿Qué me diferencia?*, closing CTA, nav anchor links, footer with logo + legal links.
New standalone bilingual pages `terminos.html` / `privacidad.html`. `signup.html` now honors
`?plan=`. Language resolution added `sessionStorage.fbs_lang_session` so the chosen language follows
the visitor onto the legal pages even when it isn't saved as the default. Documented in
`TECHNICAL.md` §14. All verified in the browser at 1280px and 375px.

## Open items

- ⚠️ **Mobile UI is not visually verified.** This Mac has only Xcode Command Line Tools (no `Xcode.app`), so
  there's no iOS Simulator. The mobile program-builder additions type-check and the parser is logic-verified,
  but nobody has *seen* them run. I should check them in Expo Go.
- Cross-context paste (program day → client calendar) exists on web only; mobile's client screen is a history
  list, not a date grid, so it'd need a client+date picker instead.
- Deep linking (`#/programa/<id>` in a fresh tab) not supported.
- Re-assign the 11 unlinked clients so auto-sync reaches them.
- **Landing page copy:** `grep -n "EDITA:" public/index.html` — *Sobre mí* still has placeholders for
  years of experience, certification, and a photo. The legal pages are substantive starter drafts but
  **have not been reviewed by a lawyer.**
- Plan prices are duplicated: `SIGNUP_PLANS` (server, authoritative) vs. the `#planes` cards (markup).
  Change both together.

## How to run and verify locally

```bash
# web (from the web repo)
node server.js          # reads .env; port 3000 (I sometimes have another app on 3000)
```

Docs to read first: web `TECHNICAL.md`, mobile `README.md` + `AGENTS.md`.

To test the UI you need a session: mint a short-lived JWT with the real user's `_id` and `JWT_SECRET` from
`.env`, set it as the `auth_token` cookie, **and** set `localStorage.auth_user` to the `/api/me` response
**plus an `id` field** — the SPA's `loadSession()` reads `session.id`, not `_id`, and without it every
client-scoped fetch silently returns nothing. Delete any test tokens and test data when done.

## How I want you to work

Investigate the real code before proposing changes — this codebase has a lot of history and several
near-duplicate code paths. Verify your work by actually running it, not just type-checking. Tell me plainly
what you couldn't verify. Ask before doing anything destructive to client data.
