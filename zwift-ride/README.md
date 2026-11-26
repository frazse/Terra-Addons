# Zwift Ride / Click v2 controller (Terra addon)

Port of the "Biketerra Ride Controller" Chrome extension: Ride hotkeys on /ride*, D-pad navigation
elsewhere, in-page mapping panel (click the pill at the bottom-left).

First run: open the panel, press **Pair controller**, pick your Zwift Ride (or pair both Left & Right pods for
Zwift Click v2) in Terra's chooser. Paired controllers are remembered and reconnect on every launch / page load.

## Zwift Click v2 & 24-hour unlock check
Zwift Click v2's Left pod enforces a 24-hour unlock signed by the Zwift app (the Right pod never locks). The addon checks for hidden services, unsolved `FF 03` auth challenges, and `0xFF 05 00 EA/FA 05` lock cutoffs, confirms live 24h unlock on a clean `RideOn` echo or real button presses past 65s, displays remaining unlock time in the panel & header pill, and provides a **Right-Only** preset (`+` / `B`) plus optional **`0x18` auto-reset** / **periodic 55s idle reboot** toggles (both off by default).

Migrating your old mappings: the old extension kept them in its hub page's localStorage. In the old hub
window's DevTools run `copy(localStorage['btz-config-v1'])`, then save the result as
`~/.local/share/dev.frazse.terra/addon-data/zwift-ride.json` in the form `{ "config": <pasted json> }`.

## Header button and ride toggle
The settings button sits in Biketerra's nav row (right after the last nav link, e.g. "Badges"); on pages without that header it
floats at the bottom-left. The dot is green when a controller is connected, amber while waiting or expiring soon,
and red if a Click v2 Left pod needs its 24h Zwift unlock.

**Send ride keys on ride pages** (panel): turn it off to let Biketerra handle the controller itself during
rides. The addon then stops sending keys on /ride* and shares the controller with the page (so Biketerra's
auto-pair can take it); on other pages it keeps using it for D-pad navigation.

## Modifier buttons (LB / RB / Click − / Click +)
Tick "Left/Right Ride On is a modifier" or "Left/Right shifter 1 is a modifier" in the panel. A new tab appears next to "Normal":
hold the button and press another one to use that button's mapping from the tab (both the ride key and the
site action). Anything left as "as normal" falls back to the normal mapping, so holding a modifier never disables
other buttons. Pressing and releasing the modifier on its own (a tap) runs the mapping set for it under "Normal"
(so on Click v2, tapping `−` shifts down while holding `−` + `A/B/Y/Z` or D-pad moves the camera, and holding `−` + `+` toggles Group view).

Example: LB tab, D-pad left -> click the key slot and press the key Biketerra uses for "pan camera left".
Normal: D-pad left = left arrow. LB held + D-pad left = pan camera left.

## Camera control (ride pages)
Each row in the panel has a **Camera** column: pick Orbit / Tilt / Zoom instead of a key. It works in every layer,
so the usual setup is a modifier layer. **Camera preset on LB** does it in one click: LB becomes a modifier and,
while it is held, D-pad left/right orbits, D-pad up/down tilts, RS1/RS2 zoom in and LS1/LS2 zoom out.

Orbit/tilt emulate a middle-button drag on the largest canvas on the page (movement continues while held);
zoom emulates scroll-wheel ticks. Tuning constants are at the top of camera.js (`CAM_DRAG_SPEED`,
`CAM_WHEEL_STEP`, `CAM_WHEEL_MS`). If the page ignores the events or throws, set `CAM_EVENTS` to `'mouse'` or
`'pointer'` and check the Terra console.
