# FitBySuarez — Technical Reference

**Stack:** Node.js + Express, MongoDB (Mongoose), vanilla JS SPA, Tailwind CSS (CDN), Chart.js, nodemailer, bcryptjs, jsonwebtoken.

All schemas live in `server.js`. All client logic lives in `public/app.js`. Each module's HTML is a standalone fragment file under `public/` that gets fetched at runtime and injected into the SPA shell.

---

## 1. Authentication & Invite System

### User perspective
Trainer creates client accounts; clients receive a one-time invite link by email and set their own password on first visit. Returning users log in with email/password. Forgotten passwords trigger a one-hour reset link.

### Database schema — `UserSchema` (model: `User`)

| Field | Type | Notes |
|---|---|---|
| `name` | String (required) | |
| `lastName` | String | default `""` |
| `email` | String (required, unique) | |
| `password` | String (required) | bcrypt hash, cost 10 |
| `role` | String | `'client'` or `'trainer'` |
| `isFirstLogin` | Boolean | default `true`; cleared after first password change |
| `isDeleted` | Boolean | soft-delete flag |
| `inviteToken` | String | SHA-256 hash of the raw token |
| `inviteExpires` | Date | `Date.now + 7 days` |
| `resetPasswordToken` | String | SHA-256 hash of raw reset token |
| `resetPasswordExpires` | Date | `Date.now + 1 hour` |
| `profilePicture` | String | base64 data URL, stored directly in document |
| `thr`, `mahr` | Number | Target Heart Rate / Max HR, set by trainer only |
| `emailPreferences` | Object | `{ dailyRoutine: Boolean, incompleteRoutine: Boolean }` |
| `paymentHandles` | Object | `{ athMovil, venmo, paypal }` — trainer only |
| `macroSettings` | Object | `{ goal, proteinRatio, fatRatio, carbRatio, goalProtein, goalCarbs, goalFat }` |
| `equipment` | Mixed | arbitrary key-value equipment map |
| `timezone` | String | IANA tz string, default `'America/Puerto_Rico'` |
| `unitSystem` | String | `'imperial'` or `'metric'` |
| `servingUnit` | String | `'g'` or `'oz'` — food serving display preference |
| `height` | Object | `{ feet: Number, inches: Number }` |
| `weight` | Number | lbs or kg depending on `unitSystem` |
| `birthday`, `gender`, `phone`, `location` | String | optional profile fields |
| `program`, `group`, `type`, `dueDate` | String | trainer-managed client metadata |
| `hideFromDashboard` | Boolean | hides client from trainer's home dashboard |
| `createdAt` | Date | |

No extra indexes beyond the `email` unique index.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | none | Validates bcrypt, returns 7-day JWT + user object |
| `POST` | `/api/auth/register` | none | Always returns `403` — self-registration disabled |
| `POST` | `/api/auth/forgot-password` | none | Generates 32-byte token, hashes it, stores hash, emails raw token link |
| `POST` | `/api/auth/reset-password` | none | Re-hashes incoming token, compares to stored hash, bcrypt-saves new password |
| `GET` | `/api/auth/invite-info` | none | Validates hashed invite token, returns `{ name, email }` for pre-fill |
| `POST` | `/api/auth/accept-invite` | none | Validates token, bcrypt-saves chosen password, returns JWT for auto-login |
| `POST` | `/api/auth/update-password` | `authenticateToken` | Changes password for the currently-logged-in user using `req.user.id` from JWT |
| `POST` | `/api/send-welcome` | `authenticateToken`, trainer/admin | Sends legacy welcome email with temp password (older flow, pre-invite) |

**Invite token flow in detail:** Raw 32-byte hex token is emailed as `?invite=<raw>`. The stored field holds `sha256(raw)`. On acceptance, server re-hashes the URL token and compares. The plaintext token never touches the database.

**Seeding:** On startup, `seedAdmin()` creates `fitbysuarez@gmail.com` as `role: 'trainer'` if it doesn't exist, using `process.env.ADMIN_SEED_PASSWORD`. It also seeds the default `"General"` group.

### Frontend flow

**`handleLogin(e)`** (`app.js:994`) — POSTs to `/api/auth/login`, stores `data.token` in `localStorage.auth_token` and serialized user object in `localStorage.auth_user`, then calls `router(userSession)`.

**`checkInviteToken()`** (`app.js:1162`) — On page load, checks for `?invite=` in the URL. If present, calls `GET /api/auth/invite-info` to pre-fill the setup card, then shows `setup-account-card`.

**`handleAcceptInvite(e)`** (`app.js:1190`) — POSTs token + chosen password to `/api/auth/accept-invite`. On success, stores the returned JWT and user in `localStorage`, cleans the URL with `history.replaceState`, and redirects to the appropriate dashboard after 1.5 seconds.

**`handleForgotPassword(e)`** / **`handleResetPassword(e)`** — straightforward form submits to the public password endpoints.

**`showCard(cardId)`** (`app.js:1141`) — toggles between `login-card`, `forgot-password-card`, `reset-password-card`, and `setup-account-card` by adding/removing `hidden`.

**First-login modal** (`app.js:922`) — if `user.isFirstLogin === true` for a client after login, a full-screen modal is injected into `document.body` forcing password change before any navigation works.

**`getToken()`** — `() => localStorage.getItem('auth_token')`. JWT is attached to every `apiFetch` call as `Authorization: Bearer <token>`. A `401` response triggers `localStorage.removeItem` + `location.reload()`.

### Key design decisions
- Tokens are stored in `localStorage` rather than `httpOnly` cookies. This is simpler for an SPA but means XSS could steal the token.
- Invite and reset tokens are both hashed with SHA-256 before storage, meaning the server never stores the raw secret — a database breach does not expose working tokens.
- Public registration is permanently disabled (`POST /api/auth/register` returns `403`); all accounts are trainer-provisioned.

### Known limitations
- `profilePicture` is stored as a base64 string inside the User document. Large images will bloat MongoDB document size (max 16 MB per document). Consider migrating to an object store (S3, Cloudinary) and storing only a URL.
- JWT expiry is 7 days with no refresh mechanism. A user whose token expires mid-session is forced to re-login without warning beyond the auto-reload.
- `isFirstLogin` check for clients also triggers on old invite-token accounts that were never fully set up (edge case).

---

## 2. Client Management

### User perspective
The trainer sees a searchable/filterable table of all clients. They can add a client (which triggers an invite email), edit profile fields (program, group, payment due date, physical stats, equipment), and soft-delete clients.

