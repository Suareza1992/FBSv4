# FitBySuárez — Admin Guide

Operational how-tos for running the platform. Each entry says **which repo** it
runs in, since the project spans two:

- **web** — `FitBySuarez-navbar-dashboard` (site + API + database scripts)
- **mobile** — `FitBySuarez-mobile` (Expo app)

---

## 1. How to add intro clips  *(mobile)*

Short clips that play once per app launch, one picked at random.

1. Drop files in `assets/videos/intro/` — e.g. `intro-1.mp4`
2. Uncomment the matching line in `lib/introVideos.ts`

```ts
export const INTRO_VIDEOS: number[] = [
  require('../assets/videos/intro/intro-1.mp4'),
  require('../assets/videos/intro/intro-2.mp4'),
];
```

**Why it's manual:** React Native resolves `require()` at build time, so a folder
cannot be scanned at runtime. The list has to be written out.

**Rules of thumb**
- Keep clips **under 5 seconds**.
- They ship **inside the app binary** — 5 clips × 3 MB = +15 MB for every user.
  Target 1080×1920 portrait, H.264, 2–4 MB each.
- Leave the list empty and the intro is skipped entirely; the app launches
  straight through. Safe to ship with no clips.
- Clips are **muted** by design and dismiss on: video end, a 6-second timeout, or
  a tap — whichever happens first.

---

## 2. How to add a trainer  *(web)*

**Entrenadores → Añadir entrenador.** They get an invite email (link valid 7 days),
start with zero clients, and can only ever see their own.

Only you can do this — the section is superadmin-only.

---

## 3. How to move a client to another trainer

- **web** — open the client → **Entrenador asignado** dropdown → save.
- **mobile** — **long-press** a client in Clientes → pick the new trainer.

Superadmin-only in both places. The previous trainer loses access immediately.

---

## 4. How to tag exercises  *(web)*

Tags power search, the library filter chips, and the "same muscle group" swap.

- **By hand:** Programas → Librería → pencil on a row → toggle tag pills → save.
- **In bulk:** run the auto-tagger (dry run first — it prints what it would do):

```bash
node scripts/tag-exercises.mjs            # preview, writes nothing
node scripts/tag-exercises.mjs --apply    # writes
```

Only touches exercises still tagged `General`, so anything you tagged by hand is
never overwritten. Safe to re-run.

---

## 5. Who can edit what

| Thing | Read / use | Create | Edit / delete |
|---|---|---|---|
| **Exercises** (library) | every trainer | every trainer | **creator or you** |
| **Programs** | owner only | every trainer | **owner or you** |
| **Clients** | own only | every trainer | own only (you: all) |

You (superadmin) can do anything. Trainers cannot see each other's clients or
programs at all.

An exercise another trainer created shows a **lock** instead of an edit pencil —
it can still be used in routines, just not modified.

---

## 6. One-time setup scripts  *(web)*

All are **dry-run by default**; add `--apply` to write. All are safe to re-run —
each only touches records that haven't been set yet.

```bash
node scripts/setup-superadmin.mjs        # grant superadmin + claim unowned clients
node scripts/assign-exercise-owners.mjs  # stamp unowned library exercises as yours
node scripts/assign-program-owners.mjs   # stamp unowned programs as yours
```

Run these once after a deploy that introduces the matching feature. They write to
the **production** database (`MONGO_URI` in `.env`).

---

## 7. Deploying

- **web** — push to `main`. Railway auto-deploys; there is no separate step.
  Confirm it landed:
  ```bash
  curl -s https://fitbysuarez.com/app.js | grep -c canEditEx
  ```
  `0` means the old build is still up.

- **mobile** — Expo Go loads from your laptop, so no deploy is needed for testing.
  For a real build see `EAS-BUILD-GUIDE.md` in the mobile repo.

**Splash screen note:** Expo Go shows your *app icon*, never your configured
splash. To see the real splash you need a dev or production build:
```bash
npx expo run:ios
```
