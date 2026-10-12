/* ---------------- ride mode: key emulation ---------------- */
const held = new Map(); // code -> {k, n}
const fire = (type, k) => window.dispatchEvent(new KeyboardEvent(type, {
  code: k.code, key: k.key, bubbles: true, cancelable: true, shiftKey: k.code.startsWith('Shift'),
}));
function press(k) { const e = held.get(k.code) || { k, n: 0 }; e.n++; held.set(k.code, e); if (e.n === 1) fire('keydown', k); }
function release(k) { const e = held.get(k.code); if (!e) return; if (--e.n <= 0) { held.delete(k.code); fire('keyup', k); } }

// ---- modifier buttons (Ride On): hold one, press another = that button's mapping from the modifier's layer ----
const heldMods = [];            // modifier buttons currently held, in press order
const usedMods = new Set();     // modifiers that were combined with another button during this hold
const activeInputs = new Map(); // input -> function that undoes what its press did (so a release can't mismatch)
const isMod = (name) => !!(cfg && cfg.mods && cfg.mods[name]);
const currentLayer = () => (heldMods.length ? heldMods[heldMods.length - 1] : null);

function releaseAll() {
  for (const { k } of held.values()) fire('keyup', k);
  held.clear();
  stopRepeat();
  heldMods.length = 0; usedMods.clear(); activeInputs.clear();
}

/* ---------------- browse mode: spatial navigation ---------------- */
const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[tabindex]:not([tabindex="-1"])';

const scope = () => document.querySelector('dialog[open],[role=dialog],[aria-modal="true"]') || document;

function visible(el) {
  if (el.disabled || el.getAttribute('aria-hidden') === 'true') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
  // Skip elements covered by something else (overlays, menus). Only testable when the centre is on screen.
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
    const top = document.elementFromPoint(cx, cy);
    // Our own settings panel doesn't count as covering the page.
    if (top && !top.closest('#btz-panel') && !(el.contains(top) || top.contains(el))) return false;
  }
  return true;
}

// Visible focusables, minus wrappers that contain another focusable (keeps the innermost control).
function candidates() {
  // The settings panel's own controls are never D-pad targets: the D-pad drives the Biketerra page.
  const list = [...scope().querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('#btz-panel') && visible(el));
  const set = new Set(list), drop = new Set();
  for (const el of list) for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) drop.add(p);
  return list.filter((el) => !drop.has(el));
}

const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
let anchor = null; // last element we focused (doc coordinates), survives the element being re-rendered
let back = null;   // lets "move back the way you came" return to the exact previous element

// The selection ring is a separate overlay, so it is never clipped by a parent's overflow:hidden
// and can follow the element's own corner radius.
const ring = document.createElement('div');
ring.id = 'btz-ring';
document.documentElement.appendChild(ring);
let focused = null, ringRaf = 0;

// Cards often use a "stretched link": a small title link whose ::after covers the whole card.
// In that case ring the card (nearest positioned ancestor), not just the title text.
function ringTarget(el) {
  const r = el.getBoundingClientRect();
  for (const pseudo of ['::after', '::before']) {
    const cs = getComputedStyle(el, pseudo);
    if (cs.content === 'none' || cs.content === 'normal' || cs.position !== 'absolute') continue;
    if (!(parseFloat(cs.width) > r.width * 1.5 || parseFloat(cs.height) > r.height * 1.5)) continue;
    let p = el.parentElement;
    while (p && getComputedStyle(p).position === 'static') p = p.parentElement;
    if (p && p !== document.body && p !== document.documentElement) return p;
  }
  return el;
}
function placeRing() {
  ringRaf = 0;
  if (!focused || !focused.isConnected) { ring.style.display = 'none'; return; }
  const t = ringTarget(focused), r = t.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { ring.style.display = 'none'; return; }
  const gap = 4, radius = (parseFloat(getComputedStyle(t).borderTopLeftRadius) || 0) + gap;
  Object.assign(ring.style, {
    display: 'block',
    left: r.left - gap - 3 + 'px', top: r.top - gap - 3 + 'px',
    width: r.width + 2 * (gap + 3) + 'px', height: r.height + 2 * (gap + 3) + 'px',
    borderRadius: Math.max(radius, 10) + 'px',
  });
}
const scheduleRing = () => { if (!ringRaf) ringRaf = requestAnimationFrame(placeRing); };
addEventListener('scroll', scheduleRing, { capture: true, passive: true });
addEventListener('resize', scheduleRing);
const ringTimer = setInterval(() => { if (focused) scheduleRing(); }, 250);

