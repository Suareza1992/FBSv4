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

### Three refinements worth copying

**Saved meal combos** — a `SavedMeal` collection (`{ clientId, name, mealSlot, foods[] }`) lets a client snapshot a meal and re-log it with one tap. Full CRUD on `/api/saved-meals` (the `PUT` overwrites in place so editing — rename / add / remove items / scale calories — doesn't spawn duplicates). Ownership-checked on every write.

**Additive water** — the oz field is a *"how much did you just drink"* box that **adds to** the day's total, then clears itself; the cups/drops fill by `floor(total / 8oz)` and **live-preview** the would-be total while typing. (Clients won't do the math to "set" a new total — make the common action one number + Enter.)
```js
const addTypedWater = () => { const add = parseInt(input.value); if (add) setWaterOz(waterOz + add); input.value = ''; };
input.addEventListener('input', () => renderWaterCups(waterOz + (parseInt(input.value) || 0))); // preview
```

**Live deficit/surplus** — the macro calculator's goal pills (`maintain` / `cut250` / `cut500` / `bulk250` / `bulk500`) recompute `targetCal` + macro grams. On the client's page, changing a pill must **live-update the page** (calorie goal, the macro inputs, and `recalcTotals()` → remaining calories + bars), with an explicit **"Aplicar metas"** to persist (`PUT /api/me` `{ macroGoals }`). The bug to avoid: updating the calculator's own numbers but forgetting to call `recalcTotals()`, so "Restante" never moves.

### The trainer's side — **Nutrición** (recipe book + shared food library)

The client's diary is only half of nutrition. The trainer gets a section of their own —
`#/nutricion`, its own sidebar entry, two tabs: **Recetas** and **Alimentos**.

```js
const RecipeSchema = new mongoose.Schema({
  trainerId: { type: ObjectId, ref: 'User', required: true },   // private to its trainer
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },                   // why it's worth making — not a method
  image: { type: String, default: '' },                         // Cloudinary URL, '' = branded placeholder
  imagePos: { type: String, default: '50% 50%' },               // CSS object-position for framing
  tags: { type: [String], default: [] }, mealSlot: { type: String, default: '' },
  servings: { type: Number, default: 1, min: 1 },
  ingredients: [{ name: String, amount: Number, unit: String,
                  calories: Number, protein: Number, carbs: Number, fat: Number }],
  isArchived: { type: Boolean, default: false },                // soft delete
}, { timestamps: true });
```

**Round per ingredient, not on the total** — the card and the diary have to agree:
```js
const recipeServingOf = (ing, servings) => {
  const per = Math.max(1, Number(servings) || 1);
  const one = (v) => Math.round(((Number(v) || 0) / per) * 10) / 10;
  return { calories: Math.round((Number(ing?.calories) || 0) / per), protein: one(ing?.protein),
           carbs: one(ing?.carbs), fat: one(ing?.fat),
           amount: Math.round(((Number(ing?.amount) || 0) / per) * 100) / 100 };
};
```
The card promised 195 kcal and the diary recorded 194, because the card summed JS-rounded
ingredients while the server totalled with Mongo's `$round` — which is **banker's rounding**
(194.5 → 194, not 195). Fixed by rounding each ingredient the same way on both sides; the
browser copy of `recipeServingOf` is character-for-character the server's.

**Photos — the add and the remove are the same field.** Upload posts the file to
`POST /api/recipes/image` (Cloudinary, folder `fitbysuarez/recipes`) and the returned URL goes
into the draft; "Quitar foto" sets `image: ''`. So the `PUT` must test for *presence*, never truth:
```js
if (b.image !== undefined) doc.image = String(b.image || '').trim();   // '' MUST clear it
```
`if (b.image)` would make a removal a silent no-op.

**Portrait or landscape.** A phone shoots portrait, and forcing those into a landscape band
crops the plate out of the picture — so the recipe carries its own frame:
```js
imageAspect: { type: String, enum: ['landscape', 'portrait'], default: 'landscape' },
const cleanAspect = (v) => (String(v || '').trim() === 'portrait' ? 'portrait' : 'landscape');
```
The upload route reports the shape it received (`result.height > result.width`) and the editor
preselects it, so the common case needs no decision; two pills override it. One table holds the
frame for all four surfaces, so they can never drift apart:
```js
const RECIPE_FRAME = {
  trainerCard: { landscape: 'aspect-[16/10]', portrait: 'aspect-[4/5]' },
  clientCard:  { landscape: 'aspect-[16/10]', portrait: 'aspect-[4/5]' },
  detail:      { landscape: 'aspect-[16/10]', portrait: 'aspect-[4/5]' },
  editor:      { landscape: 'aspect-[16/10] max-w-lg', portrait: 'aspect-[4/5] max-w-[16rem]' },
};
```
**These are ratios, not heights, and that is the whole point.** The first cut used fixed heights
(`h-72` for portrait) and a "vertical" photo in the 3xl editor modal still came out wider than it
was tall — a taller letterbox is still a letterbox. A frame only reads as portrait if the frame
itself is taller than it is wide, so portrait is `4/5`, the Instagram crop. On a wide surface the
ratio alone would blow the frame up, so the editor also caps its width; both of its frames land
around 320px tall and the form keeps its shape whichever pill is lit. Because the editor's frame
is two classes now, `setRecipeAspect` swaps whole sets:
```js
drop.classList.remove(...RECIPE_FRAME.editor.landscape.split(' '), ...RECIPE_FRAME.editor.portrait.split(' '));
drop.classList.add(...RECIPE_FRAME.editor[a].split(' '));
```
Cards carry `self-start` so one tall card cannot stretch the short ones beside it, and the enum
defaults rather than validates, so a recipe written before the field reads as landscape instead
of failing to save.

