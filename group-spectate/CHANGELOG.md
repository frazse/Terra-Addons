## 0.3.0
- Added a compact icon + live group count pill to the left of `Group Cam` in `.people-status` (and a toggle inside the Group Cam popover)
- Focal-anchored Group View always follows the pack around the current ego/focalRider (never switches focalRider away when other riders attack or drop)
- Added a dedicated `Slide speed` slider (`slideDuration`, default `0.7 s`) with a critically-damped transition slide for activating/deactivating Group Cam, switching groups/focal riders, and riders joining or leaving — works cleanly even with steady-state `Smoothing` set to `1.00` (zero shake)
- Listens to `group-spectate:toggle-ego` on `terra.bus` for Zwift Ride controller shortcut integration (default `LB + Right Power`)

## 0.2.1
- Initial release of Group Spectate camera addon
- Ctrl+click a rider-list group header or pick a live <25m pack from the Group Cam pill in `.people-status`
- Centers the camera on the arithmetic mean of the group with toggleable Fixed distance and Auto pull-back framing
- Automatically switches `focalRider` into the spectated group, excludes dropped riders, and follows the leader on splits
- Hooks `btApp.camera.update` so 3D scenery, tiles, and 2D nameplates stay aligned
