# Part 4 — Integrations & cross-cutting

[← Client features](03-client-features.md) · [Index](README.md)

---

## 21. Email (Resend)

Use the **Resend HTTP API** — Railway blocks SMTP ports, so Nodemailer/Gmail SMTP won't send in production.
```js
const sendEmail = async ({ to, subject, html, replyTo }) => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'FitBySuárez <noreply@fitbysuarez.com>',  // MUST be a verified domain
      to, subject, html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  return res.ok;
};
```

**Gotcha:** you can't set `from` to an arbitrary Gmail — Resend rejects unverified domains. Send *from* your verified domain and set `reply_to` to the trainer's address (this is exactly what broke invoice emails until fixed).

---

## 22. Food data APIs

Layer sources, local first, with a relevance guard:
```js
const resolveFood = async (query) => {
  const local = searchLocalFoods(query);                 // curated ES DB incl. PR criollo + aliases
  if (local.length) return local;

  const term = simplifyIngredient(query).split(' ')[0];  // strip stopwords ("griego", "desnatada"…)
  const usda = await fetchUSDA(query, { dataTypes: ['Foundation','SR Legacy'] }); // drop FNDDS — junk matches
  // relevance guard: the matched name must contain the first query term
  const hit = usda.find(f => f.description.toLowerCase().includes(term));
  return hit ? [hit] : await fetchNutritionix(query); // then Open Food Facts as last resort
};
```
**Gotcha:** FNDDS returns nonsense like "Papa John's Pizza" for "papa cocida" — exclude it. APIs are optional; the local DB is the floor.

---

## 23. AI features (Anthropic)

All three AI features (meal recommender, NL food logging, equipment check) share one recipe.

**Config + flags (default-on, flip off to ship dark):**
```js
import Anthropic from '@anthropic-ai/sdk';
const intEnv = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; }; // keeps a real 0
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const anthropic = ANTHROPIC_KEY ? new Anthropic({ apiKey: ANTHROPIC_KEY }) : null;
const EQUIPMENT_CHECK_ENABLED = process.env.EQUIPMENT_CHECK_ENABLED !== 'false';
const EQUIPMENT_CHECK_DAILY_LIMIT = intEnv(process.env.EQUIPMENT_CHECK_DAILY_LIMIT, 50);
const MEAL_MONTHLY_LIMIT = intEnv(process.env.MEAL_MONTHLY_LIMIT, 3000); // shared global cap
```

**Triple cost cap via an `AiUsage` collection — check BEFORE calling (a 429 costs $0):**
```js
const AiUsageSchema = new mongoose.Schema({ scope: String, clientId: { type: mongoose.Schema.Types.ObjectId, default: null }, period: String, count: Number });
AiUsageSchema.index({ scope: 1, clientId: 1, period: 1 }, { unique: true });

async function bumpAndCheck(scope, clientId, period, limit) {
  const doc = await AiUsage.findOneAndUpdate({ scope, clientId, period },
    { $inc: { count: 1 } }, { upsert: true, new: true });
  return doc.count <= limit;
}
```

**The call — structured output + verify + timeout:**
```js
if (!EQUIPMENT_CHECK_ENABLED || !anthropic) return res.status(503).json({ message: 'No disponible' });
const day = new Date().toISOString().slice(0,10), month = day.slice(0,7);
if (!(await bumpAndCheck('equipment_check', req.user.id, day, EQUIPMENT_CHECK_DAILY_LIMIT)))
  return res.status(429).json({ message: 'Límite diario' });
if (!(await bumpAndCheck('global', null, month, MEAL_MONTHLY_LIMIT)))
  return res.status(429).json({ message: 'Límite mensual' });

const msg = await anthropic.messages.create({
  model: 'claude-haiku-4-5', max_tokens: 1024,
  system: 'Flag exercises needing equipment the client lacks…',
  messages: [{ role: 'user', content: prompt }],
  output_config: { format: { type: 'json_schema', schema: EQUIPMENT_CHECK_SCHEMA } },
}, { timeout: 25000, maxRetries: 1 });
const parsed = JSON.parse(msg.content[0].text);
// VERIFY: re-check macros/items against the DB before trusting/saving
```

**Gotchas:**
- `parseInt(x) || 5` turns a configured `0` into `5` — use `intEnv` with a `Number.isNaN` check.
- `dotenv` won't override an env var already exported (even if empty) — fall back to the parsed file: `process.env.X || dotenv.config().parsed?.X`.
- Always **verify AI output against your own data** before saving.

---

## 24. Security hardening

```js
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';

app.use(helmet({ contentSecurityPolicy: { directives: { /* allow your CDNs + 'self' */ } } }));
app.use(cors({ origin: process.env.CORS_ORIGIN || process.env.APP_URL, credentials: true }));
app.use('/api/auth', rateLimit({ windowMs: 15*60*1000, max: 50 })); // throttle auth
```
Plus: allowlist on every write, `escHtml` on every server string in the DOM, hash tokens at rest, gate verbose logs behind `DEBUG`. **ESLint 10** flat config — Node globals for backend files, browser + script-mode globals for `public/**`, and declare your window-attached app globals so `no-undef` stays meaningful.

---

## 25. Deployment

**Railway**, auto-deploy from GitHub `main`:
- Set every var from `.env.example` in the Railway dashboard.
- **Build Tailwind and commit `output.css`** — production serves the compiled file, not the CDN. Re-run `npm run build:css` after adding any new utility class or it won't exist in prod (this bit us repeatedly).
- Keep launch-unready features dark: `MEAL_SUGGESTION_ENABLED=false`, `FOOD_NLP_ENABLED=false`, `EQUIPMENT_CHECK_ENABLED=false`.
- One Mongo Atlas cluster — and the **local dev server points at the same production DB**, so clean up any test data you create.

```bash
# typical local loop
npm install
cp .env.example .env        # fill in real values
npm run build:css           # whenever classes change
node --check server.js && npm run lint   # before committing
npm start
```

[← Client features](03-client-features.md) · [Index](README.md)
