# FitBySuárez — Build-From-Scratch Guide

A feature-by-feature teaching guide to recreating this entire platform, **with code snippets**. It's ordered by **dependency** — each part builds on the ones before it. For each feature you get the **goal**, **data model**, **API**, **frontend wiring**, the **gotchas** that actually bit us, and representative code.

The snippets are *illustrative* — faithful to the real patterns in `server.js` / `public/app.js`, condensed for teaching. Cross-reference the source as you go.

## The parts

1. [Foundation](01-foundation.md) — stack, models, auth, the SPA shell, UI primitives
2. [Trainer features](02-trainer-features.md) — clients, invites, library, program builder, assignment, workout editor, notifications, measurements, payments, blog
3. [Client features](03-client-features.md) — workout logging, nutrition, photos, metrics, equipment
4. [Integrations & cross-cutting](04-integrations.md) — email, food APIs, AI, security, deployment

## Condensed build order

Shortest path to a working app:

1. **Foundation** (Part 1) — you now have auth + a shell.
2. **Clients → Invites → Library → Program builder → Workout editor → Workout logging** (Part 2 §6–11, Part 3 §16) — clients can receive and do workouts.
3. **Nutrition → Metrics → Photos → Equipment** (Part 3) — client self-tracking.
4. **Notifications → Measurements → Payments** (Part 2 §12–14) — trainer oversight + money.
5. **Blog** (§15), **Email/Food/Security** (Part 4 §21–24).
6. **AI** (§23) last, behind feature flags.

Deploy (§25) as soon as Part 1 works, and keep deploying.

## House rules that apply everywhere

- **Escape every server string** before `innerHTML` (`escHtml`).
- **Allowlist** updatable fields on every `PUT`/`PATCH` — never spread `req.body` into a doc.
- **Hash tokens at rest** (SHA-256); only raw tokens travel in emails.
- **Upsert-by-day** (`findOneAndUpdate({clientId,date}, …, {upsert:true})`) for anything a client edits "today."
- **Local dates, not UTC** — compute "today" with a local-date helper.
- **Compile Tailwind** to `output.css` and commit it; re-run after new utility classes.
- Local dev points at the **production DB** — clean up test data.
