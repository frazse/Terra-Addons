// ============================================================================
// Wi-Fi Trainer Bridge — presents a Wi-Fi Wahoo Kickr (WFTNP over TCP) to
// BikeTerra as a standard Web Bluetooth trainer.
//
//   game ──Web BT──▶ mock GATT (this file) ──WFTNP over TCP──▶ Kickr
//
//   Data   : Kickr 2A63 (CPS) notify → power + crank counters → cadence
//            meter → synthesized FTMS indoor-bike-data (2AD2) → game.
//            Kickr-native 2AD2 (if any) relays verbatim and wins.
//   Control: game writes 2AD9 (FTMS control point) / WIA char → WFTNP
//            write to the Kickr.  Kickr 2AD9/WIA notifies relay back.
//
//   Setting: "host" (Kickr IP), "port" (WFTNP TCP port; Wahoo's spec default
//            is 36866 — verified for this unit by its previous working client.
//            The Kickr also runs a separate _zwift-protocol socket (observed
//            on 36867, silent to WFTNP) — used here only as last-resort fallback).
// ============================================================================

// ---------- byte helpers ----------
const u8 = (v) => ArrayBuffer.isView(v)
  ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
  : v instanceof ArrayBuffer
    ? new Uint8Array(v)
    : Uint8Array.from(v);
