/* route-sign — one billboard sign anchored at a point along the active route.
 *
 * Body runs as: async function (terra) { ... }
 *
 * Data source
 *   window.btApp (the GameManager) is exposed by the app (Terra's CDP auto-
 *   breakpoint on this host).  We install a per-frame feature with
 *         const remove = btApp.addFeature((scope, env) => ({ frame(frameState){} }));
 *
 *   The route's world-space polyline comes from the rider controller:
 *         rc    = btApp.riderController
 *         ego   = rc.ego || rc.focalRider
 *         ego.sim.prevPathNode            — a path node; its .pathNode.list is the
 *                                           full route as an array of nodes, each
 *                                           with .p = {x, y, z} (world metres, +Y up)
 *                                           and .n = {x, z} (path normal = lateral).
 *
 *   Anchor = node at (whereAlongRoute × routeLength)
 *            + (pathNormal × side)
 *            + (up        × height)
 *
 *   Everything is in the engine's own world coordinates (metres, +Y up), so the
 *   placement is exact — no GPS, no camera-relative math.  We walk the polyline
 *   by accumulated 3D chord distance (direction-independent, so it works whether
 *   the node array runs start→finish or reverse), binary-search the target
 *   distance, lerp the point, and offset laterally by the path normal.
 *
 *   Each frame we project that single world point to screen space with the same
 *   math nameplates uses (frameState.camera.viewProj minus the floating-origin
 *   frameState.origin), and position a DOM billboard (translate3d + scale with
 *   clip-W distance).
 *
 *   One sign per ride (the settings schema is a single block — the UI constraint).
 */
