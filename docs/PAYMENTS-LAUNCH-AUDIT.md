# Payments — launch-readiness audit

**Date:** 2026-09-24 · **Updated:** 2026-09-25 (B1, B2, B4 fixed; ATH Móvil added) · **Scope:** manual invoicing, Stripe self-serve signup, native PayPal
signup, webhooks, provisioning.

## Verdict

The three payment paths are **not equally ready**, and treating them as one system is the main
risk. Split them:

| Path | Verdict | Why |
|---|---|---|
| **Manual invoicing** (ATH Móvil / Venmo / cash) | ✅ **Ready** | A ledger the trainer controls. No external money movement, well-scoped routes, allowlisted updates. |
| **Stripe self-serve** | 🟡 **Blockers fixed — needs a live test** | B1, B2, B4 resolved 2026-09-25. Remaining: run `GO-LIVE-payments-test.md` against live keys. |
| **ATH Móvil** (manual) | 🟡 **Built — needs the handle configured** | Pay-then-provision with a reference code and trainer confirmation. Set the account in Ajustes. |
| **PayPal self-serve** | ⛔ **Not ready** — needs a design change | Currently unconfigured *and* carries an architectural flaw (B3). |

**Recommendation: launch Stripe-only.** Fix B1/B2/B4, hide the PayPal button (it already returns
503), and bring PayPal back once provisioning moves server-side.

---

## Blockers

### ~~B1~~ ✅ FIXED 2026-09-25 — Webhook errors are swallowed, so Stripe never retries

`server.js`, Stripe webhook:

```js
} catch (e) {
    console.error('Stripe webhook handler error:', e);
}
res.json({ received: true });          // ← 200 even when provisioning threw
```

If `provisionSelfSignupClient` throws — a Mongo blip, the email service down, a duplicate-key
error — Stripe receives **200 OK** and never redelivers. The customer has been charged, has no
account, no Payment record, and nobody is alerted.

This is the worst failure mode in the system: it is silent, it costs money, and it is
indistinguishable from success in the logs.

**Fix:** return `500` from the catch so Stripe retries on its normal backoff schedule. Keep the
200 only for events you deliberately ignore.

### ~~B2~~ ✅ FIXED 2026-09-25 — `invoice.paid` has no idempotency, so renewals double-count

The PayPal path dedupes by `paypalSaleId` — the comment even says *"Deduped by saleId for webhook
retries."* The Stripe path has no equivalent:

```js
case 'invoice.paid': {
    const existing = await Payment.findOne({ stripeSubscriptionId: invoice.subscription });
    if (existing) {
        if (existing.status !== 'paid') { /* first cycle */ }
        else {
            const newPayment = new Payment({ ... });   // ← no check on stripeInvoiceId
            await newPayment.save();
        }
    }
}
```

Stripe retries on timeout and can deliver duplicates. Every redelivery after the first cycle
creates **another Payment row for the same invoice**. Revenue totals inflate and the client sees
invoices that never existed.

**Fix:** `if (await Payment.findOne({ stripeInvoiceId: invoice.id })) break;` before creating —
mirroring what the PayPal path already does.

### B3 — PayPal subscription provisioning depends on the customer's browser

Stripe provisions inside the **webhook** — server-to-server, retried, reliable. PayPal provisions
inside `POST /api/signup/paypal/finalize`, which **the browser calls** after the approval
redirect.

If the customer closes the tab after approving:

| | Outcome |
|---|---|
| One-time order | Never captured. No charge (PayPal voids after ~3 days), but they believe they paid. |
| **Subscription** | **Active in PayPal. Charged monthly. No account exists.** |

The webhook is not a safety net for this:

```js
async function recordPaypalSubscriptionPayment(subId, sale) {
    const original = await Payment.findOne({ paypalSubscriptionId: subId });
    if (!original) return;        // ← unknown subscription: silently ignored
```

With no `finalize`, there is no original, so every monthly `PAYMENT.SALE.COMPLETED` is dropped on
the floor. `BILLING.SUBSCRIPTION.ACTIVATED` is not handled at all.

