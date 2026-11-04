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
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
    const top = document.elementFromPoint(cx, cy);
    if (top && !top.closest('#btz-panel') && !top.closest('#btz-console-hud') && !(el.contains(top) || top.contains(el))) return false;
  }
  return true;
}

// Filter out elements that act as annoying D-pad traps on a bike controller
function shouldSkipForController(el) {
  if (el.dataset.btzSkip === '1') return true;

  // 1. Skip text inputs (search bars, page number inputs) since there's no keyboard on the bike
  if (el.tagName === 'INPUT' && /^(text|search|number|email|password|tel|url)$/i.test(el.type || 'text')) {
    return true;
  }

  // 2. Skip Leaflet / Maplibre zoom controls & attribution links on Route pages
  if (
    el.closest('.leaflet-control-container, .maplibregl-ctrl, .mapboxgl-ctrl') ||
    /openstreetmap|mapbox|leaflet/i.test(el.textContent || '')
  ) {
    return true;
  }

  // 3. Skip secondary "VIEW SERIES" pills inside event cards so each event is 1 clean stop
  const txt = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (txt === 'view series') return true;

  // 4. Skip the 4 mini chart toggle pills on Dashboard (Distance / Climbing / Time / Rides)
  if ((location.pathname === '/dashboard' || location.pathname === '/dashboard/') &&
    el.tagName === 'BUTTON' &&
    ['distance', 'climbing', 'time', 'rides'].includes(txt)) {
    return true;
    }

    // 5. On Event Detail pages (/events/:id), skip individual rider profile links in the leaderboard table
    if (/^\/events\/\d+/.test(location.pathname)) {
      const href = el.getAttribute('href') || '';
      if (href.includes('/users/') || href.includes('/profile') || href.includes('/athletes/') || el.closest('table, .riders-table')) {
        return true;
      }
    }

    // 6. Skip footer copyright / privacy / terms links
    if (el.closest('footer') || ['privacy', 'terms', 'help center'].includes(txt)) {
      return true;
    }

    return false;
}

// Visible focusables, minus wrappers that contain another focusable (keeps the innermost control).
function candidates() {
  const list = [...scope().querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.closest('#btz-panel') && !shouldSkipForController(el) && visible(el)
  );
  const set = new Set(list), drop = new Set();
  for (const el of list) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (set.has(p)) drop.add(p);
    }
  }
  return list.filter((el) => !drop.has(el));
}

const OPP = { up: 'down', down: 'up', left: 'right', right: 'left' };
let anchor = null;
let back = null;

const ring = document.createElement('div');
ring.id = 'btz-ring';
document.documentElement.appendChild(ring);
let focused = null, ringRaf = 0;

function ringTarget(el) {
  const dashRow = el.closest('.btz-dash-event-row');
  if (dashRow) return dashRow;
  const evCard = el.closest('.btz-events-page-card, .club-tile');
  if (evCard) return evCard;
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
                borderRadius: Math.max(radius, 12) + 'px',
  });
}
const scheduleRing = () => { if (!ringRaf) ringRaf = requestAnimationFrame(placeRing); };
addEventListener('scroll', scheduleRing, { capture: true, passive: true });
addEventListener('resize', scheduleRing);
const ringTimer = setInterval(() => { if (focused) scheduleRing(); }, 250);

function focusEl(el, fast) {
  if (focused) {
    focused.classList.remove('btz-focus');
    ringTarget(focused)?.classList.remove('btz-card-focused');
  }
  el.classList.add('btz-focus');
  ringTarget(el)?.classList.add('btz-card-focused');
  focused = el;
  el.addEventListener('blur', () => {
    el.classList.remove('btz-focus');
    ringTarget(el)?.classList.remove('btz-card-focused');
    if (focused === el) { focused = null; scheduleRing(); }
  }, { once: true });
  el.focus({ preventScroll: true });
  const r = el.getBoundingClientRect();
  anchor = { left: r.left + scrollX, right: r.right + scrollX, top: r.top + scrollY, bottom: r.bottom + scrollY };
  if (r.top < 90 || r.bottom > innerHeight - 90) el.scrollIntoView({ block: 'center', behavior: fast ? 'auto' : 'smooth' });
  scheduleRing();
  if (typeof scheduleConsoleUi === 'function') scheduleConsoleUi();
}
function go(el, from, dir, fast) {
  back = from ? { el: from, to: el, dir: OPP[dir] } : null;
  focusEl(el, fast);
}