function focusEl(el, fast) {
  if (focused) focused.classList.remove('btz-focus');
  el.classList.add('btz-focus');
  focused = el;
  el.addEventListener('blur', () => {
    el.classList.remove('btz-focus');
    if (focused === el) { focused = null; scheduleRing(); }
  }, { once: true });
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();
  anchor = { left: r.left + scrollX, right: r.right + scrollX, top: r.top + scrollY, bottom: r.bottom + scrollY };
  if (r.top < 80 || r.bottom > innerHeight - 80) el.scrollIntoView({ block: 'center', behavior: fast ? 'auto' : 'smooth' });
  scheduleRing();
}
function go(el, from, dir, fast) {
  back = from ? { el: from, to: el, dir: OPP[dir] } : null;
  focusEl(el, fast);
}

// Lower is better; null = not in that direction.
// Facing-edge gap + heavy penalty for not lining up + a small centre-offset tie-breaker.
function score(a, r, dir, relaxed) {
  const vertical = dir === 'up' || dir === 'down';
  let gap;
  if (dir === 'down') gap = r.top - a.bottom;
  else if (dir === 'up') gap = a.top - r.bottom;
  else if (dir === 'right') gap = r.left - a.right;
  else gap = a.left - r.right;
  if (relaxed) {
    // Overlapping boxes: accept if the candidate's centre is clearly past the origin's centre.
    const ca = vertical ? (a.top + a.bottom) / 2 : (a.left + a.right) / 2;
    const cr = vertical ? (r.top + r.bottom) / 2 : (r.left + r.right) / 2;
    const d = dir === 'down' || dir === 'right' ? cr - ca : ca - cr;
    if (d < 4) return null;
  } else if (gap < -2) return null;
  const aLo = vertical ? a.left : a.top, aHi = vertical ? a.right : a.bottom;
  const rLo = vertical ? r.left : r.top, rHi = vertical ? r.right : r.bottom;
  const overlap = Math.min(aHi, rHi) - Math.max(aLo, rLo);
  const misalign = overlap > 0 ? 0 : -overlap;
  const center = Math.abs((rLo + rHi) / 2 - (aLo + aHi) / 2);
  return Math.max(gap, 0) + 4 * misalign + 0.3 * center;
}

function move(dir, fast) {
  const list = candidates();
  if (!list.length) return;
  const cur = list.includes(document.activeElement) ? document.activeElement : null;
  let a = cur ? cur.getBoundingClientRect() : null;
  if (!cur && anchor && document.activeElement === document.body) {
    // Our element vanished (page re-rendered): continue from where it was.
    a = { left: anchor.left - scrollX, right: anchor.right - scrollX, top: anchor.top - scrollY, bottom: anchor.bottom - scrollY };
  }
  if (!a) {
    const def = findDefault();
    if (def && list.includes(def)) return go(def, null, dir, fast);
    const inView = list.filter((e) => { const r = e.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    const pool = inView.length ? inView : list;
    pool.sort((x, y) => { const rx = x.getBoundingClientRect(), ry = y.getBoundingClientRect(); return rx.top - ry.top || rx.left - ry.left; });
    return go(pool[0], null, dir, fast);
  }
  // Moving back the way we came returns to the exact element we left.
  if (cur && back && back.to === cur && back.dir === dir && list.includes(back.el)) return go(back.el, cur, dir, fast);

  let best = null, bestScore = Infinity;
  for (const relaxed of [false, true]) {
    for (const el of list) {
      if (el === cur || (cur && (cur.contains(el) || el.contains(cur)))) continue;
      const sc = score(a, el.getBoundingClientRect(), dir, relaxed);
      if (sc !== null && sc < bestScore) { bestScore = sc; best = el; }
    }
    if (best) break; // only fall back to the relaxed rule when nothing qualifies strictly
  }
  if (best) return go(best, cur, dir, fast);
  if (dir === 'down') scrollBy({ top: innerHeight * 0.5, behavior: fast ? 'auto' : 'smooth' });
  else if (dir === 'up') scrollBy({ top: -innerHeight * 0.5, behavior: fast ? 'auto' : 'smooth' });
}

// Event and route pages: the selection should start on the "Ride now" (or "Sign up") button.
const DEFAULT_PAGE = /^\/(events|routes)\/\d+(\/|$)/;
// Lighter than visible(): this button is known, so don't reject it for being covered or still fading in.
const shown = (el) => {
  const r = el.getBoundingClientRect();
  return r.width >= 8 && r.height >= 8 && (!el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true }));
};
function findDefault() {
  if (!DEFAULT_PAGE.test(location.pathname)) return null;
  const hits = [...document.querySelectorAll('button, a')].filter((b) => /^\s*(ride now|sign up)\s*$/i.test(b.textContent) && shown(b));
  return hits.find((b) => b.classList.contains('btn-primary')) || hits[0] || null;
}
let autoTimer = 0;
// On landing, select the button for you (only if you haven't already moved the selection).
// The page may render it late, so poll for up to 30 seconds.
function startAutoSelect() {
  clearInterval(autoTimer);
  if (!DEFAULT_PAGE.test(location.pathname)) return;
  let tries = 0;
  dlog('autoselect: looking for the Ride now / Sign up button on', location.pathname);
  autoTimer = setInterval(() => {
    tries++;
    if (tries > 100 || mode !== 'browse' || (focused && focused.isConnected)) { clearInterval(autoTimer); return; }
    const btn = findDefault();
    if (btn) { clearInterval(autoTimer); dlog('autoselect: selected Ride now'); focusEl(btn, true); }
  }, 300);
}

