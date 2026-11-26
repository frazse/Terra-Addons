// ===== Zwift Ride controller addon for Terra =====
// Ported from the "Biketerra Ride Controller" Chrome extension. The hub window, background script and
// message bridge are gone: Rust holds the BLE link, this addon decodes it and drives the page directly.
// The js files are concatenated into one scope, in manifest order: config, nav, camera, ride, panel, console-ui, main.

const SVC_RIDE = '0000fc82-0000-1000-8000-00805f9b34fb';
const SVC_CUSTOM = '00000001-19ca-4651-86e5-fa29dcdd09d1';
const SVC = SVC_RIDE;
const SVCS = [SVC_RIDE, SVC_CUSTOM];
const CH_ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1';
const CH_SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1';
const CH_SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1';
const BAT_SVC = '0000180f-0000-1000-8000-00805f9b34fb';
const BAT_CHR = '00002a19-0000-1000-8000-00805f9b34fb';
const ANALOG_ON = 30, ANALOG_OFF = 15; // lever thresholds (hysteresis), applied per direction
const RIDE_PATH_PREFIX = '/ride';
const SPECTATE_PATH_PREFIX = '/spectate';
const DEBUG = false;                   // verbose terminal logging

const CLICK_UNLOCK_MS = 24 * 60 * 60 * 1000;
const CLICK_WARN_MS = 2 * 60 * 60 * 1000;
const CLICK_VERIFY_MS = 65 * 1000;
const CLICK_IDLE_RESET_MS = 55 * 1000;
const CLICK_KEEPALIVE_MS = 3000;
const CLICK_ACK_MS = 15000;
const LEFT_MASK = 0x0010f;  // D-pad + Left shifter 1 (-)
const RIGHT_MASK = 0x010f0; // A/B/Y/Z + Right shifter 1 (+)

// Active-low: bit == 0 means pressed. Verified on a real Ride and Click v2.
const MASKS = {
  left: 0x1, up: 0x2, right: 0x4, down: 0x8,
  a: 0x10, b: 0x20, y: 0x40, z: 0x80,
  shift_up_l: 0x100, shift_dn_l: 0x200, powerup_l: 0x400, onoff_l: 0x800,      // LS1 / Click -, LS2, LB (Ride On), power
  shift_up_r: 0x1000, shift_dn_r: 0x2000, powerup_r: 0x4000, onoff_r: 0x8000,  // RS1 / Click +, RS2, RB (Ride On), power
};

const INPUTS = [
  ['left', 'D-pad \u2190'], ['up', 'D-pad \u2191'], ['right', 'D-pad \u2192'], ['down', 'D-pad \u2193'],
  ['a', 'A (green)'], ['b', 'B (pink)'], ['y', 'Y (blue)'], ['z', 'Z (orange)'],
  ['shift_up_l', 'Left shifter 1 (LS1 / Click \u2212)'], ['shift_dn_l', 'Left shifter 2 (LS2)'],
  ['shift_up_r', 'Right shifter 1 (RS1 / Click +)'], ['shift_dn_r', 'Right shifter 2 (RS2)'],
  ['lever_l_pos', 'Left paddle ZL (+)'], ['lever_l_neg', 'Left paddle ZL (\u2212)'],
  ['lever_r_pos', 'Right paddle ZR (+)'], ['lever_r_neg', 'Right paddle ZR (\u2212)'],
  ['powerup_l', 'Left Ride On (LB)'], ['powerup_r', 'Right Ride On (RB)'],
  ['onoff_l', 'Power button (left)'], ['onoff_r', 'Power button (right)'],
];
const ACTION_LIST = [
  ['none', '\u2014'], ['nav_up', 'Navigate up'], ['nav_down', 'Navigate down'],
  ['nav_left', 'Navigate left'], ['nav_right', 'Navigate right'], ['select', 'Select / click'],
  ['back', 'Back'], ['page_up', 'Page up'], ['page_down', 'Page down'], ['top', 'Scroll to top'],
  ['open_terra', 'Open Terra settings'], ['cycle_profile', 'Cycle Ride profile'],
];
const KEY = (code, key) => ({ code, key });
const W = KEY('KeyW', 'w'), S = KEY('KeyS', 's');
const UP = KEY('ArrowUp', 'ArrowUp'), DOWN = KEY('ArrowDown', 'ArrowDown');
const LEFT = KEY('ArrowLeft', 'ArrowLeft'), RIGHT = KEY('ArrowRight', 'ArrowRight');