### Database schema
Uses the same `User` document described in section 1. Relevant trainer-managed fields: `program`, `group`, `type`, `dueDate`, `isActive`, `isDeleted`, `hideFromDashboard`, `height`, `weight`, `birthday`, `gender`, `phone`, `location`, `timezone`, `unitSystem`, `emailPreferences`, `thr`, `mahr`, `equipment`.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/clients` | trainer | Returns all `role:'client'` where `isDeleted != true`, sorted by `createdAt -1` |
| `POST` | `/api/clients` | trainer | Creates client + invite token; sends invite email; fires `client_created` notification |
| `PUT` | `/api/clients/:id` | trainer | Full document update; fires `program_assigned` notification on program change |
| `POST` | `/api/clients/:id/resend-invite` | trainer | Regenerates a fresh 7-day invite token and re-sends email |
| `DELETE` | `/api/clients/:id` | trainer | Soft-delete: sets `isDeleted: true` |
| `GET` | `/api/me` | any authenticated | Returns the logged-in user's own profile (strips password fields) |
| `PUT` | `/api/me` | any authenticated | Updates own safe fields; trainer can also update `paymentHandles` |
| `GET` | `/api/equipment` | any authenticated | Returns `req.user.equipment` |
| `PUT` | `/api/equipment` | any authenticated | Saves equipment map for the logged-in user |

### Frontend flow

**`fetchClientsFromDB()`** (`app.js:175`) — called during `loadData()`, populates `mockClientsDb` (module-level array). After fetch, calls `window.renderClientsTable()` if it exists.

**`window.renderClientsTable()`** (`app.js:3115`) — iterates `mockClientsDb`, renders an HTML table row per client with name, program, group, type, due date, and action buttons. Exposed on `window` so it can be called from within the clientes module after it loads.

**`window.openClientProfile(clientId)`** (`app.js:1431`) — looks up the client in `mockClientsDb` (loose `==` comparison to handle string/ObjectId mismatch), calls `updateContent()` with the full calendar/tab layout, and triggers `loadClientWorkoutsToCalendar(clientId)`.

**`window.deleteClient(id)`** (`app.js:2831`) — calls `showConfirm()`, then `DELETE /api/clients/:id`. On success, splices client from `mockClientsDb` and calls `renderClientsTable()`.

**`showInviteResultModal(savedClient, email, sendInvite)`** (`app.js:2850`) — displayed after `POST /api/clients` succeeds; shows the invite link (copyable) and email delivery status.

**`populateTimezones()`** (`app.js:1307`) — builds grouped `<optgroup>` elements for a timezone `<select>` covering all Americas and Europe.

**`renderGroupOptions()`** (`app.js:1399`) — fills the group `<select>` from `mockGroupsDb`.

**`renderProgramOptions(selectedValue)`** (`app.js:1412`) — fills the program `<select>` from `mockProgramsDb`, pre-selecting `selectedValue` when editing.

### Key design decisions
- `mockClientsDb` is a client-side cache. All mutations (add/edit/delete) go to the API first; on success the local array is updated and the table re-rendered. This avoids a full re-fetch on every change.
- Loose `==` comparison in `openClientProfile` is intentional: MongoDB `_id` is an object when returned by Mongoose but sometimes a string in cached data.
- Soft-delete keeps historical data (workout logs, nutrition logs, etc.) intact.

### Known limitations
- No pagination on the clients table. Large rosters (>500 clients) will cause sluggish renders.
- `mockClientsDb` is not re-synced if another trainer session modifies data concurrently.
- Equipment is stored as a schemaless `Mixed` field — no enforced structure or enum for equipment types.

---

## 3. Workout Calendar & Program Builder

### User perspective
The trainer views a continuous infinite-scroll calendar for each client. They can add workouts (or rest days) to any date, edit exercises, copy/paste single days or multi-day ranges, and apply saved programs to a client's calendar. Clients see their own calendar and can mark workouts complete, missed, or submit an RPE rating.

### Database schemas

**`ClientWorkoutSchema`** (model: `ClientWorkout`)

| Field | Type | Notes |
|---|---|---|
| `clientId` | ObjectId (ref: User, required) | |
| `date` | String (required) | `YYYY-MM-DD` |
| `title` | String | default `"Workout"` |
| `isRest` | Boolean | true for rest/active-rest days |
| `restType` | String | `'rest'` or `'active_rest'` |
| `warmup` | String | text instructions |
| `warmupVideoUrl` | String | YouTube/Vimeo URL |
| `cooldown` | String | text instructions |
| `exercises` | Array | `{ id: Number, name, instructions, videoUrl, isSuperset: Boolean }` |
| `rpe` | Number (1–10) | Rate of Perceived Exertion, submitted by client |
| `isComplete` | Boolean | |
| `isMissed` | Boolean | |
| `createdAt`, `updatedAt` | Date | |

Index: `{ clientId: 1, date: 1 }` unique — one workout document per client per day.

**`ProgramSchema`** (model: `Program`)

| Field | Type | Notes |
|---|---|---|
| `name` | String (required) | |
| `description` | String | |
| `tags` | String | default `"General"` (freeform label) |
| `weeks` | Array | `[{ weekNumber: Number, days: Map<String, Mixed> }]` |
| `clientCount` | Number | informational, not auto-updated |
| `createdBy` | String | default `"trainer"` |
| `createdAt`, `updatedAt` | Date | |

`weeks[].days` is a Mongoose `Map` of `Mixed`. Keys are day identifiers (e.g. `"1"`, `"2"`), values are day objects with exercises, warmup, cooldown, etc. `program.markModified('weeks')` must be called before `save()` because Mongoose cannot auto-detect deep changes inside `Map<Mixed>`.

**`WorkoutLogSchema`** (model: `WorkoutLog`) — legacy per-exercise completion log

| Field | Type | Notes |
|---|---|---|
| `clientId` | ObjectId | |
| `date` | String | |
| `programName` | String | |
| `exercises` | Array | `{ name, completed: Boolean, notes }` |
| `isComplete` | Boolean | |

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/client-workouts/:clientId` | any | All workouts for client, sorted `date: 1` |
| `GET` | `/api/client-workouts/:clientId/:date` | any | Single workout for a specific date |
| `POST` | `/api/client-workouts` | any | Upsert workout (findOneAndUpdate on `{clientId, date}`); fires `workout_completed` notification if caller is a client |
| `PATCH` | `/api/client-workouts/:clientId/:date` | any | Partial update (`$set`); fires `rpe_submitted`, `workout_completed`, or `workout_missed` notifications on state transitions |
| `DELETE` | `/api/client-workouts/:clientId/:date` | trainer | Deletes a workout day |
| `GET` | `/api/programs` | any | All programs, sorted `createdAt: -1` |
| `POST` | `/api/programs` | trainer | Creates new program |
| `PUT` | `/api/programs/:id` | trainer | Full program update; must call `markModified('weeks')` |
| `DELETE` | `/api/programs/:id` | trainer | Deletes program |
| `POST` | `/api/log` | any | Legacy workout log upsert (exercise-level completion) |
| `GET` | `/api/log/:clientId` | any | All legacy workout logs for client |

