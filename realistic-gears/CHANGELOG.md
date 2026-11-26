## 1.3.0
- Auto-switch to sequential ratio shifting (lowest to highest gear across your configured chainrings and cassette) when Zwift Click / Click v2 is connected without a Zwift Ride
- Fix `isZwiftRideConnected()` mistakenly matching the virtual `Zwift Ride (OBC)` device (`zwift-ride-obc-mock`), allowing Click v2 `W`/`S` shifters to drive `realistic-gears` cleanly
- Require trainer FTMS (`0x1826`) or CPS (`0x1818`) service and exclude Zwift controllers before binding `00000003-19ca` so `04 2a` trainer resistance commands are never written to Zwift Click pods
- Display sequential gear step (`SEQ · 2x12` and `14/24`) in the HUD and add `sequential_mode` setting (`auto` / `always` / `off`)

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
