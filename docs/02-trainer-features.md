# Part 2 — Trainer features

[← Foundation](01-foundation.md) · [Index](README.md) · Next: [Client features →](03-client-features.md)

---

## 6. Client management

**API with allowlist + safe projection:**
```js
const CLIENT_SAFE_SELECT = '-password -resetPasswordToken -resetPasswordExpires -inviteToken -inviteExpires';

app.get('/api/clients', authenticateToken, authorizeRoles('trainer','admin'), async (_req, res) => {
  const clients = await User.find({ role: 'client', isDeleted: { $ne: true } })
    .select(CLIENT_SAFE_SELECT).sort({ createdAt: -1 });
  res.json(clients);
});

app.put('/api/clients/:id', authenticateToken, authorizeRoles('trainer','admin'), async (req, res) => {
  const ALLOWED = ['name','lastName','email','program','group','type','dueDate','isActive',
    'location','timezone','unitSystem','phone','height','weight','birthday','gender','thr','mahr',
    'profilePicture','equipment','equipmentCheckOn','macroSettings','waterGoal','injuredMuscles','dietaryPreferences'];
  const update = {};
  for (const k of ALLOWED) if (k in req.body) update[k] = req.body[k];
  const before = await User.findById(req.params.id);
  const client = await User.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
  if (update.program && update.program !== before.program)
    await createNotification({ trainerId: TRAINER_ID, type: 'program_assigned', clientId: client._id,
      clientName: client.name, title: 'programa asignado', message: update.program });
  res.json(client);
});
```

**Soft delete:** `DELETE` sets `isDeleted: true` — never remove the doc.

**Frontend** caches the list and filters in memory:
```js
let clientsCache = [];
const renderClientsTable = () => {
  const q = (searchInput?.value || '').toLowerCase();
  clientsCache.filter(c => !c.isDeleted && c.name.toLowerCase().includes(q)).forEach(renderRow);
};
```

---

## 7. Invite system

```js
app.post('/api/clients', authenticateToken, authorizeRoles('trainer','admin'), async (req, res) => {
  const raw  = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const client = await User.create({
    ...pick(req.body, ['name','lastName','email']), role: 'client',
    inviteToken: hash, inviteExpires: Date.now() + 7*24*60*60*1000,
  });
  const link = `${process.env.APP_URL}/activate?token=${raw}`;
  const sent = await sendEmail({ to: client.email, subject: 'Activa tu cuenta', html: inviteHtml(link) })
    .catch(() => false);
  // Email failure must NOT fail the request — return the raw link for manual sharing.
  res.status(201).json({ client, inviteLink: sent ? undefined : link });
});

app.post('/api/auth/accept-invite', async (req, res) => {
  const hash = crypto.createHash('sha256').update(req.body.token).digest('hex');
  const user = await User.findOne({ inviteToken: hash, inviteExpires: { $gt: Date.now() } });
  if (!user) return res.status(400).json({ message: 'Invitación inválida o vencida' });
  user.password = await bcrypt.hash(req.body.password, 10);
  user.inviteToken = undefined; user.inviteExpires = undefined; user.isFirstLogin = false;
  await user.save();
  res.json({ token: jwt.sign({ id: user._id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' }) });
});
```

---

## 8. Exercise library

```js
const ExerciseSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  videoUrl: String, category: [String], instructions: String,
});

app.post('/api/library', authenticateToken, authorizeRoles('trainer','admin'), async (req, res) => {
  const { name } = req.body;
  const ex = await Exercise.findOneAndUpdate(
    { name: new RegExp(`^${escapeRegex(name)}$`, 'i') }, // upsert by case-insensitive name
    { $set: req.body }, { upsert: true, new: true });
  res.json(ex);
});
```
Frontend: as the trainer types an exercise name, filter `globalExerciseLibrary` for an autocomplete; selecting a hit auto-fills its `videoUrl`.

---

## 9. Multi-week program builder

```js
const ProgramSchema = new mongoose.Schema({
  name: { type: String, required: true }, description: String, tags: String,
  weeks: [{ weekNumber: Number, days: { type: Map, of: mongoose.Schema.Types.Mixed } }],
}, { timestamps: true });
```

**Save a day's routine** (walks the DOM; superset connectors mark chained sets):
```js
const saveRoutine = async () => {
  const exercises = [];
  let nextIsSuperset = false;
  document.querySelectorAll('#exercise-list > *').forEach(el => {
    if (el.classList.contains('superset-connector-row')) nextIsSuperset = el.dataset.active === 'true';
    else if (el.classList.contains('exercise-item')) {
      exercises.push({
        name: el.querySelector('.exercise-name-input').value,
        stats: el.querySelector('.exercise-stats-input').value,
        video: el.querySelector('.open-video-modal').dataset.video || '',
        isSuperset: nextIsSuperset, supersetHead: false,
      });
      nextIsSuperset = false;
    }
  });
  // first of each superset group → supersetHead so labels render A, B1, B2, C…
  exercises.forEach((ex, i) => { if (!ex.isSuperset && exercises[i+1]?.isSuperset) ex.supersetHead = true; });

  const prog = programsCache.find(p => p._id === currentProgramId);
  prog.weeks[wIdx].days[String(dayNum)] = { ...existing, name, exercises, isRest: false };
  await apiFetch(`/api/programs/${prog._id}`, { method: 'PUT', body: JSON.stringify(prog) });
};
```