const DEF = {
  // User default Zwift Ride bindings + LB camera modifier layer.
  ride: {
    shift_up_l: [S], shift_dn_l: [S], shift_up_r: [W], shift_dn_r: [W], // LS1+LS2 = shift down, RS1+RS2 = shift up
    up: [UP], down: [DOWN], left: [LEFT], right: [RIGHT],
    lever_l_pos: [LEFT], lever_l_neg: [LEFT], lever_r_pos: [RIGHT], lever_r_neg: [RIGHT],
    a: [KEY('Enter', 'Enter')], b: [KEY('KeyB', 'b')], y: [KEY('KeyP', 'p')], z: [KEY('KeyC', 'c')],
    powerup_r: [KEY('Cmd:voice_ptt', 'cmd')],
    onoff_r: [KEY('KeyU', 'u')],
  },
  browse: {
    up: 'nav_up', down: 'nav_down', left: 'nav_left', right: 'nav_right',
    a: 'select', b: 'back',
    shift_up_l: 'page_down', shift_dn_l: 'page_down', shift_up_r: 'page_up', shift_dn_r: 'page_up',
    y: 'top',
  },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dlog = (...a) => { if (DEBUG) terra.log(...a); };

let cfg = null;
let rideEnabled = true;
let autoVirtualShift = true;
let keepClickAwake = false;
let autoResetLocked = false;
let clickAuth = {};
let stopped = false;
let activeProfile = 'default';
let customProfiles = {};
const isClickName = (name) => /click/i.test(String(name || ''));

const MOD_CAPABLE = ['powerup_l', 'powerup_r', 'shift_up_l', 'shift_up_r'];
const MOD_SHORT = { powerup_l: 'LB', powerup_r: 'RB', shift_up_l: '\u2212 (LS1)', shift_up_r: '+ (RS1)' };
DEF.mods = { powerup_l: true, powerup_r: false, shift_up_l: false, shift_up_r: false };
DEF.layers = {
  powerup_l: {
    ride: {
      a: [KEY('Cam:orbit_right', 'cam')],
      b: [KEY('Cam:tilt_down', 'cam')],
      down: [KEY('Cam:zoom_out', 'cam')],
      up: [KEY('Cam:zoom_in', 'cam')],
      y: [KEY('Cam:tilt_up', 'cam')],
      z: [KEY('Cam:orbit_left', 'cam')],
      onoff_l: [KEY('Cmd:open_terra', 'cmd')],
      onoff_r: [KEY('Cmd:group_view', 'cmd')],
    },
    browse: {
      onoff_l: 'open_terra',
      onoff_r: 'cycle_profile',
    },
  },
  powerup_r: { ride: {}, browse: {} },
  shift_up_l: {
    ride: {
      a: [KEY('Cam:orbit_right', 'cam')],
      b: [KEY('Cam:tilt_down', 'cam')],
      down: [KEY('Cam:zoom_out', 'cam')],
      up: [KEY('Cam:zoom_in', 'cam')],
      left: [KEY('Cam:orbit_left', 'cam')],
      right: [KEY('Cam:orbit_right', 'cam')],
      y: [KEY('Cam:tilt_up', 'cam')],
      z: [KEY('Cam:orbit_left', 'cam')],
      shift_up_r: [KEY('Cmd:group_view', 'cmd')],
    },
    browse: {},
  },
  shift_up_r: { ride: {}, browse: {} },
};

const emptyLayers = () => ({
  powerup_l: { ride: {}, browse: {} },
  powerup_r: { ride: {}, browse: {} },
  shift_up_l: { ride: {}, browse: {} },
  shift_up_r: { ride: {}, browse: {} },
});

const PRESETS = {
  default: {
    label: 'Default (Free Ride + LB Cam)',
    cfg: () => clone(DEF),
  },
  erg: {
    label: 'ERG / Workout',
    cfg: () => ({
      ride: {
        shift_up_l: [DOWN], shift_dn_l: [DOWN],
        shift_up_r: [UP], shift_dn_r: [UP],
        up: [UP], down: [DOWN], left: [LEFT], right: [RIGHT],
        lever_l_pos: [LEFT], lever_l_neg: [LEFT], lever_r_pos: [RIGHT], lever_r_neg: [RIGHT],
        a: [KEY('Space', ' ')], b: [KEY('KeyB', 'b')], y: [KEY('KeyP', 'p')], z: [KEY('KeyC', 'c')],
        powerup_r: [KEY('Cmd:voice_ptt', 'cmd')],
        onoff_r: [KEY('KeyU', 'u')],
      },
      browse: clone(DEF.browse),
      mods: { powerup_l: true, powerup_r: false, shift_up_l: false, shift_up_r: false },
      layers: clone(DEF.layers),
    }),
  },
  spectate: {
    label: 'Spectate / Camera',
    cfg: () => ({
      ride: {
        left: [KEY('Cam:orbit_left', 'cam')],
        right: [KEY('Cam:orbit_right', 'cam')],
        up: [KEY('Cam:tilt_up', 'cam')],
        down: [KEY('Cam:tilt_down', 'cam')],
        shift_up_r: [KEY('Cam:zoom_in', 'cam')],
        shift_dn_r: [KEY('Cam:zoom_in', 'cam')],
        shift_up_l: [KEY('Cam:zoom_out', 'cam')],
        shift_dn_l: [KEY('Cam:zoom_out', 'cam')],
        a: [KEY('Enter', 'Enter')],
        b: [KEY('KeyC', 'c')],
        y: [KEY('KeyP', 'p')],
        z: [KEY('KeyU', 'u')],
      },
      browse: clone(DEF.browse),
      mods: { powerup_l: false, powerup_r: false, shift_up_l: false, shift_up_r: false },
      layers: emptyLayers(),
    }),
  },
  clickv2: {
    label: 'Zwift Click v2 (Dual + \u2212 Hold Mod)',
    cfg: () => ({
      ride: {
        shift_up_l: [S], shift_dn_l: [], shift_up_r: [W], shift_dn_r: [],
        up: [UP], down: [DOWN], left: [LEFT], right: [RIGHT],
        lever_l_pos: [], lever_l_neg: [], lever_r_pos: [], lever_r_neg: [],
        a: [KEY('Enter', 'Enter')], b: [KEY('KeyB', 'b')], y: [KEY('KeyP', 'p')], z: [KEY('KeyC', 'c')],
        powerup_l: [], powerup_r: [], onoff_l: [], onoff_r: [],
      },
      browse: {
        up: 'nav_up', down: 'nav_down', left: 'nav_left', right: 'nav_right',
        a: 'select', b: 'back',
        shift_up_l: 'page_down', shift_dn_l: 'none', shift_up_r: 'page_up', shift_dn_r: 'none',
        y: 'top',
      },
      mods: { powerup_l: false, powerup_r: false, shift_up_l: true, shift_up_r: false },
      layers: {
        ...emptyLayers(),
        shift_up_l: clone(DEF.layers.shift_up_l),
      },
    }),
  },
  clickv2_right: {
    label: 'Zwift Click v2 (Right-Only: + / B)',
    cfg: () => ({
      ride: {
        shift_up_l: [], shift_dn_l: [], shift_up_r: [W], shift_dn_r: [],
        up: [], down: [], left: [], right: [],
        lever_l_pos: [], lever_l_neg: [], lever_r_pos: [], lever_r_neg: [],
        a: [KEY('Enter', 'Enter')], b: [S], y: [KEY('KeyP', 'p')], z: [KEY('KeyC', 'c')],
        powerup_l: [], powerup_r: [], onoff_l: [], onoff_r: [],
      },
      browse: {
        up: 'none', down: 'none', left: 'none', right: 'none',
        a: 'select', b: 'back',
        shift_up_l: 'none', shift_dn_l: 'none', shift_up_r: 'page_down', shift_dn_r: 'none',
        y: 'top',
      },
      mods: { powerup_l: false, powerup_r: false, shift_up_l: false, shift_up_r: false },
      layers: emptyLayers(),
    }),
  },
};

const defaultCfg = () => clone(DEF);

function normalizeCfg(raw) {
  const base = clone(DEF);
  const src = raw || {};
  const ride = { ...clone(base.ride), ...(src.ride || {}) };
  for (const k of Object.keys(ride)) ride[k] = (ride[k] || []).slice(0, 1);
  const layers = {};
  for (const m of MOD_CAPABLE) {
    const d = base.layers[m] || { ride: {}, browse: {} };
    const s = src.layers && src.layers[m];
    layers[m] = {
      ride: { ...clone(s ? (s.ride || {}) : (d.ride || {})) },
      browse: { ...clone(s ? (s.browse || {}) : (d.browse || {})) },
    };
    for (const k of Object.keys(layers[m].ride)) layers[m].ride[k] = (layers[m].ride[k] || []).slice(0, 1);
  }
  return {
    ride,
    browse: { ...clone(base.browse), ...(src.browse || {}) },
    mods: { ...clone(base.mods), ...(src.mods || {}) },
    layers,
  };
}

let layer = 'normal';
const rideMap = (l) => (l === 'normal' ? cfg.ride : cfg.layers[l].ride);
const browseMap = (l) => (l === 'normal' ? cfg.browse : cfg.layers[l].browse);

async function loadCfg() {
  activeProfile = await terra.storage.get('activeProfile', 'default');
  customProfiles = await terra.storage.get('customProfiles', {});
  keepClickAwake = await terra.storage.get('keepClickAwake', false);
  try {
    const fixedKeepAwake = await terra.storage.get('migratedClickKeepAwakeOffV1', false);
    if (!fixedKeepAwake) {
      keepClickAwake = false;
      await terra.storage.set('keepClickAwake', false);
      await terra.storage.set('migratedClickKeepAwakeOffV1', true);
    }
  } catch {}
  autoResetLocked = await terra.storage.get('autoResetLocked', false);
  const rawAuth = await terra.storage.get('clickAuth', {});
  clickAuth = (rawAuth && typeof rawAuth === 'object' && !Array.isArray(rawAuth)) ? rawAuth : {};
  try {
    const fixedAuth = await terra.storage.get('migratedClickAuthV2Fix1', false);
    if (!fixedAuth) {
      let dirty = false;
      for (const rec of Object.values(clickAuth)) {
        if (rec && rec.source === 'verified') {
          rec.unlockedAt = null;
          rec.source = null;
          dirty = true;
        }
      }
      if (dirty) await terra.storage.set('clickAuth', clickAuth);
      await terra.storage.set('migratedClickAuthV2Fix1', true);
    }
  } catch {}
  const saved = await terra.storage.get('config', {});
  const next = normalizeCfg(saved);
  try {
    const migrated = await terra.storage.get('migratedGroupViewBindV1', false);
    if (!migrated) {
      if (next.mods && next.mods.powerup_l && next.layers && next.layers.powerup_l && next.layers.powerup_l.ride) {
        const cur = next.layers.powerup_l.ride.onoff_r;
        if (!cur || !cur.length) {
          next.layers.powerup_l.ride.onoff_r = [KEY('Cmd:group_view', 'cmd')];
          if (saved && Object.keys(saved).length > 0) {
            await terra.storage.set('config', next);
          }
        }
      }
      await terra.storage.set('migratedGroupViewBindV1', true);
    }
  } catch {}
  return next;
}
function saveClickAuth() {
  return terra.storage.set('clickAuth', clickAuth).catch(() => {});
}
function saveCfg() {
  terra.storage.set('config', cfg).then(() => flash('Saved'), (e) => flash('Save failed: ' + e));
}
