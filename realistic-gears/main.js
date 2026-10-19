(async (terra) => {
  terra.log('REALISTIC GEARS ADDON LOADED. pathname = ' + location.pathname);
  const FTMS_CONTROL_POINT = '00002ad9-0000-1000-8000-00805f9b34fb';

  // Default 2x12 Gravel setup: 46/30T front, 11-34T 12-speed rear
  let config = {
    front: [30, 46], // sorted small -> big (idx 0 = 30T, idx 1 = 46T)
rear: [34, 30, 27, 24, 21, 19, 17, 15, 14, 13, 12, 11], // idx 0 = 34T (easiest) -> idx 11 = 11T (hardest)
baseRatio: 2.15, // Neutral 1:1 reference ratio (e.g. 46x21 = 2.19) where trainer feels at stock baseline
 keyRearHarder: 'w',
 keyRearEasier: 's',
 keyFrontUp: 'q',
 keyFrontDown: 'q',
 hudPos: { bottom: '24px', right: '280px' }
  };

  let state = {
    frontIdx: 1, // 46T
    rearIdx: 4,  // 21T (ratio ~2.19)
ftmsChar: null,
lastRawSim: {
  wind: 100,   // 0.100 m/s
  grade: 0,    // 0.00%
  crr: 40,     // 0.0040
  cw: 51       // 0.51 kg/m
},
isInternalWrite: false,
writePending: false,
queuedSimPacket: null
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
  // KICKR CORE advertises Zwift Virtual Shifting under service 0000fc82-0000-1000-8000-00805f9b34fb
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
    // KICKR CORE expects gear ratio * 10000 (e.g. 46 / 19 = 2.4211 -> 24211)
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
                  // If Biketerra writes a 0x04 0x2a gear packet, override it with our active 2D gear!
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

  async function scanAndBindExistingTrainer() {
    if (!core || !core.devices) return;
    for (const dev of core.devices.values()) {
      const name = (dev.name || '').toUpperCase();
      if (name.includes('ZWIFT RIDE')) continue;
      if (dev.gatt && dev.gatt.connected) {
        for (const sUuid of ZWIFT_VS_SERVICES) {
          try {
            const svc = await dev.gatt.getPrimaryService(sUuid);
            if (svc) {
              const chr = await svc.getCharacteristic(ZWIFT_VS_RX_CHAR);
              if (chr) {
                hookVsCharacteristic(chr, dev.name || dev.id);
                return;
              }
            }
          } catch (_) {
            // Try next service UUID
          }
        }
      }
    }
  }

  function installFtmsInterceptor() {
    scanAndBindExistingTrainer();
    terra.ble.onConnect(() => setTimeout(scanAndBindExistingTrainer, 300));
    terra.ble.onPaired(() => setTimeout(scanAndBindExistingTrainer, 300));

    const pollId = setInterval(() => {
      if (!state.vsChar) scanAndBindExistingTrainer();
    }, 2000);
      terra.onCleanup(() => clearInterval(pollId));
  }

  async function pushImmediateFtmsShift() {
    if (!state.vsChar) {
      await scanAndBindExistingTrainer();
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

    // Immediately push new gear resistance to the trainer over FTMS
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

  function shiftRear(dir) {
    return applyGearChange(state.frontIdx, state.rearIdx + dir, 'rear');
  }

  function shiftFront(dir) {
    if (config.front.length <= 1) return false;
    let nextFront = state.frontIdx + dir;
    if (dir === 0) {
      nextFront = (state.frontIdx + 1) % config.front.length;
    }
    return applyGearChange(nextFront, state.rearIdx, 'front');
  }

  terra.bus.on('realistic-gears:shift', (cmd) => {
    if (!cmd) return;
    if (cmd.derailleur === 'front') shiftFront(cmd.dir ?? 0);
    else if (cmd.derailleur === 'rear') shiftRear(cmd.dir ?? 1);
  });

    // --- 3. INTERCEPT KEYBOARD & ZWIFT RIDE SYNTHETIC KEYS ---
    const sameKey = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

    function onKeyEvent(e) {
      if (!location.pathname.includes('/ride')) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;

      const k = e.key;
      const isRearHarder = sameKey(k, config.keyRearHarder);
      const isRearEasier = sameKey(k, config.keyRearEasier);
      const isFrontUp = sameKey(k, config.keyFrontUp);
      const isFrontDown = sameKey(k, config.keyFrontDown);

      // Always swallow 'w', 's', and configured shift keys so Biketerra's built-in shifting never interferes!
      if (isRearHarder || isRearEasier || isFrontUp || isFrontDown || sameKey(k, 'w') || sameKey(k, 's')) {
        e.preventDefault();
        e.stopImmediatePropagation();

        if (e.type === 'keydown' && !e.repeat) {
          if (isRearHarder) shiftRear(+1);
          else if (isRearEasier) shiftRear(-1);
          else if (isFrontUp && isFrontDown) shiftFront(0);
          else if (isFrontUp) shiftFront(+1);
          else if (isFrontDown) shiftFront(-1);
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