Notification transitions use a "read before write" pattern: the PATCH handler fetches the document's `isComplete` and `isMissed` values before applying the update, so notifications only fire on a real state change (not on re-sends of the same state).

### Frontend flow

**`generateContinuousCalendar(client)`** (`app.js:4760`) — called by `openClientProfile`. Renders a year-long (or more) grid of day cells as static HTML. Each cell has `id="day-YYYY-MM-DD"` and a `.content-area` div that workout cards are injected into.

**`loadClientWorkoutsToCalendar(clientId)`** (`app.js:1569`) — fetches `GET /api/client-workouts/:clientId`, then for each workout finds the matching `#day-YYYY-MM-DD` cell and injects either a rest badge or a collapsible workout card. Stores workouts in `window._calendarWorkouts` keyed by date string.

**`openWorkoutEditor(dateStr)`** (`app.js:4989`) — opens the orange slide-in editor panel. Fetches existing workout for that date, populates `editorExercises`, `editorWarmup`, `editorWarmupVideoUrl`, `editorCooldown`, `editorWorkoutTitle`, `editorIsComplete`, `editorIsMissed`. Starts `editorAutosaveInterval` (debounced periodic save).

**Editor state variables** (module-level in `app.js`):
- `editorExercises: []` — current list of exercises in the editor
- `editorDateStr: ""` — date currently being edited
- `editorWarmup: ""`, `editorWarmupVideoUrl: ""`, `editorCooldown: ""`
- `editorWorkoutTitle: ""`
- `editorIsDirty: boolean` — dirty flag to suppress unnecessary saves
- `editorAutosaveInterval` — `setInterval` handle for autosave
- `editorIsComplete: boolean`, `editorIsMissed: boolean`
- `currentEditorExId` — exercise index being edited for video/history
- `copiedWorkoutData` — single-day copy/paste buffer
- `copiedMultiDayData` — multi-day copy buffer with relative date offsets
- `selectedCopyDays: Set` — days selected via checkbox for multi-day copy

**Copy/paste:** Single day copy stores the serialized workout object. Multi-day copy collects all checked days, computes relative offsets from the earliest selected date, and on paste shifts all workouts by `(targetDate - anchorDate)` days.

**`applyProgramToCalendar`** — takes a selected program from `mockProgramsDb`, iterates its weeks/days structure, and POSTs/PATCHes each day to the API starting from a trainer-chosen start date.

**Program builder** (`programas_content.html`) — separate module loaded into `mainContentArea`. The builder mutates `currentProgramId` and `mockProgramsDb[idx]`. On save it calls `PUT /api/programs/:id` with the full weeks array.

### Key design decisions
- `ClientWorkout` uses a `{ clientId, date }` unique index. Upserting with `findOneAndUpdate + upsert: true` means the trainer can overwrite a day without checking existence first.
- Programs store days as `Map<String, Mixed>` to allow arbitrary day numbering without enforcing a fixed 7-day week.
- The calendar is pre-rendered as static HTML; workouts are overlaid after a separate async fetch. This gives instant visual structure while data loads.
- Autosave in the editor uses a dirty flag (`editorIsDirty`) to avoid unnecessary API calls on every keystroke.

### Known limitations
- `WorkoutLog` (the legacy per-exercise log) and `ClientWorkout` are two parallel models with overlapping purposes. The newer `ClientWorkout` model supersedes `WorkoutLog` but both exist.
- No server-side validation that `exercises[].videoUrl` is a real YouTube/Vimeo URL.
- The program `clientCount` field is never auto-updated when a program is assigned or unassigned.
- Calendar is generated for a fixed date range client-side; very old or future dates outside that range won't have day cells.

---

## 4. Exercise Library

### User perspective
The trainer manages a shared library of exercises with video URLs, categories (muscle groups), and instructions. All authenticated users can search the library; only the trainer can create or update exercises.

### Database schema — `ExerciseSchema` (model: `Exercise`)

| Field | Type | Notes |
|---|---|---|
| `name` | String (required, unique) | case-insensitive uniqueness enforced at route level via regex upsert |
| `videoUrl` | String | YouTube/Vimeo URL |
| `category` | `[String]` | default `["General"]`; values from the 18-item `muscleGroups` array |
| `instructions` | String | |
| `lastUpdated` | Date | |

No explicit indexes beyond the unique `name` constraint.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/library` | any | All exercises sorted `name: 1` |
| `POST` | `/api/library` | trainer | Upsert by case-insensitive name regex; updates `videoUrl`, `category`, `lastUpdated` |

There is no `DELETE` route for exercises. Removing exercises requires direct DB access.

### Frontend flow

**`fetchLibraryFromDB()`** (`app.js:188`) — called during `loadData()`, populates `globalExerciseLibrary` (module-level array). This array is used for autocomplete everywhere exercises are entered.

**`muscleGroups`** constant (`app.js:141`) — `["Pecho", "Espalda", "Piernas", "Quadriceps", "Femorales", "Tibiales", "Pantorrillas", "Glúteos", "Triceps", "Biceps", "Hombros", "Antebrazos", "Empuje", "Halón", "Abdomen", "Espalda Baja", "Calentamientos", "Cardio"]`

**Autocomplete** — Exercise name inputs use a `datalist`/suggestion div powered by filtering `globalExerciseLibrary` on keyup. When the trainer types in the workout editor, matching exercises from the library autofill name, video URL, and instructions.

**Library module** (`library_content.html`) — loaded into `mainContentArea` when the trainer navigates to the library. The module's init function reads `globalExerciseLibrary` to render the table, and on save calls `POST /api/library`.

### Key design decisions
- Upsert-on-name means saving an exercise with an existing name updates it rather than creating a duplicate.
- `category` is stored as an array of strings (not ObjectIds), keeping the schema simple at the cost of no referential integrity on category names.

### Known limitations
- No delete endpoint — stale or incorrect exercises can only be removed via MongoDB shell.
- `globalExerciseLibrary` is loaded once on app startup and never refreshed unless the page reloads. A trainer adding an exercise in one tab won't see it in another tab's autocomplete until refresh.
- Video URLs are stored as-is with no validation or embed conversion.

---

## 5. Nutrition Tracking

### User perspective
Clients log daily meals organized into named meal groups (Breakfast, Lunch, etc.) by searching foods with auto-complete. The app shows macro totals (calories, protein, carbs, fat, water) against configurable goals, with progress bars. The trainer can view a client's nutrition history from the client profile's Nutrition tab.

### Database schema — `NutritionLogSchema` (model: `NutritionLog`)

| Field | Type | Notes |
|---|---|---|
| `clientId` | ObjectId (required) | |
| `date` | String (required) | `YYYY-MM-DD` |
| `calories` | Number | daily total |
| `protein` | Number | grams |
| `carbs` | Number | grams |
| `fat` | Number | grams |
| `water` | Number | oz |
| `notes` | String | |
| `mood` | String | |
| `meals` | Mixed | nested structure: `{ [mealName]: { foods: [{ name, calories, protein, carbs, fat, serving, servingUnit }] } }` |
| `createdAt` | Date | |

Index: `{ clientId: 1, date: -1 }`.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/nutrition-logs/:clientId` | any | Last 100 logs sorted `date: -1` |
| `POST` | `/api/nutrition-logs` | any | `findOneAndUpdate + upsert`; only updates provided fields via `$set`; fires `nutrition_logged` notification if caller is a client |
| `DELETE` | `/api/nutrition-logs/:logId` | trainer or owning client | Deletes a specific log by its `_id` |
| `GET` | `/api/food-search` | any | Searches local `LOCAL_FOODS` database first; supplements with USDA FoodData Central API if < 4 local matches |