**Gotcha:** Mongoose `Map` serializes with **string keys** — always `week.days?.[String(dayNum)]`.

**Reorder** = serialize → swap → rebuild (DOM moves with inter-item connectors are error-prone):
```js
const arr = serializeBuilder();            // [{name, stats, video, isSuperset}, …]
[arr[i], arr[j]] = [arr[j], arr[i]];
rebuildBuilder(arr);                       // clears #exercise-list and re-adds each
```

---

## 10. Program assignment

**The materializer** — template → dated `ClientWorkout`s, with optional day selection:
```js
const pushProgramToCalendar = async (prog, clientId, startDateStr, opts = {}) => {
  const selectedKeys = opts.selectedKeys || null;     // Set of "wIdx-dayNum" or null = all
  const startDate = new Date(startDateStr + 'T00:00:00');
  let created = 0, anchorOffset = selectedKeys ? null : 0; // default anchors grid day 0

  for (let wIdx = 0; wIdx < prog.weeks.length; wIdx++) {
    for (let dayNum = 1; dayNum <= 7; dayNum++) {
      const globalIndex = wIdx * 7 + (dayNum - 1);
      const day = prog.weeks[wIdx].days?.[String(dayNum)];
      if (selectedKeys && !selectedKeys.has(`${wIdx}-${dayNum}`)) continue;
      if (!day) continue;
      const willPost = (day.isRest && !day.exercises?.length) || day.exercises?.length > 0;
      if (!willPost) continue;

      if (anchorOffset === null) anchorOffset = globalIndex;        // first selected → startDate
      const d = new Date(startDate); d.setDate(startDate.getDate() + (globalIndex - anchorOffset));
      const date = localDateStr(d);
      const res = await apiFetch('/api/client-workouts', { method: 'POST',
        body: JSON.stringify(mapDayToWorkout(day, clientId, date)) });
      if (res.ok) created++;
    }
  }
  return { created };
};
```

**Multi-client assign** (the modal holds a `Set` of ids; confirm loops):
```js
let okCount = 0;
for (const cid of Array.from(selectedClientIds)) {
  await apiFetch(`/api/clients/${cid}`, { method: 'PUT', body: JSON.stringify({ program: prog.name }) });
  await pushProgramToCalendar(prog, cid, startDateStr, { selectedKeys });
  okCount++;
}
showToast(`✓ ${prog.name} asignado a ${okCount} cliente(s).`, 'success');
```

**Single-day assign** warns before clobbering (the POST upserts):
```js
const existing = await (await apiFetch(`/api/client-workouts/${clientId}/${dateStr}`)).json();
if (existing?.exercises?.length && !await showConfirm('Ya hay rutina ese día. ¿Reemplazar?', { danger: true })) return;
await pushSingleDay(dayData, clientId, dateStr, weekIdx, dayNum);
```

**Gotcha:** keep the no-`selectedKeys` path identical to the old behavior (`anchorOffset = 0`) so existing assignment flows don't regress.

---

## 11. Per-client workout editor

`POST /api/client-workouts` upserts; `PATCH` does partial updates and fires notifications **only on transition**:
```js
app.patch('/api/client-workouts/:clientId/:date', authenticateToken, async (req, res) => {
  const before = await ClientWorkout.findOne({ clientId: req.params.clientId, date: req.params.date });
  const after  = await ClientWorkout.findOneAndUpdate(
    { clientId: req.params.clientId, date: req.params.date }, { $set: req.body }, { new: true });
  if (req.user.role === 'client' && !before?.isComplete && after.isComplete)
    await createNotification({ type: 'workout_completed', clientId: after.clientId, /* … */ });
  res.json(after);
});
```

---

## 12. Notifications feed

```js
const NotificationSchema = new mongoose.Schema({
  trainerId: mongoose.Schema.Types.ObjectId,
  type: { type: String, enum: ['workout_completed','workout_missed','weight_update','nutrition_logged',
    'progress_photos','program_assigned','client_created','rpe_submitted','contact_inquiry',
    'muscle_restriction','equipment_updated', /* keep COMPLETE */ ] },
  clientId: mongoose.Schema.Types.ObjectId, clientName: String,
  title: String, message: String, data: mongoose.Schema.Types.Mixed,
  isRead: { type: Boolean, default: false },
}, { timestamps: true });
NotificationSchema.index({ trainerId: 1, isRead: 1, createdAt: -1 });

// Swallows errors so a notification never breaks the user's action.
async function createNotification(n) {
  try { await Notification.create(n); } catch (e) { if (process.env.DEBUG) console.error(e); }
}
```

**Gotcha:** an event type missing from the enum makes `create` throw — and since `createNotification` swallows it, the notification **silently never appears**. Keep the enum complete.

