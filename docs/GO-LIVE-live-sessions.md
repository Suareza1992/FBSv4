# Go-Live: Sesiones en vivo (WebRTC)

Run this before real clients use live sessions. Same shape as
`GO-LIVE-payments-test.md`. Budget ~45 minutes, and you need **two devices**.

> ⚠️ Both platforms hit the **production** database. Use a test client account and
> delete the `callsessions` rows you create — see Cleanup at the bottom.

---

## 0. Before you start

| Need | Why |
|---|---|
| Two devices (laptop + phone) | One leg must be on cellular; a single machine can't prove TURN |
| A test client account | Real calls write real `CallSession` rows |
| Metered account (or another provider) | Without TURN, ~1 call in 6 fails and you won't know why |
| Railway access | To set env vars |

---

## 1. Environment

In Railway → Variables:

```
TURN_APP=<your-subdomain>        # <this>.metered.live
TURN_API_KEY=<key>
```

Optional (defaults shown):

```
RTC_RING_TIMEOUT_MS=45000        # how long an incoming call rings
RTC_GRACE_MS=20000               # reconnect window before a dropped socket ends the call
RTC_INVITE_LIMIT=10              # invites per user per minute (counts rejected ones)
```

Redeploy, then confirm TURN is live — log in on the web app and run in the console:

```js
await (await fetch('/api/rtc/ice', {credentials:'include'})).json()
```

- `turn: true` → good
- `turn: false, degraded: true` → the provider call failed; check the key
- `turn: false` with no `degraded` → env vars not set

---

## 2. The checks

Tick each one. **Do not skip 5 or 6** — they are the two that only fail in the wild.

| # | Test | Expected |
|---|---|---|
| 1 | Trainer calls client, both on the **same Wi-Fi** | Rings, connects, two-way video and audio |
| 2 | Client **declines** | Trainer sees "Llamada rechazada"; Sesiones tab shows **Rechazada** |
| 3 | Don't answer for 45s | Ends as **No contestó**; a notification appears in the trainer's Avisos |
| 4 | Call a client who is **logged out** | Fails **immediately** with "No está disponible", not after 45s |
| 5 | **Trainer on Wi-Fi, client on cellular (Wi-Fi off)** | Connects. This is the case TURN exists for. |
| 6 | **Force relay** (below) | Connects. Proves TURN credentials actually work. |
| 7 | Mid-call, client switches Wi-Fi → cellular | "Reconectando…" then recovers within ~10s |
| 8 | Mid-call, trainer navigates to Programa / Nutrición | Call keeps running; minimise works |
| 9 | Client opens the app in **two tabs**, trainer calls | Both ring; accepting in one stops the other |
| 10 | Hang up from each side in turn | Both sides tear down; **camera light goes out** |
| 11 | Client backgrounds the app mid-call | Trainer sees "La otra persona puso la app en segundo plano" |
| 12 | Check the **Sesiones** tab on the client | Every call above appears with the right status and duration |

### 6. Forcing relay

On **both** devices, in the browser console before calling:

```js
LiveSession._forceRelay(true);
```

Every ICE candidate must now come from TURN. If the call connects, TURN works.
Afterwards:

```js
LiveSession._forceRelay(false);
```

If it **doesn't** connect, TURN is misconfigured — and you've found that at your
desk instead of from a client who couldn't connect.

---

## 3. Permission paths

Worth walking once so you recognise them in a support message:

| Do this | Expected message |
|---|---|
| Deny the camera prompt | "Necesitamos acceso a tu cámara y micrófono…" |
| Open Zoom/Photo Booth, then call | "Otra aplicación está usando tu cámara." |
| Call from a device with no camera | "No encontramos una cámara o micrófono…" |

---

## 4. What to watch in the data

After the run, in MongoDB:

```js
db.callsessions.find().sort({startedAt:-1}).limit(15)
```

Check that `status`, `durationSec` and `connectionType` match what you actually
did. `durationSec` counts from `answeredAt`, **not** from when it started ringing —
a 45-second ring is not 45 seconds of call.

Your real relay rate, once you have a month of usage:

```js
db.callsessions.aggregate([
  { $match: { status: 'ended' } },
  { $group: { _id: '$connectionType', n: { $sum: 1 } } }
])
```

`relay` calls use ~1 GB per hour of paid bandwidth. Everyone quotes 10–20%; this
tells you *your* number.

---

## 5. Cleanup

```js
db.callsessions.deleteMany({ calleeId: ObjectId('<test client id>') })
db.notifications.deleteMany({ type: { $in: ['live_session_missed','live_session_ended'] } })
```

---

## 6. Hard limits to respect

- **One Railway instance only.** `signaling.js` keeps connected peers in process
  memory. Two instances means users on different ones can't find each other and
  calls silently fail to ring. Needs a Redis adapter first — see `TECHNICAL.md` §22.
- **Web only.** The mobile app can't do WebRTC until there's an EAS dev build.
- **Tell clients to hard-reload after a deploy.** A stale tab runs the old
  JavaScript and won't receive calls.
