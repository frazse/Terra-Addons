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
  const dev = { device, prev: null, active: new Set(), up: false, n: devs.size + 1 };
  devs.add(dev);
  device.addEventListener('gattserverdisconnected', () => {
    dev.up = false;
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
  terra.ble.setShared(!rideEnabled && mode === 'ride').catch((e) => note('share failed:', e.message || e));
}
