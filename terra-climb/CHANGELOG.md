## 0.5.0
- **Selectable `processGPX` (Fiets) Climb Detection** — ported Dan Connelly's [`processGPX`](https://github.com/djconnel/processGPX) recursive divide-and-conquer climb detector (`climbRating = dz × |10 × dz / ds|^p`, `simplifyProfile`, `findClimbs`, and 5% peak/valley endpoint stretch). Switch live between **ClimbPro (Standard)** and **processGPX** in settings (`detection_mode`), with configurable steepness power `p` (`0.5` / `1.0` / `1.5` / `2.0`) and sensitivity thresholds (`10 m` / `20 m` / `55 m` @ 10% grade) — HUD, overview, graph overlays, and 3D Start/Summit arches update instantly.
- **Native Biketerra Grade & Draft Colors** — matched Biketerra's exact continuous RGB-interpolated grade ramp (`#0092FF` deep descent → `#66BBFF` → `#60F1AB` flat → `#F4FF00` 5% → `#FF9800` 8% → `#F25A00` 11% → `#CC2020` 14% → `#701010` 18%+) and full-opacity `#6dd44d` Draft gauge color (plus live computed-style sync from Biketerra's native `.gauge.draft .gauge-fill`) across the live pills, climb profile bar, crux/relief markers, shift-ahead callouts, and 3D Start banner mini-profile, with luminance-aware text contrast.

## 0.4.0
- **3D Climb Start & Summit Gantry Arches** — places real depth-tested WebGPU overhead race gantries and slope-conforming painted start / checkered finish road lines above the route at the start and summit of every detected climb (`climb_arches_3d`, enabled by default).
- **Dynamic Mipmapped Overhead Signage** — each Start arch displays its category badge (`HC`, `CAT 1`–`CAT 4`, `WALL`), climb distance, average grade, elevation gain, and a mini color-coded gradient profile; each Summit arch features a checkered `KOM` finish banner with summit elevation and gain, with auto-fitted typography so long stats never clip or overlap.
- **Road-Centerline Alignment & Native Shadows** — aligns gantries cleanly across the road centerline (compensating for right/left-hand lane offset and tight curves) and registers a `pools.misc` shadow-only proxy so nearby gantry towers, trusses, and overhead signs cast real-time directional sun shadows onto the road and riders passing underneath.

## 0.2.2
- Distinguish downhill and rolling routes instead of labeling all climb-free routes as `Flat Route` (shows `Downhill Route` with net elevation drop and average grade, or `Rolling Route` with total ascent when no major climbs are detected).

## 0.2.1
- Fixed the conquered-climb shading overlay appearing ahead of the rider cursor by locking its right edge directly to the live rider marker position.

## 0.2.0
- Initial release of Terra ClimbPro: single-row docked HUD in Biketerra's elevation panel with live Draft bar, tilted-slope Grade indicator, native road dial replacement, and automatic climb categorization (`HC`, `CAT 1`–`CAT 4`, `WALL`, `CLIMB`).
- Mountain Stage Roadmap overlays directly on Biketerra's zoomed elevation graph: conquered-portion dimming behind the cursor, approach-only `START` hairline, checkered `TOP` summit line, Tour-style `km-to-summit` milestone ticks, and automatic steepest `▲ Crux` & `▼ Relief` breather pins.
- Live VAM-based Time to Summit (`eta`) estimator and time-adaptive quiet shift-ahead callout (`↗`, `↘`, `TOP in ...`) plus 4.5s `SUMMIT ✓` celebration hold.
- Interactive All-Climbs Route Overview: opening `Climbs (N)` smoothly zooms out to the full route and highlights every climb with category badges, pixel-aware 2-row staggered length/grade chips, hover sync, and click-to-inspect zoom; closing `Climbs (N)` zooms back into the active climb.
