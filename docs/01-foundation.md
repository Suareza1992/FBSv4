# Part 1 — Foundation

[← Index](README.md) · Next: [Trainer features →](02-trainer-features.md)

---

## 1. Project setup & stack

**Goal:** one Node process serving both a JSON API and the static frontend.

`package.json` essentials:
```json
{
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "build:css": "tailwindcss -i ./src/input.css -o ./public/output.css --minify",
    "lint": "eslint ."
  }
}
```

`server.js` boot + static + catch-all:
```js
import express from 'express';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '10mb' })); // base64 photos need headroom

await mongoose.connect(process.env.MONGO_URI);
console.log('MongoDB Conectado');

// ... all routes here ...

app.use(express.static('public'));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.listen(process.env.PORT || 3000);
```

**Gotcha:** the catch-all must come **after** the API routes and static middleware, or it swallows everything.

---

## 2. Data layer: Mongoose models

Two patterns power most of the app.

**Upsert-by-day** — exactly one doc per client per date:
```js
const ClientWorkoutSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date:     { type: String, required: true }, // 'YYYY-MM-DD'
  title: String,
  isRest: Boolean, restType: String,
  warmup: String, cooldown: String,
  exercises: [{ id: Number, name: String, instructions: String, videoUrl: String, isSuperset: Boolean, supersetHead: Boolean }],
  isComplete: Boolean, isMissed: Boolean, rpe: Number,
}, { timestamps: true });
ClientWorkoutSchema.index({ clientId: 1, date: 1 }, { unique: true });
```
```js
await ClientWorkout.findOneAndUpdate(
  { clientId, date },
  { $set: { title, exercises, updatedAt: Date.now() } },
  { upsert: true, new: true }
);
```

**`{ timestamps: true }`** gives `createdAt`/`updatedAt` for free — lean on it.

The **`User`** model is the linchpin (auth + everything a client owns that isn't time-series):
```js
const UserSchema = new mongoose.Schema({
  name: String, lastName: String, email: { type: String, unique: true },
  password: String,
  role: { type: String, enum: ['trainer', 'client'], default: 'client' },
  isFirstLogin: { type: Boolean, default: true },
  isDeleted: { type: Boolean, default: false }, // soft delete
  program: String,                              // assigned program name
  macroSettings: mongoose.Schema.Types.Mixed,
  paymentHandles: mongoose.Schema.Types.Mixed,
  equipment: { type: mongoose.Schema.Types.Mixed, default: {} },
  equipmentCheckOn: { type: Boolean, default: true },
  injuredMuscles: mongoose.Schema.Types.Mixed,
  unitSystem: { type: String, default: 'imperial' },
  servingUnit: { type: String, default: 'g' },
  thr: Number, mahr: Number,
  inviteToken: String, inviteExpires: Date,
  resetPasswordToken: String, resetPasswordExpires: Date,
}, { timestamps: true });
```

---

## 3. Authentication & JWT

**Middleware (`middleware/auth.js`):**
```js
import jwt from 'jsonwebtoken';

export const authenticateToken = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ message: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET); // { id, email, role }
    next();
  } catch { return res.status(401).json({ message: 'Invalid token' }); }
};

export const authorizeRoles = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ message: 'Forbidden' });
```

**Login:**
```js
app.post('/api/auth/login', async (req, res) => {
  const user = await User.findOne({ email: req.body.email.toLowerCase(), isDeleted: { $ne: true } });
  if (!user || !(await bcrypt.compare(req.body.password, user.password)))
    return res.status(401).json({ message: 'Credenciales inválidas' });
  const token = jwt.sign({ id: user._id, email: user.email, role: user.role },
    process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user._id, name: user.name, role: user.role } });
});
```

**Seed the first trainer on boot:**
```js
if (!(await User.findOne({ role: 'trainer' }))) {
  await User.create({
    name: 'Coach', email: 'fitbysuarez@gmail.com', role: 'trainer', isFirstLogin: true,
    password: await bcrypt.hash(process.env.ADMIN_SEED_PASSWORD, 10),
  });
} else console.log('Admin/Trainer account already exists — skipping seed.');
```

**Token-at-rest hashing** (invite + reset use the same idea):
```js
import crypto from 'crypto';
const raw = crypto.randomBytes(32).toString('hex');         // goes in the email
const hash = crypto.createHash('sha256').update(raw).digest('hex'); // goes in the DB
// verify: hash the incoming raw token and compare to the stored hash
```

---

## 4. The SPA shell

**`apiFetch`** — every call goes through it:
```js
const apiFetch = (url, opts = {}) => {
  const token = localStorage.getItem('auth_token');
  return fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(res => {
    if (res.status === 401 && token) { localStorage.clear(); location.reload(); }
    return res;
  });
};
```

**`loadAndInitModule`** — fetch a partial, inject, run its init:
```js
const MODULE_TITLES = { clientes_content: '', programas_content: 'Programas', /* … */ };
const RESTORABLE_MODULES = new Set(Object.keys(MODULE_TITLES));

const loadAndInitModule = async (name) => {
  if (!RESTORABLE_MODULES.has(name)) return false;
  const html = await (await fetch(`${name}.html`)).text();
  updateContent(MODULE_TITLES[name] ?? '', html);
  if (name === 'clientes_content') { renderClientsTable(); attachClientFilterListeners(); }
  if (name === 'programas_content') { await fetchProgramsFromDB(); renderProgramsList(); }
  // … one branch per module …
  sessionStorage.setItem('fbs_last_module', name); // for refresh restore
  return true;
};
```

**Refresh restore** — return the user where they were:
```js
const last = sessionStorage.getItem('fbs_last_module');
const home = user.role === 'trainer' ? 'trainer_home' : 'client_inicio';
if (last && RESTORABLE_MODULES.has(last) && last !== home) await loadAndInitModule(last);
```

**Gotcha (real bug):** a never-cleared module-level id leaks across contexts. `saveRoutine` (program edit) was calling `openClientProfile(currentClientViewId)` and bouncing to a stale client. Guard on the visible view:
```js
const inProgramBuilder = currentProgramId &&
  !document.getElementById('program-builder-view').classList.contains('hidden');
if (inProgramBuilder) renderProgramBuilder(prog);
else if (currentClientViewId) openClientProfile(currentClientViewId);
```

---

## 5. UI primitives

```js
const escHtml = (s) => String(s ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function showToast(msg, type = 'info', ms = 3000) { /* append a positioned, auto-dismissing chip */ }

function showConfirm(msg, { confirmLabel = 'OK', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise(resolve => { /* render modal; buttons resolve(true/false) */ });
}
```
Usage: `if (await showConfirm('¿Reemplazar la rutina?', { danger: true })) { … }`.

**Theme:** charcoal/gold tokens (`#030303` bg, `#1C1C1E`/`#2C2C2E` surfaces, `#FFDB89` gold). Encode hierarchy with **brightness** (`text-[#FFDB89]` vs `text-[#FFDB89]/55`), not many hues.

[← Index](README.md) · Next: [Trainer features →](02-trainer-features.md)
