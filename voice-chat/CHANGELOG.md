## 0.3.0
- Default PTT transcription behavior to interactive draft preview (`sendBehavior: "draft"`) with Confirm / Cancel buttons instead of auto-sending after a countdown
- Add PTT gesture controls while a draft is active: single-tap PTT to confirm & send, double-tap PTT to cancel, or hold PTT again to discard the draft and record a new message (with full 500 ms pre-roll)

## 0.2.0
- Integrated Voice Chat seamlessly into Biketerra's right-hand HUD column (`.hud-zone.zone-people`) and in-game chat panel: sits cleanly where chat appears when closed, and fuses directly below the `Type message...` input row when chat is open.
- Restyled with Biketerra's native in-ride HUD palette (`--overlay-4`, `rem` scaling, borderless hover buttons, zero `backdrop-filter`).
- Added a quick chat toggle button on the voice bar and an optional "Auto-open Biketerra chat on ride start" setting.

## 0.1.1
- Prefer Bluetooth microphone on Android and add mic diagnostics

## 0.1.0
- Initial release: Whisper voice-to-text chat addon
