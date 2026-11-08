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
 *     • frameState.camera.worldPosition   — {x, y, z}  (not needed, viewProj is enough)
 *     • frameState.origin                 — [originX, originZ], the floating-origin
 *                                          offset.  Subtracted from *world* X and Z
 *                                          before multiplying by viewProj.
 *     • frameState.rig.hideFocalRider     — true in first-person; the focal rider
 *                                          is NOT rendered in that view, so we hide
 *                                          our focal plate too when it is set.
 *     • btApp.riderController.focalRider  — the currently watched rider (ego on /ride/,
 *                                          the spectated human on /spectate/).
 *     • btApp.riderController.riders      — Array of all non-ego riders (bots + humans).
 *     • rider.sim.position                — {x, y, z} world meters, +Y is up.
 *     • rider.sim.curLod === 0            — culled by the game, skip.
 *     • rider.config                      — { first_name?, last_name?, mass? (g), ... }
 *     • rider.userData                    — extra fields (present on ego).
 *
 * A plate is a div under a fixed, full-viewport, pointer-events-none overlay.
 * It is positioned via
 *     translate3d(sx, sy, 0) translate(-50%, -100%) scale(s)
 * so the bottom-centre of the plate sits at (sx, sy) on screen and the label
 * extends *upward* above it — i.e. the plate's anchor point is just above the
 * rider's head (world +Y by H = 1.9 m).
 */