**Paginated GET** (fetch `limit+1` to detect more; filter server-side):
```js
app.get('/api/notifications', authenticateToken, async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);
  const skip  = Math.max(parseInt(req.query.skip) || 0, 0);
  const query = { trainerId: req.user.id };
  if (req.query.filter === 'unread') query.isRead = false;
  else if (req.query.filter === '7days') query.createdAt = { $gte: new Date(Date.now() - 7*864e5) };
  const docs = await Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit + 1);
  const hasMore = docs.length > limit;
  res.json({ notifications: hasMore ? docs.slice(0, limit) : docs, hasMore });
});
```

**Frontend** — "Cargar más" + in-place mark-read (never re-fetch, you'd lose scroll/pages):
```js
window.markNotificationRead = async (id) => {
  await apiFetch(`/api/notifications/${id}/read`, { method: 'PUT' });
  fetchNotificationCount();
  const el = document.querySelector(`[data-notification-id="${id}"]`);
  if (el) { el.classList.add('opacity-50'); el.removeAttribute('onclick'); el.querySelector('.notif-unread-dot')?.remove(); }
};
```
Badge caps at `count > 999 ? '999+' : count`.

---

## 13. Body measurements

```js
const BodyMeasurementSchema = new mongoose.Schema({
  clientId: mongoose.Schema.Types.ObjectId, date: String,
  pecho: Number, biceps: Number, cintura: Number, cadera: Number, quads: Number, calves: Number,
  weight: Number, bodyFat: Number, bmi: Number,
});
```
Trainer-only `POST`; plotted with Chart.js on the client's metrics page.

---

## 14. Payments & invoices

```js
const PaymentSchema = new mongoose.Schema({
  clientId: mongoose.Schema.Types.ObjectId, amount: Number,
  status: { type: String, enum: ['pending','paid','overdue'], default: 'pending' },
  method: String, periodLabel: String, dueDate: Date, paidDate: Date, notes: String,
});

app.patch('/api/payments/:id', authenticateToken, authorizeRoles('trainer','admin'), async (req, res) => {
  if (req.body.status === 'paid' && !req.body.paidDate) req.body.paidDate = new Date();
  if (req.body.status && req.body.status !== 'paid') req.body.paidDate = null;
  res.json(await Payment.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }));
});
```

**Invoice email — deep links from the trainer's saved handles:**
```js
const h = trainer.paymentHandles || {};
const buttons = [
  h.venmo  && `<a href="https://venmo.com/@${h.venmo}?txn=pay&amount=${amt}&note=${period}">Venmo</a>`,
  h.paypal && `<a href="https://paypal.me/${h.paypal}/${amt}">PayPal</a>`,
  h.athMovil && `ATH Móvil Business: busca "${h.athMovil}"`,
].filter(Boolean);
await sendEmail({ to: client.email, subject: `Factura ${period}`, html: invoiceHtml(amt, period, buttons) });
```

---

## 15. Blog

```js
const BlogPostSchema = new mongoose.Schema({
  title: { type: String, required: true }, slug: { type: String, required: true, unique: true },
  category: { type: String, default: 'General' }, excerpt: String,
  content: { type: String, required: true }, published: { type: Boolean, default: false },
  publishedAt: Date,
}, { timestamps: true });
```

**Preserve the original publish date on edit** (the bug we fixed):
```js
app.patch('/api/blog/:id', authenticateToken, authorizeRoles('trainer','admin'), async (req, res) => {
  const existing = await BlogPost.findById(req.params.id);
  const update = { title: req.body.title, category: req.body.category, content: req.body.content,
                   published: !!req.body.published };
  if (req.body.published && !existing.publishedAt) update.publishedAt = new Date(); // ONLY first publish
  res.json(await BlogPost.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }));
});
```

**Safe Markdown subset (client-side):** escape first, then links/bold/italic, then line-based lists. Shield link URLs so emphasis can't mangle them:
```js
function formatBlogContent(s) {
  let html = escHtmlPublic(s);
  const links = [];
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, text, url) => {
    links.push(`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`);
    return `@@LK${links.length - 1}KL@@`;            // sentinel that can't collide with prose
  });
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
             .replace(/\*([^*\n]+)\*/g, '<em>$1</em>').replace(/_([^_\n]+)_/g, '<em>$1</em>');
  html = html.replace(/@@LK(\d+)KL@@/g, (_m, i) => links[+i] != null ? links[+i] : _m);
  // …line pass: group `- `/`•`/`○` into <ul>, `1.` into <ol>…
  return html;
}
```

**Show both dates** (publish + updated when meaningfully later):
```js
let dateStr = pub.toLocaleDateString(lang, opts);
if (upd - pub > 5*60*1000) dateStr += ` · Actualizado ${upd.toLocaleDateString(lang, opts)}`;
```

**Gotchas:** ① `if (published) publishedAt = new Date()` on update wipes the original date — guard on `!existing.publishedAt`. ② Don't use `" L<n> "` as the link sentinel — it collides with "L4/L5" spine references; use `@@LK…KL@@`. ③ Only `http(s)` links linkify (no `javascript:`).

[← Foundation](01-foundation.md) · [Index](README.md) · Next: [Client features →](03-client-features.md)
