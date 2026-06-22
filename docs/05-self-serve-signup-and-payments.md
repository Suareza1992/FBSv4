# Part 5 — Self-serve signup & payments

[← Integrations](04-integrations.md) · [Index](README.md) · Next: [Mobile app →](06-mobile-app.md)

---

Until now clients were **invite-only** — the trainer created every account (Part 2 §6). This part adds a **public "download → see prices → pay → join" flow**: a prospect picks a plan on the website, pays with **Stripe or PayPal**, and the backend **auto-creates their account** and emails them an activation link. The mobile app stays sign-in only (see [Part 6](06-mobile-app.md) for *why* — App Store rules).

> **`POST /api/auth/register` is still a deliberate 403.** Public self-signup does **not** go through that route — it goes through a *paid* checkout, and the account is created only once payment succeeds. That's the whole point: no payment, no account.

---

## 26. The plans catalog

One editable array is the single source of truth for pricing. `mode` is `'subscription'` (recurring monthly) or `'payment'` (one-time). An optional `moreInfo` renders an expandable "Más información" on the pricing card.

```js
const SIGNUP_PLANS = [
  { id: 'monthly',       label: 'Coaching Mensual', amount: 99,  mode: 'subscription', blurb: '…' },
  { id: 'progressions3', label: '3 Progresiones',   amount: 250, mode: 'payment',      blurb: '…',
    moreInfo: `Una "progresión" es un bloque de entrenamiento…` },  // ← edit freely
];
const findSignupPlan = (id) => SIGNUP_PLANS.find(p => p.id === id);

app.get('/api/signup/plans', (req, res) => res.json(SIGNUP_PLANS)); // public — the page renders from this
```

**Why a code array, not a DB collection:** prices change rarely and are a business decision, not user data. Keeping them in one commented block means "change the price" is a one-line edit + deploy, with no admin UI to build.

---

## 27. One provisioning function, two processors

Both Stripe and PayPal converge on **one** idempotent helper that creates the account, records the paid invoice, and emails the activation link. Mirror the invite flow from Part 2 §6 (placeholder password + hashed one-time token).

```js
// opts: { email, name, lastName, planId, amount, method, dedupeQuery, paymentFields, stripeCustomerId }
async function provisionSignupAccount(opts) {
  const email = (opts.email || '').toLowerCase().trim();
  if (!email) return null;
  if (opts.dedupeQuery && await Payment.findOne(opts.dedupeQuery)) return null; // idempotent: webhooks/finalize retry

  const trainer = await User.findOne({ role: { $in: ['trainer','admin'] } }).select('_id'); // single-trainer product
  const plan    = findSignupPlan(opts.planId);
  const amount  = opts.amount != null ? opts.amount : (plan?.amount || 0);

  let client = await User.findOne({ email }), inviteRawToken = null;
  if (!client) {
    inviteRawToken = crypto.randomBytes(32).toString('hex');
    client = await new User({
      name: opts.name || 'Nuevo', lastName: opts.lastName || '', email,
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      isFirstLogin: true, role: 'client', trainerId: trainer._id,
      inviteToken: crypto.createHash('sha256').update(inviteRawToken).digest('hex'),
      inviteExpires: new Date(Date.now() + 7*24*60*60*1000),
    }).save();
    await createNotification({ type: 'client_created', clientId: client._id, /* "se registró y pagó en línea" */ });
  }

  await new Payment({ clientId: client._id, trainerId: trainer._id, amount, status: 'paid',
    method: opts.method, paidDate: today(), dueDate: today(),
    type: plan?.mode === 'subscription' ? 'subscription' : 'one_time',
    planLabel: plan?.label || '', ...(opts.paymentFields || {}) }).save();

  if (inviteRawToken) await sendActivationEmail(client, inviteRawToken); // only brand-new accounts
  return client;
}
```

