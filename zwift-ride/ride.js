/* ---------- protobuf (minimal) ---------- */
function readVarint(buf, pos) {
  let result = 0, shift = 0, b;
  do { b = buf[pos++]; result += (b & 0x7f) * 2 ** shift; shift += 7; } while ((b & 0x80) && pos < buf.length);
  return [result, pos];
}
function pb(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8), wire = tag & 7;
    if (wire === 0) { let v; [v, pos] = readVarint(buf, pos); out.push({ field, wire, value: v }); }
    else if (wire === 2) { let n; [n, pos] = readVarint(buf, pos); out.push({ field, wire, bytes: buf.subarray(pos, pos + n) }); pos += n; }
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else break;
  }
  return out;
}
const zigzag = (v) => (v >>> 1) ^ -(v & 1);
function collectAnalog(bytes, out) {
  const f = pb(bytes);
  const subs = f.filter((x) => x.wire === 2);
  const loc = f.find((x) => x.field === 1 && x.wire === 0);
  const val = f.find((x) => x.field === 2 && x.wire === 0);
  if (!subs.length && (loc || val)) {
    const raw = val ? val.value : 0;
    out.push({ loc: loc ? loc.value : 0, raw, value: zigzag(raw) });
  } else subs.forEach((s) => collectAnalog(s.bytes, out));
}

/* ---------- input edges ---------- */
const devs = new Set();
const count = () => [...devs].filter((d) => d.up).length;
const LABEL = Object.fromEntries(INPUTS);
const hexn = (n, w) => '0x' + (n >>> 0).toString(16).padStart(w, '0');
const recent = [];
function show(name, edge, info = {}) {
  const parts = [LABEL[name] || name, '[' + name + ']', edge.toUpperCase()];
  if (info.mask !== undefined) parts.push('mask ' + hexn(info.mask, 5));
  if (info.map !== undefined) parts.push('map ' + hexn(info.map, 8));
  if (info.analog !== undefined) parts.push('analog ' + info.analog);
  if (info.src) parts.push('from ' + info.src);
  if (info.note) parts.push('(' + info.note + ')');
  const line = parts.join('  ');
  recent.unshift(line);
  if (recent.length > 8) recent.pop();
  setLast(recent.join('\n'));
  ulog(line);
  dlog(line);
}
function emit(name, edge, info) {
  if (edge === 'down') {
    const layerId = isMod(name) ? null : currentLayer();
    const extra = isMod(name) ? 'modifier' : layerId ? 'with ' + (MOD_SHORT[layerId] || layerId) + ' held' : '';
    if (extra) info = { ...info, note: [info && info.note, extra].filter(Boolean).join(', ') };
  }
  show(name, edge, info);
  const row = document.getElementById('btz-row-' + name);
  if (row) row.classList.toggle('on', edge === 'down');
  dispatchInput(name, edge);
}

// Both controllers may report the same physical button (one tunnels the other's). Count holders so a
// press seen by two devices is one press, and ignore a late duplicate arriving just after release.
const DUP_MS = 150;
const combo = {}; // name -> { holders:Set, ignored:Set, lastUpAt, lastUpDev }
const srcName = (dev) => (dev.device.name || 'controller') + ' #' + dev.n;
function inputEdge(dev, name, edge, info = {}) {
  info = { ...info, src: srcName(dev) };
  const st = combo[name] || (combo[name] = { holders: new Set(), ignored: new Set(), lastUpAt: 0, lastUpDev: null });
  if (edge === 'down') {
    if (st.holders.size === 0 && st.lastUpDev && st.lastUpDev !== dev && Date.now() - st.lastUpAt < DUP_MS) {
      st.ignored.add(dev);
      show(name, edge, { ...info, note: 'duplicate from other controller, ignored' });
      return;
    }
    const first = st.holders.size === 0;
    st.holders.add(dev);
    if (first) emit(name, 'down', info);
    else show(name, edge, { ...info, note: 'also reported by another controller, ignored' });
  } else {
    if (st.ignored.delete(dev)) { show(name, edge, { ...info, note: 'duplicate, ignored' }); return; }
    if (!st.holders.delete(dev)) return;
    if (st.holders.size === 0) { st.lastUpAt = Date.now(); st.lastUpDev = dev; emit(name, 'up', info); }
  }
}

