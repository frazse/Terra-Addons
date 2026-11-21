/* Rowbike Avatar (Experiment) v0.1.0
 * Replaces your Biketerra ego bike + avatar with an articulated 3D Rowbike 720 Sport
 * and biomechanically animated rower (wearing your live ego.design kit colors).
 *
 * - Strips ego's default `skinned` + `spoke` draws in `engine.render` (other riders untouched).
 * - Injects a depth-tested WebGPU draw directly into Biketerra's main color+depth render pass.
 * - Supports `activationMode: 'always'` (default for testing) or `'auto'` (rowing-only via
 *   `window.__terraMode === 'row'` or BLE FTMS Rower Data 0x2AD1 / Concept2 PM5).
 */
'use strict';

(async () => {
  const log = (...a) => {
    try { terra.log(...a); } catch { try { console.log('[rowbike]', ...a); } catch {} }
  };

  if (window.__terraRowbikeCleanup) {
    try { window.__terraRowbikeCleanup(); } catch {}
  }

  const DEFAULTS = {
    activationMode: 'always', // 'always' | 'auto' | 'off'
    avatarMode: 'real',       // 'real' | 'stylized'
    animateWhenStopped: true,
    demoSpm: 24,
    frameColor: '#c8242b',
    leverColor: '#243ea8',
    showStatusPill: true,
    bikeShadow: true,         // project a ground shadow of the Rowbike (the injected draw has no native shadow)
    shadowAzimuth: 0,         // degrees to rotate the shadow direction around the vertical axis
  };

  let S = { ...DEFAULTS };
  try { S = { ...DEFAULTS, ...(await terra.settings.all()) }; } catch {}

  let cleaned = false;
  let unhookFeature = null;
  let unsubBleNotify = null;
  let unsubBleConnect = null;
  let unsubBleDisconnect = null;
  let unsubRide = null;
  let rideChannel = null;
  let manualOverride = null; // null = follow S.activationMode, true/false = pill click override

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function hexToRgb(hex, fallback) {
    const raw = String(hex || fallback || '#888888').trim().replace(/^#/, '');
    if (raw.length === 3) {
      const r = parseInt(raw[0] + raw[0], 16);
      const g = parseInt(raw[1] + raw[1], 16);
      const b = parseInt(raw[2] + raw[2], 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r / 255, g / 255, b / 255];
    }
    if (raw.length >= 6) {
      const r = parseInt(raw.slice(0, 2), 16);
      const g = parseInt(raw.slice(2, 4), 16);
      const b = parseInt(raw.slice(4, 6), 16);
      if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) return [r / 255, g / 255, b / 255];
    }
    return [0.55, 0.55, 0.58];
  }

  function shadeRgb(c, f) {
    return [clamp(c[0] * f, 0, 1), clamp(c[1] * f, 0, 1), clamp(c[2] * f, 0, 1)];
  }

  /* ── 1. Rowing Detection (biketerra-ride sport: 1) & BLE Rower Telemetry ──── */
  const bleRow = {
    detected: false,
    egoSportRow: false,        // true when ego / focal has sport === 1 in biketerra-ride
    rowingIds: new Set(),      // rider IDs (String) with sport === 1 in biketerra-ride
    rowingNames: new Set(),    // normalized rider names with sport === 1 in biketerra-ride
    spmById: new Map(),        // id -> spm from biketerra-ride cadence
    spmByName: new Map(),      // normName -> spm from biketerra-ride cadence
    spm: 0,
    lastSpmMs: 0,
    powerW: 0,
  };

  function normName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isSportOne(val) {
    return val === 1 || val === '1' || val === 'row' || val === 'rowing';
  }

  function onRideBroadcastFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    bleRow.egoSportRow = isSportOne(frame.sport) || Boolean(frame.ego && isSportOne(frame.ego.sport));
    bleRow.rowingIds.clear();
    bleRow.rowingNames.clear();
    bleRow.spmById.clear();
    bleRow.spmByName.clear();
    if (Array.isArray(frame.riders)) {
      for (let i = 0; i < frame.riders.length; i++) {
        const r = frame.riders[i];
        if (!r || !isSportOne(r.sport)) continue;
        if (r.id != null) {
          const sid = String(r.id);
          bleRow.rowingIds.add(sid);
          if (Number.isFinite(+r.cadence) && +r.cadence > 0) bleRow.spmById.set(sid, +r.cadence);
        }
        const nm = normName(r.name);
        if (nm) {
          bleRow.rowingNames.add(nm);
          if (Number.isFinite(+r.cadence) && +r.cadence > 0) bleRow.spmByName.set(nm, +r.cadence);
        }
      }
    }
  }

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      rideChannel = new BroadcastChannel('biketerra-ride');
      rideChannel.onmessage = (e) => {
        if (e && e.data) onRideBroadcastFrame(e.data);
      };
    }
  } catch {}

  try {
    if (terra.ride) {
      if (typeof terra.ride.latest === 'function') {
        const seed = terra.ride.latest();
        if (seed) onRideBroadcastFrame(seed);
      }
      if (typeof terra.ride.onRide === 'function') {
        unsubRide = terra.ride.onRide(onRideBroadcastFrame);
      }
    }
  } catch {}

  function checkBleDevicesForRower() {
    try {
      if (terra.ble && typeof terra.ble.devices === 'function') {
        const devs = terra.ble.devices() || [];
        for (const d of devs) {
          if (d && d.connected && /pm5|concept2|rowerg|waterrower|row/i.test(String(d.name || ''))) {
            bleRow.detected = true;
            return true;
          }
        }
      }
    } catch {}
    return false;
  }

  try {
    if (terra.ble && typeof terra.ble.onNotify === 'function') {
      unsubBleNotify = terra.ble.onNotify((ev) => {
        if (!ev || !ev.value) return;
        const ch = String(ev.characteristic || '').toLowerCase();
        const nm = String(ev.name || '');
        const dv = ev.value;
        // FTMS Rower Data (0x2AD1): bytes 0..1 = flags, byte 2 = stroke rate (0.5 spm units) when !(flags & 1)
        if (ch.includes('2ad1') && dv.byteLength >= 3) {
          bleRow.detected = true;
          const flags = dv.getUint16(0, true);
          if ((flags & 0x0001) === 0) {
            bleRow.spm = dv.getUint8(2) * 0.5;
            bleRow.lastSpmMs = performance.now();
          }
        } else if (/pm5|concept2|rowerg|waterrower|row/i.test(nm)) {
          bleRow.detected = true;
          // Concept2 PM5 Additional Status 1 (0x0032): byte 5 = stroke rate (spm)
          if (ch.includes('0032') && dv.byteLength >= 6) {
            bleRow.spm = dv.getUint8(5);
            bleRow.lastSpmMs = performance.now();
          }
        }
      });
    }
    if (terra.ble && typeof terra.ble.onConnect === 'function') {
      unsubBleConnect = terra.ble.onConnect(() => checkBleDevicesForRower());
    }
    if (terra.ble && typeof terra.ble.onDisconnect === 'function') {
      unsubBleDisconnect = terra.ble.onDisconnect(() => {
        bleRow.detected = checkBleDevicesForRower();
      });
    }
  } catch {}

  function btRiderFullName(r) {
    if (!r || typeof r !== 'object') return '';
    const cfg = r.config || {}, ud = r.userData || {};
    const first = String(ud.first_name ?? cfg.first_name ?? '').trim();
    const last = String(cfg.last_name ?? ud.last_name ?? '').trim();
    const full = normName(`${first} ${last}`);
    if (full) return full;
    return normName(cfg.name ?? cfg.fullName ?? ud.name ?? '');
  }

  function isRiderRowingInBroadcast(r, isEgoOrFocal) {
    if (!r || !r.sim) return false;
    if (isSportOne(r.sim.sport) || isSportOne(r.sport)) return true;
    if (isEgoOrFocal && bleRow.egoSportRow) return true;
    const sim = r.sim;
    for (const idCand of [sim.id, sim.athleteId, r.id, r.athleteId]) {
      if (idCand != null && bleRow.rowingIds.has(String(idCand))) return true;
    }
    const nm = btRiderFullName(r);
    if (nm && bleRow.rowingNames.has(nm)) return true;
    return false;
  }

  function getRowbikeRiders(rc) {
    if (!rc) return [];
    if (manualOverride === false) return [];
    const ego = rc.ego || rc.focalRider || null;
    if (manualOverride === true) {
      return ego && ego.sim ? [ego] : [];
    }
    if (S.activationMode === 'off') return [];
    if (S.activationMode === 'always') {
      return ego && ego.sim ? [ego] : [];
    }
    // 'auto': individually replace ONLY the specific riders (ego and/or other riders)
    // who have `sport: 1` in `biketerra-ride` (or on their sim)!
    const out = [];
    const seen = new Set();
    const check = (r, isEgoOrFocal) => {
      if (!r || !r.sim || r._isTerraGhost || seen.has(r)) return;
      if (r.sim.curLod === 0) return;
      seen.add(r);
      if (isRiderRowingInBroadcast(r, isEgoOrFocal)) out.push(r);
    };
    if (rc.ego) check(rc.ego, true);
    if (rc.focalRider && rc.focalRider !== rc.ego) check(rc.focalRider, !rc.ego);
    if (Array.isArray(rc.riders)) {
      for (let i = 0; i < rc.riders.length; i++) {
        const r = rc.riders[i];
        check(r, r === rc.ego || (!rc.ego && r === rc.focalRider));
      }
    }
    return out;
  }

  function isRowbikeActive() {
    if (manualOverride !== null) return manualOverride;
    if (S.activationMode === 'off') return false;
    if (S.activationMode === 'always') return true;
    const bt = window.btApp;
    const rc = bt && (bt.riderController || bt.rideController);
    if (rc) return getRowbikeRiders(rc).length > 0;
    return bleRow.egoSportRow || bleRow.rowingIds.size > 0 || bleRow.rowingNames.size > 0;
  }

  /* ── 2. Dynamic Mesh Builder (Pre-allocated Zero-GC Typed Arrays) ─────────── */
  // Vertex stride = 10 floats (40 bytes): pos(3), norm(3), color(3), shine(1)
  const MAX_VERTS = 16384;
  const MAX_INDICES = 65536;
  const vertData = new Float32Array(MAX_VERTS * 10);
  const idxData = new Uint32Array(MAX_INDICES);
  let vertCount = 0;
  let idxCount = 0;

  // Engine `pools.misc` shadow-casting proxy mesh: feeds our actual Rowbike geometry into
  // Biketerra's renderQueue with `castsShadow: true, shadowOnly: true`, so the native shadow-map
  // pass casts a 100% genuine Rowbike shadow (sliding seat, pivoting lever, 20" wheels)!
  const shadowMisc = {
    disabled: false,
    misc: null,
    handle: null,
    dataMap: null,
    posOut: null,
    normOut: null,
    bounds: [0, 0, 0, 0, 0, 0],
    draw: null,
    uploading: false,
    lastUploadMs: 0,
  };

  function slabsHas(slabs, slab) {
    if (!slabs || !slab) return false;
    if (typeof slabs.has === 'function') return slabs.has(slab);
    if (Array.isArray(slabs)) return slabs.indexOf(slab) !== -1;
    return false;
  }

  function ensureShadowMiscAllocated(scope, eng) {
    if (shadowMisc.disabled || shadowMisc.handle) return !!shadowMisc.handle;
    const misc = eng && eng.pools && eng.pools.misc;
    if (!misc || !misc.slabs || !misc.format || !Array.isArray(misc.format.buffers) ||
        typeof misc.allocate !== 'function' || typeof misc.upload !== 'function') {
      return false;
    }
    let handle;
    try {
      handle = misc.allocate(scope, MAX_VERTS, MAX_INDICES);
    } catch (e) {
      log('misc.allocate for Rowbike shadow failed:', e);
      shadowMisc.disabled = true;
      return false;
    }
    if (!handle) return false;

    const dataMap = {};
    let posOut = null;
    let normOut = null;
    for (const buf of misc.format.buffers) {
      for (const attr of (buf.attributes || [])) {
        const comp = attr.components || 3;
        const field = attr.field;
        if (!field) continue;
        const arr = new Float32Array(MAX_VERTS * comp);
        if (comp === 3 && !posOut) {
          posOut = arr;
        } else if (comp === 3 && !normOut) {
          normOut = arr;
        }
        dataMap[field] = arr;
      }
    }
    if (!posOut) {
      shadowMisc.disabled = true;
      return false;
    }
    shadowMisc.misc = misc;
    shadowMisc.handle = handle;
    shadowMisc.dataMap = dataMap;
    shadowMisc.posOut = posOut;
    shadowMisc.normOut = normOut;
    log('allocated pools.misc handle for real Rowbike shadow map');
    return true;
  }

  function uploadAndBuildShadowMiscDraw(draws, ox, oz) {
    if (!shadowMisc.handle || !shadowMisc.misc || vertCount <= 0 || idxCount <= 0) return null;
    const slabs = shadowMisc.misc.slabs;
    let ref = null;
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      if (d && d.geometry && slabsHas(slabs, d.geometry.slab) && d.pipeline && d.groups) {
        ref = d;
        break;
      }
    }
    if (!ref) return null;

    const po = shadowMisc.posOut;
    const no = shadowMisc.normOut;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < vertCount; i++) {
      const s = i * 10;
      const d3 = i * 3;
      // vertData is origin-relative; pools.misc expects world-space coordinates when upload({ox:0,oz:0})
      const wx = vertData[s] + ox;
      const wy = vertData[s + 1];
      const wz = vertData[s + 2] + oz;
      po[d3] = wx;
      po[d3 + 1] = wy;
      po[d3 + 2] = wz;
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      if (no) {
        no[d3]     = vertData[s + 3];
        no[d3 + 1] = vertData[s + 4];
        no[d3 + 2] = vertData[s + 5];
      }
    }
    // Zero out unused tail vertices to degenerate point at (minX, minY, minZ)
    for (let i = vertCount; i < MAX_VERTS; i++) {
      const d3 = i * 3;
      po[d3] = minX; po[d3 + 1] = minY; po[d3 + 2] = minZ;
    }
    for (let i = idxCount; i < MAX_INDICES; i++) {
      idxData[i] = 0;
    }

    shadowMisc.bounds[0] = minX; shadowMisc.bounds[1] = minY; shadowMisc.bounds[2] = minZ;
    shadowMisc.bounds[3] = maxX; shadowMisc.bounds[4] = maxY; shadowMisc.bounds[5] = maxZ;

    const now = performance.now();
    if (!shadowMisc.uploading || (now - shadowMisc.lastUploadMs) > 120) {
      shadowMisc.uploading = true;
      shadowMisc.lastUploadMs = now;
      try {
        const payload = { ...shadowMisc.dataMap, indices: idxData };
        const res = shadowMisc.misc.upload(shadowMisc.handle, payload, { ox: 0, oz: 0 });
        if (res && typeof res.then === 'function') {
          res.then(() => { shadowMisc.uploading = false; }, () => { shadowMisc.uploading = false; });
        } else {
          shadowMisc.uploading = false;
        }
      } catch {
        shadowMisc.uploading = false;
      }
    }

    if (!shadowMisc.draw) {
      shadowMisc.draw = {
        pipeline: ref.pipeline,
        index: ref.index,
        geometry: shadowMisc.handle,
        instances: null,
        groups: ref.groups,
        shadowGroups: ref.shadowGroups ?? null,
        bounds: shadowMisc.bounds,
        shadowIndex: ref.shadowIndex ?? 0,
        castsShadow: true,
        shadowOnly: true,
      };
    } else {
      shadowMisc.draw.pipeline = ref.pipeline;
      shadowMisc.draw.index = ref.index;
      shadowMisc.draw.groups = ref.groups;
      shadowMisc.draw.shadowGroups = ref.shadowGroups ?? null;
      shadowMisc.draw.shadowIndex = ref.shadowIndex ?? 0;
      shadowMisc.draw.bounds = shadowMisc.bounds;
      shadowMisc.draw.castsShadow = true;
      shadowMisc.draw.shadowOnly = true;
    }
    return shadowMisc.draw;
  }

  // Current world basis for ego (maps local right-handed +X right, +Y up, +Z back -> origin-rel world)
  const basis = {
    ox: 0, oy: 0, oz: 0,
    rx: 1, ry: 0, rz: 0,
    ux: 0, uy: 1, uz: 0,
    bx: 0, by: 0, bz: 1,
  };

  function beginMesh() {
    vertCount = 0;
    idxCount = 0;
  }

  function pushVert(lx, ly, lz, lnx, lny, lnz, col, shine) {
    if (vertCount >= MAX_VERTS) return vertCount - 1;
    const i = vertCount * 10;
    vertData[i]     = basis.ox + basis.rx * lx + basis.ux * ly + basis.bx * lz;
    vertData[i + 1] = basis.oy + basis.ry * lx + basis.uy * ly + basis.by * lz;
    vertData[i + 2] = basis.oz + basis.rz * lx + basis.uz * ly + basis.bz * lz;
    vertData[i + 3] = basis.rx * lnx + basis.ux * lny + basis.bx * lnz;
    vertData[i + 4] = basis.ry * lnx + basis.uy * lny + basis.by * lnz;
    vertData[i + 5] = basis.rz * lnx + basis.uz * lny + basis.bz * lnz;
    vertData[i + 6] = col[0];
    vertData[i + 7] = col[1];
    vertData[i + 8] = col[2];
    vertData[i + 9] = shine;
    return vertCount++;
  }

  function pushTriIdx(a, b, c) {
    if (idxCount + 3 > MAX_INDICES) return;
    idxData[idxCount++] = a;
    idxData[idxCount++] = b;
    idxData[idxCount++] = c;
  }

  function pushQuad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, col, shine) {
    const i0 = pushVert(ax, ay, az, nx, ny, nz, col, shine);
    const i1 = pushVert(bx, by, bz, nx, ny, nz, col, shine);
    const i2 = pushVert(cx, cy, cz, nx, ny, nz, col, shine);
    const i3 = pushVert(dx, dy, dz, nx, ny, nz, col, shine);
    pushTriIdx(i0, i1, i2);
    pushTriIdx(i0, i2, i3);
  }

  function orthonormalBasis(fx, fy, fz) {
    let ux = Math.abs(fx) < 0.85 ? 1 : 0;
    let uy = Math.abs(fx) < 0.85 ? 0 : 1;
    let uz = 0;
    let vx = fy * uz - fz * uy;
    let vy = fz * ux - fx * uz;
    let vz = fx * uy - fy * ux;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl; vy /= vl; vz /= vl;
    ux = vy * fz - vz * fy;
    uy = vz * fx - vx * fz;
    uz = vx * fy - vy * fx;
    return [ux, uy, uz, vx, vy, vz];
  }

  // Oriented rectangular beam from p0 to p1 (hw along U, ht along V)
  function addBoxBeam(x0, y0, z0, x1, y1, z1, hw, ht, col, shine) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const fx = dx / len, fy = dy / len, fz = dz / len;
    const [ux, uy, uz, vx, vy, vz] = orthonormalBasis(fx, fy, fz);

    const p = (bx, by, bz, su, sv) => [
      bx + ux * su * hw + vx * sv * ht,
      by + uy * su * hw + vy * sv * ht,
      bz + uz * su * hw + vz * sv * ht,
    ];
    const a0 = p(x0, y0, z0, -1, -1);
    const b0 = p(x0, y0, z0,  1, -1);
    const c0 = p(x0, y0, z0,  1,  1);
    const d0 = p(x0, y0, z0, -1,  1);
    const a1 = p(x1, y1, z1, -1, -1);
    const b1 = p(x1, y1, z1,  1, -1);
    const c1 = p(x1, y1, z1,  1,  1);
    const d1 = p(x1, y1, z1, -1,  1);

    pushQuad(d0[0], d0[1], d0[2], c0[0], c0[1], c0[2], b0[0], b0[1], b0[2], a0[0], a0[1], a0[2], -fx, -fy, -fz, col, shine);
    pushQuad(a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], c1[0], c1[1], c1[2], d1[0], d1[1], d1[2], fx, fy, fz, col, shine);
    pushQuad(a0[0], a0[1], a0[2], b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], a1[0], a1[1], a1[2], -vx, -vy, -vz, col, shine);
    pushQuad(b0[0], b0[1], b0[2], c0[0], c0[1], c0[2], c1[0], c1[1], c1[2], b1[0], b1[1], b1[2], ux, uy, uz, col, shine);
    pushQuad(c0[0], c0[1], c0[2], d0[0], d0[1], d0[2], d1[0], d1[1], d1[2], c1[0], c1[1], c1[2], vx, vy, vz, col, shine);
    pushQuad(d0[0], d0[1], d0[2], a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], d1[0], d1[1], d1[2], -ux, -uy, -uz, col, shine);
  }

  // Smooth tapered cylinder / limb segment with rounded normals
  function addLimb(x0, y0, z0, x1, y1, z1, r0, r1, segs, col, shine) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return;
    const fx = dx / len, fy = dy / len, fz = dz / len;
    const [ux, uy, uz, vx, vy, vz] = orthonormalBasis(fx, fy, fz);

    const base0 = vertCount;
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = ux * ca + vx * sa;
      const ny = uy * ca + vy * sa;
      const nz = uz * ca + vz * sa;
      pushVert(x0 + nx * r0, y0 + ny * r0, z0 + nz * r0, nx, ny, nz, col, shine);
      pushVert(x1 + nx * r1, y1 + ny * r1, z1 + nz * r1, nx, ny, nz, col, shine);
    }
    for (let i = 0; i < segs; i++) {
      const next = (i + 1) % segs;
      const a0 = base0 + i * 2;
      const a1 = a0 + 1;
      const b0 = base0 + next * 2;
      const b1 = b0 + 1;
      pushTriIdx(a0, b0, b1);
      pushTriIdx(a0, b1, a1);
    }
  }

  // Smooth ellipsoid (for head, helmet, torso, joints)
  function addEllipsoid(cx, cy, cz, rx, ry, rz, rings, segs, col, shine, pitchRad) {
    const cp = pitchRad ? Math.cos(pitchRad) : 1;
    const sp = pitchRad ? Math.sin(pitchRad) : 0;
    const base = vertCount;
    for (let r = 0; r <= rings; r++) {
      const phi = (r / rings) * Math.PI;
      const sphi = Math.sin(phi), cphi = Math.cos(phi);
      for (let s = 0; s < segs; s++) {
        const th = (s / segs) * Math.PI * 2;
        const sx = sphi * Math.cos(th);
        const sy = cphi;
        const sz = sphi * Math.sin(th);
        // Pitch around local X
        const py0 = sy * ry;
        const pz0 = sz * rz;
        const px = cx + sx * rx;
        const py = cy + py0 * cp - pz0 * sp;
        const pz = cz + py0 * sp + pz0 * cp;
        const nny = sy * cp - sz * sp;
        const nnz = sy * sp + sz * cp;
        pushVert(px, py, pz, sx, nny, nnz, col, shine);
      }
    }
    for (let r = 0; r < rings; r++) {
      for (let s = 0; s < segs; s++) {
        const sn = (s + 1) % segs;
        const a = base + r * segs + s;
        const b = base + r * segs + sn;
        const c = base + (r + 1) * segs + s;
        const d = base + (r + 1) * segs + sn;
        pushTriIdx(a, c, d);
        pushTriIdx(a, d, b);
      }
    }
  }

  // Detailed 20" Rowbike wheel with tire, brushed rim, hub, and spinning spokes
  function addRowbikeWheel(cx, cy, cz, rOuter, spinRad, steerRad, tireCol, rimCol, hubCol) {
    const cs = Math.cos(steerRad), ss = Math.sin(steerRad);
    const toSteer = (lx, ly, lz) => [
      cx + lx * cs + lz * ss,
      cy + ly,
      cz - lx * ss + lz * cs,
    ];
    const toSteerN = (nx, ny, nz) => [
      nx * cs + nz * ss,
      ny,
      -nx * ss + nz * cs,
    ];

    const segs = 18;
    const addRing = (rOut, rIn, halfW, col, shine) => {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);
        const nyM = Math.sin((a0 + a1) * 0.5);
        const nzM = Math.cos((a0 + a1) * 0.5);

        const p = (x, y, z) => toSteer(x, y, z);
        const r0i = p(halfW, s0 * rIn, c0 * rIn);
        const r0o = p(halfW, s0 * rOut, c0 * rOut);
        const r1o = p(halfW, s1 * rOut, c1 * rOut);
        const r1i = p(halfW, s1 * rIn, c1 * rIn);
        const l0i = p(-halfW, s0 * rIn, c0 * rIn);
        const l0o = p(-halfW, s0 * rOut, c0 * rOut);
        const l1o = p(-halfW, s1 * rOut, c1 * rOut);
        const l1i = p(-halfW, s1 * rIn, c1 * rIn);

        const nr = toSteerN(1, 0, 0);
        const nl = toSteerN(-1, 0, 0);
        const no = toSteerN(0, nyM, nzM);
        const ni = toSteerN(0, -nyM, -nzM);

        pushQuad(r0i[0], r0i[1], r0i[2], r0o[0], r0o[1], r0o[2], r1o[0], r1o[1], r1o[2], r1i[0], r1i[1], r1i[2], nr[0], nr[1], nr[2], col, shine);
        pushQuad(l1i[0], l1i[1], l1i[2], l1o[0], l1o[1], l1o[2], l0o[0], l0o[1], l0o[2], l0i[0], l0i[1], l0i[2], nl[0], nl[1], nl[2], col, shine);
        pushQuad(l0o[0], l0o[1], l0o[2], l1o[0], l1o[1], l1o[2], r1o[0], r1o[1], r1o[2], r0o[0], r0o[1], r0o[2], no[0], no[1], no[2], col, shine);
        pushQuad(r0i[0], r0i[1], r0i[2], r1i[0], r1i[1], r1i[2], l1i[0], l1i[1], l1i[2], l0i[0], l0i[1], l0i[2], ni[0], ni[1], ni[2], col, shine);
      }
    };

    const rRimOut = rOuter - 0.032;
    const rRimIn = rOuter - 0.056;
    addRing(rOuter, rRimOut, 0.023, tireCol, 0.08);
    addRing(rRimOut, rRimIn, 0.017, rimCol, 0.85);

    // Hub axle
    const hL = toSteer(-0.048, 0, 0);
    const hR = toSteer( 0.048, 0, 0);
    addLimb(hL[0], hL[1], hL[2], hR[0], hR[1], hR[2], 0.024, 0.024, 8, hubCol, 0.5);

    // 8 rotating spokes
    const spokeCount = 8;
    const spokeCol = shadeRgb(rimCol, 0.85);
    for (let i = 0; i < spokeCount; i++) {
      const a = spinRad + (i / spokeCount) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const sx = (i % 2 === 0 ? 0.024 : -0.024);
      const p0 = toSteer(sx, 0, 0);
      const p1 = toSteer(0, sa * rRimIn, ca * rRimIn);
      addBoxBeam(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], 0.004, 0.004, spokeCol, 0.8);
    }
  }

  /* ── 3. Analytical 2-Bone IK Solver ───────────────────────────────────────── */
  // Returns middle joint [x, y, z] given root A, target B, lengths L1, L2, and pole hint direction P
  function solveTwoBoneIK(ax, ay, az, bx, by, bz, L1, L2, px, py, pz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const rawD = Math.hypot(dx, dy, dz);
    const minD = Math.abs(L1 - L2) + 0.015;
    const maxD = L1 + L2 - 0.006;
    const d = clamp(rawD, minD, maxD);
    const invD = rawD > 1e-5 ? (1 / rawD) : 1;
    const fx = dx * invD, fy = dy * invD, fz = dz * invD;

    // Project pole vector orthogonal to AB
    const dot = px * fx + py * fy + pz * fz;
    let ox = px - fx * dot;
    let oy = py - fy * dot;
    let oz = pz - fz * dot;
    const ol = Math.hypot(ox, oy, oz);
    if (ol > 1e-5) {
      ox /= ol; oy /= ol; oz /= ol;
    } else {
      ox = 0; oy = 1; oz = 0;
    }

    const cosA = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const along = L1 * cosA;
    const perp = L1 * Math.sqrt(Math.max(0, 1 - cosA * cosA));
    return [
      ax + fx * along + ox * perp,
      ay + fy * along + oy * perp,
      az + fz * along + oz * perp,
    ];
  }

  /* ── 4. Biomechanical Rowing Stroke State + Mesh Assembly ─────────────────── */
  const anim = {
    lastMs: 0,
    lastDt: 1 / 60,
    spm: 0,
  };
  const riderStates = new WeakMap();

  function getRiderState(rider) {
    let st = riderStates.get(rider);
    if (!st) {
      st = {
        phase: 0.15,
        wheelSpin: 0,
        activeBlend: 1,
        lastHeading: null,
        smoothSteer: 0,
        smoothLean: 0,
        spm: 0,
        bonesBuf: null,
        nativeLean: 0,
      };
      riderStates.set(rider, st);
    }
    return st;
  }

  function computeStrokeKinematics(phase, blend) {
    let legProg, backProg, armProg;
    if (phase < 0.36) {
      // Explosive Drive (legs -> back -> arms)
      const d = smoothstep(0, 1, phase / 0.36);
      legProg = smoothstep(0.0, 0.72, d);
      backProg = smoothstep(0.18, 0.86, d);
      armProg = smoothstep(0.36, 1.0, d);
    } else {
      // Controlled Recovery (arms away -> body forward -> seat glide to catch, synced so arms never outrun the seat)
      const r = (phase - 0.36) / 0.64;
      armProg = 1 - smoothstep(0.0, 0.56, r);
      backProg = 1 - smoothstep(0.10, 0.68, r);
      legProg = 1 - smoothstep(0.18, 1.0, r);
    }

    // Blend toward relaxed upright coasting posture when stopped & animateWhenStopped=false
    const coastLeg = 0.55;
    const coastBack = 0.55;
    const coastArm = 0.35;
    return {
      leg: lerp(coastLeg, legProg, blend),
      back: lerp(coastBack, backProg, blend),
      arm: lerp(coastArm, armProg, blend),
    };
  }

  function stepRiderAnimation(rider, st, dt, isEgo) {
    const sim = rider && rider.sim;
    const now = performance.now();
    const speed = (sim && Number.isFinite(sim.speed)) ? Math.max(0, sim.speed) : 0;
    const power = (sim && Number.isFinite(sim.power)) ? Math.max(0, sim.power) : 0;
    let cad = (sim && Number.isFinite(sim.cadence)) ? Math.max(0, sim.cadence) : 0;
    if (cad <= 0 && sim) {
      const sid = sim.id ?? sim.athleteId ?? rider.id ?? null;
      if (sid != null && bleRow.spmById.has(String(sid))) {
        cad = bleRow.spmById.get(String(sid));
      } else {
        const nm = btRiderFullName(rider);
        if (nm && bleRow.spmByName.has(nm)) cad = bleRow.spmByName.get(nm);
      }
    }

    // Spin 20" wheels (r = 0.255m) matching ground speed
    st.wheelSpin = (st.wheelSpin + (speed * dt) / 0.255) % (Math.PI * 2);

    // Determine live stroke rate (SPM)
    let spm = 0;
    if (isEgo && bleRow.spm > 4 && (now - bleRow.lastSpmMs) < 5000) {
      spm = clamp(bleRow.spm, 12, 46);
    } else if (cad > 5) {
      // Direct SPM if <= 45 (rower), or scaled cycling cadence -> realistic rowing SPM
      spm = cad <= 45 ? clamp(cad, 14, 45) : clamp(cad * 0.32, 18, 36);
    } else if (power > 10) {
      spm = clamp(18 + power / 18, 18, 36);
    } else if (speed > 0.6) {
      spm = clamp(Number(S.demoSpm) || 22, 14, 40);
    } else if (S.animateWhenStopped) {
      spm = clamp(Number(S.demoSpm) || 24, 10, 42);
    }

    st.spm = spm;
    const targetBlend = spm > 1 ? 1 : 0;
    st.activeBlend += (targetBlend - st.activeBlend) * Math.min(1, dt * 4.0);
    if (spm > 1) {
      st.phase = (st.phase + dt * (spm / 60)) % 1;
    }
  }

  /* ── 4b. Real Biketerra 22-Bone Rider Skeleton Rowing Solver ──────────────── */
  // Exact bind-pose joint positions from Biketerra's shared 22-bone rider skeleton
  // Converted from GLB bind space (+X=Fwd, +Y=Up, +Z=Right) -> Rowbike space (+X=Right, +Y=Up, +Z=Back):
  //   rbX = bindZ, rbY = bindY, rbZ = -bindX
  const BONE_BIND_RB = [
    [ 0.0000, 0.9971,  0.1533], //  0: root
    [ 0.0000, 0.9923,  0.0548], //  1: spine.1
    [ 0.0000, 1.1389,  0.0341], //  2: spine.2
    [ 0.0000, 1.2516,  0.0321], //  3: spine.3
    [ 0.0000, 1.4823,  0.0402], //  4: neck
    [-0.0006, 1.5661,  0.0192], //  5: head
    [ 0.0000, 1.4823,  0.0402], //  6: shoulder.l
    [-0.1670, 1.4475,  0.0508], //  7: upperArm.l
    [-0.2507, 1.2914, -0.1415], //  8: forearm.l
    [-0.3144, 1.2576, -0.3737], //  9: hand.l
    [-0.3230, 1.2475, -0.4864], // 10: fingers.l
    [ 0.0000, 1.4823,  0.0402], // 11: shoulder.r
    [ 0.1717, 1.4475,  0.0508], // 12: upperArm.r
    [ 0.2554, 1.2977, -0.1443], // 13: forearm.r
    [ 0.3059, 1.2580, -0.3731], // 14: hand.r
    [ 0.3242, 1.2369, -0.4867], // 15: fingers.r
    [-0.1220, 0.9076,  0.0048], // 16: upperLeg.l
    [-0.1015, 0.5285, -0.0263], // 17: lowerLeg.l
    [-0.1054, 0.1049,  0.0208], // 18: foot.l
    [ 0.1220, 0.9076,  0.0048], // 19: upperLeg.r
    [ 0.1015, 0.5285, -0.0263], // 20: lowerLeg.r
    [ 0.1054, 0.1049,  0.0208], // 21: foot.r
  ];

  function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vLen(a) { return Math.hypot(a[0], a[1], a[2]); }
  function vNorm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vCross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }
  function m3RotX(ang) {
    // Rotation around Rowbike +X (Right): +ang pitches +Y (Up) -> +Z (Back) and -Z (Fwd) -> +Y (Up)
    const c = Math.cos(ang), s = Math.sin(ang);
    return [
      [1, 0, 0],
      [0, c, s],
      [0, -s, c],
    ];
  }
  function m3MulVec(m, v) {
    return [
      m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
      m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
      m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ];
  }
  function m3Mul(a, b) {
    return [m3MulVec(a, b[0]), m3MulVec(a, b[1]), m3MulVec(a, b[2])];
  }
  // Rotation by `ang` radians about unit axis `a` (Rodrigues), column-array like the other m3 helpers
  function m3RotAxis(a, ang) {
    const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    const x = a[0], y = a[1], z = a[2];
    return [
      [t * x * x + c,     t * x * y + s * z, t * x * z - s * y],
      [t * x * y - s * z, t * y * y + c,     t * y * z + s * x],
      [t * x * z + s * y, t * y * z - s * x, t * z * z + c    ],
    ];
  }
  // Pure swing rotation taking direction v1 toward v2, scaled by `frac` (no roll component)
  function m3Swing(v1, v2, frac) {
    const a = vNorm(v1), b = vNorm(v2);
    const ax = vCross(a, b);
    const s = vLen(ax);
    if (s < 1e-5) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const ang = Math.atan2(s, vDot(a, b));
    return m3RotAxis([ax[0] / s, ax[1] / s, ax[2] / s], ang * frac);
  }
  // Anisotropic radial scale along orthonormal directions u1 (by s1) and u2 (by s2), preserving length along the bone axis
  function m3AnisoScale(u1, s1, u2, s2) {
    const d1 = s1 - 1, d2 = s2 - 1;
    return [
      [1 + d1 * u1[0] * u1[0] + d2 * u2[0] * u2[0],     d1 * u1[0] * u1[1] + d2 * u2[0] * u2[1],     d1 * u1[0] * u1[2] + d2 * u2[0] * u2[2]],
      [    d1 * u1[1] * u1[0] + d2 * u2[1] * u2[0], 1 + d1 * u1[1] * u1[1] + d2 * u2[1] * u2[1],     d1 * u1[1] * u1[2] + d2 * u2[1] * u2[2]],
      [    d1 * u1[2] * u1[0] + d2 * u2[2] * u2[0],     d1 * u1[2] * u1[1] + d2 * u2[2] * u2[1], 1 + d1 * u1[2] * u1[2] + d2 * u2[2] * u2[2]],
    ];
  }
  function buildBasis3(primary, ref) {
    const u1 = vNorm(primary);
    const d = vDot(ref, u1);
    let r = [ref[0] - u1[0] * d, ref[1] - u1[1] * d, ref[2] - u1[2] * d];
    if (vLen(r) < 1e-4) {
      const fb = Math.abs(u1[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
      const d2 = vDot(fb, u1);
      r = [fb[0] - u1[0] * d2, fb[1] - u1[1] * d2, fb[2] - u1[2] * d2];
    }
    const u0 = vNorm(r);
    const u2 = vCross(u0, u1);
    return [u0, u1, u2];
  }
  function alignFrame(dBind, refBind, dPose, refPose) {
    // Returns 3x3 column-array rotation R such that R * dBind = dPose and R * ortho(refBind) = ortho(refPose)
    const bB = buildBasis3(dBind, refBind);
    const bP = buildBasis3(dPose, refPose);
    // R = bP * bB^T
    const c0 = [
      bP[0][0] * bB[0][0] + bP[1][0] * bB[1][0] + bP[2][0] * bB[2][0],
      bP[0][1] * bB[0][0] + bP[1][1] * bB[1][0] + bP[2][1] * bB[2][0],
      bP[0][2] * bB[0][0] + bP[1][2] * bB[1][0] + bP[2][2] * bB[2][0],
    ];
    const c1 = [
      bP[0][0] * bB[0][1] + bP[1][0] * bB[1][1] + bP[2][0] * bB[2][1],
      bP[0][1] * bB[0][1] + bP[1][1] * bB[1][1] + bP[2][1] * bB[2][1],
      bP[0][2] * bB[0][1] + bP[1][2] * bB[1][1] + bP[2][2] * bB[2][1],
    ];
    const c2 = [
      bP[0][0] * bB[0][2] + bP[1][0] * bB[1][2] + bP[2][0] * bB[2][2],
      bP[0][1] * bB[0][2] + bP[1][1] * bB[1][2] + bP[2][1] * bB[2][2],
      bP[0][2] * bB[0][2] + bP[1][2] * bB[1][2] + bP[2][2] * bB[2][2],
    ];
    return [c0, c1, c2];
  }

  // Precomputed bone lengths & bind-pose directions/bend planes
  const LEG_THIGH_L = vLen(vSub(BONE_BIND_RB[17], BONE_BIND_RB[16]));
  const LEG_SHIN_L  = vLen(vSub(BONE_BIND_RB[18], BONE_BIND_RB[17]));
  const LEG_THIGH_R = vLen(vSub(BONE_BIND_RB[20], BONE_BIND_RB[19]));
  const LEG_SHIN_R  = vLen(vSub(BONE_BIND_RB[21], BONE_BIND_RB[20]));
  const ARM_UP_L    = vLen(vSub(BONE_BIND_RB[8],  BONE_BIND_RB[7]));
  const ARM_FORE_L  = vLen(vSub(BONE_BIND_RB[9],  BONE_BIND_RB[8]));
  const ARM_UP_R    = vLen(vSub(BONE_BIND_RB[13], BONE_BIND_RB[12]));
  const ARM_FORE_R  = vLen(vSub(BONE_BIND_RB[14], BONE_BIND_RB[13]));
  const MID_HIP_BIND_RB = [
    0,
    (BONE_BIND_RB[16][1] + BONE_BIND_RB[19][1]) * 0.5,
    (BONE_BIND_RB[16][2] + BONE_BIND_RB[19][2]) * 0.5,
  ];
  // Bind-pose arm bend directions (from shoulder-hand midpoint toward elbow)
  const ARM_BEND_BIND_L = vNorm(vSub(BONE_BIND_RB[8], [
    (BONE_BIND_RB[7][0] + BONE_BIND_RB[9][0]) * 0.5,
    (BONE_BIND_RB[7][1] + BONE_BIND_RB[9][1]) * 0.5,
    (BONE_BIND_RB[7][2] + BONE_BIND_RB[9][2]) * 0.5,
  ]));
  const ARM_BEND_BIND_R = vNorm(vSub(BONE_BIND_RB[13], [
    (BONE_BIND_RB[12][0] + BONE_BIND_RB[14][0]) * 0.5,
    (BONE_BIND_RB[12][1] + BONE_BIND_RB[14][1]) * 0.5,
    (BONE_BIND_RB[12][2] + BONE_BIND_RB[14][2]) * 0.5,
  ]));

  // Foot / footplate geometry shared by the avatar solver and the bike mesh:
  // ankle target in steering-local coords, constant foot pitch, ankle-to-sole height (unscaled).
  const ANKLE_LOCAL = [0.140, 0.505, -0.440];
  const FOOT_PITCH = 0.80;
  const FOOT_ANKLE_H = 0.105;
  // Share of the forearm->hand roll absorbed by the forearm / upper arm bones (rest stays at the wrist)
  // Keep UPPERARM_TWIST_SHARE at 0 so the upperArm never candy-wrapper twists against spine.3!
  const FOREARM_TWIST_SHARE = 0.65;
  const UPPERARM_TWIST_SHARE = 0.0;
  // How much of the upper arm's swing the shoulder bone follows (0 = locked to torso)
  const SHOULDER_FOLLOW = 0.65;

  const realBoneMatrices = new Float32Array(22 * 16);
  const shadowBikeBones = new Float32Array(22 * 16);

  function fillShadowBikeBones(scale) {
    // Collapses the native Canyon bike mesh along its local Right axis (X_rb -> 18%) and lowers
    // it slightly so the native shadow pass casts an authentic shadow-map shadow for the Rowbike!
    const sc = scale || 1;
    const sx = 0.18 * sc, sy = 0.92 * sc, sz = 0.94 * sc;
    const ty = -0.04, tz = 0.02;
    const c0x = -sz * basis.bx, c0y = -sz * basis.by, c0z = -sz * basis.bz;
    const c1x =  sy * basis.ux, c1y =  sy * basis.uy, c1z =  sy * basis.uz;
    const c2x =  sx * basis.rx, c2y =  sx * basis.ry, c2z =  sx * basis.rz;
    const c3x = basis.ox + ty * basis.ux + tz * basis.bx;
    const c3y = basis.oy + ty * basis.uy + tz * basis.by;
    const c3z = basis.oz + ty * basis.uz + tz * basis.bz;
    for (let idx = 0; idx < 22; idx++) {
      const o = idx * 16;
      shadowBikeBones[o + 0] = c0x; shadowBikeBones[o + 1] = c0y; shadowBikeBones[o + 2] = c0z; shadowBikeBones[o + 3] = 0;
      shadowBikeBones[o + 4] = c1x; shadowBikeBones[o + 5] = c1y; shadowBikeBones[o + 6] = c1z; shadowBikeBones[o + 7] = 0;
      shadowBikeBones[o + 8] = c2x; shadowBikeBones[o + 9] = c2y; shadowBikeBones[o + 10] = c2z; shadowBikeBones[o + 11] = 0;
      shadowBikeBones[o + 12] = c3x; shadowBikeBones[o + 13] = c3y; shadowBikeBones[o + 14] = c3z; shadowBikeBones[o + 15] = 1;
    }
  }

  function writeSkinBone(idx, R_rb, P_pose_rb, scale) {
    // M_skin = M_rowbikeToWorld * Translate(P_pose_rb) * R_rb * Scale(scale) * Translate(-P_bind_rb) * T_bindToRowbike
    const pB = BONE_BIND_RB[idx];
    const c0 = R_rb[0], c1 = R_rb[1], c2 = R_rb[2];
    const sc = scale || 1;
    // t_rb = P_pose_rb - sc * (R_rb * P_bind_rb)
    const rbx = c0[0] * pB[0] + c1[0] * pB[1] + c2[0] * pB[2];
    const rby = c0[1] * pB[0] + c1[1] * pB[1] + c2[1] * pB[2];
    const rbz = c0[2] * pB[0] + c1[2] * pB[1] + c2[2] * pB[2];
    const tx = P_pose_rb[0] - sc * rbx;
    const ty = P_pose_rb[1] - sc * rby;
    const tz = P_pose_rb[2] - sc * rbz;

    const o = idx * 16;
    // Col 0 (Bind +X -> Rowbike -c2 * sc)
    realBoneMatrices[o + 0]  = (-c2[0] * basis.rx - c2[1] * basis.ux - c2[2] * basis.bx) * sc;
    realBoneMatrices[o + 1]  = (-c2[0] * basis.ry - c2[1] * basis.uy - c2[2] * basis.by) * sc;
    realBoneMatrices[o + 2]  = (-c2[0] * basis.rz - c2[1] * basis.uz - c2[2] * basis.bz) * sc;
    realBoneMatrices[o + 3]  = 0;
    // Col 1 (Bind +Y -> Rowbike +c1 * sc)
    realBoneMatrices[o + 4]  = ( c1[0] * basis.rx + c1[1] * basis.ux + c1[2] * basis.bx) * sc;
    realBoneMatrices[o + 5]  = ( c1[0] * basis.ry + c1[1] * basis.uy + c1[2] * basis.by) * sc;
    realBoneMatrices[o + 6]  = ( c1[0] * basis.rz + c1[1] * basis.uz + c1[2] * basis.bz) * sc;
    realBoneMatrices[o + 7]  = 0;
    // Col 2 (Bind +Z -> Rowbike +c0 * sc)
    realBoneMatrices[o + 8]  = ( c0[0] * basis.rx + c0[1] * basis.ux + c0[2] * basis.bx) * sc;
    realBoneMatrices[o + 9]  = ( c0[0] * basis.ry + c0[1] * basis.uy + c0[2] * basis.by) * sc;
    realBoneMatrices[o + 10] = ( c0[0] * basis.rz + c0[1] * basis.uz + c0[2] * basis.bz) * sc;
    realBoneMatrices[o + 11] = 0;
    // Col 3 (Translation: basis.O + W(t_rb))
    realBoneMatrices[o + 12] = basis.ox + tx * basis.rx + ty * basis.ux + tz * basis.bx;
    realBoneMatrices[o + 13] = basis.oy + tx * basis.ry + ty * basis.uy + tz * basis.by;
    realBoneMatrices[o + 14] = basis.oz + tx * basis.rz + ty * basis.uz + tz * basis.bz;
    realBoneMatrices[o + 15] = 1;
  }

  function poseRealBiketerraAvatar(ego, k, seatY, seatZ, barY, barZ, steerPt) {
    const sc = (ego && Number.isFinite(ego.renderScale) && ego.renderScale > 0.2) ? ego.renderScale : 1;

    // Note on Rowbike +X rotation sign:
    //   negative angle = lean FORWARD (Catch, toward -Z)
    //   positive angle = lay BACK (Finish, toward +Z)
    const torsoPitch = lerp(-0.46, 0.26, k.back); // leans well forward at the catch (arms straight) -> +15° layback at finish

    // Smoothly articulated pelvis -> spine -> neck -> level head (eyes always looking down the road!)
    const R0 = m3RotX(torsoPitch * 0.30); // root / pelvis
    const R1 = m3RotX(torsoPitch * 0.60); // spine.1
    const R2 = m3RotX(torsoPitch * 0.85); // spine.2
    const R3 = m3RotX(torsoPitch * 1.00); // spine.3
    const R4 = m3RotX(torsoPitch * 0.40); // neck
    const R5 = m3RotX(torsoPitch * 0.05); // head (stays level!)

    // Place mid-hip joint directly over the sliding black seat pad
    // (slid back ~5 cm so the handlebar no longer clips into the chest)
    // Hips sink onto the saddle at the catch (front) and sit at full height at the finish (back)
    const hipTarget = [0, seatY + lerp(0.082, 0.115, k.leg), seatZ + 0.04];
    // Ankle targets: with the foot pitched ~45° the MID-foot (not the heel) rests on the plate top (~0.437)
    const footTargets = [-1, 1].map((side) => steerPt(side * ANKLE_LOCAL[0], ANKLE_LOCAL[1], ANKLE_LOCAL[2]));
    // Keep both legs a little short of full extension. (a) a fully stretched leg makes the IK clamp and
    // drags the feet off the pegs, (b) near lock-out the knee swings very fast for tiny hip movement,
    // which showed up as the legs "snapping"/vibrating. The hip pull-back is solved in closed form and
    // blended smoothly (no stepping, no kink) so there is no frame-to-frame jitter.
    const legReach = (LEG_THIGH_L + LEG_SHIN_L) * sc * 0.975;
    const hipLocal = [16, 19].map((i) => m3MulVec(R0, vSub(BONE_BIND_RB[i], MID_HIP_BIND_RB)));
    let needShift = -1;
    for (let i = 0; i < 2; i++) {
      const hx = hipTarget[0] + hipLocal[i][0] * sc;
      const hy = hipTarget[1] + hipLocal[i][1] * sc;
      const hz = hipTarget[2] + hipLocal[i][2] * sc;
      const dx = footTargets[i][0] - hx, dy = footTargets[i][1] - hy;
      const avail = Math.sqrt(Math.max(legReach * legReach - dx * dx - dy * dy, 0));
      // hip may sit at most `avail` behind the foot along Z
      needShift = Math.max(needShift, (hz - footTargets[i][2]) - avail);
    }
    const SOFT = 0.02;
    hipTarget[2] -= 0.5 * (Math.sqrt(needShift * needShift + SOFT * SOFT) + needShift);
    const rootOff = m3MulVec(R0, vSub(BONE_BIND_RB[0], MID_HIP_BIND_RB));
    const P0 = [hipTarget[0] + rootOff[0] * sc, hipTarget[1] + rootOff[1] * sc, hipTarget[2] + rootOff[2] * sc];

    const stepJoint = (parentP, parentR, pIdx, cIdx) => {
      const d = m3MulVec(parentR, vSub(BONE_BIND_RB[cIdx], BONE_BIND_RB[pIdx]));
      return [parentP[0] + d[0] * sc, parentP[1] + d[1] * sc, parentP[2] + d[2] * sc];
    };

    const P1 = stepJoint(P0, R0, 0, 1);
    const P2 = stepJoint(P1, R1, 1, 2);
    const P3 = stepJoint(P2, R2, 2, 3);
    const P4 = stepJoint(P3, R3, 3, 4);
    const P5 = stepJoint(P4, R4, 4, 5);

    writeSkinBone(0, R0, P0, sc);
    writeSkinBone(1, R1, P1, sc);
    writeSkinBone(2, R2, P2, sc);
    writeSkinBone(3, R3, P3, sc);
    writeSkinBone(4, R4, P4, sc);
    writeSkinBone(5, R5, P5, sc);

    // ── Legs (16..18 left, 19..21 right): 2-bone IK welded to Rowbike front fork footpegs ──
    const footPitch = FOOT_PITCH; // constant ~45° so the sole stays flush on the angled footplate
    const legs = [
      { side: -1, hipI: 16, kneeI: 17, footI: 18, lThigh: LEG_THIGH_L * sc, lShin: LEG_SHIN_L * sc },
      { side:  1, hipI: 19, kneeI: 20, footI: 21, lThigh: LEG_THIGH_R * sc, lShin: LEG_SHIN_R * sc },
    ];
    for (const lg of legs) {
      const pHip = stepJoint(P0, R0, 0, lg.hipI);
      const pFoot = footTargets[lg.side < 0 ? 0 : 1];
      const pKnee = solveTwoBoneIK(
        pHip[0], pHip[1], pHip[2],
        pFoot[0], pFoot[1], pFoot[2],
        lg.lThigh, lg.lShin,
        lg.side * 0.38, 1.0, -0.18 // knees splay OUT around the lever blades (as in the reference photos)
      );
      const rThigh = alignFrame(
        vSub(BONE_BIND_RB[lg.kneeI], BONE_BIND_RB[lg.hipI]), [1, 0, 0],
        vSub(pKnee, pHip), [1, 0, 0]
      );
      const rShin = alignFrame(
        vSub(BONE_BIND_RB[lg.footI], BONE_BIND_RB[lg.kneeI]), [1, 0, 0],
        vSub(pFoot, pKnee), [1, 0, 0]
      );
      // Use actual end of shin so ankle mesh never detaches even at extreme scale
      const pFootActual = stepJoint(pKnee, rShin, lg.kneeI, lg.footI);
      const rFoot = m3RotX(footPitch);

      writeSkinBone(lg.hipI,  rThigh, pHip,        sc);
      writeSkinBone(lg.kneeI, rShin,  pKnee,       sc);
      writeSkinBone(lg.footI, rFoot,  pFootActual, sc);
    }

    // ── Arms (6..10 left, 11..15 right): 2-bone IK welded to moving blue lever handlebars ──
    const arms = [
      {
        side: -1, shI: 6, upI: 7, foI: 8, haI: 9, fiI: 10,
        lUp: ARM_UP_L * sc, lFo: ARM_FORE_L * sc, bendBind: ARM_BEND_BIND_L,
      },
      {
        side: 1, shI: 11, upI: 12, foI: 13, haI: 14, fiI: 15,
        lUp: ARM_UP_R * sc, lFo: ARM_FORE_R * sc, bendBind: ARM_BEND_BIND_R,
      },
    ];
    for (const ar of arms) {
      // Stroke progress (same weighting as the lever): 0 = catch, 1 = finish.
      const pull = clamp(0.46 * k.leg + 0.30 * k.back + 0.24 * k.arm, 0, 1);
      const pSh = stepJoint(P3, R3, 3, ar.shI);
      const pUp0 = stepJoint(pSh, R3, ar.shI, ar.upI);
      // Natural scapula retraction at the finish (+2.8 cm back, +0.6 cm up) opens up the elbow
      // angle and prevents the upper arm from folding acutely against the forearm.
      const pUp = [pUp0[0], pUp0[1] + 0.006 * pull, pUp0[2] + 0.028 * pull];
      // Overhand grip: palm rests on top of the bar, knuckle joint sits just past the bar,
      // and the fingers curl down + back underneath it. Wrist is derived from the knuckle target
      // so the bar always passes through the palm/finger base regardless of avatar scale.
      const GRIP_PITCH = lerp(0.58, 0.42, pull);   // how steeply the hand points down over the bar
      const GRIP_ROLL_DEG = -121; // wrist roll about the forearm axis (was -31°; +90° more pronation). Flip sign if it rolls the wrong way
      const handLen  = vLen(vSub(BONE_BIND_RB[ar.haI], BONE_BIND_RB[ar.fiI])) * sc;
      const gripDir  = vNorm([0, -GRIP_PITCH, -(1 - GRIP_PITCH * 0.25)]);
      const rollRad  = GRIP_ROLL_DEG * Math.PI / 180;
      const gripUp   = [ar.side * Math.sin(rollRad), Math.cos(rollRad), 0];
      const pKnuckle = [ar.side * 0.225, barY - 0.008, barZ - 0.032];
      const pWrist = [
        pKnuckle[0] - gripDir[0] * handLen,
        pKnuckle[1] - gripDir[1] * handLen,
        pKnuckle[2] - gripDir[2] * handLen,
      ];
      // If the wrist target is near full arm extension (e.g. during early recovery when the hands push
      // the lever away before the seat finishes gliding forward), let the shoulder protract toward
      // the wrist so the IK never hits its maxD clamp and the hands stay 0.0 mm welded to the bar!
      const maxArmReach = ar.lUp + ar.lFo - 0.008;
      const dxW = pWrist[0] - pUp[0], dyW = pWrist[1] - pUp[1], dzW = pWrist[2] - pUp[2];
      const distW = Math.hypot(dxW, dyW, dzW);
      if (distW > maxArmReach && distW > 1e-4) {
        const shift = distW - maxArmReach;
        pUp[0] += (dxW / distW) * shift;
        pUp[1] += (dyW / distW) * shift;
        pUp[2] += (dzW / distW) * shift;
      }
      const pElbow = solveTwoBoneIK(
        pUp[0], pUp[1], pUp[2],
        pWrist[0], pWrist[1], pWrist[2],
        ar.lUp, ar.lFo,
        // elbows stay tucked DOWN along the ribs and drift back/out only slightly at the finish
        // (a high, wide pole made the upper arms swing up to horizontal)
        ar.side * lerp(0.36, 0.25, pull), lerp(-0.82, -0.90, pull), lerp(0.48, 0.40, pull)
      );
      const midArm = [
        (pUp[0] + pWrist[0]) * 0.5,
        (pUp[1] + pWrist[1]) * 0.5,
        (pUp[2] + pWrist[2]) * 0.5,
      ];
      let bendPose = vSub(pElbow, midArm);
      if (vLen(bendPose) < 0.01) bendPose = [ar.side * 0.3, -0.9, 0.3];

      const rUp0 = alignFrame(
        vSub(BONE_BIND_RB[ar.foI], BONE_BIND_RB[ar.upI]), ar.bendBind,
        vSub(pElbow, pUp), bendPose
      );
      const rFo0 = alignFrame(
        vSub(BONE_BIND_RB[ar.haI], BONE_BIND_RB[ar.foI]), ar.bendBind,
        vSub(pWrist, pElbow), bendPose
      );
      // Actual end of forearm guarantees 0.000 mm wrist seam continuity!
      const pWristActual = stepJoint(pElbow, rFo0, ar.foI, ar.haI);
      // Hand aims from wrist across the handlebar grip with knuckles facing up (+Y)
      const handDir = gripDir;
      const rHand = alignFrame(
        vSub(BONE_BIND_RB[ar.fiI], BONE_BIND_RB[ar.haI]), [0, 1, 0],
        handDir, gripUp
      );

      // Spread the forearm->hand roll along the arm instead of wringing it out at the wrist:
      // measure the twist between the forearm and hand about the forearm axis, then let the
      // forearm (and a bit of the upper arm) take most of it. Joint positions are unchanged
      // (twists are about each bone's own axis), only the skin deformation gets smoother.
      const axF = vNorm(vSub(pWristActual, pElbow));
      const axU = vNorm(vSub(pElbow, pUp));
      const perp = (v) => { const d = vDot(v, axF); return [v[0] - axF[0] * d, v[1] - axF[1] * d, v[2] - axF[2] * d]; };
      const uF = perp(m3MulVec(rFo0, [0, 1, 0]));
      const uH = perp(m3MulVec(rHand, [0, 1, 0]));
      let twist = 0;
      if (vLen(uF) > 1e-4 && vLen(uH) > 1e-4) {
        twist = Math.atan2(vDot(axF, vCross(uF, uH)), vDot(uF, uH));
      }
      const rFo = m3Mul(m3RotAxis(axF, twist * FOREARM_TWIST_SHARE), rFo0);
      const rUpTwist = UPPERARM_TWIST_SHARE !== 0 ? m3Mul(m3RotAxis(axU, twist * UPPERARM_TWIST_SHARE), rUp0) : rUp0;
      // Compensate for Linear Blend Skinning radial pinch in the bend plane when the elbow flexes:
      // inflate the upper-arm cross-section slightly along the bend plane (preserving bone length)
      // so the bicep/tricep stays round at the finish just like at the catch.
      const nPlane = vNorm(vCross(axU, bendPose));
      const inPlane = vNorm(vCross(nPlane, axU));
      const rUp = m3Mul(m3AnisoScale(inPlane, 1 + 0.20 * pull, nPlane, 1 + 0.05 * pull), rUpTwist);
      const pFing = stepJoint(pWristActual, rHand, ar.haI, ar.fiI);
      // Curl fingers downward (-X rot) around the grip bar
      const rFing = m3Mul(m3RotX(-1.9), rHand);

      // Shoulder (deltoid) bone follows part of the upper arm's swing, pivoting about the
      // shoulder-arm joint so that joint doesn't move. Without this the shoulder bone stays locked
      // to the torso while the arm swings ~50° away from it, and the sleeve/deltoid collapses flat.
      const swingQ = m3Swing(
        m3MulVec(R3, vSub(BONE_BIND_RB[ar.foI], BONE_BIND_RB[ar.upI])),
        vSub(pElbow, pUp),
        SHOULDER_FOLLOW
      );
      const rSh = m3Mul(swingQ, R3);
      const dSh = vSub(pSh, pUp);
      const dShR = m3MulVec(swingQ, dSh);
      const pShPose = [pUp[0] + dShR[0], pUp[1] + dShR[1], pUp[2] + dShR[2]];

      writeSkinBone(ar.shI, rSh,   pShPose,      sc);
      writeSkinBone(ar.upI, rUp,   pUp,          sc);
      writeSkinBone(ar.foI, rFo,   pElbow,       sc);
      writeSkinBone(ar.haI, rHand, pWristActual, sc);
      writeSkinBone(ar.fiI, rFing, pFing,        sc);
    }
  }

  function buildRowbikeAndRowerMesh(rider, st, ox, oz, useRealAvatar) {
    const sim = rider.sim;
    const mid = sim.midPosition || sim.position;
    if (!mid || !Number.isFinite(mid.x)) return false;

    // Forward unit vector along the bike (including exact road slope)
    let fx = 0, fy = 0, fz = -1;
    if (sim.frontPosition && sim.position) {
      const dfx = sim.frontPosition.x - sim.position.x;
      const dfy = sim.frontPosition.y - sim.position.y;
      const dfz = sim.frontPosition.z - sim.position.z;
      const dLen = Math.hypot(dfx, dfy, dfz);
      if (dLen > 0.15) {
        fx = dfx / dLen; fy = dfy / dLen; fz = dfz / dLen;
      }
    }
    if (Math.hypot(fx, fz) < 0.01) {
      const slope = Number.isFinite(sim.grade) ? sim.grade : 0;
      if (Number.isFinite(sim.dx) && Number.isFinite(sim.dz) && Math.hypot(sim.dx, sim.dz) > 0.01) {
        const l = Math.hypot(sim.dx, slope, sim.dz);
        fx = sim.dx / l; fy = slope / l; fz = sim.dz / l;
      } else if (Number.isFinite(sim.heading)) {
        const hx = Math.cos(sim.heading), hz = -Math.sin(sim.heading);
        const l = Math.hypot(hx, slope, hz);
        fx = hx / l; fy = slope / l; fz = hz / l;
      }
    }

    // Right-handed basis: +X right, +Y up, +Z backward (-F)
    let rx = -fz, ry = 0, rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    let ux = ry * fz - rz * fy;
    let uy = rz * fx - rx * fz;
    let uz = rx * fy - ry * fx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;

    // Corner lean & steering: prefer Biketerra's native rider_bones roll/steer when available,
    // otherwise compute physical banking atan2(v^2 * kappa, g) from steering / heading rate.
    let rawSteer = 0;
    if (Number.isFinite(sim.steerAngle) && Math.abs(sim.steerAngle) > 1e-4) {
      rawSteer = clamp(sim.steerAngle, -0.45, 0.45);
    } else if (Number.isFinite(sim.naturalSteerAngle) && Math.abs(sim.naturalSteerAngle) > 1e-4) {
      rawSteer = clamp(sim.naturalSteerAngle, -0.45, 0.45);
    } else if (Number.isFinite(sim.targetSteerAngle) && Math.abs(sim.targetSteerAngle) > 1e-4) {
      rawSteer = clamp(sim.targetSteerAngle, -0.45, 0.45);
    }

    const curHdg = Math.atan2(-fz, fx);
    const spd = Math.max(0, Number.isFinite(sim.speed) ? sim.speed : 0);
    const dt = anim.lastDt > 0 ? anim.lastDt : (1 / 60);
    if (Math.abs(rawSteer) < 1e-4 && st.lastHeading !== null && spd > 0.4 && dt > 1e-4) {
      let dh = curHdg - st.lastHeading;
      if (dh > Math.PI) dh -= Math.PI * 2;
      else if (dh < -Math.PI) dh += Math.PI * 2;
      const wb = (sim.bikeMetrics && sim.bikeMetrics.wheelBase) || 0.99;
      const kappa = (dh / dt) / Math.max(spd, 1.0);
      rawSteer = clamp(Math.atan(wb * kappa), -0.45, 0.45);
    }
    st.lastHeading = curHdg;

    const alphaSteer = 1 - Math.exp(-dt / 0.14);
    st.smoothSteer += (rawSteer - st.smoothSteer) * alphaSteer;
    const steer = st.smoothSteer;

    let targetLean = 0;
    if (Number.isFinite(sim.leanAngle) && Math.abs(sim.leanAngle) > 1e-4) {
      targetLean = sim.leanAngle;
    } else if (Number.isFinite(st.nativeLean) && Math.abs(st.nativeLean) > 1e-4) {
      targetLean = st.nativeLean;
    } else {
      const wb = (sim.bikeMetrics && sim.bikeMetrics.wheelBase) || 0.99;
      const kappa = Math.tan(steer) / wb;
      // Positive `lean` below banks RIGHT (+R -> -U, +U -> +R); turning right has steer < 0 (kappa < 0)
      targetLean = -Math.atan2(spd * spd * kappa, 9.81);
    }
    const alphaLean = 1 - Math.exp(-dt / 0.16);
    st.smoothLean += (clamp(targetLean, -0.48, 0.48) - st.smoothLean) * alphaLean;
    const lean = st.smoothLean;
    if (Math.abs(lean) > 0.001) {
      const cl = Math.cos(lean), sl = Math.sin(lean);
      const nrx = rx * cl - ux * sl, nry = ry * cl - uy * sl, nrz = rz * cl - uz * sl;
      const nux = rx * sl + ux * cl, nuy = ry * sl + uy * cl, nuz = rz * sl + uz * cl;
      rx = nrx; ry = nry; rz = nrz;
      ux = nux; uy = nuy; uz = nuz;
    }

    basis.ox = mid.x - ox;
    basis.oy = mid.y;
    basis.oz = mid.z - oz;
    basis.rx = rx; basis.ry = ry; basis.rz = rz;
    basis.ux = ux; basis.uy = uy; basis.uz = uz;
    basis.bx = -fx; basis.by = -fy; basis.bz = -fz;

    // Palette: Rowbike 720 Sport + live rider.design kit colors
    const d = (rider && rider.design) || {};
    const cRed     = hexToRgb(S.frameColor, '#c8242b');
    const cRedDark = shadeRgb(cRed, 0.72);
    const cBlue    = hexToRgb(S.leverColor, '#243ea8');
    const cBlueHi  = shadeRgb(cBlue, 1.25);
    const cBlack   = [0.11, 0.12, 0.14];
    const cCharc   = [0.19, 0.21, 0.24];
    const cTire    = [0.10, 0.105, 0.115];
    const cRim     = [0.78, 0.81, 0.85];
    const cCable   = [0.22, 0.24, 0.27];
    const cShadow  = [0.05, 0.05, 0.06];

    const cJersey  = hexToRgb(d.jersey_color, '#3b82f6');
    const cShorts  = hexToRgb(d.pants_color, '#1c2029');
    const cHelmet  = hexToRgb(d.helmet_color, '#e6e8ec');
    const cHelAcc  = hexToRgb(d.helmet_accent_color, '#38bdf8');
    const cSkin    = hexToRgb(d.skin_color, '#dfa986');
    const cSocks   = hexToRgb(d.sock_color, '#f1f5f9');
    const cShoes   = hexToRgb(d.shoe_color, '#1e2430');
    const cVisor   = [0.08, 0.11, 0.16];

    const k = computeStrokeKinematics(st.phase, st.activeBlend);

    const startVerts = vertCount;
    const startIdx = idxCount;

    /* ── A. Subtle ground contact shadow oval (only when stylized; real avatar casts native shadows) ── */
    if (!useRealAvatar) {
      const shSegs = 14;
      const shCenter = pushVert(0, 0.012, 0.04, 0, 1, 0, cShadow, 0);
      for (let i = 0; i < shSegs; i++) {
        const a0 = (i / shSegs) * Math.PI * 2;
        const a1 = ((i + 1) / shSegs) * Math.PI * 2;
        const v0 = pushVert(Math.cos(a0) * 0.28, 0.012, 0.04 + Math.sin(a0) * 0.82, 0, 1, 0, cShadow, 0);
        const v1 = pushVert(Math.cos(a1) * 0.28, 0.012, 0.04 + Math.sin(a1) * 0.82, 0, 1, 0, cShadow, 0);
        pushTriIdx(shCenter, v1, v0);
      }
    }

    /* ── B. Rowbike 720 Sport Frame & Wheels ──────────────────────────────── */
    const wheelR = 0.255;
    // Rear & Front 20" wheels
    addRowbikeWheel(0, wheelR,  0.64, wheelR, st.wheelSpin, 0, cTire, cRim, cCharc);
    addRowbikeWheel(0, wheelR, -0.58, wheelR, st.wheelSpin, steer, cTire, cRim, cCharc);

    // Iconic straight red horizontal sliding seat rail
    addBoxBeam(0, 0.67,  0.58, 0, 0.66, -0.44, 0.028, 0.032, cRed, 0.55);
    addBoxBeam(0, 0.67,  0.60, 0, 0.67,  0.57, 0.031, 0.035, cBlack, 0.2); // rear rail endcap
    addBoxBeam(0, 0.66, -0.43, 0, 0.66, -0.46, 0.031, 0.035, cBlack, 0.2); // front rail endcap

    // Sweeping lower red main frame beam + diagonal braces
    addLimb(0, 0.56, -0.45, 0, 0.43, -0.10, 0.028, 0.026, 8, cRed, 0.55);
    addLimb(0, 0.43, -0.10, 0, 0.37,  0.14, 0.026, 0.026, 8, cRed, 0.55);
    addLimb(0, 0.37,  0.14, 0, 0.64,  0.46, 0.024, 0.024, 8, cRed, 0.55);
    addLimb(0, 0.42,  0.04, 0, 0.65,  0.22, 0.018, 0.018, 6, cRedDark, 0.45);

    // Red rear triangle (chainstays + seatstays) + rear cassette/derailleur
    addLimb(-0.056, wheelR, 0.64, -0.036, 0.38, 0.14, 0.015, 0.017, 6, cRed, 0.5);
    addLimb( 0.056, wheelR, 0.64,  0.036, 0.38, 0.14, 0.015, 0.017, 6, cRed, 0.5);
    addLimb(-0.056, wheelR, 0.64, -0.032, 0.65, 0.44, 0.014, 0.015, 6, cRed, 0.5);
    addLimb( 0.056, wheelR, 0.64,  0.032, 0.65, 0.44, 0.014, 0.015, 6, cRed, 0.5);
    addEllipsoid(0.068, wheelR, 0.64, 0.022, 0.068, 0.068, 5, 10, cCharc, 0.6, 0); // cassette
    addBoxBeam(0.075, wheelR - 0.02, 0.64, 0.075, wheelR - 0.10, 0.66, 0.014, 0.018, cBlack, 0.3); // derailleur

    // Black front head tube, fork blades & contoured footplates (steer-aligned)
    addLimb(0, 0.70, -0.45, 0, 0.49, -0.50, 0.030, 0.028, 8, cBlack, 0.35);
    const fcs = Math.cos(steer), fss = Math.sin(steer);
    const steerPt = (lx, ly, lz) => [
      lx * fcs + (lz + 0.50) * fss,
      ly,
      -0.50 - lx * fss + (lz + 0.50) * fcs,
    ];
    for (const side of [-1, 1]) {
      const fTop = steerPt(side * 0.050, 0.51, -0.50);
      const fBot = steerPt(side * 0.052, wheelR, -0.58);
      addLimb(fTop[0], fTop[1], fTop[2], fBot[0], fBot[1], fBot[2], 0.018, 0.014, 6, cBlack, 0.35);
      // Angled footplate: tilted to exactly match the foot's pitch and placed under the sole,
      // so the WHOLE sole (heel -> ball) rests on it instead of only the heel.
      const fsc = (rider && Number.isFinite(rider.renderScale) && rider.renderScale > 0.2) ? rider.renderScale : 1;
      const fc = Math.cos(FOOT_PITCH), fs = Math.sin(FOOT_PITCH);
      const sole = [
        side * ANKLE_LOCAL[0],
        ANKLE_LOCAL[1] - FOOT_ANKLE_H * fsc * fc,
        ANKLE_LOCAL[2] - FOOT_ANKLE_H * fsc * fs,
      ];
      // sole forward dir (up + toward -Z) and plate thickness offset (below the sole)
      const plateC = [sole[0], sole[1] - 0.012 * fc, sole[2] - 0.012 * fs];
      const pBack = steerPt(plateC[0], plateC[1] - 0.075 * fs, plateC[2] + 0.075 * fc);
      const pFront = steerPt(plateC[0], plateC[1] + 0.150 * fs, plateC[2] - 0.150 * fc);
      addBoxBeam(pBack[0], pBack[1], pBack[2], pFront[0], pFront[1], pFront[2], 0.050, 0.012, cCharc, 0.2);
      // Small heel stop at the rear edge of the plate
      const hsA = steerPt(plateC[0], plateC[1] - 0.075 * fs, plateC[2] + 0.075 * fc);
      const hsB = steerPt(plateC[0], plateC[1] - 0.075 * fs + 0.035 * fc, plateC[2] + 0.075 * fc + 0.035 * fs);
      addBoxBeam(hsA[0], hsA[1], hsA[2], hsB[0], hsB[1], hsB[2], 0.050, 0.008, cBlack, 0.15);
      // Crossbar tying the plate to the fork
      const pegIn  = steerPt(side * 0.055, plateC[1], plateC[2]);
      const pegOut = steerPt(side * 0.100, plateC[1], plateC[2]);
      addBoxBeam(pegIn[0], pegIn[1], pegIn[2], pegOut[0], pegOut[1], pegOut[2], 0.014, 0.014, cCharc, 0.2);
    }

    /* ── C. Sliding Black Seat along Red Rail ─────────────────────────────── */
    const seatZ = lerp(-0.06, 0.26, k.leg);
    const seatY = 0.715;
    // Roller carriage wrapping the red rail
    addBoxBeam(0, 0.665, seatZ - 0.08, 0, 0.665, seatZ + 0.08, 0.040, 0.042, cBlack, 0.25);
    // Cushioned sculpted seat pad
    addBoxBeam(0, seatY, seatZ - 0.11, 0, seatY, seatZ + 0.11, 0.130, 0.028, cCharc, 0.12);
    addEllipsoid(0, seatY + 0.008, seatZ + 0.02, 0.140, 0.030, 0.128, 5, 10, cCharc, 0.10, 0);

    /* ── D. Iconic Blue Pivoting Rowing Power Lever + Handlebars ──────────── */
    // Pivots on a bracket mounted to the lower red curved frame beam (mid-front),
    // extending UP & forward to the handlebars and DOWN & back underneath the beam.
    // Driven by the combined handle travel (legs push straight arms back first,
    // then back opens, then arms finish pulling the lever PAST vertical to the chest!).
    const pivY = 0.40, pivZ = -0.02;
    const upperLen = 0.70; // taller above the pivot so the bars clear the rider's chest
    const lowerLen = 0.27;
    const leverProg = 0.46 * k.leg + 0.30 * k.back + 0.24 * k.arm;
    // Angle from vertical (+ = pitched forward toward -Z, - = pulled BACK past pivot toward +Z):
    const leverAngle = lerp(0.84, -0.10, leverProg);
    const sinL = Math.sin(leverAngle), cosL = Math.cos(leverAngle);

    // Pivot bracket & mounting lug on the lower red frame beam
    // Lever is a PAIR of blue blades running down BOTH sides of the frame (see reference photo),
    // pivoting on an axle through the frame and tied together at the top (stem) and bottom (chain).
    const LEVER_X = 0.038;
    addLimb(-LEVER_X - 0.012, pivY, pivZ, LEVER_X + 0.012, pivY, pivZ, 0.022, 0.022, 8, cCharc, 0.45);
    for (const sd of [-1, 1]) {
      // Pivot bolt heads on the outside of each blade
      addLimb(sd * (LEVER_X + 0.014), pivY, pivZ, sd * (LEVER_X + 0.030), pivY, pivZ, 0.020, 0.020, 8, cBlack, 0.35);
    }

    const tailY = pivY - cosL * lowerLen;
    const tailZ = pivZ + sinL * lowerLen;
    const tipY  = pivY + cosL * upperLen;
    const tipZ  = pivZ - sinL * upperLen;

    // Stout blue rowing power beam (runs continuously through the pivot from lower chain arm to top)
    // Twin blue lever blades (one each side of the frame), thin in X and deep fore/aft
    for (const sd of [-1, 1]) {
      const bx = sd * LEVER_X;
      addBoxBeam(bx, tailY, tailZ, bx, tipY, tipZ, 0.010, 0.030, cBlue, 0.62);
      // Light-blue/white accent stripe on the outer face (nod to the Rowbike.com decal)
      const ox = sd * (LEVER_X + 0.011);
      addBoxBeam(ox, lerp(pivY, tipY, 0.15), lerp(pivZ, tipZ, 0.15),
                 ox, lerp(pivY, tipY, 0.88), lerp(pivZ, tipZ, 0.88), 0.002, 0.016, cBlueHi, 0.5);
    }
    // Top cross-brace joining both blades (head of the lever)
    addLimb(-LEVER_X, tipY, tipZ, LEVER_X, tipY, tipZ, 0.024, 0.024, 8, cBlue, 0.6);
    // Bottom cross-pin joining both blades (chain anchor)
    addLimb(-LEVER_X, tailY, tailZ, LEVER_X, tailY, tailZ, 0.016, 0.016, 8, cCharc, 0.5);
    // Lower chain-anchor clevis fin & roller underneath the bottom tip of the blue lever
    const clevisY = tailY - 0.055;
    const clevisZ = tailZ + 0.020;
    addBoxBeam(0, tailY, tailZ, 0, clevisY, clevisZ, 0.018, 0.022, cBlue, 0.55);
    addEllipsoid(0.024, clevisY, clevisZ, 0.016, 0.020, 0.020, 4, 8, cCharc, 0.5, 0);

    // Compact curved top stem + Flat Handlebars + Grips (swept slightly back toward rider)
    const barY = tipY + 0.065;
    const barZ = tipZ + lerp(-0.01, 0.060, leverProg);
    addLimb(0, tipY, tipZ, 0, barY, barZ, 0.021, 0.018, 8, cBlue, 0.55);
    addLimb(-0.27, barY, barZ, 0.27, barY, barZ, 0.014, 0.014, 8, cBlack, 0.35);
    // Rubber grips
    addLimb(-0.28, barY, barZ, -0.17, barY, barZ, 0.020, 0.020, 8, cCharc, 0.08);
    addLimb( 0.17, barY, barZ,  0.28, barY, barZ, 0.020, 0.020, 8, cCharc, 0.08);

    // Horizontal drive chain from bottom of blue lever back to rear derailleur & cassette
    addBoxBeam(0.036, clevisY, clevisZ, 0.066, wheelR - 0.08, 0.65, 0.005, 0.005, cCable, 0.5);
    addBoxBeam(0.036, tailY + 0.02, tailZ, 0.064, wheelR + 0.05, 0.64, 0.005, 0.005, cCable, 0.5);

    /* ── E. Real Biketerra Player Avatar Bones OR Procedural Fallback Human ─── */
    if (useRealAvatar) {
      poseRealBiketerraAvatar(rider, k, seatY, seatZ, barY, barZ, steerPt);
      return vertCount > startVerts && idxCount > startIdx;
    }

    const hipY = seatY + 0.08;
    const hipZ = seatZ + 0.01;
    // Pelvis / cycling bibs
    addEllipsoid(0, hipY + 0.02, hipZ, 0.155, 0.095, 0.115, 6, 10, cShorts, 0.08, 0);

    // Torso hinge: +21° forward at catch -> -15° layback at finish
    const torsoAngle = lerp(0.36, -0.26, k.back);
    const sinT = Math.sin(torsoAngle), cosT = Math.cos(torsoAngle);
    const torsoLen = 0.48;

    const midTorsoY = hipY + 0.24 * cosT;
    const midTorsoZ = hipZ - 0.24 * sinT;
    const shY = hipY + torsoLen * cosT;
    const shZ = hipZ - torsoLen * sinT;

    // Lower & upper torso (jersey) + shoulder bar
    addLimb(0, hipY + 0.03, hipZ, 0, midTorsoY, midTorsoZ, 0.135, 0.148, 10, cJersey, 0.10);
    addLimb(0, midTorsoY, midTorsoZ, 0, shY, shZ, 0.148, 0.160, 10, cJersey, 0.10);
    addEllipsoid(0, shY - 0.02, shZ, 0.195, 0.085, 0.105, 6, 10, cJersey, 0.10, -torsoAngle);

    // Neck, Head, Aero Helmet + Visor Sunglasses (head stays level looking down the road!)
    const neckY = shY + 0.07;
    const neckZ = shZ - 0.02 * sinT;
    addLimb(0, shY + 0.01, shZ, 0, neckY + 0.05, neckZ, 0.052, 0.048, 8, cSkin, 0.12);

    const headY = neckY + 0.125;
    const headZ = neckZ - 0.015;
    addEllipsoid(0, headY, headZ, 0.088, 0.102, 0.096, 6, 10, cSkin, 0.12, 0);
    // Helmet shell (slightly aero elongated toward +Z)
    addEllipsoid(0, headY + 0.042, headZ + 0.018, 0.102, 0.082, 0.132, 6, 10, cHelmet, 0.45, -0.08);
    // Helmet center accent stripe
    addBoxBeam(0, headY + 0.118, headZ - 0.075, 0, headY + 0.108, headZ + 0.115, 0.018, 0.012, cHelAcc, 0.5);
    // Cycling sunglasses / visor across front of face (-Z)
    addBoxBeam(-0.075, headY + 0.012, headZ - 0.088, 0.075, headY + 0.012, headZ - 0.088, 0.016, 0.020, cVisor, 0.85);

    // 2-Bone IK Legs (Hips on sliding seat -> Knees up/out -> Feet welded to front fork footpegs!)
    const thighLen = 0.45;
    const shinLen  = 0.44;
    for (const side of [-1, 1]) {
      const hx = side * 0.102;
      const foot = steerPt(side * 0.145, 0.46, -0.48);
      const knee = solveTwoBoneIK(
        hx, hipY, hipZ,
        foot[0], foot[1], foot[2],
        thighLen, shinLen,
        side * 0.14, 1.0, -0.22 // knee bends cleanly UP and slightly OUTWARD
      );

      // Upper thigh (bib shorts) -> lower thigh (skin) -> knee joint -> calf (skin) -> sock -> shoe
      const mThighX = lerp(hx, knee[0], 0.62);
      const mThighY = lerp(hipY, knee[1], 0.62);
      const mThighZ = lerp(hipZ, knee[2], 0.62);
      addLimb(hx, hipY, hipZ, mThighX, mThighY, mThighZ, 0.076, 0.064, 8, cShorts, 0.08);
      addLimb(mThighX, mThighY, mThighZ, knee[0], knee[1], knee[2], 0.062, 0.052, 8, cSkin, 0.12);
      addEllipsoid(knee[0], knee[1], knee[2], 0.052, 0.052, 0.052, 4, 8, cSkin, 0.12, 0);

      const sockX = lerp(knee[0], foot[0], 0.72);
      const sockY = lerp(knee[1], foot[1], 0.72);
      const sockZ = lerp(knee[2], foot[2], 0.72);
      addLimb(knee[0], knee[1], knee[2], sockX, sockY, sockZ, 0.052, 0.039, 8, cSkin, 0.12);
      addLimb(sockX, sockY, sockZ, foot[0], foot[1], foot[2], 0.040, 0.036, 8, cSocks, 0.08);

      // Cycling shoe planted against the footplate
      const toe = steerPt(side * 0.148, 0.51, -0.53);
      addBoxBeam(foot[0], foot[1] - 0.02, foot[2] + 0.03, toe[0], toe[1], toe[2], 0.044, 0.034, cShoes, 0.3);
    }

    // 2-Bone IK Arms (Shoulders -> Elbows tucked down & back -> Hands welded to moving handlebar grips!)
    const upperArmLen = 0.30;
    const forearmLen  = 0.29;
    for (const side of [-1, 1]) {
      const sx = side * 0.185;
      const gx = side * 0.235;
      const elbow = solveTwoBoneIK(
        sx, shY - 0.02, shZ,
        gx, barY, barZ,
        upperArmLen, forearmLen,
        side * 0.38, -0.85, 0.45 // elbows tuck naturally DOWN, slightly OUT, and BACK at the finish
      );

      // Jersey sleeve (upper half of upper arm) -> bare arm -> elbow -> forearm -> hand on grip
      const sleeveX = lerp(sx, elbow[0], 0.55);
      const sleeveY = lerp(shY - 0.02, elbow[1], 0.55);
      const sleeveZ = lerp(shZ, elbow[2], 0.55);
      addEllipsoid(sx, shY - 0.02, shZ, 0.055, 0.055, 0.055, 4, 8, cJersey, 0.10, 0);
      addLimb(sx, shY - 0.02, shZ, sleeveX, sleeveY, sleeveZ, 0.050, 0.044, 8, cJersey, 0.10);
      addLimb(sleeveX, sleeveY, sleeveZ, elbow[0], elbow[1], elbow[2], 0.042, 0.038, 8, cSkin, 0.12);
      addEllipsoid(elbow[0], elbow[1], elbow[2], 0.039, 0.039, 0.039, 4, 8, cSkin, 0.12, 0);
      addLimb(elbow[0], elbow[1], elbow[2], gx, barY, barZ, 0.037, 0.030, 8, cSkin, 0.12);
      // Gloved hand gripping handlebar
      addEllipsoid(gx, barY, barZ, 0.034, 0.034, 0.036, 4, 8, cCharc, 0.12, 0);
    }

    return vertCount > 0 && idxCount > 0;
  }

  /* ── 5. WebGPU Custom Depth-Tested Pipeline (Injected into Main Pass) ─────── */
  const ROWBIKE_WGSL = `
    struct Uniforms {
      viewProj: mat4x4f,
      sunAndMode: vec4f, // xyz = normalized sun dir, w = 1.0 if target is sRGB format
      plane: vec4f,      // xyz = ground plane normal, w = plane offset (dot(n, point))
      shadowSun: vec4f,  // xyz = direction TOWARD the sun for the ground shadow, w = shadow brightness
    };
    @group(0) @binding(0) var<uniform> u: Uniforms;

    struct VsIn {
      @location(0) pos: vec3f,
      @location(1) norm: vec3f,
      @location(2) col: vec3f,
      @location(3) shine: f32,
    };
    struct VsOut {
      @builtin(position) clipPos: vec4f,
      @location(0) norm: vec3f,
      @location(1) col: vec3f,
      @location(2) shine: f32,
    };

    @vertex
    fn vs(in: VsIn) -> VsOut {
      var out: VsOut;
      out.clipPos = u.viewProj * vec4f(in.pos, 1.0);
      out.norm = in.norm;
      out.col = in.col;
      out.shine = in.shine;
      return out;
    }

    @fragment
    fn fs(in: VsOut) -> @location(0) vec4f {
      let N = normalize(in.norm);
      let L = normalize(u.sunAndMode.xyz);
      let ndotl = max(dot(N, L), 0.0);
      let backFill = max(dot(N, -L), 0.0) * 0.14;
      let sky = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
      let hemi = mix(vec3f(0.24, 0.23, 0.25), vec3f(0.56, 0.60, 0.66), sky);

      let H = normalize(L + vec3f(0.0, 0.45, 0.89));
      let spec = pow(max(dot(N, H), 0.0), 26.0) * in.shine * 0.42;

      let lit = in.col * (hemi + vec3f(0.95, 0.91, 0.84) * (ndotl * 0.78 + backFill)) + vec3f(spec);
      let clamped = clamp(lit, vec3f(0.0), vec3f(1.0));
      let outRgb = select(clamped, pow(clamped, vec3f(2.2)), u.sunAndMode.w > 0.5);
      return vec4f(outRgb, 1.0);
    }

    // Planar projected ground shadow of the whole bike mesh. Drawn with a MIN blend so overlapping
    // projected triangles don't darken twice (shadow = darkest of ground and shadow colour).
    @vertex
    fn vs_shadow(@location(0) pos: vec3f) -> @builtin(position) vec4f {
      let n = normalize(u.plane.xyz);
      let L = normalize(u.shadowSun.xyz);
      let h = max(dot(n, pos) - u.plane.w, 0.0);
      let t = h / max(dot(n, L), 0.25);
      let ps = pos - L * t + n * 0.012;
      return u.viewProj * vec4f(ps, 1.0);
    }

    @fragment
    fn fs_shadow() -> @location(0) vec4f {
      let lv = u.shadowSun.w;
      let c = vec3f(lv * 0.96, lv, lv * 1.10);
      let outRgb = select(c, pow(c, vec3f(2.2)), u.sunAndMode.w > 0.5);
      return vec4f(outRgb, 1.0);
    }
  `;

  const renderer = {
    disabled: false,
    eng: null,
    origRender: null,
    gpu: null,
    origCreateTex: null,
    origWriteBuffer: null,
    origUncaptured: null,
    egoRiderBonesBuf: null,
    egoBikeBonesBuf: null,
    lastRiderBonesCandidate: null,
    lastOriginX: 0,
    lastOriginZ: 0,
    hasOrigin: false,
    bgl: null,
    shaderMod: null,
    pipe: null,
    shadowPipe: null,
    pipeKey: '',
    vbuf: null,
    ibuf: null,
    ubuf: null,
    bindGroup: null,
    uData: new Float32Array(28),
    depthFormat: null,    // auto-detected from engine textures or validation oracle
    sampleCount: null,    // auto-detected (1 or 4)
    reverseZ: null,       // auto-detected from depthClearValue (<0.5 => reverse-Z)
    diag: 'waiting…',
    loggedActive: false,
  };

  function probeEngineDepthFormat(eng) {
    if (!eng || renderer.depthFormat) return;
    const seen = new Set();
    const queue = [{ obj: eng, depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 160) {
      const { obj, depth } = queue.shift();
      if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
      seen.add(obj);
      visited++;

      if (typeof obj.format === 'string' && typeof obj.createView === 'function') {
        if (obj.format.startsWith('depth')) {
          renderer.depthFormat = obj.format;
          if (typeof obj.sampleCount === 'number' && obj.sampleCount >= 1) {
            renderer.sampleCount = obj.sampleCount;
          }
          log(`probed depth texture: format=${renderer.depthFormat} samples=${renderer.sampleCount}`);
          return;
        }
      }
      if (depth >= 3) continue;
      let keys;
      try { keys = Object.keys(obj); } catch { continue; }
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (k === 'window' || k === 'document' || k === 'riders' || k === 'draws') continue;
        let val;
        try { val = obj[k]; } catch { continue; }
        if (val && typeof val === 'object' && !ArrayBuffer.isView(val)) {
          queue.push({ obj: val, depth: depth + 1 });
        }
      }
    }
  }

  function mapValidationDepthFormat(token) {
    const t = String(token || '').toLowerCase();
    if (t.includes('depth32floatstencil8')) return 'depth32float-stencil8';
    if (t.includes('depth24plusstencil8')) return 'depth24plus-stencil8';
    if (t.includes('depth32float')) return 'depth32float';
    if (t.includes('depth24plus')) return 'depth24plus';
    if (t.includes('depth16unorm')) return 'depth16unorm';
    return null;
  }

  function matchRiderBonesWrite(buffer, data, dataOffset) {
    // Match any rider's persistent `rider_bones` GPUBuffer (22 mat4x4 = 1408 bytes) to its Rider object
    if (!buffer || buffer.label !== 'rider_bones') return;
    if (!(data instanceof Float32Array)) return;
    const off = dataOffset || 0;
    if (data.length - off < 352) return;

    const bt = window.btApp;
    const rc = bt && (bt.riderController || bt.rideController);
    if (!rc) return;

    const tx = data[off + 12], ty = data[off + 13], tz = data[off + 14];
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) return;

    const baseSim = (rc.ego && rc.ego.sim && rc.ego.sim.position)
      ? rc.ego.sim
      : (rc.focalRider && rc.focalRider.sim && rc.focalRider.sim.position ? rc.focalRider.sim : null);
    const ox = renderer.hasOrigin ? renderer.lastOriginX : (baseSim ? baseSim.position.x : 0);
    const oz = renderer.hasOrigin ? renderer.lastOriginZ : (baseSim ? baseSim.position.z : 0);
    const wx = tx + ox, wz = tz + oz;

    let bestRider = null;
    let bestDist = 1.15;
    let secondDist = Infinity;

    const consider = (r) => {
      if (!r || !r.sim || !r.sim.position || r._isTerraGhost) return;
      if (Math.abs(ty - r.sim.position.y) > 1.8) return;
      const d = Math.min(
        Math.hypot(wx - r.sim.position.x, wz - r.sim.position.z),
        r.sim.midPosition ? Math.hypot(wx - r.sim.midPosition.x, wz - r.sim.midPosition.z) : Infinity
      );
      if (d < bestDist) {
        secondDist = bestDist;
        bestDist = d;
        bestRider = r;
      } else if (d < secondDist) {
        secondDist = d;
      }
    };

    if (rc.ego) consider(rc.ego);
    if (rc.focalRider && rc.focalRider !== rc.ego) consider(rc.focalRider);
    if (Array.isArray(rc.riders)) {
      for (let i = 0; i < rc.riders.length; i++) {
        const r = rc.riders[i];
        if (r && r !== rc.ego && r !== rc.focalRider) consider(r);
      }
    }

    if (!bestRider || bestDist > secondDist - 0.04) return;

    const st = getRiderState(bestRider);
    if (st.bonesBuf !== buffer) {
      st.bonesBuf = buffer;
      if (bestRider === rc.ego) {
        renderer.egoRiderBonesBuf = buffer;
        log('captured ego rider_bones GPUBuffer for real-avatar rowing');
      } else {
        log(`captured rider_bones GPUBuffer for rider ${btRiderFullName(bestRider) || (bestRider.sim && bestRider.sim.id) || '?'}`);
      }
    }

    // Extract Biketerra's native turn-lean roll angle from root bone (bone 0) before we overwrite it:
    // Col 2 (off + 8..10) is the rider's bind +Z (Right) axis in world space.
    try {
      const r2x = data[off + 8], r2y = data[off + 9], r2z = data[off + 10];
      let bfx = 0, bfz = -1;
      const rSim = bestRider.sim;
      if (rSim.frontPosition && rSim.position) {
        const dx = rSim.frontPosition.x - rSim.position.x;
        const dz = rSim.frontPosition.z - rSim.position.z;
        const dl = Math.hypot(dx, dz);
        if (dl > 0.1) { bfx = dx / dl; bfz = dz / dl; }
      }
      const brx = -bfz, brz = bfx; // Horizontal road Right vector
      const rDotR = r2x * brx + r2z * brz;
      if (Number.isFinite(rDotR) && Math.abs(rDotR) > 0.2) {
        // When banking right by `lean`, Right tilts down (r2y < 0 => lean > 0)
        st.nativeLean = clamp(Math.atan2(-r2y, rDotR), -0.48, 0.48);
        if (bestRider === rc.ego) renderer.nativeLean = st.nativeLean;
      }
    } catch {}
  }

  function installGpuHooks(gpu) {
    if (!gpu || renderer.gpu === gpu) return;
    restoreGpuHooks();
    renderer.gpu = gpu;

    // Track any newly created depth texture (e.g. on window resize)
    if (typeof gpu.createTexture === 'function') {
      const origCreate = gpu.createTexture.bind(gpu);
      renderer.origCreateTex = gpu.createTexture;
      gpu.createTexture = function (desc) {
        try {
          if (desc && typeof desc.format === 'string' && desc.format.startsWith('depth')) {
            renderer.depthFormat = desc.format;
            if (typeof desc.sampleCount === 'number' && desc.sampleCount >= 1) {
              renderer.sampleCount = desc.sampleCount;
            }
          }
        } catch {}
        return origCreate(desc);
      };
    }

    // Track riders' persistent `rider_bones` GPUBuffers written each frame by Biketerra
    if (gpu.queue && typeof gpu.queue.writeBuffer === 'function') {
      const origWB = gpu.queue.writeBuffer;
      const boundWB = origWB.bind(gpu.queue);
      renderer.origWriteBuffer = origWB;
      gpu.queue.writeBuffer = function (buffer, bufferOffset, data, dataOffset, size) {
        try {
          if (!cleaned && buffer && buffer.label === 'rider_bones') {
            matchRiderBonesWrite(buffer, data, dataOffset);
          }
        } catch {}
        return boundWB(buffer, bufferOffset, data, dataOffset, size);
      };
    }

    // Self-healing WebGPU validation oracle for depthFormat / sampleCount mismatches
    const prior = gpu.onuncapturederror;
    renderer.origUncaptured = prior;
    gpu.onuncapturederror = (ev) => {
      try {
        const msg = String((ev && ev.error && ev.error.message) || (ev && ev.message) || '');
        if (msg.includes('terra_rowbike')) {
          const fm = msg.match(/TextureFormat::(Depth[A-Za-z0-9]+)/i);
          if (fm) {
            const parsed = mapValidationDepthFormat(fm[1]);
            if (parsed && parsed !== renderer.depthFormat) {
              renderer.depthFormat = parsed;
              renderer.pipe = null;
              renderer.shadowPipe = null;
              renderer.pipeKey = '';
              log('adapted depthFormat from WebGPU validator:', parsed);
            }
          }
          const sm = msg.match(/sample\s*count\s*\((\d+)\)/i) || msg.match(/sampleCount\s*\((\d+)\)/i);
          if (sm) {
            const sc = Number(sm[1]);
            if ((sc === 1 || sc === 4) && sc !== renderer.sampleCount) {
              renderer.sampleCount = sc;
              renderer.pipe = null;
              renderer.shadowPipe = null;
              renderer.pipeKey = '';
              log('adapted sampleCount from WebGPU validator:', sc);
            }
          }
        }
      } catch {}
      if (typeof prior === 'function') return prior(ev);
    };
  }

  function restoreGpuHooks() {
    if (renderer.gpu) {
      if (renderer.origCreateTex) {
        try { renderer.gpu.createTexture = renderer.origCreateTex; } catch {}
      }
      if (renderer.origWriteBuffer && renderer.gpu.queue) {
        try { renderer.gpu.queue.writeBuffer = renderer.origWriteBuffer; } catch {}
      }
      if (renderer.origUncaptured !== undefined) {
        try { renderer.gpu.onuncapturederror = renderer.origUncaptured; } catch {}
      }
    }
    renderer.origCreateTex = null;
    renderer.origWriteBuffer = null;
    renderer.origUncaptured = undefined;
    renderer.egoRiderBonesBuf = null;
    renderer.egoBikeBonesBuf = null;
    renderer.lastRiderBonesCandidate = null;
  }

  function ensurePipeline(gpu, colorFormat, depthFormat, sampleCount, reverseZ) {
    if (typeof GPUShaderStage === 'undefined' || typeof GPUBufferUsage === 'undefined') {
      renderer.disabled = true;
      return false;
    }
    if (!renderer.vbuf) {
      renderer.bgl = gpu.createBindGroupLayout({
        label: 'terra_rowbike_bgl',
        entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
      });
      renderer.shaderMod = gpu.createShaderModule({ label: 'terra_rowbike_shader', code: ROWBIKE_WGSL });
      renderer.vbuf = gpu.createBuffer({
        label: 'terra_rowbike_vb',
        size: vertData.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      renderer.ibuf = gpu.createBuffer({
        label: 'terra_rowbike_ib',
        size: idxData.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      renderer.ubuf = gpu.createBuffer({
        label: 'terra_rowbike_ub',
        size: renderer.uData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      renderer.bindGroup = gpu.createBindGroup({
        label: 'terra_rowbike_bg',
        layout: renderer.bgl,
        entries: [{ binding: 0, resource: { buffer: renderer.ubuf } }],
      });
    }

    const key = `${colorFormat}|${depthFormat}|${sampleCount}|${reverseZ ? 'rev' : 'std'}`;
    if (renderer.pipe && renderer.pipeKey === key) return true;

    renderer.pipe = gpu.createRenderPipeline({
      label: 'terra_rowbike_pipe',
      layout: gpu.createPipelineLayout({ bindGroupLayouts: [renderer.bgl] }),
      vertex: {
        module: renderer.shaderMod,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 40,
          attributes: [
            { shaderLocation: 0, offset: 0,  format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' },
            { shaderLocation: 3, offset: 36, format: 'float32' },
          ],
        }],
      },
      fragment: {
        module: renderer.shaderMod,
        entryPoint: 'fs',
        targets: [{ format: colorFormat }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        depthCompare: reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: sampleCount },
    });

    // Planar projected ground-shadow pipeline for the Rowbike mesh.
    // Uses MIN blending (`min(src, dst)`) and depthWriteEnabled: false so overlapping projected
    // triangles never double-darken, and the shadow conforms cleanly onto the road surface.
    renderer.shadowPipe = gpu.createRenderPipeline({
      label: 'terra_rowbike_shadow_pipe',
      layout: gpu.createPipelineLayout({ bindGroupLayouts: [renderer.bgl] }),
      vertex: {
        module: renderer.shaderMod,
        entryPoint: 'vs_shadow',
        buffers: [{
          arrayStride: 40,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module: renderer.shaderMod,
        entryPoint: 'fs_shadow',
        targets: [{
          format: colorFormat,
          blend: {
            color: { operation: 'min', srcFactor: 'one', dstFactor: 'one' },
            alpha: { operation: 'add', srcFactor: 'zero', dstFactor: 'one' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: false,
        depthCompare: reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: sampleCount },
    });
    renderer.pipeKey = key;
    return true;
  }

  /* ── 6. Identify Any Rider's Native Body, Bike & Spoke Draws ──────────────── */
  function boundsDistXZ(b, sim, ox, oz) {
    if (!sim) return Infinity;
    const cx = (b[0] + b[3]) * 0.5;
    const cy = (b[1] + b[4]) * 0.5;
    const cz = (b[2] + b[5]) * 0.5;
    let best = Infinity;
    const p1 = sim.position;
    if (p1 && Math.abs(cy - p1.y) < 2.6) {
      const d = Math.hypot(cx - (p1.x - ox), cz - (p1.z - oz));
      if (d < best) best = d;
    }
    const p2 = sim.midPosition;
    if (p2 && Math.abs(cy - p2.y) < 2.6) {
      const d = Math.hypot(cx - (p2.x - ox), cz - (p2.z - oz));
      if (d < best) best = d;
    }
    return best;
  }

  function findRiderDraws(draws, fs, rc, targetRider) {
    if (!Array.isArray(draws) || !draws.length || !rc || !targetRider || !targetRider.sim) return null;
    const targetSim = targetRider.sim;
    const others = [];
    if (rc.ego && rc.ego !== targetRider && rc.ego.sim && rc.ego.sim !== targetSim) {
      others.push(rc.ego.sim);
    }
    if (rc.focalRider && rc.focalRider !== targetRider && rc.focalRider !== rc.ego && rc.focalRider.sim && rc.focalRider.sim !== targetSim) {
      others.push(rc.focalRider.sim);
    }
    if (Array.isArray(rc.riders)) {
      for (const r of rc.riders) {
        if (r && r !== targetRider && r.sim && r.sim !== targetSim) others.push(r.sim);
      }
    }

    const oxRaw = (fs && fs.origin && Number.isFinite(fs.origin[0])) ? fs.origin[0] : 0;
    const ozRaw = (fs && fs.origin && Number.isFinite(fs.origin[1])) ? fs.origin[1] : 0;

    let ox = 0, oz = 0;
    if (oxRaw !== 0 || ozRaw !== 0) {
      let worldHits = 0, relHits = 0;
      for (let i = 0; i < draws.length; i++) {
        const d = draws[i];
        if (!d || (d.pipeline !== 'skinned' && d.pipeline !== 'spoke') || !d.bounds || d.bounds.length < 6) continue;
        if (boundsDistXZ(d.bounds, targetSim, 0, 0) < 0.85) worldHits++;
        if (boundsDistXZ(d.bounds, targetSim, oxRaw, ozRaw) < 0.85) relHits++;
      }
      if (relHits > worldHits) { ox = oxRaw; oz = ozRaw; }
    }

    const defSkinned = [];
    const defSpoke = [];
    const tiedSkinned = [];
    const tiedSpoke = [];

    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      if (!d || (d.pipeline !== 'skinned' && d.pipeline !== 'spoke') || !d.bounds || d.bounds.length < 6) continue;
      const dTarget = boundsDistXZ(d.bounds, targetSim, ox, oz);
      if (!(dTarget < 0.85)) continue;

      let dOther = Infinity;
      for (let j = 0; j < others.length; j++) {
        const dist = boundsDistXZ(d.bounds, others[j], ox, oz);
        if (dist < dOther) dOther = dist;
      }

      if (dTarget < dOther - 0.02) {
        if (d.pipeline === 'skinned') defSkinned.push(d);
        else defSpoke.push(d);
      } else if (Math.abs(dTarget - dOther) <= 0.02) {
        if (d.pipeline === 'skinned') tiedSkinned.push(d);
        else tiedSpoke.push(d);
      }
    }

    const skinned = defSkinned.length > 0 ? defSkinned : tiedSkinned.slice(0, 2);
    const spokes  = defSpoke.length > 0   ? defSpoke   : tiedSpoke.slice(0, 1);
    if (skinned.length === 0 && spokes.length === 0) return null;

    // Biketerra pushes `body` FIRST, `bike` SECOND (and Canyon bike always has indexCount === 10206)
    let bodyDraw = skinned[0] || null;
    let bikeDraw = skinned[1] || null;
    if (bodyDraw && bikeDraw) {
      const ic0 = bodyDraw.geometry && bodyDraw.geometry.indexCount;
      const ic1 = bikeDraw.geometry && bikeDraw.geometry.indexCount;
      if (ic0 === 10206 && ic1 !== 10206) {
        const tmp = bodyDraw; bodyDraw = bikeDraw; bikeDraw = tmp;
      }
    }

    const allSet = new Set([...skinned, ...spokes]);
    const bikeOnlySet = new Set(spokes);
    if (bikeDraw) bikeOnlySet.add(bikeDraw);
    return { bodyDraw, bikeDraw, allSet, bikeOnlySet };
  }

  /* ── 7. Hook engine.render to Swap Rowing Riders + Inject Rowbikes ────────── */
  function installRenderHook(env) {
    const eng = env && env.engine;
    if (!eng || typeof eng.render !== 'function' || renderer.disabled) return;
    if (renderer.eng === eng) return;

    if (renderer.eng && renderer.origRender && renderer.eng.render !== renderer.origRender) {
      try { renderer.eng.render = renderer.origRender; } catch {}
    }

    const origRender = eng.render;
    renderer.eng = eng;
    renderer.origRender = origRender;

    eng.render = function (fs, rq) {
      if (cleaned || renderer.disabled) {
        renderer.diag = 'disabled';
        return origRender.call(this, fs, rq);
      }

      const bt = window.btApp;
      const rc = bt && (bt.riderController || bt.rideController);
      if (!rc || !fs || !fs.camera || !fs.camera.viewProj || !fs.origin) {
        return origRender.call(this, fs, rq);
      }

      const ox = Number.isFinite(fs.origin[0]) ? fs.origin[0] : 0;
      const oz = Number.isFinite(fs.origin[1]) ? fs.origin[1] : 0;
      renderer.lastOriginX = ox;
      renderer.lastOriginZ = oz;
      renderer.hasOrigin = true;

      const dev = this.device;
      const gpu = dev && dev.gpu;
      const ctx = dev && dev.context;
      if (!gpu || !ctx || typeof gpu.createCommandEncoder !== 'function') {
        renderer.disabled = true;
        renderer.diag = 'no WebGPU';
        return origRender.call(this, fs, rq);
      }

      installGpuHooks(gpu);
      probeEngineDepthFormat(this);

      const targetRiders = getRowbikeRiders(rc);
      if (targetRiders.length === 0) {
        renderer.diag = 'standby';
        return origRender.call(this, fs, rq);
      }

      // Advance frame dt
      const now = performance.now();
      const dt = anim.lastMs > 0 ? clamp((now - anim.lastMs) / 1000, 0, 0.1) : (1 / 60);
      anim.lastMs = now;
      anim.lastDt = dt;

      const focal = rc.focalRider || rc.ego || null;
      const hideFocalFirstPerson = !!(fs.rig && fs.rig.hideFocalRider && focal);
      const draws = rq && Array.isArray(rq.draws) ? rq.draws : null;
      const wantReal = S.avatarMode !== 'stylized';
      const hideSet = new Set();

      beginMesh();
      let builtCount = 0;
      let realCount = 0;
      let primarySpm = 0;

      for (let i = 0; i < targetRiders.length; i++) {
        const r = targetRiders[i];
        const isEgo = r === rc.ego || (!rc.ego && r === rc.focalRider);
        const st = getRiderState(r);
        stepRiderAnimation(r, st, dt, isEgo);
        if (i === 0 || isEgo) primarySpm = st.spm;

        if (hideFocalFirstPerson && r === focal) {
          continue;
        }

        const rDraws = draws ? findRiderDraws(draws, fs, rc, r) : null;
        const useRealAvatar = Boolean(wantReal && st.bonesBuf && rDraws && rDraws.bodyDraw);

        if (buildRowbikeAndRowerMesh(r, st, ox, oz, useRealAvatar)) {
          builtCount++;
          if (useRealAvatar) realCount++;

          if (rDraws) {
            const toHide = useRealAvatar ? rDraws.bikeOnlySet : rDraws.allSet;
            for (const d of toHide) hideSet.add(d);
          }

          // Upload this rider's 22 rowing bone matrices into their own `rider_bones` GPUBuffer
          // BEFORE origRender so both the shadow pass and main PBR pass render THEIR avatar rowing!
          if (useRealAvatar && st.bonesBuf && gpu.queue) {
            const rawWB = renderer.origWriteBuffer || gpu.queue.writeBuffer;
            try {
              rawWB.call(gpu.queue, st.bonesBuf, 0, realBoneMatrices, 0, 352);
            } catch (e) {
              log('real rider_bones upload error:', e);
            }
          }
        }
      }

      anim.spm = primarySpm;

      if (builtCount === 0) {
        renderer.diag = hideFocalFirstPerson ? '1st-person' : 'standby';
        return origRender.call(this, fs, rq);
      }

      const nextDraws = hideSet.size > 0 && draws ? draws.filter((d) => !hideSet.has(d)) : (draws ? draws.slice() : null);
      let hasNativeRowbikeShadow = false;
      if (S.bikeShadow !== false && nextDraws && renderer.featScope) {
        if (ensureShadowMiscAllocated(renderer.featScope, this)) {
          const shDraw = uploadAndBuildShadowMiscDraw(nextDraws, ox, oz);
          if (shDraw) {
            nextDraws.push(shDraw);
            hasNativeRowbikeShadow = true;
          }
        }
      }
      const filteredRq = nextDraws ? { ...rq, draws: nextDraws } : rq;

      let colorFormat = dev.format || 'bgra8unorm';
      try {
        const swapTex = typeof ctx.getCurrentTexture === 'function' ? ctx.getCurrentTexture() : null;
        if (swapTex && swapTex.format) colorFormat = swapTex.format;
      } catch {}

      const rawCreateEncoder = gpu.createCommandEncoder;
      let injectedThisFrame = false;

      // Upload uniform + dynamic vertex/index buffers before command recording
      const vp = fs.camera.viewProj;
      for (let i = 0; i < 16; i++) renderer.uData[i] = vp[i];
      // Warm daylight directional sun + sRGB flag
      renderer.uData[16] = 0.45;
      renderer.uData[17] = 0.80;
      renderer.uData[18] = 0.39;
      renderer.uData[19] = colorFormat.endsWith('-srgb') ? 1.0 : 0.0;
      // Ground plane in origin-relative world space (normal = basis.u, point = basis.o)
      const pDot = basis.ux * basis.ox + basis.uy * basis.oy + basis.uz * basis.oz;
      renderer.uData[20] = basis.ux;
      renderer.uData[21] = basis.uy;
      renderer.uData[22] = basis.uz;
      renderer.uData[23] = pDot;
      // Projected shadow sun direction (matches Biketerra's default sun angle, rotatable via shadowAzimuth)
      const az = ((Number(S.shadowAzimuth) || 0) * Math.PI) / 180;
      const caz = Math.cos(az), saz = Math.sin(az);
      const sx0 = -0.46, sy0 = 0.78, sz0 = -0.42;
      renderer.uData[24] = sx0 * caz - sz0 * saz;
      renderer.uData[25] = sy0;
      renderer.uData[26] = sx0 * saz + sz0 * caz;
      renderer.uData[27] = 0.33; // shadow brightness (min-blended against sunlit asphalt)

      gpu.createCommandEncoder = function (...args) {
        const enc = rawCreateEncoder.apply(gpu, args);
        const origBegin = enc.beginRenderPass.bind(enc);
        enc.beginRenderPass = function (desc) {
          const pass = origBegin(desc);
          try {
            const hasColor = desc && Array.isArray(desc.colorAttachments) && desc.colorAttachments.length === 1 && desc.colorAttachments[0];
            const ds = desc && desc.depthStencilAttachment;
            if (!injectedThisFrame && hasColor && ds && !ds.depthReadOnly) {
              if (typeof ds.depthClearValue === 'number') {
                renderer.reverseZ = ds.depthClearValue < 0.5;
              }
              const hasResolve = !!desc.colorAttachments[0].resolveTarget;
              const sampleCount = renderer.sampleCount || (hasResolve ? 4 : 1);
              const depthFormat = renderer.depthFormat || 'depth24plus';
              const reverseZ = renderer.reverseZ !== null ? renderer.reverseZ : false;

              const origEnd = pass.end.bind(pass);
              pass.end = function () {
                try {
                  if (ensurePipeline(gpu, colorFormat, depthFormat, sampleCount, reverseZ)) {
                    gpu.queue.writeBuffer(renderer.ubuf, 0, renderer.uData);
                    gpu.queue.writeBuffer(renderer.vbuf, 0, vertData, 0, vertCount * 10);
                    gpu.queue.writeBuffer(renderer.ibuf, 0, idxData, 0, idxCount);

                    // Only use the fallback planar shadow if the native pools.misc shadowOnly Rowbike draw isn't active
                    if (S.bikeShadow !== false && !hasNativeRowbikeShadow && renderer.shadowPipe) {
                      pass.setPipeline(renderer.shadowPipe);
                      pass.setBindGroup(0, renderer.bindGroup);
                      pass.setVertexBuffer(0, renderer.vbuf);
                      pass.setIndexBuffer(renderer.ibuf, 'uint32');
                      pass.drawIndexed(idxCount);
                    }

                    pass.setPipeline(renderer.pipe);
                    pass.setBindGroup(0, renderer.bindGroup);
                    pass.setVertexBuffer(0, renderer.vbuf);
                    pass.setIndexBuffer(renderer.ibuf, 'uint32');
                    pass.drawIndexed(idxCount);
                    injectedThisFrame = true;
                    const countTag = builtCount > 1 ? `${builtCount} rowers · ` : '';
                    renderer.diag = `${countTag}${Math.round(anim.spm)} spm · ${realCount > 0 ? 'real avatar' : 'stylized'}`;
                    if (!renderer.loggedActive) {
                      renderer.loggedActive = true;
                      log(`Rowbike 3D active (${builtCount} riders, ${vertCount} verts, ${idxCount / 3} tris, ${colorFormat}, ${depthFormat}, ${sampleCount}x, revZ=${reverseZ})`);
                    }
                  }
                } catch (e) {
                  renderer.diag = 'draw err';
                  log('Rowbike pass inject error:', e);
                }
                return origEnd();
              };
            }
          } catch {}
          return pass;
        };
        return enc;
      };

      try {
        return origRender.call(this, fs, filteredRq);
      } finally {
        gpu.createCommandEncoder = rawCreateEncoder;
      }
    };

    log('hooked engine.render for Rowbike avatar replacement');
  }

  /* ── 8. Lightweight Test Toggle / Status Pill ─────────────────────────────── */
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'rb-pill';
  pill.title = 'Click to toggle Rowbike Avatar on/off';
  const pillDot = document.createElement('span');
  pillDot.className = 'rb-dot';
  const pillLbl = document.createElement('span');
  pillLbl.textContent = 'Rowbike';
  const pillMeta = document.createElement('span');
  pillMeta.className = 'rb-meta';
  pill.append(pillDot, pillLbl, pillMeta);
  pill.addEventListener('click', () => {
    manualOverride = !isRowbikeActive();
    syncPill();
  });
  document.body.append(pill);

  function syncPill() {
    pill.classList.toggle('rb-hidden', !S.showStatusPill);
    const on = isRowbikeActive();
    pill.classList.toggle('active', on);
    pillMeta.textContent = on ? renderer.diag : 'off';
  }
  syncPill();

  try {
    terra.settings.onChange(async () => {
      try {
        S = { ...DEFAULTS, ...(await terra.settings.all()) };
        manualOverride = null;
        syncPill();
      } catch {}
    });
  } catch {}

  /* ── 9. Wait for btApp + Register Render Feature ──────────────────────────── */
  const pollTimer = setInterval(() => {
    if (cleaned) return;
    syncPill();
    const bt = window.btApp;
    if (!bt || typeof bt.addFeature !== 'function') return;
    if (!unhookFeature) {
      try {
        unhookFeature = bt.addFeature((scope, env) => {
          renderer.featScope = scope;
          return {
            frame(frameState, renderQueue) {
              try {
                if (!cleaned && env && env.engine) {
                  installRenderHook(env);
                }
              } catch {}
            },
          };
        });
      } catch (e) {
        log('addFeature error:', e);
      }
    }
    if (bt.engine && typeof bt.engine.render === 'function' && renderer.eng !== bt.engine) {
      installRenderHook({ engine: bt.engine });
    }
  }, 350);

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(pollTimer);
    try { unhookFeature && unhookFeature(); } catch {}
    try { unsubBleNotify && unsubBleNotify(); } catch {}
    try { unsubBleConnect && unsubBleConnect(); } catch {}
    try { unsubBleDisconnect && unsubBleDisconnect(); } catch {}
    try { unsubRide && unsubRide(); } catch {}
    try { rideChannel && rideChannel.close(); } catch {}
    if (renderer.eng && renderer.origRender && renderer.eng.render !== renderer.origRender) {
      try { renderer.eng.render = renderer.origRender; } catch {}
    }
    restoreGpuHooks();
    try { renderer.vbuf?.destroy?.(); } catch {}
    try { renderer.ibuf?.destroy?.(); } catch {}
    try { renderer.ubuf?.destroy?.(); } catch {}
    try { pill.remove(); } catch {}
    if (window.__terraRowbikeCleanup === cleanup) delete window.__terraRowbikeCleanup;
    log('cleaned up');
  }

  window.__terraRowbikeCleanup = cleanup;
  terra.onCleanup(cleanup);
})();
