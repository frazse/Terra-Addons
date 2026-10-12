# Zwift Ride controller (Terra addon)

Port of the "Biketerra Ride Controller" Chrome extension: Ride hotkeys on /ride*, D-pad navigation
elsewhere, in-page mapping panel (click the pill at the bottom-left).

First run: open the panel, press **Pair controller**, pick your Ride in Terra's chooser. It is remembered
and reconnects on every launch / page load.

Migrating your old mappings: the old extension kept them in its hub page's localStorage. In the old hub
window's DevTools run `copy(localStorage['btz-config-v1'])`, then save the result as
`~/.local/share/dev.frazse.terra/addon-data/zwift-ride.json` in the form `{ "config": <pasted json> }`.

## Header button and ride toggle
The settings button sits in Biketerra's nav row (right after "Challenges"); on pages without that header it
floats at the bottom-left. The dot is green when a controller is connected, amber while waiting.

**Send ride keys on ride pages** (panel): turn it off to let Biketerra handle the controller itself during
rides. The addon then stops sending keys on /ride* and shares the controller with the page (so Biketerra's
auto-pair can take it); on other pages it keeps using it for D-pad navigation.

## Modifier buttons (LB / RB)
Tick "Left/Right Ride On is a modifier" in the panel. A new tab ("LB held" / "RB held") appears next to "Normal":
hold the button and press another one to use that button's mapping from the tab (both the ride key and the
site action). Anything left as "as normal" falls back to the normal mapping, so holding LB never disables
other buttons. Pressing and releasing the modifier on its own (a tap) runs the mapping set for it under "Normal".

Example: LB tab, D-pad left -> click the key slot and press the key Biketerra uses for "pan camera left".
Normal: D-pad left = left arrow. LB held + D-pad left = pan camera left.