**Food search detail:** The `GET /api/food-search?q=<query>` handler normalizes accented characters via `normalizeStr(s)` (Unicode NFD decomposition + combining mark strip), scores matches (starts-with = 2, contains = 1), and returns up to 8 local results. If fewer than 4 local matches are found, it calls the USDA API (`DEMO_KEY` — rate limited) for `Foundation` and `SR Legacy` food types, requesting nutrient IDs 1008 (energy), 1003 (protein), 1005 (carbs), 1004 (fat). Results are merged, de-duplicated by normalized name, and capped at 12 items total. A timeout of 8 seconds is set via `AbortSignal.timeout(8000)`.

**`LOCAL_FOODS` constant** — ~85 common Spanish-named foods with fields `{ name, brand, serving (g), cal100, p100, c100, f100 }`. Values are per 100g; `serving` is the typical serving size in grams.

### Frontend flow

**`initClientNutrition()`** (`app.js:6901`) — entry point for the client nutrition module (`client_nutricion.html`). On init it:
1. Fetches the client's latest `BodyMeasurement` and `GET /api/me` in parallel.
2. Calls `renderMacroCalculator(wrapper, { weight, bodyFat, macroSettings }, null, true)` to show read-only TDEE estimates.
3. Fetches `GET /api/nutrition-logs/:id` and calls `buildFoodHistory()` to populate a local `foodHistory` array for autocomplete from past meals.
4. Applies the serving unit preference from `localStorage.nutriServingUnit` (warm cache) then overwrites with `me.servingUnit` from the API.

**Date navigation** — `#nutri-date` input is wired so any change calls `loadNutritionForDate(dateStr)`, which searches the cached logs array for a matching entry or initializes an empty `mealsData` state.

**Meal state** — `mealsData` is an array of meal objects `{ name, foods: [] }`. Each food has `{ name, calories, protein, carbs, fat, serving, servingUnit }`. Totals are recomputed on every mutation by iterating `mealsData`.

**Saving** — `#save-nutrition-btn` click calls `POST /api/nutrition-logs` with the full `meals` structure and computed totals. The route uses `$set` so only the fields sent in the body are overwritten.

**Macro goal editing** — `#toggle-goals-btn` reveals `#goals-edit-row` with protein/carbs/fat gram inputs. On change these are persisted via `PUT /api/me` with `{ macroGoals: { goalProtein, goalCarbs, goalFat } }`. The server dot-notation update only touches `macroSettings.goalProtein`, `macroSettings.goalCarbs`, `macroSettings.goalFat`.

**`loadClientNutrition(clientId)`** (`app.js:2364`) — trainer-side view loaded in the Nutrition tab of the client profile. Fetches and renders the client's log history as a read-only table with macro totals per day.

**Serving unit toggle** — `#nutri-unit-toggle` toggles `servingUnit` between `'g'` and `'oz'`. The active value is persisted to `localStorage.nutriServingUnit` and synced to the server via `PUT /api/me { servingUnit }`.

### Key design decisions
- `meals` is stored as `Mixed` (schemaless) to allow arbitrary meal names and food lists without pre-defining a schema.
- Food search hits the local database first to avoid USDA API rate limits and latency on common foods.
- USDA's `DEMO_KEY` is used — it is rate-limited to 30 requests/minute per IP. This should be replaced with a real API key for production.
- `$set` partial update in `POST /api/nutrition-logs` means a client logging water does not accidentally overwrite a meal they logged earlier in the same day.

### Known limitations
- `meals` is stored as a plain object with no type enforcement. A migration or schema change would require custom scripts.
- USDA `DEMO_KEY` will 429 under moderate load.
- No server-side calorie/macro recomputation — the client computes totals locally and sends them. A bug in client-side math would persist silently.
- Food history autocomplete is built from all historical logs on every init — for clients with years of data this could be slow.

---

## 6. Body Metrics & Progress Photos

### User perspective
The trainer logs body measurements (weight, body fat %, BMI, circumferences) for a client. Clients can log their own weight. Progress photos are uploaded by the client and viewable by the trainer. Charts visualize trends over time.

### Database schemas

**`WeightLogSchema`** (model: `WeightLog`)

| Field | Type | Notes |
|---|---|---|
| `clientId` | ObjectId (required) | |
| `date` | String (required) | `YYYY-MM-DD` |
| `weight` | Number (required) | |
| `bodyFat` | Number | nullable |
| `notes` | String | |
| `createdAt` | Date | |

Index: `{ clientId: 1, date: -1 }`.

**`BodyMeasurementSchema`** (model: `BodyMeasurement`)

| Field | Type | Notes |
|---|---|---|
| `clientId` | ObjectId (required) | |
| `date` | String (required) | `YYYY-MM-DD` |
| `weight` | Number | nullable |
| `bodyFat` | Number | nullable |
| `bmi` | Number | nullable; computed by caller, not server |
| `pecho` | String | chest circumference (stored as string to allow fractions like `"27 3/8"`) |
| `biceps` | String | |
| `cintura` | String | waist |
| `cadera` | String | hips |
| `quads` | String | |
| `calves` | String | |
| `notes` | String | |
| `createdAt` | Date | |

