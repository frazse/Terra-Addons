## 0.2.1
- Initial release of Group Spectate camera addon
- Ctrl+click a rider-list group header or pick a live <25m pack from the Group Cam pill in `.people-status`
- Centers the camera on the arithmetic mean of the group with toggleable Fixed distance and Auto pull-back framing
- Automatically switches `focalRider` into the spectated group, excludes dropped riders, and follows the leader on splits
- Hooks `btApp.camera.update` so 3D scenery, tiles, and 2D nameplates stay aligned
