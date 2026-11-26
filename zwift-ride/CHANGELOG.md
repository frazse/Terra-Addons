## 0.7.0
- Add Zwift Click v2 dual-pod support (`0000fc82` & `00000001-19ca` services, plain `RideOn` handshake, `0x19` battery decode, and Click v2 Dual / Right-Only presets)
- Add `LS1 / Click −` and `RS1 / Click +` modifier support: tap `−` to shift down, hold `−` for Camera (`A/B/Y/Z` orbit/tilt, D-pad zoom/orbit) and `hold − + press +` for `Group view (follow focal rider)`
- Add 24-hour Zwift authentication check for Click v2 Left pod (hidden-service, `FF 03` unsolved challenge, and `FF 05 00 EA/FA 05` lock detection; verified only on clean `RideOn` echo or real button activity >65s; 24h countdown & pill warning; opt-in `0x18` auto-reset fallback)
- Fix Click v2 connection stability: skip `0x2a19` GATT battery reads (use `0x19` notifications), send `FF 04 00` once per connection, gate `keepAlive()` on Terra's Rust BLE supervisor (`ble_devices_status` + `ble:autoconnected`), and keep periodic `0x18` idle reboot off by default

## 0.6.6
- Fix Z-tab cycling (`cycleTopNav`) on activity and other off-tab pages to return directly to `/dashboard` instead of jumping to `/routes`

## 0.6.5
- Add `group_view` command (`group-spectate:toggle-ego`) bound by default to `LB + Right Power` when LB modifier is enabled

## 0.6.4
- Fix header pill for /badges navigation and add voice_ptt command

## 0.6.3
- Mirror controller battery to OpenBikeControl mock and require connected controllers

## 0.6.2
- Add virtual OpenBikeControl shifter for auto Virtual Shifting

## 0.6.1
- Add 2-column athlete layout and Console UI toggle

## 0.6.0
- Add BLE battery status, binding presets, and customizable Cog-menu settings

## 0.5.1
- Update default bindings and enable LB camera layer

## 0.5.0
- Adapt Console UI layouts and default focus to Horizon redesign
- Add camera control on ride pages and improve mouse drag handling

## 0.4.2
- Publish controller connection state

## 0.4.1
- Refine dashboard stats alignment

## 0.4.0
- Console UI overhaul v4 (layout engine, bottom HUD, Z-tab cycling) and updated page selectors