'use strict';
(async () => {
  const log = (...a) => { try { terra.log(...a); } catch (e) { console.log('[route-sign]', ...a); } };

  /* ── tunables (screen-space only; everything world-space is a setting) ───── */
  const HORIZON_PAD  = 1.15;  // hide the sign beyond this fraction of the NDC half-extent
  const NEAR_W       = 0.12;  // hide if clip-space W is below this (behind the near plane)
  const SCALE_NEAR_W = 8;     // at clip-W = 8 the sign is at size 1.0, shrinking with distance
  const SCALE_MIN    = 0.35;  // never smaller than this
  const SCALE_MAX    = 1.6;   // never larger than this

  /* ── settings ─────────────────────────────────────────────────────────────── */
  // `all()` returns stored-over-default; values mirror manifest.json.
  const DEFAULTS = {
    text: 'Terra',
    whereAlongRoute: 0.5,
    side: 4,
    height: 2,
    showKm: true,
    fontSize: 16,
    plateColor: '#0d3b2e',
    textColor: '#f3f0e7',
    bgOpacity: 92,
    maxDist: 120,
  };
  let S = Object.assign({}, DEFAULTS);
  try { S = Object.assign({}, DEFAULTS, await terra.settings.all()); }
  catch (e) { log('could not read settings, using defaults: ' + e); }

  const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(+v) ? +v : 0));
  const num     = (v, d) => (Number.isFinite(+v) ? +v : d);
  const px      = v => Math.min(64, Math.max(8, num(v, 16))) + 'px';

  // '#rgb' / '#rrggbb' + percent opacity -> rgba()
  const hexA = (hex, pct) => {
    let h = String(hex || '#000000').replace('#', '').trim();
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    const a = Math.min(100, Math.max(0, num(pct, 100))) / 100;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a.toFixed(3) + ')';
  };

  let appRef      = null;   // btApp, once acquired
  let routeCache  = null;   // { list, pts, norms, dist, totalLen, n, declaredTotal }
  let anchorWorld = null;   // { x, y, z } world metres
  let anchorKey   = '';     // settings fingerprint; a change forces recompute
  let signEl      = null;   // the persistent .rs billboard
  let lastText    = '';
  let cleaned     = false;
  let cleanRef    = null;

  /* ── overlay + one sign ──────────────────────────────────────────────────── */
  const ov = document.createElement('div');
  ov.className = 'routesign-ov';
  ov.style.fontSize = px(S.fontSize);
  document.body.appendChild(ov);

  const ensureSign = () => {
    if (signEl) return signEl;
    const el = document.createElement('div');
    el.className = 'rs';
    el.style.display = 'none';
    ov.appendChild(el);
    signEl = el;
    return el;
  };

  const paintSign = (el) => {
    const bg = hexA(S.plateColor, S.bgOpacity);
    const key = bg + '|' + (S.textColor || '') + '|' + (S.plateColor || '');
    if (el._rsStyle !== key) {
      el.style.background = bg;
      el.style.color      = S.textColor || '#ffffff';
      el.style.borderColor = 'rgba(255,255,255,0.28)';
      el.style.setProperty('--rs-bg', bg);   // used by the .rs::after pointer triangle
      el._rsStyle = key;
    }
  };

  // Declared route length (km) when the engine gives us one, else our own chord.
  const routeKms = () => {
    if (!routeCache) return NaN;
    const m = routeCache.declaredTotal > 0 ? routeCache.declaredTotal : routeCache.totalLen;
    return m / 1000;
  };

  const signText = () => {
    const base = String(S.text == null ? '' : S.text).trim();
    if (S.showKm) {
      const km = clamp01(S.whereAlongRoute) * routeKms();
      if (Number.isFinite(km)) {
        const k = km < 100 ? km.toFixed(1) : String(Math.round(km));
        return (base ? base + '  ' : '') + k + ' km';
      }
    }
    return base || '—';
  };

  const refreshText = (el) => {
    const t = signText();
    if (el.textContent !== t) { el.textContent = t; lastText = t; }
  };

  const applyGlobal = () => { if (ov) ov.style.fontSize = px(S.fontSize); };
  const applyS = (v) => {
    S = Object.assign({}, DEFAULTS, v);
    applyGlobal();
    anchorKey = '';            // force the anchor to be recomputed next frame
    if (signEl) { paintSign(signEl); refreshText(signEl); }
  };

  try {
    // Re-read the whole block: the UI emit is synchronous but our read is async.
    terra.settings.onChange(() => {
      terra.settings.all().then(applyS).catch(e => log('settings refresh failed: ' + e));
    });
  } catch (e) { /* older Terra core without onChange */ }

  /* ── live preview in the cog menu (shows the sign with the current colors/text) ── */
  function paintPreview(slot) {
    if (!slot) return;                       // preview is hidden — static sample, nothing to tear down
    const el = document.createElement('div');
    el.className = 'rs rs-sample';
    el.style.display = 'inline-block';
    const draw = () => {
      const bg = hexA(S.plateColor, S.bgOpacity);
      el.style.fontSize = px(S.fontSize);
      el.style.background = bg;
      el.style.color = S.textColor || '#ffffff';
      el.style.setProperty('--rs-bg', bg);   // used by the .rs::after pointer triangle
      el.textContent = signText();
    };
    draw();
    slot.appendChild(el);
    // A save may have just landed — repaint once with the server's authoritative value.
    try { terra.settings.all().then(applyS).then(draw).catch(() => {}); } catch (e) {}
  }
  try { terra.settings.preview(paintPreview); } catch (e) { /* older Terra core */ }

  /* ── ⚙ chip — ride pages have no header, so a small button (bottom-left, so
        it never collides with nameplates' bottom-right chip) ─────────────────── */
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'rs-chip';
  chip.title = 'Route sign settings (waiting for the route…)';
  chip.textContent = '🪧';
  chip.addEventListener('click', (e) => { e.preventDefault(); try { terra.settings.open(); } catch (e2) {} });
  document.body.appendChild(chip);

  /* ── route resolution (robust, geometry-based, direction-independent) ─────── */
  function resolveRoute(rc) {
    if (!rc) return null;
    const ego = rc.ego || rc.focalRider;
    if (!ego || !ego.sim) return null;
    const prev = ego.sim.prevPathNode;
    if (!prev) return null;

    // Collect candidate node arrays and use the largest (most likely the full route).
    let list = null;
    if (prev.pathNode && Array.isArray(prev.pathNode.list) && prev.pathNode.list.length > 2) {
      list = prev.pathNode.list;
    }
    if (Array.isArray(prev.list) && prev.list.length > 2 && (!list || prev.list.length > list.length)) {
      list = prev.list;
    }
    if (!list || list.length < 2) return null;
    const n = list.length;

    // Per-node world position (+Y up) and lateral normal. Nodes may wrap a pathNode.
    const pts = new Array(n), norms = new Array(n);
    for (let i = 0; i < n; i++) {
      const node = list[i];
      if (!node) continue;
      const wrap = node.pathNode || node;
      const p  = node.p  || (wrap && wrap.p);
      const nm = node.n  || (wrap && wrap.n);
      if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) pts[i] = p;
      if (nm && Number.isFinite(nm.x)) norms[i] = nm;
    }
    if (!pts[0] || !pts[n - 1]) return null;

    // Cumulative 3D chord distance along the polyline (independent of node order).
    const dist = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      if (pts[i] && pts[i - 1]) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = (pts[i].y || 0) - (pts[i - 1].y || 0);
        const dz = pts[i].z - pts[i - 1].z;
        dist[i] = dist[i - 1] + Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
    }
    const totalLen = dist[n - 1];
    if (!(totalLen > 0)) return null;

    // Authoritative route length (for the km label) from the engine if available.
    const declaredTotal = Math.max(
      Number(prev.distance) || 0,
      (prev.pathNode && (Number(prev.pathNode.distance) || (prev.pathNode.path && Number(prev.pathNode.path.distance)) || 0)) || 0,
      (prev.path && Number(prev.path.distance)) || 0,
      0
    );

    return { list, pts, norms, dist, totalLen, n, declaredTotal };
  }

  // World point + lateral normal at a cumulative chord distance.
  function pointAt(route, target) {
    const { pts, norms, dist, n } = route;
    target = Math.min(Math.max(0, target), route.totalLen);
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] < target) lo = mid + 1; else hi = mid;
    }
    const i1 = lo, i0 = Math.max(0, lo - 1);
    const a = pts[i0] || pts[i1];
    const b = pts[i1] || pts[i0];
    const d0 = dist[i0], d1 = dist[i1];
    const t = (d1 > d0) ? (target - d0) / (d1 - d0) : 0;
    // Prefer the nearer node's normal.
    const nm = ((Math.abs(d0 - target) <= Math.abs(d1 - target) && norms[i0])
      ? norms[i0] : (norms[i1] || norms[i0]) || { x: 0, z: 0 });
    return {
      p: {
        x: a.x + (b.x - a.x) * t,
        y: (a.y || 0) + ((b.y || 0) - (a.y || 0)) * t,
        z: a.z + (b.z - a.z) * t,
      },
      n: { x: nm.x || 0, z: nm.z || 0 },
    };
  }

  function ensureAnchor() {
    if (routeCache) return true;
    routeCache = resolveRoute(appRef && appRef.riderController) || null;
    if (routeCache) chip.title = 'Route sign settings · route ' + Math.round(routeCache.declaredTotal / 1000) + ' km resolved';
    log('route resolved:', routeCache
      ? routeCache.n + ' nodes, chord ' + Math.round(routeCache.totalLen) + ' m, declared ' + Math.round(routeCache.declaredTotal) + ' m'
      : '(still waiting for the route to load)');
    return !!routeCache;
  }

  function currentAnchorWorld() {
    if (!routeCache) return null;
    const key = [S.whereAlongRoute, S.side, S.height, routeCache.totalLen].join('|');
    if (anchorKey !== key) {
      const target = clamp01(S.whereAlongRoute) * routeCache.totalLen;
      const { p, n } = pointAt(routeCache, target);
      anchorWorld = {
        x: p.x + n.x * (num(S.side, 0)),
        y: (p.y || 0) + num(S.height, 0),
        z: p.z + n.z * (num(S.side, 0)),
      };
      anchorKey = key;
    }
    return anchorWorld;
  }

  /* ── render loop (installed via addFeature) ──────────────────────────────── */
  function makeFeature(app) {
    return {
      frame(frameState) {
        if (cleaned) return;
        const cam = frameState && frameState.camera;
        const vp  = cam && cam.viewProj;
        if (!vp) return;

        if (!ensureAnchor()) return;           // route still loading — retry next frame
        const aw = currentAnchorWorld();
        if (!aw) return;

        const [ox, oz] = (frameState.origin && frameState.origin.length >= 2)
          ? [frameState.origin[0], frameState.origin[1]] : [0, 0];
        const W = window.innerWidth  || document.documentElement.clientWidth;
        const H = window.innerHeight || document.documentElement.clientHeight;

        /* ── world → origin-relative → clip → NDC (same as nameplates) ────────── */
        const rx = aw.x - ox;
        const ry = aw.y;
        const rz = aw.z - oz;
        const w  = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];

        const el = ensureSign();
        const hide = () => { if (el.style.display !== 'none') el.style.display = 'none'; };

        if (w <= NEAR_W || !Number.isFinite(w)) { hide(); return; }
        const iw = 1 / w;
        const nx = (vp[0] * rx + vp[4] * ry + vp[8]  * rz + vp[12]) * iw;
        const ny = (vp[1] * rx + vp[5] * ry + vp[9]  * rz + vp[13]) * iw;
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) { hide(); return; }
        if (Math.abs(nx) > HORIZON_PAD || Math.abs(ny) > HORIZON_PAD) { hide(); return; }

        /* ── optional range gate ─────────────────────────────────────────────── */
        const maxD = num(S.maxDist, 0);        // 0 = unlimited
        if (maxD > 0 && cam && cam.worldPosition) {
          const dx = aw.x - cam.worldPosition.x;
          const dy = aw.y - (cam.worldPosition.y || 0);
          const dz = aw.z - cam.worldPosition.z;
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) > maxD) { hide(); return; }
        }

        /* ── position (bottom-centre at the anchor) + distance scale ──────────── */
        const sx = (nx * 0.5 + 0.5) * W;
        const sy = (1 - (ny * 0.5 + 0.5)) * H;
        const sc = Math.max(SCALE_MIN, Math.min(SCALE_MAX, SCALE_NEAR_W / Math.max(SCALE_NEAR_W, w)));

        paintSign(el);
        refreshText(el);

        el.style.display = 'block';
        el.style.transform =
          'translate3d(' + sx.toFixed(1) + 'px, ' + sy.toFixed(1) + 'px, 0) ' +
          'translate(-50%, -100%) scale(' + sc.toFixed(3) + ')';
      }
    };
  }

  /* ── cleanup ──────────────────────────────────────────────────────────────── */
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (cleanRef) { try { cleanRef(); } catch (e) { /* ignore */ } cleanRef = null; }
    if (signEl && signEl.parentNode) signEl.remove();
    signEl = null;
    if (ov.parentNode) ov.remove();
    if (chip.parentNode) chip.remove();
    routeCache = null; anchorWorld = null;
    log('route-sign cleaned up');
  }
  try { if (typeof terra.onCleanup === 'function') terra.onCleanup(cleanup); } catch (e) {}
  try { window.addEventListener('pagehide', cleanup, { once: true }); } catch (e) {}

  /* ── find window.btApp (poll via rAF until the game exposes it) ───────────── */
  function waitForBT(ms = 20000) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const poke = () => {
        const app = window.btApp;
        if (app && typeof app.addFeature === 'function') return resolve(app);
        if (performance.now() - t0 > ms) return reject(new Error('btApp not found within ' + ms + 'ms'));
        requestAnimationFrame(poke);
      };
      poke();
    });
  }

  /* ── boot ─────────────────────────────────────────────────────────────────── */
  try {
    appRef = await waitForBT();
    log('btApp acquired; installing route-sign feature');
    cleanRef = appRef.addFeature((scope, env) => makeFeature(appRef));
  } catch (err) {
    log('[route-sign] btApp not found after waiting.\n' +
        '  Terra ships an auto-breakpoint for exactly this; set TERRA_NO_BT_BREAKPOINT=1\n' +
        '  to disable it, or pause manually and set `window.btApp = this`. Original: ' + err.message);
    return;   // leave the (invisible) overlay + 🪧 chip in place for a later re-injection
  }
})();
