## 0.3.1
- Match Biketerra's in-ride HUD styling (`--overlay-4`, borderless, `--font` Overpass & `--font-mono` tabular numerals, `--white-4`/`--white-3` labels, no `backdrop-filter`) and scale all dimensions in `rem` with Biketerra's Text Size setting
- Reserve fixed `rem` slot widths per enabled metric so the FPS box stays a constant width as numbers fluctuate (resizing only when metrics are toggled)

## 0.3.0
- Display `base/framegen fps` when frame generation is active
- Add CPU/GPU hardware telemetry & Biketerra 3D engine render/scene stats

## 0.2.0
- Avoid overlapping the screenshot button and add optional frame time, 1% low, hitch, memory, and resolution metrics

## 0.1.0
- Initial FPS overlay
