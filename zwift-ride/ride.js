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

const CLICK_HS_V2 = new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x03]); // "RideOn" 02 03
const CLICK_INIT_1 = new Uint8Array([0x00, 0x08, 0x00]);
const CLICK_INIT_2 = new Uint8Array([0x00, 0x08, 0x10]);
const CLICK_FF04_ACK = new Uint8Array([0xff, 0x04, 0x00]);
const CLICK_RESET_CMD = new Uint8Array([0x18]);
const RIDE_HS = new Uint8Array([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);
const wiredChars = new WeakSet();

const isClickDevice = (dev) => !!(dev && (dev.isClick || dev.isClickV2 || isClickName(dev.device && dev.device.name)));

function deviceDisplayName(dev) {
  const base = (dev && dev.device && dev.device.name) || ('Controller #' + (dev ? dev.n : '?'));
  if (dev && dev.side === 'left' && !/\bleft\b/i.test(base)) return base + ' (Left)';
  if (dev && dev.side === 'right' && !/\bright\b/i.test(base)) return base + ' (Right)';
  return base;
}

function inferSideFromChangedMask(changed) {
  const hasL = (changed & LEFT_MASK) !== 0;
  const hasR = (changed & RIGHT_MASK) !== 0;
  if (hasL && !hasR) return 'left';
  if (hasR && !hasL) return 'right';
  return null;
}

function ensureClickRec(id) {
  if (!clickAuth[id] || typeof clickAuth[id] !== 'object') clickAuth[id] = {};
  return clickAuth[id];
}

function setDeviceSide(dev, side) {
  if (!dev || !side || dev.side === side) return;
  dev.side = side;
  if (dev.device && dev.device.id) {
    const rec = ensureClickRec(dev.device.id);
    rec.side = side;
    rec.isClick = true;
    saveClickAuth();
  }
  if (side === 'right') dev.authState = 'exempt';
  updateStatus();
}

function confirmDeviceUnlocked(dev, now = Date.now()) {
  if (!isClickDevice(dev) || dev.side === 'right' || dev.sawStopped) return false;
  if (dev.authState === 'locked' && dev.lockReason !== 'challenge-unsolved') return false;
  const cleanRideOnEcho = !!(dev.handshakeAckAt && !dev.sawChallenge && dev.connectedAt && now - dev.connectedAt >= 10000);
  const activeButtonsPastVerify = !!(dev.lastButtonAt && dev.connectedAt && dev.lastButtonAt - dev.connectedAt >= CLICK_VERIFY_MS);
  if (!cleanRideOnEcho && !activeButtonsPastVerify) return false;
  const rec = dev.device && dev.device.id ? ensureClickRec(dev.device.id) : {};
  const expired = !rec.unlockedAt || now >= rec.unlockedAt + CLICK_UNLOCK_MS;
  const invalidatedByLock = !!(rec.lastLockAt && (!rec.unlockedAt || rec.lastLockAt > rec.unlockedAt));
  let changed = false;
  if (expired || invalidatedByLock || rec.source === 'manual') {
    rec.unlockedAt = now;
    changed = true;
  }
  if (rec.source !== 'verified' || rec.lockReason) {
    rec.source = 'verified';
    rec.lockReason = null;
    rec.isClick = true;
    if (dev.side) rec.side = dev.side;
    changed = true;
  }
  const prevState = dev.authState;
  dev.authState = 'unlocked';
  dev.lockReason = null;
  if (changed) saveClickAuth();
  if (prevState !== 'unlocked') {
    note('Click v2 unlock verified for', deviceDisplayName(dev), '(~24h window active)');
    updateStatus();
    return true;
  }
  return changed;
}

function setDeviceLocked(dev, reason, now = Date.now()) {
  if (!dev) return;
  const prevState = dev.authState;
  dev.authState = 'locked';
  dev.lockReason = reason || 'expired-24h';
  if (!dev.side) dev.side = 'left';
  if (dev.device && dev.device.id) {
    const rec = ensureClickRec(dev.device.id);
    rec.unlockedAt = null;
    rec.source = null;
    rec.lastLockAt = now;
    rec.lockReason = dev.lockReason;
    rec.side = dev.side;
    rec.isClick = true;
    saveClickAuth();
  }
  if (prevState !== 'locked') {
    note(
      'Click v2 locked (' + dev.lockReason + '):',
      deviceDisplayName(dev),
      '- unlock once in the Zwift app (valid 24h)'
    );
  }
  updateStatus();
}

function getDevAuthInfo(dev, now = Date.now()) {
  if (!isClickDevice(dev)) return null;
  if (dev.side === 'right') return { state: 'exempt', side: 'right' };
  const rec = (dev.device && dev.device.id && clickAuth[dev.device.id]) || {};
  if (dev.authState === 'locked' || dev.sawStopped || (!dev.up && rec.lastLockAt && (!rec.unlockedAt || rec.lastLockAt > rec.unlockedAt))) {
    return {
      state: 'locked',
      side: dev.side || rec.side || 'left',
      reason: dev.lockReason || rec.lockReason || 'expired-24h',
      remainingMs: 0,
      unlockedAt: null,
      expiresAt: null,
    };
  }
  if (rec.unlockedAt) {
    const expiresAt = rec.unlockedAt + CLICK_UNLOCK_MS;
    const remainingMs = expiresAt - now;
    if (remainingMs <= 0) {
      return {
        state: 'expired',
        side: dev.side || rec.side || 'unknown',
        reason: 'expired-24h',
        remainingMs: 0,
        unlockedAt: rec.unlockedAt,
        expiresAt,
        source: rec.source || 'verified',
      };
    }
    const verifiedLive = !!(dev.up && dev.connectedAt && !dev.sawStopped && (
      (dev.handshakeAckAt && !dev.sawChallenge && now - dev.connectedAt >= 10000) ||
      (dev.lastButtonAt && dev.lastButtonAt - dev.connectedAt >= CLICK_VERIFY_MS)
    ));
    const state = rec.source === 'manual' && !verifiedLive ? 'likely' : 'unlocked';
    return {
      state,
      side: dev.side || rec.side || 'unknown',
      remainingMs,
      expiringSoon: remainingMs <= CLICK_WARN_MS,
      unlockedAt: rec.unlockedAt,
      expiresAt,
      source: rec.source || 'verified',
    };
  }
  if (dev.up) {
    if (dev.sawChallenge && !dev.handshakeAckAt) {
      return {
        state: 'locked',
        side: dev.side || 'unknown',
        reason: 'challenge-unsolved',
        remainingMs: 0,
      };
    }
    return { state: 'checking', side: dev.side || 'unknown', sawChallenge: !!dev.sawChallenge };
  }
  return { state: 'unknown', side: dev.side || rec.side || 'unknown' };
}

function summarizeClickAuth(now = Date.now()) {
  const clickDevs = [...devs].filter(isClickDevice);
  if (!clickDevs.length) return { hasClick: false, status: 'none', devices: [] };
  const infos = clickDevs.map((d) => ({ dev: d, name: deviceDisplayName(d), up: d.up, battery: d.battery, auth: getDevAuthInfo(d, now) }));
  const nonRight = infos.filter((x) => x.auth && x.auth.state !== 'exempt');
  if (!nonRight.length) return { hasClick: true, status: 'exempt', devices: infos };
  const pick = (s) => nonRight.find((x) => x.auth.state === s);
  const top = pick('locked') || pick('expired') || pick('checking') || pick('likely') || pick('unlocked') || pick('unknown') || nonRight[0];
  return {
    hasClick: true,
    status: top.auth.state,
    reason: top.auth.reason || null,
    remainingMs: top.auth.remainingMs ?? null,
    expiringSoon: !!top.auth.expiringSoon,
    unlockedAt: top.auth.unlockedAt || null,
    expiresAt: top.auth.expiresAt || null,
    source: top.auth.source || null,
    devices: infos,
  };
}

async function writeGatt(chr, bytes) {
  if (!chr) return false;
  if (chr.properties && chr.properties.writeWithoutResponse) await chr.writeValueWithoutResponse(bytes);
  else await chr.writeValue(bytes);
  return true;
}

function wakeKeepAlive(dev) {
  if (dev && typeof dev._wakeRetry === 'function') {
    const fn = dev._wakeRetry;
    dev._wakeRetry = null;
    fn();
  }
}

async function markClickUnlockedManually() {
  const now = Date.now();
  const targets = [...devs].filter((d) => isClickDevice(d) && d.side !== 'right');
  const needsReset = new Set();
  for (const d of targets) {
    if (d.sawStopped) needsReset.add(d);
    const rec = ensureClickRec(d.device.id);
    rec.unlockedAt = now;
    rec.source = 'manual';
    rec.lockReason = null;
    rec.isClick = true;
    if (d.side) rec.side = d.side;
    d.authState = 'likely';
    d.lockReason = null;
    d.sawStopped = false;
  }
  await saveClickAuth();
  note('Click v2 marked unlocked manually (24h timer started); verifying live...');
  updateStatus();
  for (const d of targets) {
    if (d.up && d.writeCh) {
      try {
        if (needsReset.has(d)) await writeGatt(d.writeCh, CLICK_RESET_CMD);
        else await writeGatt(d.writeCh, RIDE_HS);
      } catch {}
    } else {
      wakeKeepAlive(d);
      keepAlive(d);
    }
  }
}

async function recheckClickAuth() {
  const targets = [...devs].filter((d) => isClickDevice(d) && d.side !== 'right');
  for (const d of targets) {
    d.authState = 'checking';
    d.lockReason = null;
    d.sawStopped = false;
    if (d.up) {
      if (d.writeCh && isClickDevice(d)) {
        try { await writeGatt(d.writeCh, CLICK_RESET_CMD); } catch {}
      }
      try { d.device.gatt.disconnect(); } catch {}
    } else {
      wakeKeepAlive(d);
      keepAlive(d);
    }
  }
  updateStatus();
}

// Both controllers may report the same physical button (one tunnels the other's). Count holders so a
// press seen by two devices is one press, and ignore a late duplicate arriving just after release.
const DUP_MS = 150;
const combo = {}; // name -> { holders:Set, ignored:Set, lastUpAt, lastUpDev }
const srcName = (dev) => deviceDisplayName(dev) + ' #' + dev.n;
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
function isRideOnReply(data) {
  return data.length >= 6 &&
    data[0] === 0x52 && data[1] === 0x69 && data[2] === 0x64 &&
    data[3] === 0x65 && data[4] === 0x4f && data[5] === 0x6e;
}
function isClickStoppedMsg(data) {
  return data.length >= 5 &&
    data[0] === 0xff && data[1] === 0x05 && data[2] === 0x00 &&
    (data[3] === 0xea || data[3] === 0xfa) && data[4] === 0x05;
}
function decodeBattery0x19(data) {
  if (data.length < 3 || data[0] !== 0x19) return null;
  const f = pb(data.subarray(1));
  const bf = f.find((x) => x.field === 1 && x.wire === 0);
  const pct = bf ? bf.value : data[2];
  return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null;
}

function onNotify(dev, data) {
  if (!data || data.length < 1) return;
  dev.lastInboundAt = Date.now();

  if (isRideOnReply(data)) {
    const firstEcho = !dev.handshakeAckAt;
    dev.handshakeAckAt = Date.now();
    if (data.length >= 8 && data[6] === 0x02 && data[7] === 0x03) {
      dev.isClick = true;
      dev.isClickV2 = true;
    }
    if (firstEcho) {
      note('handshake echoed:', deviceDisplayName(dev));
      if (isClickDevice(dev) && dev.writeCh && !dev.sawChallenge && !dev.sentFf04Ack) {
        dev.sentFf04Ack = true;
        dev.lastAckAt = Date.now();
        writeGatt(dev.writeCh, CLICK_FF04_ACK).catch(() => {});
      }
      updateStatus();
    }
    return;
  }

  if (data[0] === 0xff) {
    dev.isClick = true;
    dev.isClickV2 = true;
    if (data.length >= 2 && data[1] === 0x03) {
      dev.sawChallenge = true;
      const now = Date.now();
      if (dev.writeCh && !dev.sentFf04Ack) {
        dev.sentFf04Ack = true;
        dev.lastAckAt = now;
        writeGatt(dev.writeCh, CLICK_FF04_ACK).catch(() => {});
      }
      const rec = (dev.device && dev.device.id && clickAuth[dev.device.id]) || {};
      const hasValidPersisted = !!(rec.unlockedAt && now < rec.unlockedAt + CLICK_UNLOCK_MS);
      if (dev.side !== 'right' && !dev.handshakeAckAt && !hasValidPersisted) {
        dev.authState = 'locked';
        dev.lockReason = 'challenge-unsolved';
      }
      if (!dev._loggedChallenge) {
        dev._loggedChallenge = true;
        note('Click v2 auth challenge (FF 03) on', deviceDisplayName(dev), '(' + Math.max(0, data.length - 3) + 'B)');
      }
      updateStatus();
      return;
    }
    if (isClickStoppedMsg(data)) {
      dev.sawStopped = true;
      setDeviceLocked(dev, 'expired-24h');
      if (autoResetLocked && dev.writeCh && Date.now() - (dev.lastResetAt || 0) > 5000) {
        dev.lastResetAt = Date.now();
        note('auto-resetting locked Click v2 (0x18) for another ~55s window');
        writeGatt(dev.writeCh, CLICK_RESET_CMD).catch(() => {});
      }
      return;
    }
  }

  if (data[0] === 0x19) {
    const pct = decodeBattery0x19(data);
    if (pct !== null && dev.battery !== pct) {
      dev.battery = pct;
      note('battery', deviceDisplayName(dev) + ':', dev.battery + '%');
      updateStatus();
    }
    return;
  }

  if (data.length < 2) return;
  if (data[0] !== 0x23) {
    if (data[0] !== 0x15) ulog('msg', [...data].map((b) => b.toString(16).padStart(2, '0')).join(' '));
    return;
  }
  const f = pb(data.subarray(1));
  const mf = f.find((x) => x.field === 1 && x.wire === 0);
  if (mf) {
    if (dev.prev !== null) {
      const changed = dev.prev ^ mf.value;
      if (changed) {
        const now = Date.now();
        dev.lastButtonAt = now;
        dev.idleResetSent = false;
        if (isClickDevice(dev)) {
          const inferred = inferSideFromChangedMask(changed);
          if (inferred && !dev.side) setDeviceSide(dev, inferred);
          if (dev.side !== 'right' && !dev.sawStopped && dev.connectedAt && now - dev.connectedAt >= CLICK_VERIFY_MS) {
            confirmDeviceUnlocked(dev, now);
          }
        }
      }
      for (const [name, mask] of Object.entries(MASKS)) {
        const was = (dev.prev & mask) === 0, now = (mf.value & mask) === 0;
        if (was !== now) inputEdge(dev, name, now ? 'down' : 'up', { mask, map: mf.value });
      }
      // A bit that changed but isn't in MASKS = a physical button we don't know about.
      const unknown = changed & ~KNOWN & 0x3fffff;
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
function clearDevMaintenance(dev) {
  if (dev && dev.maintTimer) {
    clearInterval(dev.maintTimer);
    dev.maintTimer = null;
  }
}
function releaseDevice(dev) {
  clearDevMaintenance(dev);
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
      note('battery', deviceDisplayName(dev) + ':', dev.battery + '%');
    }
    if (batChr.properties && batChr.properties.notify) {
      if (!wiredChars.has(batChr)) {
        wiredChars.add(batChr);
        batChr.addEventListener('characteristicvaluechanged', (e) => {
          applyBat(e.target && e.target.value);
        });
      }
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
const RETRY_BACKOFF_MS = [3000, 5000, 8000, 12000, 15000];

async function attach(dev) {
  if (dev.attaching) return dev.attaching;
  const p = attachImpl(dev);
  dev.attaching = p;
  try {
    return await p;
  } finally {
    if (dev.attaching === p) dev.attaching = null;
  }
}

async function attachImpl(dev) {
  const token = (dev._connectToken = (dev._connectToken || 0) + 1);
  const server = await dev.device.gatt.connect();
  const services = await server.getPrimaryServices();
  const svc = services.find((s) => s.uuid === SVC_RIDE) || services.find((s) => s.uuid === SVC_CUSTOM);
  if (!svc) {
    if (isClickDevice(dev)) {
      setDeviceLocked(dev, 'hidden-service');
      try { server.disconnect(); } catch {}
      throw new Error('Zwift Click v2 locked (Zwift service hidden - unlock in Zwift app)');
    }
    throw new Error('Zwift service not found');
  }

  const chars = await svc.getCharacteristics();
  const asyncCh = chars.find((c) => c.uuid === CH_ASYNC)
    || chars.find((c) => c.properties && c.properties.notify && !c.properties.indicate)
    || chars.find((c) => c.properties && (c.properties.notify || c.properties.indicate));
  const writeCh = chars.find((c) => c.uuid === CH_SYNC_RX)
    || chars.find((c) => c.properties && (c.properties.writeWithoutResponse || c.properties.write));
  const syncTxCh = chars.find((c) => c.uuid === CH_SYNC_TX)
    || chars.find((c) => c !== asyncCh && c.properties && c.properties.indicate);

  if (!writeCh) throw new Error('no writable characteristic on Zwift service');
  if (!asyncCh) throw new Error('no notify characteristic on Zwift service');

  dev.writeCh = writeCh;
  for (const c of [asyncCh, syncTxCh]) {
    if (!c) continue;
    if (!wiredChars.has(c)) {
      wiredChars.add(c);
      c.addEventListener('characteristicvaluechanged', (e) => {
        const v = e.target.value;
        onNotify(dev, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
    }
    await c.startNotifications().catch((err) => {
      if (c === asyncCh) throw err;
    });
  }

  if (isClickDevice(dev)) {
    dev.isClick = true;
    dev.sawChallenge = false;
    dev.sawStopped = false;
    dev.handshakeAckAt = 0;
    dev.idleResetSent = false;
    dev.sentFf04Ack = false;
    dev.lastButtonAt = 0;
    dev._loggedChallenge = false;
    if (dev.authState === 'locked') dev.authState = 'checking';
    dev.lockReason = null;
    dev.lastAckAt = 0;
  }

  await writeGatt(writeCh, RIDE_HS);
  if (stopped || dev._connectToken !== token) return;

  dev.prev = null;
  dev.up = true;
  dev.connectedAt = Date.now();
  dev.lastInboundAt = Date.now();
  dev._retryIdx = 0;
  note('connected', deviceDisplayName(dev));
  updateStatus();
  if (!isClickDevice(dev)) {
    readBattery(dev, server);
  }

  clearDevMaintenance(dev);
  if (isClickDevice(dev)) {
    dev.maintTimer = setInterval(async () => {
      if (!dev.up || stopped || dev._connectToken !== token) { clearDevMaintenance(dev); return; }
      const now = Date.now();
      if (dev.side !== 'right' && !dev.sawStopped && dev.handshakeAckAt && !dev.sawChallenge && now - dev.connectedAt >= 10000) {
        confirmDeviceUnlocked(dev, now);
      }
      if (keepClickAwake && !dev.idleResetSent && typeof CLICK_IDLE_RESET_MS === 'number') {
        const activeRef = Math.max(dev.connectedAt || 0, dev.lastButtonAt || 0);
        if (activeRef && now - activeRef >= CLICK_IDLE_RESET_MS) {
          dev.idleResetSent = true;
          ulog('idle 55s -> rebooting', deviceDisplayName(dev), '(0x18) before ~65s sleep');
          writeGatt(writeCh, CLICK_RESET_CMD).catch(() => {});
          return;
        }
      }
    }, CLICK_KEEPALIVE_MS);
  }

  if (mode === 'ride' && (!obcDevice || !obcDevice.gatt.connected)) maybePairObcMock();
}

// Retry until the controller is reachable (it may be switched off or asleep for a while).
// Inside Terra, Rust's BLE supervisor owns discovery and auto-connects remembered devices
// under `connect_gate`; calling gatt.connect() blindly on sleeping/off devices from JS forces
// 10s BlueZ scan loops and `le-connection-abort-by-local` races. Poll `ble_devices_status`
// (pure state read) and wait for `ble:autoconnected` instead of hammering `gatt.connect()`.
function hasRustSupervisor() {
  return !!(typeof window !== 'undefined' && window.__terraCore && typeof window.__terraCore.call === 'function');
}

async function isDeviceConnectedInBroker(dev) {
  if (!hasRustSupervisor()) return true;
  try {
    const list = await window.__terraCore.call('ble_devices_status', {});
    const row = Array.isArray(list) ? list.find((x) => x && x.id === dev.device.id) : null;
    return !!(row && row.connected);
  } catch {
    return true;
  }
}

async function keepAlive(dev) {
  if (dev.retrying) return;
  dev.retrying = true;
  let n = 0;
  dev._retryIdx = dev._retryIdx || 0;
  const managedBySupervisor = hasRustSupervisor();
  while (!dev.up && !stopped) {
    try {
      if (managedBySupervisor && !(await isDeviceConnectedInBroker(dev))) {
        const lockedWait = dev.lockReason === 'hidden-service';
        if (n % 6 === 0) {
          note('waiting for', deviceDisplayName(dev), lockedWait ? '- locked (unlock in Zwift app)' : '- switch it on (via BLE supervisor)');
        }
        n++;
        await new Promise((resolve) => {
          const t = setTimeout(() => { dev._wakeRetry = null; resolve(); }, 3000);
          dev._wakeRetry = () => { clearTimeout(t); resolve(); };
        });
        continue;
      }
      await attach(dev);
      break;
    } catch (e) {
      const msg = String(e.message || e);
      const lockedWait = dev.lockReason === 'hidden-service';
      const slowWait = lockedWait || msg.includes('unknown device') || msg.includes('not in range');
      if (n % (slowWait ? 4 : 10) === 0) {
        note('waiting for', deviceDisplayName(dev), lockedWait ? '- locked (unlock in Zwift app)' : '- switch it on (' + msg + ')');
      }
      n++;
      const delayMs = slowWait ? 15000 : RETRY_BACKOFF_MS[Math.min(dev._retryIdx, RETRY_BACKOFF_MS.length - 1)];
      if (!slowWait && dev._retryIdx < RETRY_BACKOFF_MS.length - 1) dev._retryIdx++;
      await new Promise((resolve) => {
        const t = setTimeout(() => { dev._wakeRetry = null; resolve(); }, delayMs);
        dev._wakeRetry = () => { clearTimeout(t); resolve(); };
      });
    }
  }
  dev.retrying = false;
}

function register(device) {
  if ([...devs].some((d) => d.device.id === device.id)) return null;
  const rec = (clickAuth && clickAuth[device.id]) || null;
  const isClick = isClickName(device.name) || !!(rec && rec.isClick);
  const dev = {
    device, prev: null, active: new Set(), up: false, battery: null, n: devs.size + 1,
    isClick, isClickV2: isClick, side: (rec && rec.side) || null,
    authState: rec && rec.side === 'right' ? 'exempt' : null,
    lockReason: (rec && rec.lockReason) || null,
    writeCh: null, maintTimer: null, attaching: null, connectedAt: 0, lastInboundAt: 0,
    lastAckAt: 0, lastResetAt: 0, lastButtonAt: 0, handshakeAckAt: 0,
    sawChallenge: false, sawStopped: false, idleResetSent: false, sentFf04Ack: false,
    _wakeRetry: null, _connectToken: 0, _retryIdx: 0,
  };
  devs.add(dev);
  device.addEventListener('gattserverdisconnected', () => {
    const upSecs = dev.connectedAt ? Math.round((Date.now() - dev.connectedAt) / 1000) : 0;
    const idleSecs = dev.lastButtonAt ? Math.round((Date.now() - dev.lastButtonAt) / 1000) : upSecs;
    dev.up = false;
    dev.battery = null;
    dev.writeCh = null;
    dev._connectToken = (dev._connectToken || 0) + 1;
    releaseDevice(dev);
    const diag = dev.connectedAt ? ` after ${upSecs}s (idle ${idleSecs}s${dev.idleResetSent ? ', 0x18 reboot' : ''})` : '';
    note('disconnected', deviceDisplayName(dev) + diag);
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
    for (const d of devs) {
      clearDevMaintenance(d);
      wakeKeepAlive(d);
    }
    if (navigator.bluetooth && navigator.bluetooth.requestDevice === wrappedRequestDevice) {
      navigator.bluetooth.requestDevice = origRequestDevice;
    }
    disconnectObcMock();
  });
})();
