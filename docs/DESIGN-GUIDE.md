# FitBySuárez — design guide

How Angel wants things to look. **Read this before any UI work.** Where it is silent, keep matching
the existing brand and decide without asking: Angel delegated styling to Claude (2026-10-05).

## Baseline (already in the product)

- Gold `#FFDB89` on near-black `#030303`. The day's secondary routine is sky `#7DD3FC` (§ 38).
- No emoji in the interface. Spanish strings.
- Web = mobile: a design change lands in both.
- A new Tailwind class needs `npm run build:css`, or it ships unstyled.

---

## Live-session call screen

**Status:** parked. Video calls are switched off (`LIVE_SESSIONS_ENABLED`, TECHNICAL.md § 40) until
the app relaunches. This is the intended design for when they return.

**Reference:** `docs/design-refs/call-screen-reference.jpg`. Angel annotated it: blue and red
rectangles mark the regions, and the percentages below are his.

### The three regions

| Region | Share of screen | Shows |
|---|---|---|
| **Large tile** (right in the reference) | ~50% | **The other person.** The biggest thing on screen. |
| **Red box** | ~30% | **The user themself** — their own camera. |
| **Blue box** | ~20% | **The current exercise** being worked on. |

Reading of the reference, beyond Angel's note: rounded-corner tiles, translucent glass panels over a
dark ground, name + role captions on each tile, a floating control bar (mic, camera, audio, hang up
in red) at the bottom of the large tile, and small utility buttons stacked on its right edge.

Why the self-view is as large as 30% is presumably the point: in a coaching call the client
watching their own form is useful, like a mirror. That is a reason to keep it big rather than
shrink it to a picture-in-picture.

### What this changes about today's screen

Today (`public/live-session.js`): the remote video fills the screen (`absolute inset-0`) and the
local preview is a small picture-in-picture. The reference replaces both with a tiled layout.

### Decisions (answered by Angel, 2026-10-05)

1. **Portrait uses Claude's proposal, landscape uses Angel's reference.** Portrait: the other
   person on top (~50% of the height); you and the current exercise side by side below
   (30 / 20 of the area); controls floating over the big tile. Landscape: the other person on
   the right, the exercise above you on the left.
2. **The trainer advances the exercise.** The client's tile is read-only and follows live.
3. **The routine shown is the one the CLIENT chose** (`chosenBlock`) — the client knows where the
   session is happening, gym or home. Labelled Principal or Secundaria.
4. **The exercise tile shows what the trainer wrote under the exercise name**, verbatim —
   e.g. "Toca la silla/sofá y regresa arriba. 3 sets de 12 repeticiones." (the `instructions`
   field; line breaks are kept).
5. **Build both web and phone.** Testing deferred; changes will be made directly.

### Status

| | State |
|---|---|
| Web call screen (`public/live-session.js`) | **Built and tested** — a real two-tab call, trainer + client, both orientations, stepping, routine switch mid-call, reconnect replay, empty state |
| Server (`signaling.js`, `call:exercise`) | **Built and tested** — 26 checks |
| Phone call engine (`FitBySuarez-mobile/lib/live/session.ts`) | **Built, tested against the real server with a fake peer connection** — 66 checks. NOT tested with a real camera |
| Phone screens (`components/live/*`) | **Built, typechecked, bundled by Metro. Never seen on a screen.** |
| Everything | **Off** (`LIVE_SESSIONS_ENABLED`). Native side also needs a development build |

### How the layout is pinned

The share of the screen each tile gets is the same number on web and phone, by construction and
by test: a 375×812 portrait screen measures 45.6 / 26.6 / 17.7 % of the screen (50.7 / 29.6 /
19.7 of the tile area — the 10px gap between two tiles is why it is not exactly 50/30/20) in a
real browser, and `computeLayout()` on the phone reproduces it to the decimal.

On a phone the app is portrait-locked (`app.json`), so the landscape arrangement exists in code
but cannot appear until rotation is allowed during calls — see TECHNICAL.md § 41.

### Not decided here

Colours inside the call screen (assume the brand baseline above), animation, and the ringing
screen.