Index: `{ clientId: 1, date: 1 }`.

**`ProgressPhotoSchema`** (model: `ProgressPhoto`)

| Field | Type | Notes |
|---|---|---|
| `clientId` | ObjectId (required) | |
| `date` | String (required) | `YYYY-MM-DD` |
| `imageData` | String (required) | base64-encoded image |
| `notes` | String | |
| `category` | String | default `'general'`; freeform |
| `createdAt` | Date | |

Index: `{ clientId: 1, date: -1 }`.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/weight-logs/:clientId` | any | Last 100 weight logs, `date: -1` |
| `POST` | `/api/weight-logs` | any | Upsert by `{clientId, date}`; fires `weight_update` notification if caller is client |
| `GET` | `/api/body-measurements/:clientId` | any | All measurements sorted `date: 1` |
| `POST` | `/api/body-measurements` | trainer only | Upsert by `{clientId, date}`; 403 if caller is not trainer |
| `DELETE` | `/api/body-measurements/:id` | trainer only | Delete by `_id` |
| `GET` | `/api/progress-photos/:clientId` | any | Last 50 photos, `date: -1` |
| `POST` | `/api/progress-photos` | any | Creates new photo document; fires `progress_photos` notification if caller is client |
| `DELETE` | `/api/progress-photos/:id` | trainer only | Delete by `_id` |

### Frontend flow

**`loadClientMetrics(clientId)`** (`app.js:1654`) — called when the trainer switches to the Metrics tab in a client's profile. Fetches `GET /api/body-measurements/:clientId`, renders an HTML table (most recent first via `[...measurements].reverse()`), and initializes a Chart.js line chart via `renderTrainerChart(key)`.

**`parseMeasurement(v)`** (`app.js:1642`) — handles numeric, decimal, and fraction string formats (e.g. `"27 3/8"`) for circumference fields. Uses regex matching for mixed number (`/^(\d+)\s+(\d+)\/(\d+)$/`) and fraction (`/^(\d+)\/(\d+)$/`) patterns.

**`renderTrainerChart(key)`** (`app.js:1796`) — renders a Chart.js gradient line chart for `weight`, `fat`, `bmi`, or individual circumference fields. Uses `spanGaps: true` to connect over null data points. Chart is destroyed and recreated on tab switch (`trChart.destroy()`). Stats strip (`tr-stat-current`, `tr-stat-change`, `tr-stat-best`) is updated inline.

**`window.showAddMeasurementModal(clientId, totalInches)`** — opens a modal to enter new measurements. BMI is computed client-side as `weight(kg) / (height(m))^2`, converting from imperial if needed.

**`loadClientPhotos(clientId)`** (`app.js:2518`) — fetches progress photos and renders a masonry-style grid. Each photo is displayed as a `<img src="...base64...">` tag.

**Client metrics module** (`client_metricas.html`) — clients can log their own weight via `POST /api/weight-logs`. The client-facing chart uses `WeightLog` data, not `BodyMeasurement` (the latter is trainer-only write).

### Key design decisions
- Circumference measurements are stored as strings to preserve fraction notation (e.g. inches with fractions). `parseMeasurement()` converts to float for chart rendering.
- BMI is computed client-side (the server accepts whatever is sent). This puts math responsibility on the frontend.
- Progress photos are stored as base64 in MongoDB, capped at 50 per fetch. No compression is applied server-side. Images over ~1 MB each will quickly exhaust storage.

### Known limitations
- Base64 photo storage in MongoDB documents is the most significant scalability concern in the entire app. At 50 photos per client and typical mobile photo sizes, a single client could consume tens of MB in the database.
- `BodyMeasurement` write is restricted to trainers only, but read is open to any authenticated user — a client can read all their own measurements directly.
- No duplicate-date protection on `ProgressPhoto` (unlike workouts and nutrition logs which use upsert).

---

## 7. Payments & Invoicing

### User perspective
The trainer creates invoices for clients (amount, period label, due date). Invoices appear in a table with status badges (pending/paid/overdue). The trainer can mark invoices paid, revert them to pending, send a styled HTML invoice email, or delete records. Summary cards show counts by status.

### Database schema — `PaymentSchema` (model: `Payment`)

| Field | Type | Notes |
|---|---|---|
| `clientId` | ObjectId (required) | |
| `trainerId` | ObjectId (required) | scopes all queries to the trainer who created it |
| `amount` | Number (required) | USD |
| `status` | String enum | `'pending'`, `'paid'`, `'overdue'`; default `'pending'` |
| `method` | String | `'ath_movil'`, `'venmo'`, `'paypal'`, `'cash'`, `'other'` |
| `periodLabel` | String | display label e.g. `"Mayo 2026"` |
| `dueDate` | String (required) | `YYYY-MM-DD` |
| `paidDate` | String | `YYYY-MM-DD`; auto-set on mark-paid if not supplied |
| `notes` | String | |
| `createdAt` | Date | |

Index: `{ trainerId: 1, dueDate: -1 }`.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/payments` | trainer | All payments for `trainerId: req.user.id`; populates `clientName` in memory |
| `GET` | `/api/payments/client/:clientId` | trainer | Payments for one client filtered by `trainerId` |
| `POST` | `/api/payments` | trainer | Creates new payment; requires `clientId`, `amount`, `dueDate` |
| `PATCH` | `/api/payments/:id` | trainer | Updates allowed fields; auto-sets `paidDate` when `status` becomes `'paid'`; clears `paidDate` when status reverts |
| `DELETE` | `/api/payments/:id` | trainer | Deletes; scoped to `{ _id, trainerId }` so trainer can't delete others' records |
| `POST` | `/api/payments/:id/invoice` | trainer | Sends HTML invoice email to client; builds deep links for Venmo and PayPal from `trainer.paymentHandles` |

Client name population in `GET /api/payments` is done in-memory: fetches all unique `clientId`s, queries `User` for names, builds a map, and merges before returning. This is not a MongoDB `$lookup` — it's two sequential queries.

### Frontend flow

**`renderPaymentsView()`** (`app.js:4601`) — entry point for the Pagos module. Fetches `GET /api/payments`, stores in module-level `paymentsDb`, calls `renderPaymentsTable()`. Wires search input, status filter select, and the "Nueva Factura" button (once, using a `dataset.wired` guard to prevent double-binding on re-render).

