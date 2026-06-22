# FitBySuárez — Build-From-Scratch Guide

A feature-by-feature teaching guide to recreating this entire platform, **with code snippets**. It's ordered by **dependency** — each part builds on the ones before it. For each feature you get the **goal**, **data model**, **API**, **frontend wiring**, the **gotchas** that actually bit us, and representative code.

The snippets are *illustrative* — faithful to the real patterns in `server.js` / `public/app.js`, condensed for teaching. Cross-reference the source as you go.

## The parts

1. [Foundation](01-foundation.md) — stack, models, auth, the SPA shell, UI primitives
2. [Trainer features](02-trainer-features.md) — clients, invites, library, program builder, assignment, workout editor, notifications, measurements, payments, blog
3. [Client features](03-client-features.md) — workout logging, nutrition, photos, metrics, equipment
4. [Integrations & cross-cutting](04-integrations.md) — email, food APIs, AI, security, deployment
5. [Self-serve signup & payments](05-self-serve-signup-and-payments.md) — public pricing page, Stripe + **native PayPal**, pay-then-create-account provisioning
6. [The mobile app](06-mobile-app.md) — the Expo/React Native companion app: cookie auth, role-aware tabs, screen-by-screen, store-policy rationale

Parts 1–4 are the web platform. Part 5 adds public paid onboarding on top of it. Part 6 is a **separate repo** (`FitBySuarez-mobile`) that consumes the same API — start it only once the backend is stable.

## Condensed build order

Shortest path to a working app:

1. **Foundation** (Part 1) — you now have auth + a shell.
2. **Clients → Invites → Library → Program builder → Workout editor → Workout logging** (Part 2 §6–11, Part 3 §16) — clients can receive and do workouts.
3. **Nutrition → Metrics → Photos → Equipment** (Part 3) — client self-tracking.
4. **Notifications → Measurements → Payments** (Part 2 §12–14) — trainer oversight + money.
5. **Blog** (§15), **Email/Food/Security** (Part 4 §21–24).
6. **AI** (§23) last, behind feature flags.
7. **Self-serve signup + Stripe/PayPal** (Part 5) — once invite-flow accounts work, reuse that same provisioning behind a paid checkout.
8. **Mobile app** (Part 6) — last; it's pure front-end over the finished API.

Deploy (§25) as soon as Part 1 works, and keep deploying.

## House rules that apply everywhere

- **Escape every server string** before `innerHTML` (`escHtml`).
- **Allowlist** updatable fields on every `PUT`/`PATCH` — never spread `req.body` into a doc.
- **Hash tokens at rest** (SHA-256); only raw tokens travel in emails.
- **Upsert-by-day** (`findOneAndUpdate({clientId,date}, …, {upsert:true})`) for anything a client edits "today."
- **Local dates, not UTC** — compute "today" with a local-date helper.
- **Compile Tailwind** to `output.css` and commit it; re-run after new utility classes.
- Local dev points at the **production DB** — clean up test data.
- **Create the account *after* payment, never before** — and make provisioning **idempotent** (dedupe on the processor's payment id), because webhooks and finalize calls retry (Part 5).
- **Never set explicit `payment_method_types` on Stripe Checkout** — omit it so the Dashboard's enabled methods show; hard-coding an unactivated method throws (Part 5 §28).
- **Sell on the web, authenticate in the app** — keep digital purchases out of the iOS/Android binary to avoid In-App-Purchase rules (Part 6 §36).
- **Mobile reads the *versioned* Expo docs** for its pinned SDK before any change; the app is one more API client, so the backend's auth/ownership/role checks already protect it.
