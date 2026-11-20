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
keyFrontDown: 'q'
  };

  let state = {
    frontIdx: 1, // 46T
    rearIdx: 4,  // 21T (ratio ~2.19)
vsChar: null,
isInternalWrite: false,
isErgMode: false,
ergText: '',
nativeGearEl: null
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

  // --- 0. DETECT BIKETERRA "ERG Xw" AND "Gear X" DOM ELEMENTS ---
  const GEAR_REGEX = /^\s*Gear\s+\d+\s*$/i;
  const ERG_REGEX = /\bERG\s+\d+\s*w\b/i;
  const ROAD_ERG_REGEX = /^\s*\d+\s*W\s*$/i;
  let isScanningDom = false;

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function isAncestorChainShown(el) {
    if (!el || !el.isConnected) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const cs = getComputedStyle(cur);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function restoreHiddenGearElements(exceptEl = null) {
    document.querySelectorAll('[data-terra-hidden-gear="1"]').forEach(el => {
      if (el !== exceptEl) {
        el.style.opacity = '';
        el.style.pointerEvents = '';
        delete el.dataset.terraHiddenGear;
      }
    });
  }

  function hideGearHud() {
    if (!hudEl) return;
    if (hudEl.style.display !== 'none') hudEl.style.display = 'none';
    if (hudEl.parentElement !== document.body && document.body) {
      document.body.appendChild(hudEl);
    }
    hudEl.classList.remove('tg-in-flow');
  }

  function scanBiketerraDom() {
    if (isScanningDom) return;
    isScanningDom = true;
    try {
      if (!location.pathname.includes('/ride')) {
        state.isErgMode = false;
        state.ergText = '';
        state.nativeGearEl = null;
        restoreHiddenGearElements();
        hideGearHud();
        return;
      }

      let foundErg = false;
      let foundErgText = '';
      let foundGearEl = null;

      // Fast path: Biketerra's native `.road-readout` inside `.road-middle`
      const roadReadout =
        document.querySelector('.road-middle .road-readout') ||
        document.querySelector('.road-readout');
      if (roadReadout) {
        const readoutActive =
          roadReadout.dataset.terraHiddenGear === '1'
            ? isAncestorChainShown(roadReadout.parentElement)
            : isElementVisible(roadReadout);
        if (readoutActive) {
          const labelEl = roadReadout.querySelector('.readout-label');
          const labelTxt = ((labelEl ? labelEl.textContent : roadReadout.textContent) || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (GEAR_REGEX.test(labelTxt)) {
            foundGearEl = roadReadout;
          } else if (
            ERG_REGEX.test(labelTxt) ||
            ROAD_ERG_REGEX.test(labelTxt) ||
            (labelEl && /target power/i.test(labelEl.getAttribute('title') || ''))
          ) {
            foundErg = true;
            foundErgText = labelTxt.toUpperCase();
          }
        }
      }

      // Fallback scan for older/custom layouts if `.road-readout` didn't resolve Gear or ERG
      if (!foundGearEl && !foundErg) {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode(node) {
              const p = node.parentElement;
              if (!p) return NodeFilter.FILTER_REJECT;
              const tag = p.tagName;
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
              if (p.closest('#terra-gear-hud, #btz-panel')) return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );

        let n;
        while ((n = walker.nextNode())) {
          const txt = n.nodeValue.trim();
          if (!txt || txt.length > 40) continue;

          if (!foundGearEl && GEAR_REGEX.test(txt)) {
            const el = n.parentElement;
            if (el.dataset.terraHiddenGear === '1' || el.closest('[data-terra-hidden-gear="1"]') || isElementVisible(el)) {
              foundGearEl = el;
            }
          }

          if (!foundErg && ERG_REGEX.test(txt)) {
            const el = n.parentElement;
            if (isElementVisible(el)) {
              foundErg = true;
              foundErgText = txt.match(ERG_REGEX)[0].toUpperCase();
            }
          }
        }

        // Split-span fallback
        if (!foundErg && !foundGearEl) {
          const candidates = document.querySelectorAll('div, span, button, p');
          for (let i = 0; i < candidates.length; i++) {
            const el = candidates[i];
            if (el.children.length > 4 || el.closest('#terra-gear-hud, #btz-panel')) continue;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 24) continue;

            if (!foundErg && ERG_REGEX.test(t) && isElementVisible(el)) {
              foundErg = true;
              foundErgText = t.match(ERG_REGEX)[0].toUpperCase();
            }
            if (!foundGearEl && GEAR_REGEX.test(t) && (el.dataset.terraHiddenGear === '1' || isElementVisible(el))) {
              foundGearEl = el;
            }
          }
        }
      }

      // Replace Biketerra's virtual shifting indicator in-flow inside `.road-middle`
      // so `.lap-counter` (and `.step-readout`) stack cleanly above our HUD instead of being covered.
      if (foundGearEl && !foundErg) {
        const targetBox = foundGearEl.closest('.road-readout, .gear-indicator, .virtual-gear') || foundGearEl;
        const roadMiddle = targetBox.closest('.road-middle');
        state.nativeGearEl = targetBox;
        restoreHiddenGearElements(targetBox);

        if (roadMiddle) {
          if (targetBox.dataset.terraHiddenGear !== '1') {
            targetBox.dataset.terraHiddenGear = '1';
          }
          if (hudEl) {
            if (hudEl.parentElement !== roadMiddle) {
              roadMiddle.appendChild(hudEl);
            }
            hudEl.classList.add('tg-in-flow');
            hudEl.style.top = '';
            hudEl.style.right = '';
            hudEl.style.bottom = '';
            hudEl.style.left = '';
            if (hudEl.style.display !== 'block') hudEl.style.display = 'block';
          }
        } else {
          // Fallback for layouts without `.road-middle`: keep fixed overlay anchored to targetBox
          if (targetBox.dataset.terraHiddenGear !== '1') {
            targetBox.dataset.terraHiddenGear = '1';
            targetBox.style.opacity = '0';
            targetBox.style.pointerEvents = 'none';
          }
          if (hudEl) {
            if (hudEl.parentElement !== document.body && document.body) {
              document.body.appendChild(hudEl);
            }
            hudEl.classList.remove('tg-in-flow');
            const r = targetBox.getBoundingClientRect();
            const centerX = r.left + r.width / 2;
            const bottomPx = Math.max(8, Math.round(window.innerHeight - r.bottom));
            hudEl.style.display = 'block';
            const hudW = hudEl.offsetWidth || 292;
            const leftPx = Math.max(8, Math.min(window.innerWidth - hudW - 8, Math.round(centerX - hudW / 2)));
            hudEl.style.bottom = `${bottomPx}px`;
            hudEl.style.left = `${leftPx}px`;
            hudEl.style.top = 'auto';
            hudEl.style.right = 'auto';
          }
        }
      } else {
        // Either in ERG mode or "Gear X" is not on screen -> restore native DOM & hide our HUD
        state.nativeGearEl = null;
        restoreHiddenGearElements();
        hideGearHud();
      }

      if (foundErg !== state.isErgMode || foundErgText !== state.ergText) {
        state.isErgMode = foundErg;
        state.ergText = foundErgText;
        terra.log(foundErg
          ? `ERG mode detected (${foundErgText}) -> hiding Gear HUD & passing shifters through to Biketerra (W/S)`
          : `Virtual Shifting mode active -> 2x12 shifters & HUD engaged`);
      }
    } finally {
      isScanningDom = false;
    }
  }

  addEventListener('resize', scanBiketerraDom);
  terra.onCleanup(() => removeEventListener('resize', scanBiketerraDom));

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

    scanBiketerraDom();
    // Only intercept Zwift Ride shifters when "Gear X" is active (not in ERG mode)
    if (state.isErgMode || !state.nativeGearEl) {
      return;
    }

    const now = Date.now();
    for (const [btnName, mask] of Object.entries(ZR_MASKS)) {
      const wasPressed = (prev & mask) === 0;
      const isPressed = (buttonMap & mask) === 0;
      if (!wasPressed && isPressed) {
        if (now - (zrLastPressTime[btnName] || 0) < 150) continue;
        zrLastPressTime[btnName] = now;
        handleZwiftRideShifterPress(btnName);
      }
    }
  }

  function handleZwiftRideShifterPress(btnName) {
    if (btnName === 'shift_up_l') {
      shiftFront(config.frontShifterMode === 'toggle' ? 0 : -1, 'zwift-ride:LS1');
    } else if (btnName === 'shift_dn_l') {
      shiftFront(config.frontShifterMode === 'toggle' ? 0 : +1, 'zwift-ride:LS2');
    } else if (btnName === 'shift_up_r') {
      shiftRear(config.swapRearButtons ? +1 : -1, 'zwift-ride:RS1');
    } else if (btnName === 'shift_dn_r') {
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

    if (terra.ble && typeof terra.ble.onNotify === 'function') {
      terra.ble.onNotify((evt) => {
        if (evt && evt.bytes && evt.bytes[0] === 0x23) {
          decodeZwiftRideButtons(evt.id || 'ble', evt.bytes);
        }
      });
    }

    const pollId = setInterval(() => {
      scanAndBindDevices();
      scanBiketerraDom();
    }, 1000);
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

    // --- 3. INTERCEPT KEYBOARD & PASS THROUGH W/S WHEN IN ERG MODE ---
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

      scanBiketerraDom();

      // If in ERG mode or "Gear X" is not active, let W/S pass through to Biketerra untouched!
      if (state.isErgMode || !state.nativeGearEl) {
        return;
      }

      const k = e.key;
      const isRearHarder = sameKey(k, config.keyRearHarder);
      const isRearEasier = sameKey(k, config.keyRearEasier);
      const isFrontUp = sameKey(k, config.keyFrontUp);
      const isFrontDown = sameKey(k, config.keyFrontDown);

      if (isRearHarder || isRearEasier || isFrontUp || isFrontDown || sameKey(k, 'w') || sameKey(k, 's')) {
        e.preventDefault();
        e.stopImmediatePropagation();

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

    // --- 4. ON-SCREEN GEAR INDICATOR HUD (REPLACES `.road-readout` IN-FLOW INSIDE `.road-middle`) ---
    // Mirrors Biketerra's in-ride Rider Stat HUD (`.panel`/`.glass` neutral dark translucent surface,
    // borderless, crisp white numerals, `--white-4` secondary labels) and sizes everything in `rem`
    // so the entire widget scales smoothly with Biketerra's Text Size setting.
    terra.ui.addStyle(`
    .road-middle [data-terra-hidden-gear="1"] {
      display: none !important;
    }
    #terra-gear-hud {
      position: fixed;
      z-index: 99990;
      display: none;
      width: 18.25rem;
      padding: 0.35rem 0.42rem;
      border-radius: var(--radius-md, 0.5rem);
      background-color: var(--overlay-4, rgba(0, 0, 0, 0.53));
      border: 1px solid transparent;
      color: #fff;
      font-family: var(--font, "Overpass", system-ui, -apple-system, sans-serif);
      font-size: 1rem;
      line-height: 1.2;
      text-shadow: var(--hud-text-shadow, 1px 1px 2px var(--overlay-4, rgba(0, 0, 0, 0.5)));
      user-select: none;
      pointer-events: auto;
      box-sizing: border-box;
      transition: border-color 0.15s ease, transform 0.1s ease;
    }
    #terra-gear-hud.tg-in-flow {
      position: relative;
      z-index: auto;
      inset: auto;
    }
    #terra-gear-hud.limit-flash {
      border-color: var(--danger, #f28b82);
      transform: scale(0.98);
    }
    .tg-body {
      display: flex;
      align-items: stretch;
      gap: 0.4rem;
    }
    .tg-center {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .tg-side-col {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      width: 2.25rem;
      flex-shrink: 0;
    }
    .tg-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.35rem;
      padding-bottom: 0.18rem;
      margin-bottom: 0.22rem;
      border-bottom: 1px solid var(--white-1, rgba(255, 255, 255, 0.09));
      font-size: 0.62rem;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--white-3, rgba(255, 255, 255, 0.55));
      text-transform: uppercase;
    }
    .tg-warn {
      color: var(--danger, #f28b82);
      font-size: 0.58rem;
      font-weight: 700;
    }
    .tg-cfg-btn {
      background: transparent;
      border: 0;
      border-radius: var(--radius-sm, 0.25rem);
      color: var(--white-3, rgba(255, 255, 255, 0.55));
      cursor: pointer;
      font-family: inherit;
      font-size: 0.72rem;
      line-height: 1;
      padding: 0.08rem 0.18rem;
    }
    .tg-cfg-btn:hover {
      background: var(--white-2, rgba(255, 255, 255, 0.22));
      color: #fff;
    }
    .tg-main-readout {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.35rem;
      margin-bottom: 0.24rem;
    }
    .tg-gear-num {
      font-family: var(--font-mono, "Overpass Mono", monospace);
      font-size: 1.3rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.04em;
      color: #fff;
      line-height: 1;
    }
    .tg-teeth-badge {
      font-family: var(--font-mono, "Overpass Mono", monospace);
      font-size: 0.75rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--white-4, rgba(255, 255, 255, 0.85));
      background: var(--white-1, rgba(255, 255, 255, 0.09));
      padding: 0.08rem 0.32rem;
      border-radius: var(--radius-sm, 0.25rem);
    }
    .tg-ratio-badge {
      font-family: var(--font-mono, "Overpass Mono", monospace);
      font-size: 0.7rem;
      font-variant-numeric: tabular-nums;
      color: var(--white-4, rgba(255, 255, 255, 0.75));
    }
    .tg-drivetrain {
      display: flex;
      align-items: flex-end;
      gap: 0.55rem;
      height: 1.9rem;
      padding: 0.2rem 0.35rem;
      border-radius: var(--radius-sm, 0.25rem);
      background: var(--overlay-2, rgba(0, 0, 0, 0.28));
      box-sizing: border-box;
    }
    .tg-front-rings {
      display: flex;
      align-items: flex-end;
      gap: 0.22rem;
      height: 100%;
      padding-right: 0.45rem;
      border-right: 1px solid var(--white-1, rgba(255, 255, 255, 0.12));
    }
    .tg-cassette-cogs {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      flex: 1;
      gap: 0.125rem;
      height: 100%;
    }
    .tg-bar {
      flex: 1;
      border-radius: 0.125rem;
      background: var(--white-2, rgba(255, 255, 255, 0.25));
      transition: background 0.12s ease, box-shadow 0.12s ease;
      cursor: pointer;
    }
    .tg-bar:hover {
      background: var(--white-3, rgba(255, 255, 255, 0.5));
    }
    .tg-bar.active-front {
      background: #fff;
      box-shadow: 0 0 0.35rem rgba(255, 255, 255, 0.45);
    }
    .tg-bar.active-rear {
      background: var(--success, #6dd44d);
      box-shadow: 0 0 0.35rem color-mix(in oklab, var(--success, #6dd44d) 60%, transparent);
    }
    .tg-bar.cross-chain {
      background: var(--danger, #f28b82) !important;
      box-shadow: 0 0 0.35rem color-mix(in oklab, var(--danger, #f28b82) 60%, transparent) !important;
    }
    .tg-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.06rem;
      padding: 0.18rem 0.1rem;
      border-radius: var(--radius-sm, 0.25rem);
      border: 0;
      background: var(--white-1, rgba(255, 255, 255, 0.08));
      color: var(--white-4, rgba(255, 255, 255, 0.8));
      font-family: inherit;
      font-size: 0.6rem;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      text-align: center;
    }
    .tg-btn:hover {
      background: var(--white-2, rgba(255, 255, 255, 0.22));
      color: #fff;
    }
    .tg-btn-arrow {
      font-size: 0.58rem;
      line-height: 1;
    }
    .tg-btn-lbl {
      font-size: 0.58rem;
      letter-spacing: 0.03em;
      line-height: 1;
    }
    .tg-btn-save {
      flex-direction: row;
      background: var(--white-2, rgba(255, 255, 255, 0.2));
      color: #fff;
      padding: 0.28rem 0;
      font-size: 0.65rem;
    }
    .tg-btn-save:hover {
      background: var(--success, #6dd44d);
      color: #111;
    }
    .tg-config-drawer {
      display: none;
      flex-direction: column;
      gap: 0.375rem;
      margin-top: 0.38rem;
      padding-top: 0.38rem;
      border-top: 1px solid var(--white-1, rgba(255, 255, 255, 0.1));
      font-size: 0.65rem;
    }
    .tg-config-drawer.open {
      display: flex;
    }
    .tg-field-lbl {
      color: var(--white-4, rgba(255, 255, 255, 0.78));
      margin-bottom: 0.15rem;
    }
    .tg-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--overlay-4, rgba(0, 0, 0, 0.5));
      border: 1px solid var(--white-2, rgba(255, 255, 255, 0.22));
      color: #fff;
      border-radius: var(--radius-sm, 0.25rem);
      padding: 0.2rem 0.38rem;
      font-family: var(--font-mono, "Overpass Mono", monospace);
      font-size: 0.65rem;
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

      hudEl.innerHTML = `
      <div class="tg-body">
        <div class="tg-side-col tg-side-left">
          <button type="button" class="tg-btn" id="tg-fd-up" title="Left Shifter Up (Big Ring)"><span class="tg-btn-arrow">▲</span><span class="tg-btn-lbl">FD</span></button>
          <button type="button" class="tg-btn" id="tg-fd-down" title="Left Shifter Down (Small Ring)"><span class="tg-btn-lbl">FD</span><span class="tg-btn-arrow">▼</span></button>
        </div>
        <div class="tg-center">
          <div class="tg-header">
            <span id="tg-spec-title">2x12 GRX</span>
            <span id="tg-warn-label" class="tg-warn"></span>
            <button type="button" id="tg-cfg-toggle" class="tg-cfg-btn" title="Configure Gears">✎</button>
          </div>
          <div class="tg-main-readout">
            <span class="tg-gear-num" id="tg-gear-index">2-5</span>
            <span class="tg-teeth-badge" id="tg-teeth-text">46×21T</span>
            <span class="tg-ratio-badge" id="tg-ratio-text">2.19x</span>
          </div>
          <div class="tg-drivetrain">
            <div class="tg-front-rings" id="tg-front-bars"></div>
            <div class="tg-cassette-cogs" id="tg-rear-bars"></div>
          </div>
        </div>
        <div class="tg-side-col tg-side-right">
          <button type="button" class="tg-btn" id="tg-rd-up" title="Right Shifter Harder (Smaller Cog)"><span class="tg-btn-arrow">▲</span><span class="tg-btn-lbl">RD</span></button>
          <button type="button" class="tg-btn" id="tg-rd-down" title="Right Shifter Easier (Larger Cog)"><span class="tg-btn-lbl">RD</span><span class="tg-btn-arrow">▼</span></button>
        </div>
      </div>
      <div class="tg-config-drawer" id="tg-config-drawer">
        <div>
          <div class="tg-field-lbl">Front Chainrings (Teeth):</div>
          <input type="text" class="tg-input" id="tg-inp-front" value="${config.front.join(', ')}">
        </div>
        <div>
          <div class="tg-field-lbl">Rear Cassette (Teeth):</div>
          <input type="text" class="tg-input" id="tg-inp-rear" value="${config.rear.join(', ')}">
        </div>
        <button type="button" class="tg-btn tg-btn-save" id="tg-save-cfg">Save & Apply Drivetrain</button>
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

      updateHud();
      scanBiketerraDom();
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
      hudEl.querySelector('#tg-warn-label').textContent = cross ? 'CROSS' : '';

      const fContainer = hudEl.querySelector('#tg-front-bars');
      const maxF = Math.max(...config.front, 50);
      fContainer.innerHTML = '';
      config.front.forEach((t, idx) => {
        const bar = document.createElement('div');
        const hPct = Math.max(35, Math.round((t / maxF) * 100));
        bar.className = 'tg-bar' + (idx === state.frontIdx ? ' active-front' : '');
        bar.style.cssText = `width: 0.625rem; height: ${hPct}%;`;
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
        scanBiketerraDom();
      } else if (hudEl) {
        hudEl.remove();
        hudEl = null;
      }
    }

    await loadSettings();
    checkRouteAndMount();

    // Publish the initial gear state so listeners can learn the current 2x12 position right away
    // (e.g. karoo-bridge, which forwards gears to an external bike computer). Same shape as shift events.
    {
      const fTeeth = config.front[state.frontIdx];
      const rTeeth = config.rear[state.rearIdx];
      terra.bus.emit('realistic-gears:changed', {
        frontIndex: state.frontIdx + 1,
        frontTotal: config.front.length,
        frontTeeth: fTeeth,
        rearIndex: state.rearIdx + 1,
        rearTotal: config.rear.length,
        rearTeeth: rTeeth,
        ratio: Number((fTeeth / rTeeth).toFixed(2)),
        source: 'init'
      });
      terra.log(`Init gear state published: ${state.frontIdx + 1}-${state.rearIdx + 1} (${fTeeth}x${rTeeth}T)`);
    }

    const domObserver = new MutationObserver((mutations) => {
      if (!location.pathname.includes('/ride')) return;
      if (hudEl && mutations.every(m => hudEl.contains(m.target))) return;
      scanBiketerraDom();
    });
    domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

    terra.onNavigate(() => checkRouteAndMount());
    terra.settings.onChange(async () => {
      await loadSettings();
      pushImmediateFtmsShift();
      updateHud();
    });
    terra.onCleanup(() => {
      domObserver.disconnect();
      if (hudEl) hudEl.remove();
      restoreHiddenGearElements();
    });
})(terra);