**`renderPaymentsTable()`** (`app.js:4531`) — pure render function; reads `paymentsDb`, applies client-side overdue elevation (if `status === 'pending'` and `dueDate < today`, display as overdue without changing the DB), filters by search text and status dropdown, updates summary cards (`count-paid`, `count-pending`, `count-overdue`), and renders the table body.

**Overdue elevation** is intentionally client-side only — the DB `status` remains `'pending'` until the trainer explicitly marks it overdue. This prevents the server from needing a cron job.

**`openNewInvoiceModal()`** (`app.js:4644`) — populates the client `<select>` from `mockClientsDb`, defaults `dueDate` to end of current month, defaults `periodLabel` to current month name + year.

**`handleCreateInvoice()`** (`app.js:4669`) — validates inputs, POSTs to `/api/payments`, on success refreshes `paymentsDb` and re-renders the table.

**`window.markPaymentPaid(id)`** / **`window.markPaymentPending(id)`** — call `PATCH /api/payments/:id` with `{ status: 'paid' }` or `{ status: 'pending' }`, then refresh.

**`window.sendPaymentInvoice(id, clientName)`** — calls `POST /api/payments/:id/invoice`, shows success/error toast.

**Payment handles** (trainer settings) — `paymentHandles.athMovil`, `.venmo`, `.paypal` are set in Settings (`initSettings()` in `app.js`) via `PUT /api/me`. Invoice emails pull these handles server-side when generating deep links. Venmo link format: `https://venmo.com/{handle}?txn=pay&amount={amount}&note={period}`. PayPal: `https://paypal.me/{handle}/{amount}`.

### Key design decisions
- `trainerId` is always set from `req.user.id` (JWT), not from the request body, preventing a trainer from claiming payments belonging to another trainer.
- `paidDate` auto-set on the server means the trainer doesn't have to manually enter it.
- Overdue status is display-only on the client — no nightly job needed.

### Known limitations
- No currency support other than USD — `amount` is a plain Number with no currency field.
- No partial payment or payment history — each `Payment` document represents a single invoice, not a running balance.
- Client name population uses two sequential queries rather than a `$lookup` aggregation, which scales poorly with large client lists.
- No email templating engine — invoice HTML is hardcoded in the route handler.

---

## 8. Notifications

### User perspective
Trainer receives a feed of activity events from clients (workout completions, missed workouts, RPE submissions, weight logs, nutrition logs, progress photo uploads, new client created, program assigned). Unread count is shown as a badge on the sidebar bell icon, polled every 60 seconds.

### Database schema — `NotificationSchema` (model: `Notification`)

| Field | Type | Notes |
|---|---|---|
| `trainerId` | ObjectId (required) | always the single trainer account |
| `clientId` | ObjectId (required) | |
| `clientName` | String (required) | denormalized for display |
| `type` | String enum (required) | `workout_completed`, `workout_missed`, `metric_resistance`, `nutrition_logged`, `progress_photos`, `weight_update`, `workout_comment`, `video_upload`, `reported_issue`, `metric_inactivity`, `program_assigned`, `client_created`, `rpe_submitted` |
| `title` | String (required) | verb phrase, e.g. `"completó su entrenamiento"` |
| `message` | String | detail line |
| `data` | Mixed | arbitrary extra payload |
| `isRead` | Boolean | default `false` |
| `createdAt` | Date | |

Index: `{ trainerId: 1, isRead: 1, createdAt: -1 }`.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/notifications/unread-count` | any | `countDocuments({ trainerId: req.user.id, isRead: false })` |
| `GET` | `/api/notifications` | any | Last 50 notifications for trainer, `createdAt: -1` |
| `PUT` | `/api/notifications/:id/read` | any | Sets `isRead: true` on one notification |
| `PUT` | `/api/notifications/read-all` | any | `updateMany` all unread for trainer |

**Route ordering note:** `GET /api/notifications/unread-count` must be registered before `GET /api/notifications/:id/...` in the route list to prevent Express from matching `"unread-count"` as an `:id` parameter. This is explicitly noted in the source (`// MUST be before :id route`).

**`createNotification()`** (`server.js:343`) — internal async helper called by route handlers when client actions occur. Finds the trainer by `role: 'trainer'` (assumes a single trainer), creates the `Notification` document. Errors are caught and logged but do not fail the parent request.

### Frontend flow

**`fetchNotificationCount()`** (`app.js:208`) — called immediately after trainer login and then every 60 seconds via `notificationPollInterval = setInterval(fetchNotificationCount, 60000)`. Updates `#notification-badge` text and toggles `hidden`.

**`fetchAndRenderNotifications(filter)`** (`app.js:226`) — fetches all notifications, applies one of three filters: `'7days'` (default), `'unread'`, or `'all'`. Filter is applied client-side on the already-fetched array.

**`renderNotificationItem(n)`** (`app.js:260`) — renders a single notification card with left-border color from `getNotificationConfig(n.type)`, relative timestamp from `getTimeAgo(date)`, and a click handler that calls `window.markNotificationRead(id)` if unread. Client name is a clickable span that calls `window.openClientProfile(n.clientId)`.

**`getNotificationConfig(type)`** (`app.js:286`) — maps each notification type to a Font Awesome icon class and hex color. Falls back to `{ icon: 'fas fa-bell', color: '#FFDB89' }`.

**`window.markNotificationRead(id)`** / **`window.markAllNotificationsRead()`** (`app.js:318`) — call the respective API routes then refresh count and feed.

### Key design decisions
- `clientName` is denormalized into the notification document so the feed can render without joining to the `User` collection.
- The trainer is identified by `role: 'trainer'` lookup rather than a hardcoded ID, making the system portable if the trainer account is recreated.
- Polling (60s interval) is used instead of WebSockets for simplicity.

### Known limitations
- Single-trainer assumption is baked in — `createNotification` does `User.findOne({ role: 'trainer' })` and uses the first result. A multi-trainer setup would require a `trainerId` parameter to every client action.
- No push notifications — the trainer must have the app open to see badge updates.
- Notifications are never pruned. Over time the collection will grow unboundedly.
- The 50-notification fetch limit means old notifications become invisible even if not read.

---

## 9. Settings & User Preferences

### User perspective
Users can update their display name, last name, profile picture, and unit system (imperial/metric). The trainer can additionally configure ATH Móvil, Venmo, and PayPal payment handles. Health data (THR, Max HR) is displayed as read-only (set by trainer). A dark/light theme toggle persists to `localStorage`.