/* ---------- Ride decoding ---------- */
const KNOWN = Object.values(MASKS).reduce((a, m) => a | m, 0);
function onNotify(dev, data) {
  if (data.length < 2) return;
  if (data[0] !== 0x23) {
    if (data[0] !== 0x19 && data[0] !== 0x15) ulog('msg', [...data].map((b) => b.toString(16).padStart(2, '0')).join(' '));
    return;
  }
  const f = pb(data.subarray(1));
  const mf = f.find((x) => x.field === 1 && x.wire === 0);
  if (mf) {
    if (dev.prev !== null) {
      for (const [name, mask] of Object.entries(MASKS)) {
        const was = (dev.prev & mask) === 0, now = (mf.value & mask) === 0;
        if (was !== now) inputEdge(dev, name, now ? 'down' : 'up', { mask, map: mf.value });
      }
      // A bit that changed but isn't in MASKS = a physical button we don't know about.
      const unknown = (dev.prev ^ mf.value) & ~KNOWN & 0x3fffff;
      if (unknown) show('unknown', (mf.value & unknown) === 0 ? 'down' : 'up', { mask: unknown, map: mf.value, src: srcName(dev), note: 'unmapped bit' });
    }
    dev.prev = mf.value;
  }
  const entries = [];
  f.filter((x) => x.wire === 2).forEach((x) => collectAnalog(x.bytes, entries));
  if (entries.length) ulog('analog', JSON.stringify(entries));
  const seen = new Set();
  for (const { loc, value } of entries) {
    if (loc !== 0 && loc !== 1) continue;
    const base = loc === 0 ? 'lever_l' : 'lever_r';
    // Sign of the analog value = direction: + one way, \u2212 the other.
    lever(dev, base + '_pos', value > 0 ? value : 0, value);
    lever(dev, base + '_neg', value < 0 ? -value : 0, value);
    seen.add(base + '_pos');
    seen.add(base + '_neg');
  }
  for (const name of [...dev.active]) if (!seen.has(name)) lever(dev, name, 0, 0);
}
function lever(dev, name, v, signed) {
  if (!dev.active.has(name) && v >= ANALOG_ON) { dev.active.add(name); inputEdge(dev, name, 'down', { analog: signed }); }
  else if (dev.active.has(name) && v <= ANALOG_OFF) { dev.active.delete(name); inputEdge(dev, name, 'up', { analog: signed }); }
}
function releaseDevice(dev) {
  for (const [name, st] of Object.entries(combo)) {
    st.ignored.delete(dev);
    if (st.holders.has(dev)) inputEdge(dev, name, 'up', { note: 'controller disconnected' });
  }
  dev.active.clear();
  dev.prev = null;
}

async function readBattery(dev, server) {
  try {
    const batSvc = await server.getPrimaryService(BAT_SVC);
    const batChr = await batSvc.getCharacteristic(BAT_CHR);
    const applyBat = (dv) => {
      if (!dv || dv.byteLength < 1) return false;
      const pct = dv.getUint8(0);
      if (dev.battery === pct) return false;
      dev.battery = pct;
      updateStatus();
      return true;
    };
    const dv = await batChr.readValue();
    if (applyBat(dv)) {
      note('battery', (dev.device.name || 'controller') + ':', dev.battery + '%');
    }
    if (batChr.properties && batChr.properties.notify) {
      batChr.addEventListener('characteristicvaluechanged', (e) => {
        applyBat(e.target && e.target.value);
      });
      await batChr.startNotifications();
    } else {
      const poll = setInterval(async () => {
        if (!dev.up || stopped) { clearInterval(poll); return; }
        try { applyBat(await batChr.readValue()); } catch {}
      }, 120000);
      terra.onCleanup(() => clearInterval(poll));
    }
  } catch {
    // Battery service is optional on some firmware / adapters
  }
}

