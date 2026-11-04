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

**A client does not get a plan, they are given one.** Until their trainer has prepared it, the whole
of this screen is a single button — *"Solicítale las recomendaciones nutricionales a tu
entrenador."* — which raises a `meal_plan_requested` notification and then spends itself. Three
states: no row at all, a row with `status: 'requested'` and `planId: null`, and a prepared row.
`GET /api/my-meal-plan` sends **nothing of any plan** in the first two; the gate is in the response,
not in the rendering. Asking twice is accepted and notifies once.

A plate is a short list of **elements**, each a food, an amount and a **role** — `protein | carb |
fat | veg | free`. The role is the mechanism: it decides what an element can be swapped for, and
which of the week's targets its amount scales against.

```js
MealPlan            // trainerId, name, weeks[{ objective, calories, protein, carbs, fat, deficit,
                    //   options[{ key, label, meals[{ slot, text,
                    //     items[{ name, amount, unit, role, alternatives[{ name, amount, unit, role }] }] }] }] }]
MealPlanAssignment  // planId (null until prepared), clientId (unique), trainerId, startDate, option,
                    //   status: 'requested' | 'ready', requestedAt, preparedAt,
                    //   goals{ calories, protein, carbs, fat }, evalDate,
                    //   amounts[{ week, option, slot, name, amount }],
                    //   swaps[{ week, slot, from, text, amount, unit, role }]
```

`meals[].text` is derived — the server rebuilds the plate's sentence from the elements on save. A
plan written before elements existed has only its text and still renders, with one swap for the
whole plate.

**Elements still carry no macros.** `public/meal-item.js` scales amounts from the week's targets and
the goals on the assignment: protein elements by `goal.protein / week.protein`, carbs and fat by
theirs, **vegetables and free items never**. Clamped to [0.5, 2], 1 when a goal or a target is
missing. The four tiles on top switch to the client's goals whenever the amounts are theirs. There
is no "as written" toggle any more: what the client sees *is* the plan as their trainer wrote it for
them.

**The goals are frozen onto the assignment** at preparation time, copied from the client's
`macroSettings` — the numbers the macro calculator already produced from their latest evaluation.
`mealGoalsFor()` falls back to live `macroSettings` only when the assignment has none, which is what
a plan assigned before preparation existed still does. Frozen because a weigh-in on Tuesday must not
silently rewrite Wednesday's dinner; the trainer's panel points out that a newer evaluation landed
and leaves the decision to them.

**Amounts are the personalisation.** `amounts[{ week, option, slot, name, amount }]` is the trainer
overruling the arithmetic one element at a time, addressed by `overrideKey(week, option, slot, name)`
— the same shape a swap uses, lower-cased and trimmed. A tuned amount is filed under the *plan's*
food, so swapping that element out leaves it behind. Typing the computed number back, or clearing
the box, deletes the entry. A tuned amount is displayed **as typed** (`amountLabel(item, true)`),
unrounded: a number a coach chose is already measurable.

**The plan belongs to the trainer; what a client changed belongs to the assignment.** Two clients on
one plan can swap different dinners and neither sees the other's. `clientId` is unique, so assigning
a client takes them off whatever they were on.

**Two ways in.** `PUT /api/meal-plan-prep/:clientId` is one client with their own frozen goals and
amounts, and is the only route that can turn a request into a readable plan; `DELETE` on the same
path removes the row entirely and puts the client back to the button. Moving a client to a
*different* plan drops their swaps, because those name foods that are not on the new plates.
**Asignar en grupo** (`PUT /api/meal-plans/:id/assignments`) is still there as the fast path: ready,
but with no frozen goals, so those clients scale against their live macros until somebody prepares
them.

**The week is counted, not set** — `mealPlanWeekFor(startDate, weekCount)` is
`floor(daysSince / 7) + 1`, clamped at both ends. A plan that needs someone to remember to advance it
stops advancing in week three. Before the start date the client sees week 1; past the last week they
hold on the last week instead of falling off into a blank page.

**Swapping** is per element. The sheet offers the same role in the same slot — the plan's own
element, its alternatives, then every other prep's element of that role — all at this client's
amounts. A swap is keyed by `(week, slot, from)`, where `from` is the **name** of the element it
replaces, so two changes to one plate coexist and a change follows its food through both preps.
Sending an empty text deletes the row rather than storing a copy of the plan. An empty `from` is a
whole-plate swap, which is how pre-element plans still work.

`public/meal-plan-template.js` holds a ready 8-week progressive plan — 202 elements with 309
alternatives already written — that **Usar plantilla** loads into the editor; every line is editable
before saving. Prose in its own file, not buried in `app.js`.

