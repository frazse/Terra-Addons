## 1.2.2
- Move FD up/down buttons to the left side and RD up/down buttons to the right side of the gear HUD, reducing vertical height in `.road-middle`

## 1.2.1
- Replace Biketerra's `.road-readout` gear pill in-flow inside `.road-middle` so the native `.lap-counter` (and workout step readout) stacks cleanly above the gear HUD without being covered
- Mirror Biketerra's in-ride Rider Stat HUD styling (`--overlay-4`, borderless, crisp `#fff` / `--white-4` typography, no `backdrop-filter`) and convert all dimensions to `rem` so the widget scales with Biketerra's Text Size setting
- Improve ERG mode detection for Biketerra's `.road-readout` target-power pill (`200 W`)

## 1.2.0
- Detect ERG mode and anchor HUD to the native Gear element

## 1.1.0
- Support shifter buttons alongside the Zwift Ride addon
- Initial realistic multi-chainring & cassette simulation
