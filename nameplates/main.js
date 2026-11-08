/* nameplates — floating screen-space names above every rider (ego + bots)
 *
 * Body runs as: async function (terra) { ... }
 *
 * Data source
 *   `window.btApp` (the Tf GameManager) is exposed by the app.  We wait up
 *   to ~20 s for it, then install ourselves through the in-game render-loop
 *   plugin API:
 *
 *       const remove = btApp.addFeature((scope, {engine, tiles, budget}) =>
 *         ({ frame(frameState, renderQueue) { ... } })
 *       );
 *
 *   Per-frame facts we rely on (from the "Biketerra WebGPU Architecture"
 *   reference):
 *     • frameState.camera.viewProj        — Float32Array(16), col-major, P * V
 *     • frameState.origin                 — [originX, originZ], the floating-origin
 *                                          offset.  Subtracted from *world* X and Z
 *                                          before multiplying by viewProj.
 *     • frameState.rig.hideFocalRider     — true in first-person; the focal rider
 *                                          is NOT rendered in that view, so we hide
 *                                          our focal plate too when it is set.
 *     • btApp.riderController.focalRider  — the currently watched rider (ego on /ride/,
 *                                          the spectated human on /spectate/).
 *     • btApp.riderController.riders      — Array of all non-ego riders (bots + humans).
 *     • rider.sim.position / midPosition  — {x, y, z} world metres, +Y is up.
 *     • rider.sim.curLod === 0            — culled by the game, skip.
 *     • rider.sim.power                   — live watts, per frame.
 *     • rider.config                      — { first_name?, last_name?, mass? (g), ... }
 *     • rider.userData                    — extra fields (present on ego).
 *
 *   Per-second facts (2 Hz) for the extra stats, from `terra.ride.onRide`:
 *     frame.ego     — { power, wkg, speed, cadence, heartRate, gap, lapCount, ... }
 *     frame.riders  — [{ id, name, power, wkg, speed, cadence, heartRate, gap, lapCount }, ...]
 *
 *   Helmet colors (color mode "helmet"):
 *     btApp.riderController.focalRider.design.helmet_color  (the focal rider)
 *     btApp.riderController.humanFeed.humans[<id>].design.helmet_color  (other humans)
 *     btApp.riderController.ego.design.helmet_color          (ego)
 *     Value shape is not guaranteed (hex string / int / [r,g,b]) — parsed defensively.
 *
 * Settings live in Terra's cog menu ("Settings ▾") and are declared in
 * manifest.json.  Live preview via terra.settings.preview.
 *
 * A plate is a div under a fixed, full-viewport, pointer-events-none overlay.
 * It is positioned via
 *     translate3d(sx, sy, 0) translate(-50%, -100%) scale(s)
 * so the bottom-centre of the plate sits at (sx, sy) on screen and the label
 * extends *upward* above it — i.e. the plate's anchor point is just above the
 * rider's head (world +Y by S.plateHeight, default 1.9 m).
 */

