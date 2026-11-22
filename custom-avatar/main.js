/* Custom 3D Avatar v0.1.0
 * Imports rigged .glb humanoid avatars (Half-Life 2, World of Warcraft, Mixamo, VRM, etc.)
 * and drives them live with Biketerra's per-frame rider skeleton & 2-bone IK.
 *
 * - Stores imported .glb files in IndexedDB (persists across reloads).
 * - Hides only the ego rider's native `body` skinned draw while keeping the real Biketerra bike.
 * - Captures Biketerra's live 22-bone `rider_bones` matrices every frame and retargets pelvis,
 *   spine chain, neck, head, 2-bone IK legs (locked to pedals), and 2-bone IK arms (locked to bars).
 * - Injects a depth-tested textured skinned WebGPU pipeline + planar ground shadow into the main pass.
 */
'use strict';

(async () => {
  const log = (...a) => {
    try { terra.log(...a); } catch { try { console.log('[custom-avatar]', ...a); } catch {} }
  };

  if (window.__terraCustomAvatarCleanup) {
    try { window.__terraCustomAvatarCleanup(); } catch {}
  }

  const DEFAULTS = {
    enabledMode: 'active',      // 'active' | 'off'
    animationMode: 'retarget_ik', // 'retarget_ik' | 'rigid_rider'
    scale: 1.0,
    seatOffsetY: 0.0,
    seatOffsetZ: 0.0,
    facingOffsetDeg: 'auto',    // 'auto' | '0' | '90' | '180' | '-90'
    castShadow: true,
    hideNativeBody: true,
  };

  let S = { ...DEFAULTS };
  try { S = { ...DEFAULTS, ...(await terra.settings.all()) }; } catch {}

  let cleaned = false;
  let unhookFeature = null;
  let unsubSettings = null;
  let unsubPreview = null;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));

  /* ── 1. Vector / 3x3 / 4x4 / Quaternion Math Helpers ─────────────────────── */
  function vSub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vAdd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function vScale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function vLen(a) { return Math.hypot(a[0], a[1], a[2]); }
  function vDot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function vNorm(a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-7 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
  }
  function vCross(a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  }

  // 3x3 matrices are stored as array of 3 columns: [c0, c1, c2]
  const M3_ID = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

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

  function m3RotAxis(a, ang) {
    const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    const x = a[0], y = a[1], z = a[2];
    return [
      [t * x * x + c,     t * x * y + s * z, t * x * z - s * y],
      [t * x * y - s * z, t * y * y + c,     t * y * z + s * x],
      [t * x * z + s * y, t * y * z - s * x, t * z * z + c    ],
    ];
  }

  function m3Swing(v1, v2, frac) {
    const a = vNorm(v1), b = vNorm(v2);
    const ax = vCross(a, b);
    const s = vLen(ax);
    const d = clamp(vDot(a, b), -1, 1);
    if (s < 1e-5) {
      if (d < -0.999) {
        const fb = Math.abs(a[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
        const perp = vNorm(vCross(a, fb));
        return m3RotAxis(perp, Math.PI * frac);
      }
      return M3_ID;
    }
    const ang = Math.atan2(s, d);
    return m3RotAxis([ax[0] / s, ax[1] / s, ax[2] / s], ang * frac);
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
    const bB = buildBasis3(dBind, refBind);
    const bP = buildBasis3(dPose, refPose);
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

  function m3ToQuat(m) {
    // Columns c0, c1, c2 -> row-major elements m[col][row]
    const m00 = m[0][0], m01 = m[1][0], m02 = m[2][0];
    const m10 = m[0][1], m11 = m[1][1], m12 = m[2][1];
    const m20 = m[0][2], m21 = m[1][2], m22 = m[2][2];
    const tr = m00 + m11 + m22;
    let x, y, z, w;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1.0);
      w = 0.25 / s;
      x = (m21 - m12) * s;
      y = (m02 - m20) * s;
      z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2.0 * Math.sqrt(Math.max(1e-12, 1.0 + m00 - m11 - m22));
      w = (m21 - m12) / s;
      x = 0.25 * s;
      y = (m01 + m10) / s;
      z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2.0 * Math.sqrt(Math.max(1e-12, 1.0 + m11 - m00 - m22));
      w = (m02 - m20) / s;
      x = (m01 + m10) / s;
      y = 0.25 * s;
      z = (m12 + m21) / s;
    } else {
      const s = 2.0 * Math.sqrt(Math.max(1e-12, 1.0 + m22 - m00 - m11));
      w = (m10 - m01) / s;
      x = (m02 + m20) / s;
      y = (m12 + m21) / s;
      z = 0.25 * s;
    }
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  }

  function quatToM3(q) {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      [1 - (yy + zz), xy + wz, xz - wy],
      [xy - wz, 1 - (xx + zz), yz + wx],
      [xz + wy, yz - wx, 1 - (xx + yy)],
    ];
  }

  function quatSlerp(a, b, t) {
    let bx = b[0], by = b[1], bz = b[2], bw = b[3];
    let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    if (dot > 0.9995) {
      const x = a[0] + (bx - a[0]) * t;
      const y = a[1] + (by - a[1]) * t;
      const z = a[2] + (bz - a[2]) * t;
      const w = a[3] + (bw - a[3]) * t;
      const l = Math.hypot(x, y, z, w) || 1;
      return [x / l, y / l, z / l, w / l];
    }
    const theta0 = Math.acos(clamp(dot, -1, 1));
    const sin0 = Math.sin(theta0);
    const s0 = Math.sin((1 - t) * theta0) / sin0;
    const s1 = Math.sin(t * theta0) / sin0;
    return [
      s0 * a[0] + s1 * bx,
      s0 * a[1] + s1 * by,
      s0 * a[2] + s1 * bz,
      s0 * a[3] + s1 * bw,
    ];
  }

  function m3Slerp(mA, mB, t) {
    if (t <= 0) return mA;
    if (t >= 1) return mB;
    return quatToM3(quatSlerp(m3ToQuat(mA), m3ToQuat(mB), t));
  }

  function m4Mul(a, b) {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  function m4Invert(m) {
    const out = new Float64Array(16);
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
    det = 1.0 / det;

    out[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  }

  function m4TransformPoint(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8]  * z + m[12],
      m[1] * x + m[5] * y + m[9]  * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
  }

  function m4TransformDir(m, x, y, z) {
    return [
      m[0] * x + m[4] * y + m[8]  * z,
      m[1] * x + m[5] * y + m[9]  * z,
      m[2] * x + m[6] * y + m[10] * z,
    ];
  }

  function solveTwoBoneIK(ax, ay, az, bx, by, bz, L1, L2, px, py, pz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const rawD = Math.hypot(dx, dy, dz);
    const minD = Math.abs(L1 - L2) + 0.012;
    const maxD = L1 + L2 - 0.005;
    const d = clamp(rawD, minD, maxD);
    const invD = rawD > 1e-5 ? (1 / rawD) : 1;
    const fx = dx * invD, fy = dy * invD, fz = dz * invD;

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

  /* ── 2. IndexedDB Persistence for .glb Models ─────────────────────────────── */
  const IDB_NAME = 'terra_custom_avatar_v1';
  let idbPromise = null;

  function openIdb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('models')) {
          db.createObjectStore('models', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    return idbPromise;
  }

  async function idbListModels() {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('models', 'readonly');
      const req = tx.objectStore('models').getAll();
      req.onsuccess = () => {
        const list = (req.result || []).map((r) => ({
          id: r.id, name: r.name, size: r.size, savedAt: r.savedAt,
        }));
        list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
        resolve(list);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGetModel(id) {
    if (!id) return null;
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('models', 'readonly');
      const req = tx.objectStore('models').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSaveModel(name, bytes) {
    const db = await openIdb();
    const id = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const rec = { id, name, size: bytes.byteLength, bytes, savedAt: Date.now() };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    return rec;
  }

  async function idbDeleteModel(id) {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetActiveId() {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('activeId');
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSetActiveId(id) {
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'activeId', value: id || null });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGetHiddenParts(id) {
    if (!id) return null;
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('hidden:' + id);
      req.onsuccess = () => resolve(req.result && Array.isArray(req.result.value) ? req.result.value : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSetHiddenParts(id, list) {
    if (!id) return;
    const db = await openIdb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key: 'hidden:' + id, value: Array.isArray(list) ? list : [] });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /* ── 3. Pure-JS GLB 2.0 Parser ────────────────────────────────────────────── */
  const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const COMP_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

  function decodeDataUri(uri) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/i.exec(String(uri || ''));
    if (!m) return null;
    const mime = m[1] || 'application/octet-stream';
    if (m[2]) {
      const bin = atob(m[3]);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return { bytes: out, mime };
    }
    const dec = decodeURIComponent(m[3]);
    const out = new Uint8Array(dec.length);
    for (let i = 0; i < dec.length; i++) out[i] = dec.charCodeAt(i);
    return { bytes: out, mime };
  }

  function nodeLocalMatrix(n) {
    if (n && Array.isArray(n.matrix) && n.matrix.length === 16) {
      return Float64Array.from(n.matrix);
    }
    const t = (n && n.translation) || [0, 0, 0];
    const q = (n && n.rotation) || [0, 0, 0, 1];
    const s = (n && n.scale) || [1, 1, 1];
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    return Float64Array.from([
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ]);
  }

  function parseGlb(arrayBuffer, fileName) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 20) {
      throw new Error('File is too small to be a valid .glb.');
    }
    const dv = new DataView(arrayBuffer);
    const magic = dv.getUint32(0, true);
    const version = dv.getUint32(4, true);
    if (magic !== 0x46546c67) {
      throw new Error('Not a binary glTF (.glb) file (missing glTF magic header).');
    }
    if (version !== 2) {
      throw new Error(`Unsupported glTF version ${version} (expected 2).`);
    }

    let json = null;
    let binBytes = null;
    let offset = 12;
    const totalLen = Math.min(dv.getUint32(8, true), arrayBuffer.byteLength);
    while (offset + 8 <= totalLen) {
      const chunkLen = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const dataStart = offset + 8;
      if (dataStart + chunkLen > arrayBuffer.byteLength) break;
      if (chunkType === 0x4e4f534a) {
        const str = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer, dataStart, chunkLen));
        json = JSON.parse(str);
      } else if (chunkType === 0x004e4942) {
        binBytes = new Uint8Array(arrayBuffer, dataStart, chunkLen);
      }
      offset = dataStart + chunkLen;
    }
    if (!json) throw new Error('GLB is missing its JSON chunk.');

    const reqExt = json.extensionsRequired || [];
    if (reqExt.includes('KHR_draco_mesh_compression')) {
      throw new Error('This .glb uses Draco mesh compression. Re-export from Blender with Draco disabled.');
    }

    const buffers = (json.buffers || []).map((b, i) => {
      if (b.uri) {
        const dec = decodeDataUri(b.uri);
        if (dec) return dec.bytes;
      }
      if (i === 0 && binBytes) return binBytes;
      return new Uint8Array(0);
    });
    const bufferViews = json.bufferViews || [];
    const accessors = json.accessors || [];

    function readAccessor(accIdx, asFloat) {
      const acc = accessors[accIdx];
      if (!acc) return null;
      const numComp = TYPE_COMPONENTS[acc.type] || 1;
      const compSize = COMP_BYTES[acc.componentType] || 4;
      const count = acc.count || 0;
      const out = asFloat ? new Float32Array(count * numComp) : new Uint32Array(count * numComp);
      if (acc.bufferView === undefined) return out;
      const bv = bufferViews[acc.bufferView];
      if (!bv) return out;
      const buf = buffers[bv.buffer || 0];
      if (!buf || buf.byteLength === 0) return out;
      const baseOff = (bv.byteOffset || 0) + (acc.byteOffset || 0);
      const stride = bv.byteStride || (numComp * compSize);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const norm = !!acc.normalized;
      const ct = acc.componentType;

      for (let i = 0; i < count; i++) {
        const rowOff = baseOff + i * stride;
        const dstBase = i * numComp;
        for (let c = 0; c < numComp; c++) {
          const p = rowOff + c * compSize;
          let v = 0;
          if (ct === 5126) v = view.getFloat32(p, true);
          else if (ct === 5125) v = view.getUint32(p, true);
          else if (ct === 5123) v = view.getUint16(p, true);
          else if (ct === 5122) v = view.getInt16(p, true);
          else if (ct === 5121) v = view.getUint8(p);
          else if (ct === 5120) v = view.getInt8(p);

          if (asFloat && norm) {
            if (ct === 5121) v /= 255;
            else if (ct === 5123) v /= 65535;
            else if (ct === 5120) v = Math.max(-1, v / 127);
            else if (ct === 5122) v = Math.max(-1, v / 32767);
          }
          out[dstBase + c] = v;
        }
      }
      return out;
    }

    // Node hierarchy & bind-pose world transforms
    const nodes = json.nodes || [];
    const nodeParent = new Int32Array(nodes.length).fill(-1);
    for (let i = 0; i < nodes.length; i++) {
      const ch = nodes[i].children;
      if (Array.isArray(ch)) {
        for (let k = 0; k < ch.length; k++) nodeParent[ch[k]] = i;
      }
    }
    const nodeWorld = new Array(nodes.length);
    function getNodeWorld(i) {
      if (nodeWorld[i]) return nodeWorld[i];
      const loc = nodeLocalMatrix(nodes[i]);
      nodeWorld[i] = nodeParent[i] >= 0 ? m4Mul(getNodeWorld(nodeParent[i]), loc) : loc;
      return nodeWorld[i];
    }
    for (let i = 0; i < nodes.length; i++) getNodeWorld(i);

    // Unified skeleton table across all skins (handles single-skin HL2/Mixamo/WoW and multi-skin exports)
    const skins = json.skins || [];
    const nodeToJoint = new Map();
    const joints = []; // { nodeIdx, name, ibm, pBindRaw }
    const skinJointRemap = []; // skinIdx -> Int32Array mapping local skin joint index -> unified joint index

    for (let si = 0; si < skins.length; si++) {
      const sk = skins[si];
      const sJoints = sk.joints || [];
      const ibmData = sk.inverseBindMatrices !== undefined ? readAccessor(sk.inverseBindMatrices, true) : null;

      // Compute scene-world -> skin-mesh-space transform so joints with placeholder/zero-weight IBMs
      // (e.g. Sketchfab FBX->glTF exports with non-identity root scale/rotation like Smash Bros Sheik)
      // still map `getNodeWorld(ni)` into the exact same coordinate space as valid `inv(ibm)` joints!
      let skinWorldToMesh = null;
      if (ibmData) {
        for (let ji = 0; ji < sJoints.length; ji++) {
          const ni = sJoints[ji];
          const ibm = Float64Array.from(ibmData.subarray(ji * 16, ji * 16 + 16));
          const invIbm = m4Invert(ibm);
          const nodeW = getNodeWorld(ni);
          const ibmHasPos = invIbm && Math.hypot(invIbm[12], invIbm[13], invIbm[14]) > 1e-4;
          const nodeHasPos = Math.hypot(nodeW[12], nodeW[13], nodeW[14]) > 1e-4;
          if (ibmHasPos && nodeHasPos) {
            const invNodeW = m4Invert(nodeW);
            if (invNodeW) {
              skinWorldToMesh = m4Mul(invIbm, invNodeW);
              break;
            }
          }
        }
      }
      if (!skinWorldToMesh) {
        for (let ni = 0; ni < nodes.length; ni++) {
          if (nodes[ni].skin === si) {
            skinWorldToMesh = m4Invert(getNodeWorld(ni));
            if (skinWorldToMesh) break;
          }
        }
      }

      const remap = new Int32Array(sJoints.length);
      for (let ji = 0; ji < sJoints.length; ji++) {
        const ni = sJoints[ji];
        let uIdx = nodeToJoint.get(ni);
        if (uIdx === undefined) {
          uIdx = joints.length;
          nodeToJoint.set(ni, uIdx);
          const nodeW = getNodeWorld(ni);
          const nodeInMesh = skinWorldToMesh ? m4Mul(skinWorldToMesh, nodeW) : nodeW;
          const ibm = ibmData
            ? Float64Array.from(ibmData.subarray(ji * 16, ji * 16 + 16))
            : (m4Invert(nodeInMesh) || Float64Array.from([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]));
          const invIbm = m4Invert(ibm);
          // Some FBX->glTF exporters write placeholder scaled-identity IBMs (t=0,0,0) for zero-weight
          // helper/hand/finger bones while the node hierarchy still has the true 3D joint position.
          const ibmHasPos = invIbm && Math.hypot(invIbm[12], invIbm[13], invIbm[14]) > 1e-4;
          const nodeHasPos = Math.hypot(nodeInMesh[12], nodeInMesh[13], nodeInMesh[14]) > 1e-4;
          const w = (invIbm && (ibmHasPos || !nodeHasPos)) ? invIbm : nodeInMesh;
          joints.push({
            nodeIdx: ni,
            name: (nodes[ni] && nodes[ni].name) || `joint_${uIdx}`,
            ibm,
            pBindRaw: [w[12], w[13], w[14]],
          });
        }
        remap[ji] = uIdx;
      }
      skinJointRemap.push(remap);
    }

    // If model has no skin at all, create 1 synthetic root joint so unrigged meshes still render cleanly
    const isSkinned = joints.length > 0;
    if (!isSkinned) {
      joints.push({
        nodeIdx: -1,
        name: 'root',
        ibm: Float64Array.from([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]),
        pBindRaw: [0, 0, 0],
      });
    }

    // Joint parent indices & topological order (parent always before child)
    const parentJoint = new Int32Array(joints.length).fill(-1);
    const childrenJoints = joints.map(() => []);
    for (let j = 0; j < joints.length; j++) {
      let p = joints[j].nodeIdx >= 0 ? nodeParent[joints[j].nodeIdx] : -1;
      while (p >= 0) {
        const pj = nodeToJoint.get(p);
        if (pj !== undefined) {
          parentJoint[j] = pj;
          childrenJoints[pj].push(j);
          break;
        }
        p = nodeParent[p];
      }
    }
    const topoOrder = [];
    const visited = new Uint8Array(joints.length);
    function visitJoint(j) {
      if (visited[j]) return;
      visited[j] = 1;
      if (parentJoint[j] >= 0) visitJoint(parentJoint[j]);
      topoOrder.push(j);
    }
    for (let j = 0; j < joints.length; j++) visitJoint(j);

    // Embedded images
    const images = (json.images || []).map((img) => {
      if (img.bufferView !== undefined) {
        const bv = bufferViews[img.bufferView];
        const buf = bv ? buffers[bv.buffer || 0] : null;
        if (buf && bv) {
          const slice = buf.slice(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
          return { bytes: slice, mimeType: img.mimeType || 'image/png' };
        }
      } else if (img.uri) {
        const dec = decodeDataUri(img.uri);
        if (dec) return { bytes: dec.bytes, mimeType: img.mimeType || dec.mime };
      }
      return null;
    });

    const samplers = (json.samplers || []).map((s) => ({
      wrapS: s.wrapS === 33071 ? 'clamp-to-edge' : (s.wrapS === 33648 ? 'mirror-repeat' : 'repeat'),
      wrapT: s.wrapT === 33071 ? 'clamp-to-edge' : (s.wrapT === 33648 ? 'mirror-repeat' : 'repeat'),
      magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
      minFilter: (s.minFilter === 9728 || s.minFilter === 9984 || s.minFilter === 9986) ? 'nearest' : 'linear',
    }));

    const textures = (json.textures || []).map((t) => ({
      imageIdx: t.source !== undefined ? t.source : -1,
      samplerIdx: t.sampler !== undefined ? t.sampler : -1,
    }));

    const materials = (json.materials || []).map((m) => {
      const pbr = m.pbrMetallicRoughness || {};
      const bcf = Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length === 4
        ? pbr.baseColorFactor
        : [1, 1, 1, 1];
      const texInfo = pbr.baseColorTexture;
      const tex = texInfo && textures[texInfo.index];
      const alphaMode = m.alphaMode || 'OPAQUE';
      const alphaCutoff = alphaMode === 'MASK' ? (m.alphaCutoff !== undefined ? m.alphaCutoff : 0.5) : 0.0;
      return {
        name: m.name || 'mat',
        baseColorFactor: bcf,
        imageIdx: tex ? tex.imageIdx : -1,
        samplerIdx: tex ? tex.samplerIdx : -1,
        alphaMode,
        alphaCutoff,
        metallic: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 0.0,
        roughness: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 0.65,
        doubleSided: !!m.doubleSided,
        unlit: !!(m.extensions && m.extensions.KHR_materials_unlit),
      };
    });
    if (materials.length === 0) {
      materials.push({
        name: 'default', baseColorFactor: [0.85, 0.85, 0.88, 1],
        imageIdx: -1, samplerIdx: -1, alphaMode: 'OPAQUE', alphaCutoff: 0,
        metallic: 0, roughness: 0.65, doubleSided: true, unlit: false,
      });
    }

    // Collect mesh primitives from scene graph
    const meshes = json.meshes || [];
    const primitives = [];
    let totalVerts = 0;
    let totalTris = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    // Walk reachable nodes from active scene (or all mesh nodes if no scenes array)
    const meshNodeList = [];
    const sceneIdx = json.scene !== undefined ? json.scene : 0;
    const activeScene = json.scenes && json.scenes[sceneIdx];
    const visitedNodes = new Uint8Array(nodes.length);
    function walkSceneNode(ni) {
      if (ni < 0 || ni >= nodes.length || visitedNodes[ni]) return;
      visitedNodes[ni] = 1;
      const n = nodes[ni];
      if (n.mesh !== undefined && meshes[n.mesh]) meshNodeList.push(ni);
      if (Array.isArray(n.children)) {
        for (let i = 0; i < n.children.length; i++) walkSceneNode(n.children[i]);
      }
    }
    if (activeScene && Array.isArray(activeScene.nodes)) {
      for (let i = 0; i < activeScene.nodes.length; i++) walkSceneNode(activeScene.nodes[i]);
    } else {
      for (let i = 0; i < nodes.length; i++) if (nodes[i].mesh !== undefined) meshNodeList.push(i);
    }

    for (let mni = 0; mni < meshNodeList.length; mni++) {
      const ni = meshNodeList[mni];
      const node = nodes[ni];
      const mesh = meshes[node.mesh];
      if (!mesh || !Array.isArray(mesh.primitives)) continue;

      const hasSkin = node.skin !== undefined && skinJointRemap[node.skin];
      const remap = hasSkin ? skinJointRemap[node.skin] : null;
      // If unskinned child mesh is parented to a bone node (e.g. WoW helmet/shoulderpad), attach to that bone
      let rigidJoint = 0;
      let attachedToBone = !!hasSkin;
      let rigidXform = null;
      if (!hasSkin) {
        let p = ni;
        while (p >= 0) {
          const pj = nodeToJoint.get(p);
          if (pj !== undefined) { rigidJoint = pj; attachedToBone = true; break; }
          p = nodeParent[p];
        }
        rigidXform = getNodeWorld(ni);
      }

      for (let pi = 0; pi < mesh.primitives.length; pi++) {
        const prim = mesh.primitives[pi];
        const mode = prim.mode !== undefined ? prim.mode : 4;
        if (mode !== 4) continue; // Only TRIANGLES
        const attrs = prim.attributes || {};
        if (attrs.POSITION === undefined) continue;

        const pos = readAccessor(attrs.POSITION, true);
        const vCount = (pos.length / 3) | 0;
        if (vCount <= 0) continue;

        let norm = attrs.NORMAL !== undefined ? readAccessor(attrs.NORMAL, true) : null;
        const uv = attrs.TEXCOORD_0 !== undefined ? readAccessor(attrs.TEXCOORD_0, true) : null;
        const j0 = hasSkin && attrs.JOINTS_0 !== undefined ? readAccessor(attrs.JOINTS_0, false) : null;
        const w0 = hasSkin && attrs.WEIGHTS_0 !== undefined ? readAccessor(attrs.WEIGHTS_0, true) : null;

        let indices;
        if (prim.indices !== undefined) {
          indices = readAccessor(prim.indices, false);
        } else {
          indices = new Uint32Array(vCount);
          for (let i = 0; i < vCount; i++) indices[i] = i;
        }
        if (indices.length < 3) continue;

        // Pre-transform unskinned primitive into scene bind space
        const posWork = new Float32Array(vCount * 3);
        if (rigidXform) {
          for (let i = 0; i < vCount; i++) {
            const p3 = m4TransformPoint(rigidXform, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            posWork[i * 3] = p3[0];
            posWork[i * 3 + 1] = p3[1];
            posWork[i * 3 + 2] = p3[2];
          }
        } else {
          posWork.set(pos);
        }

        // Compute normals if missing
        if (!norm) {
          norm = new Float32Array(vCount * 3);
          for (let i = 0; i + 2 < indices.length; i += 3) {
            const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
            const e1x = posWork[ib] - posWork[ia], e1y = posWork[ib + 1] - posWork[ia + 1], e1z = posWork[ib + 2] - posWork[ia + 2];
            const e2x = posWork[ic] - posWork[ia], e2y = posWork[ic + 1] - posWork[ia + 1], e2z = posWork[ic + 2] - posWork[ia + 2];
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            norm[ia] += nx; norm[ia + 1] += ny; norm[ia + 2] += nz;
            norm[ib] += nx; norm[ib + 1] += ny; norm[ib + 2] += nz;
            norm[ic] += nx; norm[ic + 1] += ny; norm[ic + 2] += nz;
          }
          for (let i = 0; i < vCount; i++) {
            const l = Math.hypot(norm[i * 3], norm[i * 3 + 1], norm[i * 3 + 2]) || 1;
            norm[i * 3] /= l; norm[i * 3 + 1] /= l; norm[i * 3 + 2] /= l;
          }
        } else if (rigidXform) {
          const nWork = new Float32Array(vCount * 3);
          for (let i = 0; i < vCount; i++) {
            const n3 = vNorm(m4TransformDir(rigidXform, norm[i * 3], norm[i * 3 + 1], norm[i * 3 + 2]));
            nWork[i * 3] = n3[0]; nWork[i * 3 + 1] = n3[1]; nWork[i * 3 + 2] = n3[2];
          }
          norm = nWork;
        }

        // Interleave into 56-byte vertices:
        // pos(3f:0..11), norm(3f:12..23), uv(2f:24..31), joints(4u16:32..39), weights(4f:40..55)
        const vBuf = new ArrayBuffer(vCount * 56);
        const f32 = new Float32Array(vBuf);
        const u16 = new Uint16Array(vBuf);
        const maxJoint = joints.length - 1;
        const isSceneProp = isSkinned && !attachedToBone;

        for (let i = 0; i < vCount; i++) {
          const px = posWork[i * 3], py = posWork[i * 3 + 1], pz = posWork[i * 3 + 2];
          if (!isSceneProp) {
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
            if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
          }

          const fo = i * 14;
          f32[fo + 0] = px;
          f32[fo + 1] = py;
          f32[fo + 2] = pz;
          f32[fo + 3] = norm[i * 3];
          f32[fo + 4] = norm[i * 3 + 1];
          f32[fo + 5] = norm[i * 3 + 2];
          f32[fo + 6] = uv ? uv[i * 2] : 0;
          f32[fo + 7] = uv ? uv[i * 2 + 1] : 0;

          const uo = i * 28 + 16;
          if (j0 && w0 && remap) {
            let wa = w0[i * 4], wb = w0[i * 4 + 1], wc = w0[i * 4 + 2], wd = w0[i * 4 + 3];
            const ws = wa + wb + wc + wd;
            if (ws > 1e-5) { wa /= ws; wb /= ws; wc /= ws; wd /= ws; }
            else { wa = 1; wb = 0; wc = 0; wd = 0; }
            u16[uo + 0] = clamp(remap[j0[i * 4]] ?? 0, 0, maxJoint);
            u16[uo + 1] = clamp(remap[j0[i * 4 + 1]] ?? 0, 0, maxJoint);
            u16[uo + 2] = clamp(remap[j0[i * 4 + 2]] ?? 0, 0, maxJoint);
            u16[uo + 3] = clamp(remap[j0[i * 4 + 3]] ?? 0, 0, maxJoint);
            f32[fo + 10] = wa;
            f32[fo + 11] = wb;
            f32[fo + 12] = wc;
            f32[fo + 13] = wd;
          } else {
            u16[uo + 0] = rigidJoint;
            u16[uo + 1] = 0;
            u16[uo + 2] = 0;
            u16[uo + 3] = 0;
            f32[fo + 10] = 1;
            f32[fo + 11] = 0;
            f32[fo + 12] = 0;
            f32[fo + 13] = 0;
          }
        }

        const matIdx = (prim.material !== undefined && materials[prim.material]) ? prim.material : 0;
        const matLabel = (materials[matIdx] && materials[matIdx].name) || mesh.name || `part_${matIdx}`;
        const partKey = `${matLabel}${isSceneProp ? '::prop' : ''}`;
        primitives.push({
          vertBytes: vBuf,
          indices,
          vertCount: vCount,
          indexCount: indices.length,
          materialIdx: matIdx,
          partKey,
          partLabel: matLabel,
          isSceneProp,
        });
        totalVerts += vCount;
        totalTris += (indices.length / 3) | 0;
      }
    }

    if (primitives.length === 0) {
      throw new Error('No triangle meshes found in this .glb file.');
    }
    if (!Number.isFinite(minX)) { minX = -0.5; maxX = 0.5; minY = 0; maxY = 1.7; minZ = -0.5; maxZ = 0.5; }

    // Deduplicated per-part/material visibility catalog (auto-hides unskinned backdrops, mirrors & handheld props)
    const AUTO_HIDE_RE = /(backdrop|background|skybox|stage|pedestal|floor_?plane|ground_?plane|studio|mirror|cellphone|smartphone|phone_?screen|phone_?back)/i;
    const partsMap = new Map();
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives[i];
      let entry = partsMap.get(p.partKey);
      if (!entry) {
        const defaultHidden = p.isSceneProp || AUTO_HIDE_RE.test(p.partLabel);
        entry = {
          key: p.partKey,
          label: p.partLabel,
          tris: 0,
          isSceneProp: p.isSceneProp,
          defaultHidden,
        };
        partsMap.set(p.partKey, entry);
      }
      entry.tris += (p.indexCount / 3) | 0;
    }
    const parts = Array.from(partsMap.values());

    return {
      fileName: fileName || 'avatar.glb',
      isSkinned,
      joints,
      parentJoint,
      childrenJoints,
      topoOrder,
      images,
      samplers,
      materials,
      primitives,
      parts,
      totalVerts,
      totalTris,
      bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    };
  }

  /* ── 4. Humanoid Bone Auto-Mapper & Canonical Bind Calibration ────────────── */
  function cleanBoneName(name) {
    let s = String(name || '');
    // Strip leading Smash Bros / numbered prefixes like "_03_-_HipN_04" or "04_-_LLegJ"
    s = s.replace(/^_?\d+[_\s-]+-[_\s-]+/i, '');
    // Strip common rig prefixes before lowercasing so CamelCase L/R prefixes stay detectable
    s = s
      .replace(/^valvebiped[._\s-]*/i, '')
      .replace(/^bip\d*[._\s-]*/i, '')
      .replace(/^mixamorig\d*[:._\s-]*/i, '')
      .replace(/^armature[:._\s-]*/i, '')
      .replace(/^j_bip_(?:c_)?/i, '')
      .replace(/^def[._-]/i, '');
    // Split CamelCase side prefix: "LShoulderJ" -> "L_ShoulderJ", "HLP_LKneeJb" -> "HLP_L_KneeJb"
    s = s.replace(/(^|[._\s-])([LR])(?=[A-Z][a-z])/g, '$1$2_');
    return s
      .toLowerCase()
      .replace(/_\d+$/g, '') // trailing Sketchfab numeric suffix like _01, _083
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function isHelperBone(clean, raw) {
    if (/(^|_)(end|nub|twist|helper|hlp|swg|assist|dyn|deform|org|mch|tgt|attach|attachment|weapon|haven|thrown|sakotsu|tekubi|comaneci|shol|nurbs|socket|bracer|armband|strap|backpack|bicep|ulna|trapezius|latt|cloth|cape|cloak|skirt|hair|momi|ponytail|braid|breast|pec|eye|eyeball|jaw|mouth|tongue|brow|lid|lip|ear|cheek|chin|teeth|nose|face|pouch|sheath|quiver|finger|fingerbasen|thumb|index|middle|ring|pinky|carpal|metacarpal|forward|wansyo|ik|ctrl|target|pole)($|_)/.test(clean)) {
      return true;
    }
    if (/(^|_)bust_?\d+($|_)/.test(clean)) return true;
    if (/_(end|eff)(?:_\d+)?$/i.test(raw)) return true;
    return false;
  }

  function sideOfBone(clean) {
    if (/(^|_)(l|left)($|_)/.test(clean) || /left/.test(clean)) return 'l';
    if (/(^|_)(r|right)($|_)/.test(clean) || /right/.test(clean)) return 'r';
    if (/_l$/.test(clean)) return 'l';
    if (/_r$/.test(clean)) return 'r';
    return null;
  }

  function mapHumanoidSkeleton(model) {
    const { joints, parentJoint, childrenJoints } = model;
    const map = {
      hips: -1, chest: -1, neck: -1, head: -1,
      lShoulder: -1, lUpperArm: -1, lForearm: -1, lHand: -1,
      rShoulder: -1, rUpperArm: -1, rForearm: -1, rHand: -1,
      lThigh: -1, lShin: -1, lFoot: -1, lToe: -1,
      rThigh: -1, rShin: -1, rFoot: -1, rToe: -1,
    };

    const cleanedNames = joints.map((jt) => cleanBoneName(jt.name));
    let rigStyle = 'Generic';
    for (let i = 0; i < joints.length; i++) {
      const raw = joints[i].name || '';
      const cl = cleanedNames[i];
      if (/valvebiped/i.test(raw)) { rigStyle = 'ValveBiped'; break; }
      if (/mixamorig/i.test(raw)) { rigStyle = 'Mixamo'; break; }
      if (/^(hipn|bustn|l_shoulderj|r_shoulderj|l_armj|r_armj|l_legj|r_legj)$/.test(cl)) {
        rigStyle = 'SmashBros'; break;
      }
      if (/^skl_root$/.test(cl)) { rigStyle = 'Nintendo'; break; }
    }

    const nonTerminalSlots = new Set([
      'hips', 'chest', 'neck',
      'lShoulder', 'rShoulder', 'lUpperArm', 'rUpperArm', 'lForearm', 'rForearm',
      'lThigh', 'rThigh', 'lShin', 'rShin',
    ]);

    const candidates = {};
    const addCand = (slot, jIdx, score) => {
      // Penalize zero-child leaf/duplicate bones for non-terminal limb slots (e.g. Linkle Elbow_L, Master Chief clavicle_l_09_0)
      let adjScore = score;
      if (nonTerminalSlots.has(slot) && childrenJoints[jIdx].length === 0) adjScore -= 28;
      if (!candidates[slot] || adjScore > candidates[slot].score) {
        candidates[slot] = { idx: jIdx, score: adjScore };
      }
    };

    for (let j = 0; j < joints.length; j++) {
      const raw = joints[j].name || '';
      const clean = cleanedNames[j];
      if (!clean || isHelperBone(clean, raw)) continue;
      const side = sideOfBone(clean);

      if (!side) {
        if (/^(pelvis|hips|hip|hipn|root_hips|waist_root)$/.test(clean)) addCand('hips', j, 105);
        else if (/^waist$/.test(clean)) addCand('hips', j, 85);
        else if (/^skl_root$/.test(clean)) addCand('hips', j, 70);
        else if (/(pelvis|hips)/.test(clean)) addCand('hips', j, 80);

        if (/^bustn$/.test(clean)) {
          addCand('chest', j, 105);
        } else if (/^waistn$/.test(clean)) {
          addCand('chest', j, 55);
        } else if (/^(upper_?chest|chest|thorax|spine_?0?5|spine_?0?4|spine_?0?3|spine_?0?2)$/.test(clean)) {
          const num = parseInt((clean.match(/\d+/) || ['0'])[0], 10);
          addCand('chest', j, 70 + num * 5 + (clean.includes('chest') ? 15 : 0));
        } else if (/^spine/.test(clean)) {
          const num = parseInt((clean.match(/\d+/) || ['0'])[0], 10);
          addCand('chest', j, 40 + num * 5);
        }

        if (/^neckn?0*\d*$/.test(clean)) addCand('neck', j, 105);
        else if (/neck/.test(clean)) addCand('neck', j, 75);

        if (/^headn?0*\d*$/.test(clean)) addCand('head', j, 105);
        else if (/head/.test(clean)) addCand('head', j, 75);
      } else {
        const pfx = side; // 'l' or 'r'
        // Super Smash Bros naming: ShoulderN=clavicle, ShoulderJ=upperArm, ArmJ=forearm, LegJ=thigh, KneeJ=shin
        if (/(^|_)shouldern($|_)/.test(clean)) {
          addCand(pfx + 'Shoulder', j, 110);
        } else if (/(clavicle|collar|shoulder)/.test(clean) && !/(upper|arm|pad|armor|shoulderj)/.test(clean)) {
          addCand(pfx + 'Shoulder', j, clean.includes('clavicle') ? 105 : 85);
        }

        if (/(^|_)shoulderj($|_)/.test(clean)) {
          addCand(pfx + 'UpperArm', j, 110);
        } else if (/(upper_?arm|upperarm|up_?arm|humerus|arm_?1($|_))/.test(clean)) {
          addCand(pfx + 'UpperArm', j, 105);
        } else if (/(^|_)arm($|_)/.test(clean) && !/(fore|lower)/.test(clean)) {
          addCand(pfx + 'UpperArm', j, 80);
        }

        if (/(^|_)armj($|_)/.test(clean)) {
          addCand(pfx + 'Forearm', j, 110);
        } else if (/(fore_?arm|forearm|lower_?arm|lowerarm|arm_?2($|_))/.test(clean)) {
          addCand(pfx + 'Forearm', j, 105);
        } else if (/(^|_)elbow($|_)/.test(clean)) {
          addCand(pfx + 'Forearm', j, 80);
        }

        if (/(^|_)handn?($|_)/.test(clean)) {
          addCand(pfx + 'Hand', j, 105);
        } else if (/(^|_)wrist($|_)/.test(clean)) {
          addCand(pfx + 'Hand', j, 85);
        }

        if (/(^|_)legj($|_)/.test(clean)) {
          addCand(pfx + 'Thigh', j, 110);
        } else if (/(thigh|up_?leg|upleg|upper_?leg|upperleg|femur|leg_?1($|_))/.test(clean)) {
          addCand(pfx + 'Thigh', j, 105);
        } else if (/(^|_)hip($|_)/.test(clean)) {
          addCand(pfx + 'Thigh', j, 55);
        }

        if (/(^|_)kneej($|_)/.test(clean)) {
          addCand(pfx + 'Shin', j, 110);
        } else if (/(calf|shin|lower_?leg|lowerleg|leg_?2($|_))/.test(clean)) {
          addCand(pfx + 'Shin', j, 105);
        } else if (/(^|_)knee($|_)/.test(clean)) {
          addCand(pfx + 'Shin', j, 80);
        } else if (/(^|_)leg($|_)/.test(clean) && !/(up|upper)/.test(clean)) {
          addCand(pfx + 'Shin', j, 75);
        }

        if (/(^|_)footj?($|_)|(^|_)ankle($|_)/.test(clean)) {
          addCand(pfx + 'Foot', j, 105);
        }
        if (/toen?|(^|_)ball($|_)/.test(clean)) {
          addCand(pfx + 'Toe', j, /toe/.test(clean) ? 95 : 80);
        }
      }
    }

    for (const k of Object.keys(map)) {
      if (candidates[k]) map[k] = candidates[k].idx;
    }

    // Helper: pick the first non-helper child (or first child with descendants)
    const primaryChild = (jIdx) => {
      const ch = childrenJoints[jIdx] || [];
      if (ch.length === 0) return -1;
      for (const c of ch) {
        if (!isHelperBone(cleanedNames[c], joints[c].name || '') && childrenJoints[c].length > 0) return c;
      }
      for (const c of ch) {
        if (!isHelperBone(cleanedNames[c], joints[c].name || '')) return c;
      }
      return ch[0];
    };

    // Infer missing parent/child chain links from skeleton topology
    if (map.lShin < 0 && map.lThigh >= 0) map.lShin = primaryChild(map.lThigh);
    if (map.rShin < 0 && map.rThigh >= 0) map.rShin = primaryChild(map.rThigh);
    if (map.lFoot < 0 && map.lShin >= 0) map.lFoot = primaryChild(map.lShin);
    if (map.rFoot < 0 && map.rShin >= 0) map.rFoot = primaryChild(map.rShin);
    if (map.lForearm < 0 && map.lUpperArm >= 0) map.lForearm = primaryChild(map.lUpperArm);
    if (map.rForearm < 0 && map.rUpperArm >= 0) map.rForearm = primaryChild(map.rUpperArm);
    if (map.lHand < 0 && map.lForearm >= 0) map.lHand = primaryChild(map.lForearm);
    if (map.rHand < 0 && map.rForearm >= 0) map.rHand = primaryChild(map.rForearm);

    // If `hips` is a sibling of the spine (e.g. BotW/Nintendo: Skl_Root -> {Spine_1, Waist -> Legs}),
    // promote `hips` to the lowest common ancestor of `hips` and `chest/neck` when it sits near hip height!
    const spineRef = map.chest >= 0 ? map.chest : (map.neck >= 0 ? map.neck : map.head);
    if (map.hips >= 0 && spineRef >= 0 && map.hips !== spineRef) {
      const hipAnc = new Set();
      let cur = map.hips;
      while (cur >= 0 && !hipAnc.has(cur)) { hipAnc.add(cur); cur = parentJoint[cur]; }
      let lca = spineRef;
      const seen = new Set();
      while (lca >= 0 && !hipAnc.has(lca) && !seen.has(lca)) { seen.add(lca); lca = parentJoint[lca]; }
      if (lca >= 0 && lca !== map.hips) {
        const bb = model.bbox;
        const modelDiag = Math.max(1e-4, Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]));
        const dist = vLen(vSub(joints[lca].pBindRaw, joints[map.hips].pBindRaw));
        if (dist < modelDiag * 0.16) {
          map.hips = lca;
        }
      }
    }

    // Count how many core bones were matched by name
    const coreKeys = [
      'hips', 'head', 'lThigh', 'lShin', 'lFoot', 'rThigh', 'rShin', 'rFoot',
      'lUpperArm', 'lForearm', 'lHand', 'rUpperArm', 'rForearm', 'rHand',
    ];
    let matchedCore = coreKeys.filter((k) => map[k] >= 0).length;

    // Geometric/topological fallback for unnamed skeletons (e.g. WoW `bone_0..bone_N`)
    if (model.isSkinned && matchedCore < 6 && joints.length >= 10) {
      rigStyle = 'Auto-Topo';
      const bb = model.bbox;
      const sx = bb.max[0] - bb.min[0];
      const sy = bb.max[1] - bb.min[1];
      const sz = bb.max[2] - bb.min[2];
      const upIdx = (sy >= sx * 0.7 && sy >= sz * 0.7) ? 1 : (sz >= sx ? 2 : 0);
      const latIdx = upIdx === 1 ? 0 : (upIdx === 2 ? 0 : 1);
      const minU = bb.min[upIdx], spanU = Math.max(1e-4, bb.max[upIdx] - bb.min[upIdx]);
      const midLat = (bb.min[latIdx] + bb.max[latIdx]) * 0.5;

      const chainFromTo = (anc, leaf) => {
        const path = [];
        let cur = leaf;
        const guard = new Set();
        while (cur >= 0 && cur !== anc && !guard.has(cur)) {
          guard.add(cur);
          path.push(cur);
          cur = parentJoint[cur];
        }
        if (cur !== anc) return null;
        path.reverse();
        return path;
      };

      // Hips = joint near center laterally, ~38-62% height, with >=2 children
      let bestHips = -1, bestHipsScore = -1e9;
      for (let j = 0; j < joints.length; j++) {
        const p = joints[j].pBindRaw;
        const hFrac = (p[upIdx] - minU) / spanU;
        const latErr = Math.abs(p[latIdx] - midLat) / spanU;
        const deg = childrenJoints[j].length;
        if (deg < 2 || hFrac < 0.25 || hFrac > 0.68) continue;
        const sc = deg * 2 - Math.abs(hFrac - 0.50) * 8 - latErr * 10;
        if (sc > bestHipsScore) { bestHipsScore = sc; bestHips = j; }
      }
      if (bestHips >= 0) {
        if (map.hips < 0) map.hips = bestHips;
        // Collect all descendants of hips
        const desc = [];
        const stack = [map.hips];
        const vis = new Set();
        while (stack.length) {
          const cur = stack.pop();
          if (vis.has(cur)) continue;
          vis.add(cur);
          desc.push(cur);
          for (const c of childrenJoints[cur]) stack.push(c);
        }

        // Highest central descendant -> head
        if (map.head < 0) {
          let bestHead = -1, bestH = -Infinity;
          for (const j of desc) {
            const p = joints[j].pBindRaw;
            if (Math.abs(p[latIdx] - midLat) < spanU * 0.14 && p[upIdx] > bestH) {
              bestH = p[upIdx]; bestHead = j;
            }
          }
          if (bestHead >= 0 && bestHead !== map.hips) {
            map.head = bestHead;
            if (map.neck < 0 && parentJoint[bestHead] >= 0 && parentJoint[bestHead] !== map.hips) {
              map.neck = parentJoint[bestHead];
            }
          }
        }

        // Legs: two lowest joints on opposite sides of midLat
        let lowNeg = -1, lowNegH = Infinity, lowPos = -1, lowPosH = Infinity;
        for (const j of desc) {
          const p = joints[j].pBindRaw;
          const hFrac = (p[upIdx] - minU) / spanU;
          if (hFrac > 0.28) continue;
          const dLat = p[latIdx] - midLat;
          if (dLat < -spanU * 0.02 && p[upIdx] < lowNegH) { lowNegH = p[upIdx]; lowNeg = j; }
          if (dLat >  spanU * 0.02 && p[upIdx] < lowPosH) { lowPosH = p[upIdx]; lowPos = j; }
        }
        // In glTF (+Z forward, +Y up), +X is character's LEFT and -X is RIGHT
        const assignLeg = (footLeaf, pfx) => {
          if (footLeaf < 0) return;
          const path = chainFromTo(map.hips, footLeaf);
          if (!path || path.length < 3) return;
          // If the lowest joint is a toe, back up 1 step to the ankle
          const footPos = joints[path[path.length - 1]].pBindRaw;
          const prevPos = joints[path[path.length - 2]].pBindRaw;
          const usePath = (path.length >= 4 && Math.abs(footPos[upIdx] - prevPos[upIdx]) < spanU * 0.06)
            ? path.slice(0, -1) : path;
          if (usePath.length >= 3) {
            if (map[pfx + 'Thigh'] < 0) map[pfx + 'Thigh'] = usePath[usePath.length - 3];
            if (map[pfx + 'Shin'] < 0)  map[pfx + 'Shin']  = usePath[usePath.length - 2];
            if (map[pfx + 'Foot'] < 0)  map[pfx + 'Foot']  = usePath[usePath.length - 1];
          }
        };
        assignLeg(lowPos, 'l');
        assignLeg(lowNeg, 'r');

        // Arms: two furthest-lateral upper-body joints on opposite sides of midLat
        const spineAnc = new Set();
        let sc = map.neck >= 0 ? map.neck : map.head;
        while (sc >= 0 && !spineAnc.has(sc)) { spineAnc.add(sc); sc = parentJoint[sc]; }
        let farPos = -1, farPosD = 0, farNeg = -1, farNegD = 0;
        for (const j of desc) {
          const p = joints[j].pBindRaw;
          const hFrac = (p[upIdx] - minU) / spanU;
          if (hFrac < 0.35 || hFrac > 0.90) continue;
          const dLat = p[latIdx] - midLat;
          if (dLat > farPosD) { farPosD = dLat; farPos = j; }
          if (-dLat > farNegD) { farNegD = -dLat; farNeg = j; }
        }
        const assignArm = (tipLeaf, pfx) => {
          if (tipLeaf < 0) return;
          // Walk up until we hit the spine chain
          const path = [];
          let cur = tipLeaf;
          const guard = new Set();
          while (cur >= 0 && !spineAnc.has(cur) && !guard.has(cur)) {
            guard.add(cur);
            path.push(cur);
            cur = parentJoint[cur];
          }
          path.reverse();
          // Trim finger tips at the end if chain > 4 (hand is usually the branching node with >=2 children)
          let handPos = path.length - 1;
          for (let k = Math.min(path.length - 1, 4); k >= 2; k--) {
            if (childrenJoints[path[k]].length >= 2) { handPos = k; break; }
          }
          const armPath = path.slice(0, handPos + 1);
          if (armPath.length >= 4) {
            if (map[pfx + 'Shoulder'] < 0) map[pfx + 'Shoulder'] = armPath[0];
            if (map[pfx + 'UpperArm'] < 0) map[pfx + 'UpperArm'] = armPath[1];
            if (map[pfx + 'Forearm'] < 0)  map[pfx + 'Forearm']  = armPath[2];
            if (map[pfx + 'Hand'] < 0)     map[pfx + 'Hand']     = armPath[3];
          } else if (armPath.length === 3) {
            if (map[pfx + 'UpperArm'] < 0) map[pfx + 'UpperArm'] = armPath[0];
            if (map[pfx + 'Forearm'] < 0)  map[pfx + 'Forearm']  = armPath[1];
            if (map[pfx + 'Hand'] < 0)     map[pfx + 'Hand']     = armPath[2];
          }
        };
        assignArm(farPos, 'l');
        assignArm(farNeg, 'r');
      }
      matchedCore = coreKeys.filter((k) => map[k] >= 0).length;
    }

    // Build ordered spine chain strictly between `hips` and `neck` (or `head`)
    const spineChain = [];
    const spineTop = map.neck >= 0 ? map.neck : (map.head >= 0 ? map.head : map.chest);
    if (map.hips >= 0 && spineTop >= 0) {
      let cur = (spineTop === map.chest) ? spineTop : parentJoint[spineTop];
      const guard = new Set();
      while (cur >= 0 && cur !== map.hips && !guard.has(cur)) {
        guard.add(cur);
        spineChain.push(cur);
        cur = parentJoint[cur];
      }
      if (cur === map.hips) {
        spineChain.reverse();
      } else {
        spineChain.length = 0;
        if (map.chest >= 0 && map.chest !== map.hips) spineChain.push(map.chest);
      }
    }
    if (spineChain.length > 0 && map.chest < 0) {
      map.chest = spineChain[spineChain.length - 1];
    }

    // Build set of mapped core bones so we know which are animated directly vs inherited
    return {
      map,
      spineChain,
      rigStyle,
      matchedCore,
      totalCore: coreKeys.length,
    };
  }

  // Biketerra's 22-bone bind positions in Rowbike/Rider space (+X=Right, +Y=Up, +Z=Back):
  //   rbX = bindZ, rbY = bindY, rbZ = -bindX  (so bindPos_bt = [-rbZ, rbY, rbX])
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
  const BT_HEAD_TO_FOOT = BONE_BIND_RB[5][1] - BONE_BIND_RB[18][1]; // 1.4612 m
  const BT_HIP_TO_FOOT  = BONE_BIND_RB[16][1] - BONE_BIND_RB[18][1]; // 0.8027 m

  function snapAxisIfClose(v) {
    const n = vNorm(v);
    const axes = [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]];
    for (const a of axes) {
      if (vDot(n, a) > 0.975) return a;
    }
    return n;
  }

  function calibrateCharacter(model, rig) {
    const { joints, childrenJoints, bbox } = model;
    const m = rig.map;
    const jp = (idx) => (idx >= 0 && joints[idx] ? joints[idx].pBindRaw : null);

    // 1. Up vector in raw glTF mesh space
    let rawU = [0, 1, 0];
    const pHead = jp(m.head) || jp(m.neck);
    const pFootL = jp(m.lFoot), pFootR = jp(m.rFoot);
    const pMidFoot = (pFootL && pFootR) ? vScale(vAdd(pFootL, pFootR), 0.5) : (pFootL || pFootR || jp(m.hips));
    if (pHead && pMidFoot && vLen(vSub(pHead, pMidFoot)) > 1e-4) {
      rawU = snapAxisIfClose(vSub(pHead, pMidFoot));
    } else {
      const sy = bbox.max[1] - bbox.min[1];
      const sz = bbox.max[2] - bbox.min[2];
      rawU = sz > sy * 1.25 ? [0, 0, 1] : [0, 1, 0];
    }

    // 2. Right vector in raw glTF mesh space (from Left limb -> Right limb)
    let rawR = [-1, 0, 0]; // glTF default (+Z forward, +Y up => Right is -X)
    const lrPairs = [
      [jp(m.lUpperArm), jp(m.rUpperArm)],
      [jp(m.lThigh), jp(m.rThigh)],
      [jp(m.lShoulder), jp(m.rShoulder)],
      [jp(m.lFoot), jp(m.rFoot)],
    ];
    for (const [pl, pr] of lrPairs) {
      if (pl && pr) {
        const d = vSub(pr, pl);
        const proj = vSub(d, vScale(rawU, vDot(d, rawU)));
        if (vLen(proj) > 1e-4) {
          rawR = snapAxisIfClose(proj);
          break;
        }
      }
    }
    // Re-orthogonalize rawR against rawU
    rawR = vNorm(vSub(rawR, vScale(rawU, vDot(rawR, rawU))));
    // Back vector = cross(rawR, rawU) -> guarantees right-handed det = +1!
    let rawB = vNorm(vCross(rawR, rawU));

    // Apply optional user facing override around rawU
    if (S.facingOffsetDeg && S.facingOffsetDeg !== 'auto') {
      const deg = Number(S.facingOffsetDeg) || 0;
      if (Math.abs(deg) > 0.1) {
        const rot = m3RotAxis(rawU, (deg * Math.PI) / 180);
        rawR = vNorm(m3MulVec(rot, rawR));
        rawB = vNorm(vCross(rawR, rawU));
      }
    }

    // Q = R_rawToRb has rows [rawR, rawU, rawB], so columns are:
    const Q = [
      [rawR[0], rawU[0], rawB[0]],
      [rawR[1], rawU[1], rawB[1]],
      [rawR[2], rawU[2], rawB[2]],
    ];

    // 3. Auto-scale character height & cockpit reach to match Biketerra's human rider
    let autoScale = 1.0;
    const pHipL = jp(m.lThigh), pHipR = jp(m.rThigh);
    const pMidHip = (pHipL && pHipR) ? vScale(vAdd(pHipL, pHipR), 0.5) : jp(m.hips);
    if (pHead && pFootL && pFootR) {
      const hSpan = Math.abs(vDot(vSub(pHead, pMidFoot), rawU));
      const lSpan = pMidHip ? Math.abs(vDot(vSub(pMidHip, pMidFoot), rawU)) : 0;
      if (hSpan > 1e-4) {
        const sHead = BT_HEAD_TO_FOOT / hSpan;
        const sLeg = lSpan > 1e-4 ? (BT_HIP_TO_FOOT / lSpan) : sHead;
        const sHeightLeg = sHead * 0.65 + sLeg * 0.35;
        // Blend in upper-body cockpit reach (torso + arm) so stylized characters with large heads
        // or long legs + petite torsos (e.g. Arcane/anime rigs) still fit the bike's reach cleanly.
        const pUpL = jp(m.lUpperArm), pUpR = jp(m.rUpperArm);
        const pFoL = jp(m.lForearm),  pFoR = jp(m.rForearm);
        const pHaL = jp(m.lHand),     pHaR = jp(m.rHand);
        if (pMidHip && pUpL && pUpR && pFoL && pFoR && pHaL && pHaR) {
          const pMidSh = vScale(vAdd(pUpL, pUpR), 0.5);
          const torsoLen = vLen(vSub(pMidSh, pMidHip));
          const armLen = 0.5 * (
            vLen(vSub(pFoL, pUpL)) + vLen(vSub(pHaL, pFoL)) +
            vLen(vSub(pFoR, pUpR)) + vLen(vSub(pHaR, pFoR))
          );
          const reachSpan = torsoLen + armLen;
          if (reachSpan > 1e-4) {
            const sReach = 1.047 / reachSpan; // BT torso (0.542) + BT arm (0.505)
            autoScale = clamp(sHead * 0.35 + sLeg * 0.30 + sReach * 0.35, sHeightLeg * 0.88, sHeightLeg * 1.18);
          } else {
            autoScale = sHeightLeg;
          }
        } else {
          autoScale = sHeightLeg;
        }
      }
    } else {
      // Fallback: bbox span along rawU -> 1.72 m
      const corners = [
        [bbox.min[0], bbox.min[1], bbox.min[2]],
        [bbox.max[0], bbox.max[1], bbox.max[2]],
      ];
      const hMin = Math.min(vDot(corners[0], rawU), vDot(corners[1], rawU));
      const hMax = Math.max(vDot(corners[0], rawU), vDot(corners[1], rawU));
      const span = Math.abs(hMax - hMin);
      if (span > 1e-4) autoScale = 1.72 / span;
    }

    // Precompute scaled bind joint positions in rbSpace (at userScale=1, btScale=1)
    const charPosBase = joints.map((jt) => vScale(m3MulVec(Q, jt.pBindRaw), autoScale));

    // Mid-hip bind position in rbSpace (base scale)
    let midHipBase;
    if (m.lThigh >= 0 && m.rThigh >= 0) {
      midHipBase = vScale(vAdd(charPosBase[m.lThigh], charPosBase[m.rThigh]), 0.5);
    } else if (m.hips >= 0) {
      midHipBase = charPosBase[m.hips].slice();
    } else {
      const midRaw = [
        (bbox.min[0] + bbox.max[0]) * 0.5,
        (bbox.min[1] + bbox.max[1]) * 0.5,
        (bbox.min[2] + bbox.max[2]) * 0.5,
      ];
      midHipBase = vScale(m3MulVec(Q, midRaw), autoScale);
    }

    // Hand bind orientation (finger direction, dorsal/back-of-hand normal, palm length) & finger chains
    const analyzeHand = (handIdx, foreIdx, side) => {
      const fbDir = (handIdx >= 0 && foreIdx >= 0)
        ? vNorm(vSub(charPosBase[handIdx], charPosBase[foreIdx]))
        : [0, 0, -1];
      const fbBack = vNorm(vSub([side * 0.5, 0.866, 0], vScale(fbDir, vDot([side * 0.5, 0.866, 0], fbDir))));
      if (handIdx < 0) return { dir: fbDir, back: fbBack, palmLen: 0.095, fingerChains: [] };

      const fingerRoots = [];
      let indexRoot = -1, pinkyRoot = -1;
      let sx = 0, sy = 0, sz = 0, lenSum = 0, cnt = 0;
      const isNonFingerChild = (cl, raw) =>
        /(attach|attachment|weapon|have|haven|throw|thrown|end|nub|ik|ctrl|wrist|ulna|bracelet|prop|hlp|swg|assist|dyn)/.test(cl) ||
        /_(end|eff)(?:_\d+)?$/i.test(raw);

      // Walk past palm / metacarpal / Smash Bros FingerBaseN / cascading MiddleN->RingN->PinkyN containers
      const knuckleCandidates = [];
      const collectKnuckles = (parentJ, depth) => {
        if (depth > 5) return;
        const kids = childrenJoints[parentJ] || [];
        for (const c of kids) {
          const raw = (joints[c] && joints[c].name) || '';
          const cl = cleanBoneName(raw);
          if (isNonFingerChild(cl, raw)) continue;
          const validSub = (childrenJoints[c] || []).filter((k) => {
            const kr = (joints[k] && joints[k].name) || '';
            return !isNonFingerChild(cleanBoneName(kr), kr);
          });
          const isContainer =
            /(metacarpal|carpal|finger_?base|palm)/.test(cl) ||
            (validSub.length >= 2 && validSub.some((k) => /(1n?|01|_1)($|_)/.test(cleanBoneName((joints[k] && joints[k].name) || '')))) ||
            (/(middle|ring|pinky)n$/.test(cl) && validSub.length >= 1);
          if (isContainer && validSub.length > 0) {
            collectKnuckles(c, depth + 1);
          } else {
            knuckleCandidates.push(c);
          }
        }
      };
      collectKnuckles(handIdx, 0);

      for (const c of knuckleCandidates) {
        const raw = (joints[c] && joints[c].name) || '';
        const cl = cleanBoneName(raw);
        const d = vSub(charPosBase[c], charPosBase[handIdx]);
        const dl = vLen(d);
        if (dl < 0.012 || dl > 0.22) continue;

        const isThumb = /(thumb|finger_?0($|_)|finger_?a($|_))/.test(cl);
        if (/(index|finger_?1($|_)|finger_?b($|_))/.test(cl)) indexRoot = c;
        if (/(pinky|little|finger_?4($|_)|finger_?e($|_))/.test(cl)) pinkyRoot = c;

        // Collect phalanx chain (up to 4 segments, skipping _end_ tips and bogus origin joints)
        const chain = [c];
        let cur = c;
        for (let depth = 0; depth < 3; depth++) {
          const kids = (childrenJoints[cur] || []).filter((k) => {
            const kr = (joints[k] && joints[k].name) || '';
            const kc = cleanBoneName(kr);
            if (isNonFingerChild(kc, kr)) return false;
            const segLen = vLen(vSub(charPosBase[k], charPosBase[cur]));
            return segLen >= 0.004 && segLen <= 0.10;
          });
          if (kids.length === 0) break;
          cur = kids[0];
          chain.push(cur);
        }
        fingerRoots.push({ isThumb, chain });

        if (!isThumb) {
          sx += d[0]; sy += d[1]; sz += d[2];
          lenSum += dl;
          cnt++;
        }
      }

      const dir = cnt > 0 ? vNorm([sx, sy, sz]) : fbDir;
      const palmLen = cnt > 0 ? clamp(lenSum / cnt, 0.055, 0.16) : 0.095;

      // Dorsal (back-of-hand) normal from index->pinky x fingerDir:
      // Left (side=-1): cross(dir, pinky - index); Right (side=+1): cross(pinky - index, dir)
      let back = fbBack;
      if (indexRoot >= 0 && pinkyRoot >= 0) {
        const span = vSub(charPosBase[pinkyRoot], charPosBase[indexRoot]);
        const n = side < 0 ? vCross(dir, span) : vCross(span, dir);
        if (vLen(n) > 1e-5) back = vNorm(n);
      } else {
        back = vNorm(vSub(fbBack, vScale(dir, vDot(fbBack, dir))));
      }

      // Measure existing bind-pose finger curl toward palm (-back) so both flat-hand rigs
      // (Mixamo/WoW) and pre-curled rigs (HL2/ValveBiped) curl to the same natural grip.
      const palmDir = vScale(back, -1);
      for (let fi = 0; fi < fingerRoots.length; fi++) {
        const fc = fingerRoots[fi];
        const chn = fc.chain;
        const bindCurls = [];
        for (let k = 0; k < chn.length; k++) {
          if (k + 1 < chn.length) {
            const seg = vNorm(vSub(charPosBase[chn[k + 1]], charPosBase[chn[k]]));
            bindCurls.push(Math.atan2(vDot(seg, palmDir), vDot(seg, dir)));
          } else {
            bindCurls.push(bindCurls.length > 0 ? bindCurls[bindCurls.length - 1] : 0);
          }
        }
        fc.bindCurls = bindCurls;
      }

      return { dir, back, palmLen, fingerChains: fingerRoots };
    };

    const lHandInfo = analyzeHand(m.lHand, m.lForearm, -1);
    const rHandInfo = analyzeHand(m.rHand, m.rForearm,  1);

    // Track trapezius helper bones (e.g. ValveBiped L/R_Trapezius) so chestplate collars stay flat
    // even when clavicles smoothly follow the forward cycling arm reach.
    const trapJoints = [];
    for (let j = 0; j < joints.length; j++) {
      const cl = cleanBoneName(joints[j].name);
      if (/(trapezius|_trap($|_))/.test(cl)) trapJoints.push(j);
    }

    // Anchor disconnected secondary armatures (e.g. Linkle's separate `skin 1` hair rig!) to their
    // nearest semantic core bone (e.g. `head`) instead of letting them drift rigidly with `hips`.
    const detachedRootAnchors = [];
    if (m.hips >= 0) {
      const hipAnc = new Set();
      let hc = m.hips;
      while (hc >= 0 && !hipAnc.has(hc)) { hipAnc.add(hc); hc = model.parentJoint[hc]; }
      const coreAnchors = [m.head, m.neck, m.chest, m.hips, m.lHand, m.rHand, m.lFoot, m.rFoot]
        .filter((idx) => idx >= 0);

      for (let j = 0; j < joints.length; j++) {
        if (model.parentJoint[j] >= 0 || hipAnc.has(j)) continue;
        // Collect subtree names & average non-origin bind position
        const stack = [j];
        const vis = new Set();
        let isHeadSub = false;
        let ax = 0, ay = 0, az = 0, ac = 0;
        while (stack.length) {
          const cur = stack.pop();
          if (vis.has(cur)) continue;
          vis.add(cur);
          const nm = joints[cur].name || '';
          if (/(hair|momi|ponytail|braid|bangs|hat|hood|helmet|glasses|ear|face|eye|brow|head|crown|tiara|mask|visor)/i.test(nm)) {
            isHeadSub = true;
          }
          const pb = charPosBase[cur];
          if (Math.hypot(pb[0], pb[1], pb[2]) > 0.02) {
            ax += pb[0]; ay += pb[1]; az += pb[2]; ac++;
          }
          for (const ch of childrenJoints[cur]) stack.push(ch);
        }
        let anchor = m.hips;
        if (isHeadSub && m.head >= 0) {
          anchor = m.head;
        } else if (ac > 0 && coreAnchors.length > 0) {
          const avg = [ax / ac, ay / ac, az / ac];
          let bestD = Infinity;
          for (const aIdx of coreAnchors) {
            const dd = vLen(vSub(avg, charPosBase[aIdx]));
            if (dd < bestD) { bestD = dd; anchor = aIdx; }
          }
        }
        detachedRootAnchors.push({ joint: j, anchor });
      }
    }

    return {
      Q,
      rawR, rawU, rawB,
      autoScale,
      charPosBase,
      midHipBase,
      lHandInfo,
      rHandInfo,
      trapJoints,
      detachedRootAnchors,
      canRetarget: model.isSkinned && m.hips >= 0 && rig.matchedCore >= 6,
    };
  }

  /* ── 5. Live Biketerra Skeleton Extraction & Retargeting Solver ───────────── */
  const btLive = {
    raw: new Float32Array(22 * 16),
    valid: false,
    lastMs: 0,
    egoBuf: null,
    P: Array.from({ length: 22 }, () => [0, 0, 0]),
    R: Array.from({ length: 22 }, () => M3_ID),
    btScale: 1.0,
  };

  function unpackBtLiveBones() {
    const raw = btLive.raw;
    let sumScale = 0;
    for (let b = 0; b < 22; b++) {
      const o = b * 16;
      const pRb = BONE_BIND_RB[b];
      // Biketerra GLB bind space: bindX = -rbZ, bindY = rbY, bindZ = rbX
      const bx = -pRb[2], by = pRb[1], bz = pRb[0];
      const px = raw[o + 0] * bx + raw[o + 4] * by + raw[o + 8]  * bz + raw[o + 12];
      const py = raw[o + 1] * bx + raw[o + 5] * by + raw[o + 9]  * bz + raw[o + 13];
      const pz = raw[o + 2] * bx + raw[o + 6] * by + raw[o + 10] * bz + raw[o + 14];
      btLive.P[b][0] = px;
      btLive.P[b][1] = py;
      btLive.P[b][2] = pz;

      // Columns of M_bt[b]: col0=bind+X(-Z_rb), col1=bind+Y(+Y_rb), col2=bind+Z(+X_rb)
      const c2 = [raw[o + 8],  raw[o + 9],  raw[o + 10]]; // +X_rb (Right)
      const c1 = [raw[o + 4],  raw[o + 5],  raw[o + 6]];  // +Y_rb (Up)
      const c0 = [-raw[o + 0], -raw[o + 1], -raw[o + 2]]; // +Z_rb (Back)
      const l1 = vLen(c1);
      if (b <= 5 && l1 > 0.1) sumScale += l1;

      const uY = vNorm(c1);
      const uX = vNorm(vSub(c2, vScale(uY, vDot(c2, uY))));
      const uZ = vCross(uX, uY);
      btLive.R[b] = [uX, uY, uZ];
    }
    btLive.btScale = sumScale > 0.5 ? clamp(sumScale / 6, 0.4, 2.0) : 1.0;
  }

  function solveAvatarPose(av, rider, ox, oz) {
    const { model, rig, cal, boneData, poseR, poseP, posedFlags } = av;
    const jointCount = model.joints.length;
    const userScale = clamp(S.scale, 0.25, 3.0);
    const offY = clamp(S.seatOffsetY, -1.0, 1.0);
    const offZ = clamp(S.seatOffsetZ, -1.0, 1.0);

    const hasBt = btLive.valid && (performance.now() - btLive.lastMs) < 1500;
    if (hasBt) unpackBtLiveBones();

    const scFactor = (hasBt ? btLive.btScale : ((rider && rider.renderScale) || 1.0)) * userScale;
    const scTotal = cal.autoScale * scFactor;

    // Helper: scaled bind joint position in rbSpace (meters)
    const C = (j) => {
      const b = cal.charPosBase[j];
      return [b[0] * scFactor, b[1] * scFactor, b[2] * scFactor];
    };

    posedFlags.fill(0);

    const useRetarget = hasBt && cal.canRetarget && S.animationMode !== 'rigid_rider';
    const m = rig.map;

    if (useRetarget) {
      const P = btLive.P;
      const R = btLive.R;
      const R_pelvis = R[0];

      // 1. Pelvis / Hips anchored to Biketerra's live mid-hip position + user seat offsets
      const btMidHip = vScale(vAdd(P[16], P[19]), 0.5);
      const offsetWorld = m3MulVec(R_pelvis, [0, offY, offZ]);
      const midHipTarget = vAdd(btMidHip, offsetWorld);
      const charMidHip = vScale(cal.midHipBase, scFactor);

      poseR[m.hips] = R_pelvis;
      poseP[m.hips] = vAdd(midHipTarget, m3MulVec(R_pelvis, vSub(C(m.hips), charMidHip)));
      posedFlags[m.hips] = 1;

      const stepFromParent = (jIdx, pIdx) => {
        const d = vSub(C(jIdx), C(pIdx));
        return vAdd(poseP[pIdx], m3MulVec(poseR[pIdx], d));
      };

      // 2. Smooth Spine Chain (hips -> spine... -> chest) slerped across Biketerra's spine 0..3
      const spRots = [R[0], R[1], R[2], R[3]];
      const sampleSpineR = (t) => {
        const f = clamp(t, 0, 1) * 3;
        const i0 = Math.min(2, Math.floor(f));
        return m3Slerp(spRots[i0], spRots[i0 + 1], f - i0);
      };
      let lastTorso = m.hips;
      const spChain = rig.spineChain;
      for (let i = 0; i < spChain.length; i++) {
        const sj = spChain[i];
        const frac = (i + 1) / spChain.length;
        poseP[sj] = stepFromParent(sj, lastTorso);
        poseR[sj] = sampleSpineR(frac);
        posedFlags[sj] = 1;
        lastTorso = sj;
      }

      // Precompute live handlebar hood grip targets so both torso lean & arm IK share exact targets
      const computeHandTarget = (side, btHand, btFing, handInfo) => {
        const btHandDirRaw = vSub(P[btFing], P[btHand]);
        const hasDir = vLen(btHandDirRaw) > 0.01;
        const btHandDir = hasDir ? vNorm(btHandDirRaw) : vScale(R[btHand][2], -1);
        const hoodNudge = vAdd(
          vAdd(vScale(R_pelvis[1], 0.020 * scFactor), vScale(R_pelvis[0], side * 0.018 * scFactor)),
          vScale(btHandDir, -0.004 * scFactor)
        );
        const gripPoint = vAdd(P[btFing], hoodNudge);
        const target = hasDir
          ? vSub(gripPoint, vScale(btHandDir, handInfo.palmLen * scFactor))
          : vAdd(P[btHand], hoodNudge);
        return { btHandDir, target };
      };
      const lHandGoal = computeHandTarget(-1, 9, 10, cal.lHandInfo);
      const rHandGoal = computeHandTarget( 1, 14, 15, cal.rHandInfo);

      // 2b. Align spine pitch/yaw toward Biketerra's live shoulder midpoint, then auto-lean forward
      //     (plus gentle saddle slide) if a petite/short-armed model still needs reach to grip the hoods
      if (spChain.length > 0 && m.lUpperArm >= 0 && m.rUpperArm >= 0) {
        const chestIdx = (m.chest >= 0 && posedFlags[m.chest]) ? m.chest : spChain[spChain.length - 1];
        const estUp = (shIdx, upIdx) => {
          if (shIdx >= 0) {
            const pSh = stepFromParent(shIdx, chestIdx);
            return vAdd(pSh, m3MulVec(poseR[chestIdx], vSub(C(upIdx), C(shIdx))));
          }
          return stepFromParent(upIdx, chestIdx);
        };
        const gMidSh = vScale(vAdd(estUp(m.lShoulder, m.lUpperArm), estUp(m.rShoulder, m.rUpperArm)), 0.5);
        const btMidShTarget = vAdd(vScale(vAdd(P[7], P[12]), 0.5), offsetWorld);
        const pivotP = poseP[spChain[0]];
        const vCharT = vSub(gMidSh, pivotP);
        const vBtT   = vSub(btMidShTarget, pivotP);
        let swingFull = M3_ID;
        if (vLen(vCharT) > 0.08 && vLen(vBtT) > 0.08) {
          swingFull = m3Swing(vCharT, vBtT, 1.0);
        }
        const applySpineSwing = (extraRot) => {
          const totalRot = extraRot ? m3Mul(extraRot, swingFull) : swingFull;
          let prevTorso = m.hips;
          for (let i = 0; i < spChain.length; i++) {
            const sj = spChain[i];
            const frac = (i + 1) / spChain.length;
            const w = spChain.length === 1 ? 1.0 : (0.50 + 0.50 * (i / (spChain.length - 1)));
            poseP[sj] = stepFromParent(sj, prevTorso);
            poseR[sj] = m3Mul(m3Slerp(M3_ID, totalRot, w), sampleSpineR(frac));
            prevTorso = sj;
          }
          lastTorso = prevTorso;
        };
        applySpineSwing(null);

        // Check if either arm still falls short of a comfortable relaxed reach to the hoods
        if (m.lForearm >= 0 && m.lHand >= 0 && m.rForearm >= 0 && m.rHand >= 0) {
          const pUpL0 = estUp(m.lShoulder, m.lUpperArm);
          const pUpR0 = estUp(m.rShoulder, m.rUpperArm);
          const reachL = (vLen(vSub(C(m.lForearm), C(m.lUpperArm))) + vLen(vSub(C(m.lHand), C(m.lForearm)))) * 0.94;
          const reachR = (vLen(vSub(C(m.rForearm), C(m.rUpperArm))) + vLen(vSub(C(m.rHand), C(m.rForearm)))) * 0.94;
          // Account for ~2.5 cm gained by natural clavicle forward roll
          const clavBonus = (m.lShoulder >= 0 && m.rShoulder >= 0) ? 0.025 * scFactor : 0;
          const shortL = vLen(vSub(lHandGoal.target, pUpL0)) - (reachL + clavBonus);
          const shortR = vLen(vSub(rHandGoal.target, pUpR0)) - (reachR + clavBonus);
          const shortfall = Math.max(0, shortL, shortR);
          if (shortfall > 0.004) {
            // Scoot gently forward toward the saddle nose (<= 6.5 cm; legs stay locked to pedals via IK)
            const hipFwd = clamp(shortfall * 0.45, 0, 0.065 * scFactor);
            const fwdDir = vScale(R_pelvis[2], -1);
            poseP[m.hips] = vAdd(poseP[m.hips], vScale(fwdDir, hipFwd));
            // Lean spine forward in an aero tuck (<= 24°) to bring shoulders naturally over the bars
            const remShort = Math.max(0, shortfall - hipFwd);
            const torsoH = Math.max(0.28 * scFactor, vLen(vSub(vScale(vAdd(pUpL0, pUpR0), 0.5), poseP[spChain[0]])));
            const extraPitch = clamp((remShort / torsoH) * 1.15, 0, 0.42);
            applySpineSwing(extraPitch > 0.005 ? m3RotAxis(R_pelvis[0], -extraPitch) : null);
          }
        }
      }

      // 3. Neck & Head (gentle chin-up pitch so the avatar looks ahead down the road)
      if (m.neck >= 0) {
        poseP[m.neck] = stepFromParent(m.neck, lastTorso);
        poseR[m.neck] = m3Mul(m3RotAxis(R[4][0], 0.09), R[4]);
        posedFlags[m.neck] = 1;
        lastTorso = m.neck;
      }
      if (m.head >= 0) {
        poseP[m.head] = stepFromParent(m.head, lastTorso);
        poseR[m.head] = m3Mul(m3RotAxis(R[5][0], 0.18), R[5]);
        posedFlags[m.head] = 1;
      }

      // 4. Legs (2-bone IK locked to Biketerra's live pedaling ankles + knees)
      const legs = [
        { thigh: m.lThigh, shin: m.lShin, foot: m.lFoot, btHip: 16, btKnee: 17, btFoot: 18 },
        { thigh: m.rThigh, shin: m.rShin, foot: m.rFoot, btHip: 19, btKnee: 20, btFoot: 21 },
      ];
      for (const lg of legs) {
        if (lg.thigh < 0 || lg.shin < 0 || lg.foot < 0) continue;
        const cThigh = C(lg.thigh), cShin = C(lg.shin), cFoot = C(lg.foot);
        const lThigh = vLen(vSub(cShin, cThigh));
        const lShin  = vLen(vSub(cFoot, cShin));
        if (lThigh < 1e-4 || lShin < 1e-4) continue;

        const pHip = stepFromParent(lg.thigh, m.hips);
        const pFootTarget = P[lg.btFoot];
        const btMidLeg = vScale(vAdd(P[lg.btHip], pFootTarget), 0.5);
        let kneePole = vSub(P[lg.btKnee], btMidLeg);
        if (vLen(kneePole) < 0.03) {
          // Fallback pole: forward (-Z_rb) in pelvis space
          kneePole = vScale(R_pelvis[2], -1);
        }

        const pKnee = solveTwoBoneIK(
          pHip[0], pHip[1], pHip[2],
          pFootTarget[0], pFootTarget[1], pFootTarget[2],
          lThigh, lShin,
          kneePole[0], kneePole[1], kneePole[2]
        );

        const dThighPose = vSub(pKnee, pHip);
        const dShinPose  = vSub(pFootTarget, pKnee);
        // Medial-lateral Right axis of the knee hinge plane: cross(dShin, dThigh) points Right (+X_rb)
        const hingeCross = vCross(dShinPose, dThighPose);
        const hcLen = vLen(hingeCross);
        const rightRefPose = hcLen > 0.01
          ? vNorm(vAdd(vScale(hingeCross, 1 / hcLen), vScale(R_pelvis[0], 0.35)))
          : R_pelvis[0];

        const rThigh = alignFrame(vSub(cShin, cThigh), [1, 0, 0], dThighPose, rightRefPose);
        const rShin  = alignFrame(vSub(cFoot, cShin),  [1, 0, 0], dShinPose,  rightRefPose);
        const pFootActual = vAdd(pKnee, m3MulVec(rShin, vSub(cFoot, cShin)));

        poseP[lg.thigh] = pHip;
        poseR[lg.thigh] = rThigh;
        posedFlags[lg.thigh] = 1;

        poseP[lg.shin] = pKnee;
        poseR[lg.shin] = rShin;
        posedFlags[lg.shin] = 1;

        poseP[lg.foot] = pFootActual;
        poseR[lg.foot] = R[lg.btFoot];
        posedFlags[lg.foot] = 1;
      }

      // 5. Arms (2-bone IK locked to Biketerra's live handlebar grips + elbows + curled fingers)
      const chestAnchor = (m.chest >= 0 && posedFlags[m.chest]) ? m.chest
        : (spChain.length > 0 ? spChain[spChain.length - 1] : m.hips);
      const arms = [
        {
          side: -1, sh: m.lShoulder, up: m.lUpperArm, fo: m.lForearm, ha: m.lHand,
          btUp: 7, btElb: 8, btHand: 9, btFing: 10, hand: cal.lHandInfo, goal: lHandGoal,
        },
        {
          side: 1, sh: m.rShoulder, up: m.rUpperArm, fo: m.rForearm, ha: m.rHand,
          btUp: 12, btElb: 13, btHand: 14, btFing: 15, hand: cal.rHandInfo, goal: rHandGoal,
        },
      ];
      const TARGET_FINGER_CURLS = [0.78, 1.72, 2.20, 2.40];
      const TARGET_THUMB_CURLS  = [0.42, 0.78, 1.05, 1.15];

      for (const ar of arms) {
        if (ar.up < 0 || ar.fo < 0 || ar.ha < 0) continue;
        const cUp = C(ar.up), cFo = C(ar.fo), cHa = C(ar.ha);
        const lUp = vLen(vSub(cFo, cUp));
        const lFo = vLen(vSub(cHa, cFo));
        if (lUp < 1e-4 || lFo < 1e-4) continue;

        const btHandDir = ar.goal.btHandDir;
        const pHandTarget = ar.goal.target;

        let parentOfUp = chestAnchor;
        if (ar.sh >= 0) {
          poseP[ar.sh] = stepFromParent(ar.sh, chestAnchor);
          // Smoothly roll clavicle 25% toward the handlebar grip (pure rotation, 0 cm stretch!)
          // so bare shoulders (e.g. Jinx) curve naturally into the arm without a sharp 90° step.
          const dClavRest = m3MulVec(poseR[chestAnchor], vSub(cUp, C(ar.sh)));
          const dToHand = vSub(pHandTarget, poseP[ar.sh]);
          poseR[ar.sh] = (vLen(dClavRest) > 1e-4 && vLen(dToHand) > 1e-4)
            ? m3Mul(m3Swing(dClavRest, dToHand, 0.25), poseR[chestAnchor])
            : poseR[chestAnchor];
          posedFlags[ar.sh] = 1;
          parentOfUp = ar.sh;
        }

        let pUp = stepFromParent(ar.up, parentOfUp);

        // Tiny fallback socket shift (<= 1.5 cm) only if still barely short after aero lean + clavicle roll
        const maxReach = lUp + lFo - 0.008;
        const toW = vSub(pHandTarget, pUp);
        const dW = vLen(toW);
        if (dW > maxReach && dW > 1e-4) {
          const shift = Math.min(0.015 * scFactor, dW - maxReach);
          pUp[0] += (toW[0] / dW) * shift;
          pUp[1] += (toW[1] / dW) * shift;
          pUp[2] += (toW[2] / dW) * shift;
        }

        const btMidArm = vScale(vAdd(P[ar.btUp], pHandTarget), 0.5);
        let elbowPole = vSub(P[ar.btElb], btMidArm);
        if (vLen(elbowPole) < 0.025) {
          // Fallback pole: down + slightly out + back in chest space
          elbowPole = m3MulVec(poseR[chestAnchor], [ar.side * 0.35, -0.75, 0.55]);
        }

        const pElbow = solveTwoBoneIK(
          pUp[0], pUp[1], pUp[2],
          pHandTarget[0], pHandTarget[1], pHandTarget[2],
          lUp, lFo,
          elbowPole[0], elbowPole[1], elbowPole[2]
        );

        const midArm = vScale(vAdd(pUp, pHandTarget), 0.5);
        let bendPose = vSub(pElbow, midArm);
        if (vLen(bendPose) < 0.015) bendPose = elbowPole;

        // Zero-twist geodesic upper-arm swing from parent clavicle/chest -> posed upper arm,
        // with only a subtle clamped external roll (<= ±26°) toward the elbow hinge plane.
        // Eliminates candy-wrapper shoulder pinching on BOTH T-pose and A-pose characters!
        const dUpBind = vSub(cFo, cUp);
        const dUpPose = vSub(pElbow, pUp);
        const rUpZero = m3Mul(m3Swing(m3MulVec(poseR[parentOfUp], dUpBind), dUpPose, 1.0), poseR[parentOfUp]);
        const rUpPlane = alignFrame(dUpBind, [0, 0, 1], dUpPose, bendPose);
        const axU = vNorm(dUpPose);
        const perpU = (v) => {
          const d = vDot(v, axU);
          return [v[0] - axU[0] * d, v[1] - axU[1] * d, v[2] - axU[2] * d];
        };
        const uZ = perpU(m3MulVec(rUpZero, [0, 0, 1]));
        const uP = perpU(m3MulVec(rUpPlane, [0, 0, 1]));
        let shTwist = 0;
        if (vLen(uZ) > 1e-4 && vLen(uP) > 1e-4) {
          shTwist = Math.atan2(vDot(axU, vCross(uZ, uP)), vDot(uZ, uP));
        }
        const rUp = m3Mul(m3RotAxis(axU, clamp(shTwist * 0.30, -0.45, 0.45)), rUpZero);

        // Swing forearm cleanly from rUp across the elbow hinge (zero abrupt twist jump at elbow!)
        const dFoBind = vSub(cHa, cFo);
        const dFoPose = vSub(pHandTarget, pElbow);
        const rFo0 = m3Mul(m3Swing(m3MulVec(rUp, dFoBind), dFoPose, 1.0), rUp);
        const pHandActual = vAdd(pElbow, m3MulVec(rFo0, dFoBind));

        // Overhand road-bike hood grip: back of hand faces mostly UP (~59°) and slightly OUT (~31°)
        // so the palm rests on top of the hood, fingers wrap downward over the front/brake lever,
        // and the thumb hugs the inner top ridge of the hood.
        const gripBackWorld = m3MulVec(R_pelvis, [ar.side * 0.52, 0.85, 0]);
        const rHand = alignFrame(ar.hand.dir, ar.hand.back, btHandDir, gripBackWorld);

        // Share 65% of forearm->hand pronation roll along the forearm so the wrist stays smooth
        const axF = vNorm(vSub(pHandActual, pElbow));
        const perpF = (v) => {
          const d = vDot(v, axF);
          return [v[0] - axF[0] * d, v[1] - axF[1] * d, v[2] - axF[2] * d];
        };
        const uF = perpF(m3MulVec(rFo0, ar.hand.back));
        const uH = perpF(m3MulVec(rHand, ar.hand.back));
        let twist = 0;
        if (vLen(uF) > 1e-4 && vLen(uH) > 1e-4) {
          twist = Math.atan2(vDot(axF, vCross(uF, uH)), vDot(uF, uH));
        }
        const rFo = m3Mul(m3RotAxis(axF, twist * 0.65), rFo0);

        poseP[ar.up] = pUp;
        poseR[ar.up] = rUp;
        posedFlags[ar.up] = 1;

        poseP[ar.fo] = pElbow;
        poseR[ar.fo] = rFo;
        posedFlags[ar.fo] = 1;

        poseP[ar.ha] = pHandActual;
        poseR[ar.ha] = rHand;
        posedFlags[ar.ha] = 1;

        // Curl fingers & thumb smoothly around the brake hoods (subtracting existing bind-pose curl)
        if (ar.hand.fingerChains.length > 0) {
          const handDirW = m3MulVec(rHand, ar.hand.dir);
          const handBackW = m3MulVec(rHand, ar.hand.back);
          const curlAxis = vNorm(vCross(handBackW, handDirW));
          // Gently angle thumb forward (~16°) so it rests cleanly along the inner top edge of the hood
          const thumbBaseRot = m3Mul(m3RotAxis(handBackW, -ar.side * 0.28), rHand);
          for (let fi = 0; fi < ar.hand.fingerChains.length; fi++) {
            const fc = ar.hand.fingerChains[fi];
            const targets = fc.isThumb ? TARGET_THUMB_CURLS : TARGET_FINGER_CURLS;
            const bCurls = fc.bindCurls || [];
            const maxDelta = fc.isThumb ? 0.90 : 1.50;
            const baseRot = fc.isThumb ? thumbBaseRot : rHand;
            let prevJ = ar.ha;
            for (let k = 0; k < fc.chain.length; k++) {
              const fj = fc.chain[k];
              const target = targets[Math.min(k, targets.length - 1)];
              const bCurl = bCurls[k] || 0;
              const delta = clamp(target - bCurl, 0, maxDelta);
              poseP[fj] = stepFromParent(fj, prevJ);
              poseR[fj] = m3Mul(m3RotAxis(curlAxis, delta), baseRot);
              posedFlags[fj] = 1;
              prevJ = fj;
            }
          }
        }
      }

      // Pin trapezius helper bones (e.g. ValveBiped L/R_Trapezius) to chestAnchor so chestplate collars
      // never flare upward when clavicles roll smoothly forward toward the handlebars.
      if (cal.trapJoints && cal.trapJoints.length > 0) {
        for (let i = 0; i < cal.trapJoints.length; i++) {
          const tj = cal.trapJoints[i];
          if (!posedFlags[tj]) {
            poseR[tj] = poseR[chestAnchor];
            poseP[tj] = stepFromParent(tj, chestAnchor);
            posedFlags[tj] = 1;
          }
        }
      }

      // Anchor disconnected secondary armatures (e.g. separate hair/accessory skins) before propagation
      if (cal.detachedRootAnchors && cal.detachedRootAnchors.length > 0) {
        for (let i = 0; i < cal.detachedRootAnchors.length; i++) {
          const da = cal.detachedRootAnchors[i];
          if (!posedFlags[da.joint] && posedFlags[da.anchor]) {
            poseR[da.joint] = poseR[da.anchor];
            poseP[da.joint] = stepFromParent(da.joint, da.anchor);
            posedFlags[da.joint] = 1;
          }
        }
      }

      // 6. Propagate all remaining bones (fingers, glasses, eyes, mouth, toes, twist helpers, capes/armor)
      //    rigidly from their nearest posed ancestor (or pelvis if above hips like _rootJoint)
      const order = model.topoOrder;
      const pJoint = model.parentJoint;
      for (let i = 0; i < order.length; i++) {
        const j = order[i];
        if (posedFlags[j]) continue;
        const pj = pJoint[j];
        if (pj >= 0 && posedFlags[pj]) {
          poseR[j] = poseR[pj];
          poseP[j] = vAdd(poseP[pj], m3MulVec(poseR[pj], vSub(C(j), C(pj))));
          posedFlags[j] = 1;
        }
      }
      // Any root joints above `hips` (e.g. `_rootJoint`) follow `hips`
      for (let j = 0; j < jointCount; j++) {
        if (posedFlags[j]) continue;
        poseR[j] = poseR[m.hips];
        poseP[j] = vAdd(poseP[m.hips], m3MulVec(poseR[m.hips], vSub(C(j), C(m.hips))));
        posedFlags[j] = 1;
      }
    } else {
      // Rigid fallback (unrigged .glb OR user chose 'rigid_rider')
      let rootR = M3_ID;
      let rootP = [0, 0, 0];
      if (hasBt) {
        rootR = btLive.R[0];
        const btMidHip = vScale(vAdd(btLive.P[16], btLive.P[19]), 0.5);
        rootP = vAdd(btMidHip, m3MulVec(rootR, [0, offY, offZ]));
      } else if (rider && rider.sim && (rider.sim.midPosition || rider.sim.position)) {
        const sim = rider.sim;
        const p = sim.midPosition || sim.position;
        let fx = 0, fy = 0, fz = -1;
        if (sim.frontPosition && sim.position) {
          const d = vSub([sim.frontPosition.x, sim.frontPosition.y, sim.frontPosition.z],
                         [sim.position.x, sim.position.y, sim.position.z]);
          if (vLen(d) > 0.1) [fx, fy, fz] = vNorm(d);
        }
        const rx = vNorm([-fz, 0, fx]);
        const ux = vNorm(vCross([rx[0], rx[1], rx[2]], [fx, fy, fz]));
        rootR = [rx, ux, [-fx, -fy, -fz]];
        rootP = [p.x - ox, p.y + 0.90 + offY, p.z - oz];
      }
      const charMidHip = vScale(cal.midHipBase, scFactor);
      for (let j = 0; j < jointCount; j++) {
        poseR[j] = rootR;
        poseP[j] = vAdd(rootP, m3MulVec(rootR, vSub(C(j), charMidHip)));
      }
    }

    // Write final GPU skinning matrices: M[j] = (scTotal * poseR[j] * Q, poseP[j] - poseR[j] * C(j))
    const Q = cal.Q;
    for (let j = 0; j < jointCount; j++) {
      const Rw = poseR[j];
      const Pw = poseP[j];
      const A = m3Mul(Rw, Q);
      const cj = C(j);
      const rc = m3MulVec(Rw, cj);
      const o = j * 16;

      boneData[o + 0]  = A[0][0] * scTotal;
      boneData[o + 1]  = A[0][1] * scTotal;
      boneData[o + 2]  = A[0][2] * scTotal;
      boneData[o + 3]  = 0;

      boneData[o + 4]  = A[1][0] * scTotal;
      boneData[o + 5]  = A[1][1] * scTotal;
      boneData[o + 6]  = A[1][2] * scTotal;
      boneData[o + 7]  = 0;

      boneData[o + 8]  = A[2][0] * scTotal;
      boneData[o + 9]  = A[2][1] * scTotal;
      boneData[o + 10] = A[2][2] * scTotal;
      boneData[o + 11] = 0;

      boneData[o + 12] = Pw[0] - rc[0];
      boneData[o + 13] = Pw[1] - rc[1];
      boneData[o + 14] = Pw[2] - rc[2];
      boneData[o + 15] = 1;
    }
  }

  /* ── 6. WebGPU Textured Skinned Pipeline + Planar Ground Shadow ───────────── */
  const AVATAR_WGSL = `
    struct SceneUniforms {
      viewProj: mat4x4f,
      sunAndMode: vec4f, // xyz = sun dir, w = 1.0 if target is sRGB
      plane: vec4f,      // xyz = ground normal, w = dot(n, point)
      shadowSun: vec4f,  // xyz = shadow light dir, w = shadow brightness
    };
    @group(0) @binding(0) var<uniform> u: SceneUniforms;
    @group(0) @binding(1) var<storage, read> bones: array<mat4x4f>;

    struct MatUniforms {
      baseColor: vec4f,
      params: vec4f, // x = alphaCutoff, y = metallic, z = roughness, w = unlit
    };
    @group(1) @binding(0) var<uniform> mat: MatUniforms;
    @group(1) @binding(1) var baseTex: texture_2d<f32>;
    @group(1) @binding(2) var baseSamp: sampler;

    struct VsIn {
      @location(0) pos: vec3f,
      @location(1) norm: vec3f,
      @location(2) uv: vec2f,
      @location(3) joints: vec4u,
      @location(4) weights: vec4f,
    };

    struct VsOut {
      @builtin(position) clipPos: vec4f,
      @location(0) norm: vec3f,
      @location(1) uv: vec2f,
    };

    fn skinMatrix(joints: vec4u, weights: vec4f) -> mat4x4f {
      return bones[joints.x] * weights.x
           + bones[joints.y] * weights.y
           + bones[joints.z] * weights.z
           + bones[joints.w] * weights.w;
    }

    @vertex
    fn vs(in: VsIn) -> VsOut {
      let sm = skinMatrix(in.joints, in.weights);
      let wp = (sm * vec4f(in.pos, 1.0)).xyz;
      let wnRaw = (sm * vec4f(in.norm, 0.0)).xyz;
      let wnLen = length(wnRaw);
      let wn = select(vec3f(0.0, 1.0, 0.0), wnRaw / wnLen, wnLen > 1e-5);
      var out: VsOut;
      out.clipPos = u.viewProj * vec4f(wp, 1.0);
      out.norm = wn;
      out.uv = in.uv;
      return out;
    }

    @fragment
    fn fs(in: VsOut, @builtin(front_facing) isFront: bool) -> @location(0) vec4f {
      let tex = textureSample(baseTex, baseSamp, in.uv) * mat.baseColor;
      if (mat.params.x > 0.0 && tex.a < mat.params.x) {
        discard;
      }
      var rgb: vec3f;
      if (mat.params.w > 0.5) {
        rgb = tex.rgb;
      } else {
        let nRaw = select(-in.norm, in.norm, isFront);
        let N = normalize(nRaw);
        let L = normalize(u.sunAndMode.xyz);
        let ndotl = max(dot(N, L), 0.0);
        let backFill = max(dot(N, -L), 0.0) * 0.16;
        let sky = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
        let hemi = mix(vec3f(0.20, 0.19, 0.21), vec3f(0.48, 0.52, 0.58), sky);
        let H = normalize(L + vec3f(0.0, 0.45, 0.89));
        let shininess = mix(42.0, 10.0, clamp(mat.params.z, 0.0, 1.0));
        let specStr = mix(0.28, 0.04, clamp(mat.params.z, 0.0, 1.0));
        let spec = pow(max(dot(N, H), 0.0), shininess) * specStr;
        rgb = tex.rgb * (hemi + vec3f(0.95, 0.91, 0.84) * (ndotl * 0.82 + backFill)) + vec3f(spec);
      }
      let clamped = clamp(rgb, vec3f(0.0), vec3f(1.0));
      let outRgb = select(pow(clamped, vec3f(1.0 / 2.2)), clamped, u.sunAndMode.w > 0.5);
      return vec4f(outRgb, 1.0);
    }

    @vertex
    fn vs_shadow(in: VsIn) -> @builtin(position) vec4f {
      let sm = skinMatrix(in.joints, in.weights);
      let wp = (sm * vec4f(in.pos, 1.0)).xyz;
      let n = normalize(u.plane.xyz);
      let L = normalize(u.shadowSun.xyz);
      let h = max(dot(n, wp) - u.plane.w, 0.0);
      let t = h / max(dot(n, L), 0.25);
      let ps = wp - L * t + n * 0.012;
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
    lastOriginX: 0,
    lastOriginZ: 0,
    hasOrigin: false,
    sceneBgl: null,
    matBgl: null,
    shaderMod: null,
    pipe: null,
    shadowPipe: null,
    pipeKey: '',
    ubuf: null,
    uData: new Float32Array(28),
    whiteTex: null,
    defaultSamp: null,
    depthFormat: null,
    sampleCount: null,
    reverseZ: null,
    featScope: null,
    diag: 'No model loaded',
    diagKind: '',
  };

  /* ── 6b. Real Biketerra Shadow-Map Proxy (`pools.misc`, `shadowOnly: true`) ─ */
  const SHADOW_MAX_VERTS = 6000;
  const SHADOW_MAX_INDICES = 24000; // 8,000 tris budget

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
      handle = misc.allocate(scope, SHADOW_MAX_VERTS, SHADOW_MAX_INDICES);
    } catch (e) {
      log('misc.allocate for avatar shadow failed:', e);
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
        const arr = new Float32Array(SHADOW_MAX_VERTS * comp);
        if (comp === 3 && !posOut) posOut = arr;
        else if (comp === 3 && !normOut) normOut = arr;
        dataMap[field] = arr;
      }
    }
    if (!posOut) {
      shadowMisc.disabled = true;
      return false;
    }
    if (normOut) {
      for (let i = 0; i < SHADOW_MAX_VERTS; i++) normOut[i * 3 + 1] = 1;
    }
    shadowMisc.misc = misc;
    shadowMisc.handle = handle;
    shadowMisc.dataMap = dataMap;
    shadowMisc.posOut = posOut;
    shadowMisc.normOut = normOut;
    log('allocated pools.misc handle for real avatar shadow map');
    return true;
  }

  function buildAvatarShadowProxy(av) {
    const prims = (av && av.model && av.model.primitives) || [];
    const vis = [];
    let totalTris = 0;
    for (let i = 0; i < prims.length; i++) {
      const p = prims[i];
      if (av.hiddenParts && av.hiddenParts.has(p.partKey)) continue;
      const tc = (p.indexCount / 3) | 0;
      if (tc <= 0) continue;
      vis.push(p);
      totalTris += tc;
    }
    if (totalTris === 0) return { vCount: 0, iCount: 0, pos: new Float32Array(0), j0: new Uint16Array(0), w0: new Float32Array(0), indices: new Uint32Array(SHADOW_MAX_INDICES) };

    let totalVertsVis = 0;
    for (let i = 0; i < vis.length; i++) totalVertsVis += vis[i].vertCount;

    const maxTris = (SHADOW_MAX_INDICES / 3) | 0;
    let stride = (totalTris <= maxTris && totalVertsVis <= SHADOW_MAX_VERTS)
      ? 1
      : Math.max(2, Math.ceil(totalTris / Math.floor(SHADOW_MAX_VERTS / 2.75)));

    for (let attempt = 0; attempt < 5; attempt++) {
      const idxOut = new Uint32Array(SHADOW_MAX_INDICES);
      const posList = [];
      const jList = [];
      const wList = [];
      let vCount = 0;
      let iCount = 0;
      let overflow = false;

      for (let pi = 0; pi < vis.length && !overflow; pi++) {
        const p = vis[pi];
        const f32 = new Float32Array(p.vertBytes);
        const u16 = new Uint16Array(p.vertBytes);
        const pIdx = p.indices;
        const remap = new Int32Array(p.vertCount);
        remap.fill(-1);
        const tc = (p.indexCount / 3) | 0;

        for (let t = 0; t < tc; t += stride) {
          if (iCount + 3 > SHADOW_MAX_INDICES) { overflow = true; break; }
          const i0 = pIdx[t * 3], i1 = pIdx[t * 3 + 1], i2 = pIdx[t * 3 + 2];
          let n0 = remap[i0], n1 = remap[i1], n2 = remap[i2];
          const need = (n0 < 0 ? 1 : 0) + (n1 < 0 ? 1 : 0) + (n2 < 0 ? 1 : 0);
          if (vCount + need > SHADOW_MAX_VERTS) { overflow = true; break; }

          const addV = (vi) => {
            const ni = vCount++;
            remap[vi] = ni;
            const fo = vi * 14;
            const uo = vi * 28 + 16;
            posList.push(f32[fo], f32[fo + 1], f32[fo + 2]);
            jList.push(u16[uo], u16[uo + 1], u16[uo + 2], u16[uo + 3]);
            wList.push(f32[fo + 10], f32[fo + 11], f32[fo + 12], f32[fo + 13]);
            return ni;
          };
          if (n0 < 0) n0 = addV(i0);
          if (n1 < 0) n1 = addV(i1);
          if (n2 < 0) n2 = addV(i2);
          idxOut[iCount++] = n0;
          idxOut[iCount++] = n1;
          idxOut[iCount++] = n2;
        }
      }

      if (!overflow || attempt === 3) {
        return {
          vCount,
          iCount,
          pos: new Float32Array(posList),
          j0: new Uint16Array(jList),
          w0: new Float32Array(wList),
          indices: idxOut,
        };
      }
      stride = Math.max(stride + 1, Math.ceil(stride * 1.45));
    }
    return null;
  }

  function uploadAndBuildAvatarShadowDraw(av, draws, ox, oz) {
    if (!shadowMisc.handle || !shadowMisc.misc || !av || !av.boneData) return null;
    if (!av.shadowProxy) av.shadowProxy = buildAvatarShadowProxy(av);
    const sp = av.shadowProxy;
    if (!sp || sp.vCount <= 0 || sp.iCount <= 0) return null;

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
    const bd = av.boneData;
    const pos = sp.pos;
    const j0 = sp.j0;
    const w0 = sp.w0;
    const vCount = sp.vCount;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < vCount; i++) {
      const p3 = i * 3;
      const q4 = i * 4;
      const px = pos[p3], py = pos[p3 + 1], pz = pos[p3 + 2];

      const wa = w0[q4];
      const o0 = j0[q4] * 16;
      let rx = (bd[o0] * px + bd[o0 + 4] * py + bd[o0 + 8]  * pz + bd[o0 + 12]) * wa;
      let ry = (bd[o0 + 1] * px + bd[o0 + 5] * py + bd[o0 + 9]  * pz + bd[o0 + 13]) * wa;
      let rz = (bd[o0 + 2] * px + bd[o0 + 6] * py + bd[o0 + 10] * pz + bd[o0 + 14]) * wa;

      const wb = w0[q4 + 1];
      if (wb > 1e-4) {
        const o1 = j0[q4 + 1] * 16;
        rx += (bd[o1] * px + bd[o1 + 4] * py + bd[o1 + 8]  * pz + bd[o1 + 12]) * wb;
        ry += (bd[o1 + 1] * px + bd[o1 + 5] * py + bd[o1 + 9]  * pz + bd[o1 + 13]) * wb;
        rz += (bd[o1 + 2] * px + bd[o1 + 6] * py + bd[o1 + 10] * pz + bd[o1 + 14]) * wb;

        const wc = w0[q4 + 2];
        if (wc > 1e-4) {
          const o2 = j0[q4 + 2] * 16;
          rx += (bd[o2] * px + bd[o2 + 4] * py + bd[o2 + 8]  * pz + bd[o2 + 12]) * wc;
          ry += (bd[o2 + 1] * px + bd[o2 + 5] * py + bd[o2 + 9]  * pz + bd[o2 + 13]) * wc;
          rz += (bd[o2 + 2] * px + bd[o2 + 6] * py + bd[o2 + 10] * pz + bd[o2 + 14]) * wc;

          const wd = w0[q4 + 3];
          if (wd > 1e-4) {
            const o3 = j0[q4 + 3] * 16;
            rx += (bd[o3] * px + bd[o3 + 4] * py + bd[o3 + 8]  * pz + bd[o3 + 12]) * wd;
            ry += (bd[o3 + 1] * px + bd[o3 + 5] * py + bd[o3 + 9]  * pz + bd[o3 + 13]) * wd;
            rz += (bd[o3 + 2] * px + bd[o3 + 6] * py + bd[o3 + 10] * pz + bd[o3 + 14]) * wd;
          }
        }
      }

      const wx = rx + ox;
      const wy = ry;
      const wz = rz + oz;
      po[p3] = wx;
      po[p3 + 1] = wy;
      po[p3 + 2] = wz;
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
    }

    if (!Number.isFinite(minX)) return null;
    for (let i = vCount; i < SHADOW_MAX_VERTS; i++) {
      const p3 = i * 3;
      po[p3] = minX; po[p3 + 1] = minY; po[p3 + 2] = minZ;
    }

    shadowMisc.bounds[0] = minX; shadowMisc.bounds[1] = minY; shadowMisc.bounds[2] = minZ;
    shadowMisc.bounds[3] = maxX; shadowMisc.bounds[4] = maxY; shadowMisc.bounds[5] = maxZ;

    const now = performance.now();
    if (!shadowMisc.uploading || (now - shadowMisc.lastUploadMs) > 120) {
      shadowMisc.uploading = true;
      shadowMisc.lastUploadMs = now;
      try {
        const payload = { ...shadowMisc.dataMap, indices: sp.indices };
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

  // Active parsed + GPU-uploaded avatar state
  let activeAvatar = null; // { id, model, rig, cal, boneData, poseR, poseP, posedFlags, gpuReady, gpuResources, uploading }
  let activeModelId = null;
  let savedModelsCache = [];
  let previewSlotEl = null;

  function destroyAvatarGpu(av) {
    if (!av || !av.gpuResources) return;
    const g = av.gpuResources;
    try { g.boneBuf?.destroy?.(); } catch {}
    for (const p of (g.prims || [])) {
      try { p.vbuf?.destroy?.(); } catch {}
      try { p.ibuf?.destroy?.(); } catch {}
    }
    for (const m of (g.mats || [])) {
      try { m.ubuf?.destroy?.(); } catch {}
    }
    for (const t of (g.textures || [])) {
      try { t?.destroy?.(); } catch {}
    }
    av.gpuResources = null;
    av.gpuReady = false;
  }

  function buildAvatarFromBytes(id, name, bytes) {
    const model = parseGlb(bytes, name);
    const rig = mapHumanoidSkeleton(model);
    const cal = calibrateCharacter(model, rig);
    const jCount = model.joints.length;
    const hiddenParts = new Set();
    for (const pt of (model.parts || [])) {
      if (pt.defaultHidden) hiddenParts.add(pt.key);
    }
    return {
      id,
      model,
      rig,
      cal,
      hiddenParts,
      shadowProxy: null,
      boneData: new Float32Array(jCount * 16),
      poseR: Array.from({ length: jCount }, () => M3_ID),
      poseP: Array.from({ length: jCount }, () => [0, 0, 0]),
      posedFlags: new Uint8Array(jCount),
      gpuReady: false,
      uploading: false,
      gpuResources: null,
    };
  }

  function recalibrateActiveAvatar() {
    if (!activeAvatar) return;
    activeAvatar.cal = calibrateCharacter(activeAvatar.model, activeAvatar.rig);
    refreshPreviewUi();
  }

  function ensureSharedGpuResources(gpu) {
    if (renderer.sceneBgl) return true;
    if (typeof GPUShaderStage === 'undefined' || typeof GPUBufferUsage === 'undefined') {
      renderer.disabled = true;
      return false;
    }
    renderer.sceneBgl = gpu.createBindGroupLayout({
      label: 'terra_ca_scene_bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    renderer.matBgl = gpu.createBindGroupLayout({
      label: 'terra_ca_mat_bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    renderer.shaderMod = gpu.createShaderModule({ label: 'terra_ca_shader', code: AVATAR_WGSL });
    renderer.ubuf = gpu.createBuffer({
      label: 'terra_ca_ubuf',
      size: renderer.uData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    renderer.whiteTex = gpu.createTexture({
      label: 'terra_ca_white',
      size: [1, 1, 1],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    gpu.queue.writeTexture(
      { texture: renderer.whiteTex },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );
    renderer.defaultSamp = gpu.createSampler({
      label: 'terra_ca_default_samp',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    return true;
  }

  async function uploadAvatarToGpu(av, gpu) {
    if (!av || av.gpuReady || av.uploading || !gpu) return;
    if (!ensureSharedGpuResources(gpu)) return;
    av.uploading = true;
    try {
      const { model } = av;

      // 1. Decode embedded PNG/JPG/WebP textures into WebGPU rgba8unorm-srgb textures
      const gpuTextures = [];
      for (let i = 0; i < model.images.length; i++) {
        const img = model.images[i];
        if (!img || !img.bytes || img.bytes.byteLength === 0) {
          gpuTextures.push(null);
          continue;
        }
        try {
          const blob = new Blob([img.bytes], { type: img.mimeType || 'image/png' });
          const bmp = await createImageBitmap(blob);
          const tex = gpu.createTexture({
            label: `terra_ca_tex_${i}`,
            size: [bmp.width, bmp.height, 1],
            format: 'rgba8unorm-srgb',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
          });
          gpu.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex }, [bmp.width, bmp.height]);
          try { bmp.close(); } catch {}
          gpuTextures.push(tex);
        } catch (e) {
          log(`texture ${i} decode failed:`, e);
          gpuTextures.push(null);
        }
      }

      if (cleaned || activeAvatar !== av) {
        for (const t of gpuTextures) try { t?.destroy?.(); } catch {}
        return;
      }

      // 2. Samplers
      const gpuSamplers = model.samplers.map((s, i) => gpu.createSampler({
        label: `terra_ca_samp_${i}`,
        magFilter: s.magFilter,
        minFilter: s.minFilter,
        addressModeU: s.wrapS,
        addressModeV: s.wrapT,
      }));

      // 3. Per-material uniform buffer + bind group
      const gpuMats = model.materials.map((m, i) => {
        const uArr = new Float32Array([
          m.baseColorFactor[0], m.baseColorFactor[1], m.baseColorFactor[2], m.baseColorFactor[3],
          m.alphaCutoff, m.metallic, m.roughness, m.unlit ? 1.0 : 0.0,
        ]);
        const ubuf = gpu.createBuffer({
          label: `terra_ca_mat_${i}`,
          size: uArr.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        gpu.queue.writeBuffer(ubuf, 0, uArr);
        const tex = (m.imageIdx >= 0 && gpuTextures[m.imageIdx]) || renderer.whiteTex;
        const samp = (m.samplerIdx >= 0 && gpuSamplers[m.samplerIdx]) || renderer.defaultSamp;
        const bindGroup = gpu.createBindGroup({
          label: `terra_ca_mat_bg_${i}`,
          layout: renderer.matBgl,
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: tex.createView() },
            { binding: 2, resource: samp },
          ],
        });
        return { ubuf, bindGroup };
      });

      // 4. Bone storage buffer + scene bind group
      const boneBufSize = Math.max(64, av.boneData.byteLength);
      const boneBuf = gpu.createBuffer({
        label: 'terra_ca_bones',
        size: boneBufSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      const sceneBindGroup = gpu.createBindGroup({
        label: 'terra_ca_scene_bg',
        layout: renderer.sceneBgl,
        entries: [
          { binding: 0, resource: { buffer: renderer.ubuf } },
          { binding: 1, resource: { buffer: boneBuf } },
        ],
      });

      // 5. Primitive vertex & index buffers (4-byte aligned size)
      const gpuPrims = model.primitives.map((p, i) => {
        const vSize = (p.vertBytes.byteLength + 3) & ~3;
        const vbuf = gpu.createBuffer({
          label: `terra_ca_vb_${i}`,
          size: vSize,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        gpu.queue.writeBuffer(vbuf, 0, p.vertBytes);

        const iSize = (p.indices.byteLength + 3) & ~3;
        const ibuf = gpu.createBuffer({
          label: `terra_ca_ib_${i}`,
          size: iSize,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        gpu.queue.writeBuffer(ibuf, 0, p.indices);

        return { vbuf, ibuf, indexCount: p.indexCount, materialIdx: p.materialIdx, partKey: p.partKey };
      });

      av.gpuResources = {
        textures: gpuTextures,
        mats: gpuMats,
        boneBuf,
        sceneBindGroup,
        prims: gpuPrims,
      };
      av.gpuReady = true;
      log(`uploaded ${model.fileName} to WebGPU (${model.primitives.length} meshes, ${model.totalTris} tris, ${gpuTextures.filter(Boolean).length} textures, ${model.joints.length} joints)`);
      refreshPreviewUi();
    } catch (e) {
      log('GPU upload error:', e);
      renderer.diag = 'GPU upload failed: ' + (e && e.message ? e.message : e);
      renderer.diagKind = 'err';
      refreshPreviewUi();
    } finally {
      av.uploading = false;
    }
  }

  function ensurePipeline(gpu, colorFormat, depthFormat, sampleCount, reverseZ) {
    if (!ensureSharedGpuResources(gpu)) return false;
    const key = `${colorFormat}|${depthFormat}|${sampleCount}|${reverseZ ? 'rev' : 'std'}`;
    if (renderer.pipe && renderer.pipeKey === key) return true;

    const vLayout = [{
      arrayStride: 56,
      attributes: [
        { shaderLocation: 0, offset: 0,  format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'float32x3' },
        { shaderLocation: 2, offset: 24, format: 'float32x2' },
        { shaderLocation: 3, offset: 32, format: 'uint16x4'  },
        { shaderLocation: 4, offset: 40, format: 'float32x4' },
      ],
    }];

    renderer.pipe = gpu.createRenderPipeline({
      label: 'terra_ca_pipe',
      layout: gpu.createPipelineLayout({ bindGroupLayouts: [renderer.sceneBgl, renderer.matBgl] }),
      vertex: { module: renderer.shaderMod, entryPoint: 'vs', buffers: vLayout },
      fragment: { module: renderer.shaderMod, entryPoint: 'fs', targets: [{ format: colorFormat }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: depthFormat,
        depthWriteEnabled: true,
        depthCompare: reverseZ ? 'greater-equal' : 'less-equal',
      },
      multisample: { count: sampleCount },
    });

    renderer.shadowPipe = gpu.createRenderPipeline({
      label: 'terra_ca_shadow_pipe',
      layout: gpu.createPipelineLayout({ bindGroupLayouts: [renderer.sceneBgl] }),
      vertex: { module: renderer.shaderMod, entryPoint: 'vs_shadow', buffers: vLayout },
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

  /* ── 7. Engine Depth Probing, rider_bones Capture & Native Body Hiding ────── */
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
      if (typeof obj.format === 'string' && typeof obj.createView === 'function' && obj.format.startsWith('depth')) {
        renderer.depthFormat = obj.format;
        if (typeof obj.sampleCount === 'number' && obj.sampleCount >= 1) renderer.sampleCount = obj.sampleCount;
        log(`probed depth texture: format=${renderer.depthFormat} samples=${renderer.sampleCount}`);
        return;
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

  function captureEgoRiderBones(buffer, data, dataOffset) {
    if (!buffer || buffer.label !== 'rider_bones') return;
    let f32 = null;
    let off = 0;
    if (data instanceof Float32Array) {
      f32 = data;
      off = dataOffset || 0;
    } else if (ArrayBuffer.isView(data)) {
      const byteOff = data.byteOffset + (dataOffset || 0) * (data.BYTES_PER_ELEMENT || 1);
      if (byteOff % 4 === 0 && (data.byteLength - (byteOff - data.byteOffset)) >= 352 * 4) {
        f32 = new Float32Array(data.buffer, byteOff, 352);
        off = 0;
      }
    } else if (data instanceof ArrayBuffer) {
      const byteOff = dataOffset || 0;
      if (byteOff % 4 === 0 && data.byteLength - byteOff >= 352 * 4) {
        f32 = new Float32Array(data, byteOff, 352);
        off = 0;
      }
    }
    if (!f32 || f32.length - off < 352) return;

    const bt = window.btApp;
    const rc = bt && (bt.riderController || bt.rideController);
    const ego = rc && (rc.ego || rc.focalRider);
    if (!ego || !ego.sim || !ego.sim.position) return;

    const tx = f32[off + 12], ty = f32[off + 13], tz = f32[off + 14];
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) return;

    const ox = renderer.hasOrigin ? renderer.lastOriginX : ego.sim.position.x;
    const oz = renderer.hasOrigin ? renderer.lastOriginZ : ego.sim.position.z;
    const wx = tx + ox, wz = tz + oz;

    let isMatch = (btLive.egoBuf === buffer);
    if (!isMatch) {
      if (Math.abs(ty - ego.sim.position.y) > 1.8) return;
      const dEgo = Math.min(
        Math.hypot(wx - ego.sim.position.x, wz - ego.sim.position.z),
        ego.sim.midPosition ? Math.hypot(wx - ego.sim.midPosition.x, wz - ego.sim.midPosition.z) : Infinity
      );
      if (dEgo >= 1.15) return;
      let dOther = Infinity;
      if (Array.isArray(rc.riders)) {
        for (let i = 0; i < rc.riders.length; i++) {
          const r = rc.riders[i];
          if (!r || r === ego || !r.sim || !r.sim.position || r._isTerraGhost) continue;
          const d = Math.hypot(wx - r.sim.position.x, wz - r.sim.position.z);
          if (d < dOther) dOther = d;
        }
      }
      if (dEgo < dOther - 0.04) {
        btLive.egoBuf = buffer;
        isMatch = true;
        log('captured ego rider_bones GPUBuffer for live animation retargeting');
      }
    } else {
      // Sanity check that the cached buffer still tracks ego
      const dEgo = Math.hypot(wx - ego.sim.position.x, wz - ego.sim.position.z);
      if (dEgo > 3.0) {
        btLive.egoBuf = null;
        return;
      }
    }

    if (isMatch) {
      btLive.raw.set(f32.subarray(off, off + 352));
      btLive.valid = true;
      btLive.lastMs = performance.now();
    }
  }

  function installGpuHooks(gpu) {
    if (!gpu || renderer.gpu === gpu) return;
    restoreGpuHooks();
    renderer.gpu = gpu;

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

    if (gpu.queue && typeof gpu.queue.writeBuffer === 'function') {
      const origWB = gpu.queue.writeBuffer;
      const boundWB = origWB.bind(gpu.queue);
      renderer.origWriteBuffer = origWB;
      gpu.queue.writeBuffer = function (buffer, bufferOffset, data, dataOffset, size) {
        try {
          if (!cleaned && buffer && buffer.label === 'rider_bones') {
            captureEgoRiderBones(buffer, data, dataOffset);
          }
        } catch {}
        return boundWB(buffer, bufferOffset, data, dataOffset, size);
      };
    }

    const prior = gpu.onuncapturederror;
    renderer.origUncaptured = prior;
    gpu.onuncapturederror = (ev) => {
      try {
        const msg = String((ev && ev.error && ev.error.message) || (ev && ev.message) || '');
        if (msg.includes('terra_ca')) {
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
    btLive.egoBuf = null;
  }

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

  function findRiderBodyDraw(draws, fs, rc, targetRider) {
    if (!Array.isArray(draws) || !draws.length || !rc || !targetRider || !targetRider.sim) return null;
    const targetSim = targetRider.sim;
    const others = [];
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
        if (!d || d.pipeline !== 'skinned' || !d.bounds || d.bounds.length < 6) continue;
        if (boundsDistXZ(d.bounds, targetSim, 0, 0) < 0.85) worldHits++;
        if (boundsDistXZ(d.bounds, targetSim, oxRaw, ozRaw) < 0.85) relHits++;
      }
      if (relHits > worldHits) { ox = oxRaw; oz = ozRaw; }
    }

    const defSkinned = [];
    const tiedSkinned = [];
    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      if (!d || d.pipeline !== 'skinned' || !d.bounds || d.bounds.length < 6) continue;
      const dTarget = boundsDistXZ(d.bounds, targetSim, ox, oz);
      if (!(dTarget < 0.85)) continue;
      let dOther = Infinity;
      for (let j = 0; j < others.length; j++) {
        const dist = boundsDistXZ(d.bounds, others[j], ox, oz);
        if (dist < dOther) dOther = dist;
      }
      if (dTarget < dOther - 0.02) defSkinned.push(d);
      else if (Math.abs(dTarget - dOther) <= 0.02) tiedSkinned.push(d);
    }

    const skinned = defSkinned.length > 0 ? defSkinned : tiedSkinned.slice(0, 2);
    if (skinned.length === 0) return null;

    // Biketerra pushes `body` FIRST, `bike` SECOND (Canyon bike has indexCount === 10206)
    let bodyDraw = skinned[0] || null;
    const bikeDraw = skinned[1] || null;
    if (bodyDraw && bikeDraw) {
      const ic0 = bodyDraw.geometry && bodyDraw.geometry.indexCount;
      const ic1 = bikeDraw.geometry && bikeDraw.geometry.indexCount;
      if (ic0 === 10206 && ic1 !== 10206) bodyDraw = bikeDraw;
    } else if (bodyDraw && bodyDraw.geometry && bodyDraw.geometry.indexCount === 10206) {
      // Only the bike was present (e.g. body already stripped), do NOT hide the bike
      return null;
    }
    return bodyDraw;
  }

  /* ── 8. Hook engine.render to Swap Ego Body + Inject Custom Avatar ────────── */
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
      if (cleaned || renderer.disabled) return origRender.call(this, fs, rq);

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
        return origRender.call(this, fs, rq);
      }

      installGpuHooks(gpu);
      probeEngineDepthFormat(this);

      const av = activeAvatar;
      if (!av || S.enabledMode === 'off') {
        return origRender.call(this, fs, rq);
      }

      if (!av.gpuReady) {
        if (!av.uploading) uploadAvatarToGpu(av, gpu);
        return origRender.call(this, fs, rq);
      }

      const ego = rc.ego || rc.focalRider;
      if (!ego || !ego.sim || ego.sim.curLod === 0) {
        return origRender.call(this, fs, rq);
      }

      const focal = rc.focalRider || rc.ego || null;
      const hideFirstPerson = !!(fs.rig && fs.rig.hideFocalRider && ego === focal);
      if (hideFirstPerson) {
        return origRender.call(this, fs, rq);
      }

      // Compute posed skinning matrices from Biketerra's live `rider_bones`
      solveAvatarPose(av, ego, ox, oz);

      // Hide only the native ego rider body draw (keep the real bike + wheels + bike shadow!)
      // and inject our real shadow-map proxy into Biketerra's native shadow pass.
      const draws = rq && Array.isArray(rq.draws) ? rq.draws : null;
      let nextDraws = null;
      if (draws) {
        const bodyDraw = S.hideNativeBody !== false ? findRiderBodyDraw(draws, fs, rc, ego) : null;
        nextDraws = bodyDraw ? draws.filter((d) => d !== bodyDraw) : draws.slice();
      }
      let hasNativeShadow = false;
      if (S.castShadow !== false && nextDraws && renderer.featScope) {
        if (ensureShadowMiscAllocated(renderer.featScope, this)) {
          const shDraw = uploadAndBuildAvatarShadowDraw(av, nextDraws, ox, oz);
          if (shDraw) {
            nextDraws.push(shDraw);
            hasNativeShadow = true;
          }
        }
      }
      const filteredRq = nextDraws ? { ...rq, draws: nextDraws } : rq;

      let colorFormat = dev.format || 'bgra8unorm';
      try {
        const swapTex = typeof ctx.getCurrentTexture === 'function' ? ctx.getCurrentTexture() : null;
        if (swapTex && swapTex.format) colorFormat = swapTex.format;
      } catch {}

      // Pack scene uniforms
      const vp = fs.camera.viewProj;
      for (let i = 0; i < 16; i++) renderer.uData[i] = vp[i];
      renderer.uData[16] = 0.45;
      renderer.uData[17] = 0.80;
      renderer.uData[18] = 0.39;
      renderer.uData[19] = colorFormat.endsWith('-srgb') ? 1.0 : 0.0;

      // Ground plane beneath ego rider (origin-relative)
      const sim = ego.sim;
      const gPos = sim.midPosition || sim.position;
      let nx = 0, ny = 1, nz = 0;
      if (sim.frontPosition && sim.position) {
        const df = vSub([sim.frontPosition.x, sim.frontPosition.y, sim.frontPosition.z],
                        [sim.position.x, sim.position.y, sim.position.z]);
        if (vLen(df) > 0.1) {
          const f = vNorm(df);
          const r = vNorm([-f[2], 0, f[0]]);
          const u = vNorm(vCross(r, f));
          nx = u[0]; ny = u[1]; nz = u[2];
        }
      }
      const gx = (gPos ? gPos.x : ox) - ox;
      const gy = gPos ? gPos.y : 0;
      const gz = (gPos ? gPos.z : oz) - oz;
      renderer.uData[20] = nx;
      renderer.uData[21] = ny;
      renderer.uData[22] = nz;
      renderer.uData[23] = nx * gx + ny * gy + nz * gz;
      // Projected shadow sun direction
      renderer.uData[24] = -0.46;
      renderer.uData[25] = 0.78;
      renderer.uData[26] = -0.42;
      renderer.uData[27] = 0.34;

      const rawCreateEncoder = gpu.createCommandEncoder;
      let injectedThisFrame = false;

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
                  if (av.gpuReady && av.gpuResources && ensurePipeline(gpu, colorFormat, depthFormat, sampleCount, reverseZ)) {
                    const g = av.gpuResources;
                    const rawWB = renderer.origWriteBuffer || gpu.queue.writeBuffer;
                    rawWB.call(gpu.queue, renderer.ubuf, 0, renderer.uData);
                    rawWB.call(gpu.queue, g.boneBuf, 0, av.boneData);

                    // Fallback planar shadow ONLY if Biketerra's native pools.misc shadow map isn't active
                    if (S.castShadow !== false && !hasNativeShadow && renderer.shadowPipe) {
                      pass.setPipeline(renderer.shadowPipe);
                      pass.setBindGroup(0, g.sceneBindGroup);
                      for (let i = 0; i < g.prims.length; i++) {
                        const pr = g.prims[i];
                        if (av.hiddenParts && av.hiddenParts.has(pr.partKey)) continue;
                        pass.setVertexBuffer(0, pr.vbuf);
                        pass.setIndexBuffer(pr.ibuf, 'uint32');
                        pass.drawIndexed(pr.indexCount);
                      }
                    }

                    pass.setPipeline(renderer.pipe);
                    pass.setBindGroup(0, g.sceneBindGroup);
                    for (let i = 0; i < g.prims.length; i++) {
                      const pr = g.prims[i];
                      if (av.hiddenParts && av.hiddenParts.has(pr.partKey)) continue;
                      const mat = g.mats[pr.materialIdx] || g.mats[0];
                      pass.setBindGroup(1, mat.bindGroup);
                      pass.setVertexBuffer(0, pr.vbuf);
                      pass.setIndexBuffer(pr.ibuf, 'uint32');
                      pass.drawIndexed(pr.indexCount);
                    }
                    injectedThisFrame = true;
                  }
                } catch (e) {
                  log('avatar pass inject error:', e);
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

    log('hooked engine.render for Custom 3D Avatar');
  }

  /* ── 9. Model Loading & Cog Menu Settings Preview UI ──────────────────────── */
  async function activateModelById(id) {
    const prev = activeAvatar;
    activeAvatar = null;
    if (prev) destroyAvatarGpu(prev);
    activeModelId = id || null;
    try { await idbSetActiveId(activeModelId); } catch {}

    if (!activeModelId) {
      renderer.diag = 'Using default Biketerra rider';
      renderer.diagKind = '';
      refreshPreviewUi();
      return;
    }

    try {
      const rec = await idbGetModel(activeModelId);
      if (!rec || !rec.bytes) {
        activeModelId = null;
        renderer.diag = 'Saved model not found in storage.';
        renderer.diagKind = 'err';
        refreshPreviewUi();
        return;
      }
      const av = buildAvatarFromBytes(rec.id, rec.name, rec.bytes);
      try {
        const savedHidden = await idbGetHiddenParts(rec.id);
        if (savedHidden) av.hiddenParts = new Set(savedHidden);
      } catch {}
      activeAvatar = av;
      const { model, rig, cal } = av;
      const texCnt = model.images.filter(Boolean).length;
      const hiddenCnt = av.hiddenParts.size;
      const modeTag = cal.canRetarget
        ? `${rig.rigStyle} (${rig.matchedCore}/${rig.totalCore} core bones, ${model.joints.length} total)`
        : 'Static / Rigid attach (no skeleton)';
      renderer.diag = `Loaded ${rec.name} · ${model.totalTris.toLocaleString()} tris · ${texCnt} textures · ${modeTag}` +
        (hiddenCnt > 0 ? ` · ${hiddenCnt} backdrop/prop part${hiddenCnt === 1 ? '' : 's'} hidden` : '');
      renderer.diagKind = 'ok';
      log(renderer.diag);
      if (renderer.gpu) uploadAvatarToGpu(av, renderer.gpu);
    } catch (e) {
      log('Failed to parse .glb:', e);
      renderer.diag = 'Load error: ' + (e && e.message ? e.message : String(e));
      renderer.diagKind = 'err';
    }
    refreshPreviewUi();
  }

  async function importGlbFile(file) {
    if (!file) return;
    if (!/\.glb$/i.test(file.name)) {
      renderer.diag = 'Please choose a binary .glb file (contains meshes, skeleton, and embedded textures).';
      renderer.diagKind = 'err';
      refreshPreviewUi();
      return;
    }
    try {
      renderer.diag = `Loading ${file.name}…`;
      renderer.diagKind = '';
      refreshPreviewUi();

      const bytes = await file.arrayBuffer();
      // Validate parse before saving so broken files don't clutter the library
      parseGlb(bytes, file.name);
      const rec = await idbSaveModel(file.name, bytes);
      savedModelsCache = await idbListModels();
      await activateModelById(rec.id);
    } catch (e) {
      log('Import error:', e);
      renderer.diag = 'Import failed: ' + (e && e.message ? e.message : String(e));
      renderer.diagKind = 'err';
      refreshPreviewUi();
    }
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function refreshPreviewUi() {
    const slot = previewSlotEl;
    if (!slot) return;
    slot.replaceChildren();

    const panel = document.createElement('div');
    panel.className = 'ca-panel';

    // Hidden file input
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.glb,model/gltf-binary';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) importGlbFile(f);
    });

    // Drop zone + Import button
    const drop = document.createElement('div');
    drop.className = 'ca-drop';
    const dropLbl = document.createElement('div');
    dropLbl.className = 'ca-drop-label';
    dropLbl.textContent = 'Drop a rigged .glb file here or click Import.';
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'ca-btn ca-btn-primary';
    importBtn.textContent = 'Import .glb…';
    importBtn.addEventListener('click', () => fileInput.click());
    drop.append(dropLbl, importBtn, fileInput);

    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('ca-dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('ca-dragover'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('ca-dragover');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) importGlbFile(f);
    });
    panel.append(drop);

    // Saved models list
    const list = document.createElement('div');
    list.className = 'ca-list';

    const defRow = document.createElement('div');
    defRow.className = 'ca-item' + (!activeModelId ? ' ca-active' : '');
    const defName = document.createElement('div');
    defName.className = 'ca-item-name';
    defName.textContent = 'Default Biketerra Rider';
    defRow.append(defName);
    defRow.addEventListener('click', () => activateModelById(null));
    list.append(defRow);

    for (const m of savedModelsCache) {
      const row = document.createElement('div');
      row.className = 'ca-item' + (m.id === activeModelId ? ' ca-active' : '');
      const nm = document.createElement('div');
      nm.className = 'ca-item-name';
      nm.textContent = m.name;
      nm.title = m.name;
      const meta = document.createElement('div');
      meta.className = 'ca-item-meta';
      meta.textContent = formatBytes(m.size);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ca-item-del';
      del.title = 'Remove saved avatar';
      del.textContent = '×';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await idbDeleteModel(m.id);
          savedModelsCache = await idbListModels();
          if (activeModelId === m.id) await activateModelById(null);
          else refreshPreviewUi();
        } catch (err) { log('Delete error:', err); }
      });
      row.append(nm, meta, del);
      row.addEventListener('click', () => activateModelById(m.id));
      list.append(row);
    }
    panel.append(list);

    // Per-part / material visibility toggles (hide backdrops, mirrors, handheld props, weapons, etc.)
    if (activeAvatar && activeAvatar.model && activeAvatar.model.parts && activeAvatar.model.parts.length > 1) {
      const partsWrap = document.createElement('div');
      partsWrap.className = 'ca-parts';
      const pHdr = document.createElement('div');
      pHdr.className = 'ca-parts-hdr';
      pHdr.textContent = 'Model parts (click to hide/show):';
      partsWrap.append(pHdr);
      const chips = document.createElement('div');
      chips.className = 'ca-chips';
      const avRef = activeAvatar;
      for (const pt of avRef.model.parts) {
        const isHidden = avRef.hiddenParts && avRef.hiddenParts.has(pt.key);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ca-chip' + (isHidden ? ' ca-chip-off' : '');
        chip.textContent = pt.label + (pt.isSceneProp ? ' [prop]' : '');
        chip.title = `${pt.label} (${pt.tris.toLocaleString()} tris)${isHidden ? ' — hidden' : ' — visible'}`;
        chip.addEventListener('click', () => {
          if (!avRef.hiddenParts) avRef.hiddenParts = new Set();
          if (avRef.hiddenParts.has(pt.key)) avRef.hiddenParts.delete(pt.key);
          else avRef.hiddenParts.add(pt.key);
          avRef.shadowProxy = null;
          idbSetHiddenParts(avRef.id, Array.from(avRef.hiddenParts)).catch(() => {});
          refreshPreviewUi();
        });
        chips.append(chip);
      }
      partsWrap.append(chips);
      panel.append(partsWrap);
    }

    // Status line
    const st = document.createElement('div');
    st.className = 'ca-status' + (renderer.diagKind ? ` ca-${renderer.diagKind}` : '');
    st.textContent = renderer.diag || 'Import a .glb avatar to get started.';
    panel.append(st);

    slot.append(panel);
  }

  try {
    unsubPreview = terra.settings.preview((slot) => {
      previewSlotEl = slot;
      if (slot) {
        idbListModels().then((list) => {
          savedModelsCache = list;
          refreshPreviewUi();
        }).catch(() => refreshPreviewUi());
      }
    });
  } catch {}

  try {
    unsubSettings = terra.settings.onChange(async () => {
      try {
        const prevFacing = S.facingOffsetDeg;
        S = { ...DEFAULTS, ...(await terra.settings.all()) };
        if (S.facingOffsetDeg !== prevFacing) recalibrateActiveAvatar();
      } catch {}
    });
  } catch {}

  // Restore saved library & previously active .glb from IndexedDB
  (async () => {
    try {
      savedModelsCache = await idbListModels();
      const savedActive = await idbGetActiveId();
      if (savedActive && savedModelsCache.some((m) => m.id === savedActive)) {
        await activateModelById(savedActive);
      } else {
        refreshPreviewUi();
      }
    } catch (e) {
      log('IndexedDB init warning:', e);
    }
  })();

  /* ── 10. Wait for btApp & Register Render Hook ────────────────────────────── */
  const pollTimer = setInterval(() => {
    if (cleaned) return;
    const bt = window.btApp;
    if (!bt || typeof bt.addFeature !== 'function') return;
    if (!unhookFeature) {
      try {
        unhookFeature = bt.addFeature((scope, env) => {
          renderer.featScope = scope;
          return {
            frame() {
              try {
                if (!cleaned && env && env.engine) installRenderHook(env);
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
    try { unsubSettings && unsubSettings(); } catch {}
    try { unsubPreview && unsubPreview(); } catch {}
    if (renderer.eng && renderer.origRender && renderer.eng.render !== renderer.origRender) {
      try { renderer.eng.render = renderer.origRender; } catch {}
    }
    restoreGpuHooks();
    destroyAvatarGpu(activeAvatar);
    activeAvatar = null;
    try { renderer.ubuf?.destroy?.(); } catch {}
    try { renderer.whiteTex?.destroy?.(); } catch {}
    if (window.__terraCustomAvatarCleanup === cleanup) delete window.__terraCustomAvatarCleanup;
    log('cleaned up');
  }

  window.__terraCustomAvatarCleanup = cleanup;
  terra.onCleanup(cleanup);
})();