Compounding it: `PendingSignup` has a **24-hour TTL**, so even a manual recovery attempt the next
day has nothing to work from.

**Fix:** handle `BILLING.SUBSCRIPTION.ACTIVATED` in the webhook and provision there, with
`finalize` as the fast path rather than the only path. Until then, do not sell PayPal
subscriptions.

### ~~B4~~ ✅ FIXED 2026-09-25 — Every dedupe is check-then-act with no database constraint

```js
if (opts.dedupeQuery && await Payment.findOne(opts.dedupeQuery)) return null;
```

Two concurrent webhook deliveries can both pass this check and both create a user and a payment.
The only index on `Payment` is `{ trainerId: 1, dueDate: -1 }` — nothing enforces uniqueness on
any external identifier.

**Fix:** sparse unique indexes on `stripeCheckoutSessionId`, `stripeInvoiceId`, `paypalOrderId`,
`paypalSaleId`, `paypalSubscriptionId`. Then the race is *impossible* rather than *unlikely*, and
a duplicate insert throws instead of corrupting the ledger.

---

## Serious — fix before real volume

| # | Issue | Impact |
|---|---|---|
| **S1** | **No refund / dispute / chargeback handling.** `charge.refunded` and `charge.dispute.created` are unhandled; zero matches for "refund" in the codebase. | A refunded payment stays `paid` forever. Survivable only if you *know* you are reconciling by hand. |
| ~~**S2**~~ ✅ | ~~`POST /api/payments` never checks that `clientId` belongs to the caller.~~ **Fixed 2026-09-25** — `canTouchClient` on both `POST /api/payments` and `POST /api/stripe/checkout`. | Trainer A can invoice trainer B's client, and that client sees it in `/api/payments/mine`. Use `canTouchClient`. |
| ~~**S3**~~ ✅ | ~~No amount validation.~~ **Fixed 2026-09-25** — shared `parseAmountUSD()` on create, edit and Stripe checkout: rejects negative/zero/NaN/Infinity/>$50k/sub-cent, rounds to cents. | A `-500` invoice is storable. |
| **S4** | Money stored as floating-point USD (`invoice.amount_paid / 100`). | Summing floats drifts. Integer cents is the standard. |
| **S5** | Cancelled subscriptions are marked `overdue`. | "Cancelled" is not "overdue". The status enum has no `cancelled`, so reporting is wrong. |
| **S6** | No superadmin oversight — `/api/payments` filters strictly by `trainerId: req.user.id`. | Inconsistent with the oversight model used elsewhere. |
| **S7** | `invoice.payment_failed` unhandled — no dunning. | A card that starts failing just silently stops paying. Nobody is told. |
| **S8** | A client cannot cancel their own subscription; only the trainer can. | Likely a consumer-protection problem, and a support burden. |

---

## What is genuinely solid

Worth stating, because the foundations are better than the gaps suggest:

- **Both webhooks verify signatures.** Stripe via `constructEvent`; PayPal via the real
  `/v1/notifications/verify-webhook-signature` API rather than a shortcut. Many implementations
  skip the PayPal one.
- **The Stripe raw body is correctly excluded from `express.json()`** — a classic and silent
  source of signature failures, handled properly here.
- **Every CRUD route is scoped by `trainerId`.** No cross-trainer reads, no cross-trainer writes.
- **`PATCH /api/payments/:id` uses a field allowlist**, not a `req.body` spread.
- **Signup routes to the superadmin**, with a comment explaining the multi-trainer lottery bug
  that was fixed — exactly the kind of decision that should be written down.
- **Graceful 503 when unconfigured** rather than a crash or a half-finished charge.
- **Duplicate-email check before checkout**, so a payer cannot create a second account.
- **`PendingSignup` to carry state across the PayPal redirect** is the right pattern.
- A go-live test script already exists (`GO-LIVE-payments-test.md`).

---

## Configuration state