function score(a, r, dir, relaxed) {
  const vertical = dir === 'up' || dir === 'down';
  let gap;
  if (dir === 'down') gap = r.top - a.bottom;
  else if (dir === 'up') gap = a.top - r.bottom;
  else if (dir === 'right') gap = r.left - a.right;
  else gap = a.left - r.right;
  if (relaxed) {
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
  const cur = list.includes(document.activeElement) ? document.activeElement : (focused && list.includes(focused) ? focused : null);
  let a = cur ? ringTarget(cur).getBoundingClientRect() : null;
  if (!cur && anchor && document.activeElement === document.body) {
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
  if (cur && back && back.to === cur && back.dir === dir && list.includes(back.el)) return go(back.el, cur, dir, fast);

  let best = null, bestScore = Infinity;
  for (const relaxed of [false, true]) {
    for (const el of list) {
      if (el === cur || (cur && (cur.contains(el) || el.contains(cur)))) continue;
      const sc = score(a, ringTarget(el).getBoundingClientRect(), dir, relaxed);
      if (sc !== null && sc < bestScore) { bestScore = sc; best = el; }
    }
    if (best) break;
  }
  if (best) return go(best, cur, dir, fast);
  if (dir === 'down') scrollBy({ top: innerHeight * 0.5, behavior: fast ? 'auto' : 'smooth' });
  else if (dir === 'up') scrollBy({ top: -innerHeight * 0.5, behavior: fast ? 'auto' : 'smooth' });
}

const shown = (el) => {
  const r = el.getBoundingClientRect();
  return r.width >= 8 && r.height >= 8 && (!el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true }));
};

function findDefault() {
  const path = location.pathname;

  // 1. Route / Event detail page: focus "Ride now" / "Sign up" / "Starting pen"
  if (/\/(events|routes)\/.+/.test(path)) {
    const hits = [...document.querySelectorAll('button, a')].filter((b) => {
      const text = b.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      const href = b.getAttribute('href') || '';
      return (
        text.startsWith('ride now') ||
        text === 'sign up' ||
        text.includes('starting pen') ||
        text.includes('enter pen') ||
        href.includes('/ride?event=')
      ) && shown(b);
    });
    return hits.find((b) => b.classList.contains('btn-primary')) || hits[0] || null;
  }

  // 2. Dashboard: focus the first individual upcoming event row (or Quick Start tile)
  if (path === '/dashboard' || path === '/dashboard/') {
    const firstRowTarget = [...document.querySelectorAll('.btz-dash-event-target')].find(shown);
    if (firstRowTarget) return firstRowTarget;
    const qTile = document.querySelector('.btz-qtile-primary');
    if (qTile && shown(qTile)) return qTile;
  }

  // 3. Routes list (/routes): focus first route card
  if (path === '/routes' || path === '/routes/') {
    const firstRoute = [...document.querySelectorAll('a[href*="/routes/"]')].find(
      (a) => shown(a) && !a.closest('nav, header')
    );
    if (firstRoute) return firstRoute;
  }

  // 4. Events list (/events): focus first event row
  if (path === '/events' || path === '/events/') {
    const firstEv = [...document.querySelectorAll('a[href*="/events/"]')].find(
      (a) => shown(a) && !a.closest('nav, header') && a.textContent.trim().toLowerCase() !== 'view series'
    );
    if (firstEv) return firstEv;
  }
  // 5. Clubs list (/clubs): focus first club card title link
  if (path === '/clubs' || path === '/clubs/') {
    const firstClub = [...document.querySelectorAll('.club-tile .tile-title a, .club-tile a[href*="/clubs/"]')].find(shown);
    if (firstClub) return firstClub;
  }
  return null;
}

let autoTimer = 0;
function startAutoSelect() {
  clearInterval(autoTimer);
  let tries = 0;
  autoTimer = setInterval(() => {
    tries++;
    if (tries > 60 || mode !== 'browse' || (focused && focused.isConnected)) { clearInterval(autoTimer); return; }
    const btn = findDefault();
    if (btn) { clearInterval(autoTimer); focusEl(btn, true); }
  }, 200);
}

function select() {
  let el = document.activeElement;
  if ((!el || el === document.body) && focused && focused.isConnected) el = focused;
  if (!el || el === document.body) return;
  if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && !/button|submit|checkbox|radio/.test(el.type)) return;
  el.click();
}

// Cycle top-level navigation tabs (Dashboard -> Routes -> Events -> Clubs -> Challenges)
function cycleTopNav(step = 1) {
  const order = ['/dashboard', '/routes', '/events', '/clubs', '/challenges'];
  const curIdx = order.findIndex((p) => location.pathname.startsWith(p));
  const nextPath = order[((curIdx >= 0 ? curIdx : 0) + step + order.length) % order.length];
  const navLink = [...document.querySelectorAll('.nav-links a.nav-link, a[href]')].find(
    (a) => a.getAttribute('href') === nextPath
  );
  if (navLink) navLink.click();
  else location.href = nextPath;
}

