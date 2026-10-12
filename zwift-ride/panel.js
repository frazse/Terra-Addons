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
let tabsEl, hintEl;
const modInputs = {};
let panel, pill, pillDot, pillLabel, pillWrap, pillTimer, rideToggle, statusEl, lastEl, logEl, savedEl, fallbackEl;
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
function updateStatus() {
  if (!pill) return;
  const n = count(), waiting = devs.size - n;
  statusEl.textContent = `${n} controller(s) connected` + (waiting ? `, ${waiting} waiting` : '');
  pillDot.className = 'btz-dot ' + (n > 0 ? 'ok' : devs.size ? 'wait' : 'none');
  pillLabel.textContent = n > 0 ? `Controller \u00b7 ${n}` : devs.size ? 'Controller: waiting' : 'Pair controller';
  pill.title = `Zwift Ride: ${statusEl.textContent} \u00b7 ${mode} page` + (rideEnabled ? '' : ' \u00b7 ride keys off') + ' (click for settings)';
}

// ---- header button: sits in Biketerra's nav row, right after the last link; floats if there is no header ----
function headerHost() {
  const link = (t) => [...document.querySelectorAll('a')].find((a) => a.textContent.trim() === t);
  const first = link('Dashboard'), last = link('Challenges');
  if (!first || !last) return null;
  let box = last.parentElement;
  while (box && !box.contains(first)) box = box.parentElement; // nav list = common ancestor of both links
  if (!box || box === document.body) return null;
  let item = last;
  while (item.parentElement && item.parentElement !== box) item = item.parentElement; // child of the list holding the last link
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
    // No header on ride pages: the floating pill would sit on top of Biketerra's stats, so hide it there.
    pill.style.display = mode === 'ride' ? 'none' : '';
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

const ARROWS = { ArrowUp: '\u2191', ArrowDown: '\u2193', ArrowLeft: '\u2190', ArrowRight: '\u2192' };
function keyLabel(k) {
  if (!k) return '\u2014';
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
  if (r.sel.dataset.layer !== layer) fillSelect(r.sel);
  r.sel.value = layer === 'normal' ? (b || 'none') : (b === undefined ? 'inherit' : b);
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
    r.tr.style.display = n === layer ? 'none' : ''; // a modifier has no mapping inside its own layer
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
  const l = layer; // the layer being edited when capture started
  btn.textContent = 'press a key\u2026';
  const done = (k) => {
    if (finished) return;
    finished = true;
    window.removeEventListener('keydown', onKey, true);
    btn.removeEventListener('blur', onBlur);
    cancelCapture = null;
    if (k) { rideMap(l)[name] = [k]; saveCfg(); }
    refresh(name);
    btn.blur(); // so Space/Enter on the captured key can't re-trigger the button
  };
  // Only real keyboard presses: the controller's own synthetic keys must not be captured.
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
    const labelTd = h('td', {}, label);
    const tr = h('tr', { id: 'btz-row-' + name }, labelTd, h('td', {}, slot, x), h('td', {}, sel));
    tbody.append(tr);
    rows[name] = { slot, sel, tr, label: labelTd };
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
      filters: [{ services: [SVC] }, { namePrefix: 'Zwift' }],
      optionalServices: [SVC],
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
  lastEl = h('pre', { id: 'btz-last' }, 'Press a button on the controller...');
  logEl = h('pre', { id: 'btz-log' });
  savedEl = h('span', { id: 'btz-saved' });
  fallbackEl = h('p', {}, 'Pairing shows Terra\'s device chooser. Paired controllers are remembered and reconnect by themselves.');
  rideToggle = h('input', { type: 'checkbox', id: 'btz-ride-toggle' });
  rideToggle.checked = rideEnabled;
  rideToggle.addEventListener('change', () => setRideEnabled(rideToggle.checked));

  panel = h('div', { id: 'btz-panel' },
    h('button', { class: 'btz-close', title: 'close', onclick: () => togglePanel(false) }, '\u00d7'),
    h('h3', {}, 'Zwift Ride controller'),
    h('p', {}, 'Terra holds the Bluetooth connection, so page loads on the site no longer drop your controller.'),
    h('button', { class: 'btz-primary', onclick: pairController }, 'Pair controller'),
    statusEl, fallbackEl,
    h('label', { class: 'btz-toggle' }, rideToggle, ' Send ride keys on ride pages'),
    h('p', {}, 'Turn off to let Biketerra handle the controller itself during rides. Navigation on other pages keeps working.'),
    h('h4', {}, 'Modifier buttons'),
    ...MOD_CAPABLE.map(modBox),
    h('p', {}, 'A modifier does nothing by itself while held. Press another button meanwhile to use that button\'s mapping from the modifier\'s tab below; a quick tap on its own runs its normal mapping.'),
    h('h4', {}, 'Last inputs'), lastEl,
    h('h4', {}, 'Button mapping ', savedEl),
    h('p', {}, 'Click a key slot, then press the key to send during a ride. The row lights up while you press the matching button or move a lever. Changes save automatically.'),
    tabsEl, hintEl,
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Input'), h('th', {}, 'Ride key'), h('th', {}, 'On site pages'))), tbody),
    h('p', {}, h('button', { class: 'btz-secondary', onclick: () => {
      cfg = defaultCfg();
      layer = 'normal';
      releaseAll();
      saveCfg();
      for (const m of MOD_CAPABLE) modInputs[m].checked = false;
      INPUTS.forEach(([n]) => refresh(n));
      renderTabs();
    } }, 'Reset to defaults')),
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
  pillTimer = setInterval(placePill, 500); // the page re-renders its header now and then
  terra.onCleanup(() => { clearInterval(pillTimer); panel.remove(); pill.remove(); if (pillWrap) pillWrap.remove(); });
  updateStatus();
}

function togglePanel(force) {
  const open = force ?? !panel.classList.contains('open');
  panel.classList.toggle('open', open);
  if (open) ulog('settings open');
}