'use strict';
(async () => {
const log = (...a) => { try { terra.log(...a); } catch (e) { console.log('[nameplates]', ...a); } };

  /* ── tunables ─────────────────────────────────────────────────────────────── */
  const HEAD_LIFT      = 1.9;   // world metres above `sim.position` (≈ top of the head)
  const HORIZON_PAD    = 1.10;  // hide plates beyond this fraction of the NDC half-extent
  const NEAR_W         = 0.15;  // hide plates whose clip-space W is below this (behind near plane)
  const SCALE_NEAR_W   = 10;    // at clip-W = 10, scale = 1.0 and then we scale down with distance
  const SCALE_MIN      = 0.55;  // never smaller than this
  const SCALE_MAX      = 1.00;  // never larger than this
  let   MAX_DIST       = 100;   // metres; hide non-focal riders farther than this from focal (0 = unlimited)

  /* ── overlay ──────────────────────────────────────────────────────────────── */
  const ov = document.createElement('div');
  ov.className = 'nameplates-ov';
  document.body.appendChild(ov);

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

  /* ── label + formatting helpers ───────────────────────────────────────────── */
  const fmtInt = v => (Number.isFinite(v) ? Math.round(v) : 0);
  const fmt1   = v => (Number.isFinite(v) ? v.toFixed(1) : '0.0');

  function riderLabel(r, isFocal) {
    const cfg = (r && r.config)   || {};
    const ud  = (r && r.userData) || {};
    const first = String(ud.first_name != null ? ud.first_name : cfg.first_name != null ? cfg.first_name : '').trim();
    const last  = String(cfg.last_name  || '').trim();
    const full  = [first, last].filter(Boolean).join(' ').trim();
    if (full.length) return full;
    return isFocal ? 'You' : 'Rider #' + (r.sim && r.sim.id != null ? r.sim.id : '');
  }

  function composeLabel(r, isFocal) {
    const name = riderLabel(r, isFocal);
    const sim  = r.sim;
    const pwr  = fmtInt(sim && sim.power);
    const massG = (r.config   && r.config.mass)   || (r.userData && r.userData.weight) || 75000;   // grams
    const wkg  = pwr > 0 ? (pwr * 1000) / massG : 0;
    return name + '  •  ' + pwr + 'W  (' + fmt1(wkg) + ' W/kg)';
  }

  function ensurePlate(id, isFocal) {
    let el = plates.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'np' + (isFocal ? ' np-focal' : '');
      el.style.display = 'none';
      ov.appendChild(el);
      plates.set(id, el);
    } else if (!isFocal ? el.classList.contains('np-focal') : !el.classList.contains('np-focal')) {
      el.classList.toggle('np-focal', isFocal);
    }
    return el;
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

        const [ox, oz] = (frameState.origin && frameState.origin.length >= 2)
          ? [frameState.origin[0], frameState.origin[1]] : [0, 0];
        const hideFocal = !!(frameState.rig   && frameState.rig.hideFocalRider);
        const W          = window.innerWidth  || document.documentElement.clientWidth;
        const H          = window.innerHeight || document.documentElement.clientHeight;

        /* ── build this frame's rider list (focal + bots), deduped ───────── */
        const focal = R.focalRider || R.ego;
        const list  = [];
        const seen  = new Set();
        if (focal && focal.sim) list.push({ r: focal, focal: true });
        for (const r of (R.riders || [])) {
          if (!r || !r.sim) continue;
          if (r === focal) continue;                    // already pushed above
          if (seen.has(r)) continue;
          seen.add(r);
          list.push({ r, focal: false });
        }

        const active = new Set();
        const drop = el => { if (el && el.parentNode) el.remove(); };
        const focalPos = (focal && focal.sim) ? focal.sim.midPosition : null;

        for (const { r, focal: isFocal } of list) {
          const sim = r.sim;
          if (sim.curLod === 0) continue;               // game has culled this rider
          if (isFocal && hideFocal) continue;           // first-person: focal isn't on screen

          /* ── range gate: skip non-focal riders farther than MAX_DIST from focal ── */
          if (!isFocal && MAX_DIST > 0 && focalPos) {
            const dx = sim.midPosition.x - focalPos.x;
            const dy = sim.midPosition.y - focalPos.y;
            const dz = sim.midPosition.z - focalPos.z;
            if (Math.sqrt(dx*dx + dy*dy + dz*dz) > MAX_DIST) {
              const el0 = plates.get((sim.id != null) ? sim.id : sim.athleteId);
              if (el0) el0.style.display = 'none';
              continue;
            }
          }

          const id = (sim.id != null) ? sim.id : sim.athleteId;
          if (id != null) active.add(id);

          /* ── world → origin-relative → clip → NDC ─────────────────────── */
          const rx = sim.midPosition.x - ox;
          const ry = sim.midPosition.y + HEAD_LIFT;
          const rz = sim.midPosition.z - oz;
          const w  = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];
          const el = ensurePlate(id, isFocal);
          if (w <= NEAR_W || !Number.isFinite(w)) { el.style.display = 'none'; continue; }
          const iw = 1 / w;
          const nx = (vp[0] * rx + vp[4] * ry + vp[8] * rz  + vp[12]) * iw;
          const ny = (vp[1] * rx + vp[5] * ry + vp[9] * rz  + vp[13]) * iw;
          if (!Number.isFinite(nx) || !Number.isFinite(ny)) { el.style.display = 'none'; continue; }
          if (Math.abs(nx) > HORIZON_PAD || Math.abs(ny) > HORIZON_PAD) { el.style.display = 'none'; continue; }

          /* ── label ────────────────────────────────────────────────────── */
          const text = composeLabel(r, isFocal);
          if (el.textContent !== text) el.textContent = text;

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
    if (ov.parentNode) ov.remove();
    for (const k of ['__nameplates']) { try { delete window[k]; } catch (e) {} }
    log('nameplates cleaned up');
  }
  try { if (typeof terra.onCleanup === 'function') terra.onCleanup(cleanup); } catch (e) {}
  try { window.addEventListener('pagehide', cleanup, { once: true }); } catch (e) {}

  /* ── boot ─────────────────────────────────────────────────────────────────── */
  let app = null;
  try {
    app = await waitForBT();
    log('btApp acquired; installing nameplate feature (polling done)');
  } catch (err) {
    log('[nameplates] btApp not found after waiting.\n' +
        '  Set a DevTools *conditional breakpoint* on the Tf.#K tick line ' +
        '`this.riderController.handleInput()`\n' +
        '  (source: /_app/immutable/chunks/B_8b0DVZ.js or similar)\n' +
        '  with expression  (window.btApp = this, false)\n' +
        '  then reload the page.  The breakpoint fires without pausing and ' +
        'publishes the root instance, after which this addon attaches via ' +
        'btApp.addFeature().');
    log('  original error: ' + err.message);
    return;   // leave the (invisible) overlay in place so a later manual re-inject works
  }

  cleanRef = app.addFeature((scope, env) => makeFeature(app));
  log('nameplates ready');

  window.__nameplates = {
    get plateCount() { return plates.size; },
    get lastActive() { return Array.from(lastActive); },
    maxDist: v => { MAX_DIST = Number(v) >= 0 ? Number(v) : 0; },
    stop: cleanup,
  };
})();
