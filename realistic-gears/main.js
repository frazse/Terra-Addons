(async (terra) => {
  terra.log('REALISTIC GEARS ADDON LOADED. pathname = ' + location.pathname);

  // Default 2x12 Gravel setup: 46/30T front, 11-34T 12-speed rear
  let config = {
    front: [30, 46], // sorted small -> big (idx 0 = 30T, idx 1 = 46T)
rear: [34, 30, 27, 24, 21, 19, 17, 15, 14, 13, 12, 11], // idx 0 = 34T (easiest) -> idx 11 = 11T (hardest)
frontShifterMode: 'separate', // 'separate' (LS1=Small, LS2=Big) or 'toggle' (LS1 & LS2 both toggle)
swapRearButtons: false,       // false: RS1=Easier, RS2=Harder | true: RS1=Harder, RS2=Easier
keyRearHarder: 'w',
keyRearEasier: 's',
keyFrontUp: 'q',
keyFrontDown: 'q',
hudPos: { bottom: '24px', right: '280px' }
  };

  let state = {
    frontIdx: 1, // 46T
    rearIdx: 4,  // 21T (ratio ~2.19)
vsChar: null,
isInternalWrite: false
  };

  function parseTeethList(str, ascending = true) {
    if (!str || typeof str !== 'string') return [];
    const nums = str
    .split(/[\s,;/-]+/)
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !isNaN(n) && n >= 9 && n <= 70);
    const unique = [...new Set(nums)];
    return unique.sort((a, b) => ascending ? a - b : b - a);
  }

  async function loadSettings() {
    try {
      const s = await terra.settings.all();
      if (s.front_chainrings) {
        const f = parseTeethList(s.front_chainrings, true);
        if (f.length > 0) config.front = f;
      }
      if (s.rear_cassette) {
        const r = parseTeethList(s.rear_cassette, false);
        if (r.length > 0) config.rear = r;
      }
      if (s.key_rear_harder) config.keyRearHarder = s.key_rear_harder.trim();
      if (s.key_rear_easier) config.keyRearEasier = s.key_rear_easier.trim();
      if (s.key_front_up) config.keyFrontUp = s.key_front_up.trim();
      if (s.key_front_down) config.keyFrontDown = s.key_front_down.trim();

      const savedPos = await terra.storage.get('hud_pos', null);
      if (savedPos) config.hudPos = savedPos;

      const savedGear = await terra.storage.get('last_gear', null);
      if (savedGear) {
        state.frontIdx = Math.min(config.front.length - 1, Math.max(0, savedGear.frontIdx ?? 1));
        state.rearIdx = Math.min(config.rear.length - 1, Math.max(0, savedGear.rearIdx ?? 4));
      } else {
        state.frontIdx = config.front.length - 1;
        state.rearIdx = Math.floor(config.rear.length / 2);
      }
    } catch (e) {
      terra.log('Error loading settings:', e.message || e);
    }
  }

  // --- 1. NATIVE HARDWARE VIRTUAL SHIFTING ENGINE (00000003-19ca-4651-86e5-fa29dcdd09d1) ---
  const ZWIFT_VS_SERVICES = [
    '0000fc82-0000-1000-8000-00805f9b34fb',
    '00000001-19ca-4651-86e5-fa29dcdd09d1'
  ];
  const ZWIFT_VS_RX_CHAR = '00000003-19ca-4651-86e5-fa29dcdd09d1';
  const core = window.__terraCore;

  function encodeVarint(val) {
    const bytes = [];
    let v = Math.max(1000, Math.round(val));
    while (v > 0x7f) {
      bytes.push((v & 0x7f) | 0x80);
      v >>>= 7;
    }
    bytes.push(v & 0x7f);
    return bytes;
  }

  function buildNativeGearPacket() {
    const f = config.front[state.frontIdx] || 46;
    const r = config.rear[state.rearIdx] || 21;
    const ratioScaled = Math.round((f / r) * 10000);
    const ratioVarint = encodeVarint(ratioScaled);
    const inner = [0x10, ...ratioVarint, 0x20, 0xa0, 0x06, 0x28, 0xb0, 0x54];
    return new Uint8Array([0x04, 0x2a, inner.length, ...inner]);
  }

  function bytesToHex(u8) {
    return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(' ');
  }

  function hookVsCharacteristic(chr, devName = 'Trainer') {
    if (!chr) return;
    state.vsChar = chr;
    if (chr.__terraVsHooked) return;

    const targets = [chr];
    const proto = Object.getPrototypeOf(chr);
    if (proto && proto !== Object.prototype && !proto.__terraVsProtoHooked) {
      targets.push(proto);
      proto.__terraVsProtoHooked = true;
    }

    for (const obj of targets) {
      for (const m of ['writeValue', 'writeValueWithResponse', 'writeValueWithoutResponse']) {
        if (typeof obj[m] === 'function') {
          const origW = obj[m];
          obj[m] = async function (val, ...rest) {
            try {
              const uuid = String(this.uuid || '').toLowerCase();
              if (uuid.includes('00000003-19ca')) {
                state.vsChar = this;
                if (!state.isInternalWrite) {
                  const u8 = val instanceof ArrayBuffer
                  ? new Uint8Array(val)
                  : ArrayBuffer.isView(val)
                  ? new Uint8Array(val.buffer, val.byteOffset, val.byteLength)
                  : null;
                  if (u8 && u8.byteLength >= 6 && u8[0] === 0x04 && u8[1] === 0x2a) {
                    const overridePkt = buildNativeGearPacket();
                    return await origW.call(this, overridePkt, ...rest);
                  }
                }
              }
            } catch (e) {
              terra.log('VS write hook error:', e.message || e);
            }
            return await origW.call(this, val, ...rest);
          };
        }
      }
    }

    chr.__terraVsHooked = true;
    terra.log(`Bound Native Hardware Virtual Shifting (00000003-19ca) on ${devName}`);
    pushImmediateFtmsShift();
  }

  // --- 1B. DIRECT ZWIFT RIDE CONTROLLER SHIFTER INTERCEPTOR ---
  // Reads raw 0x23 protobuf button masks from Zwift Ride so zwift-ride addon keybinds can stay on default (LS=S, RS=W)!
  const ZR_MASKS = {
    shift_up_l: 0x100,  // LS1
    shift_dn_l: 0x200,  // LS2
    shift_up_r: 0x1000, // RS1
    shift_dn_r: 0x2000  // RS2
  };
  const zrPrevMaskByDev = new Map();
  const zrLastPressTime = {};

  function readPbVarint(buf, pos) {
    let result = 0, shift = 0, b;
    do {
      b = buf[pos++];
      result += (b & 0x7f) * (2 ** shift);
      shift += 7;
    } while ((b & 0x80) && pos < buf.length);
    return [result, pos];
  }

  function decodeZwiftRideButtons(devId, u8) {
    if (!location.pathname.includes('/ride')) return;
    if (!u8 || u8.length < 3 || u8[0] !== 0x23) return;

    // Parse protobuf field 1 (wire type 0 -> tag === 0x08)
    let pos = 1;
    let buttonMap = null;
    while (pos < u8.length) {
      let tag;
      [tag, pos] = readPbVarint(u8, pos);
      const field = Math.floor(tag / 8), wire = tag & 7;
      if (wire === 0) {
        let v;
        [v, pos] = readPbVarint(u8, pos);
        if (field === 1) {
          buttonMap = v;
          break;
        }
      } else if (wire === 2) {
        let len;
        [len, pos] = readPbVarint(u8, pos);
        pos += len;
      } else if (wire === 1) pos += 8;
      else if (wire === 5) pos += 4;
      else break;
    }

    if (buttonMap === null) return;
    const prev = zrPrevMaskByDev.get(devId);
    zrPrevMaskByDev.set(devId, buttonMap);
    if (prev === undefined) return;

    const now = Date.now();
    for (const [btnName, mask] of Object.entries(ZR_MASKS)) {
      const wasPressed = (prev & mask) === 0;
      const isPressed = (buttonMap & mask) === 0;
      if (!wasPressed && isPressed) {
        // De-duplicate across left/right tunnelled controllers (150ms window)
        if (now - (zrLastPressTime[btnName] || 0) < 150) continue;
        zrLastPressTime[btnName] = now;
        handleZwiftRideShifterPress(btnName);
      }
    }
  }

  function handleZwiftRideShifterPress(btnName) {
    if (btnName === 'shift_up_l') {
      // LS1: Front Small Ring (or toggle if configured)
      shiftFront(config.frontShifterMode === 'toggle' ? 0 : -1, 'zwift-ride:LS1');
    } else if (btnName === 'shift_dn_l') {
      // LS2: Front Big Ring (or toggle if configured)
      shiftFront(config.frontShifterMode === 'toggle' ? 0 : +1, 'zwift-ride:LS2');
    } else if (btnName === 'shift_up_r') {
      // RS1: Rear Easier (or Harder if swapped)
      shiftRear(config.swapRearButtons ? +1 : -1, 'zwift-ride:RS1');
    } else if (btnName === 'shift_dn_r') {
      // RS2: Rear Harder (or Easier if swapped)
      shiftRear(config.swapRearButtons ? -1 : +1, 'zwift-ride:RS2');
    }
  }

  async function hookZwiftRideDevice(dev) {
    if (!dev || !dev.gatt || !dev.gatt.connected || dev.__terraZrShifterHooked) return;
    try {
      const svc = await dev.gatt.getPrimaryService('0000fc82-0000-1000-8000-00805f9b34fb');
      if (!svc) return;
      const chars = await svc.getCharacteristics();
      for (const c of chars) {
        if (c.properties && (c.properties.notify || c.properties.indicate)) {
          c.addEventListener('characteristicvaluechanged', (e) => {
            const v = e.target.value;
            if (v) {
              decodeZwiftRideButtons(dev.id, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
            }
          });
        }
      }
      dev.__terraZrShifterHooked = true;
      dev.addEventListener('gattserverdisconnected', () => {
        dev.__terraZrShifterHooked = false;
        zrPrevMaskByDev.delete(dev.id);
      }, { once: true });
      terra.log(`Bound direct 2x12 shifter listener to Zwift Ride (${dev.id})`);
    } catch (_) {}
  }

  async function scanAndBindDevices() {
    if (!core || !core.devices) return;
    for (const dev of core.devices.values()) {
      const name = (dev.name || '').toUpperCase();
      if (name.includes('ZWIFT RIDE')) {
        hookZwiftRideDevice(dev);
        continue;
      }
      if (dev.gatt && dev.gatt.connected && !state.vsChar) {
        for (const sUuid of ZWIFT_VS_SERVICES) {
          try {
            const svc = await dev.gatt.getPrimaryService(sUuid);
            if (svc) {
              const chr = await svc.getCharacteristic(ZWIFT_VS_RX_CHAR);
              if (chr) {
                hookVsCharacteristic(chr, dev.name || dev.id);
                break;
              }
            }
          } catch (_) {}
        }
      }
    }
  }

  function installFtmsInterceptor() {
    scanAndBindDevices();
    terra.ble.onConnect(() => setTimeout(scanAndBindDevices, 300));
    terra.ble.onPaired(() => setTimeout(scanAndBindDevices, 300));

    // Also listen to global BLE notifications if emitted by Terra shim
    if (terra.ble && typeof terra.ble.onNotify === 'function') {
      terra.ble.onNotify((evt) => {
        if (evt && evt.bytes && evt.bytes[0] === 0x23) {
          decodeZwiftRideButtons(evt.id || 'ble', evt.bytes);
        }
      });
    }

    const pollId = setInterval(scanAndBindDevices, 2000);
    terra.onCleanup(() => clearInterval(pollId));
  }

  async function pushImmediateFtmsShift() {
    if (!state.vsChar) {
      await scanAndBindDevices();
    }
    if (!state.vsChar) {
      terra.log('Shift queued (waiting for trainer 00000003-19ca connection)');
      return;
    }

    const pkt = buildNativeGearPacket();
    const f = config.front[state.frontIdx] || 46;
    const r = config.rear[state.rearIdx] || 21;
    terra.log(`-> Native Gear Write [${bytesToHex(pkt)}] (${f}x${r}T = ${(f / r).toFixed(3)}x)`);

    state.isInternalWrite = true;
    try {
      const writeFn = state.vsChar.writeValueWithoutResponse || state.vsChar.writeValue;
      await writeFn.call(state.vsChar, pkt);
    } catch (e) {
      terra.log('Native gear write error:', e.message || e);
    } finally {
      state.isInternalWrite = false;
    }
  }

  installFtmsInterceptor();

  // --- 2. FRONT & REAR DERAILLEUR SHIFT LOGIC ---
  function applyGearChange(newFrontIdx, newRearIdx, source = 'manual') {
    const clampedFront = Math.min(config.front.length - 1, Math.max(0, newFrontIdx));
    const clampedRear = Math.min(config.rear.length - 1, Math.max(0, newRearIdx));

    if (clampedFront === state.frontIdx && clampedRear === state.rearIdx) {
      flashHudLimit();
      return false;
    }

    state.frontIdx = clampedFront;
    state.rearIdx = clampedRear;

    pushImmediateFtmsShift();

    terra.storage.set('last_gear', { frontIdx: state.frontIdx, rearIdx: state.rearIdx }).catch(() => {});
    const fTeeth = config.front[state.frontIdx];
    const rTeeth = config.rear[state.rearIdx];
    const ratio = Number((fTeeth / rTeeth).toFixed(2));

    terra.log(`Shift [${source}]: ${state.frontIdx + 1}-${state.rearIdx + 1} (${fTeeth}x${rTeeth}T, ratio=${ratio}x)`);

    terra.bus.emit('realistic-gears:changed', {
      frontIndex: state.frontIdx + 1,
      frontTotal: config.front.length,
      frontTeeth: fTeeth,
      rearIndex: state.rearIdx + 1,
      rearTotal: config.rear.length,
      rearTeeth: rTeeth,
      ratio,
      source
    });

    updateHud();
    return true;
  }

  function shiftRear(dir, source = 'rear') {
    return applyGearChange(state.frontIdx, state.rearIdx + dir, source);
  }

  function shiftFront(dir, source = 'front') {
    if (config.front.length <= 1) return false;
    let nextFront = state.frontIdx + dir;
    if (dir === 0) {
      nextFront = (state.frontIdx + 1) % config.front.length;
    }
    return applyGearChange(nextFront, state.rearIdx, source);
  }

  terra.bus.on('realistic-gears:shift', (cmd) => {
    if (!cmd) return;
    if (cmd.derailleur === 'front') shiftFront(cmd.dir ?? 0, 'bus:front');
    else if (cmd.derailleur === 'rear') shiftRear(cmd.dir ?? 1, 'bus:rear');
  });

    // --- 3. INTERCEPT KEYBOARD & BLOCK ZWIFT-RIDE DEFAULT 'W'/'S' KEYS ---
    const sameKey = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

    function isZwiftRideConnected() {
      if (!core || !core.devices) return false;
      for (const dev of core.devices.values()) {
        if ((dev.name || '').toUpperCase().includes('ZWIFT RIDE') && dev.gatt?.connected) {
          return true;
        }
      }
      return false;
    }

    function onKeyEvent(e) {
      if (!location.pathname.includes('/ride')) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

      const k = e.key;
      const isRearHarder = sameKey(k, config.keyRearHarder);
      const isRearEasier = sameKey(k, config.keyRearEasier);
      const isFrontUp = sameKey(k, config.keyFrontUp);
      const isFrontDown = sameKey(k, config.keyFrontDown);

      if (isRearHarder || isRearEasier || isFrontUp || isFrontDown || sameKey(k, 'w') || sameKey(k, 's')) {
        // Always block 'w'/'s' from reaching Biketerra so Biketerra's built-in shifting doesn't trigger
        e.preventDefault();
        e.stopImmediatePropagation();

        // If this is a synthetic 'w' or 's' from zwift-ride (!e.isTrusted) and we are already reading
        // raw BLE buttons from the Zwift Ride controller directly, ignore the synthetic key!
        if (!e.isTrusted && isZwiftRideConnected() && (sameKey(k, 'w') || sameKey(k, 's'))) {
          return;
        }

        if (e.type === 'keydown' && !e.repeat) {
          if (isRearHarder) shiftRear(+1, 'key');
          else if (isRearEasier) shiftRear(-1, 'key');
          else if (isFrontUp && isFrontDown) shiftFront(0, 'key');
          else if (isFrontUp) shiftFront(+1, 'key');
          else if (isFrontDown) shiftFront(-1, 'key');
        }
      }
    }

    window.addEventListener('keydown', onKeyEvent, true);
    window.addEventListener('keyup', onKeyEvent, true);
    terra.onCleanup(() => {
      window.removeEventListener('keydown', onKeyEvent, true);
      window.removeEventListener('keyup', onKeyEvent, true);
    });

    // --- 4. ON-SCREEN GEAR INDICATOR HUD ---
    terra.ui.addStyle(`
    #terra-gear-hud {
    position: fixed;
    z-index: 99990;
    width: 220px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(16, 18, 23, 0.88);
    backdrop-filter: blur(10px);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.55);
    color: #f4f4f5;
    font-family: system-ui, -apple-system, sans-serif;
    user-select: none;
    transition: border-color 0.15s ease, transform 0.1s ease;
    }
    #terra-gear-hud.limit-flash {
    border-color: #f87171;
    transform: scale(0.98);
    }
    .tg-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: grab;
      padding-bottom: 6px;
      margin-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.6px;
      color: #a1a1aa;
      text-transform: uppercase;
    }
    .tg-main-readout {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 8px;
    }
    .tg-gear-num {
      font-size: 24px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      color: #5DCAA5;
      line-height: 1;
    }
    .tg-teeth-badge {
      font-family: monospace;
      font-size: 13px;
      font-weight: 700;
      color: #e4e4e7;
      background: rgba(255, 255, 255, 0.08);
      padding: 2px 6px;
      border-radius: 5px;
    }
    .tg-ratio-badge {
      font-family: monospace;
      font-size: 11px;
      color: #a1a1aa;
    }
    .tg-front-rings {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 100%;
      padding-right: 8px;
      border-right: 1px solid rgba(255, 255, 255, 0.1);
    }
    .tg-cassette-cogs {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      flex: 1;
      gap: 2px;
      height: 100%;
    }
    .tg-bar {
      flex: 1;
      border-radius: 2px;
      background: rgba(255, 255, 255, 0.18);
      transition: background 0.12s ease, box-shadow 0.12s ease;
      cursor: pointer;
    }
    .tg-bar.active-front {
      background: #60a5fa;
      box-shadow: 0 0 8px rgba(96, 165, 250, 0.6);
    }
    .tg-bar.active-rear {
      background: #5DCAA5;
      box-shadow: 0 0 8px rgba(93, 202, 165, 0.6);
    }
    .tg-bar.cross-chain {
      background: #f59e0b !important;
      box-shadow: 0 0 8px rgba(245, 158, 11, 0.6) !important;
    }
    .tg-controls {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      margin-top: 8px;
    }
    .tg-btn-group {
      display: flex;
      flex: 1;
      gap: 3px;
      align-items: center;
    }
    .tg-btn {
      flex: 1;
      padding: 4px 0;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.06);
      color: #e4e4e7;
      font-size: 10px;
      font-weight: 700;
      cursor: pointer;
      text-align: center;
    }
    .tg-btn:hover {
      background: rgba(255, 255, 255, 0.15);
    }
    .tg-config-drawer {
      display: none;
      flex-direction: column;
      gap: 6px;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      font-size: 10px;
    }
    .tg-config-drawer.open {
      display: flex;
    }
    .tg-input {
      width: 100%;
      box-sizing: border-box;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      border-radius: 4px;
      padding: 3px 6px;
      font-family: monospace;
      font-size: 10px;
    }
    `);

    let hudEl = null;

    function isCrossChained() {
      if (config.front.length < 2 || config.rear.length < 5) return false;
      const isBigFront = state.frontIdx === config.front.length - 1;
      const isSmallFront = state.frontIdx === 0;
      if (isBigFront && state.rearIdx <= 1) return true;
      if (isSmallFront && state.rearIdx >= config.rear.length - 2) return true;
      return false;
    }

    function flashHudLimit() {
      if (!hudEl) return;
      hudEl.classList.add('limit-flash');
      setTimeout(() => hudEl?.classList.remove('limit-flash'), 150);
    }

    function buildHud() {
      if (document.getElementById('terra-gear-hud')) return;

      hudEl = document.createElement('div');
      hudEl.id = 'terra-gear-hud';
      Object.assign(hudEl.style, config.hudPos);

      hudEl.innerHTML = `
      <div class="tg-header" id="tg-drag-handle">
      <span>⚙️ <span id="tg-spec-title">2x12 GRX</span></span>
      <span id="tg-warn-label" style="color: #f59e0b; font-size: 9px;"></span>
      <button type="button" id="tg-cfg-toggle" title="Configure Gears" style="background:none;border:none;color:#a1a1aa;cursor:pointer;font-size:11px;padding:0;">✎</button>
      </div>
      <div class="tg-main-readout">
      <span class="tg-gear-num" id="tg-gear-index">2 - 5</span>
      <span class="tg-teeth-badge" id="tg-teeth-text">46×21T</span>
      <span class="tg-ratio-badge" id="tg-ratio-text">2.19x</span>
      </div>
      <div style="display:flex;align-items:flex-end;gap:10px;height:38px;padding:4px 6px;border-radius:8px;background:rgba(0,0,0,0.35);">
      <div class="tg-front-rings" id="tg-front-bars"></div>
      <div class="tg-cassette-cogs" id="tg-rear-bars"></div>
      </div>
      <div class="tg-controls">
      <div class="tg-btn-group">
      <button type="button" class="tg-btn" id="tg-fd-down" title="Left Shifter Down (Small Ring)">FD ▼</button>
      <button type="button" class="tg-btn" id="tg-fd-up" title="Left Shifter Up (Big Ring)">FD ▲</button>
      </div>
      <div class="tg-btn-group">
      <button type="button" class="tg-btn" id="tg-rd-down" title="Right Shifter Easier (Larger Cog)">RD ◀</button>
      <button type="button" class="tg-btn" id="tg-rd-up" title="Right Shifter Harder (Smaller Cog)">RD ▶</button>
      </div>
      </div>
      <div class="tg-config-drawer" id="tg-config-drawer">
      <div>
      <div style="color:#a1a1aa;margin-bottom:2px;">Front Chainrings (Teeth):</div>
      <input type="text" class="tg-input" id="tg-inp-front" value="${config.front.join(', ')}">
      </div>
      <div>
      <div style="color:#a1a1aa;margin-bottom:2px;">Rear Cassette (Teeth):</div>
      <input type="text" class="tg-input" id="tg-inp-rear" value="${config.rear.join(', ')}">
      </div>
      <button type="button" class="tg-btn" id="tg-save-cfg" style="background:#5DCAA5;color:#000;padding:4px;">Save & Apply Drivetrain</button>
      </div>
      `;

      document.body.appendChild(hudEl);

      hudEl.querySelector('#tg-fd-down').addEventListener('click', () => shiftFront(-1));
      hudEl.querySelector('#tg-fd-up').addEventListener('click', () => shiftFront(+1));
      hudEl.querySelector('#tg-rd-down').addEventListener('click', () => shiftRear(-1));
      hudEl.querySelector('#tg-rd-up').addEventListener('click', () => shiftRear(+1));

      const drawer = hudEl.querySelector('#tg-config-drawer');
      hudEl.querySelector('#tg-cfg-toggle').addEventListener('click', () => {
        drawer.classList.toggle('open');
      });

      hudEl.querySelector('#tg-save-cfg').addEventListener('click', async () => {
        const fStr = hudEl.querySelector('#tg-inp-front').value;
        const rStr = hudEl.querySelector('#tg-inp-rear').value;
        const fParsed = parseTeethList(fStr, true);
        const rParsed = parseTeethList(rStr, false);

        if (fParsed.length > 0 && rParsed.length > 0) {
          config.front = fParsed;
          config.rear = rParsed;
          state.frontIdx = Math.min(state.frontIdx, config.front.length - 1);
          state.rearIdx = Math.min(state.rearIdx, config.rear.length - 1);
          await terra.settings.set('front_chainrings', config.front.join(', '));
          await terra.settings.set('rear_cassette', config.rear.join(', '));
          pushImmediateFtmsShift();
          updateHud();
          drawer.classList.remove('open');
        }
      });

      const handle = hudEl.querySelector('#tg-drag-handle');
      let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
      handle.addEventListener('mousedown', (e) => {
        if (e.target.id === 'tg-cfg-toggle') return;
        dragging = true;
        const rect = hudEl.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        hudEl.style.bottom = 'auto';
        hudEl.style.right = 'auto';
        hudEl.style.left = `${startLeft}px`;
        hudEl.style.top = `${startTop}px`;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const nl = Math.max(8, Math.min(window.innerWidth - 230, startLeft + (e.clientX - startX)));
        const nt = Math.max(8, Math.min(window.innerHeight - 140, startTop + (e.clientY - startY)));
        hudEl.style.left = `${nl}px`;
        hudEl.style.top = `${nt}px`;
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        config.hudPos = { left: hudEl.style.left, top: hudEl.style.top, bottom: 'auto', right: 'auto' };
        terra.storage.set('hud_pos', config.hudPos).catch(() => {});
      });

      updateHud();
    }

    function updateHud() {
      if (!hudEl) return;
      const fTeeth = config.front[state.frontIdx];
      const rTeeth = config.rear[state.rearIdx];
      const ratio = (fTeeth / rTeeth).toFixed(2);
      const cross = isCrossChained();

      hudEl.querySelector('#tg-spec-title').textContent = `${config.front.length}x${config.rear.length} (${[...config.front].reverse().join('/')})`;
      hudEl.querySelector('#tg-gear-index').textContent = `${state.frontIdx + 1}-${state.rearIdx + 1}`;
      hudEl.querySelector('#tg-teeth-text').textContent = `${fTeeth}×${rTeeth}T`;
      hudEl.querySelector('#tg-ratio-text').textContent = `${ratio}x`;
      hudEl.querySelector('#tg-warn-label').textContent = cross ? '⚡ CROSS' : '';

      const fContainer = hudEl.querySelector('#tg-front-bars');
      const maxF = Math.max(...config.front, 50);
      fContainer.innerHTML = '';
      config.front.forEach((t, idx) => {
        const bar = document.createElement('div');
        const hPct = Math.max(35, Math.round((t / maxF) * 100));
        bar.className = 'tg-bar' + (idx === state.frontIdx ? ' active-front' : '');
        bar.style.cssText = `width: 10px; height: ${hPct}%;`;
        bar.title = `Front Ring ${idx + 1}: ${t}T`;
        bar.addEventListener('click', () => applyGearChange(idx, state.rearIdx, 'hud-click'));
        fContainer.appendChild(bar);
      });

      const rContainer = hudEl.querySelector('#tg-rear-bars');
      const maxR = Math.max(...config.rear, 34);
      rContainer.innerHTML = '';
      config.rear.forEach((t, idx) => {
        const bar = document.createElement('div');
        const hPct = Math.max(25, Math.round((t / maxR) * 100));
        const isActive = idx === state.rearIdx;
        bar.className = 'tg-bar' + (isActive ? (cross ? ' active-rear cross-chain' : ' active-rear') : '');
        bar.style.cssText = `height: ${hPct}%;`;
        bar.title = `Cog ${idx + 1}: ${t}T (${(fTeeth / t).toFixed(2)}x)`;
        bar.addEventListener('click', () => applyGearChange(state.frontIdx, idx, 'hud-click'));
        rContainer.appendChild(bar);
      });
    }

    function checkRouteAndMount() {
      if (location.pathname.includes('/ride')) {
        buildHud();
      } else if (hudEl) {
        hudEl.remove();
        hudEl = null;
      }
    }

    await loadSettings();
    checkRouteAndMount();

    terra.onNavigate(() => checkRouteAndMount());
    terra.settings.onChange(async () => {
      await loadSettings();
      pushImmediateFtmsShift();
      updateHud();
    });
    terra.onCleanup(() => {
      if (hudEl) hudEl.remove();
    });
})(terra);