/* ---------- BLE (through Terra's Web Bluetooth shim) ---------- */
async function attach(dev) {
  const server = await dev.device.gatt.connect();
  const svc = await server.getPrimaryService(SVC);
  const chars = await svc.getCharacteristics();
  let writeCh = null;
  for (const c of chars) {
    const p = c.properties;
    if (!writeCh && (p.write || p.writeWithoutResponse)) writeCh = c;
    if (p.notify || p.indicate) {
      c.addEventListener('characteristicvaluechanged', (e) => {
        const v = e.target.value;
        onNotify(dev, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
      await c.startNotifications();
    }
  }
  if (!writeCh) throw new Error('no writable characteristic on Zwift service');
  const hs = new TextEncoder().encode('RideOn');
  if (writeCh.properties.writeWithoutResponse) await writeCh.writeValueWithoutResponse(hs);
  else await writeCh.writeValue(hs);
  dev.prev = null;
  dev.up = true;
  note('connected', dev.device.name || dev.device.id);
  updateStatus();
  readBattery(dev, server);
  if (mode === 'ride' && (!obcDevice || !obcDevice.gatt.connected)) maybePairObcMock();
}

// Retry until the controller is reachable (it may be switched off or asleep for a while).
async function keepAlive(dev) {
  if (dev.retrying) return;
  dev.retrying = true;
  let n = 0;
  while (!dev.up && !stopped) {
    try { await attach(dev); break; }
    catch (e) {
      if (n % 10 === 0) note('waiting for', dev.device.name || 'controller', '- switch it on (' + (e.message || e) + ')');
      n++;
      await sleep(String(e.message || e).includes('unknown device') ? 15000 : 3000);
    }
  }
  dev.retrying = false;
}

function register(device) {
  if ([...devs].some((d) => d.device.id === device.id)) return null;
  const dev = { device, prev: null, active: new Set(), up: false, battery: null, n: devs.size + 1 };
  devs.add(dev);
  device.addEventListener('gattserverdisconnected', () => {
    dev.up = false;
    dev.battery = null;
    releaseDevice(dev);
    note('disconnected', device.name || device.id);
    updateStatus();
    if (!stopped) keepAlive(dev);
  });
  return dev;
}

// When ride keys are off, hand the controller to the page on ride pages so Biketerra's own Zwift Ride
// support can pair it; everywhere else the addon keeps it for D-pad navigation.
function applyShare() {
  const handToPage = !rideEnabled && mode === 'ride';
  terra.ble.setShared(handToPage).catch((e) => note('share failed:', e.message || e));
  if (mode !== 'ride' || !rideEnabled) disconnectObcMock();
}

/* ---------- Virtual OpenBikeControl (OBC) shifter for native auto Virtual Shifting ---------- */
const OBC_MOCK_ID = 'zwift-ride-obc-mock';
const OBC_MOCK_NAME = 'Zwift Ride (OBC)';
const OBC_SVC = 'd273f680-d548-419d-b9d1-fa0472345229';
const OBC_BTN_CHR = 'd273f681-d548-419d-b9d1-fa0472345229';
const OBC_HAP_CHR = 'd273f682-d548-419d-b9d1-fa0472345229';
const OBC_APP_CHR = 'd273f683-d548-419d-b9d1-fa0472345229';
const DIS_SVC = '0000180a-0000-1000-8000-00805f9b34fb';
const DIS_MFR_CHR = '00002a29-0000-1000-8000-00805f9b34fb';
const DIS_MODEL_CHR = '00002a24-0000-1000-8000-00805f9b34fb';

const OBC_FULL_PROPS = {
  broadcast: false, notify: false, indicate: false, read: false,
  write: false, writeWithoutResponse: false,
  authenticatedSignedWrites: false, reliableWrite: false, writableAuxiliaries: false,
};
const obcProps = (keys) => {
  const p = { ...OBC_FULL_PROPS };
  for (const k of keys) p[k] = true;
  return p;
};
const obcU8 = (v) => ArrayBuffer.isView(v)
  ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  : v instanceof ArrayBuffer ? new Uint8Array(v) : Uint8Array.from(v || []);
const obcDv = (a) => new DataView(a.buffer, a.byteOffset, a.byteLength);
const obcNormUuid = (v) => {
  const s = String(v == null ? '' : v).toLowerCase();
  if (s === 'battery_service') return BAT_SVC;
  if (s === 'device_information') return DIS_SVC;
  if (/^[0-9a-f]{4}$/.test(s)) return '0000' + s + '-0000-1000-8000-00805f9b34fb';
  return s;
};
const obcNotFound = (what) => typeof DOMException === 'function'
  ? new DOMException(what + ' not found', 'NotFoundError')
  : Object.assign(new Error(what + ' not found'), { name: 'NotFoundError' });

class ObcMockCharacteristic extends EventTarget {
  constructor(uuid, propertyKeys, initialBytes = null) {
    super();
    this.uuid = uuid;
    this.properties = obcProps(propertyKeys);
    this.value = initialBytes ? obcDv(obcU8(initialBytes)) : null;
    this.service = null;
    this._notifying = false;
    this._writeHandler = null;
  }
  async readValue() {
    if (!this.value) this.value = obcDv(new Uint8Array(0));
    this.dispatchEvent(new Event('characteristicvaluechanged'));
    return this.value;
  }
  async startNotifications() { this._notifying = true; return this; }
  async stopNotifications() { this._notifying = false; return this; }
  async writeValue(v) { return this.writeValueWithResponse(v); }
  async writeValueWithResponse(v) { if (this._writeHandler) return this._writeHandler(obcU8(v)); }
  async writeValueWithoutResponse(v) { if (this._writeHandler) return this._writeHandler(obcU8(v)); }
  async getDescriptor() { throw obcNotFound('descriptor'); }
  async getDescriptors() { return []; }
  _notify(bytes) {
    this.value = obcDv(obcU8(bytes));
    if (!this._notifying) return;
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class ObcMockService {
  constructor(device, uuid, chars) {
    this.device = device;
    this.uuid = uuid;
    this.isPrimary = true;
    this._chars = chars;
    for (const c of chars) c.service = this;
  }
  async getCharacteristics(uuid) {
    if (uuid === undefined) return this._chars;
    const id = obcNormUuid(uuid);
    const list = this._chars.filter((c) => obcNormUuid(c.uuid) === id);
    if (!list.length) throw obcNotFound('characteristic ' + id);
    return list;
  }
  async getCharacteristic(uuid) {
    const id = obcNormUuid(uuid);
    const hit = this._chars.find((c) => obcNormUuid(c.uuid) === id);
    if (!hit) throw obcNotFound('characteristic ' + id);
    return hit;
  }
}

let obcDevice = null;
let obcBtnChar = null;
let obcBatChar = null;
let obcLastBattery = null;

function mirroredBatteryPct() {
  const bats = [...devs]
    .filter((d) => d.up && typeof d.battery === 'number' && !Number.isNaN(d.battery))
    .map((d) => Math.max(0, Math.min(100, Math.round(d.battery))));
  return bats.length ? Math.min(...bats) : 100;
}

function syncObcBattery(force = false) {
  const pct = mirroredBatteryPct();
  if (!obcBatChar) return;
  if (!force && obcLastBattery === pct && obcBatChar.value && obcBatChar.value.byteLength >= 1 && obcBatChar.value.getUint8(0) === pct) {
    return;
  }
  obcLastBattery = pct;
  obcBatChar._notify(new Uint8Array([pct]));
}

function buildObcMockDevice() {
  const core = typeof window !== 'undefined' ? window.__terraCore : null;
  const enc = new TextEncoder();

  // Button State: [0x01, buttonId, state] — report Shift Up (0x01) & Shift Down (0x02) released
  obcBtnChar = new ObcMockCharacteristic(OBC_BTN_CHR, ['read', 'notify'], new Uint8Array([0x01, 0x01, 0x00, 0x02, 0x00]));
  const obcHapChar = new ObcMockCharacteristic(OBC_HAP_CHR, ['write', 'writeWithoutResponse']);
  const obcAppChar = new ObcMockCharacteristic(OBC_APP_CHR, ['write', 'writeWithoutResponse']);
  let loggedApp = false;
  obcAppChar._writeHandler = (b) => {
    if (loggedApp) return;
    loggedApp = true;
    const txt = [...b].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ' ')).join('').trim();
    note('OBC app connected' + (txt ? ': ' + txt : ''));
  };

  obcLastBattery = mirroredBatteryPct();
  obcBatChar = new ObcMockCharacteristic(BAT_CHR, ['read', 'notify'], new Uint8Array([obcLastBattery]));
  const mfrChar = new ObcMockCharacteristic(DIS_MFR_CHR, ['read'], enc.encode('Terra'));
  const modelChar = new ObcMockCharacteristic(DIS_MODEL_CHR, ['read'], enc.encode(OBC_MOCK_NAME));

  const dev = Object.assign(new EventTarget(), {
    id: OBC_MOCK_ID,
    name: OBC_MOCK_NAME,
    watchingAdvertisements: false,
    async watchAdvertisements() { this.watchingAdvertisements = true; return this; },
    async forget() {
      this.gatt.disconnect();
      core?.devices?.delete(this.id);
      return this;
    },
  });

  const obcSvc = new ObcMockService(dev, OBC_SVC, [obcBtnChar, obcHapChar, obcAppChar]);
  const batSvc = new ObcMockService(dev, BAT_SVC, [obcBatChar]);
  const disSvc = new ObcMockService(dev, DIS_SVC, [mfrChar, modelChar]);
  const services = [obcSvc, batSvc, disSvc];

  dev.gatt = {
    device: dev,
    connected: false,
    connect: async () => {
      loggedApp = false;
      dev.gatt.connected = true;
      syncObcBattery(true);
      try { core?.bus?.emit('ble:connected', { deviceId: dev.id, name: dev.name }); } catch {}
      return dev.gatt;
    },
    disconnect: () => {
      if (!dev.gatt.connected) return;
      dev.gatt.connected = false;
      try { core?.bus?.emit('ble:disconnected', { deviceId: dev.id, name: dev.name }); } catch {}
      dev.dispatchEvent(new Event('gattserverdisconnected'));
    },
    getPrimaryServices: async (uuid) => {
      if (!dev.gatt.connected) throw new DOMException('GATT server not connected', 'NetworkError');
      if (uuid === undefined) return services;
      const id = obcNormUuid(uuid);
      const list = services.filter((s) => obcNormUuid(s.uuid) === id);
      if (!list.length) throw obcNotFound('service ' + id);
      return list;
    },
    getPrimaryService: async (uuid) => {
      if (!dev.gatt.connected) throw new DOMException('GATT server not connected', 'NetworkError');
      const id = obcNormUuid(uuid);
      const hit = services.find((s) => obcNormUuid(s.uuid) === id);
      if (!hit) throw obcNotFound('service ' + id);
      return hit;
    },
  };

  return dev;
}

function sendObcButton(buttonId, down) {
  if (!obcBtnChar || !obcDevice || !obcDevice.gatt.connected) return;
  obcBtnChar._notify(new Uint8Array([0x01, buttonId & 0xff, down ? 0x01 : 0x00]));
}

function disconnectObcMock() {
  const core = typeof window !== 'undefined' ? window.__terraCore : null;
  if (obcDevice) {
    try { obcDevice.gatt.disconnect(); } catch {}
  }
  try { core?.devices?.delete(OBC_MOCK_ID); } catch {}
}

function isObcRequest(options) {
  const filters = (options && options.filters) || [];
  for (const f of filters) {
    if (f && f.services && f.services.some((s) => obcNormUuid(s) === OBC_SVC)) return true;
  }
  const opt = (options && options.optionalServices) || [];
  return opt.some((s) => obcNormUuid(s) === OBC_SVC);
}

function isObcExcluded(options) {
  const ex = (options && options.exclusionFilters) || [];
  return ex.some((f) => f && f.name === OBC_MOCK_NAME);
}

function shouldMockObc() {
  if (!autoVirtualShift || mode !== 'ride' || !rideEnabled) return false;
  if (typeof window !== 'undefined' && window.__terraMode === 'row') return false;
  return count() > 0;
}

function serveObcMock(settledCb) {
  const core = typeof window !== 'undefined' ? window.__terraCore : null;
  if (!obcDevice) obcDevice = buildObcMockDevice();
  try { core?.devices?.set(obcDevice.id, obcDevice); } catch {}
  if (obcDevice.gatt) obcDevice.gatt.connected = true; // connect immediately, matching wifi-trainer-bridge
  try { window.__terraLastPaired = obcDevice.id; } catch {}
  try { if (settledCb) settledCb(true); } catch {}
  try { core?.bus?.emit('ble:paired', { deviceId: obcDevice.id, name: obcDevice.name }); } catch {}
  note('paired virtual OpenBikeControl shifter:', obcDevice.name);
  return obcDevice;
}

function maybePairObcMock() {
  if (!shouldMockObc()) return;
  if (obcDevice && obcDevice.gatt.connected) return;
  if (typeof window !== 'undefined' && typeof window.__terraSettled === 'function') return;
  let btn = null;
  for (const el of document.querySelectorAll('button, [role="button"], a, div, span')) {
    const t = (el.innerText || '').trim().toLowerCase();
    if (!t.startsWith('pair device') || t.length > 40) continue;
    if (!btn || btn.contains(el)) btn = el;
  }
  btn = btn && (btn.closest('button, [role="button"], a') || btn);
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const target = (r.width && r.height && document.elementFromPoint(x, y)) || btn;
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const ptr = t.startsWith('pointer');
    target.dispatchEvent(new (ptr ? PointerEvent : MouseEvent)(t, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: t.endsWith('down') ? 1 : 0, detail: 1,
      ...(ptr ? { pointerId: 1, pointerType: 'mouse', isPrimary: true } : {}),
    }));
  }
}

(function installObcHook() {
  if (typeof navigator === 'undefined' || !navigator.bluetooth || typeof navigator.bluetooth.requestDevice !== 'function') return;
  const origRequestDevice = navigator.bluetooth.requestDevice;
  const wrappedRequestDevice = async function (options = {}) {
    if (options && options.__terraOwner) return origRequestDevice.call(this, options);

    if (isObcRequest(options) && !isObcExcluded(options) && shouldMockObc()) {
      const settled = typeof window !== 'undefined' && typeof window.__terraSettled === 'function'
        ? window.__terraSettled : null;
      return serveObcMock(settled);
    }

    return origRequestDevice.call(this, options);
  };
  navigator.bluetooth.requestDevice = wrappedRequestDevice;
  terra.onCleanup(() => {
    if (navigator.bluetooth && navigator.bluetooth.requestDevice === wrappedRequestDevice) {
      navigator.bluetooth.requestDevice = origRequestDevice;
    }
    disconnectObcMock();
  });
})();
