## 3.3.0
- When exporting a rowing activity, compute real rowing speed and distance (matching Strava export physics) while injecting route GPS coordinates, altitude, and laps
- Ensure custom logger FIT file uploads retain route GPS track coordinates when exported to Suunto
- Synchronize Strava/Intervals hijacked rowing uploads to include accurate rowing physics and route GPS data

## 3.2.0
- Support manual PHPSESSID/rememberme login for Runalyze (Cloudflare bypass)
- Auto-detect rowing mode and stamp sport marker on export
- Drop Strava direct upload + token scraping; persist export mode
- Fix Suunto export login and automatic Runalyze key refresh

## 3.1.0
- Upload rowing activities as virtual rowing

## 1.3.0
- Initial Suunto export via Runalyze
