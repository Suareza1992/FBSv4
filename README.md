# FitBySuárez — Personal Training Platform

A full-stack web application built for Coach Suarez to manage clients, training programs, nutrition, payments, and progress tracking — all from a single, private platform. Designed for a solo personal trainer working with remote and in-person clients, primarily in Puerto Rico.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Funcionalidades (Español)](#funcionalidades-español)
- [Stack Tecnológico (Español)](#stack-tecnológico-español)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Dormant Features (Built, Activated at Launch)](#dormant-features-built-activated-at-launch)
- [Architecture Overview](#architecture-overview)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Routes](#api-routes)
- [Database Schemas](#database-schemas)
- [Role System](#role-system)
- [Email System](#email-system)
- [Payments System](#payments-system)
- [Future Roadmap](#future-roadmap)

---

## Project Overview

FitBySuárez is an invite-only fitness coaching platform. Public self-registration is disabled — the trainer creates every client account manually and sends a secure invite link via email. Clients then activate their account, set their own password, and access a personal dashboard with their assigned workouts, nutrition tracker, progress photos, body metrics, and payment history.

The trainer gets a separate dashboard with full control: client management, a multi-week program builder, an exercise library, a notification feed tracking all client activity, and an invoice system with direct payment links for ATH Móvil, Venmo, and PayPal.

The app is used in Spanish day-to-day but the codebase is commented in English.

---

## Funcionalidades (Español)

Resumen de todo lo que ofrece la plataforma FitBySuárez.

### Panel del Entrenador
- **Gestión de clientes** — crear, editar, archivar, filtrar y buscar clientes; agruparlos en cohortes personalizados.
- **Sistema de invitaciones** — enlaces de invitación seguros (7 días) con correo automático al crear un cliente; se pueden reenviar.
- **Constructor de programas multi-semana** — rutinas reutilizables con semanas y entrenamientos diarios, asignables a cada cliente.
- **Editor de entrenamientos por cliente** — asignar entrenamientos por fecha; calentamiento/enfriamiento, supersets, videos de ejercicios y días de descanso (activo o total).
- **Asignación flexible de programas** — asignar un programa a **varios clientes a la vez**, con fecha de inicio y selección opcional de qué días cargar (p. ej. empezar desde el Día 3); también asignar **un solo día** suelto al calendario de un cliente.
- **Blog** — redactar y publicar artículos con formato Markdown (enlaces, negrita, cursiva, listas); se muestran en el sitio público con fecha de publicación y, si se editan, de actualización.
- **Biblioteca de ejercicios** — base de datos por grupo muscular, con video e instrucciones; agregar y editar ejercicios.
- **Equipo del cliente** — pestaña de solo lectura con el inventario y los pesos que el cliente marcó como disponibles; recibes una notificación cuando el cliente lo actualiza.
- **Feed de notificaciones** — actividad en tiempo real (entrenamientos completados/perdidos, RPE, peso, nutrición, fotos, equipo actualizado, restricciones musculares, nuevos clientes); filtrable.
- **Medidas corporales** — registrar y seguir circunferencias, % de grasa, IMC y peso por sesión.
- **Facturación y pagos** — crear facturas, marcarlas pagadas/vencidas y enviar correos con enlaces a ATH Móvil, Venmo y PayPal.
- **Métodos de cobro** — configurar los handles de ATH Móvil, Venmo y PayPal.

### Panel del Cliente
- **Entrenamiento del día** — ver la rutina asignada con instrucciones y videos; marcar ejercicios y la sesión como completados o perdidos; enviar RPE (esfuerzo percibido).
- **Historial de entrenamientos** — revisar y editar sesiones pasadas con su estado.
- **Seguimiento de nutrición** — registrar calorías, macros (proteína, carbos, grasas) y agua por comida (desayuno, almuerzo, merienda, cena).
- **Búsqueda de alimentos** — base local en español (incluye comida criolla puertorriqueña) más USDA / Nutritionix / Open Food Facts; entrada manual con unidad obligatoria.
- **Recomendador de comidas con IA — "¿Qué como?"** 🤖 — sugiere comidas para cerrar los macros que faltan, respetando alergias y preferencias; los macros se verifican contra la base de datos.
- **Registro de comidas por texto natural — "Describir"** 🤖 — el cliente describe lo que comió en español y la IA lo convierte en alimentos con macros; revisa y ajusta los gramos antes de guardar.
- **Preferencias alimenticias** — tipo de dieta, alergias y alimentos que no le gustan; alimentan al recomendador.
- **Ejercicio extra** — registrar entrenamientos adicionales y las calorías quemadas, que amplían el presupuesto calórico del día.
- **Seguimiento de agua** — botella visual que se vacía según el agua consumida y se reinicia cada día.
- **Fotos de progreso** — subir fotos por categoría (frente, espalda, lado, general) y ver el historial.
- **Métricas corporales** — historial de peso y medidas con gráficas, y guía de medidas con figura anatómica.
- **Inventario de equipo** — marcar el equipo disponible para personalizar las rutinas.
- **Ajustes de perfil** — nombre, sistema de unidades (imperial/métrico), unidad de porción (g/oz), zona horaria y foto de perfil.
- **Historial de pagos** — ver las facturas emitidas por el entrenador con su estado (pendiente, pagada, vencida).

### Ambos roles
- **Autenticación JWT** — sesiones con expiración de 7 días y cierre de sesión automático al vencer.
- **Recuperación de contraseña** — flujo de restablecimiento con enlace temporal (1 hora) por correo.
- **Notificaciones tipo *toast*** y **diálogos de confirmación** propios (sin `alert()`/`confirm()` nativos).
- **Tema oscuro** — sistema de diseño carbón/dorado (`#030303` / `#FFDB89`).

> 🤖 Las funciones de IA se controlan con *feature flags* y se activan al lanzamiento. Incluyen límites de uso (por cliente/día y un tope global mensual) y un límite de gasto en la consola de Anthropic para evitar cargos inesperados.

---

## Stack Tecnológico (Español)

| Capa | Tecnología |
|---|---|
| Backend | Node.js (ESM) + Express 4 |
| Base de datos | MongoDB con Mongoose 8 |
| Autenticación | JWT (`jsonwebtoken`) + `bcryptjs` |
| Seguridad | Helmet (CSP), CORS, rate limiting |
| Inteligencia artificial | Anthropic Claude (modelo Haiku) — recomendador de comidas y registro por texto; salidas estructuradas + verificación de macros contra la base de datos |
| Frontend | SPA en JavaScript puro (sin framework) |
| Estilos | Tailwind CSS (compilado a `output.css`), fuente Inter, íconos Font Awesome 6 |
| Gráficas | Chart.js |
| Almacenamiento de imágenes | Cloudinary |
| Datos de alimentos | Base local curada + USDA FoodData Central / Nutritionix / Open Food Facts |
| Correo | Resend (API HTTP) |
| Pagos | Enlaces directos a ATH Móvil, Venmo y PayPal; integración con Stripe |
| Hospedaje | Railway (despliegue automático desde GitHub) |
| Configuración | `dotenv` |

---

## Features

### Trainer Dashboard
- **Client management** — create, edit, soft-delete, filter, and search clients; group clients into custom cohorts
- **Invite system** — generate secure 7-day invite tokens; resend invite links at any time; invite email sent automatically on client creation
- **Multi-week program builder** — create reusable training programs with named weeks and daily workouts; assign programs to clients
- **Client workout editor** — assign workouts directly to individual clients by calendar date; supports warmup/cooldown sections, superset grouping, exercise video links, and rest/active-rest days
- **Flexible program assignment** — assign a program to **multiple clients at once**, with a start date and an optional day picker (assign only specific days, e.g. start from Day 3); also assign a **single program day** to one client's calendar
- **Blog editor** — write and publish articles with Markdown formatting (links, bold, italic, bullet/numbered lists); they render on the public marketing site with a publish date (and an "updated" date if edited later)
- **Exercise library** — curated database of exercises categorized by muscle group, each with an optional video URL and instructions; trainer can add/update exercises
- **Client equipment view** — read-only tab showing the equipment and weights a client has marked as available; the trainer receives a notification (throttled) whenever a client updates their inventory
- **Notifications feed** — real-time activity feed showing workout completions, missed sessions, RPE ratings, weight updates, nutrition logs, progress photo uploads, equipment updates, muscle restrictions, and new client additions; filterable by last 7 days or unread
- **Body measurements** — record and track circumference measurements (chest, biceps, waist, hips, quads, calves), body fat %, BMI, and weight per session
- **Payment / Invoice management** — create invoices per client, mark them paid/overdue, send branded invoice emails with deep links to ATH Móvil, Venmo, and PayPal
- **Settings** — configure payment handles (ATH Móvil business name, Venmo handle, PayPal.me username)

### Client Dashboard
- **Workout view** — see today's assigned workout with exercise instructions, video demos, warmup, and cooldown; mark individual exercises complete; mark session complete or missed; submit RPE (Rate of Perceived Exertion) rating after each session
- **Workout history** — browse past sessions by week with completion status
- **Nutrition tracker** — log daily calories, macros (protein, carbs, fat), and water by meal slot (desayuno, almuerzo, merienda, cena, snacks); food search backed by a curated local Spanish database (incl. Puerto Rican criollo dishes) plus USDA FoodData Central, Nutritionix, and Open Food Facts; manual entry requires a unit
- **AI meal recommender ("¿Qué como?")** 🤖 — suggests meals to close the day's remaining macros, respecting the client's allergies and preferences; every macro is verified against the food database
- **AI food logging by text ("Describir")** 🤖 — the client describes a meal in plain Spanish and the AI parses it into foods with macros; the client reviews and adjusts grams before saving
- **Dietary preferences** — diet type, allergies, and disliked foods that feed the recommender
- **Extra exercise** — log additional workouts and calories burned, which widen the day's calorie budget
- **Water tracking** — visual bottle that empties as water is logged and resets daily
- **Progress photos** — upload categorized progress photos (front, back, side, general); view photo history
- **Body metrics** — view weight history and body measurement trends with charts (Chart.js)
- **Equipment inventory** — mark available gym equipment to help the trainer personalize workouts
- **Profile settings** — update name, unit system (imperial/metric), preferred food serving unit (g/oz), timezone, profile picture
- **Payment history** — view invoices issued by the trainer with status (pending, paid, overdue)

### Both Roles
- **JWT authentication** — stateless sessions with 7-day token expiry; automatic logout on expired token
- **Password recovery** — forgot-password flow with a time-limited (1 hour) reset link sent via email
- **Toast notification system** — non-blocking in-app success/error/info toasts replace all `alert()` calls
- **Custom confirm dialogs** — branded async confirm modals replace all `confirm()` calls
- **Dark theme** — charcoal/gold design system (`#030303` / `#FFDB89`) throughout

> 🤖 AI features are controlled by feature flags and enabled at launch. They include usage limits (per-client/day and a global monthly cap) and an Anthropic Console spend limit to prevent surprise charges.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (ESM — `"type": "module"`) |
| Web framework | Express 4 |
| Database | MongoDB via Mongoose 8 |
| Authentication | JWT (`jsonwebtoken`) + `bcryptjs` |
| Security | Helmet (CSP), CORS, rate limiting (`express-rate-limit`) |
| AI | Anthropic Claude (Haiku) — meal recommender & text food logging; structured outputs + DB-verified macros |
| Frontend | Vanilla JavaScript SPA (no framework) |
| Styling | Tailwind CSS (compiled to `output.css`), Inter font (Google Fonts) |
| Icons | Font Awesome 6 |
| Charts | Chart.js |
| Image storage | Cloudinary |
| Food data | Local curated database + USDA FoodData Central / Nutritionix / Open Food Facts |
| Email | Resend (HTTP API) |
| Payments | ATH Móvil / Venmo / PayPal deep links; Stripe integration |
| Hosting | Railway (auto-deploy from GitHub) |
| Linting | ESLint 10 (flat config) |
| Environment | `dotenv` |

---

## Dormant Features (Built, Activated at Launch)

These features are **fully implemented but kept dark behind feature flags** until the platform officially launches. Each is wired end-to-end (backend + UI) and can be switched on per environment without a code change. All AI features share triple-layer cost protection: a per-user/day cap, a global monthly call cap, and a spend limit set in the Anthropic Console — so they can never produce surprise charges.

| Feature | Flag | Status |
|---|---|---|
| 🤖 **AI meal recommender ("¿Qué como?")** — suggests meals to close the day's remaining macros, respecting allergies/preferences; every macro is DB-verified | `MEAL_SUGGESTION_ENABLED` | Built, dormant |
| 🤖 **AI food logging by text ("Describir")** — client describes a meal in plain Spanish; the AI parses it into foods with macros to review and adjust before saving | `FOOD_NLP_ENABLED` | Built, dormant |
| 🤖 **AI equipment check ("Revisar equipo")** — trainer-only button in the workout editor that uses AI to flag any exercise needing equipment the client doesn't own, or any prescribed weight that exceeds what they have (parsed from the free-text instructions); advisory only, never blocks saving | `EQUIPMENT_CHECK_ENABLED` | Built, dormant |

**AI equipment check — safeguards (so it never produces unwanted flags):**
- If the client hasn't registered any equipment, the check is skipped entirely (no AI call, no flags) and the trainer is told there's nothing to compare against.
- A **per-client on/off toggle** (`equipmentCheckOn`, default on) lives in the client's *Equipo* tab — turn it off for clients with full gym access so they're never flagged. When off, the check short-circuits both client- and server-side.

> Why dormant? The trainer wants to validate AI behavior and roll these out deliberately at launch rather than expose them to clients early. Flipping the relevant flag to `true` (and providing `ANTHROPIC_API_KEY`) activates a feature instantly.

---

## Architecture Overview

### Single-Page Application Pattern

The entire frontend lives in `public/index.html` (shell) and `public/app.js` (application logic). All page sections are loaded dynamically via a `loadModule()` function that fetches HTML partials from the `public/` directory and injects them into `#main-content`. This means:

- There is no client-side router library — navigation is handled by fetching HTML fragments over HTTP
- HTML partials (`clientes_content.html`, `programas_content.html`, `pagos_content.html`, etc.) are server-static files returned by Express's `express.static('public')` middleware
- A wildcard catch-all route (`app.get('*', ...)`) redirects any unknown path back to `index.html`, enabling bookmarkable URLs without a 404

### `apiFetch` Wrapper

Every API call goes through `apiFetch()`, a thin wrapper around `fetch` that:
1. Automatically attaches the `Authorization: Bearer <token>` header from `localStorage`
2. Intercepts `401 Unauthorized` responses — if a token existed and is now rejected, it clears `localStorage` and reloads the page to force re-login
3. Returns the raw `Response` object for callers to handle normally

### Write-Through localStorage Cache

Auth state is persisted in `localStorage` under two keys:
- `auth_token` — the raw JWT string
- `auth_user` — JSON of basic user info (id, name, email, role, profile picture)

On page load, `app.js` checks for a valid token in `localStorage` to restore the session without a round-trip to `/api/me`. All other data (clients, programs, groups, exercise library) is fetched fresh from the API on every login.

### Role-Based Auth Middleware

`middleware/auth.js` exports two Express middlewares:

- `authenticateToken` — verifies the `Bearer` token from the `Authorization` header using `jwt.verify()`. Attaches `{ id, email, role }` to `req.user`. Returns 401 on missing or invalid token.
- `authorizeRoles(...roles)` — factory middleware that checks `req.user.role` against the allowed list. Returns 403 on mismatch.

Trainer-only routes are protected with `authorizeRoles('trainer', 'admin')`. Routes accessible by any authenticated user (clients reading their own data, logging workouts, etc.) use only `authenticateToken`.

### Module Separation

The trainer dashboard and client dashboard are served from separate HTML shells (`trainer-dashboard.html` and `client-dashboard.html`) loaded by `app.js` based on the user's `role` field after login.

---

## Getting Started

### Prerequisites

- Node.js 18+
- MongoDB (local instance or MongoDB Atlas)
- A [Resend](https://resend.com) account + API key (for sending invite, password-reset, and welcome emails)
- A USDA FoodData Central API key (optional — `DEMO_KEY` works for light usage)
- An [Anthropic](https://console.anthropic.com) API key (optional — only needed for the AI nutrition features)

### Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd FitBySuarez-navbar-dashboard

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env

# 4. Fill in the required values in .env (see table below)
#    At minimum: MONGO_URI, JWT_SECRET, ADMIN_SEED_PASSWORD, RESEND_API_KEY

# 5. Start the server
npm start
```

The server starts on `http://localhost:3000` (or the `PORT` in your `.env`).

On first boot, if no trainer account exists in the database, the server automatically seeds one:
- **Email:** `fitbysuarez@gmail.com`
- **Password:** whatever you set in `ADMIN_SEED_PASSWORD`
- **Role:** `trainer`

Change the password immediately after first login.

---

## Environment Variables

All variables are defined in `.env.example`. Copy it to `.env` and fill in real values — never commit `.env` to version control.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGO_URI` | Yes | `mongodb://localhost:27017/fitbysuarez` | MongoDB connection string. Use `mongodb+srv://...` for Atlas. |
| `JWT_SECRET` | Yes | `CHANGE_ME_IN_PRODUCTION` | Secret used to sign and verify JWT tokens. Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Rotate before going to production. |
| `ADMIN_SEED_PASSWORD` | Yes | _(none)_ | Temporary password for the auto-seeded trainer account. Only used on first boot. Change immediately. |
| `APP_URL` | Yes | `http://localhost:3000` | Public URL of the app. Used in invite links and password-reset emails. Set to your production domain in prod. |
| `CORS_ORIGIN` | No | Same as `APP_URL` | Allowed origin for CORS. Should match `APP_URL` in most setups. |
| `RESEND_API_KEY` | Yes | _(none)_ | API key for [Resend](https://resend.com); sends all transactional email (invite, password reset, welcome). From address: `FitBySuárez <noreply@fitbysuarez.com>`. |
| `ANTHROPIC_API_KEY` | For AI | _(none)_ | Anthropic key powering the meal recommender and text food logging. Leave blank to disable both. |
| `MEAL_SUGGESTION_ENABLED` / `FOOD_NLP_ENABLED` / `EQUIPMENT_CHECK_ENABLED` | No | `true` | Feature flags for the three AI features (meal recommender, text food logging, trainer equipment check). Set to `false` to keep a feature dark (e.g., until launch). See [Dormant Features](#dormant-features-built-activated-at-launch). |
| `MEAL_DAILY_LIMIT` / `FOOD_NLP_DAILY_LIMIT` / `EQUIPMENT_CHECK_DAILY_LIMIT` / `MEAL_MONTHLY_LIMIT` | No | `5` / `20` / `50` / `3000` | AI usage caps — per-user/day caps plus a shared global monthly cap. |
| `PORT` | No | `3000` | Port the Express server listens on. |
| `DEBUG` | No | `false` | Set to `true` locally to enable verbose logging (email config, notification creation). Never enable in production. |

> Image storage (Cloudinary), payments (Stripe), and food-data APIs (USDA, Nutritionix) have their own keys — all documented in `.env.example`.

---

## API Routes

All routes beginning with `/api/` are JSON endpoints. Routes marked **Trainer** require `Authorization: Bearer <token>` from an account with `role: 'trainer'`. Routes marked **Auth** require any valid JWT.

### Authentication

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/login` | Public | Log in with email + password. Returns JWT + user object. |
| `POST` | `/api/auth/register` | Public | Always returns 403 — public registration is disabled. |
| `POST` | `/api/auth/forgot-password` | Public | Send a password-reset link to the given email (1-hour expiry). |
| `POST` | `/api/auth/reset-password` | Public | Consume a reset token and set a new password. |
| `GET` | `/api/auth/invite-info` | Public | Return the name and email for a valid invite token (for pre-filling the activation form). |
| `POST` | `/api/auth/accept-invite` | Public | Activate account via invite token; set password; returns JWT for auto-login. |
| `POST` | `/api/auth/update-password` | Auth | Change password for the currently authenticated user. |

### User Profile

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/me` | Auth | Fetch the current user's full profile (excludes password and reset tokens). |
| `PUT` | `/api/me` | Auth | Update allowed profile fields: name, lastName, unitSystem, timezone, profilePicture, servingUnit, macroGoals. Trainers can also update `paymentHandles`. |

### Clients

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/clients` | Trainer | List all non-deleted clients, sorted newest first. |
| `POST` | `/api/clients` | Trainer | Create a new client account with a secure invite token; sends invite email automatically. |
| `PUT` | `/api/clients/:id` | Trainer | Update any client field. Triggers `program_assigned` notification if program changes. |
| `DELETE` | `/api/clients/:id` | Trainer | Soft-delete a client (sets `isDeleted: true`). |
| `POST` | `/api/clients/:id/resend-invite` | Trainer | Generate a fresh 7-day invite token and resend the invite email. |

### Email

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/send-welcome` | Trainer | Send a legacy welcome email with temporary credentials (pre-invite-system flow). |

### Exercise Library

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/library` | Auth | List all exercises sorted alphabetically. |
| `POST` | `/api/library` | Trainer | Create or update an exercise (upsert by name, case-insensitive). |

### Programs

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/programs` | Auth | List all programs sorted newest first. |
| `POST` | `/api/programs` | Trainer | Create a new program. |
| `PUT` | `/api/programs/:id` | Trainer | Update program name, description, tags, or weeks. |
| `DELETE` | `/api/programs/:id` | Trainer | Permanently delete a program. |

### Client Workouts

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/client-workouts/:clientId` | Auth | List all workouts for a client, sorted by date. |
| `GET` | `/api/client-workouts/:clientId/:date` | Auth | Get a single workout by client ID and date (`YYYY-MM-DD`). |
| `POST` | `/api/client-workouts` | Auth | Create or replace a workout for a client on a given date (upsert). Triggers `workout_completed` notification when a client saves. |
| `PATCH` | `/api/client-workouts/:clientId/:date` | Auth | Partial update — used for marking complete/missed, submitting RPE, autosave. Triggers notifications on state transitions only. |
| `DELETE` | `/api/client-workouts/:clientId/:date` | Trainer | Delete a workout entry. |

### Workout Logs (Legacy)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/log` | Auth | Log an individual exercise as completed/incomplete (granular per-exercise tracking). |
| `GET` | `/api/log/:clientId` | Auth | Fetch all workout log entries for a client. |

### Nutrition

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/nutrition-logs/:clientId` | Auth | Fetch up to 100 nutrition logs for a client, newest first. |
| `POST` | `/api/nutrition-logs` | Auth | Create or update a daily nutrition log (upsert by clientId + date). Triggers `nutrition_logged` notification when a client saves. |
| `DELETE` | `/api/nutrition-logs/:logId` | Auth | Delete a nutrition log. Client can only delete their own; trainer can delete any. |
| `GET` | `/api/food-search` | Auth | Search foods. Checks local Spanish-language database first; falls back to USDA FoodData Central API. |

### Weight / Metrics

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/weight-logs/:clientId` | Auth | Fetch up to 100 weight log entries for a client, newest first. |
| `POST` | `/api/weight-logs` | Auth | Create or update a weight log entry (upsert by clientId + date). Triggers `weight_update` notification when a client saves. |

### Body Measurements

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/body-measurements/:clientId` | Auth | Fetch all body measurement records for a client. |
| `POST` | `/api/body-measurements` | Trainer | Record a new body measurement session. |
| `DELETE` | `/api/body-measurements/:id` | Trainer | Delete a measurement record. |

### Progress Photos

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/progress-photos/:clientId` | Auth | Fetch up to 50 progress photos for a client, newest first. |
| `POST` | `/api/progress-photos` | Auth | Upload a new progress photo (base64 image data). Triggers `progress_photos` notification when a client uploads. |
| `DELETE` | `/api/progress-photos/:id` | Trainer | Delete a progress photo. |

### Payments / Invoices

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/payments` | Trainer | List all invoices for the trainer, with client name populated. |
| `GET` | `/api/payments/client/:clientId` | Trainer | List all invoices for a specific client. |
| `POST` | `/api/payments` | Trainer | Create a new invoice. |
| `PATCH` | `/api/payments/:id` | Trainer | Update invoice fields (status, method, paidDate, amount, notes, etc.). Auto-sets `paidDate` when status changes to `paid`. |
| `DELETE` | `/api/payments/:id` | Trainer | Delete an invoice. |
| `POST` | `/api/payments/:id/invoice` | Trainer | Send a branded invoice email to the client with payment method deep links. |

### Groups

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/groups` | Auth | List all client groups sorted alphabetically. |
| `POST` | `/api/groups` | Trainer | Create a new group. |
| `DELETE` | `/api/groups/:id` | Trainer | Delete a group. |

### Notifications

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/notifications` | Auth | Paginated notifications for the trainer, newest first. Query: `skip`, `limit` (default 30, max 100), `filter` (`unread` / `7days`, applied server-side). Returns `{ notifications, hasMore }` for "Cargar más" infinite-scroll. |
| `GET` | `/api/notifications/unread-count` | Auth | Return the count of unread notifications (used for the bell badge). |
| `PUT` | `/api/notifications/read-all` | Auth | Mark all notifications as read. |
| `PUT` | `/api/notifications/:id/read` | Auth | Mark a single notification as read. |

### Equipment

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/equipment` | Auth | Fetch the current user's equipment inventory. |
| `PUT` | `/api/equipment` | Auth | Save the current user's equipment inventory. When a client saves, fires a throttled `equipment_updated` notification to the trainer. |
| `POST` | `/api/equipment-check` | Trainer | 🤖 **Dormant** (flag: `EQUIPMENT_CHECK_ENABLED`). AI-checks a list of exercises against a client's equipment; returns per-exercise flags for missing equipment or over-budget weights. Short-circuits if the client has no inventory (`noEquipment`) or has the check toggled off (`disabled`). |

### Blog

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/blog` | Public | List published posts, newest first. Returns `publishedAt` + `updatedAt` so the public page can show both dates. |
| `GET` | `/api/blog/all` | Trainer | List every post, including unpublished drafts. |
| `GET` | `/api/blog/:slug` | Public | Fetch a single published post by its slug. |
| `POST` | `/api/blog` | Trainer | Create a post (auto-generates a unique slug; stamps `publishedAt` if published on creation). |
| `PATCH` | `/api/blog/:id` | Trainer | Update a post. **Preserves the original `publishedAt`** (stamped only on first publish); `updatedAt` auto-bumps via Mongoose timestamps. |
| `DELETE` | `/api/blog/:id` | Trainer | Delete a post. |

---

## Database Schemas

### `User`
Core model for both trainers and clients. Notable fields:
- `role` — `'trainer'` or `'client'`
- `isFirstLogin` — flags the forced password-change flow on initial login
- `isDeleted` — soft-delete flag; deleted clients are excluded from list views but preserved in the database
- `inviteToken` / `inviteExpires` — hashed one-time invite token for account activation
- `resetPasswordToken` / `resetPasswordExpires` — hashed token for the forgot-password flow
- `macroSettings` — trainer-set goal type and macro ratios; client-editable gram targets stored as `goalProtein`, `goalCarbs`, `goalFat`
- `paymentHandles` — trainer's ATH Móvil, Venmo, and PayPal handles used to generate invoice payment links
- `equipment` — free-form Mixed object storing the client's available gym equipment
- `equipmentCheckOn` — per-client toggle (default `true`) for the dormant AI equipment check; when `false` the check is skipped for that client
- `emailPreferences` — per-user toggles for automated email types
- `thr` / `mahr` — Target Heart Rate and Maximum Aerobic Heart Rate, trainer-set for cardio programming
- `unitSystem` (`'imperial'` | `'metric'`) and `servingUnit` (`'g'` | `'oz'`) — client display preferences

### `Exercise`
The global exercise library. Each exercise has a unique `name`, optional `videoUrl`, an array of `category` tags (muscle groups), and `instructions` text.

### `ClientWorkout`
A single workout assigned to a specific client on a specific date. Key fields:
- `isRest` / `restType` — marks the day as a rest or active-rest day
- `warmup` / `warmupVideoUrl` / `cooldown` — text and video for the session warm-up/cool-down
- `exercises` — ordered array with name, instructions, video URL, and superset flag
- `isComplete` / `isMissed` — client-toggled status flags
- `rpe` — client's perceived exertion rating (1–10)
- Compound unique index on `{ clientId, date }` — one workout document per client per day

### `Program`
A reusable training template. Structured as an array of weeks, each containing a `Map` of day keys to day data (exercises, rest flags, etc.). Programs can be assigned to multiple clients via the `program` field on `User`.

### `WorkoutLog`
Granular per-exercise completion log (legacy, pre-dates `ClientWorkout`). Tracks which individual exercises within a session were marked done.

### `NutritionLog`
Daily nutrition entry per client. Stores macro totals (calories, protein, carbs, fat, water), mood, notes, and a nested `meals` object keyed by meal slot (breakfast, lunch, dinner, snacks, etc.).

### `WeightLog`
Time-series weight and body fat entries. One document per client per date, with optional `bodyFat` percentage and freeform `notes`.

### `BodyMeasurement`
Circumference and composition measurements recorded by the trainer. Fields: `pecho` (chest), `biceps`, `cintura` (waist), `cadera` (hips), `quads`, `calves`, plus `weight`, `bodyFat`, and `bmi`.

### `ProgressPhoto`
Base64-encoded progress photos. Categorized (`'front'`, `'back'`, `'side'`, `'general'`). Capped at 50 per client in list queries.

### `Notification`
Activity feed entries directed at the trainer. Each notification has a `type` (one of the defined event types — workout/nutrition/weight/photo activity, new clients, plus `equipment_updated` and `muscle_restriction`), `clientId`, `clientName`, `title`, `message`, optional `data` payload, and `isRead` flag. Indexed on `{ trainerId, isRead, createdAt }` for fast unread queries.

### `Group`
Simple named cohort. Groups appear as filter options on the client list and can be assigned to clients for segmentation.

### `Payment`
Invoice record linking a client to the trainer. Fields: `amount` (USD), `status` (`'pending'` | `'paid'` | `'overdue'`), `method` (payment platform used), `periodLabel` (display period, e.g. "Mayo 2026"), `dueDate`, `paidDate`, and `notes`. `paidDate` is auto-set when status transitions to `'paid'`.

### `BlogPost`
Educational/marketing articles authored by the trainer and rendered on the public site. Fields: `title`, `slug` (unique, auto-generated), `category`, `excerpt`, `content` (a safe Markdown subset — links, bold, italic, bullet/numbered lists — rendered client-side with HTML escaping + http(s)-only links), and `published`. `publishedAt` is stamped once on first publish and never overwritten on later edits; `createdAt`/`updatedAt` are auto-managed (`timestamps: true`), letting the public page show a publish date plus an "updated" date when a post is edited well after publishing.

---

## Role System

There are two roles: `trainer` and `client`. The trainer role is also compatible with `admin` checks throughout the codebase (any route guarded by `authorizeRoles('trainer', 'admin')` will accept either).

### Trainer Capabilities
- Full CRUD on all client accounts
- Full CRUD on all programs, exercises, workouts, groups, payments
- Read access to all client data (nutrition, weight, photos, measurements, workout logs)
- Send invite and invoice emails
- Configure payment handles on their own profile
- Record body measurements for clients
- View and manage the notification feed

### Client Capabilities
- Read and log their own workouts (mark complete/missed, submit RPE)
- Log their own nutrition, weight, and progress photos
- View their own payment history (read-only)
- Update their own profile (name, unit preferences, profile picture, macro gram goals)
- Manage their own equipment inventory
- Read the exercise library and assigned programs

Clients cannot see other clients' data, cannot create/edit programs, cannot manage invoices, and cannot access the notification feed.

---

## Email System

All outgoing mail is sent via the [Resend](https://resend.com) HTTP API (`RESEND_API_KEY`) — SMTP is avoided because Railway blocks it. The from address is `FitBySuárez <noreply@fitbysuarez.com>`. Emails are dark-themed HTML with the FitBySuárez gold branding.

| Trigger | Recipient | Description |
|---|---|---|
| New client created (invite flow) | Client | Account activation email with a 7-day invite link and a CTA button. |
| Trainer resends invite | Client | Fresh 7-day invite link. |
| Forgot password request | User | Password-reset link valid for 1 hour. The stored token is SHA-256 hashed; only the raw token travels in the email. |
| Trainer sends invoice | Client | Branded invoice email showing the period, amount, due date, and deep-link payment buttons for each configured payment method. |
| Legacy welcome email (`/api/send-welcome`) | Client | Plain credentials email from the pre-invite flow. Kept for backward compatibility. |

Email delivery failures on client creation do not fail the request — the client account is still created and the trainer receives the raw invite link in the API response to share manually.

---

## Payments System

Invoices are created by the trainer per client per billing period. Each invoice has:
- A dollar amount and an optional period label (e.g. "Mayo 2026")
- A due date
- A status: `pending`, `paid`, or `overdue`
- A payment method field (recorded after payment: `ath_movil`, `venmo`, `paypal`, `cash`, `other`)
- Optional notes

When the trainer clicks "Send Invoice Email," the server fetches the trainer's saved `paymentHandles` and generates a branded email with up to three payment method sections:

- **ATH Móvil** — displays the business name/handle and instructs the client to search for it in ATH Móvil Business
- **Venmo** — deep link to `venmo.com/@handle?txn=pay&amount=XX.XX` pre-filled with the invoice amount and period label
- **PayPal** — deep link to `paypal.me/username/XX.XX`

Only payment methods with a configured handle are shown. If no handles are configured, the email instructs the client to contact the trainer directly.

The trainer marks invoices paid manually after receiving confirmation. Marking an invoice `paid` automatically records today's date as `paidDate`. Unmarking it clears `paidDate`.

---

## Future Roadmap

- **Stripe integration** — automated recurring billing, payment capture directly in the platform, and automatic status transitions without manual confirmation
- **Mobile app** — React Native or PWA wrapper so clients can log workouts and nutrition from their phones with offline support and push notifications
- **Automated email reminders** — scheduled emails for upcoming payment due dates, missed workout follow-ups, and weekly progress summaries
- **Video uploads** — direct in-app video recording and upload for exercise form checks (currently only YouTube/external URLs are supported)
- **Multi-trainer support** — expand the role model to support multiple coaches under one organization, each with their own client roster
- **Calendar integration** — export scheduled workouts to Google Calendar or Apple Calendar via iCal feed
- **AI workout generation** — use client metrics, goals, and available equipment to suggest personalized workouts for the trainer to review and assign
