# Discord Rich Presence

While you ride (or spectate) on Biketerra, your Discord profile shows the ride:

```
Riding — Alpine Loop 50          ← route or event name (details)
42.3 km of 50 km                 ← live distance (state)
Elapsed time: 1:12:34            ← Discord's own live line, driven by the start timestamp
```

When you're not riding or spectating it shows what page you're on (no timer):

```
On dashboard                     ← dashboard / login / athletes / …
Browsing routes / events / clubs / challenges
Viewing results                  ← an activity (/activities/<id>) or results page
```

## How it works

The addon runs inside the biketerra.com webview, so it cannot talk directly to
Discord's desktop client (which listens on a local IPC socket:
`/tmp/discord-ipc-*` on Linux, `\\.\pipe\discord-ipc-*` on Windows). The
**Terra core does**:

```
biketerra webview ──ride frames──▶ addon (main.js)
                                       │  terra.discord.* (core.call)
                                       ▼
                                 Terra core (Rust)
                                       │  Unix socket, SET_ACTIVITY (Discord IPC)
                                       ▼
                                Discord desktop client
```

There is no sidecar process and no Node dependency. The core connects to
Discord's local socket itself; the addon only decides *what* to show.

## Setup

1. **Create a Discord application** (one time, ~1 minute):
   - <https://discord.com/developers/applications> > *New Application* > any name.
   - Copy the **Client ID** from *General Information*.
   - Optional: *Rich Presence > Rich Presence Assets* > upload an image (e.g. a
     bike icon, key `bike`) to show as the large icon.

2. **Enable the addon** in Terra (cog menu next to the theme toggle) and set:
   - *Discord application Client ID* — from step 1.
   - *Update interval* — leave 20 s; lower values risk Discord rate-limiting.

3. Make sure **Discord desktop** is running for your user (the core needs its
   local IPC socket). Then that's it.

Riding presence appears when the ride starts moving. Spectating presence appears
on the first broadcast frame (no movement needed). An idle presence ("On
dashboard", "Viewing results", …) appears on any other Biketerra page. All of
these are cleared/replaced when you navigate, the ride-frame stream stops
(15 s of silence), or the addon is disabled. To hide the idle presence, untick
*Show idle presence* in the settings (rides/spectating only).

## Behaviour notes

- **Ride/spectate presence appears the moment you land on the page** — name and
  icon immediately; the distance/state line and the green "Elapsed" timer join
  as soon as the ride is live (movement for rides, first broadcast frame for
  spectating). If you land on the ride page but never start riding, the
  presence drops after a 30 s grace — no fake presence while merely sitting
  there.
- **Idle presence** (anything not a ride/spectate page): shows a
  "what am I doing" line derived from the URL (with a `<title>` fallback) —
  the routes / events / clubs / challenges pages read "Browsing …", an activity
  or results page reads "Viewing results", and everything else (dashboard,
  login, athletes, …) reads "On dashboard". It has no green "Elapsed" timer:
  the clock is reserved for riding/watching. Toggle off in settings to go
  ride/spectate-only.
- **Linux only for now.** Discord desktop exposes a Unix socket here, which the
  core speaks directly. Other platforms return a clear "not available" error so
  the addon just stays quiet.
- Route/event name + length come from the ride's **detail page** — the same
  page the app itself renders:
  - riding a route `/ride?route=<id>` → `biketerra.com/routes/<id>` (`.route-stats`)
  - riding an event `/ride?event=<id>` → `biketerra.com/events/<id>` (`.route-tile_stats`)
  - name from that page's `<title>`, distance from its stats element.
  Fallbacks: `document.title` / URL params for the name, and the
  `__data.json` route geometry for the length (then the ego-derived total).
- The route name is the detail page's real name; the "of X km" total is its
  stats number (so it is correct even when you load or spectate a ride that is
  already partway through). If the page can't be read it falls back to the
  `__data.json` geometry, then to `ego.distance + ego.distanceRemaining`.
- **Spectating** is detected from the `?spectate=1` flag on a `/ride` URL (or a
  `/spectate/…` page) and labeled "Spectating — {route/event}". Its state line
  shows the route context and the rider count (e.g. `34.8 km route · 4 riders`)
  instead of the live distance/spectator-clock — the broadcast ego usually
  doesn't track the spectator moving, so that would look frozen/stuck. The
  green "Elapsed" timer is kept (time spent watching); arms on the first
  broadcast frame.
- Elapsed time is shown in the state line (read from the app's own ride clock)
  for rides and events, and is always handed to Discord as a `start` timestamp
  for its own green timer line.
- The core keeps one persistent Discord IPC socket (re-establishing on the next
  push if it drops), rather than opening a fresh socket every update.