### Database fields (within `UserSchema`)
`name`, `lastName`, `unitSystem` (`'imperial'`|`'metric'`), `servingUnit` (`'g'`|`'oz'`), `profilePicture` (base64 string), `paymentHandles.athMovil`, `paymentHandles.venmo`, `paymentHandles.paypal`, `thr`, `mahr`.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/me` | any | Full user profile minus password fields |
| `PUT` | `/api/me` | any | Updates `name`, `lastName`, `unitSystem`, `profilePicture`, `servingUnit`; optionally `macroSettings.goal{Protein,Carbs,Fat}` via `macroGoals`; optionally `paymentHandles` if caller is trainer |

Allowlist pattern: only fields in `allowedFields = ['name', 'lastName', 'unitSystem', 'timezone', 'profilePicture', 'servingUnit']` are accepted from the request body. `paymentHandles` is handled as a separate block restricted to `req.user.role === 'trainer'`.

### Frontend flow

**`initSettings()`** (`app.js:338`) — async; fetches `GET /api/me`, populates all form fields. If trainer, un-hides `#payment-handles-section` and wires `#save-payment-handles-btn`.

**Profile picture flow:**
1. `#change-photo-btn` triggers `#profile-pic-input` file picker.
2. File is validated (max 5 MB, JPEG/PNG/GIF only).
3. `FileReader.readAsDataURL()` opens the photo editor modal.
4. **`openPhotoEditor(src)`** (`app.js:430`) — shows a 192×192px crop circle with drag-to-reposition and a zoom slider. `editorState` tracks `{ x, y, scale, baseScale, dragging, lastX, lastY }`. `baseScale` is computed on `img.onload` as `Math.max(CIRCLE_PX / naturalWidth, CIRCLE_PX / naturalHeight)` to ensure cover fit.
5. **`exportCroppedPhoto()`** (`app.js:449`) — renders the positioned/scaled image to a 400×400 canvas and returns `canvas.toDataURL('image/jpeg', 0.92)`.
6. The exported base64 string is stored in `window._pendingProfilePicture`.
7. On `#save-settings-btn` click, if `window._pendingProfilePicture` exists, it is included in the `PUT /api/me` body.

**Unit toggle** — uses a CSS translate trick: `#unit-toggle-circle` toggles `translate-x-0` / `translate-x-5` to simulate a toggle switch. Actual value is read from `unitCircle.classList.contains('translate-x-5')`.

**`loadSession()`** (`app.js:691`) — `() => JSON.parse(localStorage.getItem('auth_user'))`. Used throughout the app to get the cached user without an API call.

**Theme toggle** — `document.documentElement.classList.toggle('dark')` + `localStorage.setItem('theme', ...)`. `applyThemePreferenceEarly()` reads this on page load, before content renders, to avoid flash.

**After save** — `PUT /api/me` response is merged back into `localStorage.auth_user` to keep the in-memory session in sync.

### Key design decisions
- Profile pictures are stored as base64 in MongoDB because no external storage service is configured. The `PUT /api/me` body limit is 2 MB (`express.json({ limit: '2mb' })`). A 400×400 JPEG at quality 0.92 is typically 30–60 KB, well within this limit.
- `paymentHandles` venmo value has `@` stripped server-side (`ph.venmo.replace('@', '').trim()`) so deep links are always formatted correctly.

### Known limitations
- Email address is read-only in Settings UI — there is no route to change it.
- `timezone` is in the `allowedFields` list on the server but has no corresponding UI control in `ajustes_content.html`. It can only be set when creating a client.
- Theme preference is stored in `localStorage` only, not the database — it doesn't sync across devices.

---

## 10. Groups

### User perspective
The trainer creates named groups (e.g. "Mujeres", "Presencial") and assigns clients to them. Groups appear as filters on the clients list. The default group "General" is seeded on startup and cannot be deleted via UI.

### Database schema — `GroupSchema` (model: `Group`)

| Field | Type | Notes |
|---|---|---|
| `name` | String (required, unique) | |
| `createdBy` | ObjectId (ref: User) | trainer's user ID |
| `createdAt` | Date | |

No additional indexes beyond the unique `name` constraint.

### Backend routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/groups` | any | All groups sorted `name: 1` |
| `POST` | `/api/groups` | trainer | Creates group; checks for existing name before insert |
| `DELETE` | `/api/groups/:id` | trainer | Deletes by `_id`; does not cascade-update clients in that group |

### Frontend flow

**`fetchGroupsFromDB()`** (`app.js:155`) — fetches all groups, maps to `mockGroupsDb` (array of name strings). Ensures `'General'` is always first.

**`renderGroupOptions()`** (`app.js:1399`) — populates group `<select>` elements in the "Add Client" form from `mockGroupsDb`.

The groups management UI is embedded in the Clientes section — adding and deleting groups directly updates `mockGroupsDb` and re-renders group selects after the API call.

### Key design decisions
- Groups are stored as a name string on the `User.group` field, not as a foreign key ObjectId. This means deleting a group does not automatically update clients that belong to it.
- `mockGroupsDb` stores only names (not the full Group documents) because only the name is needed for filtering and dropdowns.

### Known limitations
- No cascade delete: deleting a group leaves clients with a `group` value pointing to a now-deleted group name.
- No group membership count displayed in the groups list.
- The "General" group is seeded but not protected from deletion via the API — the UI just doesn't expose a delete button for it.

---

## 11. Toast & Confirm UI System

### User perspective
Non-blocking toast notifications replace `alert()`. Confirm dialogs replace `confirm()` with a styled modal that returns a Promise.

### Implementation

Both systems are initialized inline in `app.js` before any module loads, and exposed on `window` so they can be called from any dynamically-loaded HTML fragment.

**`window.showToast(message, type, duration)`** (`app.js:55`):
- Creates a `#toast-container` div fixed to `bottom:24px; right:24px; z-index:9999` on first call (IIFE at `app.js:48`).
- `type` options: `'success'` (green), `'error'` (red), `'info'` (gold). Defaults to `'info'`.
- `duration` defaults to 3500ms.
- Each toast is a dynamically created `div` with slide-in animation (`opacity: 0 → 1`, `translateX(20px) → 0`) via `requestAnimationFrame`.
- Auto-removes after `duration`ms with a 300ms fade-out.
- Has an `×` close button that removes the toast immediately.
- Multiple toasts stack vertically (flexbox column).

**`window.showConfirm(message, options)`** (`app.js:79`):
- Returns a `Promise<boolean>`.
- Options: `{ confirmLabel: 'Confirmar', cancelLabel: 'Cancelar', danger: true }`.
- Renders a full-screen `backdrop-blur-sm` overlay with a centered card.
- `danger: true` colors the confirm button red; `danger: false` colors it gold.
- Resolves `true` on confirm, `false` on cancel or backdrop click.
- Usage: `const yes = await showConfirm('¿Eliminar?', { confirmLabel: 'Eliminar', danger: true });`

