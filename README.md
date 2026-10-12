# Terra Addons 🚲

Official community addons and custom JavaScript extensions for **[Terra](https://github.com/frazse/Terra)**, the companion app and web runtime for **[Biketerra.com](https://biketerra.com)**.

---

## 📦 Official Community Addons

| Addon | Description                                                                                | Folder |
| :--- |:-------------------------------------------------------------------------------------------| :--- |
| **🎮 Zwift Ride Controller** | Hotkeys, D-pad UI navigation, and mapping panel for Zwift Ride smart controllers.          | [`zwift-ride`](./zwift-ride/) |
| **📊 Garmin HUD** | Replaces standard stat cells with Garmin-style rolling graphs colored Intervals.icu zones. | [`garmin-hud`](./garmin-hud/) |
| **📈 Biketerra Universal Logger** | Rowing & cycling session logger with live graphs, `.fit` export.                           | [`biketerra-logger`](./biketerra-logger/) |
| **⏱️ FPS Monitor** | Small draggable FPS and rendering performance overlay.                                     | [`fps-monitor`](./fps-monitor/) |
| **⚡ Live Stats HUD** | Small draggable heart rate and power overlay for ride pages.                               | [`live-stats`](./live-stats/) |

---

## 📂 Installation Directories

To install an addon, copy its folder (containing `manifest.json`) into Terra's addons directory:

* **Android**:
  ```text
  /storage/emulated/0/Android/data/dev.frazse.terra/files/addons/
  ```

* **Linux Desktop**:
  ```text
  ~/.local/share/dev.frazse.terra/addons/
  ```
  *(Or `./addons/` in your local directory when running in development mode).*

---

## ⚙️ Managing Addons

Click the **Cog icon** next to Biketerra's theme toggle in Terra's header menu:
* Toggle addons on or off instantly.
* Click **`Settings ▾`** to configure API keys (Intervals.icu, Strava), FTP, and HR thresholds directly in Terra.
* Addon files are re-evaluated on page reload (**F5** or **Ctrl+R**), allowing live addon development without rebuilding Terra.

---

## 🛠️ Developing Custom Addons

An addon is a folder containing a `manifest.json` file and JavaScript/CSS assets:

### `manifest.json` Specification

```json
{
  "id": "my-custom-addon",
  "name": "My Custom Addon",
  "version": "1.0.0",
  "description": "Short summary displayed in Terra's Cog menu",
  "matches": ["https://biketerra.com/ride*"],
  "js": ["main.js"],
  "css": ["style.css"],
  "connect": ["api.example.com"],
  "settings": [
    {
      "key": "target_ftp",
      "label": "Target FTP (W)",
      "type": "number",
      "default": 250,
      "description": "Your current FTP in Watts"
    },
    {
      "key": "api_secret",
      "label": "API Secret Key",
      "type": "password",
      "description": "Saved write-only in Terra. Substituted into terra.http requests via {{setting:api_secret}}"
    }
  ],
  "enabled": true
}
```

---

### The `terra` API Object

Addons receive the `terra` helper object upon initialization:

| API | Description |
| :--- | :--- |
| `terra.id / name / version` | Manifest metadata. |
| `terra.log(...)` | Prints formatted messages to terminal and logcat console. |
| `terra.onCleanup(fn)` | Callback executed when the addon is disabled or page unloads. |
| `terra.onNavigate(fn)` | Called with the new URL on single-page navigation. |
| `terra.waitFor(selector, opts)` | Returns a Promise resolving to a DOM element once rendered. |
| `terra.storage.get / set / remove` | Async persistent per-addon key-value storage. |
| `terra.settings.get / set / onChange` | Access settings configured by the user in Terra's Cog menu. |
| `terra.http.request(req)` | CORS-free HTTPS requests made directly by Rust. |
| `terra.files.save(filename, bytes)` | Saves `.fit`, `.gpx`, `.tcx`, `.json`, `.csv` files directly to `Downloads/Terra/`. |
| `terra.bus.on / emit` | In-page event bus shared across addons. |
| `terra.ble.onNotify(cb)` | Live Bluetooth notification callback (`{deviceId, characteristic, value: DataView}`). |
| `terra.ble.request(options)` | Pair dedicated Bluetooth devices for this addon. |
| `terra.keys.down / up / tap(key)` | Dispatch synthetic keyboard events. |
| `terra.ui.addStyle(css)` | Inject CSP-safe custom CSS stylesheets. |

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for more information.
