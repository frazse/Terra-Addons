## 1.2.0
- Add a tilted-slope grade background to the Karoo Climber current-grade pill that dynamically angles (`atan(grade)`) and colors to match the live gradient
- Add a live Draft progress bar on the left side of the Karoo Climber header (matching Biketerra's original left-side Draft / right-side Grade layout)
- Optionally hide Biketerra's built-in Grade & Draft circles above the elevation profile while docked (keeping `.road-middle` centered and automatically restoring native dials if hidden or undocked)

## 1.1.0
- Dock Karoo Climber seamlessly into Biketerra's `.panel-profile` directly above `.elev-graph` (with automatic floating fallback when the elevation profile is hidden or replaced by a workout chart)
- Match Biketerra's in-ride HUD styling (shared `.bg-dark` / `--overlay-4` glass, borderless controls, `--font` Overpass & `--font-mono` tabular numerals, no `backdrop-filter`) and scale all dimensions in `rem` with Biketerra's Text Size setting
- Make the 500m Karoo color-block ticker DPI- and width-aware so it stays crisp across the full elevation bar

## 1.0.0
- Initial release of Karoo Climber HUD overlay with live climb detection and zoomable elevation profile
