# Part 6 — The mobile app (Expo / React Native)

[← Signup & payments](05-self-serve-signup-and-payments.md) · [Index](README.md)

---

A native companion app for iOS/Android, in its **own repo** (`FitBySuarez-mobile`). It is a **client of the same backend** — it talks to `https://api.fitbysuarez.com` over HTTPS and shares no code with the web app. Everything the API already enforces (auth, ownership, roles) protects the app for free; the app is "just another front-end."

> **Read the versioned Expo docs before writing code.** Expo changes a lot between SDKs. This app is pinned to **SDK 54** (not "latest") because that's what the installed Expo Go supports — bumping it broke the device. Always check `https://docs.expo.dev/versions/v54.0.0/`.

---

## 31. Stack & structure

- **Expo SDK 54**, **expo-router 6** (file-based routes, typed routes), React 19, TypeScript.
- Routes live in **`app/`** at the repo root (not `src/app/`). The `@/` alias points at the repo root.
- `ThemeProvider`/`DarkTheme` come from `@react-navigation/native` (not expo-router).

```
app/
  _layout.tsx                  // root: ThemeProvider + AuthProvider + Stack.Protected guards
  sign-in.tsx                  // the only public screen
  (app)/
    _layout.tsx                // Stack: the tabs + full-screen detail routes
    (tabs)/_layout.tsx         // role-aware bottom tabs
    (tabs)/{index,hoy,nutricion,progreso,perfil,clientes,notificaciones}.tsx
    cliente/[id].tsx           // trainer → client detail + workout builder
    {equipo,pagos,programa,ajustes,facturacion,biblioteca,blog}.tsx  // pushed detail screens
components/DateNav.tsx          // shared day-stepper
lib/{api,auth,date}.ts          // API client, auth context, local-date helpers
```

---

## 32. Cookie auth (no token juggling)

The web login sets an **HttpOnly `auth_token` cookie** and *omits the token from the JSON body*. React Native's native networking persists and resends that cookie automatically — so the app never sees or stores a token. The entire client is one `fetch` wrapper:

```ts
export const API_BASE_URL = 'https://api.fitbysuarez.com';
export async function apiFetch(path: string, opts: RequestInit = {}) {
  return fetch(`${API_BASE_URL}${path}`, { credentials: 'include', ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}
export const getMe = async () => { const r = await apiFetch('/api/me'); if (!r.ok) throw new Error('No autorizado'); return r.json(); };
```

`AuthProvider` (`lib/auth.tsx`) exposes `user`, `session` (`!!user`), `signIn`, `signOut`, `refreshUser`. On launch it calls `getMe()` once — the cookie restores the session. The root layout guards routes:

```tsx
<Stack.Protected guard={!!session}><Stack.Screen name="(app)" /></Stack.Protected>
<Stack.Protected guard={!session}><Stack.Screen name="sign-in" /></Stack.Protected>
```

**Gotcha:** the login route returns the user in `{ user }` but **no `token`** — an app that expects `data.token` will think login failed. Trust the cookie; just call `getMe()` after a successful `POST /api/auth/login`.

---

## 33. Role-aware tabs

One tab bar serves both roles; tabs for the wrong role are hidden with `href: null` (the route still exists, it just isn't shown).

```tsx
const isTrainer = user?.role === 'trainer' || user?.role === 'admin';
// client-only:
<Tabs.Screen name="hoy"        options={{ href: isTrainer ? null : undefined }} />
// trainer-only:
<Tabs.Screen name="clientes"   options={{ href: isTrainer ? undefined : null }} />
```

| | Client tabs | Trainer tabs |
|---|---|---|
| Bottom bar | Inicio · Hoy · Nutrición · Progreso · Perfil | Inicio · Clientes · Avisos · Perfil |
| Pushed screens | programa, ajustes, equipo, pagos | cliente/[id] (+ workout builder), facturación, biblioteca, blog |

`Inicio` is a shared dashboard that branches on role (client: today's workout + nutrition snapshot; trainer: client count + unread avisos).

---

## 34. Screen inventory (what maps to which API)

**Client**
- **Hoy** — `GET/PATCH /api/client-workouts/:id/:date`; complete/missed/RPE with optimistic updates. A "Mi programa" button opens **programa** (full history + adherence % from `GET /api/client-workouts/:id`).
- **Nutrición** — today's log; food search (`/api/food-search`), **additive water** (§ below), **saved combos** (`/api/saved-meals`), and a **macro calculator** whose deficit/surplus pills live-update remaining calories.
- **Progreso** — weight logging (`POST /api/weight-logs`, auto-notifies the trainer), a dependency-free weight-trend chart, and photo upload (expo-image-picker → base64 data-URI).
- **Perfil → Ajustes** — units, dietary preferences, and the injury/muscle-restriction picker (`PUT /api/me`; only sends `injuredMuscles` when touched, to avoid spurious trainer alerts).

**Trainer**
- **Clientes → cliente/[id]** — history/metrics/equipment tabs, plus a **workout builder** (assign/edit a `ClientWorkout` for a date → `POST /api/client-workouts`; trainers pass `assertOwnership`).
- **Facturación** — full invoicing over `/api/payments*` (create, mark paid, email invoice, delete) + a payment-handles editor.
- **Biblioteca** — exercise library CRUD (`/api/library`). **Blog** — post editor (`/api/blog`, `/blog/all` for drafts).

---

## 35. Shared patterns

- **Local dates, never UTC** — `lib/date.ts` mirrors the web helper (`getTodayStr`, plus `shiftDateStr`/`prettyDate` for the **DateNav** day-stepper used in Hoy & Nutrición; forward is capped at today).
- **Additive water** — the oz field *adds to* the day's total (clients are lazy: type "16", hit Añadir, done) and auto-clears; drops live-preview the would-be total while typing. Same UX as the web tweak.
- **Optimistic writes** — toggle state locally, fire the `PATCH`, reload from server only on failure.
- **Tolerate undeployed backends** — screens accept both old and new response shapes (e.g. notifications as a bare array *or* `{ notifications, hasMore }`).

---

## 36. Signup & store policy

New clients **sign up and pay on the website** ([Part 5](05-self-serve-signup-and-payments.md)); the app is **sign-in only**, with a "¿Nuevo aquí? Crea tu cuenta" link that opens `fitbysuarez.com/signup.html`.

**Why:** Apple/Google require digital subscriptions sold *inside* an app to use their In-App Purchase (15–30% cut). Selling coaching through a Stripe/PayPal paywall in the iOS app risks rejection (guideline 3.1.1). Charging on the web and having the app only authenticate sidesteps IAP entirely — no cut, no rejection risk. If in-app purchase is ever required, that's a separate RevenueCat/StoreKit build.

**Deploying the app** is *not* a server deploy: ship JS via Expo (OTA update) or cut a native build with EAS for the App Store / Play Store (the $99/$25 fees). The **backend** still deploys from this repo (Railway).

[← Signup & payments](05-self-serve-signup-and-payments.md) · [Index](README.md)