**Two different defaults, deliberately.** A *new* recipe opens on portrait — these photos are
shot on a phone, so vertical is the common case — but the schema default and `recipeAspect`'s
fallback stay landscape. That split is what keeps the recipes written before the field existed
looking the way they always did: a document with no `imageAspect` is still read as landscape, so
flipping the editor's default reframes nothing that is already saved. Changing the *schema*
default would, because Mongoose fills a missing path on hydration.

**The shared food library (Alimentos)** — `upsertSharedFood(food, isAdmin)`: **adding is open to
everyone, changing is superadmin-only.** A client logging a food that already exists just bumps
`timesUsed`; only the owner's account may rewrite another person's macros.
```js
if (existing && !isAdmin) {                       // not an edit — just a use
  await FoodLibrary.updateOne({ _id: existing._id }, { $inc: { timesUsed: 1 } });
  return { ok: true, created: false, changed: false, counted: true, id: existing._id };
}
```
A food with no `servingAmount` is read as *per 100 g*, which is wrong for anything sold by the
unit — hence the **"Sin porción"** filter, which lists exactly the entries still missing one.

**Gotchas:** ① Mongo `$round` is banker's rounding and `Math.round` is not — round per ingredient
on both sides or the card and the diary will disagree by 1 kcal. ② A falsy check on `image`
makes "remove photo" do nothing; test `!== undefined`. ③ **Both dashboards label the sidebar link
"Nutrición"** — the click handler matched the client branch first and sent the trainer to the
client's read-only page. Dispatch on the session, the way `Inicio` already does:
```js
else if (linkText.includes('Nutrición')) {
  const session = loadSession();
  moduleToLoad = (session?.role === 'client') ? 'client_nutricion' : 'nutricion_content';
}
```
④ Tailwind only ships classes it can see as literals — the frame table spells `aspect-[4/5]` and
`max-w-[16rem]` out in full for that reason, and new ones need `npm run build:css`. `hidden` is
emitted after `block`, so `class="hidden block mx-auto"` on the *Quitar foto* button still hides. ⑤ A new SPA module needs **four** registrations — `MODULE_TITLES`, `TRAINER_MODULES`,
server-side `SPA_PARTIALS`, and whatever `scripts/check-routes.mjs` asserts; the catch-all route
returns **200 for any unknown path**, so a status check can never prove a partial is deployed.

**The client only reads it.** `client_nutricion` renders the same book with no editor and one
button that matters — *"Añadir a mi diario"* — which posts the per-serving ingredients through the
same atomic `POST /api/nutrition-logs/food` append every other food uses, so the day's totals are
recomputed server-side.

---

### Meal Prep — the plan, as opposed to the book

Recetas is a book to browse; **Meal Prep** is the plan to follow. A plan is weeks, a week is its own
targets plus **two preparations** that hit the same numbers — so the week can be cooked in two batches
instead of the same plate seven nights running.

The plates are prose, not ingredient rows, and that is the point: the client reads a plate and cooks
it. The week's targets are informational — counting happens in the diary, where they log what they
actually ate.

```js
MealPlan            // trainerId, name, weeks[{ objective, calories, protein, carbs, fat,
                    //   deficit, options[{ key, label, meals[{ slot, text, alternatives[] }] }] }]
MealPlanAssignment  // planId, clientId (unique), trainerId, startDate, option, swaps[{ week, slot, text }]
```

**The plan belongs to the trainer; what a client changed belongs to the assignment.** Two clients on
one plan can swap different dinners and neither sees the other's. `clientId` is unique, so assigning
a client takes them off whatever they were on.

**The week is counted, not set** — `mealPlanWeekFor(startDate, weekCount)` is
`floor(daysSince / 7) + 1`, clamped at both ends. A plan that needs someone to remember to advance it
stops advancing in week three. Before the start date the client sees week 1; past the last week they
hold on the last week instead of falling off into a blank page.

**Swapping** offers the same slot from every other prep that week, plus the trainer's own
alternatives — so a plan with no alternatives still answers *"not this tonight"*. A swap stores the
final text keyed by `(week, slot)`, which is why it survives flipping between preps, and sending the
plan's own text back deletes the row rather than storing a copy of it.

`public/meal-plan-template.js` holds a ready 8-week progressive plan that **Usar plantilla** loads
into the editor; it is a starting point, every line editable before saving. Prose in its own file,
not buried in `app.js`.

**Gotchas:** ① `$setOnInsert` on the roster is what keeps an existing client's start date and swaps
when the roster is re-saved to add somebody else. ② Incoming client ids are intersected with the
trainer's own clients before anything is written. ③ Collapsing or removing a week in the editor must
read the form into the draft first, or the re-render wipes what was typed into the open week. ④ A
week with no preps is dropped rather than stored empty.

Full reasoning in [TECHNICAL.md § 56](../TECHNICAL.md).

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
