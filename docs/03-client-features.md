# Part 3 — Client features

[← Trainer features](02-trainer-features.md) · [Index](README.md) · Next: [Integrations →](04-integrations.md)

---

## 16. Workout view & logging

The client reads today's `ClientWorkout` and toggles state; each action `PATCH`es:
```js
const markComplete = async () => {
  await apiFetch(`/api/client-workouts/${clientId}/${getTodayStr()}`, {
    method: 'PATCH', body: JSON.stringify({ isComplete: true, isMissed: false }),
  });
  renderWorkout();
};
const submitRpe = (rpe) => apiFetch(`/api/client-workouts/${clientId}/${getTodayStr()}`,
  { method: 'PATCH', body: JSON.stringify({ rpe }) }); // 1–10
```
History = `GET /api/client-workouts/:clientId` grouped by week.

**Gotcha:** "today" must be local, not UTC, or a late-night log lands on the wrong day:
```js
const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const getTodayStr = () => localDateStr(new Date());
```

---

## 17. Nutrition tracker

```js
const NutritionLogSchema = new mongoose.Schema({
  clientId: mongoose.Schema.Types.ObjectId, date: String,
  calories: Number, protein: Number, carbs: Number, fat: Number, water: Number,
  mood: String, notes: String, meals: mongoose.Schema.Types.Mixed,
  exercise: [{ name: String, calories: Number }], exerciseCalories: Number,
}, { timestamps: true });
NutritionLogSchema.index({ clientId: 1, date: 1 }, { unique: true });
```

**Calorie budget** — extra exercise widens the ring; macro grams stay fixed:
```js
const burnedCal = exerciseData.reduce((s, e) => s + (parseFloat(e.calories) || 0), 0);
const derivedCalGoal = baseCalGoal + burnedCal;          // calorie ring uses this
goalEl.textContent = burnedCal > 0 ? `${baseCalGoal} +${Math.round(burnedCal)}🔥` : baseCalGoal;
const ringPct = Math.min(1, totalCal / derivedCalGoal);  // protein/carb/fat goals NOT scaled
```

**Water bottle** — an SVG that *empties* (not fills) as water is logged:
```js
const remainingPct = Math.max(0, 1 - consumed / goal);
bottleLiquid.style.transformOrigin = 'bottom';
bottleLiquid.style.transform = `scaleY(${remainingPct})`; // drains downward
```

**Food search** — local DB first, then external APIs (details in [Part 4 §22](04-integrations.md#22-food-data-apis)). Manual entry requires a unit.

---

## 18. Progress photos

```js
const ProgressPhotoSchema = new mongoose.Schema({
  clientId: mongoose.Schema.Types.ObjectId,
  category: { type: String, enum: ['front','back','side','general'] },
  url: String, date: String,
}, { timestamps: true });

app.post('/api/progress-photos', authenticateToken, async (req, res) => {
  const upload = await cloudinary.uploader.upload(req.body.image, { folder: 'fbs/progress' });
  const photo = await ProgressPhoto.create({ clientId: req.user.id, category: req.body.category, url: upload.secure_url });
  if (req.user.role === 'client') await createNotification({ type: 'progress_photos', clientId: req.user.id, /* … */ });
  res.json(photo);
});
```
Store the Cloudinary URL, not the base64. Cap list queries at 50.

---

## 19. Body metrics & charts

`WeightLog` upserts by day; render with Chart.js:
```js
const WeightLogSchema = new mongoose.Schema({
  clientId: mongoose.Schema.Types.ObjectId, date: String, weight: Number, bodyFat: Number, notes: String,
}, { timestamps: true });
WeightLogSchema.index({ clientId: 1, date: 1 }, { unique: true });
```
```js
new Chart(ctx, { type: 'line',
  data: { labels: logs.map(l => l.date), datasets: [{ label: 'Peso', data: logs.map(l => l.weight) }] },
  options: { scales: { y: { beginAtZero: false } } } });
```

---

## 20. Equipment inventory

```js
// stored on the client User as the Mixed `equipment` field:
// { unit:'kg'|'lbs', dumbbells:[], plates:[], kettlebells:[], cables:[],
//   stations:{barra,banco,prensa,squat}, other:{bands,trx,mat,pullup,treadmill,bike,row,box} }

app.put('/api/equipment', authenticateToken, async (req, res) => {
  const user = await User.findByIdAndUpdate(req.user.id, { $set: { equipment: req.body } }, { new: true });
  if (req.user.role === 'client') {
    // throttle: skip if an equipment_updated notice already exists in the last 2 hours
    const recent = await Notification.findOne({ clientId: user._id, type: 'equipment_updated',
      createdAt: { $gte: new Date(Date.now() - 2*60*60*1000) } });
    if (!recent) await createNotification({ type: 'equipment_updated', clientId: user._id, clientName: user.name, title: 'actualizó su equipo' });
  }
  res.json(user.equipment);
});
```
The trainer gets a read-only "Equipo" tab rendering this, plus the `equipmentCheckOn` toggle that gates the dormant AI check ([Part 4 §23](04-integrations.md#23-ai-features-anthropic)).

[← Trainer features](02-trainer-features.md) · [Index](README.md) · Next: [Integrations →](04-integrations.md)