'use strict';
(async () => {
  const log = (...a) => { try { terra.log(...a); } catch (e) { console.log('[nameplates]', ...a); } };

  /* ── tunables (screen-space only; everything else is a setting) ────────────── */
  const HORIZON_PAD  = 1.10;  // hide plates beyond this fraction of the NDC half-extent
  const NEAR_W       = 0.15;  // hide plates whose clip-space W is below this (behind near plane)
  const SCALE_NEAR_W = 10;    // at clip-W = 10, scale = 1.0 and then we scale down with distance
  const SCALE_MIN    = 0.55;  // never smaller than this
  const SCALE_MAX    = 1.00;  // never larger than this

  /* ── settings ──────────────────────────────────────────────────────────────── */
  // Defaults mirror manifest.json; `all()` returns stored-over-default.
  const DEFAULTS = {
    nameFormat: 'full', showEgo: true, fontSize: 12,
    colorMode: 'custom', plateColor: '#0f172a', egoPlateColor: '#dc2626',
    showPower: true, showWkg: true,
    showSpeed: false, showCadence: false, showHeart: false, showGap: false, showLap: false,
    plateHeight: 1.9, maxDist: 100, bgOpacity: 82,
  };
  let S = Object.assign({}, DEFAULTS);
  try { S = Object.assign({}, DEFAULTS, await terra.settings.all()); }
  catch (e) { log('could not read settings, using defaults: ' + e); }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));
  const num = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
  const px = v => clamp(v, 6, 40) + 'px';
  let appRef = null; // btApp, once acquired (also read from inside helmetRgb)

  /* ── overlay ──────────────────────────────────────────────────────────────── */
  const ov = document.createElement('div');
  ov.className = 'nameplates-ov';
  ov.style.fontSize = px(S.fontSize);
  document.body.appendChild(ov);

  const applyGlobal = () => { ov.style.fontSize = px(S.fontSize); };
  const applyS = (v) => { S = Object.assign({}, DEFAULTS, v); applyGlobal(); };
  const fetchSettings = (then) => terra.settings.all().then(then).catch(e => log('settings refresh failed: ' + e));
  try {
    terra.settings.onChange(() => { fetchSettings(applyS); }); // re-read: the UI emit is synchronous, our read isn't
  } catch (e) { /* older Terra core */ }

  /* ── ⚙ chip — ride pages usually have no header, so put a small button here ── */
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'np-chip';
  chip.title = 'Nameplates settings';
  chip.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1.15-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
  chip.addEventListener('click', () => { try { terra.settings.open(); } catch (e) {} });
  document.body.appendChild(chip);

  /* ── live stats cache (2 Hz broadcast) ─────────────────────────────────────── */
  const statsById   = new Map(); // String(id) -> stats from frame.riders
  const statsByName = new Map(); // lowercased name -> stats (id shapes may differ between
                                 // the game graph and the broadcast; names are the fallback)
  let egoStats      = null;      // frame.ego
  try {
    terra.ride.onRide(frame => {
      if (!frame) return;
      if (frame.ego) egoStats = frame.ego;
      if (Array.isArray(frame.riders)) {
        statsById.clear();
        statsByName.clear();
        for (const s of frame.riders) {
          if (!s) continue;
          if (s.id != null) statsById.set(String(s.id), s);
          if (s.name) statsByName.set(String(s.name).toLowerCase(), s);
        }
      }
    });
  } catch (e) { /* older Terra core */ }

  const statsFor = (id, isFocal, focalIsEgo, r) => {
    let st = id != null ? statsById.get(String(id)) : undefined;
    if (!st && r) {
      const cfg = r.config || {}, ud = r.userData || {};
      const name = ((ud.first_name != null ? ud.first_name : cfg.first_name) || '') + ' '
                 + (cfg.last_name  != null ? cfg.last_name  : (ud.last_name  != null ? ud.last_name : ''));
      const key = name.toLowerCase();
      if (key) st = statsByName.get(key);
    }
    if (!st && isFocal && focalIsEgo) st = egoStats;
    return st || null;
  };

  /* ── names ─────────────────────────────────────────────────────────────────── */
  const fmtInt = v => (Number.isFinite(+v) ? Math.round(+v) : 0);
  const fmt1   = v => (Number.isFinite(+v) ? (+v).toFixed(1) : '0.0');
  const trim   = v => String(v == null ? '' : v).trim();

  function nameFor(r, isFocal, id) {
    const cfg = (r && r.config)   || {};
    const ud  = (r && r.userData) || {};
    const first = trim(ud.first_name != null ? ud.first_name : cfg.first_name);
    const last  = trim(cfg.last_name  != null ? cfg.last_name : ud.last_name);
    const full  = (first + ' ' + last).trim();
    const fall  = isFocal ? 'You' : (id != null ? 'Rider #' + id : 'Rider');
    if (S.nameFormat === 'short') return first || last || full || fall;
    if (S.nameFormat === 'last')  return last || first || full || fall;
    return full || fall;
  }

  /* ── colors ────────────────────────────────────────────────────────────────── */
  function rgbFromHex(v) {
    if (typeof v === 'string') {
      const m = v.trim().match(/^#?([0-9a-f]{6})([0-9a-f]{2})?$/i)
              || v.trim().match(/^#?([0-9a-f]{3})$/i);
      if (m) {
        let h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
      }
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) return [Math.min(255, n >> 16), Math.min(255, (n >> 8) & 255), Math.min(255, n & 255)];
    }
    if (Number.isFinite(v) && v >= 0) return [Math.min(255, Math.floor(v) >> 16), Math.min(255, (Math.floor(v) >> 8) & 255), Math.min(255, Math.floor(v) & 255)];
    if (Array.isArray(v) && v.length >= 3) return [clamp(v[0], 0, 255), clamp(v[1], 0, 255), clamp(v[2], 0, 255)];
    if (v && typeof v === 'object' && v.r != null) return [clamp(v.r, 0, 255), clamp(v.g, 0, 255), clamp(v.b, 0, 255)];
    return null;
  }

  function hashRgb(seed) { // stable per-rider pseudo-random color
    let h = 2166136261;
    for (const ch of String(seed == null ? '' : seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const hue = h % 360, sat = 0.62, lit = 0.42; // HSL
    const c = (1 - Math.abs(2 * lit - 1)) * sat, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = lit - c / 2;
    const q = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
    return [Math.round((q[0] + m) * 255), Math.round((q[1] + m) * 255), Math.round((q[2] + m) * 255)];
  }

  function helmetRgb(r, id, isFocal) {
    const rc = appRef && appRef.riderController;
    if (!rc) return null;
    const pick = (o) => o && o.design && rgbFromHex(o.design.helmet_color);
    if (isFocal && pick(rc.focalRider)) return pick(rc.focalRider);
    if (rc.humanFeed && rc.humanFeed.humans) {
      const e = rc.humanFeed.humans[id] || rc.humanFeed.humans[String(id)];
      const p = pick(e);
      if (p) return p;
    }
    const pe = pick(rc.ego);
    if (pe) return pe;
    return null;
  }

  const customRgb = isFocal => rgbFromHex(isFocal ? S.egoPlateColor : S.plateColor) || [0, 0, 0];
  const resolveRgb = (id, isFocal, r) => {
    if (S.colorMode === 'random') return hashRgb(id);
    if (S.colorMode === 'helmet') { const h = helmetRgb(r, id, isFocal); if (h) return h; }
    return customRgb(isFocal);
  };
  const rgbCss  = rgb => 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + (clamp(S.bgOpacity, 0, 100) / 100).toFixed(2) + ')';
  const textFor = rgb => ((0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 > 0.58) ? '#0f172a' : '#ffffff';

  /* ── label ─────────────────────────────────────────────────────────────────── */
  function labelText(name, st, r) {
    const parts = [];
    const sim = (r && r.sim) || {};
    const pwr = (Number.isFinite(+sim.power) && +sim.power > 0)
      ? +sim.power
      : (st && Number.isFinite(+st.power) && +st.power > 0 ? +st.power : 0);
    if (S.showPower && pwr > 0) parts.push(fmtInt(pwr) + ' W');
    if (S.showWkg && pwr > 0) {
      const massG = (r && r.config && r.config.mass) || (r && r.userData && r.userData.weight) || 75000;
      const w = (st && Number.isFinite(+st.wkg) && +st.wkg > 0) ? +st.wkg : (pwr * 1000) / massG;
      parts.push('(' + fmt1(w) + ' W/kg)');
    }
    if (st) {
      if (S.showSpeed   && +st.speed     > 0)  parts.push(fmt1(st.speed)   + ' km/h');
      if (S.showCadence && +st.cadence   > 0)  parts.push(fmtInt(st.cadence)   + ' rpm');
      if (S.showHeart   && +st.heartRate > 0)  parts.push(fmtInt(st.heartRate) + ' bpm');
      if (S.showGap     && +st.gap       >= 0.05) parts.push('+' + fmt1(st.gap) + ' s');
      if (S.showLap     && +st.lapCount  > 0)  parts.push('Lap ' + fmtInt(st.lapCount));
    }
    return parts.length ? name + '  •  ' + parts.join('  •  ') : name;
  }

  /* ── live preview in the cog menu ──────────────────────────────────────────── */
  const SAMPLE = { power: 210, wkg: 2.8, speed: 37.4, cadence: 88, heartRate: 152, gap: 12.4, lapCount: 8 };
  function paintPreview(slot) {
    if (!slot) return; // hidden — nothing to tear down (static sample, no timers)
    const mk = (name, rgb) => {
      const el = document.createElement('div');
      el.className = 'np np-sample';
      el.style.background = rgbCss(rgb);
      el.style.color = textFor(rgb);
      el.style.fontSize = px(S.fontSize);
      el.textContent = labelText(name, SAMPLE, null);
      return el;
    };
    // helmet colors can't be sampled out of the game; preview with the custom colors
    const paintNow = () => {
      slot.replaceChildren(mk('Josef Nilsson', customRgb(true)), mk('Alex Kim', customRgb(false)));
    };
    paintNow();
    // The UI fires this the instant a save lands, but our cached copy of the
    // settings may still be resolving — repaint once with the server's value.
    try { terra.settings.all().then(applyS).then(paintNow).catch(() => {}); } catch (e) {}
  }
  try { terra.settings.preview(paintPreview); } catch (e) { /* older Terra core */ }

  /* ── plates ────────────────────────────────────────────────────────────────── */
  /** map of rider identity → live plate element. */
  const plates = new Map();
  /** last identity we saw in the frame; used to drop plates no longer on screen. */
  let lastActive = new Set();
  let cleanRef   = null;
  let cleaned    = false;

  /* ── find window.btApp (poll via rAF until the game exposes it) ──────────── */
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

  /* ── render loop (installed via addFeature) ───────────────────────────────── */
  function makeFeature(app) {
    const rc = () => app && app.riderController;

    return {
      frame(frameState) {
        if (cleaned) return;
        const cam  = frameState && frameState.camera;
        const R    = rc();
        const vp   = cam  && cam.viewProj;
        if (!vp || !R) return;

        const lift   = clamp(S.plateHeight, 0.5, 4);   // metres above the rider
        const maxD   = num(S.maxDist, 100);            // 0 = unlimited
        const showEgo = !!S.showEgo;

        const [ox, oz] = (frameState.origin && frameState.origin.length >= 2)
          ? [frameState.origin[0], frameState.origin[1]] : [0, 0];
        const hideFocal = !!(frameState.rig   && frameState.rig.hideFocalRider);
        const W          = window.innerWidth  || document.documentElement.clientWidth;
        const H          = window.innerHeight || document.documentElement.clientHeight;

        /* ── build this frame's rider list (focal + bots), deduped ───────── */
        const focal = R.focalRider || R.ego;
        const focalIsEgo = (R.ego !== undefined && R.ego !== null) && focal === R.ego;
        const list  = [];
        if (showEgo && focal && focal.sim) list.push({ r: focal, focal: true });
        for (const r of (R.riders || [])) {
          if (!r || !r.sim) continue;
          if (r === focal) continue;                    // already pushed above
          list.push({ r, focal: false });
        }

        const active = new Set();
        const drop = el => { if (el && el.parentNode) el.remove(); };
        const focalPos = (focal && focal.sim) ? focal.sim.midPosition : null;

        for (const { r, focal: isFocal } of list) {
          const sim = r.sim;
          if (sim.curLod === 0) continue;               // game has culled this rider
          if (isFocal && hideFocal) continue;           // first-person: focal isn't on screen
          if (isFocal && !showEgo) continue;            // plate hidden by settings

          /* ── range gate: skip non-focal riders farther than maxD from focal ── */
          if (!isFocal && maxD > 0 && focalPos) {
            const dx = sim.midPosition.x - focalPos.x;
            const dy = sim.midPosition.y - focalPos.y;
            const dz = sim.midPosition.z - focalPos.z;
            if (Math.sqrt(dx*dx + dy*dy + dz*dz) > maxD) {
              const id0 = (sim.id != null) ? sim.id : sim.athleteId;
              const el0 = plates.get(id0);
              if (el0) el0.style.display = 'none';
              continue;
            }
          }

          const id = (sim.id != null) ? sim.id : sim.athleteId;
          if (id != null) active.add(id);

          /* ── world → origin-relative → clip → NDC ─────────────────────── */
          const rx = sim.midPosition.x - ox;
          const ry = sim.midPosition.y + lift;
          const rz = sim.midPosition.z - oz;
          const w  = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];
          const el = plates.get(id);
          if (w <= NEAR_W || !Number.isFinite(w)) { if (el) el.style.display = 'none'; continue; }
          const iw = 1 / w;
          const nx = (vp[0] * rx + vp[4] * ry + vp[8] * rz  + vp[12]) * iw;
          const ny = (vp[1] * rx + vp[5] * ry + vp[9] * rz  + vp[13]) * iw;
          if (!Number.isFinite(nx) || !Number.isFinite(ny)) { if (el) el.style.display = 'none'; continue; }
          if (Math.abs(nx) > HORIZON_PAD || Math.abs(ny) > HORIZON_PAD) { if (el) el.style.display = 'none'; continue; }

          /* ── label ────────────────────────────────────────────────────── */
          const st = statsFor(id, isFocal, focalIsEgo, r);
          const text = labelText(nameFor(r, isFocal, id), st, r);
          if (el) {
            if (el.textContent !== text) el.textContent = text;
          } else {                    // lazy-create (also survives a page navigation)
            el = document.createElement('div');
            el.className = 'np' + (isFocal ? ' np-focal' : '');
            el.style.display = 'none';
            ov.appendChild(el);
            plates.set(id, el);
          }

          /* ── colors (per mode; re-applied only when they change) ────────── */
          const rgb = resolveRgb(id, isFocal, r);
          const bg = rgbCss(rgb), tx = textFor(rgb);
          const key = bg + '|' + tx;
          if (el._npStyle !== key) {
            el.style.background = bg;
            el.style.color = tx;
            el._npStyle = key;
          }

          /* ── position + scale ─────────────────────────────────────────── */
          const sx = (nx * 0.5 + 0.5) * W;
          const sy = (1 - (ny * 0.5 + 0.5)) * H;
          const sc = Math.max(SCALE_MIN, Math.min(SCALE_MAX, SCALE_NEAR_W / Math.max(SCALE_NEAR_W, w)));
          el.style.display   = 'block';
          el.style.transform =
            'translate3d(' + sx.toFixed(1) + 'px, ' + sy.toFixed(1) + 'px, 0) ' +
            'translate(-50%, -100%) scale(' + sc.toFixed(3) + ')';
        }

        /* ── drop plates whose rider is no longer in the frame ──────────── */
        for (const [id, el] of plates) if (!active.has(id)) { drop(el); plates.delete(id); }
        lastActive = active;
      }
    };
  }

  /* ── cleanup ──────────────────────────────────────────────────────────────── */
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (cleanRef) { try { cleanRef(); } catch (e) { /* ignore */ } cleanRef = null; }
    for (const el of plates.values()) { if (el.parentNode) el.remove(); }
    plates.clear();
    lastActive.clear();
    statsBy.clear();
    if (ov.parentNode) ov.remove();
    if (chip.parentNode) chip.remove();
    for (const k of ['__nameplates']) { try { delete window[k]; } catch (e) {} }
    log('nameplates cleaned up');
  }
  try { if (typeof terra.onCleanup === 'function') terra.onCleanup(cleanup); } catch (e) {}
  try { window.addEventListener('pagehide', cleanup, { once: true }); } catch (e) {}

  /* ── boot ─────────────────────────────────────────────────────────────────── */
  try {
    appRef = await waitForBT();
    log('btApp acquired; installing nameplate feature (polling done)');
  } catch (err) {
    log('[nameplates] btApp not found after waiting.\n' +
        '  Terra ships an auto-breakpoint for exactly this; set TERRA_NO_BT_BREAKPOINT=1\n' +
        '  to disable it, or pause manually and set `window.btApp = this`.');
    log('  original error: ' + err.message);
    return;   // leave the (invisible) overlay + ⚙ chip in place for later re-injection
  }

  cleanRef = appRef.addFeature((scope, env) => makeFeature(appRef));
  log('nameplates ready');

  /* ── small dev/ops API (biketerra-logger & friends rely on this) ──────────── */
  window.__nameplates = {
    get plateCount() { return plates.size; },
    get lastActive() { return Array.from(lastActive); },
    // kept as a proxy for the cog-menu setting so existing callers keep working
    maxDist: (v) => terra.settings.set('maxDist', v),
    stop: cleanup,
  };
})();