### Key design decisions
- Toast container is created once with an IIFE and referenced by ID on subsequent calls, avoiding duplicate containers.
- `showConfirm` uses a Promise-based API identical to the native `confirm()` pattern, making it a drop-in replacement with `await`.
- Both functions are attached to `window` because they need to be called from HTML `onclick` attributes in dynamically-loaded module fragments (where the `app.js` closure scope is not accessible).

### Known limitations
- `showToast` HTML uses `innerHTML` with the `message` parameter — if `message` contains user-controlled content it could be an XSS vector. Currently all callers use static strings or server-controlled data.
- No toast queue limit — rapidly firing many errors could stack dozens of toasts.

---

## 12. SPA Architecture (loadModule, apiFetch, role routing)

### Overview

FitBySuarez is a Single Page Application hosted from a single `index.html`. The Express server has a catch-all `GET *` route that serves `public/index.html`. All navigation happens client-side by fetching HTML fragment files and injecting them into `#main-content`.

### Shell structure

`public/index.html` — root HTML. Contains `#auth-screen` and `#dashboard-container`. `dashboard-container` has `#sidebar-placeholder` (where the role-appropriate sidebar HTML is injected) and `#main-content` (where module content is injected).

`public/trainer-dashboard.html` — sidebar HTML for the trainer role. Contains nav links, collapse button, notification badge, logout button, trainer name + avatar.

`public/client-dashboard.html` — sidebar HTML for the client role.

### Key functions

**`loadModule(name)`** (`app.js:877`):
```js
const loadModule = async (name) => {
    if (MODULE_CACHE[name]) return MODULE_CACHE[name];
    const res = await fetch(`${name}.html`);
    const html = await res.text();
    MODULE_CACHE[name] = html;
    return html;
};
```
`MODULE_CACHE` is a plain object keyed by module name. Once a module is fetched it is never re-fetched (no cache invalidation). Module names map directly to file names: `'trainer_home'` → `public/trainer_home.html`.

**`router(user)`** (`app.js:888`):
- If no `user` object, loads `localStorage.auth_user` via `loadSession()`.
- If still no user: shows `#auth-screen`, hides dashboard.
- If user: hides auth screen, shows dashboard.
- Loads the role-appropriate sidebar HTML via `loadModule(dashModule)` and injects into `#sidebar-placeholder`.
- For trainers: loads `trainer_home.html`, calls `renderTrainerHome()`, starts notification polling.
- For clients: loads `client_inicio.html`, calls `initClientHome()`.
- Triggers first-login modal if `user.isFirstLogin`.

**`updateContent(title, contentHtml)`** (`app.js:849`):
- Injects content into `#main-content`.
- Detects calendar view by checking for `'client-calendar-grid'` in the HTML string — if true, removes padding and rounds from the container for edge-to-edge layout.
- Wraps content in a glassmorphism card: `bg-[#030303]/85 backdrop-blur-2xl border border-white/[0.06]`.

**`apiFetch(url, options)`** (`app.js:19`):
- Wrapper around native `fetch`.
- Auto-attaches `Authorization: Bearer <token>` from `localStorage.auth_token`.
- On `401` with a token present: clears `auth_token` and `auth_user` from localStorage and calls `location.reload()` to force re-login.
- On `401` without a token: throws `'Session expired'` without reloading (prevents infinite reload on login page).

### Navigation model

Sidebar nav links in `trainer-dashboard.html` have `href` values pointing to fragment HTML files (e.g. `href="/clientes_content.html"`). The app intercepts these clicks (wired in the sidebar init logic) and instead calls `loadModule('clientes_content')` + `updateContent(...)`. Direct URL navigation to `href` paths would also work (Express serves index.html for all routes), but the fragment files themselves are not complete HTML pages — they are content-only divs.

Some nav items use `href="#"` and are wired entirely via JavaScript click handlers (e.g., Pagos, Ajustes, Inicio).

### Module list and their init functions

| File | Role | Init function |
|---|---|---|
| `trainer_home.html` | trainer | `renderTrainerHome(trainerName, filterType)` |
| `clientes_content.html` | trainer | `window.renderClientsTable()` |
| `programas_content.html` | trainer | wired inline |
| `library_content.html` | trainer | wired inline |
| `pagos_content.html` | trainer | `renderPaymentsView()` |
| `notifications_content.html` | trainer | `fetchAndRenderNotifications(filter)` |
| `ajustes_content.html` | both | `initSettings()` |
| `client_inicio.html` | client | `initClientHome()` |
| `client_nutricion.html` | client | `initClientNutrition()` |
| `client_metricas.html` | client | wired inline |
| `client_programas.html` | client | wired inline |
| `client_progress.html` | client | wired inline |
| `client_equipo.html` | client | wired inline |

### Global state variables

Key module-level state in `app.js` (accessible to all closures within `DOMContentLoaded`):
- `mockClientsDb: []` — cached clients array
- `mockProgramsDb: []` — cached programs array
- `globalExerciseLibrary: []` — cached exercise library
- `mockGroupsDb: []` — cached group names
- `MODULE_CACHE: {}` — HTML fragment cache
- `currentClientViewId` — ID of client currently being viewed
- `currentNotifFilter` — `'7days'` | `'unread'` | `'all'`
- All editor state variables prefixed with `editor` (see section 3)

### Key design decisions
- HTML fragment caching (`MODULE_CACHE`) avoids re-fetching modules on every navigation, but means module HTML changes require a page reload to take effect.
- `apiFetch` centralizes all auth token handling — no module needs to think about JWT.
- Role routing is binary (trainer vs. client) and handled entirely in `router()`. There is no client-side route table or URL-based routing.
- `injectGlobalStyles()` (`app.js:726`) injects a `<style id="dynamic-styles">` tag once with calendar, editor, superset connector, and responsive CSS that cannot be expressed with Tailwind utility classes alone.

### Known limitations
- No URL routing — the browser URL stays at `/` regardless of which module is active. Deep linking and browser back/forward navigation are not supported.
- `MODULE_CACHE` has no TTL or size limit. In a long session, all visited modules remain in memory.
- All global state is in a single closure — there is no state management library. Complex inter-module state is shared via `window.*` properties and module-level variables, making the dependency graph implicit.
- `updateContent()` destroys and re-creates module HTML on every navigation, losing any unsaved form state in the replaced module.