function select() {
  let el = document.activeElement;
  if ((!el || el === document.body) && focused && focused.isConnected) el = focused;
  if (!el || el === document.body) return;
  if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && !/button|submit|checkbox|radio/.test(el.type)) return;
  el.click();
}
const page = (f) => () => scrollBy({ top: innerHeight * 0.8 * f, behavior: 'smooth' });
const ACTIONS = {
  nav_up: (f) => move('up', f), nav_down: (f) => move('down', f), nav_left: (f) => move('left', f), nav_right: (f) => move('right', f),
  select, back: () => history.back(),
  page_up: page(-1), page_down: page(1),
  top: () => scrollTo({ top: 0, behavior: 'smooth' }),
};
const isNav = (a) => typeof a === 'string' && a.startsWith('nav_');
let rep = null;
function stopRepeat() { if (rep) { clearTimeout(rep.t1); clearInterval(rep.t2); rep = null; } }

/* ---------------- routing ---------------- */
const curMode = () => location.pathname.startsWith(RIDE_PATH_PREFIX) ? 'ride' : 'browse';
let mode = curMode();

// The mapping that applies to `name` right now: the held modifier's layer if it defines one, else the normal one.
function rideKeys(name, layerId) {
  const l = layerId && cfg.layers[layerId] && cfg.layers[layerId].ride[name];
  return l || cfg.ride[name] || [];
}
function browseAction(name, layerId) {
  const l = layerId && cfg.layers[layerId] ? cfg.layers[layerId].browse[name] : undefined;
  return l !== undefined ? l : cfg.browse[name];
}
// A modifier pressed and released on its own = a tap of its own (normal) mapping.
function tapOwn(name) {
  if (mode === 'ride') {
    const keys = cfg.ride[name] || [];
    keys.forEach(press);
    setTimeout(() => keys.forEach(release), 60);
  } else {
    const fn = ACTIONS[cfg.browse[name]];
    if (fn) fn();
  }
}

// Button edge (already de-duplicated by ride.js) -> ride keys or browse action.
function dispatchInput(name, edge) {
  if (!cfg) return;
  if (mode === 'ride' && !rideEnabled) return; // ride keys are off: Biketerra handles the controller itself

  if (edge === 'up') { // undo exactly what this button's press did, whatever layer was active then
    const undo = activeInputs.get(name);
    activeInputs.delete(name);
    if (undo) undo();
    return;
  }

  if (isMod(name)) { // a modifier does nothing by itself on press
    heldMods.push(name);
    activeInputs.set(name, () => {
      const i = heldMods.indexOf(name);
      if (i >= 0) heldMods.splice(i, 1);
      if (!usedMods.delete(name)) tapOwn(name); // released without combining it with anything = a tap
    });
    return;
  }

  const layerId = currentLayer(); // the most recently pressed modifier wins if two are held
  heldMods.forEach((m) => usedMods.add(m));
  if (mode === 'ride') {
    const keys = rideKeys(name, layerId);
    keys.forEach(press);
    activeInputs.set(name, () => keys.forEach(release));
  } else {
    const act = browseAction(name, layerId), fn = ACTIONS[act];
    if (!fn) return;
    fn();
    if (isNav(act)) { stopRepeat(); rep = { t1: setTimeout(() => { rep.t2 = setInterval(() => fn(true), 130); }, 380) }; }
    activeInputs.set(name, () => { if (isNav(act)) stopRepeat(); });
  }
}

let lastPath = location.pathname;
const modeTimer = setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    if (focused) focused.classList.remove('btz-focus');
    focused = null; anchor = null; back = null; scheduleRing();
    startAutoSelect();
  }
  const m = curMode();
  if (m !== mode) { releaseAll(); mode = m; applyShare(); updateStatus(); dlog('mode ->', m); }
}, 250);
addEventListener('blur', releaseAll);

terra.onCleanup(() => {
  stopped = true;
  releaseAll();
  clearInterval(ringTimer); clearInterval(modeTimer); clearInterval(autoTimer);
  cancelAnimationFrame(ringRaf);
  removeEventListener('scroll', scheduleRing, { capture: true });
  removeEventListener('resize', scheduleRing);
  removeEventListener('blur', releaseAll);
  if (focused) focused.classList.remove('btz-focus');
  ring.remove();
});