**Gotchas:** ① `$setOnInsert` on the roster is what keeps an existing client's start date and swaps
when the roster is re-saved to add somebody else. ② Incoming client ids are intersected with the
trainer's own clients before anything is written. ③ Collapsing or removing a week in the editor must
read the form into the draft first, or the re-render wipes what was typed into the open week. ④ A
week with no preps is dropped rather than stored empty. ⑤ **Anything `amountLabel` prints,
`parseLine` has to read** — the editor writes an element as one line and parses it back, so a glyph
that only goes one way turns the amount into part of the food's name on the next save. The glyphs
are a closed set and `scripts/test-meal-items.mjs` runs the whole template through the round trip.
⑥ A plate's *"N cambios"* counts only swaps that land on an element in the prep being shown.
⑦ `meal_plan_requested` must be in `NotificationSchema`'s enum — that enum is strict, and a missing
type makes `Notification.create()` throw a `ValidationError` that `createNotification()` swallows, so
you get no notification and no error. ⑧ The preparation sheet renders one week at a time, so the
open week is the only week in the DOM: overrides live in a `Map` kept current by the `input`
handler, never read off the inputs at save time. ⑨ A pending request has `planId: null` and is
therefore not counted as a client on any plan.

Full reasoning in [TECHNICAL.md § 56](../TECHNICAL.md).

---

### Seco o cocido — how a food was weighed

A cup of rice is ~205 g dry and ~160 g cooked, and the dry cup carries about **three times** the
carbohydrate. So every food carries a state: `'seco' | 'cocido' | 'na' | ''`, on `FoodLibrary`,
`PersonalFoodLibrary`, `Recipe.ingredients[]`, meal-plan `items[]` and their `alternatives[]`, and
meal-plan `swaps[]`. The vocabulary is `public/food-state.js`, mirrored on the phone as
`lib/foodState.ts`; both read `scripts/food-state-cases.json`, so they cannot drift.

**`''` is not `'na'`.** `'na'` is somebody saying the question is meaningless for this food; `''` is
nobody having answered. Both render no chip, but only `''` is asked about and only `''` appears in
the **Sin seco/cocido** filter in Alimentos.

**The app never converts.** Dry↔cooked yield ratios would be nutrition data we have no source for,
and the house rule is that numbers come from the food database. This only removes the guesswork about
which of two numbers you are reading.

**And it does not have to, because the food comes in both.** Fourteen animal proteins are **two rows**
in the curated database, raw and cooked, each with its own macros from USDA FoodData Central (the
`// fdc NNNNNN` beside each number is the row it came from). A client who weighs raw picks
*Pechuga de pollo (cruda)* — 120 kcal/100 g — and a client who weighs cooked picks *(cocida)* — 165.
Both halves answer the bare search word, so `pollo` and `chicken` bring up the pair and the client
chooses; only `pollo crudo` / `raw chicken` narrows it. The paired cuts: chicken breast, thigh and
ground chicken; ground beef 80/20 and 90/10; sirloin; pork chop and tenderloin; turkey breast and
ground turkey; salmon, tilapia, cod, shrimp and bacon.

**A row may answer explicitly when its name cannot.** `localFoodWithState` is
`f.state || FoodState.fromName(f.name)`, so a curated row can carry `state: 'na'` — canned tuna and
deli ham are neither raw nor cooked, and without it the app would ask about them forever. All **361**
curated foods now have an answer: prepared dishes are `'cocido'`, raw starches (papa, batata,
plátano, hongos) are `'seco'`, and produce where the answer does not move the numbers is `'na'`.

**It is asked wherever a food's numbers are entered** — the shared library row (with a blocking
dialog on save when `shouldAsk`), the diary's Añadir alimento, recipe ingredient rows, and meal-plan
element lines. `matters(name)` keeps the question off foods that have no answer; it is anchored at a
word boundary because the first version matched `'res'` inside "f**res**as". Cancelling the dialog
**abandons the save** — nothing is assumed from a refusal to answer.

**The state travels with the food.** Picked from the library it is inherited and never asked again;
read off the name (`fromName`) only as a pre-selection a human is looking at.

**The shared library learns but cannot be overwritten:** a client logging a food may fill a state
nobody has given (the response says `filledState`), and can never change one that is there — the same
rule its macros already follow.

**Gotchas:** ① The state must never enter `itemText`/`parseLine` — the plan editor writes an element
as one line and reads it back, so "arroz (cocido)" would become the food's *name* on the next save.
② The diary preview repaints on every keystroke in the amount box, so the picker is rebuilt only when
the food changes. ③ A template line's alternatives inherit its state unless their own name says
otherwise. ④ A swapped-in element carries its own state, not the one it replaced. ⑤ Tapping the
chosen option again clears it.

Full reasoning in [TECHNICAL.md § 57](../TECHNICAL.md).

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