| Var | Local | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | ✅ set | Confirm live vs test in Railway |
| `STRIPE_WEBHOOK_SECRET` | ✅ set | |
| `PAYPAL_CLIENT_ID` | ❌ empty | |
| `PAYPAL_SECRET` | ❌ empty | |
| `PAYPAL_ENV` | ❌ empty | defaults to `live` — dangerous default while untested |
| `PAYPAL_WEBHOOK_ID` | ❌ empty | renewals webhook returns 503 without it |

**PayPal is entirely unconfigured**, so every PayPal route currently 503s. The button should be
hidden rather than shown-and-broken.

> `PAYPAL_ENV` defaulting to `live` is worth changing to `sandbox`. A misconfiguration should fail
> safe, not take real money.

Current plans: **$95/mo subscription** and **$260 one-time (3 Progresiones)**.

---

## Not built at all

- **Tax.** Puerto Rico IVU. Personal training services *may* be exempt — confirm with an
  accountant, do not guess. Stripe Tax is not enabled.
- **Receipts** beyond Stripe's own automatic email.
- **Proration / plan changes.**
- **Failed-payment recovery (dunning).**
- **Revenue reporting.** No aggregate view; the trainer reads a list.

---

## Progress

✅ **Done 2026-09-25** — B1 (webhook returns 500 so Stripe retries), B2 (`invoice.paid` deduped on
`stripeInvoiceId`, plus the id is now stamped on the first cycle so the guard can match it), B4
(sparse unique indexes on `stripeCheckoutSessionId`, `stripeInvoiceId`, `paypalOrderId`,
`paypalSaleId` — **not** `paypalSubscriptionId`, which legitimately has one row per cycle).
Monthly plan raised to **$99** so the trainer nets ~$95.83 after fees. S2 and S3 also done.

> ⚠️ **Index gotcha, learned the hard way.** The first version of B4 used `sparse: true`. Sparse
> only skips documents where the field is **absent** — these fields default to `null` in the
> schema, and `null` is a *present* value, so the **second manual invoice collided with the first
> on a duplicate null** and every invoice creation after the first returned 500. Mongoose
> `autoIndex` had already pushed the broken indexes to production on boot. Fixed with
> `partialFilterExpression: { field: { $type: 'string' } }`, which indexes only real ids; the four
> bad indexes were dropped and recreated. **Verified both directions: many nulls coexist, a
> duplicate real id is still blocked.**

### Remaining order

1. **S1** — at minimum handle `charge.refunded`
3. Set the ATH Móvil account in **Ajustes** (the option 503s until then)
4. Ship **Stripe + ATH Móvil**; run `GO-LIVE-payments-test.md` with test keys, then live
5. **B3** — move PayPal provisioning into the webhook, then re-enable PayPal
6. S4–S8 as volume justifies

---

## ATH Móvil (added 2026-09-25)

ATH Móvil has **no self-serve payment API** without a merchant (Business) account, so this path is
deliberately manual rather than pretending to be automated:

1. Client picks ATH Móvil → server creates a `PendingSignup` and returns the handle, the amount and
   a reference code (`FBS-XXXXXX`)
2. Client transfers, putting the code in the payment note, then presses "ya envié el pago" — which
   only **notifies** the trainer
3. Trainer confirms in the app → `provisionSignupAccount()` runs

**It keeps the rule every other path follows: no account exists until the money is confirmed.**

Design notes:

- The reference alphabet omits `0 O 1 I` — the code is typed into a phone by hand and then read
  back off a bank statement.
- A second click **reuses the existing code** rather than minting another. Two codes for one
  transfer is unresolvable for whoever is reconciling.
- Confirm is a **conditional update** (`status: 'awaiting'` in the filter), so a double tap cannot
  provision twice. If provisioning then fails, the request is put back to `awaiting` rather than
  lost.
- Monthly over ATH Móvil **cannot auto-renew**, and the signup page says so at the point of
  payment rather than letting someone discover it next month.
- The TTL index is `partialFilterExpression`-scoped to PayPal kinds — a bank transfer can easily
  take more than 24 hours, so ATH Móvil requests must not be swept.

Three handle fields on the trainer profile: `athMovil` (personal), **`athMovilBusiness`**
(commercial — wins when set), `athMovilPhone` (optional). Kept separate so both can be held during
the switch-over to a Business account.
