# Go-live test — self-serve signup (Stripe + PayPal)

How to configure and prove out the public "pay → account created" flow before you depend on it. Do this once; it's independent of the mobile app being on the stores.

> ⚠️ Local dev and the deployed site both point at the **production database**. Use throwaway test emails and **delete the test client + payment afterward**.

---

## 1. Environment variables (Railway → your service → Variables)

**Stripe** (you likely already have these):
| Var | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_live_…` (or `sk_test_…` while testing) |
| `STRIPE_WEBHOOK_SECRET` | from the Stripe webhook you create in §2 |

**PayPal** (new):
| Var | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | from developer.paypal.com |
| `PAYPAL_SECRET` | from developer.paypal.com |
| `PAYPAL_ENV` | `sandbox` while testing, `live` for real |
| `PAYPAL_WEBHOOK_ID` | from the PayPal webhook you create in §2 |

**Where to get the PayPal creds:** developer.paypal.com → **Apps & Credentials** → toggle **Sandbox** (for testing) or **Live** → open the **Default** app (or create one) → copy **Client ID** + **Secret**.

> Until `PAYPAL_*` is set, every PayPal endpoint returns a clean `503` and the page just shows the message — Stripe keeps working on its own.

---

## 2. Register the webhooks

**Stripe** — Dashboard → Developers → Webhooks → *Add endpoint*:
- URL: `https://api.fitbysuarez.com/api/stripe/webhook`
- Events: `checkout.session.completed`, `invoice.paid`, `customer.subscription.deleted`
- Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`.

**PayPal** — developer.paypal.com → your app → **Webhooks** → *Add Webhook*:
- URL: `https://api.fitbysuarez.com/api/paypal/webhook`
- Events: `PAYMENT.SALE.COMPLETED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`
- Copy the **Webhook ID** → `PAYPAL_WEBHOOK_ID`.

Redeploy after setting the vars so the server picks them up.

---

## 3. Test Stripe (use TEST mode first)

Easiest safe path: set `STRIPE_SECRET_KEY` to your **test** key + the test webhook secret, then:

1. Open `https://api.fitbysuarez.com/signup.html`.
2. Pick a plan → **Pagar con tarjeta**.
3. On Stripe Checkout use test card **`4242 4242 4242 4242`**, any future expiry, any CVC/ZIP.
4. You're redirected back to the **"¡Bienvenido!"** panel.

Then run the **§5 verification checklist**. When it all passes, switch back to **live** keys and (optionally) do one real charge you refund from the Stripe dashboard.

---

## 4. Test PayPal (sandbox)

1. Set `PAYPAL_ENV=sandbox` + your **sandbox** client id/secret + the sandbox webhook id.
2. Get a sandbox **buyer** login: developer.paypal.com → **Testing Tools → Sandbox Accounts** (there's a personal/buyer account with an email + password).
3. Open `signup.html` → pick a plan → **Pagar con PayPal** → log in with the **sandbox buyer** → approve.
4. You're redirected back; the page shows "Confirmando tu pago…" then the success panel.

Test **both** plans: the **$250** (one-time → PayPal *order*) and the **$99/mo** (subscription → PayPal *subscription*, which lazily creates a billing plan the first time).

When sandbox passes, switch to `PAYPAL_ENV=live` + live creds + live webhook id.

---

## 5. Verification checklist (run after each test purchase)

- [ ] Redirected to the **success panel** ("revisa tu correo para activar").
- [ ] A new **client** appears (DB, or in your trainer **Clientes** list / **Facturación**).
- [ ] **Activation email** arrives → its link lets you **set a password** → you can log in.
- [ ] A **Payment** record shows in trainer **Facturación**, status **Pagado**, right amount + plan.
- [ ] **Subscription only:** the *first* charge is recorded once (not duplicated by the webhook).
- [ ] **Idempotency:** refreshing the success page does **not** create a second account or payment.
- [ ] **Renewal (subscription):** on the next cycle, the PayPal/Stripe webhook adds a *new* paid invoice for that month. (In PayPal sandbox you can shorten this or just confirm the first cycle + trust the webhook logic.)
- [ ] **Cleanup:** delete the test client + their Payment record(s) from the production DB.

---

## Common gotchas

- **PayPal 503 on the button** → `PAYPAL_CLIENT_ID`/`SECRET` not set (or not redeployed).
- **PayPal webhook "verification failed"** → `PAYPAL_WEBHOOK_ID` is missing/wrong, or it's the sandbox id while running live (they differ).
- **Account not created after paying** → the webhook isn't reaching the server. Check the Stripe/PayPal webhook dashboard for delivery errors and confirm the URL + events.
- **"Ya existe una cuenta con ese email"** → that email already exists; use a fresh test email each run.
- **Renewal not recorded** → make sure `PAYMENT.SALE.COMPLETED` is subscribed in the PayPal webhook.