// Smart page up/down: on paginated lists (/routes), if at bottom/top of page, click Next/Prev page button!
const page = (f) => () => {
  if (location.pathname === '/routes' || location.pathname === '/routes/') {
    const atBottom = f > 0 && (window.innerHeight + window.scrollY >= document.body.scrollHeight - 80);
    const atTop = f < 0 && window.scrollY <= 40;
    if (atBottom || atTop) {
      const pagBtns = [...document.querySelectorAll('button, a')].filter((b) => {
        const t = b.textContent.trim();
        return f > 0 ? (t === '→' || t === '->' || /next/i.test(t)) : (t === '←' || t === '<-' || /prev/i.test(t));
      });
      const targetBtn = pagBtns[pagBtns.length - 1];
      if (targetBtn && !targetBtn.disabled) {
        targetBtn.click();
        setTimeout(() => { scrollTo({ top: 0, behavior: 'smooth' }); startAutoSelect(); }, 250);
        return;
      }
    }
  }
  scrollBy({ top: innerHeight * 0.75 * f, behavior: 'smooth' });
};

const ACTIONS = {
  nav_up: (f) => move('up', f),
  nav_down: (f) => move('down', f),
  nav_left: (f) => move('left', f),
  nav_right: (f) => move('right', f),
  select,
  back: () => history.back(),
  page_up: page(-1),
  page_down: page(1),
  top: () => {
    if (window.scrollY > 100) scrollTo({ top: 0, behavior: 'smooth' });
    else cycleTopNav(1);
  },
};
const isNav = (a) => typeof a === 'string' && a.startsWith('nav_');
let rep = null;
function stopRepeat() { if (rep) { clearTimeout(rep.t1); clearInterval(rep.t2); rep = null; } }

/* ---------------- routing ---------------- */
const curMode = () => location.pathname.startsWith(RIDE_PATH_PREFIX) ? 'ride' : 'browse';
let mode = curMode();

function rideKeys(name, layerId) {
  const l = layerId && cfg.layers[layerId] && cfg.layers[layerId].ride[name];
  return l || cfg.ride[name] || [];
}
function browseAction(name, layerId) {
  const l = layerId && cfg.layers[layerId] ? cfg.layers[layerId].browse[name] : undefined;
  if (l !== undefined) return l;
  // Default Z button in browse mode to cycle top nav tabs if unbound
  if (name === 'z' && (!cfg.browse.z || cfg.browse.z === 'none')) return 'top';
  return cfg.browse[name];
}
function tapOwn(name) {
  if (mode === 'ride') {
    const keys = cfg.ride[name] || [];
    keys.forEach(press);
    setTimeout(() => keys.forEach(release), 60);
  } else {
    const fn = ACTIONS[browseAction(name, null)];
    if (fn) fn();
  }
}

function dispatchInput(name, edge) {
  if (!cfg) return;
  if (mode === 'ride' && !rideEnabled) return;

  if (edge === 'up') {
    const undo = activeInputs.get(name);
    activeInputs.delete(name);
    if (undo) undo();
    return;
  }

  if (isMod(name)) {
    heldMods.push(name);
    activeInputs.set(name, () => {
      const i = heldMods.indexOf(name);
      if (i >= 0) heldMods.splice(i, 1);
      if (!usedMods.delete(name)) tapOwn(name);
    });
      return;
  }

  const layerId = currentLayer();
  heldMods.forEach((m) => usedMods.add(m));
  if (mode === 'ride') {
    const keys = rideKeys(name, layerId);
    keys.forEach(press);
    activeInputs.set(name, () => keys.forEach(release));
  } else {
    // Allow Z button in browse mode to cycle main tabs directly
    if (name === 'z' && (!cfg.browse.z || cfg.browse.z === 'none')) {
      cycleTopNav(1);
      return;
    }
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
    if (focused) {
      focused.classList.remove('btz-focus');
      ringTarget(focused)?.classList.remove('btz-card-focused');
    }
    focused = null; anchor = null; back = null; scheduleRing();
    startAutoSelect();
    if (typeof scheduleConsoleUi === 'function') scheduleConsoleUi();
  }
  const m = curMode();
  if (m !== mode) { releaseAll(); mode = m; applyShare(); updateStatus(); dlog('mode ->', m); }
}, 200);
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
