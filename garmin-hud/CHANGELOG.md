## 1.4.2
- Subscribe directly to `BroadcastChannel('biketerra-ride')` alongside `terra.ride.onRide`, merge `ego` and `riders` feed entries, support `spm` cadence units, and fix feed timestamp deduplication when `frame.timestamp` is omitted

## 1.4.1
- Switch cadence and heart rate back to biketerra-ride while keeping power on btApp

## 1.4.0
- Add speed unit (km/h / mph), numeric power smoothing (instant / 3s / 10s), graph window length (30 / 60 / 120s), and background opacity settings

## 1.3.0
- Prefer btApp.riderController at 10Hz with braking color indicator and biketerra-ride / DOM fallbacks

## 1.2.0
- Use biketerra-ride broadcast data with DOM scraping as a fallback
