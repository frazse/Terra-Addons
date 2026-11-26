/* ---------- settings panel (replaces the extension's hub window) ---------- */
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}
const logLines = [];
let tabsEl, hintEl, profileSel;
const modInputs = {};
let panel, pill, pillDot, pillLabel, pillWrap, pillTimer, authRefreshTimer;
let rideToggle, consoleUiToggle, virtualShiftToggle, keepClickAwakeToggle, autoResetToggle;
let statusEl, authEl, authBodyEl, lastEl, logEl, savedEl, fallbackEl;
const rows = {};

function ulog(...a) { // panel log only
  logLines.push(a.join(' '));
  if (logLines.length > 80) logLines.shift();
  if (logEl) { logEl.textContent = logLines.join('\n'); logEl.scrollTop = 1e9; }
}
function note(...a) { ulog(...a); terra.log(a.join(' ')); } // panel log + terminal
function setLast(t) { if (lastEl) lastEl.textContent = t; }
let flashTimer;
function flash(t) {
  if (!savedEl) return;
  savedEl.textContent = t;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { savedEl.textContent = ''; }, 1500);
}

function fmtRemaining(ms) {
  if (ms == null || ms <= 0) return '0m';
  const totalMin = Math.ceil(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function connectedBatteries() {
  return [...devs].filter((d) => d.up && d.battery != null).map((d) => ({
    name: typeof deviceDisplayName === 'function' ? deviceDisplayName(d) : (d.device.name || ('Controller #' + d.n)),
    pct: d.battery,
  }));
}

function renderAuthBox(auth) {
  if (!authEl || !authBodyEl) return;
  if (!auth || !auth.hasClick) {
    authEl.style.display = 'none';
    return;
  }
  authEl.style.display = 'block';
  authEl.className = 'btz-auth ' + (
    auth.status === 'locked' || auth.status === 'expired' ? 'btz-auth-lock' :
    auth.status === 'unlocked' && !auth.expiringSoon ? 'btz-auth-ok' :
    auth.status === 'exempt' ? 'btz-auth-ok' : 'btz-auth-warn'
  );

  let title = '';
  let sub = '';
  if (auth.status === 'locked') {
    const why = auth.reason === 'hidden-service'
      ? 'Zwift service hidden'
      : auth.reason === 'challenge-unsolved'
        ? 'unauthenticated \u00b7 FF 03 challenge'
        : '24h Zwift auth required';
    title = `Click v2 Left pod locked (${why})`;
    sub = 'Open the Zwift app once with your Click v2 awake to unlock for 24h, or use Right-Only / auto-reset below.';
  } else if (auth.status === 'expired') {
    title = 'Click v2 24h Zwift unlock expired';
    sub = 'Open the Zwift app once to renew for 24h, then tap Recheck (or press a button to wake the Left pod).';
  } else if (auth.status === 'checking') {
    title = 'Checking Left Click v2 unlock (~65s live check)\u2026';
    sub = 'Staying connected past ~65s without a lock cutoff automatically confirms your 24h window.';
  } else if (auth.status === 'likely') {
    title = `Marked unlocked (~${fmtRemaining(auth.remainingMs)} left) \u2014 verifying live\u2026`;
    sub = 'Staying connected past ~65s confirms the unlock automatically.';
  } else if (auth.status === 'unlocked' && auth.expiringSoon) {
    title = `Click v2 unlock expires soon (~${fmtRemaining(auth.remainingMs)} left)`;
    sub = 'Renew in the Zwift app before your next ride.';
  } else if (auth.status === 'unlocked') {
    title = `Click v2 Left unlocked (~${fmtRemaining(auth.remainingMs)} left)`;
    sub = '24h Zwift authentication verified.';
  } else if (auth.status === 'exempt') {
    title = 'Click v2 Right pod ready (never locks)';
    sub = 'Only the Left pod has Zwift\u2019s 24h lock; Right-Only riding needs no Zwift auth.';
  } else {
    title = 'Click v2 paired \u2014 waiting for Left pod to check 24h auth';
    sub = 'Press a button on the Left pod to wake it and verify unlock status.';
  }

  const podRows = (auth.devices || []).map((x) => {
    const bits = [x.name, x.up ? 'connected' : 'waiting'];
    if (x.battery != null) bits.push(x.battery + '%');
    if (x.auth) {
      if (x.auth.state === 'exempt') bits.push('no lock');
      else if (x.auth.state === 'locked') bits.push('locked');
      else if (x.auth.state === 'expired') bits.push('auth expired');
      else if (x.auth.state === 'unlocked') bits.push(fmtRemaining(x.auth.remainingMs) + ' left');
      else if (x.auth.state === 'likely') bits.push('~' + fmtRemaining(x.auth.remainingMs) + ' left');
      else if (x.auth.state === 'checking') bits.push('checking\u2026');
    }
    return h('div', { class: 'btz-auth-pod' }, bits.join(' \u00b7 '));
  });

  const actions = [];
  if (auth.status !== 'exempt') {
    if (auth.status !== 'unlocked' || auth.expiringSoon) {
      actions.push(h('button', {
        class: 'btz-primary',
        type: 'button',
        onclick: () => { if (typeof markClickUnlockedManually === 'function') markClickUnlockedManually(); },
      }, 'I unlocked in Zwift app'));
    }
    actions.push(h('button', {
      class: 'btz-secondary',
      type: 'button',
      onclick: () => { if (typeof recheckClickAuth === 'function') recheckClickAuth(); },
    }, 'Recheck'));
    if (activeProfile !== 'clickv2_right' && (auth.status === 'locked' || auth.status === 'expired' || auth.status === 'unknown')) {
      actions.push(h('button', {
        class: 'btz-secondary',
        type: 'button',
        onclick: () => applyPresetById('clickv2_right'),
      }, 'Use Right-Only preset'));
    }
  }

  authBodyEl.replaceChildren(
    h('div', { class: 'btz-auth-title' }, title),
    h('div', { class: 'btz-auth-sub' }, sub),
    ...podRows,
    ...(actions.length ? [h('div', { class: 'btz-auth-actions' }, ...actions)] : []),
  );
}

function updateStatus() {
  if (typeof syncObcBattery === 'function') syncObcBattery();
  const n = count(), waiting = devs.size - n;
  const bats = connectedBatteries();
  const auth = typeof summarizeClickAuth === 'function' ? summarizeClickAuth() : { hasClick: false, status: 'none', devices: [] };
  const hasRideConnected = [...devs].some((d) => d.up && !isClickDevice(d));
  const hasClickConnected = [...devs].some((d) => d.up && isClickDevice(d));
  try {
    window.__zwiftRideState = {
      connected: n,
      waiting,
      batteries: bats,
      clickAuth: auth,
      rideEnabled,
      hasRide: hasRideConnected,
      hasClickConnected,
    };
    terra.bus.emit('zwift-ride:state', window.__zwiftRideState);
  } catch {}
  if (!pill) return;
  const batText = bats.length ? ' (' + bats.map((b) => b.pct + '%').join(', ') + ')' : '';
  const minBat = bats.length ? Math.min(...bats.map((b) => b.pct)) : null;
  statusEl.textContent = `${n} controller(s) connected${batText}` + (waiting ? `, ${waiting} waiting` : '');
  statusEl.classList.toggle('btz-bat-low', minBat !== null && minBat <= 20);
  renderAuthBox(auth);

  const authLocked = auth.hasClick && (auth.status === 'locked' || auth.status === 'expired');
  const authWarn = auth.hasClick && auth.status === 'unlocked' && auth.expiringSoon;
  if (authLocked) {
    pillDot.className = 'btz-dot lock';
    pillLabel.textContent = n > 0 ? `Controller \u00b7 ${n} \u00b7 Auth!` : 'Click v2 \u00b7 Auth needed';
  } else if (authWarn && n > 0) {
    pillDot.className = 'btz-dot warn';
    pillLabel.textContent = `Controller \u00b7 ${n} \u00b7 ${fmtRemaining(auth.remainingMs)}`;
  } else {
    pillDot.className = 'btz-dot ' + (n > 0 ? 'ok' : devs.size ? 'wait' : 'none');
    pillLabel.textContent = n > 0
      ? `Controller \u00b7 ${n}` + (minBat !== null ? ` \u00b7 ${minBat}%` : '')
      : devs.size ? 'Controller: waiting' : 'Pair controller';
  }
  const authNote = authLocked ? ' \u00b7 Click v2 auth needed' : authWarn ? ` \u00b7 Click v2 auth ${fmtRemaining(auth.remainingMs)} left` : '';
  pill.title = `Zwift controller: ${statusEl.textContent}${authNote} \u00b7 ${mode} page` + (rideEnabled ? '' : ' \u00b7 ride keys off') + ' (click for settings)';
}

// ---- header button: sits in Biketerra's nav row, right after the last link; floats if there is no header ----
function headerHost() {
  const isVisible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
  const nav = document.querySelector('header nav.nav-links, .header nav.nav-links, nav.nav-links');
  if (isVisible(nav)) {
    const links = [...nav.querySelectorAll('a')].filter(isVisible);
    const last = links[links.length - 1];
    if (last) {
      let item = last;
      while (item.parentElement && item.parentElement !== nav) item = item.parentElement;
      return { box: nav, item };
    }
  }
  const link = (t) => [...document.querySelectorAll('.header a, header a, nav a, a')].find((a) => isVisible(a) && a.textContent.trim() === t);
  const first = link('Routes') || link('Dashboard');
  const last = link('Badges') || link('Challenges') || link('Clubs') || link('Events');
  if (!first || !last) return null;
  let box = last.parentElement;
  while (box && !box.contains(first)) box = box.parentElement;
  if (!box || box === document.body || !isVisible(box)) return null;
  let item = last;
  while (item.parentElement && item.parentElement !== box) item = item.parentElement;
  return { box, item };
}
function placePill() {
  if (!pill) return;
  const host = headerHost();
  if (host) {
    let node = pill;
    if (host.item.tagName === 'LI') {
      pillWrap = pillWrap || h('li', { class: 'btz-pill-wrap' });
      if (pill.parentElement !== pillWrap) pillWrap.append(pill);
      node = pillWrap;
    }
    pill.classList.add('btz-in-header');
    pill.style.display = '';
    if (node.previousElementSibling !== host.item) host.item.after(node);
  } else {
    pill.classList.remove('btz-in-header');
    if (pill.parentElement !== document.body) document.body.append(pill);
    if (pillWrap) pillWrap.remove();
    pill.style.display =
      mode === 'ride' || location.pathname.startsWith(SPECTATE_PATH_PREFIX) ? 'none' : '';
  }
}

function setRideEnabled(v) {
  rideEnabled = v;
  terra.storage.set('rideEnabled', v).then(() => flash(v ? 'Ride keys on' : 'Ride keys off'), (e) => flash('Save failed: ' + e));
  releaseAll();
  applyShare();
  panel.classList.toggle('btz-ride-off', !v);
  updateStatus();
}

function setConsoleUiEnabled(v) {
  consoleUiEnabled = v;
  terra.storage.set('consoleUiEnabled', v).then(
    () => flash(v ? 'Console UI on' : 'Console UI off'),
    (e) => flash('Save failed: ' + e)
  );
  if (!v && typeof unwrapAthletePage === 'function') unwrapAthletePage();
  if (typeof scheduleConsoleUi === 'function') scheduleConsoleUi();
}

function setAutoVirtualShift(v) {
  autoVirtualShift = v;
  terra.storage.set('autoVirtualShift', v).then(
    () => flash(v ? 'Virtual OBC shifter on' : 'Virtual OBC shifter off'),
    (e) => flash('Save failed: ' + e)
  );
  if (v) {
    if (typeof maybePairObcMock === 'function') maybePairObcMock();
  } else {
    if (typeof disconnectObcMock === 'function') disconnectObcMock();
  }
}

function setKeepClickAwake(v) {
  keepClickAwake = v;
  terra.storage.set('keepClickAwake', v).then(
    () => flash(v ? 'Keep-awake on' : 'Keep-awake off'),
    (e) => flash('Save failed: ' + e)
  );
  if (v) {
    const now = Date.now();
    for (const d of devs) {
      if (isClickDevice(d) && d.up && !d.idleResetSent && d.writeCh && typeof CLICK_IDLE_RESET_MS === 'number') {
        const activeRef = Math.max(d.connectedAt || 0, d.lastButtonAt || 0);
        if (activeRef && now - activeRef >= CLICK_IDLE_RESET_MS) {
          d.idleResetSent = true;
          d.lastResetAt = now;
          writeGatt(d.writeCh, CLICK_RESET_CMD).catch(() => {});
        }
      }
    }
  }
}

function setAutoResetLocked(v) {
  autoResetLocked = v;
  terra.storage.set('autoResetLocked', v).then(
    () => flash(v ? 'Auto-reset on' : 'Auto-reset off'),
    (e) => flash('Save failed: ' + e)
  );
  if (v) {
    for (const d of devs) {
      if (isClickDevice(d) && d.up && d.sawStopped && d.writeCh) {
        d.lastResetAt = Date.now();
        writeGatt(d.writeCh, CLICK_RESET_CMD).catch(() => {});
      }
    }
  }
}

const CMD_ACTIONS = [
  ['open_terra', 'Open Terra settings'],
  ['cycle_profile', 'Cycle Ride profile'],
  ['voice_ptt', 'Voice chat (Push-to-Talk)'],
  ['group_view', 'Group view (follow focal rider)'],
];
const CMD_LABEL = Object.fromEntries(CMD_ACTIONS);
const ARROWS = { ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192' };

function keyLabel(k) {
  if (!k) return '\u2014';
  if (k.code && k.code.startsWith('Cmd:')) return CMD_LABEL[k.code.slice(4)] || 'Command';
  if (k.code && k.code.startsWith('Cam:')) return CAM_LABEL[k.code.slice(4)] || 'Camera';
  if (ARROWS[k.code]) return ARROWS[k.code];
  if (k.key === ' ') return 'Space';
  if (k.key && k.key.length === 1) return k.key.toUpperCase();
  return k.code.replace(/^(Key|Digit)/, '');
}
function fillSelect(sel) {
  sel.replaceChildren();
  if (layer !== 'normal') sel.append(h('option', { value: 'inherit' }, '(as normal)'));
  for (const [v, t] of ACTION_LIST) sel.append(h('option', { value: v }, t));
  sel.dataset.layer = layer;
}
function refresh(name) {
  const r = rows[name], arr = rideMap(layer)[name], b = browseMap(layer)[name];
  const inherit = layer !== 'normal';
  r.slot.textContent = arr && arr.length ? keyLabel(arr[0]) : inherit ? 'as normal' : '\u2014';
  r.slot.classList.toggle('btz-inherit', inherit && !(arr && arr.length));
  const a0 = arr && arr[0];
  if (a0 && a0.code.startsWith('Cam:')) r.cam.value = a0.code;
  else if (a0 && a0.code.startsWith('Cmd:')) r.cam.value = a0.code;
  else r.cam.value = '';
  if (r.sel.dataset.layer !== layer) fillSelect(r.sel);
  r.sel.value = layer === 'normal' ? (b || 'none') : (b === undefined ? 'inherit' : b);
}

// ---- profiles ----
function profileLabel(id) {
  if (PRESETS[id]) return PRESETS[id].label;
  if (id.startsWith('custom:')) return 'Custom: ' + id.slice(7);
  return id;
}

function renderProfiles() {
  if (!profileSel) return;
  profileSel.replaceChildren();
  for (const [id, p] of Object.entries(PRESETS)) {
    profileSel.append(h('option', { value: id }, p.label));
  }
  for (const name of Object.keys(customProfiles || {})) {
    profileSel.append(h('option', { value: 'custom:' + name }, 'Custom: ' + name));
  }
  if (![...profileSel.options].some((o) => o.value === activeProfile)) {
    profileSel.append(h('option', { value: activeProfile }, profileLabel(activeProfile)));
  }
  profileSel.value = activeProfile;
}

function applyPresetById(id) {
  let nextCfg = null;
  if (PRESETS[id]) {
    nextCfg = normalizeCfg(PRESETS[id].cfg());
  } else if (id.startsWith('custom:') && customProfiles[id.slice(7)]) {
    nextCfg = normalizeCfg(customProfiles[id.slice(7)]);
  }
  if (!nextCfg) return;
  activeProfile = id;
  cfg = nextCfg;
  layer = 'normal';
  releaseAll();
  terra.storage.set('activeProfile', activeProfile).catch(() => {});
  saveCfg();
  for (const m of MOD_CAPABLE) {
    if (modInputs[m]) modInputs[m].checked = !!cfg.mods[m];
  }
  INPUTS.forEach(([n]) => refresh(n));
  renderTabs();
  renderProfiles();
  flash('Profile: ' + profileLabel(id));
  note('profile switched to', profileLabel(id));
}

function cyclePreset() {
  const keys = [
    ...Object.keys(PRESETS),
    ...Object.keys(customProfiles || {}).map((k) => 'custom:' + k),
  ];
  if (!keys.length) return;
  const idx = keys.indexOf(activeProfile);
  const next = keys[(idx + 1) % keys.length];
  applyPresetById(next);
}

async function saveCustomPreset() {
  const name = prompt('Save current bindings as a custom preset name:');
  if (!name || !name.trim()) return;
  const clean = name.trim().slice(0, 40);
  customProfiles[clean] = clone(cfg);
  activeProfile = 'custom:' + clean;
  await terra.storage.set('customProfiles', customProfiles);
  await terra.storage.set('activeProfile', activeProfile);
  renderProfiles();
  flash('Saved preset "' + clean + '"');
}

// ---- layers: tabs for "Normal" and each enabled modifier ----
function setLayer(l) {
  layer = l;
  INPUTS.forEach(([n]) => refresh(n));
  renderTabs();
}
function renderTabs() {
  if (!tabsEl) return;
  if (layer !== 'normal' && !cfg.mods[layer]) layer = 'normal';
  const enabled = MOD_CAPABLE.filter((m) => cfg.mods[m]);
  tabsEl.replaceChildren();
  const tab = (id, label) => h('button', { class: 'btz-tab' + (layer === id ? ' active' : ''), type: 'button', onclick: () => setLayer(id) }, label);
  tabsEl.append(tab('normal', 'Normal'), ...enabled.map((m) => tab(m, MOD_SHORT[m] + ' held')));
  tabsEl.style.display = enabled.length ? '' : 'none';
  for (const [n, label] of INPUTS) {
    const r = rows[n];
    r.tr.style.display = n === layer ? 'none' : '';
    r.label.textContent = label + (layer === 'normal' && cfg.mods[n] ? ' \u00b7 tap' : '');
    refresh(n);
  }
  hintEl.textContent = layer !== 'normal'
    ? `Used while ${LABEL[layer]} is held. "as normal" = the normal mapping applies.`
    : enabled.length ? 'A modifier button used on its own (a tap) runs the mapping set here for it.' : '';
}
function modBox(m) {
  const cb = h('input', { type: 'checkbox' });
  cb.checked = !!cfg.mods[m];
  cb.addEventListener('change', () => { cfg.mods[m] = cb.checked; releaseAll(); saveCfg(); renderTabs(); });
  modInputs[m] = cb;
  return h('label', { class: 'btz-toggle' }, cb, ' ' + LABEL[m] + ' is a modifier');
}

let cancelCapture = null;
function capture(name, btn) {
  if (cancelCapture) cancelCapture();
  let finished = false;
  const l = layer;
  btn.textContent = 'press a key\u2026';
  const done = (k) => {
    if (finished) return;
    finished = true;
    window.removeEventListener('keydown', onKey, true);
    btn.removeEventListener('blur', onBlur);
    cancelCapture = null;
    if (k) { rideMap(l)[name] = [k]; saveCfg(); }
    refresh(name);
    btn.blur();
  };
  const onKey = (e) => { if (!e.isTrusted) return; e.preventDefault(); e.stopPropagation(); done({ code: e.code, key: e.key }); };
  const onBlur = () => done(null);
  window.addEventListener('keydown', onKey, true);
  btn.addEventListener('blur', onBlur);
  cancelCapture = () => done(null);
  btn.focus();
}

function buildTable(tbody) {
  for (const [name, label] of INPUTS) {
    const slot = h('button', { class: 'btz-slot' });
    slot.addEventListener('click', () => capture(name, slot));
    const x = h('button', { class: 'btz-x', title: 'clear' }, '\u00d7');
    x.addEventListener('click', () => {
      if (layer === 'normal') cfg.ride[name] = []; else delete rideMap(layer)[name];
      saveCfg();
      refresh(name);
    });
    const sel = h('select');
    sel.addEventListener('change', () => {
      const m = browseMap(layer);
      if (sel.value === 'inherit') delete m[name]; else m[name] = sel.value;
      saveCfg();
    });
    const cam = h('select', { title: 'Camera or Terra action (instead of a key) on ride pages' });
    const camGroup = h('optgroup', { label: 'Camera' }, ...CAM_ACTIONS.map(([v, t]) => h('option', { value: 'Cam:' + v }, t)));
    const cmdGroup = h('optgroup', { label: 'Terra' }, ...CMD_ACTIONS.map(([v, t]) => h('option', { value: 'Cmd:' + v }, t)));
    cam.append(h('option', { value: '' }, '\u2014'), camGroup, cmdGroup);
    cam.addEventListener('change', () => {
      if (cam.value) rideMap(layer)[name] = [{ code: cam.value, key: cam.value.startsWith('Cmd:') ? 'cmd' : 'cam' }];
      else {
        const cur = (rideMap(layer)[name] || [])[0];
        if (cur && (cur.code.startsWith('Cam:') || cur.code.startsWith('Cmd:'))) {
          if (layer === 'normal') cfg.ride[name] = []; else delete rideMap(layer)[name];
        }
      }
      saveCfg();
      refresh(name);
    });
    const labelTd = h('td', {}, label);
    const tr = h('tr', { id: 'btz-row-' + name }, labelTd, h('td', {}, slot, x), h('td', {}, cam), h('td', {}, sel));
    tbody.append(tr);
    rows[name] = { slot, sel, tr, label: labelTd, cam };
    refresh(name);
  }
}

function buildVirtual(box) {
  const mk = (name, text) => {
    const b = h('button', { class: 'btz-vb', title: 'Shift+click latches it down; click again to release' }, text);
    let down = false, latched = false;
    const release = () => { if (down) { down = false; latched = false; b.classList.remove('held'); emit(name, 'up', { src: 'virtual' }); } };
    const up = () => { if (!latched) release(); };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (latched) { release(); return; }
      b.setPointerCapture(e.pointerId);
      if (!down) { down = true; latched = e.shiftKey; b.classList.add('held'); emit(name, 'down', { src: 'virtual' }); }
    });
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    return b;
  };
  const cross = (top, left, right, bottom) =>
    h('div', { class: 'btz-vgrid' }, ...[null, top, null, left, null, right, null, bottom, null].map((c) => c || h('span')));
  const row = (...bs) => h('div', { class: 'btz-vrow' }, ...bs);
  const group = (title, ...els) => h('div', { class: 'btz-vgroup' }, h('p', {}, title), ...els);
  box.append(
    group('Left controller',
      cross(mk('up', '\u2191'), mk('left', '\u2190'), mk('right', '\u2192'), mk('down', '\u2193')),
      row(mk('shift_up_l', 'LS1'), mk('shift_dn_l', 'LS2')),
      row(mk('lever_l_pos', 'ZL +'), mk('lever_l_neg', 'ZL \u2212')),
      row(mk('powerup_l', 'LB'), mk('onoff_l', 'Power'))),
    group('Right controller',
      cross(mk('y', 'Y'), mk('b', 'B'), mk('z', 'Z'), mk('a', 'A')),
      row(mk('shift_up_r', 'RS1'), mk('shift_dn_r', 'RS2')),
      row(mk('lever_r_pos', 'ZR +'), mk('lever_r_neg', 'ZR \u2212')),
      row(mk('powerup_r', 'RB'), mk('onoff_r', 'Power'))),
  );
}

async function pairController() {
  ulog('requesting device...');
  try {
    const device = await terra.ble.request({
      filters: [{ services: [SVC_RIDE] }, { services: [SVC_CUSTOM] }, { namePrefix: 'Zwift' }],
      optionalServices: [SVC_RIDE, SVC_CUSTOM, BAT_SVC],
    });
    note('chosen:', device.name || device.id);
    const dev = register(device);
    if (!dev) { ulog('already paired'); return; }
    await keepAliveOnce(dev);
  } catch (e) {
    note('pair error:', (e.name || 'Error') + ': ' + (e.message || e));
  }
}
async function keepAliveOnce(dev) { await attach(dev).catch((e) => { note('connect failed:', e.message || e); keepAlive(dev); }); }

function buildPanel() {
  const tbody = h('tbody');
  tabsEl = h('div', { class: 'btz-tabs' });
  hintEl = h('p', {});
  const vc = h('div', { id: 'btz-vc' });
  statusEl = h('div', { id: 'btz-status' }, '0 controller(s) connected');
  authBodyEl = h('div', { class: 'btz-auth-body' });
  keepClickAwakeToggle = h('input', { type: 'checkbox', id: 'btz-keepawake-toggle' });
  keepClickAwakeToggle.checked = keepClickAwake;
  keepClickAwakeToggle.addEventListener('change', () => setKeepClickAwake(keepClickAwakeToggle.checked));
  autoResetToggle = h('input', { type: 'checkbox', id: 'btz-autoreset-toggle' });
  autoResetToggle.checked = autoResetLocked;
  autoResetToggle.addEventListener('change', () => setAutoResetLocked(autoResetToggle.checked));
  authEl = h('div', { id: 'btz-auth', style: 'display:none' },
    authBodyEl,
    h('label', { class: 'btz-toggle btz-auth-opt' }, keepClickAwakeToggle, ' Force periodic idle reboot (0x18 after 55s)'),
    h('p', { class: 'btz-auth-opt-note' }, 'Off by default. Sends 0x18 after 55s with no button presses, which reboots the Click hardware and briefly drops/reconnects BLE.'),
    h('label', { class: 'btz-toggle btz-auth-opt' }, autoResetToggle, ' Auto-reset locked Left pod (0x18 every ~55s)'),
    h('p', { class: 'btz-auth-opt-note' }, 'Fallback if you didn\u2019t unlock in Zwift today: briefly reconnects every ~55s to keep Left buttons active.')
  );
  lastEl = h('pre', { id: 'btz-last' }, 'Press a button on the controller...');
  logEl = h('pre', { id: 'btz-log' });
  savedEl = h('span', { id: 'btz-saved' });
  fallbackEl = h('p', {}, 'Pairing shows Terra\u2019s device chooser. Paired controllers are remembered and reconnect by themselves. For Zwift Click v2, pair both Left and Right pods (or just Right in Right-Only mode).');
  rideToggle = h('input', { type: 'checkbox', id: 'btz-ride-toggle' });
  rideToggle.checked = rideEnabled;
  rideToggle.addEventListener('change', () => setRideEnabled(rideToggle.checked));
  consoleUiToggle = h('input', { type: 'checkbox', id: 'btz-console-ui-toggle' });
  consoleUiToggle.checked = consoleUiEnabled;
  consoleUiToggle.addEventListener('change', () => setConsoleUiEnabled(consoleUiToggle.checked));
  virtualShiftToggle = h('input', { type: 'checkbox', id: 'btz-virtual-shift-toggle' });
  virtualShiftToggle.checked = autoVirtualShift;
  virtualShiftToggle.addEventListener('change', () => setAutoVirtualShift(virtualShiftToggle.checked));

  profileSel = h('select', { title: 'Binding profile preset' });
  profileSel.addEventListener('change', () => applyPresetById(profileSel.value));
  renderProfiles();

  panel = h('div', { id: 'btz-panel' },
    h('button', { class: 'btz-close', title: 'close', onclick: () => togglePanel(false) }, '\u00d7'),
    h('h3', {}, 'Zwift Ride / Click v2'),
    h('p', {}, 'Terra holds the Bluetooth connection, so page loads on the site no longer drop your controller.'),
    h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' },
      h('button', { class: 'btz-primary', onclick: pairController }, 'Pair controller'),
      h('button', { class: 'btz-secondary', onclick: () => terra.bus.emit('terra:open-addons', {}) }, 'Terra settings')),
    statusEl, authEl, fallbackEl,
    h('label', { class: 'btz-toggle' }, rideToggle, ' Send ride keys on ride pages'),
    h('p', {}, 'Turn off to let Biketerra handle the controller itself during rides. Navigation on other pages keeps working.'),
    h('label', { class: 'btz-toggle' }, consoleUiToggle, ' Enable Console UI (widescreen layout & bottom HUD)'),
    h('p', {}, 'Turn off on mobile devices or smaller screens to keep Biketerra\u2019s default layout and hide the bottom controller bar.'),
    h('label', { class: 'btz-toggle' }, virtualShiftToggle, ' Virtual OpenBikeControl shifter (auto Virtual Shifting)'),
    h('p', {}, 'Auto-pairs a virtual OpenBikeControl controller on ride pages when 1 or 2 controllers are connected, so Biketerra switches to Virtual Shifting on its own.'),
    h('h4', {}, 'Binding profile'),
    h('div', { class: 'btz-profile-row' },
      profileSel,
      h('button', { class: 'btz-secondary', type: 'button', onclick: saveCustomPreset }, 'Save as preset\u2026')),
    h('h4', {}, 'Modifier buttons'),
    ...MOD_CAPABLE.map(modBox),
    h('p', {}, 'A modifier does nothing by itself while held. Press another button meanwhile to use that button\u2019s mapping from the modifier\u2019s tab below; a quick tap on its own runs its normal mapping.'),
    h('h4', {}, 'Last inputs'), lastEl,
    h('h4', {}, 'Button mapping ', savedEl),
    h('p', {}, 'Click a key slot, then press the key to send during a ride. The row lights up while you press the matching button or move a lever. Changes save automatically.'),
    tabsEl, hintEl,
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Input'), h('th', {}, 'Ride key'), h('th', {}, 'Action'), h('th', {}, 'On site pages'))), tbody),
    h('p', {},
      h('button', { class: 'btz-secondary', title: 'Makes LB a modifier: LB + D-pad orbits/tilts, LB + shifters zoom', onclick: () => applyCameraPreset('powerup_l') }, 'Camera preset on LB'),
      ' ',
      h('button', { class: 'btz-secondary', title: 'Makes Click \u2212 (LS1) a modifier: tap \u2212 to shift down, hold \u2212 + A/B/Y/Z or D-pad for camera, hold \u2212 + + for group spectate', onclick: () => { applyCameraPreset('shift_up_l'); flash('Click \u2212 modifier enabled'); } }, 'Click \u2212 cam + group preset'),
      ' ',
      h('button', { class: 'btz-secondary', onclick: () => applyPresetById('default') }, 'Reset to defaults')),
    h('details', {}, h('summary', {}, 'Debug: virtual controller'),
      h('p', {}, 'Press and hold these like the real buttons; they go through the same mapping. Shift+click latches a button down, so you can test modifier combos with one mouse.'), vc),
    h('h4', {}, 'Log'), logEl,
  );
  buildTable(tbody);
  renderTabs();
  buildVirtual(vc);

  panel.classList.toggle('btz-ride-off', !rideEnabled);

  pillDot = h('span', { class: 'btz-dot none' });
  pillLabel = h('span', {}, 'Pair controller');
  pill = h('button', { id: 'btz-pill', type: 'button' }, pillDot, pillLabel);
  pill.addEventListener('click', () => togglePanel());
  document.body.append(panel);
  placePill();
  pillTimer = setInterval(placePill, 500);
  authRefreshTimer = setInterval(() => {
    if (typeof summarizeClickAuth === 'function' && summarizeClickAuth().hasClick) updateStatus();
  }, 60000);
  terra.onCleanup(() => {
    clearInterval(pillTimer);
    clearInterval(authRefreshTimer);
    panel.remove(); pill.remove();
    if (pillWrap) pillWrap.remove();
  });
  updateStatus();
}

function togglePanel(force) {
  const open = force ?? !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  if (open) ulog('settings open');
}