**Gotchas that matter here:**
- **Idempotency is non-negotiable.** Stripe retries webhooks; the PayPal finalize endpoint can be double-called on a page refresh. The `dedupeQuery` (keyed on the processor's payment id) makes a second run a no-op so nobody gets two accounts or two charges recorded.
- **Create the account *after* payment, never before.** The prospect's name/email ride along in the checkout metadata (Stripe) or a short-lived `PendingSignup` doc (PayPal); the `User` is only written when money actually lands.
- **Find the owning trainer** with a role query — self-signups have no inviter, so they're assigned to the single trainer/admin account.

---

## 28. Stripe self-serve checkout

A public, rate-limited endpoint creates a Checkout Session tagged `metadata.signup`. The existing Stripe webhook (Part 4 / §14) routes that tag to provisioning.

```js
app.post('/api/signup/checkout', authLimiter, async (req, res) => {
  const { name, lastName, email, planId } = req.body;
  if (await User.findOne({ email: email.toLowerCase().trim() }))
    return res.status(409).json({ message: 'Ya existe una cuenta con ese email.' });
  const plan = findSignupPlan(planId);
  const recurring = plan.mode === 'subscription';
  const session = await stripe.checkout.sessions.create({
    mode: recurring ? 'subscription' : 'payment',
    customer_email: email,
    line_items: [{ price_data: { currency: 'usd', unit_amount: plan.amount*100,
      product_data: { name: `FitBySuárez — ${plan.label}` }, ...(recurring ? { recurring: { interval: 'month' } } : {}) }, quantity: 1 }],
    success_url: `${APP_URL}/signup.html?status=success`,
    cancel_url:  `${APP_URL}/signup.html?status=cancelled`,
    metadata: { signup: 'true', name, lastName, email, planId, planLabel: plan.label },
  });
  res.json({ checkoutUrl: session.url });
});
```
```js
// in the existing webhook, case 'checkout.session.completed':
if (session.metadata?.signup === 'true') { await provisionSelfSignupClient(session); break; }
```
`provisionSelfSignupClient(session)` is a thin adapter that reads the metadata + amount and calls `provisionSignupAccount(...)` with `dedupeQuery: { stripeCheckoutSessionId: session.id }`.

> **Don't set `payment_method_types`.** Omitting it makes Checkout show whatever methods are enabled in the Stripe Dashboard (card, Apple Pay, even PayPal-via-Stripe). Hard-coding a method that isn't activated throws.

---

## 29. Native PayPal (money to your own PayPal)

PayPal-through-Stripe takes Stripe's cut and is region-limited for subscriptions. A **native** integration sends money straight to the trainer's PayPal. It's a redirect flow that mirrors Stripe: create → approve on PayPal → return → finalize → provision.

**Auth + a thin REST wrapper** (Node 18+ has global `fetch`):
```js
const PAYPAL_BASE = (process.env.PAYPAL_ENV === 'sandbox')
  ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
async function paypalToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, { method:'POST',
    headers: { Authorization:`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials' });
  return (await r.json()).access_token;
}
async function paypalApi(path, method, token, body) {
  const r = await fetch(`${PAYPAL_BASE}${path}`, { method,
    headers: { Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `PayPal ${method} ${path} → ${r.status}`);
  return data;
}
```

**Create** — one-time uses Orders v2; monthly uses Subscriptions (which need a billing plan, created lazily once and cached in a tiny `AppSetting` k/v doc):
```js
app.post('/api/signup/paypal/create', authLimiter, async (req, res) => {
  const plan = findSignupPlan(req.body.planId);
  const token = await paypalToken();
  let ref, approveUrl, kind;
  if (plan.mode === 'subscription') {
    kind = 'subscription';
    const sub = await paypalApi('/v1/billing/subscriptions', 'POST', token, {
      plan_id: await getPaypalPlanId(token, plan),         // lazy create + cache
      subscriber: { name: { given_name: req.body.name }, email_address: req.body.email },
      application_context: { user_action: 'SUBSCRIBE_NOW',
        return_url: `${APP_URL}/signup.html?paypal=subscription`, cancel_url: `${APP_URL}/signup.html?status=cancelled` } });
    ref = sub.id; approveUrl = sub.links.find(l => l.rel === 'approve').href;
  } else {
    kind = 'order';
    const order = await paypalApi('/v2/checkout/orders', 'POST', token, {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: plan.amount.toFixed(2) } }],
      application_context: { user_action: 'PAY_NOW',
        return_url: `${APP_URL}/signup.html?paypal=order`, cancel_url: `${APP_URL}/signup.html?status=cancelled` } });
    ref = order.id; approveUrl = order.links.find(l => l.rel === 'approve' || l.rel === 'payer-action').href;
  }
  await PendingSignup.create({ ref, kind, ...req.body });   // carry name/email/plan across the redirect (TTL 24h)
  res.json({ approveUrl });
});
```

**Finalize** — the page calls this on return with the order/subscription id; capture (one-time) or verify ACTIVE (subscription), then provision:
```js
app.post('/api/signup/paypal/finalize', authLimiter, async (req, res) => {
  const pending = await PendingSignup.findOne({ ref: req.body.ref });
  if (!pending) return res.json({ status: 'ok' });          // already finalized (refresh) → treat as success
  const token = await paypalToken();
  if (pending.kind === 'subscription') {
    const sub = await paypalApi(`/v1/billing/subscriptions/${pending.ref}`, 'GET', token);
    if (!['ACTIVE','APPROVED'].includes(sub.status)) return res.status(402).json({ message: 'No activa.' });
    await provisionSignupAccount({ ...pending.toObject(), method: 'paypal',
      dedupeQuery: { paypalSubscriptionId: pending.ref }, paymentFields: { paypalSubscriptionId: pending.ref } });
  } else {
    const cap = await paypalApi(`/v2/checkout/orders/${pending.ref}/capture`, 'POST', token, {});
    if (cap.status !== 'COMPLETED') return res.status(402).json({ message: 'No completado.' });
    await provisionSignupAccount({ ...pending.toObject(), method: 'paypal',
      dedupeQuery: { paypalOrderId: pending.ref }, paymentFields: { paypalOrderId: pending.ref } });
  }
  await PendingSignup.deleteOne({ ref: pending.ref });
  res.json({ status: 'ok' });
});
```

**PayPal return-URL params** (the page reads these): orders append `?token=<ORDER_ID>`; subscriptions append `?subscription_id=<ID>`. So `ref = paypal === 'subscription' ? params.get('subscription_id') : params.get('token')`.

**Config:** `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, optional `PAYPAL_ENV` (`sandbox`|`live`). Until set, every PayPal endpoint returns a clean `503` and the page shows the message.

**Known gap:** subscription **renewals** (month 2+) aren't recorded as in-app invoices yet — that needs a PayPal webhook (`PAYMENT.SALE.COMPLETED` with `billing_agreement_id`), the same idea as the Stripe `invoice.paid` handler. The subscription still bills correctly in PayPal; only the trainer's invoice *history* misses renewals.

---

## 30. The public pricing page

`public/signup.html` — a standalone branded page (no build step, no framework). It `GET`s `/api/signup/plans`, renders selectable cards, and offers **two buttons** (card → Stripe, PayPal → native). One shared `startPayment()` validates the form, `POST`s to the right endpoint, and redirects to the returned URL. On return it reads `?status=success` (Stripe) or `?paypal=…` (PayPal → calls finalize) and shows the "check your email to activate" panel.

House rules for this page: **escape every value before `innerHTML`** (the `moreInfo` text is yours, but treat it like data anyway), and never expose a secret — only the *public* client-id ever reaches the browser (and even that isn't needed with this server-redirect flow).

[← Integrations](04-integrations.md) · [Index](README.md) · Next: [Mobile app →](06-mobile-app.md)
