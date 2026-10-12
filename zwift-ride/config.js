// ===== Zwift Ride controller addon for Terra =====
// Ported from the "Biketerra Ride Controller" Chrome extension. The hub window, background script and
// message bridge are gone: Rust holds the BLE link, this addon decodes it and drives the page directly.
// The js files are concatenated into one scope, in manifest order: config, nav, ride, panel, main.

const SVC = '0000fc82-0000-1000-8000-00805f9b34fb';
const ANALOG_ON = 30, ANALOG_OFF = 15; // lever thresholds (hysteresis), applied per direction
const RIDE_PATH_PREFIX = '/ride';
const DEBUG = false;                   // verbose terminal logging

// Active-low: bit == 0 means pressed. Verified on a real Ride by pressing every button.
const MASKS = {
  left: 0x1, up: 0x2, right: 0x4, down: 0x8,
  a: 0x10, b: 0x20, y: 0x40, z: 0x80,
  shift_up_l: 0x100, shift_dn_l: 0x200, powerup_l: 0x400, onoff_l: 0x800,      // LS1, LS2, LB (Ride On), power
  shift_up_r: 0x1000, shift_dn_r: 0x2000, powerup_r: 0x4000, onoff_r: 0x8000,  // RS1, RS2, RB (Ride On), power
};

const INPUTS = [
  ['left', 'D-pad \u2190'], ['up', 'D-pad \u2191'], ['right', 'D-pad \u2192'], ['down', 'D-pad \u2193'],
  ['a', 'A (green)'], ['b', 'B (pink)'], ['y', 'Y (blue)'], ['z', 'Z (orange)'],
  ['shift_up_l', 'Left shifter 1 (LS1)'], ['shift_dn_l', 'Left shifter 2 (LS2)'],
  ['shift_up_r', 'Right shifter 1 (RS1)'], ['shift_dn_r', 'Right shifter 2 (RS2)'],
  ['lever_l_pos', 'Left paddle ZL (+)'], ['lever_l_neg', 'Left paddle ZL (\u2212)'],
  ['lever_r_pos', 'Right paddle ZR (+)'], ['lever_r_neg', 'Right paddle ZR (\u2212)'],
  ['powerup_l', 'Left Ride On (LB)'], ['powerup_r', 'Right Ride On (RB)'],
  ['onoff_l', 'Power button (left)'], ['onoff_r', 'Power button (right)'],
];
const ACTION_LIST = [
  ['none', '\u2014'], ['nav_up', 'Navigate up'], ['nav_down', 'Navigate down'],
  ['nav_left', 'Navigate left'], ['nav_right', 'Navigate right'], ['select', 'Select / click'],
  ['back', 'Back'], ['page_up', 'Page up'], ['page_down', 'Page down'], ['top', 'Scroll to top'],
];
const KEY = (code, key) => ({ code, key });
const W = KEY('KeyW', 'w'), S = KEY('KeyS', 's');
const UP = KEY('ArrowUp', 'ArrowUp'), DOWN = KEY('ArrowDown', 'ArrowDown');
const LEFT = KEY('ArrowLeft', 'ArrowLeft'), RIGHT = KEY('ArrowRight', 'ArrowRight');
const DEF = {
  // Follows Biketerra's default Zwift Ride bindings (key values from its Keyboard tab).
  ride: {
    shift_up_l: [S], shift_dn_l: [S], shift_up_r: [W], shift_dn_r: [W], // LS1+LS2 = shift down, RS1+RS2 = shift up
    up: [UP], down: [DOWN], left: [LEFT], right: [RIGHT],
    lever_l_pos: [LEFT], lever_l_neg: [LEFT], lever_r_pos: [RIGHT], lever_r_neg: [RIGHT],
    a: [KEY('Enter', 'Enter')], b: [KEY('KeyB', 'b')], y: [KEY('KeyP', 'p')], z: [KEY('KeyC', 'c')],
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

// cfg = { ride: {input: [{code,key}]}, browse: {input: action},
//         mods: {powerup_l: bool, ...},                      which Ride On buttons act as modifiers
//         layers: {powerup_l: {ride: {...}, browse: {...}}}  mappings used while that modifier is held }
let cfg = null;
let rideEnabled = true; // send ride keys on /ride* pages (off = let Biketerra handle the controller)
let stopped = false;

// Ride On buttons can act as modifiers: hold one, press another button, and that button's mapping comes from
// the modifier's layer (anything the layer leaves unset falls back to the normal mapping).
const MOD_CAPABLE = ['powerup_l', 'powerup_r'];
const MOD_SHORT = { powerup_l: 'LB', powerup_r: 'RB' };
DEF.mods = { powerup_l: false, powerup_r: false };
DEF.layers = { powerup_l: { ride: {}, browse: {} }, powerup_r: { ride: {}, browse: {} } };
const defaultCfg = () => clone(DEF);

let layer = 'normal'; // which layer the settings table is showing: 'normal' or a modifier's input name
const rideMap = (l) => (l === 'normal' ? cfg.ride : cfg.layers[l].ride);
const browseMap = (l) => (l === 'normal' ? cfg.browse : cfg.layers[l].browse);

async function loadCfg() {
  const saved = await terra.storage.get('config', {});
  const ride = { ...clone(DEF.ride), ...(saved.ride || {}) };
  for (const k of Object.keys(ride)) ride[k] = (ride[k] || []).slice(0, 1); // one key per input
  const layers = {};
  for (const m of MOD_CAPABLE) {
    const s = (saved.layers && saved.layers[m]) || {};
    layers[m] = { ride: { ...(s.ride || {}) }, browse: { ...(s.browse || {}) } };
    for (const k of Object.keys(layers[m].ride)) layers[m].ride[k] = (layers[m].ride[k] || []).slice(0, 1);
  }
  return {
    ride,
    browse: { ...clone(DEF.browse), ...(saved.browse || {}) },
    mods: { ...clone(DEF.mods), ...(saved.mods || {}) },
    layers,
  };
}
function saveCfg() {
  terra.storage.set('config', cfg).then(() => flash('Saved'), (e) => flash('Save failed: ' + e));
}