const dv = (a) => new DataView(a.buffer, a.byteOffset, a.byteLength);
const hex = (a) => {
  a = u8(a);
  const n = Math.min(a.length, 48);
  let s = '';
  for (let i = 0; i < n; i++) s += a[i].toString(16).padStart(2, '0') + ' ';
  return s.trim() + (a.length > n ? ' …' : '');
};
const concat = (...parts) => {
  parts = parts.map(u8);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

// ---------- game-facing UUIDs (what BikeTerra sees) ----------
const base128 = (n) => '0000' + n.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb';
const POWER_SVC = base128(0x1818); // Cycling Power
const FTMS_SVC = base128(0x1826); // Fitness Machine
const SPD_SVC = base128(0x1816); // Cycling Speed & Cadence
const CHR_2A63 = base128(0x2a63); // Cycling Power Measurement
const CHR_2AD2 = base128(0x2ad2); // Indoor Bike Data (FTMS)
const CHR_2AD9 = base128(0x2ad9); // FTMS Control Point
const CHR_2ACC = base128(0x2acc); // FTMS Feature
const CHR_WIA = 'a026e005-0a7d-4ab3-97fa-f1500f9feb8b'; // Wahoo WIA
const VS_SVC = base128(0xfc82); // Zwift-style virtual shifting service (0xFC82)
const ZWIFT_VS_CHAR = '00000003-19ca-4651-86e5-fa29dcdd09d1'; // gear-ratio char

function normalizeUuid(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (s === 'cycling_power' || s === 'cyclingpower') return POWER_SVC;
  if (s === 'fitness_machine' || s === 'fitnessmachine') return FTMS_SVC;
  if (s === 'cycling_speed_and_cadence' || s === 'speedcadence') return SPD_SVC;
  if (/^[0-9a-f]{4}$/.test(s)) return base128(parseInt(s, 16));
  return s;
}

// ---------- WFTNP wire UUIDs (16 bytes, "text order" per the Wahoo spec) ----------
const wireUuid16 = (n) => new Uint8Array([0, 0, (n >>> 8) & 0xff, n & 0xff, 0, 0, 0x10, 0, 0x80, 0, 0, 0x80, 0x5f, 0x9b, 0x34, 0xfb]);
const WIRE_2A63 = wireUuid16(0x2a63);
const WIRE_2AD2 = wireUuid16(0x2ad2);
const WIRE_2AD9 = wireUuid16(0x2ad9);
const WIRE_WIA = Uint8Array.from([0xa0, 0x26, 0xe0, 0x05, 0x0a, 0x7d, 0x4a, 0xb3, 0x97, 0xfa, 0xf1, 0x50, 0x0f, 0x9f, 0xeb, 0x8b]);
const WIRE_VS = Uint8Array.from([0x00, 0x00, 0x00, 0x03, 0x19, 0xca, 0x46, 0x51, 0x86, 0xe5, 0xfa, 0x29, 0xdc, 0xdd, 0x09, 0xd1]);
const uuidEq = (a, b) => {
  const x = u8(a), y = u8(b);
  return x.length === 16 && y.length === 16 && x.every((c, i) => c === y[i]);
};
const shortName = (wire) =>
  uuidEq(wire, WIRE_2A63) ? '2A63'
    : uuidEq(wire, WIRE_2AD2) ? '2AD2'
      : uuidEq(wire, WIRE_2AD9) ? '2AD9'
        : uuidEq(wire, WIRE_WIA) ? 'a026e005'
          : uuidEq(wire, WIRE_VS) ? 'fc82-vs'
            : hex(wire);

// ---------- WFTNP framing: [0x01, type, seq, respCode, dataLen BE16, data…] ----------
// The fixed header is 6 bytes: Optional Data starts at offset 6. Confirmed by
// both the elfrances/wahoo-fitness-tnp spec text ("Data Length: … of the
// Optional Data that follows the fixed message header", header = version,
// type, seq, respCode, 16-bit length) and the working kilianyp/hacs-wahoo-wftnp
// client (struct "!BBBBH" + readexactly(6)). NOT the 8-offset misread of the
// spec's ASCII art that this file originally carried.
const WFTNP = { DISCOVER_SERVICES: 1, DISCOVER_CHARS: 2, READ: 3, WRITE: 4, ENABLE: 5, NOTIFY: 6 };
const WFTNP_RESP = { 0: 'ok', 3: 'service not found', 4: 'characteristic not found', 5: 'operation not supported', 6: 'write failed' };
function wftnp(type, seq, respCode, data = new Uint8Array(0)) {
  data = u8(data);
  const out = new Uint8Array(6 + data.length);
  out[0] = 0x01;
  out[1] = type & 0xff;
  out[2] = seq & 0xff;
  out[3] = respCode & 0xff;
  out[4] = (data.length >>> 8) & 0xff;
  out[5] = data.length & 0xff;
  out.set(data, 6);
  return out;
}

// ---------- value decoding — ported verbatim from BikeTerra (helpers N/P) ----------
function N({ dataview: e, bytes: t = 1, offset: n = 0, signed: r = false }) {
  let i = 0;
  for (let x = 0; x < t; x++) i += e.getUint8(n + x) * (2 ** (8 * x));
  if (r && i >= 2 ** (t * 8 - 1)) i -= 2 ** (t * 8);
  return i;
}
function P(e, t) {
  const flags = N({ dataview: e, bytes: t.flags.bytes });
  const r = {};
  let i = t.flags.bytes;
  for (const [a, o] of Object.entries(t)) {
    if (a === 'flags') continue;
    if (!(o.alwaysPresent || ((flags >> o.flagBit) & 1) === +!o.oddball)) continue;
    const s = N({ dataview: e, bytes: o.bytes, offset: i, signed: o.signed });
    i += o.bytes;
    if (s !== o.invalid) r[o.alias ?? a] = s * (o.multiplier ?? 1);
  }
  return r;
}

// 2A63 Cycling Power Measurement (table as in BikeTerra)
const ZE = {
  flags: { bytes: 2 },
  instantaneousPower: { bytes: 2, alwaysPresent: true, signed: true },
  pedalPowerBalance: { bytes: 1, flagBit: 0, multiplier: 0.5 },
  accumulatedTorque: { bytes: 2, flagBit: 2, multiplier: 1 / 32 },
  cumulativeWheelRevolutions: { bytes: 4, flagBit: 4 },
  lastWheelEventTime: { bytes: 2, flagBit: 4, multiplier: 1 / 2048 },
  cumulativeCrankRevolutions: { bytes: 2, flagBit: 5 },
  lastCrankEventTime: { bytes: 2, flagBit: 5, multiplier: 1 / 1024 },
  maximumForceMagnitude: { bytes: 2, flagBit: 6, signed: true },
  minimumForceMagnitude: { bytes: 2, flagBit: 6, signed: true },
  maximumTorqueMagnitude: { bytes: 2, flagBit: 7, multiplier: 1 / 32, signed: true },
  minimumTorqueMagnitude: { bytes: 2, flagBit: 7, multiplier: 1 / 32, signed: true },
};

// 2AD2 Indoor Bike Data (table as in BikeTerra; instantaneousSpeed is the
// "oddball": present when bit 0 is CLEAR — matching real Kickr traffic)
const KE = {
  flags: { bytes: 2 },
  instantaneousSpeed: { bytes: 2, flagBit: 0, multiplier: 0.01, oddball: true },
  averageSpeed: { bytes: 2, flagBit: 1, multiplier: 0.01 },
  instantaneousCadence: { bytes: 2, flagBit: 2, multiplier: 0.5, alias: 'cadence' },
  averageCadence: { bytes: 2, flagBit: 3, multiplier: 0.5 },
  totalDistance: { bytes: 3, flagBit: 4 },
  resistanceLevel: { bytes: 2, flagBit: 5, signed: true },
  instantaneousPower: { bytes: 2, flagBit: 6, alias: 'power', signed: true },
  averagePower: { bytes: 2, flagBit: 7, signed: true },
  totalEnergy: { bytes: 2, flagBit: 8 },
  energyPerHour: { bytes: 2, flagBit: 8 },
  energyPerMinute: { bytes: 1, flagBit: 8 },
  heartRate: { bytes: 1, flagBit: 9, invalid: 0 },
  metabolicEquivalent: { bytes: 1, flagBit: 10 },
  elapsedTime: { bytes: 2, flagBit: 11 },
  remainingTime: { bytes: 2, flagBit: 12 },
};

// Cadence from crank counters — ported verbatim from BikeTerra's class R.
// Feed cumulativeCrankRevolutions (u16) + lastCrankEventTime (1/1024 s).
class CadenceMeter {
  constructor() {
    this.inactivityThreshold = 3000;
    this.reset = true;
    this.recent = [];
    this.prevRevCount = 0;
    this.prevRevTime = 0;
    this.lastUpdate = 0;
  }
  handleOverflow(a, b) { return (a - b + 65536) % 65536; }
  calculate(rev, time) {
    let cadence = 0;
    const now = Date.now();
    const valid = rev !== undefined && time !== undefined;
    if (this.reset) {
      if (valid) {
        this.reset = false;
        this.recent = [];
        this.prevRevCount = rev;
        this.prevRevTime = time;
        this.lastUpdate = now;
      }
      return cadence;
    }
    if (now - this.lastUpdate > this.inactivityThreshold) {
      this.reset = true;
      return cadence;
    }
    if (valid) {
      const revs = this.handleOverflow(rev, this.prevRevCount);
      const secs = this.handleOverflow(time * 1024, this.prevRevTime * 1024) / 1024;
      if (secs > 0) {
        cadence = Math.round((revs / secs) * 60);
        this.recent = [...this.recent.slice(-1), cadence];
        this.lastUpdate = now;
      }
      this.prevRevCount = rev;
      this.prevRevTime = time;
    }
    if (this.recent.length > 1) cadence = Math.round((this.recent[0] + this.recent[1]) / 2);
    return cadence;
  }
}

// ---------- 2AD2 encoding (inverse of the game's P/KE decode) ----------
function encodeBikeData(f = {}) {
  let flags = 0;
  const body = [];
  for (const [name, o] of Object.entries(KE)) {
    if (name === 'flags') continue;
    const v = f[name];
    if (v === undefined || v === null) continue;
    if (!o.oddball) flags |= 1 << o.flagBit;
    const raw = o.multiplier ? Math.round(v / o.multiplier) : Math.round(v);
    const bytes = new Uint8Array(o.bytes);
    const u = o.signed ? (raw & 0xffffffff) : (raw >>> 0);
    for (let i = 0; i < o.bytes; i++) bytes[i] = (u >>> (8 * i)) & 0xff;
    body.push(bytes);
  }
  return concat([flags & 0xff, (flags >> 8) & 0xff], ...body);
}
// Proven layout: [0x44 0x00, speed 2B (=0), cadence 2B (×½), power i16]
const synthBikeData = (cadence, watts) => encodeBikeData({
  instantaneousSpeed: 0, // oddball field: present = bit 0 clear
  instantaneousCadence: Math.max(0, Math.round(cadence)),
  instantaneousPower: Math.max(-32768, Math.min(32767, Math.round(watts))),
});
// ---------- mock GATT — the Web-BT API surface BikeTerra drives ----------
const FULL_PROPS = {
  broadcast: false, notify: false, indicate: false, read: false,
  write: false, writeWithoutResponse: false,
  authenticatedSignedWrites: false, reliableWrite: false, writableAuxiliaries: false,
};
const props = (keys) => {
  const p = { ...FULL_PROPS };
  for (const k of keys) p[k] = true;
  return p;
};
const notFound = (what) => {
  const e = typeof DOMException === 'function'
    ? new DOMException(what + ' not found', 'NotFoundError')
    : Object.assign(new Error(what + ' not found'), { name: 'NotFoundError' });
  return e;
};

class MockCharacteristic extends EventTarget {
  constructor(uuid, propertyKeys, defaults) {
    super();
    this.uuid = uuid;
    this.properties = props(propertyKeys);
    this.value = defaults ? dv(u8(defaults)) : null;
    this._notifying = false;
    this._writeHandler = null; // (bytes: Uint8Array) => Promise
    this._service = null;
  }
  async readValue() { return this.value ?? dv(new Uint8Array([0, 0])); }
  async startNotifications() { this._notifying = true; return this; }
  async stopNotifications() { this._notifying = false; return this; }
  async writeValueWithResponse(v) { return this._write(v); }
  async writeValueWithoutResponse(v) { return this._write(v); }
  async _write(v) {
    if (this._writeHandler) return this._writeHandler(u8(v));
  }
  _notify(bytes) {
    this.value = dv(u8(bytes));
    if (!this._notifying) return;
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

class MockService extends EventTarget {
  constructor(uuid, charArray) {
    super();
    this.uuid = uuid;
    this._chars = charArray;
    for (const c of charArray) c._service = this;
  }
  async getCharacteristics() { return this._chars; }
  async getCharacteristic(uuid) {
    const hit = this._chars.find((c) => normalizeUuid(c.uuid) === normalizeUuid(uuid));
    if (!hit) throw notFound('characteristic');
    return hit;
  }
}

class MockDevice extends EventTarget {
  constructor(name, services) {
    super();
    this.id = 'wifi-trainer-bridge';
    this.name = name;
    this.watchingAdvertisements = false;
    this._services = services;
    this.gatt = {
      device: this,
      connected: false,
      connect: async () => { this.gatt.connected = true; return this.gatt; },
      disconnect: () => { this.gatt.connected = false; this.dispatchEvent(new Event('gattserverdisconnected')); },
      getPrimaryServices: async () => services,
      getPrimaryService: async (uuid) => {
        const s = services.find((x) => normalizeUuid(x.uuid) === normalizeUuid(uuid));
        if (!s) throw notFound('service');
        return s;
      },
    };
  }
  async watchAdvertisements() { this.watchingAdvertisements = true; return this; }
  async forget() { return this; }
}

// The GATT tree the game sees (a Kickr with FTMS + its WIA char).
function buildMock(bridge) {
  const powerChar = new MockCharacteristic(CHR_2A63, ['notify']);
  const wiaChar = new MockCharacteristic(CHR_WIA, ['write', 'writeWithoutResponse', 'notify', 'indicate']);
  wiaChar._writeHandler = (b) => bridge.write(WIRE_WIA, b);
  const powerSvc = new MockService(POWER_SVC, [powerChar, wiaChar]);

  const bikeData = new MockCharacteristic(CHR_2AD2, ['notify'], synthBikeData(0, 0));
  const ftmsCp = new MockCharacteristic(CHR_2AD9, ['write', 'indicate', 'notify']);
  ftmsCp._writeHandler = (b) => bridge.write(WIRE_2AD9, b);
  // FTMS Feature: flags, 0–2200 W, 0–500 m/s (0.01 units), −50%…+25% (1/512)
  const ftmsFeature = new MockCharacteristic(CHR_2ACC, ['read'], new Uint8Array([
    0x01, 0x00, 0x00, 0x00, 0xc8, 0x08, 0x00, 0x00, 0x50, 0xc3, 0x80, 0x00, 0x00, 0xff,
  ]));
  const ftmsSvc = new MockService(FTMS_SVC, [bikeData, ftmsCp, ftmsFeature]);

  // Zwift-style virtual shifting (0xFC82): the gear-ratio char is write-only
  // (Write Without Response on a real Zwift-connected trainer); realistic-gears
  // and the game push raw packet bytes here, which we relay to the Kickr.
  const vsChar = new MockCharacteristic(ZWIFT_VS_CHAR, ['write', 'writeWithoutResponse']);
  vsChar._writeHandler = (b) => bridge.write(WIRE_VS, b);
  const vsSvc = new MockService(VS_SVC, [vsChar]);

  return new MockDevice('KICKR Wi-Fi', [powerSvc, ftmsSvc, vsSvc]);
}

// Wire Kickr notify callbacks to the mock's outbound notifications.
function wireBridge(bridge, device) {
  const find = (uuid) => {
    for (const s of device._services) {
      const c = s._chars.find((x) => x.uuid === uuid);
      if (c) return c;
    }
    return null;
  };
  const powerChar = find(CHR_2A63);
  const wiaChar = find(CHR_WIA);
  const bikeData = find(CHR_2AD2);
  const ftmsCp = find(CHR_2AD9);
  const vsChar = find(ZWIFT_VS_CHAR);

  // 2A63: keep real power + run the game's cadence algorithm, then publish.
  bridge.onCps = (value) => {
    let d = {};
    try { d = P(dv(u8(value)), ZE); } catch (e) { bridge.log('bad 2A63: ' + e.message); return; }
    if (typeof d.instantaneousPower === 'number') bridge.lastWatts = d.instantaneousPower;
    const cad = bridge.cadenceMeter.calculate(d.cumulativeCrankRevolutions, d.lastCrankEventTime);
    if (cad > 0) bridge.lastCadence = cad;
    const watts = typeof d.instantaneousPower === 'number' ? d.instantaneousPower : bridge.lastWatts;
    if (Date.now() - bridge.lastRealBikeData > 2500) {
      // Kickr isn't streaming its own 2AD2 — synthesize one.
      if (bikeData) bikeData._notify(synthBikeData(bridge.lastCadence, watts));
    }
    if (powerChar) powerChar._notify(value);
    bridge.log('ride ' + Math.round(watts) + 'W ' + Math.round(bridge.lastCadence) + 'rpm');
  };

  // 2AD2: Kickr's own stream — pass it on, refreshed with our cadence state.
  bridge.onBikeData = (value) => {
    bridge.lastRealBikeData = Date.now();
    let d = {};
    try { d = P(dv(u8(value)), KE); } catch (e) { /* unparseable — still relay raw */ }
    if (typeof d.cadence === 'number' && d.cadence > 0) bridge.lastCadence = d.cadence;
    if (typeof d.power === 'number') bridge.lastWatts = d.power;
    if (bikeData) bikeData._notify(value);
  };

  bridge.onControl = (value) => { if (ftmsCp) ftmsCp._notify(value); };
  bridge.onWia = (value) => { if (wiaChar) wiaChar._notify(value); };
  bridge.onVs = (value) => { if (vsChar) vsChar._notify(value); };
}

// Is this a requestDevice call asking for a trainer?
function isTrainerRequest(options) {
  const filters = (options && options.filters) || [];
  for (const f of filters) {
    if (!f || !f.services) continue;
    for (const s of f.services) {
      const id = normalizeUuid(s);
      if (id === FTMS_SVC || id === POWER_SVC || id === SPD_SVC || id === VS_SVC) return true;
    }
  }
  return false;
}

// ---------- the WFTNP-over-TCP bridge ----------
class WahooBridge {
  constructor(log) {
    this.log = log;
    this.terra = null;
    this.conn = null;
    this.buf = new Uint8Array(0);
    this.seq = 0;
    this.lastPort = null;
    this.badPort = null;
    this._lastCpOpcode = undefined;
    this.pending = new Map(); // seq → {resolve, reject, timer, label}
    this.timer = null;
    this.backoff = 2000;
    this.stopping = false;
    this.connecting = false;
    this.cadenceMeter = new CadenceMeter();
    this.lastCadence = 0;
    this.lastWatts = 0;
    this.lastRealBikeData = 0;
    this._resyncLogged = false;
    this.onCps = null;
    this.onBikeData = null;
    this.onControl = null;
    this.onWia = null;
    this.onVs = null;
  }

  start(terra) {
    this.terra = terra;
    this.loop().catch((e) => this.log('boot: ' + (e && e.message || e)));
  }

  // Connect + discovery, single-flight, with exponential-backoff retries.
  // The Kickr is a single-session server — it latches and refuses new
  // connections for a while after each session. Known WFTNP ports:
  //   36866 — spec default; the client that previously drove this exact
  //           Kickr connected here successfully (device ground truth).
  //   36867 — observed open on this unit, but it answered neither 6-byte nor
  //           8-byte WFTNP DISCOVER; it matches the mDNS-advertised separate
  //           _zwift-protocol socket. Kept only as a last-resort fallback.
  // Refused attempts are plain RSTs and burn no device session, so probing
  // both is safe. If a port connects but discovery fails (wrong protocol),
  // remember it as bad so the next cycle prefers the other port and we stop
  // spending sessions on it.
  async loop() {
    if (this.connecting || this.stopping) return;
    this.connecting = true;
    let ok = false;
    try {
      const s = (await this.terra.settings.all()) || {};
      const configured = Math.round(Number(s.port));
      const first = (Number.isInteger(configured) && configured > 0) ? configured : (this.lastPort || 36866);
      const candidates = [first, 36866, 36867].filter((p, i, a) => a.indexOf(p) === i);
      let tried = first, failed = null;
      let conn = null;
      let lastErr = null;
      for (const port of candidates) {
        if (this.badPort === port && candidates.length > 1) {
          failed = port; // defer the known-bad port to the last slot
          continue;
        }
        try {
          conn = await this.terra.tcp.connect('{{setting:host}}', port, 5000);
          this.lastPort = port;
          break;
        } catch (e) {
          lastErr = e;
          this.log('port ' + port + ': ' + ((e && e.message) || e));
        }
      }
      if (failed !== null) {
        try {
          conn = await this.terra.tcp.connect('{{setting:host}}', failed, 5000);
          this.lastPort = failed;
        } catch (e) {
          if (!conn) lastErr = e;
        }
      }
      if (!conn) throw lastErr || new Error('no WFTNP port answered');
      this.conn = conn;
      this.buf = new Uint8Array(0);
      this._failPending('reconnecting');
      this.log('tcp connected (' + conn + ') — WFTNP port ' + this.lastPort);
      await this.discover();
      this.badPort = null;
      this.backoff = 2000;
      ok = true;
    } catch (e) {
      this.conn = null;
      this.buf = new Uint8Array(0);
      this._failPending('connect failed');
      // Connected but the socket didn't speak WFTNP (e.g. it is the Zwift
      // _zwift-protocol socket): prefer the other port next cycle.
      if (this.lastPort && /discover|response code|timeout|not found/i.test((e && e.message) || '')) {
        this.badPort = this.lastPort;
        this.log('marking port ' + this.lastPort + ' as non-WFTNP; next cycle prefers ' + (this.lastPort === 36866 ? 36867 : 36866));
      }
      this.log('not connected: ' + (e && e.message || e));
    } finally {
      this.connecting = false;
    }
    if (!ok && !this.stopping) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.timer || this.stopping) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 15000);
    this.log('retry in ' + delay + 'ms');
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopping) this.loop().catch(() => {});
    }, delay);
    if (typeof this.timer.unref === 'function') { try { this.timer.unref(); } catch (e) { /* page: noop */ } }
  }

  onLost(e) {
    this.log('connection lost: ' + ((e && (e.reason || e.state)) || 'closed') + (e && e.peer ? ' [' + e.peer + ']' : ''));
    this.conn = null;
    this.buf = new Uint8Array(0);
    this._failPending('connection lost');
    if (this.stopping || this.connecting) return; // in-flight loop handles retry
    this.scheduleReconnect();
  }

  restart(reason) {
    this.log('restart (' + reason + ')');
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const old = this.conn;
    this.conn = null;
    this._failPending('restart');
    this.backoff = 2000;
    if (old && this.terra) this.terra.tcp.close(old).catch(() => {});
    this.loop().catch((e) => this.log('restart: ' + (e && e.message || e)));
  }

  stop() {
    this.stopping = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this._failPending('addon stop');
    const old = this.conn;
    this.conn = null;
    if (old && this.terra) this.terra.tcp.close(old).catch(() => {});
  }

  async discover() {
    const svc = await this.request(WFTNP.DISCOVER_SERVICES, new Uint8Array(0), 'discover services');
    const seen = [];
    for (let i = 0; i + 16 <= svc.length; i += 16) {
      const n = (svc[i + 2] << 8) | svc[i + 3];
      if (n > 0 && n < 0x4000) seen.push('0x' + n.toString(16));
    }
    this.log('services: ' + (seen.join(', ') || '(none 16-bit)'));
    for (const [label, wire] of [
      ['2A63', WIRE_2A63],
      ['2AD9', WIRE_2AD9],
      ['2AD2', WIRE_2AD2],
      ['a026e005', WIRE_WIA],
      ['fc82-vs', WIRE_VS],
    ]) {
      try {
        await this.request(WFTNP.ENABLE, concat(wire, [0x01]), 'enable ' + label, 3000);
      } catch (e) {
        this.log(label + ': ' + e.message); // missing char is fine — just unused
      }
    }
    this.log('ready — Kickr traffic will be relayed');
  }

  request(type, data, label, timeoutMs = 4000) {
    if (!this.terra) return Promise.reject(new Error('bridge not started'));
    const conn = this.conn;
    if (!conn) return Promise.reject(new Error('not connected to Kickr'));
    const seq = (this.seq = (this.seq % 255) + 1);
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error((label || 'wftnp') + ': timeout after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer, label });
    });
    this.terra.tcp.send(conn, wftnp(type, seq, 0, data)).catch((e) => {
      const q = this.pending.get(seq);
      if (q) {
        clearTimeout(q.timer);
        this.pending.delete(seq);
        q.reject(new Error((label || 'wftnp') + ': send failed (' + (e && e.message || e) + ')'));
      }
    });
    return p;
  }

  async write(wire, value) {
    const name = shortName(wire);
    if (uuidEq(wire, WIRE_2AD9) && u8(value).length > 0) this._lastCpOpcode = u8(value)[0] & 0xff;
    this.log('→ kickr ' + name + ' [' + hex(value) + ']');
    const resp = await this.request(WFTNP.WRITE, concat(wire, value), 'write ' + name, 4000);
    if (resp && resp.length > 16) this._emitWriteExtras(wire, resp);
  }

  // FTMS control-point ack shaping. The game expects the status form
  // [0x80, opcode, result] after every 2AD9 write (it checks for
  // [0x80, 0x00, 0x01] before sending 0x11/0x05). On this Kickr the raw
  // server→client ack has been observed as bare opcode byte(s) — the
  // previous working bridge synthesized [0x80, payload[0], 0x01] exactly
  // for this reason. Normalize either way: if the device already sends the
  // [0x80, …] form pass it through; otherwise wrap its opcode (or the last
  // opcode we wrote) into the success form.
  shapeCpAck(value) {
    const v = u8(value);
    if (v.length >= 1 && v[0] === 0x80) return v;
    const op = v.length > 0 ? v[0] : (this._lastCpOpcode === undefined ? 0 : this._lastCpOpcode);
    return new Uint8Array([0x80, op & 0xff, 0x01]);
  }

  _emitControl(value) {
    if (!this.onControl) return;
    try { this.onControl(this.shapeCpAck(value)); } catch (e) { this.log('emit fail: ' + e.message); }
  }

  // Some Kickr firmware piggybacks a characteristic's new value inside the
  // WRITE response (a 16-byte char UUID, then bytes). For the 2AD9 FTMS
  // control point that new value is the handshake ack [0x80, opcode, result]
  // — the game writes 0x00 and must observe [0x80, 0x00, 0x01] before it
  // sends 0x11 (SIM) or 0x05 (ERG). Emit whatever follows the UUID so the
  // handshake completes even when it never arrives as a separate NOTIFY.
  _emitWriteExtras(wire, resp) {
    const extras = resp.slice(16);
    if (uuidEq(wire, WIRE_2AD9)) {
      this.log('⇢ kickr 2AD9 write response [' + hex(extras) + '] → presenting ' + hex(this.shapeCpAck(extras)));
      this._emitControl(extras);
      return;
    }
    this.log('⇢ kickr write response ' + shortName(wire) + ' [' + hex(extras) + ']');
    const cb = uuidEq(wire, WIRE_WIA) ? this.onWia
      : uuidEq(wire, WIRE_2A63) ? this.onCps
        : uuidEq(wire, WIRE_2AD2) ? this.onBikeData
          : uuidEq(wire, WIRE_VS) ? this.onVs
            : null;
    if (cb) { try { cb(extras); } catch (e) { this.log('emit fail: ' + e.message); } }
  }

  feed(bytes) {
    if (u8(bytes).length === 0) return;
    this.buf = concat(this.buf, bytes);
    let guard = 0;
    while (this.buf.length >= 6 && guard++ < 1024) {
      if (this.buf[0] !== 0x01) {
        if (!this._resyncLogged) {
          this.log('resync: dropping stray byte(s) around [' + hex(this.buf) + ']');
          this._resyncLogged = true;
        }
        this.buf = this.buf.slice(1);
        continue;
      }
      const len = (this.buf[4] << 8) | this.buf[5];
      if (len > 1024) { this.buf = this.buf.slice(1); continue; }
      if (this.buf.length < 6 + len) break;
      const frame = this.buf.slice(0, 6 + len);
      this.buf = this.buf.slice(6 + len);
      this._resyncLogged = false;
      try {
        this.handleFrame(frame);
      } catch (e) {
        this.log('frame error: ' + (e && e.message || e));
      }
    }
  }

  handleFrame(f) {
    const type = f[1];
    const seq = f[2];
    const code = f[3];
    const len = (f[4] << 8) | f[5];
    const data = f.slice(6, 6 + len);
    if (type === WFTNP.NOTIFY) {
      const wire = data.slice(0, 16);
      const value = data.slice(16);
      this.log('← kickr ' + shortName(wire) + ' [' + hex(value) + ']');
      if (uuidEq(wire, WIRE_2A63) && this.onCps) this.onCps(value);
      else if (uuidEq(wire, WIRE_2AD2) && this.onBikeData) this.onBikeData(value);
      else if (uuidEq(wire, WIRE_2AD9) && this.onControl) this._emitControl(value);
      else if (uuidEq(wire, WIRE_WIA) && this.onWia) this.onWia(value);
      else if (uuidEq(wire, WIRE_VS) && this.onVs) this.onVs(value);
      else this.log('  (no handler for ' + shortName(wire) + ')');
      return;
    }
    const p = this.pending.get(seq);
    if (!p) {
      this.log('resp: unknown seq ' + seq + ' (type ' + type + ', ' + (WFTNP_RESP[code] || 'code ' + code) + ')');
      return;
    }
    this.pending.delete(seq);
    clearTimeout(p.timer);
    if (code === 0) p.resolve(data);
    else p.reject(new Error((p.label || 'wftnp') + ': ' + (WFTNP_RESP[code] || 'code ' + code)));
  }

  _failPending(msg) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(msg));
    }
    this.pending.clear();
  }
}
// ---------- boot: intercept pairing, wire the bridge ----------
if (typeof navigator !== 'undefined' && navigator.bluetooth && typeof navigator.bluetooth.requestDevice === 'function') {
  (async function boot() {
    const bridge = new WahooBridge((...a) => {
      const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
      try { terra.log(line); } catch (e) { /* page: terra always exists */ }
    });
    terra.log('boot: presenting a Wi-Fi Kickr over WFTNP');
    bridge.start(terra);

    let device = null;
    const ensureDevice = () => {
      if (!device) {
        device = buildMock(bridge);
        wireBridge(bridge, device);
      }
      return device;
    };

    const core = typeof window !== 'undefined' ? window.__terraCore : null;
    const registerMock = (d) => {
      if (!core || !core.devices) return; // page: core map optional
      try {
        core.devices.set(d.id, d);
        if (core.bus && typeof core.bus.emit === 'function') {
          core.bus.emit('ble:paired', { deviceId: d.id, name: d.name });
        }
      } catch (e) { /* page: core missing */ }
    };

    const origRequestDevice = navigator.bluetooth.requestDevice;
    navigator.bluetooth.requestDevice = async function (options) {
      if (isTrainerRequest(options)) {
        const d = ensureDevice();
        registerMock(d);
        if (d.gatt) d.gatt.connected = true; // rider connects next; bind early (realistic-gears etc.)
        try { if (typeof window !== 'undefined' && window.__terraSettled) window.__terraSettled(true); } catch (e) { /* noop */ }
        bridge.log('pairing rider with the Wi-Fi Kickr mock (' + d.name + ')');
        return d;
      }
      return origRequestDevice.apply(this, arguments);
    };

    terra.tcp.onFrame((e) => {
      if (e && e.conn === bridge.conn) bridge.feed(e.bytes);
    });
    terra.tcp.onState((e) => {
      if (!e || e.conn !== bridge.conn) return;
      if (e.state === 'closed' || e.state === 'error') bridge.onLost(e);
    });
    terra.settings.onChange(() => bridge.restart('settings changed'));
    terra.onCleanup(() => {
      bridge.log('stopping');
      bridge.stop();
      if (device && core && core.devices) {
        try { core.devices.delete(device.id); } catch (e) { /* page */ }
      }
      try {
        if (navigator.bluetooth.requestDevice !== origRequestDevice) {
          navigator.bluetooth.requestDevice = origRequestDevice;
        }
      } catch (e) { /* page: restore failure is harmless */ }
    });
  })().catch((e) => {
    try { console.error('[wifi-trainer-bridge] boot failed:', e); } catch (err) { /* page */ }
  });
}

// Node test harness hook (inert in the page).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    u8, dv, hex, concat,
    base128, normalizeUuid,
    POWER_SVC, FTMS_SVC, SPD_SVC, VS_SVC, CHR_2A63, CHR_2AD2, CHR_2AD9, CHR_2ACC, CHR_WIA, ZWIFT_VS_CHAR,
    wireUuid16, WIRE_2A63, WIRE_2AD2, WIRE_2AD9, WIRE_WIA, WIRE_VS, uuidEq, shortName,
    WFTNP, WFTNP_RESP, wftnp,
    N, P, ZE, KE, CadenceMeter,
    encodeBikeData, synthBikeData,
    MockCharacteristic, MockService, MockDevice, buildMock, wireBridge,
    WahooBridge, isTrainerRequest,
  };
}
