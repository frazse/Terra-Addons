/* ---------- camera control (ride pages) ----------
 C amera actions are sto*red in the ride map as pseudo-keys { code: 'Cam:<action>', key: 'cam' }, so they work in
 normal AND modifier layers with no changes to the layer logic. nav.js's fire() routes them here instead of
 dispatching a KeyboardEvent. While an orbit/tilt action is held we emulate a middle-button drag on the game
 canvas (mouse-move deltas); zoom emulates wheel ticks. */

const CAM_ACTIONS = [
  ['orbit_left', 'Orbit \u2190'], ['orbit_right', 'Orbit \u2192'],
['tilt_up', 'Tilt \u2191'], ['tilt_down', 'Tilt \u2193'],
['zoom_in', 'Zoom in'], ['zoom_out', 'Zoom out'],
];
const CAM_LABEL = Object.fromEntries(CAM_ACTIONS);
const CAM_DRAG_SPEED = 450;  // px/s of emulated mouse movement while held
const CAM_WHEEL_STEP = 100;  // deltaY per wheel tick
const CAM_WHEEL_MS = 70;     // ms between wheel ticks while a zoom is held
const CAM_EVENTS = 'both';   // 'both' | 'mouse' | 'pointer' - flip if the page misbehaves (see README)

const camOn = new Set();
let camRaf = 0, camLast = 0, camDrag = null, camWheelAcc = 0;

function camCanvas() {
  let best = null, area = 0;
  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect(), a = r.width * r.height;
    if (a > area) { area = a; best = c; }
  }
  return best;
}

// Clear focus from any UI button the mouse previously clicked and park virtual hover at canvas center
function camCenterAndDefocus(target) {
  if (document.activeElement && document.activeElement !== document.body && document.activeElement !== target) {
    try { document.activeElement.blur(); } catch {}
  }
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  try { target.focus({ preventScroll: true }); } catch {}

  const r = target.getBoundingClientRect();
  const cx = Math.round(r.left + r.width / 2);
  const cy = Math.round(r.top + r.height / 2);

  // Move virtual pointer to center with no buttons pressed first so the game updates its hover position
  const moveInit = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: cx, clientY: cy, screenX: cx, screenY: cy,
    button: -1, buttons: 0,
  };
  if (CAM_EVENTS !== 'mouse') {
    target.dispatchEvent(new PointerEvent('pointermove', { ...moveInit, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  }
  if (CAM_EVENTS !== 'pointer') {
    target.dispatchEvent(new MouseEvent('mousemove', moveInit));
  }
  return { r, cx, cy };
}

function camSet(action, on) {
  if (on) camOn.add(action); else camOn.delete(action);
  if (!camOn.size) { camStop(); return; }
  if (!camRaf) { camLast = performance.now(); camRaf = requestAnimationFrame(camTick); }
}

function camFire(target, kind, x, y, mx, my) {
  // kind: 'down' | 'move' | 'up'
  const base = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: Math.round(x), clientY: Math.round(y),
    screenX: Math.round(x), screenY: Math.round(y),
    button: kind === 'move' ? -1 : 1,
    buttons: kind === 'up' ? 0 : 4,
  };
  const send = (e) => {
    if (kind === 'move') {
      // movementX/Y aren't honoured as init values everywhere; force them.
      try {
        Object.defineProperty(e, 'movementX', { value: Math.round(mx) });
        Object.defineProperty(e, 'movementY', { value: Math.round(my) });
      } catch {}
    }
    target.dispatchEvent(e);
  };
  if (CAM_EVENTS !== 'mouse') {
    send(new PointerEvent('pointer' + kind, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, movementX: Math.round(mx), movementY: Math.round(my) }));
  }
  if (CAM_EVENTS !== 'pointer') {
    send(new MouseEvent('mouse' + kind, { ...base, movementX: Math.round(mx), movementY: Math.round(my) }));
  }
}

function camBegin(target) {
  const { r, cx, cy } = camCenterAndDefocus(target);
  camDrag = { target, r, x: cx, y: cy };
  camFire(target, 'down', cx, cy, 0, 0);
  dlog('camera drag start');
}

function camMove(dx, dy) {
  const d = camDrag;
  const nextX = d.x + dx;
  const nextY = d.y + dy;

  // Keep virtual drag strictly inside the middle 40% of the canvas (away from all HUD edges).
  // If it reaches the boundary, release and re-grab at exact center seamlessly.
  const minX = d.r.left + d.r.width * 0.3;
  const maxX = d.r.left + d.r.width * 0.7;
  const minY = d.r.top + d.r.height * 0.3;
  const maxY = d.r.top + d.r.height * 0.7;

  if (nextX < minX || nextX > maxX || nextY < minY || nextY > maxY) {
    const target = d.target;
    camEnd();
    camBegin(target);
    return;
  }

  d.x = nextX;
  d.y = nextY;
  camFire(d.target, 'move', d.x, d.y, dx, dy);
}

function camEnd() {
  if (!camDrag) return;
  const { target, r, x, y } = camDrag;
  camFire(target, 'up', x, y, 0, 0);
  // Park virtual pointer back at exact canvas center on release
  camCenterAndDefocus(target);
  camDrag = null;
  dlog('camera drag end');
}

function camWheel(target, deltaY) {
  const { cx, cy } = camCenterAndDefocus(target);
  target.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: cx, clientY: cy, deltaY, deltaMode: 0,
  }));
}

function camTick(t) {
  camRaf = 0;
  if (!camOn.size) { camStop(); return; }
  const dt = Math.min(t - camLast, 50) / 1000;
  camLast = t;
  const target = camCanvas();
  if (target) {
    const dx = (camOn.has('orbit_right') - camOn.has('orbit_left')) * CAM_DRAG_SPEED * dt;
    const dy = (camOn.has('tilt_down') - camOn.has('tilt_up')) * CAM_DRAG_SPEED * dt;
    if (dx || dy) { if (!camDrag) camBegin(target); camMove(dx, dy); }
    else if (camDrag) camEnd();
    const zoom = camOn.has('zoom_out') - camOn.has('zoom_in');
    if (zoom) {
      camWheelAcc += dt * 1000;
      if (camWheelAcc >= CAM_WHEEL_MS) { camWheelAcc = 0; camWheel(target, zoom * CAM_WHEEL_STEP); }
    } else camWheelAcc = CAM_WHEEL_MS; // first tick of the next zoom fires immediately
  }
  camRaf = requestAnimationFrame(camTick);
}
function camStop() {
  if (camRaf) cancelAnimationFrame(camRaf);
  camRaf = 0;
  camOn.clear();
  camEnd();
}

// One-click setup: make `m` (powerup_l / powerup_r) a modifier whose layer drives the camera.
function applyCameraPreset(m) {
  releaseAll();
  cfg.mods[m] = true;
  const r = cfg.layers[m].ride;
  const set = (n, a) => { r[n] = [{ code: 'Cam:' + a, key: 'cam' }]; };
  set('left', 'orbit_left'); set('right', 'orbit_right');
  set('up', 'tilt_up'); set('down', 'tilt_down');
  set('shift_up_r', 'zoom_in'); set('shift_dn_r', 'zoom_in');
  set('shift_up_l', 'zoom_out'); set('shift_dn_l', 'zoom_out');
  if (modInputs[m]) modInputs[m].checked = true;
  saveCfg();
  renderTabs();
  if (layer !== 'normal') INPUTS.forEach(([n]) => refresh(n));
}

terra.onCleanup(camStop);
