/* Ghost Rider — load a previous .fit or .gpx of the current road and race
 * against a 3D ghost cyclist + floating time/power gap inside Biketerra.
 */
'use strict';

(async () => {
  const log = (...a) => {
    try { terra.log(...a); } catch { try { console.log('[ghost-rider]', ...a); } catch {} }
  };

  if (window.__terraGhostCleanup) {
    try { window.__terraGhostCleanup(); } catch {}
  }

  const STORAGE_LIST_KEY = 'ghostTracksV1';
  const STORAGE_ACTIVE_KEY = 'ghostActiveIdV1';
  const STORAGE_POS_KEY = 'ghostHudPosV1';
  const MAX_SAVED_TRACKS = 10;

  const DEFAULTS = {
    show3dModel: true,
    avatarStyle: 'exact',
    ghostOpacity: 55,
    ghostTint: 20,
    showNameplate: true,
    lateralOffsetM: 0.8,
    autoStart: true,
    pauseWithMe: true,
    ghostPasses: 1,
    pacerSpeedKmh: 30,
    hudOpacity: 88,
  };

  let S = { ...DEFAULTS };
  let cleaned = false;
  let unhookFeature = null;
  let unhookRide = null;
  let timer = 0;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));
  const finite = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;

  try { S = { ...DEFAULTS, ...(await terra.settings.all()) }; } catch {}

  /* ── 1. FIT & GPX Parsers ─────────────────────────────────────────────────── */
  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function normalizeSamples(rawSamples, fallbackSpeedMps, name, sourceType, hasRealTime) {
    if (!Array.isArray(rawSamples) || rawSamples.length < 2) {
      throw new Error('Track needs at least 2 points.');
    }

    // Fill cumulative distance if missing
    let hasDist = rawSamples.some((p) => Number.isFinite(p.distM) && p.distM > 0.5);
    let cumDist = 0;
    let prevLat = null;
    let prevLng = null;

    const pts = [];
    let t0 = null;
    let lastT = 0;

    for (let i = 0; i < rawSamples.length; i++) {
      const r = rawSamples[i];
      let d = Number.isFinite(r.distM) ? r.distM : null;
      if (!hasDist) {
        if (prevLat !== null && Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
          cumDist += haversineM(prevLat, prevLng, r.lat, r.lng);
        } else if (pts.length > 0 && Number.isFinite(r.tSec) && Number.isFinite(pts[pts.length - 1].rawT)) {
          const dt = Math.max(0, r.tSec - pts[pts.length - 1].rawT);
          const spd = Number.isFinite(r.speedMps) ? r.speedMps : fallbackSpeedMps;
          cumDist += spd * dt;
        }
        d = cumDist;
      }
      if (Number.isFinite(r.lat) && Number.isFinite(r.lng)) {
        prevLat = r.lat;
        prevLng = r.lng;
      }

      let t;
      if (hasRealTime && Number.isFinite(r.tSec)) {
        if (t0 === null) t0 = r.tSec;
        t = Math.max(lastT, r.tSec - t0);
      } else {
        const prevD = pts.length > 0 ? pts[pts.length - 1].rawD : (d ?? 0);
        const stepD = Math.max(0, (d ?? 0) - prevD);
        t = pts.length === 0 ? 0 : lastT + stepD / Math.max(0.5, fallbackSpeedMps);
      }
      lastT = t;

      pts.push({
        rawT: r.tSec,
        rawD: d ?? 0,
        t,
        d: d ?? 0,
        p: Number.isFinite(r.powerW) ? Math.max(0, Math.round(r.powerW)) : 0,
        s: Number.isFinite(r.speedMps) ? Math.max(0, Number(r.speedMps.toFixed(2))) : null,
        h: Number.isFinite(r.hr) ? Math.max(0, Math.round(r.hr)) : 0,
        lat: Number.isFinite(r.lat) ? Number(r.lat.toFixed(6)) : null,
        lng: Number.isFinite(r.lng) ? Number(r.lng.toFixed(6)) : null,
      });
    }

    // Re-zero distance from first sample
    const d0 = pts[0].d;
    for (let i = 0; i < pts.length; i++) {
      pts[i].d = Math.max(0, Number((pts[i].d - d0).toFixed(2)));
      if (i > 0 && pts[i].d < pts[i - 1].d) pts[i].d = pts[i - 1].d;
    }

    // Fill missing speeds from finite differences
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].s === null) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(pts.length - 1, i + 1);
        const dt = pts[i1].t - pts[i0].t;
        const dd = pts[i1].d - pts[i0].d;
        pts[i].s = dt > 0.05 ? Number(clamp(dd / dt, 0, 40).toFixed(2)) : Number(fallbackSpeedMps.toFixed(2));
      }
      pts[i].t = Number(pts[i].t.toFixed(2));
    }

    // Downsample gently if massive (> 3600 pts) to keep storage compact & search fast
    const maxPts = 3600;
    let out = pts;
    if (pts.length > maxPts) {
      const minDt = pts[pts.length - 1].t / (maxPts - 2);
      out = [pts[0]];
      let lastKeptT = pts[0].t;
      for (let i = 1; i < pts.length - 1; i++) {
        if (pts[i].t - lastKeptT >= minDt) {
          out.push(pts[i]);
          lastKeptT = pts[i].t;
        }
      }
      out.push(pts[pts.length - 1]);
    } else {
      out = pts.map(({ t, d, p, s, h, lat, lng }) => ({ t, d, p, s, h, lat, lng }));
    }

    let pwrSum = 0;
    let pwrCnt = 0;
    for (const pt of out) {
      if (pt.p > 0) { pwrSum += pt.p; pwrCnt++; }
    }

    const totalDistM = out[out.length - 1].d;
    const totalTimeS = out[out.length - 1].t;
    if (!(totalDistM > 5) || !(totalTimeS > 1)) {
      throw new Error('Track has zero distance or duration.');
    }

    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || 'Ghost Ride').replace(/\.(fit|gpx)$/i, ''),
      sourceType,
      hasRealTime: !!hasRealTime,
      totalDistM,
      totalTimeS,
      avgPowerW: pwrCnt > 0 ? Math.round(pwrSum / pwrCnt) : 0,
      hasGps: out.some((p) => p.lat !== null && p.lng !== null),
      samples: out,
    };
  }

  function parseFit(arrayBuffer, filename, fallbackSpeedMps) {
    const u8 = new Uint8Array(arrayBuffer);
    if (u8.byteLength < 16) throw new Error('FIT file is too small.');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const headerSize = dv.getUint8(0);
    if (headerSize < 12 || headerSize > u8.byteLength) throw new Error('Invalid FIT header.');
    if (u8[8] !== 0x2E || u8[9] !== 0x46 || u8[10] !== 0x49 || u8[11] !== 0x54) {
      throw new Error('Missing .FIT signature.');
    }

    const dataSize = dv.getUint32(4, true);
    const endOffset = Math.min(u8.byteLength, headerSize + dataSize);
    const FIT_EPOCH = 631065600;
    const SEMI_TO_DEG = 180 / 2147483648;

    const defs = {};
    const records = [];
    let lastTimestampRaw = 0;
    let pos = headerSize;

    while (pos < endOffset) {
      const hdr = dv.getUint8(pos++);
      const isCompressedTs = (hdr & 0x80) !== 0;

      if (isCompressedTs) {
        const localNum = (hdr >> 5) & 0x03;
        const timeOffset = hdr & 0x1F;
        const def = defs[localNum];
        if (!def) break;

        let tsRaw = (lastTimestampRaw & 0xFFFFFFE0) | timeOffset;
        if (timeOffset < (lastTimestampRaw & 0x1F)) tsRaw += 0x20;
        lastTimestampRaw = tsRaw;

        const msg = readFitFields(dv, pos, def);
        pos += def.totalSize;
        if (def.globalNum === 20) {
          pushFitRecord(records, msg, tsRaw, FIT_EPOCH, SEMI_TO_DEG);
        }
        continue;
      }

      const isDef = (hdr & 0x40) !== 0;
      const hasDevData = (hdr & 0x20) !== 0;
      const localNum = hdr & 0x0F;

      if (isDef) {
        if (pos + 5 > endOffset) break;
        pos += 1; // reserved
        const arch = dv.getUint8(pos++);
        const littleEndian = arch === 0;
        const globalNum = dv.getUint16(pos, littleEndian);
        pos += 2;
        const numFields = dv.getUint8(pos++);
        if (pos + numFields * 3 > endOffset) break;

        const fields = [];
        let stdSize = 0;
        for (let i = 0; i < numFields; i++) {
          const fNum = dv.getUint8(pos++);
          const fSize = dv.getUint8(pos++);
          const fType = dv.getUint8(pos++);
          fields.push({ fNum, fSize, fType });
          stdSize += fSize;
        }

        let devSize = 0;
        if (hasDevData && pos < endOffset) {
          const numDev = dv.getUint8(pos++);
          for (let i = 0; i < numDev && pos + 3 <= endOffset; i++) {
            pos += 1; // field_num
            devSize += dv.getUint8(pos++);
            pos += 1; // dev_data_index
          }
        }

        defs[localNum] = { globalNum, littleEndian, fields, devSize, totalSize: stdSize + devSize };
      } else {
        const def = defs[localNum];
        if (!def || pos + def.totalSize > endOffset) break;
        const msg = readFitFields(dv, pos, def);
        pos += def.totalSize;

        if (msg[253] != null) lastTimestampRaw = msg[253];
        if (def.globalNum === 20) {
          const tsRaw = msg[253] != null ? msg[253] : lastTimestampRaw;
          if (tsRaw > 0) pushFitRecord(records, msg, tsRaw, FIT_EPOCH, SEMI_TO_DEG);
        }
      }
    }

    if (records.length < 2) {
      throw new Error('No track records (Msg 20) found in FIT file.');
    }
    return normalizeSamples(records, fallbackSpeedMps, filename, 'FIT', true);
  }

  function readFitFields(dv, startPos, def) {
    const msg = {};
    let pos = startPos;
    for (const f of def.fields) {
      const baseType = f.fType & 0x1F;
      let val = null;
      if (f.fSize === 1) {
        const raw = dv.getUint8(pos);
        if (baseType === 1) val = raw === 0x7F ? null : dv.getInt8(pos);
        else val = raw === 0xFF ? null : raw;
      } else if (f.fSize === 2) {
        const raw = dv.getUint16(pos, def.littleEndian);
        if (baseType === 3) val = raw === 0x7FFF ? null : dv.getInt16(pos, def.littleEndian);
        else val = raw === 0xFFFF ? null : raw;
      } else if (f.fSize === 4) {
        const raw = dv.getUint32(pos, def.littleEndian);
        if (baseType === 5) val = raw === 0x7FFFFFFF ? null : dv.getInt32(pos, def.littleEndian);
        else val = raw === 0xFFFFFFFF ? null : raw;
      }
      msg[f.fNum] = val;
      pos += f.fSize;
    }
    return msg;
  }

  function pushFitRecord(records, msg, tsRaw, FIT_EPOCH, SEMI_TO_DEG) {
    const tSec = tsRaw + FIT_EPOCH;
    const lat = msg[0] != null ? msg[0] * SEMI_TO_DEG : null;
    const lng = msg[1] != null ? msg[1] * SEMI_TO_DEG : null;
    const hr = msg[3] != null ? msg[3] : 0;
    const distM = msg[5] != null ? msg[5] / 100 : null;
    const rawSpd = msg[73] != null ? msg[73] : (msg[6] != null ? msg[6] : null);
    const speedMps = rawSpd != null ? rawSpd / 1000 : null;
    const powerW = msg[7] != null ? msg[7] : 0;
    records.push({ tSec, lat, lng, hr, distM, speedMps, powerW });
  }

  function parseGpx(xmlText, filename, fallbackSpeedMps) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Invalid GPX XML file.');
    }
    let nodes = Array.from(doc.getElementsByTagName('trkpt'));
    if (nodes.length < 2) nodes = Array.from(doc.getElementsByTagName('rtept'));
    if (nodes.length < 2) throw new Error('GPX file contains fewer than 2 track points.');

    const nameEl = doc.querySelector('trk > name, metadata > name, rte > name');
    const trackName = (nameEl && nameEl.textContent && nameEl.textContent.trim()) || filename;

    let hasTimeCount = 0;
    const raw = [];
    for (const pt of nodes) {
      const lat = parseFloat(pt.getAttribute('lat'));
      const lng = parseFloat(pt.getAttribute('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

      const timeEl = pt.getElementsByTagName('time')[0];
      let tSec = null;
      if (timeEl && timeEl.textContent) {
        const ms = Date.parse(timeEl.textContent.trim());
        if (Number.isFinite(ms)) { tSec = ms / 1000; hasTimeCount++; }
      }

      const ext = pt.getElementsByTagName('extensions')[0];
      let powerW = 0;
      let hr = 0;
      let distM = null;
      if (ext) {
        const allExt = ext.getElementsByTagName('*');
        for (const el of allExt) {
          const ln = (el.localName || el.tagName || '').toLowerCase();
          const num = parseFloat(el.textContent);
          if (!Number.isFinite(num)) continue;
          if (ln === 'power' || ln === 'watts') powerW = num;
          else if (ln === 'hr' || ln === 'heartrate') hr = num;
          else if (ln === 'distance') distM = num;
        }
      }
      raw.push({ tSec, lat, lng, hr, distM, speedMps: null, powerW });
    }

    const hasRealTime = hasTimeCount >= Math.max(2, Math.floor(raw.length * 0.5));
    return normalizeSamples(raw, fallbackSpeedMps, trackName, 'GPX', hasRealTime);
  }

  /* ── 2. Track Interpolation (Speed-Integrated + PCHIP) ────────────────────── */
  function ensureTrackSpline(track) {
    if (!track || track._splineReady) return track;
    const arr = track.samples;
    const n = arr ? arr.length : 0;
    if (n < 2) return track;

    // Check if samples carry real recorded speeds (e.g. FIT enhanced_speed)
    let speedCount = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(arr[i].s) && arr[i].s > 0.1) speedCount++;
    }
    const useSpeedIntegral = track.sourceType === 'FIT' && speedCount >= Math.max(2, Math.floor(n * 0.25));

    const smoothD = new Float64Array(n);
    smoothD[0] = arr[0].d;
    smoothD[n - 1] = arr[n - 1].d;

    const dts = [];
    for (let i = 1; i < n; i++) {
      const dt = arr[i].t - arr[i - 1].t;
      if (dt > 1e-3) dts.push(dt);
    }
    dts.sort((a, b) => a - b);
    const medDt = dts.length > 0 ? dts[dts.length >> 1] : 1.0;

    const isStop = new Uint8Array(n);
    for (let i = 1; i < n - 1; i++) {
      const ti = arr[i].t;
      let i0 = i, i1 = i;
      while (i0 > 0 && (ti - arr[i0 - 1].t) < 3.0) i0--;
      while (i1 < n - 1 && (arr[i1 + 1].t - ti) < 3.0) i1++;
      const spanT = arr[i1].t - arr[i0].t;
      if (spanT >= 2.5 && (arr[i1].d - arr[i0].d) < 0.4) isStop[i] = 1;
    }

    const triSmooth = (src, winS) => {
      const dst = new Float64Array(n);
      dst[0] = src[0];
      dst[n - 1] = src[n - 1];
      for (let i = 1; i < n - 1; i++) {
        const ti = arr[i].t;
        let wSum = 0;
        let wvSum = 0;
        for (let j = i; j >= 0 && (ti - arr[j].t) <= winS; j--) {
          const w = 1 - (ti - arr[j].t) / (winS + 0.1);
          wSum += w;
          wvSum += w * src[j];
        }
        for (let j = i + 1; j < n && (arr[j].t - ti) <= winS; j++) {
          const w = 1 - (arr[j].t - ti) / (winS + 0.1);
          wSum += w;
          wvSum += w * src[j];
        }
        dst[i] = wSum > 0 ? wvSum / wSum : src[i];
      }
      return dst;
    };

    if (useSpeedIntegral) {
      // Smooth recorded speed s(t) over ±2s to remove 1Hz sensor ripples, integrate,
      // then add a ±15s-smoothed residual (rawD - intD) so quantization vanishes with zero drift.
      const rawS = new Float64Array(n);
      for (let i = 0; i < n; i++) rawS[i] = arr[i].s || 0;
      const smoothS = triSmooth(rawS, Math.max(2.0, medDt * 1.5));

      const intD = new Float64Array(n);
      intD[0] = arr[0].d;
      for (let i = 1; i < n; i++) {
        const dt = Math.max(0, arr[i].t - arr[i - 1].t);
        intD[i] = intD[i - 1] + 0.5 * (smoothS[i - 1] + smoothS[i]) * dt;
      }

      const rawErr = new Float64Array(n);
      for (let i = 0; i < n; i++) rawErr[i] = arr[i].d - intD[i];
      const smoothErr = triSmooth(rawErr, 15.0);

      for (let i = 1; i < n - 1; i++) {
        const cand = intD[i] + smoothErr[i];
        smoothD[i] = clamp(Math.max(smoothD[i - 1], cand), 0, track.totalDistM);
      }
    } else {
      // Fallback (e.g. GPX without speed): two-pass adaptive triangular smooth over distance
      const winS = clamp(Math.max(6.0, medDt * 3.5), 6.0, 15.0);
      const rawD = new Float64Array(n);
      for (let i = 0; i < n; i++) rawD[i] = arr[i].d;
      const pass1 = triSmooth(rawD, winS);
      const pass2 = triSmooth(pass1, winS * 0.5);

      for (let i = 1; i < n - 1; i++) {
        const cand = isStop[i] ? arr[i].d : pass2[i];
        smoothD[i] = clamp(Math.max(smoothD[i - 1], cand), 0, track.totalDistM);
      }
    }

    for (let i = 1; i < n - 1; i++) {
      if (smoothD[i] > smoothD[n - 1]) smoothD[i] = smoothD[n - 1];
      if (smoothD[i] < smoothD[i - 1]) smoothD[i] = smoothD[i - 1];
    }

    // Bridge accidental flat clamps while moving so PCHIP velocity never pulses to 0 mid-ride
    let runStart = -1;
    for (let i = 1; i < n; i++) {
      const flat = (smoothD[i] - smoothD[i - 1]) < 1e-4 && !isStop[i] && (arr[i].t - arr[i - 1].t) > 1e-3;
      if (flat && runStart === -1) {
        runStart = i - 1;
      } else if (!flat && runStart !== -1) {
        const iEnd = i;
        const tSpan = arr[iEnd].t - arr[runStart].t;
        if (tSpan > 1e-3 && smoothD[iEnd] > smoothD[runStart]) {
          for (let k = runStart + 1; k < iEnd; k++) {
            const frac = (arr[k].t - arr[runStart].t) / tSpan;
            smoothD[k] = smoothD[runStart] + (smoothD[iEnd] - smoothD[runStart]) * frac;
          }
        }
        runStart = -1;
      }
    }

    // Fritsch-Carlson monotone cubic Hermite (PCHIP) tangent velocities (m/s)
    const h = new Float64Array(n - 1);
    const delta = new Float64Array(n - 1);
    for (let k = 0; k < n - 1; k++) {
      h[k] = Math.max(0, arr[k + 1].t - arr[k].t);
      delta[k] = h[k] > 1e-4 ? (smoothD[k + 1] - smoothD[k]) / h[k] : -1;
    }
    for (let k = 0; k < n - 1; k++) {
      if (delta[k] < 0) {
        delta[k] = k > 0 ? delta[k - 1] : (k + 1 < n - 1 && delta[k + 1] >= 0 ? delta[k + 1] : 0);
      }
    }

    const v = new Float64Array(n);
    v[0] = delta[0];
    v[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
      const d0 = delta[i - 1];
      const d1 = delta[i];
      if (d0 <= 0 || d1 <= 0) {
        v[i] = 0;
      } else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        v[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
      }
    }

    track._smoothD = smoothD;
    track._pchipV = v;
    track._splineReady = true;
    return track;
  }

  function sampleGhostAtTime(track, tSec) {
    ensureTrackSpline(track);
    const arr = track.samples;
    const sd = track._smoothD;
    const pv = track._pchipV;
    const n = arr.length;
    const t = clamp(tSec, 0, track.totalTimeS);
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = arr[lo], b = arr[hi];
    const span = b.t - a.t;
    const f = span > 1e-4 ? clamp((t - a.t) / span, 0, 1) : 0;

    let d;
    let spd;
    if (sd && pv && span > 1e-4) {
      const u = f;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      d = h00 * sd[lo] + h10 * span * pv[lo] + h01 * sd[hi] + h11 * span * pv[hi];
      d = clamp(d, sd[lo], sd[hi]);

      const dh00 = 6 * u2 - 6 * u;
      const dh10 = 3 * u2 - 4 * u + 1;
      const dh01 = -6 * u2 + 6 * u;
      const dh11 = 3 * u2 - 2 * u;
      spd = clamp((dh00 * sd[lo] + dh10 * span * pv[lo] + dh01 * sd[hi] + dh11 * span * pv[hi]) / span, 0, 40);
    } else {
      d = a.d + (b.d - a.d) * f;
      spd = a.s + (b.s - a.s) * f;
    }

    return {
      t,
      d,
      p: Math.round(a.p + (b.p - a.p) * f),
      s: spd,
      h: Math.round(a.h + (b.h - a.h) * f),
      finished: tSec >= track.totalTimeS,
    };
  }

  function ghostTimeAtDist(track, distM) {
    ensureTrackSpline(track);
    const arr = track.samples;
    const sd = track._smoothD;
    const n = arr.length;
    const d = clamp(distM, 0, track.totalDistM);
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      const dm = sd ? sd[mid] : arr[mid].d;
      if (dm <= d) lo = mid;
      else hi = mid;
    }
    const d0 = sd ? sd[lo] : arr[lo].d;
    const d1 = sd ? sd[hi] : arr[hi].d;
    const span = d1 - d0;
    const f = span > 1e-4 ? clamp((d - d0) / span, 0, 1) : 0;
    return arr[lo].t + (arr[hi].t - arr[lo].t) * f;
  }

  /* ── 3. Biketerra Route Polyline & Distance Tracking ──────────────────────── */
  let cachedRoute = null;
  let lastHintIdx = 0;

  function resolveRoute() {
    try {
      const rc = window.btApp && (window.btApp.riderController || window.btApp.rideController);
      if (!rc) return null;
      const focal = rc.ego || rc.focalRider;
      const prev = focal && focal.sim && focal.sim.prevPathNode;
      if (!prev) return null;

      let list = null;
      if (prev.pathNode && Array.isArray(prev.pathNode.list) && prev.pathNode.list.length > 2) {
        list = prev.pathNode.list;
      } else if (Array.isArray(prev.list) && prev.list.length > 2) {
        list = prev.list;
      }
      if (!list || list.length < 3) return null;

      if (cachedRoute && cachedRoute.listRef === list) {
        return { route: cachedRoute, focal, prev };
      }

      const n = list.length;
      const pts = new Array(n);
      const norms = new Array(n);
      for (let i = 0; i < n; i++) {
        const node = list[i];
        const inner = (node && node.pathNode) ? node.pathNode : node;
        const p = inner && (inner.p || inner.pos || inner.position);
        const nm = inner && (inner.n || inner.normal);
        if (!p || typeof p.x !== 'number') return null;
        pts[i] = {
          x: p.x,
          y: Number.isFinite(p.y) ? p.y : 0,
          z: Number.isFinite(p.z) ? p.z : 0,
        };
        norms[i] = (nm && typeof nm.x === 'number') ? { x: nm.x, z: nm.z } : null;
      }

      const dist = new Float64Array(n);
      const tangs = new Array(n);
      const slopes = new Float32Array(n);

      for (let i = 1; i < n; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        const dz = pts[i].z - pts[i - 1].z;
        dist[i] = dist[i - 1] + Math.hypot(dx, dy, dz);
      }
      const totalLen = dist[n - 1];
      if (!(totalLen > 1)) return null;

      const loopGap = Math.hypot(pts[n - 1].x - pts[0].x, pts[n - 1].z - pts[0].z);
      const isLoop = n > 20 && loopGap < 80;

      // Spatially smooth centerline over ±2.0m arc length to filter dense GPS road-node jitter
      // while leaving well-spaced nodes untouched.
      const R_POS = 2.0;
      const sPts = new Array(n);
      for (let i = 0; i < n; i++) {
        if (!isLoop && (i === 0 || i === n - 1)) {
          sPts[i] = pts[i];
          continue;
        }
        const di = dist[i];
        let wSum = 1.0;
        let sx = pts[i].x, sy = pts[i].y, sz = pts[i].z;
        for (let j = i - 1; j >= 0; j--) {
          const dd = di - dist[j];
          if (dd > R_POS) break;
          const w = 1 - dd / (R_POS + 0.05);
          wSum += w; sx += w * pts[j].x; sy += w * pts[j].y; sz += w * pts[j].z;
        }
        for (let j = i + 1; j < n; j++) {
          const dd = dist[j] - di;
          if (dd > R_POS) break;
          const w = 1 - dd / (R_POS + 0.05);
          wSum += w; sx += w * pts[j].x; sy += w * pts[j].y; sz += w * pts[j].z;
        }
        sPts[i] = { x: sx / wSum, y: sy / wSum, z: sz / wSum };
      }
      if (isLoop && loopGap < 1.0) sPts[n - 1] = sPts[0];

      // Determine road normal handedness (+1 or -1 relative to (-tz, tx)) from Biketerra node normals
      const R_TAN = 4.5;
      let normDotSum = 0;
      for (let i = 0; i < n; i++) {
        const di = dist[i];
        let j0 = i, j1 = i;
        while (j0 > 0 && (di - dist[j0]) < R_TAN) j0--;
        while (j1 < n - 1 && (dist[j1] - di) < R_TAN) j1++;
        const dx = sPts[j1].x - sPts[j0].x;
        const dy = sPts[j1].y - sPts[j0].y;
        const dz = sPts[j1].z - sPts[j0].z;
        const hLen = Math.hypot(dx, dz) || 1;
        const tx = dx / hLen;
        const tz = dz / hLen;
        tangs[i] = { x: tx, z: tz };
        slopes[i] = clamp(dy / Math.max(0.5, hLen), -0.45, 0.45);
        if (norms[i] && (norms[i].x !== 0 || norms[i].z !== 0)) {
          normDotSum += norms[i].x * (-tz) + norms[i].z * tx;
        }
      }
      const normSign = normDotSum < 0 ? -1 : 1;

      cachedRoute = { listRef: list, nodes: list, pts, sPts, normSign, tangs, slopes, dist, totalLen, isLoop, n };
      lastHintIdx = 0;
      return { route: cachedRoute, focal, prev };
    } catch {
      return null;
    }
  }

  function sampleSplinePos(route, targetDist) {
    const { nodes, sPts, dist, totalLen, isLoop, n } = route;
    const d = isLoop ? (((targetDist % totalLen) + totalLen) % totalLen) : clamp(targetDist, 0, totalLen);

    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segLen = dist[hi] - dist[lo];
    const t = segLen > 1e-6 ? clamp((d - dist[lo]) / segLen, 0, 1) : 0;

    let p;
    if (n >= 4 && segLen > 1e-4) {
      const iPrev = lo > 0 ? lo - 1 : (isLoop ? n - 2 : 0);
      const iNext = hi + 1 < n ? hi + 1 : (isLoop ? 1 : n - 1);
      const p0 = sPts[iPrev], p1 = sPts[lo], p2 = sPts[hi], p3 = sPts[iNext];
      const u = t, u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      const dPrev = Math.max(0.5, isLoop && lo === 0 ? dist[n - 1] - dist[n - 2] : (lo > 0 ? dist[lo] - dist[lo - 1] : segLen));
      const dNext = Math.max(0.5, isLoop && hi === n - 1 ? dist[1] - dist[0] : (hi + 1 < n ? dist[hi + 1] - dist[hi] : segLen));
      const m1x = ((p2.x - p0.x) / (dPrev + segLen)) * segLen;
      const m1y = ((p2.y - p0.y) / (dPrev + segLen)) * segLen;
      const m1z = ((p2.z - p0.z) / (dPrev + segLen)) * segLen;
      const m2x = ((p3.x - p1.x) / (segLen + dNext)) * segLen;
      const m2y = ((p3.y - p1.y) / (segLen + dNext)) * segLen;
      const m2z = ((p3.z - p1.z) / (segLen + dNext)) * segLen;
      p = {
        x: h00 * p1.x + h10 * m1x + h01 * p2.x + h11 * m2x,
        y: h00 * p1.y + h10 * m1y + h01 * p2.y + h11 * m2y,
        z: h00 * p1.z + h10 * m1z + h01 * p2.z + h11 * m2z,
      };
    } else {
      p = {
        x: sPts[lo].x + (sPts[hi].x - sPts[lo].x) * t,
        y: sPts[lo].y + (sPts[hi].y - sPts[lo].y) * t,
        z: sPts[lo].z + (sPts[hi].z - sPts[lo].z) * t,
      };
    }
    const rawNode = nodes && nodes[lo];
    const node = rawNode && rawNode.pathNode ? rawNode.pathNode : rawNode;
    return { p, distM: d, node };
  }

  function sampleRouteAt(route, targetDist) {
    const center = sampleSplinePos(route, targetDist);
    const d = center.distM;
    const pBack = sampleSplinePos(route, d - 2.0).p;
    const pFwd = sampleSplinePos(route, d + 2.0).p;
    const dx = pFwd.x - pBack.x;
    const dy = pFwd.y - pBack.y;
    const dz = pFwd.z - pBack.z;
    const hLen = Math.hypot(dx, dz) || 1;
    const tx = dx / hLen;
    const tz = dz / hLen;
    const sgn = route.normSign || 1;
    const slope = clamp(dy / Math.max(0.5, hLen), -0.45, 0.45);
    return {
      p: center.p,
      tang: { x: tx, z: tz },
      norm: { x: -tz * sgn, z: tx * sgn },
      slope,
      distM: d,
      node: center.node,
    };
  }

  function findFocalDistance(route, focal, prev) {
    const { pts, dist, n } = route;
    const pos = focal && focal.sim && (focal.sim.midPosition || focal.sim.position);
    const hint = Number.isInteger(prev.index) && prev.index >= 0 && prev.index < n ? prev.index : lastHintIdx;
    if (!pos || typeof pos.x !== 'number') {
      lastHintIdx = hint;
      return dist[hint];
    }

    let bestIdx = hint;
    let bestD2 = Infinity;
    const lo = Math.max(0, hint - 30);
    const hi = Math.min(n - 1, hint + 30);
    for (let i = lo; i <= hi; i++) {
      const dx = pts[i].x - pos.x;
      const dz = pts[i].z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestD2 > 900) {
      for (let i = 0; i < n; i++) {
        const dx = pts[i].x - pos.x;
        const dz = pts[i].z - pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
    }
    lastHintIdx = bestIdx;

    let curDist = dist[bestIdx];
    const trySeg = (a, b) => {
      const vx = pts[b].x - pts[a].x;
      const vz = pts[b].z - pts[a].z;
      const len2 = vx * vx + vz * vz;
      if (len2 < 1e-4) return null;
      const t = ((pos.x - pts[a].x) * vx + (pos.z - pts[a].z) * vz) / len2;
      if (t < 0 || t > 1) return null;
      const px = pts[a].x + vx * t;
      const pz = pts[a].z + vz * t;
      return { d: dist[a] + (dist[b] - dist[a]) * t, d2: (pos.x - px) ** 2 + (pos.z - pz) ** 2 };
    };
    const candA = bestIdx > 0 ? trySeg(bestIdx - 1, bestIdx) : null;
    const candB = bestIdx + 1 < n ? trySeg(bestIdx, bestIdx + 1) : null;
    if (candA && (!candB || candA.d2 <= candB.d2)) curDist = candA.d;
    else if (candB) curDist = candB.d;

    return curDist;
  }

  /* ── 4. Procedural 3D Cyclist + Bike + Beacon Mesh (Right-Handed CCW) ─────── */
  // Local coordinates: +X = right, +Y = up, +Z = back (-Z = forward along road).
  function buildCyclistGeometry() {
    const pos = [];
    const norm = [];
    const uv = [];
    const idx = [];

    function pushQuad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz) {
      const base = pos.length / 3;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
      norm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
      uv.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    function pushTri(ax, ay, az, bx, by, bz, cx, cy, cz) {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      const base = pos.length / 3;
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
      norm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
      uv.push(0.5, 0.5, 0.5, 0.5, 0.5, 0.5);
      idx.push(base, base + 1, base + 2);
    }

    // Oriented box from point p0 to p1 with half-width hw (along local X) & half-thickness ht (perp in YZ)
    function addTube(x0, y0, z0, x1, y1, z1, hw, ht) {
      const dy = y1 - y0, dz = z1 - z0;
      const dx = x1 - x0;
      const len = Math.hypot(dx, dy, dz) || 1;
      const fx = dx / len, fy = dy / len, fz = dz / len;
      // Pick perpendicular axis U roughly along +X or +Y
      let ux = Math.abs(fx) < 0.8 ? 1 : 0;
      let uy = Math.abs(fx) < 0.8 ? 0 : 1;
      let uz = 0;
      // v = normalize(f x u)
      let vx = fy * uz - fz * uy;
      let vy = fz * ux - fx * uz;
      let vz = fx * uy - fy * ux;
      const vl = Math.hypot(vx, vy, vz) || 1;
      vx /= vl; vy /= vl; vz /= vl;
      // u = v x f
      ux = vy * fz - vz * fy;
      uy = vz * fx - vx * fz;
      uz = vx * fy - vy * fx;

      const pt = (bx, by, bz, su, sv) => [
        bx + ux * su * hw + vx * sv * ht,
        by + uy * su * hw + vy * sv * ht,
        bz + uz * su * hw + vz * sv * ht,
      ];
      const a0 = pt(x0, y0, z0, -1, -1);
      const b0 = pt(x0, y0, z0,  1, -1);
      const c0 = pt(x0, y0, z0,  1,  1);
      const d0 = pt(x0, y0, z0, -1,  1);
      const a1 = pt(x1, y1, z1, -1, -1);
      const b1 = pt(x1, y1, z1,  1, -1);
      const c1 = pt(x1, y1, z1,  1,  1);
      const d1 = pt(x1, y1, z1, -1,  1);

      // End caps & 4 sides (CCW outward)
      pushQuad(...d0, ...c0, ...b0, ...a0, -fx, -fy, -fz);
      pushQuad(...a1, ...b1, ...c1, ...d1, fx, fy, fz);
      pushQuad(...a0, ...b0, ...b1, ...a1, -vx, -vy, -vz);
      pushQuad(...b0, ...c0, ...c1, ...b1, ux, uy, uz);
      pushQuad(...c0, ...d0, ...d1, ...c1, vx, vy, vz);
      pushQuad(...d0, ...a0, ...a1, ...d1, -ux, -uy, -uz);
    }

    // Wheel ring (in YZ plane, centered at (0, cy, cz))
    function addWheel(cy, cz, rOuter, rInner, halfW, segs) {
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const c0 = Math.cos(a0), s0 = Math.sin(a0);
        const c1 = Math.cos(a1), s1 = Math.sin(a1);
        const y0o = cy + s0 * rOuter, z0o = cz + c0 * rOuter;
        const y1o = cy + s1 * rOuter, z1o = cz + c1 * rOuter;
        const y0i = cy + s0 * rInner, z0i = cz + c0 * rInner;
        const y1i = cy + s1 * rInner, z1i = cz + c1 * rInner;
        const nyM = Math.sin((a0 + a1) * 0.5);
        const nzM = Math.cos((a0 + a1) * 0.5);

        // Right face (+X), Left face (-X), Outer rim, Inner rim
        pushQuad(halfW, y0i, z0i, halfW, y0o, z0o, halfW, y1o, z1o, halfW, y1i, z1i, 1, 0, 0);
        pushQuad(-halfW, y1i, z1i, -halfW, y1o, z1o, -halfW, y0o, z0o, -halfW, y0i, z0i, -1, 0, 0);
        pushQuad(-halfW, y0o, z0o, -halfW, y1o, z1o, halfW, y1o, z1o, halfW, y0o, z0o, 0, nyM, nzM);
        pushQuad(halfW, y0i, z0i, halfW, y1i, z1i, -halfW, y1i, z1i, -halfW, y0i, z0i, 0, -nyM, -nzM);
      }
    }

    // Wheels (forward is -Z, rear is +Z)
    addWheel(0.34,  0.50, 0.34, 0.28, 0.025, 12); // rear wheel
    addWheel(0.34, -0.50, 0.34, 0.28, 0.025, 12); // front wheel

    // Bike diamond frame + fork + handlebars + saddle
    addTube(0, 0.34,  0.50, 0, 0.30,  0.08, 0.02, 0.025); // chainstay
    addTube(0, 0.34,  0.50, 0, 0.80,  0.22, 0.02, 0.022); // seatstay
    addTube(0, 0.30,  0.08, 0, 0.86,  0.24, 0.025, 0.028); // seat tube
    addTube(0, 0.30,  0.08, 0, 0.78, -0.32, 0.026, 0.030); // down tube
    addTube(0, 0.80,  0.22, 0, 0.80, -0.32, 0.024, 0.024); // top tube
    addTube(0, 0.84, -0.34, 0, 0.34, -0.50, 0.024, 0.026); // fork
    addTube(-0.19, 0.89, -0.38, 0.19, 0.89, -0.38, 0.022, 0.022); // handlebar

    // Cyclist body (aero tuck)
    addTube(0, 0.94, 0.22, 0, 1.32, -0.14, 0.15, 0.11); // torso
    addTube(0, 1.44, -0.22, 0, 1.48, -0.28, 0.095, 0.105); // helmet
    // Arms
    addTube(-0.16, 1.28, -0.14, -0.19, 0.91, -0.38, 0.042, 0.042);
    addTube( 0.16, 1.28, -0.14,  0.19, 0.91, -0.38, 0.042, 0.042);
    // Legs
    addTube(-0.11, 0.94, 0.20, -0.11, 0.68, -0.02, 0.06, 0.065); // L thigh
    addTube(-0.11, 0.68, -0.02, -0.11, 0.26, 0.06, 0.045, 0.045); // L calf
    addTube( 0.11, 0.94, 0.20,  0.11, 0.60, 0.08, 0.06, 0.065); // R thigh
    addTube( 0.11, 0.60, 0.08,  0.11, 0.38, 0.14, 0.045, 0.045); // R calf

    // Floating Ghost Diamond Beacon above helmet (y = 1.78 .. 2.08)
    const by = 1.93, r = 0.13, h = 0.17;
    pushTri(0, by + h, 0,  0, by, -r,  r, by, 0);
    pushTri(0, by + h, 0,  r, by,  0,  0, by, r);
    pushTri(0, by + h, 0,  0, by,  r, -r, by, 0);
    pushTri(0, by + h, 0, -r, by,  0,  0, by, -r);
    pushTri(0, by - h, 0,  r, by,  0,  0, by, -r);
    pushTri(0, by - h, 0,  0, by,  r,  r, by, 0);
    pushTri(0, by - h, 0, -r, by,  0,  0, by, r);
    pushTri(0, by - h, 0,  0, by, -r, -r, by, 0);

    return {
      localPos: new Float32Array(pos),
      localNorm: new Float32Array(norm),
      localUv: new Float32Array(uv),
      indices: new Uint32Array(idx),
      vertCount: pos.length / 3,
      idxCount: idx.length,
    };
  }

  /* ── 5. Addon State & Persistence ─────────────────────────────────────────── */
  const ghostGeom = buildCyclistGeometry();
  let savedTracks = [];
  let activeTrack = null;

  // Live Ghost Race State
  const race = {
    started: false,
    paused: false,
    clockSec: 0,
    lastStepMs: 0,
    startOffsetM: 0,      // road distance where ghost t=0 starts
    egoCoveredM: 0,       // ego progress since ghost started
    prevEgoRoadDist: null,
    egoRoadDist: null,
    egoSpeedMps: 0,
    egoPowerW: 0,
    egoLat: null,
    egoLng: null,
    ghostWorldPos: null,  // { x, y, z }
    ghostSample: null,    // { t, d, p, s, h, finished }
    timeGapSec: null,
    distGapM: null,
    statusNote: '',
  };

  async function loadPersisted() {
    try {
      const list = await terra.storage.get(STORAGE_LIST_KEY, []);
      if (Array.isArray(list)) savedTracks = list;
      const activeId = await terra.storage.get(STORAGE_ACTIVE_KEY, null);
      if (activeId) {
        activeTrack = savedTracks.find((t) => t && t.id === activeId) || null;
      }
      if (!activeTrack && savedTracks.length > 0) {
        activeTrack = savedTracks[0];
      }
    } catch (e) {
      log('storage load warning: ' + e);
    }
  }

  async function persistTracks() {
    try {
      await terra.storage.set(STORAGE_LIST_KEY, savedTracks);
      await terra.storage.set(STORAGE_ACTIVE_KEY, activeTrack ? activeTrack.id : null);
    } catch (e) {
      log('storage save warning: ' + e);
    }
  }

  function resetRace(newOffsetM = null) {
    race.started = false;
    race.paused = false;
    race.clockSec = 0;
    race.lastStepMs = performance.now();
    if (newOffsetM !== null && Number.isFinite(newOffsetM)) {
      race.startOffsetM = newOffsetM;
    }
    race.egoCoveredM = (race.egoRoadDist !== null) ? Math.max(0, race.egoRoadDist - race.startOffsetM) : 0;
    race.prevEgoRoadDist = race.egoRoadDist;
    race.ghostSample = activeTrack ? sampleGhostAtTime(activeTrack, 0) : null;
    race.timeGapSec = null;
    race.distGapM = null;
  }

  function activateTrack(track, snapToCurrent = false) {
    activeTrack = track;
    if (snapToCurrent && race.egoRoadDist !== null) {
      resetRace(race.egoRoadDist);
      race.statusNote = 'Aligned to current spot';
    } else {
      resetRace(0);
      race.statusNote = track.hasRealTime ? 'Ready at start' : 'Timeless GPX (pacer mode)';
    }
    persistTracks();
    renderHud();
    renderSavedList();
  }

  function gpsAlignTrack() {
    if (!activeTrack || !activeTrack.hasGps) {
      race.statusNote = 'Track has no GPS coordinates';
      renderHud();
      return;
    }
    if (race.egoLat === null || race.egoLng === null) {
      race.statusNote = 'Waiting for live GPS from Biketerra...';
      renderHud();
      return;
    }
    let bestI = 0, bestD = Infinity;
    const pts = activeTrack.samples;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].lat === null || pts[i].lng === null) continue;
      const d = haversineM(race.egoLat, race.egoLng, pts[i].lat, pts[i].lng);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    if (bestD > 1000) {
      race.statusNote = `Nearest GPS point is ${Math.round(bestD)}m away`;
      renderHud();
      return;
    }
    // Shift ghost clock to the matching point on the track, or align offset so ghost starts at current road spot
    const trackDistAtMe = pts[bestI].d;
    if (race.egoRoadDist !== null) {
      const offset = Math.max(0, race.egoRoadDist - trackDistAtMe);
      race.startOffsetM = offset;
      race.egoCoveredM = trackDistAtMe;
      race.clockSec = pts[bestI].t;
      race.started = true;
      race.paused = false;
      race.lastStepMs = performance.now();
      race.statusNote = `GPS matched (${Math.round(bestD)}m)`;
    }
    renderHud();
  }

  async function handleFileLoad(file) {
    if (!file) return;
    const fallbackMps = clamp(Number(S.pacerSpeedKmh) || 30, 5, 80) / 3.6;
    try {
      const lower = (file.name || '').toLowerCase();
      let track;
      if (lower.endsWith('.fit')) {
        const buf = await file.arrayBuffer();
        track = parseFit(buf, file.name, fallbackMps);
      } else if (lower.endsWith('.gpx')) {
        const txt = await file.text();
        track = parseGpx(txt, file.name, fallbackMps);
      } else {
        throw new Error('Please choose a .fit or .gpx file.');
      }

      // Deduplicate by name + totalDistM
      savedTracks = [
        track,
        ...savedTracks.filter((t) => !(t.name === track.name && Math.abs(t.totalDistM - track.totalDistM) < 5)),
      ].slice(0, MAX_SAVED_TRACKS);

      activateTrack(track, false);
    } catch (err) {
      race.statusNote = err && err.message ? err.message : String(err);
      log('load failed: ' + race.statusNote);
      renderHud();
    }
  }

  /* ── 6. HUD + Floating Nameplate Overlay ──────────────────────────────────── */
  const card = document.createElement('div');
  card.className = 'tr-gr-card';
  card.innerHTML = `
    <div class="tr-gr-head">
      <span class="tr-gr-badge">GHOST</span>
      <span class="tr-gr-title">No track loaded</span>
      <button type="button" class="tr-gr-icon-btn" data-act="drawer" title="Saved ghosts">📂</button>
      <button type="button" class="tr-gr-icon-btn" data-act="settings" title="Ghost settings">⚙</button>
      <button type="button" class="tr-gr-icon-btn" data-act="collapse" title="Collapse">▾</button>
    </div>
    <div class="tr-gr-body">
      <div class="tr-gr-empty">
        <div class="tr-gr-hint">Load a previous <b>.fit</b> or <b>.gpx</b> ride of this road (or drop a file here) to race against a 3D ghost.</div>
        <button type="button" class="tr-gr-load-btn" data-act="pick">Load .FIT / .GPX File</button>
      </div>
      <div class="tr-gr-live" style="display:none">
        <div class="tr-gr-gap-row">
          <div class="tr-gr-gap-time even">0.0s</div>
          <div class="tr-gr-gap-dist">0 m</div>
        </div>
        <div class="tr-gr-bar-wrap">
          <div class="tr-gr-bar-fill" style="width:0%"></div>
          <div class="tr-gr-dot ghost" style="left:0%"></div>
          <div class="tr-gr-dot ego" style="left:0%"></div>
        </div>
        <div class="tr-gr-stats">
          <div class="tr-gr-stat"><div class="tr-gr-stat-l">Ghost W</div><div class="tr-gr-stat-v" data-f="gw">--</div></div>
          <div class="tr-gr-stat"><div class="tr-gr-stat-l">Ghost Spd</div><div class="tr-gr-stat-v" data-f="gs">--</div></div>
          <div class="tr-gr-stat"><div class="tr-gr-stat-l">Ghost km</div><div class="tr-gr-stat-v" data-f="gd">--</div></div>
        </div>
        <div class="tr-gr-controls" style="margin-top:6px">
          <button type="button" class="tr-gr-btn primary" data-act="toggle">▶ Start</button>
          <button type="button" class="tr-gr-btn" data-act="snap" title="Align ghost start to your current road spot">📍 Snap</button>
          <button type="button" class="tr-gr-btn" data-act="gps" title="Sync to nearest GPS coordinate">🎯 GPS</button>
          <button type="button" class="tr-gr-btn" data-act="reset" title="Reset ghost clock to 0">↺</button>
          <button type="button" class="tr-gr-btn" data-act="pick" title="Load another file">📁</button>
        </div>
        <div class="tr-gr-status" style="margin-top:5px">
          <span data-f="note">Ready</span>
          <span data-f="clock">0:00</span>
        </div>
      </div>
      <div class="tr-gr-saved" style="display:none"></div>
    </div>
    <input type="file" accept=".fit,.gpx" style="display:none" />
  `;

  const ov = document.createElement('div');
  ov.className = 'tr-gr-ov';
  const plateEl = document.createElement('div');
  plateEl.className = 'tr-gr-plate';
  const dot2dEl = document.createElement('div');
  dot2dEl.className = 'tr-gr-dot-2d';
  ov.appendChild(dot2dEl);
  ov.appendChild(plateEl);

  document.body.appendChild(ov);
  document.body.appendChild(card);

  const fileInput = card.querySelector('input[type="file"]');
  const els = {
    head: card.querySelector('.tr-gr-head'),
    title: card.querySelector('.tr-gr-title'),
    body: card.querySelector('.tr-gr-body'),
    empty: card.querySelector('.tr-gr-empty'),
    live: card.querySelector('.tr-gr-live'),
    saved: card.querySelector('.tr-gr-saved'),
    gapTime: card.querySelector('.tr-gr-gap-time'),
    gapDist: card.querySelector('.tr-gr-gap-dist'),
    barFill: card.querySelector('.tr-gr-bar-fill'),
    dotGhost: card.querySelector('.tr-gr-dot.ghost'),
    dotEgo: card.querySelector('.tr-gr-dot.ego'),
    gw: card.querySelector('[data-f="gw"]'),
    gs: card.querySelector('[data-f="gs"]'),
    gd: card.querySelector('[data-f="gd"]'),
    note: card.querySelector('[data-f="note"]'),
    clock: card.querySelector('[data-f="clock"]'),
    toggleBtn: card.querySelector('[data-act="toggle"]'),
    collapseBtn: card.querySelector('[data-act="collapse"]'),
  };

  let collapsed = false;
  let drawerOpen = false;

  function applyHudOpacity() {
    const op = clamp(S.hudOpacity, 30, 100) / 100;
    card.style.background = `rgba(15, 23, 42, ${op.toFixed(2)})`;
  }
  applyHudOpacity();

  // Restore saved HUD position
  try {
    const pos = await terra.storage.get(STORAGE_POS_KEY, null);
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
      card.style.left = `${clamp(pos.left, 0, Math.max(40, window.innerWidth - 100))}px`;
      card.style.top = `${clamp(pos.top, 0, Math.max(40, window.innerHeight - 60))}px`;
    }
  } catch {}

  // Draggable header
  (() => {
    let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    els.head.addEventListener('pointerdown', (e) => {
      if (e.target && e.target.closest && e.target.closest('button')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = card.getBoundingClientRect();
      ox = r.left; oy = r.top;
      try { els.head.setPointerCapture(e.pointerId); } catch {}
    });
    els.head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const nx = clamp(ox + (e.clientX - sx), 4, Math.max(4, window.innerWidth - card.offsetWidth - 4));
      const ny = clamp(oy + (e.clientY - sy), 4, Math.max(4, window.innerHeight - 40));
      card.style.left = `${nx}px`;
      card.style.top = `${ny}px`;
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      const r = card.getBoundingClientRect();
      try { terra.storage.set(STORAGE_POS_KEY, { left: Math.round(r.left), top: Math.round(r.top) }); } catch {}
    };
    els.head.addEventListener('pointerup', endDrag);
    els.head.addEventListener('pointercancel', endDrag);
  })();

  // Drag & drop .fit / .gpx directly onto the card
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.classList.add('dragover');
  });
  card.addEventListener('dragleave', () => card.classList.remove('dragover'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('dragover');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFileLoad(f);
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (f) handleFileLoad(f);
  });

  card.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'pick') {
      fileInput.click();
    } else if (act === 'settings') {
      try { terra.settings.open(); } catch {}
    } else if (act === 'collapse') {
      collapsed = !collapsed;
      card.classList.toggle('compact', collapsed);
      els.body.style.display = collapsed ? 'none' : '';
      els.collapseBtn.textContent = collapsed ? '▸' : '▾';
    } else if (act === 'drawer') {
      drawerOpen = !drawerOpen;
      renderSavedList();
    } else if (act === 'toggle') {
      if (!activeTrack) return;
      if (!race.started) {
        race.started = true;
        race.paused = false;
        race.lastStepMs = performance.now();
        race.statusNote = 'Racing';
      } else {
        race.paused = !race.paused;
        race.lastStepMs = performance.now();
        race.statusNote = race.paused ? 'Paused' : 'Racing';
      }
      renderHud();
    } else if (act === 'snap') {
      if (activeTrack && race.egoRoadDist !== null) {
        resetRace(race.egoRoadDist);
        race.started = true;
        race.paused = false;
        race.statusNote = 'Snapped to current spot';
        renderHud();
      }
    } else if (act === 'gps') {
      gpsAlignTrack();
    } else if (act === 'reset') {
      resetRace();
      race.statusNote = 'Reset to start';
      renderHud();
    }
  });

  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    return `${m}:${String(r).padStart(2, '0')}`;
  }

  function renderSavedList() {
    if (!drawerOpen || savedTracks.length === 0) {
      els.saved.style.display = 'none';
      els.saved.replaceChildren();
      return;
    }
    els.saved.style.display = 'flex';
    els.saved.replaceChildren();
    for (const tr of savedTracks) {
      const row = document.createElement('div');
      row.className = 'tr-gr-saved-item' + (activeTrack && activeTrack.id === tr.id ? ' active' : '');
      const meta = document.createElement('div');
      meta.className = 'tr-gr-saved-meta';
      const nm = document.createElement('div');
      nm.className = 'tr-gr-saved-name';
      nm.textContent = tr.name;
      const sub = document.createElement('div');
      sub.className = 'tr-gr-saved-sub';
      sub.textContent = `${(tr.totalDistM / 1000).toFixed(1)} km · ${fmtClock(tr.totalTimeS)}${tr.avgPowerW ? ` · ${tr.avgPowerW}W` : ''}`;
      meta.append(nm, sub);
      meta.addEventListener('click', () => {
        activateTrack(tr, false);
        drawerOpen = false;
        renderSavedList();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'tr-gr-icon-btn';
      del.textContent = '✕';
      del.title = 'Remove saved ghost';
      del.addEventListener('click', (ev) => {
        ev.stopPropagation();
        savedTracks = savedTracks.filter((x) => x.id !== tr.id);
        if (activeTrack && activeTrack.id === tr.id) {
          activeTrack = savedTracks[0] || null;
          resetRace(0);
        }
        persistTracks();
        renderHud();
        renderSavedList();
      });

      row.append(meta, del);
      els.saved.appendChild(row);
    }
  }

  function renderHud() {
    if (!activeTrack) {
      els.title.textContent = 'No track loaded';
      els.empty.style.display = '';
      els.live.style.display = 'none';
      return;
    }

    els.title.textContent = activeTrack.name;
    els.empty.style.display = 'none';
    els.live.style.display = '';

    const g = race.ghostSample || sampleGhostAtTime(activeTrack, race.clockSec);
    const tGap = race.timeGapSec;
    if (tGap === null || !Number.isFinite(tGap)) {
      els.gapTime.textContent = '0.0s';
      els.gapTime.className = 'tr-gr-gap-time even';
    } else {
      const sign = tGap > 0.05 ? '+' : (tGap < -0.05 ? '-' : '');
      els.gapTime.textContent = `${sign}${Math.abs(tGap).toFixed(1)}s`;
      els.gapTime.className = 'tr-gr-gap-time ' + (tGap < -0.2 ? 'ahead' : (tGap > 0.2 ? 'behind' : 'even'));
    }

    const dGap = race.distGapM;
    if (dGap === null || !Number.isFinite(dGap)) {
      els.gapDist.textContent = `${(activeTrack.totalDistM / 1000).toFixed(1)} km`;
    } else {
      const absD = Math.abs(Math.round(dGap));
      els.gapDist.textContent = absD < 2 ? 'Even' : (dGap > 0 ? `${absD}m ahead` : `${absD}m behind`);
    }

    const ghostPct = clamp((g.d / Math.max(1, activeTrack.totalDistM)) * 100, 0, 100);
    const egoPct = clamp((race.egoCoveredM / Math.max(1, activeTrack.totalDistM)) * 100, 0, 100);
    els.barFill.style.width = `${ghostPct.toFixed(1)}%`;
    els.dotGhost.style.left = `${ghostPct.toFixed(1)}%`;
    els.dotEgo.style.left = `${egoPct.toFixed(1)}%`;

    els.gw.textContent = g.p > 0 ? `${g.p} W` : '--';
    els.gs.textContent = `${(g.s * 3.6).toFixed(1)}`;
    els.gd.textContent = `${(g.d / 1000).toFixed(2)}`;

    els.toggleBtn.textContent = !race.started ? '▶ Start' : (race.paused ? '▶ Resume' : '⏸ Pause');
    const stBase = g.finished ? 'Ghost finished' : (race.statusNote || (race.started ? 'Racing' : 'Ready'));
    const d3 = render3d.diagShort ? ` · ${render3d.diagShort}` : '';
    els.note.textContent = stBase + d3;
    els.clock.textContent = `${fmtClock(race.clockSec)} / ${fmtClock(activeTrack.totalTimeS)}`;
  }

  /* ── 7. 3D Scene Rendering (Cloned Biketerra Avatar + pools.misc fallback) ── */
  const render3d = {
    disabled: false,
    diagShort: '',
    misc: null,
    handle: null,
    buffersMeta: null,
    dataMap: null,
    posOut: null,
    normOut: null,
    uploading: false,
    lastUploadX: NaN,
    lastUploadY: NaN,
    lastUploadZ: NaN,
    lastUploadMs: 0,
    bounds: [0, 0, 0, 0, 0, 0],
    draws: [],
  };

  const ghostAvatar = {
    disabled: false,
    rider: null,
    sim: null,
    rc: null,
    style: null,
    pedalPhase: 0,
    steerAngle: 0,
    steerSign: 1,
    lastMs: 0,
    loggedMode: false,
  };

  function blendHex(hex, targetHex, t) {
    const parse = (h) => {
      if (typeof h !== 'string') return null;
      const m = h.trim().match(/^#?([0-9a-f]{6})$/i);
      if (!m) return null;
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const a = parse(hex);
    const b = parse(targetHex);
    if (!a || !b) return targetHex;
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
  }

  function buildGhostDesign(egoDesign, style) {
    const base = egoDesign && typeof egoDesign === 'object' ? { ...egoDesign } : {};
    if (style === 'exact') return base;

    // Tinted spectral-cyan ghost palette derived from ego's own kit & bike
    delete base.jersey_slug;
    const cyan = '#67e8f9';
    const ice = '#cffafe';
    base.jersey_color = blendHex(base.jersey_color || '#38bdf8', cyan, 0.72);
    base.pants_color = blendHex(base.pants_color || '#1e293b', '#38bdf8', 0.68);
    base.helmet_color = blendHex(base.helmet_color || '#e0f2fe', ice, 0.75);
    base.helmet_accent_color = '#ffffff';
    base.shoe_color = blendHex(base.shoe_color || '#0ea5e9', cyan, 0.7);
    base.shoe_accent_color = '#ffffff';
    base.sock_color = blendHex(base.sock_color || '#bae6fd', ice, 0.78);
    base.bike_frame_color = blendHex(base.bike_frame_color || '#7dd3fc', cyan, 0.76);
    base.bike_sidewall_color = blendHex(base.bike_sidewall_color || '#bae6fd', ice, 0.75);
    base.skin_color = blendHex(base.skin_color || '#e0f2fe', '#e0f7ff', 0.65);
    base.hair_color = blendHex(base.hair_color || '#bae6fd', ice, 0.72);
    return base;
  }

  function destroyGhostAvatar() {
    if (ghostAvatar.rider && ghostAvatar.rc && typeof ghostAvatar.rc.unregister === 'function') {
      try { ghostAvatar.rc.unregister(ghostAvatar.rider); } catch {}
    }
    ghostAvatar.rider = null;
    ghostAvatar.sim = null;
    ghostAvatar.rc = null;
    ghostAvatar.style = null;
    ghostAvatar.steerAngle = 0;
  }

  function pickRiderCandidates(rc, template) {
    const out = [];
    const seen = new Set();
    const push = (fn) => {
      if (typeof fn === 'function' && fn !== Object && !seen.has(fn)) {
        seen.add(fn);
        out.push(fn);
      }
    };
    if (rc && rc.ego) {
      const p1 = Object.getPrototypeOf(rc.ego);
      const p2 = p1 ? Object.getPrototypeOf(p1) : null;
      if (p2 && p2 !== Object.prototype) push(p2.constructor);
    }
    if (rc) push(rc.botRiderClass);
    if (template) {
      const p1 = Object.getPrototypeOf(template);
      const p2 = p1 ? Object.getPrototypeOf(p1) : null;
      if (p2 && p2 !== Object.prototype) push(p2.constructor);
    }
    if (rc && Array.isArray(rc.riders)) {
      for (const r of rc.riders) {
        if (!r || r._isTerraGhost || !r.sim) continue;
        const p1 = Object.getPrototypeOf(r);
        const p2 = p1 ? Object.getPrototypeOf(p1) : null;
        if (p2 && p2 !== Object.prototype) push(p2.constructor);
      }
    }
    // Direct class (1 level above Object.prototype), e.g. when focalRider is BaseRider/HumanRider directly
    if (template) {
      const p1 = Object.getPrototypeOf(template);
      if (p1 && p1 !== Object.prototype) push(p1.constructor);
    }
    if (rc && Array.isArray(rc.riders)) {
      for (const r of rc.riders) {
        if (!r || r._isTerraGhost || !r.sim) continue;
        const p1 = Object.getPrototypeOf(r);
        if (p1 && p1 !== Object.prototype) push(p1.constructor);
      }
    }
    return out;
  }

  function pickSimBase(sim) {
    if (!sim) return null;
    const p1 = Object.getPrototypeOf(sim);
    const p2 = p1 ? Object.getPrototypeOf(p1) : null;
    if (p2 && p2 !== Object.prototype) return p2;
    if (p1 && p1 !== Object.prototype) return p1;
    return null;
  }

  function ensureGhostAvatar(pose) {
    const style = S.avatarStyle || 'exact';
    if (ghostAvatar.disabled || style === 'simple') return false;

    const bt = window.btApp;
    const rc = bt && (bt.riderController || bt.rideController);
    const template = rc && (rc.ego || rc.focalRider);
    if (!rc || typeof rc.register !== 'function' || !template || !template.sim || !template.design) {
      return false;
    }

    if (ghostAvatar.rider) {
      if (ghostAvatar.rc === rc && ghostAvatar.style === style &&
          Array.isArray(rc.riders) && rc.riders.indexOf(ghostAvatar.rider) !== -1) {
        return true;
      }
      destroyGhostAvatar();
    }

    try {
      const candidates = pickRiderCandidates(rc, template);
      const simBase = pickSimBase(template.sim);
      if (candidates.length === 0 || !simBase) {
        if (!ghostAvatar.loggedMode) {
          ghostAvatar.loggedMode = true;
          log(`no avatar class candidates (ego=${!!rc.ego}, bot=${typeof rc.botRiderClass}, simBase=${!!simBase})`);
        }
        ghostAvatar.disabled = true;
        return false;
      }

      const baseCfg = (template.config && typeof template.config === 'object') ? template.config : {};
      const ghostCfg = {
        ...baseCfg,
        bike: baseCfg.bike ? { ...baseCfg.bike } : { model: 'Canyon' },
        rider: baseCfg.rider ? { ...baseCfg.rider } : { model: 'Neutral' },
        first_name: 'Ghost',
        last_name: '',
        id: '__terra_ghost__',
      };

      const ghostSim = Object.create(simBase);
      const es = template.sim;
      Object.assign(ghostSim, {
        type: -1,
        authority: 'addon',
        id: '__terra_ghost__',
        athleteId: null,
        teamId: null,
        config: ghostCfg,
        bikeMetrics: es.bikeMetrics,
        generation: 1,
        positionRevision: 1,
        race: null,
        totalMassKg: es.totalMassKg || 75,
        riderMassKg: es.riderMassKg || 68,
        cda: es.cda || 0.3,
        position: { x: pose.wx, y: pose.wy, z: pose.wz },
        midPosition: { x: pose.wx, y: pose.wy, z: pose.wz },
        frontPosition: { x: pose.wx, y: pose.wy, z: pose.wz },
        speed: 0,
        pSpeed: 0,
        accel: 0,
        heading: Math.atan2(-pose.tang.z, pose.tang.x),
        steerAngle: 0,
        brake: 0,
        grade: pose.slope || 0,
        cosGrade: 1 / Math.hypot(1, pose.slope || 0),
        dx: pose.tang.x,
        dz: pose.tang.z,
        power: 0,
        cadence: 0,
        heartRate: 0,
        standing: false,
        standingGradeThreshold: es.standingGradeThreshold ?? 0.09,
        draftFactor: 1,
        smoothWkg: 0,
        crr: es.crr ?? 0.004,
        naturalSteerAngle: 0,
        microSteer: 0,
        microSteerScale: 0,
        pedalPhase: 0,
        sport: es.sport || 'cycling',
        currentPath: es.currentPath,
        currentPathNode: pose.node || es.currentRoadNode || es.currentPathNode,
        currentRoadNode: pose.node || es.currentRoadNode,
        currentPathDistance: pose.distM || 0,
        progressSamples: [],
        lapsRemaining: 0,
        raceFinished: false,
        currentNodeOffset: 0,
        currentNodeOffsetLerp: 0,
        lateralOffset: 0,
        frontLateralOffset: 0,
        pLateralOffset: 0,
        lateralOffsetTarget: 0,
        preferredLateralOffset: 0,
        closestPointOnPath: null,
        closestPointOnPathFront: null,
        targetPosition: null,
        targetNode: null,
        curLod: 4,
        isFocalRider: false,
        lapCount: 0,
        prevPathDistance: 0,
      });

      let ghostRider = null;
      let usedCtor = null;
      const errs = [];
      for (const Ctor of candidates) {
        try {
          const inst = new Ctor(ghostSim, ghostCfg, true);
          if (inst && typeof inst === 'object' && inst !== ghostSim && inst.sim === ghostSim && inst.sim.currentRoadNode) {
            ghostRider = inst;
            usedCtor = Ctor;
            break;
          }
          errs.push(`${Ctor.name || 'anon'}:invalid_sim`);
        } catch (ce) {
          errs.push(`${Ctor.name || 'anon'}:${ce && ce.message ? ce.message : ce}`);
        }
      }
      if (!ghostRider) {
        if (!ghostAvatar.loggedMode) {
          ghostAvatar.loggedMode = true;
          log('cloned avatar ctors failed (falling back to 3D mesh): ' + errs.join(' | '));
        }
        ghostAvatar.disabled = true;
        return false;
      }
      ghostSim.update = () => {};
      ghostSim.updateAlways = () => {};
      ghostSim._updateSkip = () => {};
      ghostRider.design = buildGhostDesign(template.design, style);
      ghostRider._isTerraGhost = true;
      ghostRider.updateCounter = 0;
      ghostRider.update = () => {};
      ghostRider.setLod = (lod) => { ghostSim.curLod = lod; };
      ghostRider.destroy = () => {};

      rc.register(ghostRider);

      ghostAvatar.rider = ghostRider;
      ghostAvatar.sim = ghostSim;
      ghostAvatar.rc = rc;
      ghostAvatar.style = style;
      ghostAvatar.lastPose = pose;
      ghostAvatar.steerAngle = 0;
      ghostAvatar.lastMs = performance.now();
      applyGhostSimPose(ghostSim, pose, false);

      const op = clamp(S.ghostOpacity ?? 55, 15, 100);
      const tn = clamp(S.ghostTint ?? 20, 0, 100);
      render3d.diagShort = (style === 'exact' && op >= 99.5 && tn <= 0.5)
        ? 'Avatar (copy)'
        : (compositor.disabled ? 'Avatar (opaque)' : 'Avatar (ghost)');
      if (!ghostAvatar.loggedMode) {
        ghostAvatar.loggedMode = true;
        log(`spawned cloned Biketerra avatar (${style}, ctor=${usedCtor.name || 'anon'})`);
      }
      return true;
    } catch (e) {
      log('cloned avatar spawn failed (falling back to 3D mesh): ' + e);
      destroyGhostAvatar();
      ghostAvatar.disabled = true;
      return false;
    }
  }

  function applyGhostSimPose(sim, pose, advancePedal, dtOverride) {
    if (!sim || !pose) return;
    const wb = (sim.bikeMetrics && sim.bikeMetrics.wheelBase) || 0.99;
    const moving = race.started && !race.paused && pose.g.s > 0.3;
    if (advancePedal) {
      const now = performance.now();
      const dt = (typeof dtOverride === 'number' && Number.isFinite(dtOverride))
        ? clamp(dtOverride, 0, 0.25)
        : (ghostAvatar.lastMs > 0 ? clamp((now - ghostAvatar.lastMs) / 1000, 0, 0.25) : 0);
      ghostAvatar.lastMs = now;
      const cad = moving ? (pose.g.p > 0 ? 85 : 70) : 0;
      if (moving) {
        ghostAvatar.pedalPhase = (ghostAvatar.pedalPhase + dt * (cad / 60)) % 1;
      }
      sim.cadence = cad;
      sim.standing = moving && (pose.slope || 0) > 0.085 && pose.g.p > 240;

      const targetSteer = moving
        ? clamp(ghostAvatar.steerSign * Math.atan(wb * (pose.kappa || 0)), -0.45, 0.45)
        : 0;
      const alpha = dt > 0 ? (1 - Math.exp(-dt / 0.16)) : 1;
      ghostAvatar.steerAngle += (targetSteer - ghostAvatar.steerAngle) * alpha;
    }

    const tx = pose.tang.x;
    const tz = pose.tang.z;
    const slope = pose.slope || 0;
    const backOff = 0.40 * wb;
    const frontOff = 0.60 * wb;

    sim.midPosition.x = pose.wx;
    sim.midPosition.y = pose.wy;
    sim.midPosition.z = pose.wz;

    sim.position.x = pose.wx - tx * backOff;
    sim.position.y = pose.wy - slope * backOff;
    sim.position.z = pose.wz - tz * backOff;

    sim.frontPosition.x = pose.wx + tx * frontOff;
    sim.frontPosition.y = pose.wy + slope * frontOff;
    sim.frontPosition.z = pose.wz + tz * frontOff;

    const hdg = Math.atan2(-tz, tx);
    sim.heading = hdg;
    sim.targetAngle = hdg;
    sim.steerAngle = ghostAvatar.steerAngle;
    sim.naturalSteerAngle = ghostAvatar.steerAngle;
    sim.targetSteerAngle = ghostAvatar.steerAngle;
    sim.targetPosition = { x: pose.wx, y: pose.wy, z: pose.wz };
    sim.dx = tx;
    sim.dz = tz;
    sim.grade = slope;
    sim.cosGrade = 1 / Math.hypot(1, slope);
    sim.speed = pose.g.s;
    sim.pSpeed = pose.g.s;
    sim.power = pose.g.p;
    sim.heartRate = pose.g.h;
    sim.pedalPhase = ghostAvatar.pedalPhase;
    sim.positionRevision = ((sim.positionRevision || 0) + 1) | 0;
    sim.currentPathDistance = pose.distM || 0;
    if (pose.node) {
      sim.currentRoadNode = pose.node;
      sim.currentPathNode = pose.node;
    }
  }

  function updateGhostAvatar(pose, dtOverride) {
    const sim = ghostAvatar.sim;
    if (!sim) return;
    ghostAvatar.lastPose = pose;
    applyGhostSimPose(sim, pose, true, dtOverride);
  }

  function slabsHas(slabs, slab) {
    if (!slabs || !slab) return false;
    if (typeof slabs.has === 'function') return slabs.has(slab);
    if (Array.isArray(slabs)) return slabs.indexOf(slab) !== -1;
    return false;
  }

  function init3DMesh(scope, env) {
    if (render3d.disabled || render3d.handle) return !!render3d.handle;
    const misc = env && env.engine && env.engine.pools && env.engine.pools.misc;
    if (!misc || !misc.slabs || !misc.format || !Array.isArray(misc.format.buffers) ||
        typeof misc.allocate !== 'function' || typeof misc.upload !== 'function') {
      render3d.diagShort = 'no pools.misc';
      return false;
    }

    let handle;
    try {
      handle = misc.allocate(scope, ghostGeom.vertCount, ghostGeom.idxCount);
    } catch (e) {
      log('misc.allocate failed (falling back to 2D marker): ' + e);
      render3d.diagShort = 'alloc err';
      render3d.disabled = true;
      return false;
    }
    if (!handle) {
      render3d.diagShort = 'alloc null';
      return false;
    }
    log('misc.allocate OK:', JSON.stringify(Object.keys(handle)));

    const dataMap = {};
    let posOut = null;
    let normOut = null;
    const metas = [];

    for (const buf of misc.format.buffers) {
      for (const attr of (buf.attributes || [])) {
        const comp = attr.components || 3;
        const field = attr.field;
        if (!field) continue;
        const arr = new Float32Array(ghostGeom.vertCount * comp);
        if (comp === 3 && !posOut) {
          posOut = arr;
        } else if (comp === 3 && !normOut) {
          normOut = arr;
        } else if (comp === 2) {
          arr.set(ghostGeom.localUv);
        } else if (comp === 4) {
          for (let i = 0; i < ghostGeom.vertCount; i++) {
            arr[i * 4 + 0] = 0.25;
            arr[i * 4 + 1] = 0.85;
            arr[i * 4 + 2] = 1.0;
            arr[i * 4 + 3] = 1.0;
          }
        }
        dataMap[field] = arr;
        metas.push({ field, comp });
      }
    }

    if (!posOut) {
      log('misc.format had no 3-component position attribute');
      render3d.disabled = true;
      return false;
    }

    render3d.misc = misc;
    render3d.handle = handle;
    render3d.dataMap = dataMap;
    render3d.posOut = posOut;
    render3d.normOut = normOut;
    render3d.buffersMeta = metas;
    return true;
  }

  function uploadGhostPose(pose) {
    if (!render3d.handle || !render3d.misc) return;
    const now = performance.now();
    if (render3d.uploading && (now - render3d.lastUploadMs) < 400) return;
    const moved = Math.hypot(
      pose.wx - render3d.lastUploadX,
      pose.wy - render3d.lastUploadY,
      pose.wz - render3d.lastUploadZ
    );
    if (Number.isFinite(moved) && moved < 0.02 && (now - render3d.lastUploadMs) < 250) return;

    // Orthonormal right-handed basis (R, U, B) pitched to road slope
    const tx = pose.tang.x, tz = pose.tang.z, slope = pose.slope;
    const invF = 1 / Math.hypot(1, slope);
    const fx = tx * invF, fy = slope * invF, fz = tz * invF;
    const bx = -fx, by = -fy, bz = -fz; // Back (+Z local)
    const rx = pose.norm.x, ry = 0, rz = pose.norm.z; // Right (+X local)
    // Up = Back x Right
    const ux = by * rz - bz * ry;
    const uy = bz * rx - bx * rz;
    const uz = bx * ry - by * rx;

    const lp = ghostGeom.localPos;
    const ln = ghostGeom.localNorm;
    const po = render3d.posOut;
    const no = render3d.normOut;
    const vc = ghostGeom.vertCount;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < vc; i++) {
      const i3 = i * 3;
      const lx = lp[i3], ly = lp[i3 + 1], lz = lp[i3 + 2];
      const wx = pose.wx + rx * lx + ux * ly + bx * lz;
      const wy = pose.wy + ry * lx + uy * ly + by * lz;
      const wz = pose.wz + rz * lx + uz * ly + bz * lz;
      po[i3] = wx; po[i3 + 1] = wy; po[i3 + 2] = wz;
      if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;

      if (no) {
        const lnx = ln[i3], lny = ln[i3 + 1], lnz = ln[i3 + 2];
        no[i3]     = rx * lnx + ux * lny + bx * lnz;
        no[i3 + 1] = ry * lnx + uy * lny + by * lnz;
        no[i3 + 2] = rz * lnx + uz * lny + bz * lnz;
      }
    }

    render3d.bounds[0] = minX; render3d.bounds[1] = minY; render3d.bounds[2] = minZ;
    render3d.bounds[3] = maxX; render3d.bounds[4] = maxY; render3d.bounds[5] = maxZ;

    render3d.uploading = true;
    render3d.lastUploadX = pose.wx;
    render3d.lastUploadY = pose.wy;
    render3d.lastUploadZ = pose.wz;
    render3d.lastUploadMs = now;

    try {
      const payload = { ...render3d.dataMap, indices: ghostGeom.indices };
      const res = render3d.misc.upload(render3d.handle, payload, { ox: 0, oz: 0 });
      if (res && typeof res.then === 'function') {
        res.then(
          () => { render3d.uploading = false; },
          (err) => { render3d.uploading = false; render3d.diagShort = 'upload err'; log('misc.upload rejected:', err); }
        );
      } else {
        render3d.uploading = false;
      }
    } catch (err) {
      render3d.uploading = false;
      render3d.diagShort = 'upload throw';
      log('misc.upload throw:', err);
    }
  }

  function pushGhostDraws(renderQueue) {
    if (!renderQueue || !Array.isArray(renderQueue.draws) || !render3d.handle || !render3d.misc) {
      render3d.diagShort = 'no renderQueue';
      return false;
    }
    const slabs = render3d.misc.slabs;
    let ref = null;
    for (let i = 0; i < renderQueue.draws.length; i++) {
      const d = renderQueue.draws[i];
      if (d && d.geometry && slabsHas(slabs, d.geometry.slab) && d.pipeline && d.groups) {
        ref = d;
        break;
      }
    }
    if (!ref) {
      render3d.diagShort = 'no misc ref';
      return false;
    }
    render3d.diagShort = '3D active';

    const passes = clamp(Math.round(Number(S.ghostPasses) || 1), 1, 3);
    while (render3d.draws.length < passes) {
      render3d.draws.push({
        pipeline: ref.pipeline,
        index: ref.index,
        geometry: render3d.handle,
        instances: null,
        groups: ref.groups,
        shadowGroups: ref.shadowGroups ?? null,
        bounds: render3d.bounds,
        shadowIndex: ref.shadowIndex ?? 0,
        castsShadow: false,
        shadowOnly: false,
      });
    }

    let pushed = false;
    for (let p = 0; p < passes; p++) {
      const dr = render3d.draws[p];
      dr.pipeline = ref.pipeline;
      dr.index = ref.index;
      dr.groups = ref.groups;
      dr.shadowGroups = ref.shadowGroups ?? null;
      dr.shadowIndex = ref.shadowIndex ?? 0;
      dr.bounds = render3d.bounds;
      if (renderQueue.draws.indexOf(dr) === -1) {
        renderQueue.draws.push(dr);
      }
      pushed = true;
    }
    return pushed;
  }

  /* ── 8. Clock Step & Per-Frame Hook ───────────────────────────────────────── */
  let hookedApp = null;
  const rcHook = {
    rc: null,
    origUpdate: null,
    calledOnce: false,
    lastStepMs: 0,
  };

  function uninstallRcHook() {
    if (rcHook.rc && rcHook.origUpdate && rcHook.rc.update !== rcHook.origUpdate) {
      try { rcHook.rc.update = rcHook.origUpdate; } catch {}
    }
    rcHook.rc = null;
    rcHook.origUpdate = null;
    rcHook.calledOnce = false;
    rcHook.lastStepMs = 0;
  }

  function installRcHook(app) {
    const rc = app && (app.riderController || app.rideController);
    if (!rc || typeof rc.update !== 'function') return false;
    if (rcHook.rc === rc) return true;
    uninstallRcHook();

    const origUpdate = rc.update;
    rcHook.rc = rc;
    rcHook.origUpdate = origUpdate;
    rc.update = function (dt, opts) {
      const res = origUpdate.call(this, dt, opts);
      try {
        if (!cleaned) {
          const stepDt = (typeof dt === 'number' && Number.isFinite(dt)) ? clamp(dt, 0, 0.5) : 0;
          rcHook.calledOnce = true;
          rcHook.lastStepMs = performance.now();
          const pose = stepGhostState(stepDt);
          race.lastPose = pose;
          if (pose && S.show3dModel && S.avatarStyle !== 'simple') {
            if (ensureGhostAvatar(pose)) {
              updateGhostAvatar(pose, stepDt);
            } else {
              destroyGhostAvatar();
            }
          } else {
            destroyGhostAvatar();
          }
        }
      } catch {}
      return res;
    };
    return true;
  }

  function stepGhostState(dtOverride) {
    const now = performance.now();
    const dt = (typeof dtOverride === 'number' && Number.isFinite(dtOverride))
      ? clamp(dtOverride, 0, 2.0)
      : (race.lastStepMs > 0 ? clamp((now - race.lastStepMs) / 1000, 0, 2.0) : 0);
    race.lastStepMs = now;

    const resolved = resolveRoute();
    if (resolved) {
      const curDist = findFocalDistance(resolved.route, resolved.focal, resolved.prev);
      if (race.prevEgoRoadDist !== null) {
        let dStep = curDist - race.prevEgoRoadDist;
        if (resolved.route.isLoop) {
          const half = resolved.route.totalLen * 0.5;
          if (dStep < -half) dStep += resolved.route.totalLen;
          else if (dStep > half) dStep -= resolved.route.totalLen;
        }
        if (race.started) race.egoCoveredM += dStep;
      }
      race.prevEgoRoadDist = curDist;
      race.egoRoadDist = curDist;

      const simSpd = finite(resolved.focal && resolved.focal.sim && resolved.focal.sim.speed);
      if (simSpd !== null) race.egoSpeedMps = simSpd;
    }

    if (!activeTrack) return null;

    if (!race.started && S.autoStart && race.egoSpeedMps > 0.6) {
      race.started = true;
      race.paused = false;
      race.egoCoveredM = race.egoRoadDist !== null ? Math.max(0, race.egoRoadDist - race.startOffsetM) : 0;
      race.statusNote = 'Racing';
    }

    if (race.started && !race.paused) {
      const moving = race.egoSpeedMps > 0.35;
      if (!S.pauseWithMe || moving) {
        race.clockSec = Math.min(activeTrack.totalTimeS, race.clockSec + dt);
      }
    }

    const g = sampleGhostAtTime(activeTrack, race.clockSec);
    race.ghostSample = g;

    if (race.started) {
      race.distGapM = race.egoCoveredM - g.d;
      const ghostTimeForMe = ghostTimeAtDist(activeTrack, Math.max(0, race.egoCoveredM));
      race.timeGapSec = race.clockSec - ghostTimeForMe;
    } else {
      race.distGapM = null;
      race.timeGapSec = null;
    }

    if (!resolved) return null;

    const ghostRoadDist = race.startOffsetM + g.d;
    const sampled = sampleRouteAt(resolved.route, ghostRoadDist);
    const chordHalf = 4.0;
    const sBack = sampleRouteAt(resolved.route, ghostRoadDist - chordHalf);
    const sFwd = sampleRouteAt(resolved.route, ghostRoadDist + chordHalf);
    const h0 = Math.atan2(-sBack.tang.z, sBack.tang.x);
    const h1 = Math.atan2(-sFwd.tang.z, sFwd.tang.x);
    let dh = h1 - h0;
    if (dh > Math.PI) dh -= Math.PI * 2;
    else if (dh < -Math.PI) dh += Math.PI * 2;
    const chordLen = resolved.route.isLoop
      ? chordHalf * 2
      : Math.max(0.5, sFwd.distM - sBack.distM);
    const kappa = dh / chordLen;

    const latOff = clamp(Number(S.lateralOffsetM) || 0, -5, 5);
    return {
      wx: sampled.p.x + sampled.norm.x * latOff,
      wy: sampled.p.y,
      wz: sampled.p.z + sampled.norm.z * latOff,
      tang: sampled.tang,
      norm: sampled.norm,
      slope: sampled.slope,
      kappa,
      distM: sampled.distM,
      node: sampled.node,
      g,
    };
  }

  /* ── 7b. WebGPU Transparent + Tinted Ghost Compositor ─────────────────────── */
  const NOOP_PASS_ENCODER = Object.freeze({
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    setIndexBuffer() {},
    setViewport() {},
    setScissorRect() {},
    setBlendConstant() {},
    setStencilReference() {},
    beginOcclusionQuery() {},
    endOcclusionQuery() {},
    executeBundles() {},
    draw() {},
    drawIndexed() {},
    drawIndirect() {},
    drawIndexedIndirect() {},
    pushDebugGroup() {},
    popDebugGroup() {},
    insertDebugMarker() {},
    end() {},
  });

  const COMPOSITOR_WGSL = `
    struct GhostParams {
      opacity: f32,
      tint: f32,
      _pad0: f32,
      _pad1: f32,
    };
    @group(0) @binding(0) var bgTex: texture_2d<f32>;
    @group(0) @binding(1) var ghostTex: texture_2d<f32>;
    @group(0) @binding(2) var<uniform> params: GhostParams;

    @vertex
    fn vs(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
      var pos = array<vec2f, 3>(
        vec2f(-1.0, -1.0),
        vec2f(3.0, -1.0),
        vec2f(-1.0, 3.0)
      );
      return vec4f(pos[vid], 0.0, 1.0);
    }

    @fragment
    fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
      let coord = vec2i(pos.xy);
      let bg = textureLoad(bgTex, coord, 0);
      let gh = textureLoad(ghostTex, coord, 0);
      if (gh.a <= 0.004) {
        return vec4f(bg.rgb, 1.0);
      }
      let rawRgb = clamp(gh.rgb / max(gh.a, 0.004), vec3f(0.0), vec3f(1.0));
      let cyan = vec3f(0.45, 0.90, 1.0);
      let tinted = mix(rawRgb, cyan, params.tint);
      let alpha = clamp(params.opacity * gh.a, 0.0, 1.0);
      return vec4f(mix(bg.rgb, tinted, alpha), 1.0);
    }
  `;

  const compositor = {
    disabled: false,
    eng: null,
    origRender: null,
    gpu: null,
    bgl: null,
    pipeline: null,
    pipelineFormat: null,
    paramBuf: null,
    paramData: new Float32Array(4),
    bgTex: null,
    bgView: null,
    ghostTex: null,
    ghostView: null,
    bindGroup: null,
    w: 0,
    h: 0,
    texFormat: null,
    loggedActive: false,
  };

  function destroyCompositorTextures() {
    try { compositor.bgTex?.destroy?.(); } catch {}
    try { compositor.ghostTex?.destroy?.(); } catch {}
    compositor.bgTex = null;
    compositor.bgView = null;
    compositor.ghostTex = null;
    compositor.ghostView = null;
    compositor.bindGroup = null;
    compositor.w = 0;
    compositor.h = 0;
    compositor.texFormat = null;
  }

  function destroyCompositor() {
    if (compositor.eng && compositor.origRender && compositor.eng.render !== compositor.origRender) {
      try { compositor.eng.render = compositor.origRender; } catch {}
    }
    destroyCompositorTextures();
    try { compositor.paramBuf?.destroy?.(); } catch {}
    compositor.paramBuf = null;
    compositor.pipeline = null;
    compositor.pipelineFormat = null;
    compositor.bgl = null;
    compositor.gpu = null;
    compositor.eng = null;
    compositor.origRender = null;
  }

  function initCompositor(gpu, format) {
    if (typeof GPUShaderStage === 'undefined' || typeof GPUTextureUsage === 'undefined' ||
        typeof GPUBufferUsage === 'undefined') {
      compositor.disabled = true;
      return false;
    }
    if (compositor.gpu !== gpu) {
      destroyCompositorTextures();
      try { compositor.paramBuf?.destroy?.(); } catch {}
      compositor.gpu = gpu;
      compositor.bgl = gpu.createBindGroupLayout({
        label: 'terra_ghost_bgl',
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      compositor.paramBuf = gpu.createBuffer({
        label: 'terra_ghost_params',
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      compositor.pipeline = null;
      compositor.pipelineFormat = null;
    }

    if (!compositor.pipeline || compositor.pipelineFormat !== format) {
      const module = gpu.createShaderModule({ label: 'terra_ghost_shader', code: COMPOSITOR_WGSL });
      compositor.pipeline = gpu.createRenderPipeline({
        label: 'terra_ghost_pipe',
        layout: gpu.createPipelineLayout({ bindGroupLayouts: [compositor.bgl] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      compositor.pipelineFormat = format;
    }
    return true;
  }

  function ensureCompositorTextures(gpu, w, h, format) {
    if (compositor.bgTex && compositor.w === w && compositor.h === h &&
        compositor.texFormat === format && compositor.bindGroup) {
      return true;
    }
    destroyCompositorTextures();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    compositor.bgTex = gpu.createTexture({ label: 'terra_ghost_bg', size: [w, h, 1], format, usage });
    compositor.ghostTex = gpu.createTexture({ label: 'terra_ghost_fg', size: [w, h, 1], format, usage });
    compositor.bgView = compositor.bgTex.createView();
    compositor.ghostView = compositor.ghostTex.createView();
    compositor.bindGroup = gpu.createBindGroup({
      label: 'terra_ghost_bg_group',
      layout: compositor.bgl,
      entries: [
        { binding: 0, resource: compositor.bgView },
        { binding: 1, resource: compositor.ghostView },
        { binding: 2, resource: { buffer: compositor.paramBuf } },
      ],
    });
    compositor.w = w;
    compositor.h = h;
    compositor.texFormat = format;
    return true;
  }

  function boundsDistXZ(b, sim, ox, oz) {
    if (!sim) return Infinity;
    const cx = (b[0] + b[3]) * 0.5;
    const cy = (b[1] + b[4]) * 0.5;
    const cz = (b[2] + b[5]) * 0.5;
    let best = Infinity;
    const p1 = sim.position;
    if (p1 && Math.abs(cy - p1.y) < 2.5) {
      const d = Math.hypot(cx - (p1.x - ox), cz - (p1.z - oz));
      if (d < best) best = d;
    }
    const p2 = sim.midPosition;
    if (p2 && Math.abs(cy - p2.y) < 2.5) {
      const d = Math.hypot(cx - (p2.x - ox), cz - (p2.z - oz));
      if (d < best) best = d;
    }
    return best;
  }

  function findGhostDrawSet(draws, fs) {
    if (!Array.isArray(draws) || draws.length === 0 || !ghostAvatar.sim) return null;
    const bt = window.btApp;
    const rc = ghostAvatar.rc || (bt && (bt.riderController || bt.rideController));
    const gSim = ghostAvatar.sim;
    const others = [];
    if (rc) {
      if (rc.ego && rc.ego.sim && rc.ego.sim !== gSim) others.push(rc.ego.sim);
      if (rc.focalRider && rc.focalRider !== rc.ego && rc.focalRider.sim && rc.focalRider.sim !== gSim) {
        others.push(rc.focalRider.sim);
      }
      if (Array.isArray(rc.riders)) {
        for (const r of rc.riders) {
          if (r && !r._isTerraGhost && r.sim && r.sim !== gSim) others.push(r.sim);
        }
      }
    }

    const oxRaw = (fs && fs.origin && Number.isFinite(fs.origin[0])) ? fs.origin[0] : 0;
    const ozRaw = (fs && fs.origin && Number.isFinite(fs.origin[1])) ? fs.origin[1] : 0;

    // Detect whether draw.bounds are world-space or origin-relative
    let ox = 0;
    let oz = 0;
    if (oxRaw !== 0 || ozRaw !== 0) {
      let worldHits = 0;
      let relHits = 0;
      for (let i = 0; i < draws.length; i++) {
        const d = draws[i];
        if (!d || (d.pipeline !== 'skinned' && d.pipeline !== 'spoke') || !d.bounds || d.bounds.length < 6) continue;
        if (boundsDistXZ(d.bounds, gSim, 0, 0) < 0.85) worldHits++;
        if (boundsDistXZ(d.bounds, gSim, oxRaw, ozRaw) < 0.85) relHits++;
      }
      if (relHits > worldHits) { ox = oxRaw; oz = ozRaw; }
    }

    const definite = new Set();
    const tiedSkinned = [];
    const tiedSpoke = [];

    for (let i = 0; i < draws.length; i++) {
      const d = draws[i];
      if (!d || (d.pipeline !== 'skinned' && d.pipeline !== 'spoke') || !d.bounds || d.bounds.length < 6) continue;
      const dGhost = boundsDistXZ(d.bounds, gSim, ox, oz);
      if (!(dGhost < 0.85)) continue;

      let dOther = Infinity;
      for (let j = 0; j < others.length; j++) {
        const dist = boundsDistXZ(d.bounds, others[j], ox, oz);
        if (dist < dOther) dOther = dist;
      }

      if (dGhost < dOther - 0.02) {
        definite.add(d);
      } else if (Math.abs(dGhost - dOther) <= 0.02) {
        if (d.pipeline === 'skinned') tiedSkinned.push(d);
        else tiedSpoke.push(d);
      }
    }

    if (definite.size === 0 && (tiedSkinned.length > 0 || tiedSpoke.length > 0)) {
      // Ghost is registered after ego/bots, so its draws appear last in a tie
      for (let i = Math.max(0, tiedSkinned.length - 2); i < tiedSkinned.length; i++) {
        definite.add(tiedSkinned[i]);
      }
      if (tiedSpoke.length > 0) definite.add(tiedSpoke[tiedSpoke.length - 1]);
    }

    return definite.size > 0 ? definite : null;
  }

  function installCompositor(env) {
    const eng = env && env.engine;
    if (!eng || typeof eng.render !== 'function' || compositor.disabled) return;
    if (compositor.eng === eng) return;

    if (compositor.eng && compositor.eng !== eng) {
      destroyCompositor();
    }

    const origRender = eng.render;
    compositor.eng = eng;
    compositor.origRender = origRender;

    eng.render = function (fs, rq) {
      if (cleaned || compositor.disabled || !S.show3dModel || S.avatarStyle === 'simple' || !ghostAvatar.rider) {
        return origRender.call(this, fs, rq);
      }

      const opacity = clamp(S.ghostOpacity ?? 55, 15, 100) / 100;
      const tint = clamp(S.ghostTint ?? 20, 0, 100) / 100;
      if (opacity >= 0.995 && tint <= 0.005) {
        render3d.diagShort = S.avatarStyle === 'exact' ? 'Avatar (copy)' : 'Avatar (ghost)';
        return origRender.call(this, fs, rq);
      }

      const draws = rq && Array.isArray(rq.draws) ? rq.draws : null;
      const ghostSet = draws ? findGhostDrawSet(draws, fs) : null;
      if (!ghostSet) {
        return origRender.call(this, fs, rq);
      }

      const dev = this.device;
      const gpu = dev && dev.gpu;
      const ctx = dev && dev.context;
      if (!gpu || !ctx || typeof gpu.createCommandEncoder !== 'function' || typeof ctx.getCurrentTexture !== 'function') {
        compositor.disabled = true;
        return origRender.call(this, fs, rq);
      }

      let swapTex;
      let swapView;
      try {
        swapTex = ctx.getCurrentTexture();
        if (!swapTex || !swapTex.width || !swapTex.height) {
          return origRender.call(this, fs, rq);
        }
        swapView = swapTex.createView();
      } catch {
        return origRender.call(this, fs, rq);
      }

      const format = swapTex.format || dev.format || 'bgra8unorm';
      const rawCreateEncoder = gpu.createCommandEncoder;
      const rawSubmit = gpu.queue && gpu.queue.submit;
      if (typeof rawCreateEncoder !== 'function' || typeof rawSubmit !== 'function') {
        compositor.disabled = true;
        return origRender.call(this, fs, rq);
      }

      try {
        if (!initCompositor(gpu, format)) {
          return origRender.call(this, fs, rq);
        }
        ensureCompositorTextures(gpu, swapTex.width, swapTex.height, format);

        compositor.paramData[0] = opacity;
        compositor.paramData[1] = tint;
        compositor.paramData[2] = 0;
        compositor.paramData[3] = 0;
        gpu.queue.writeBuffer(compositor.paramBuf, 0, compositor.paramData);

        const worldDraws = [];
        const ghostDraws = [];
        for (let i = 0; i < draws.length; i++) {
          const d = draws[i];
          if (ghostSet.has(d)) {
            ghostDraws.push({ ...d, castsShadow: false, shadowOnly: false });
          } else {
            worldDraws.push(d);
          }
        }

        const worldRq = { ...rq, draws: worldDraws };
        const ghostRq = { ...rq, compute: [], draws: ghostDraws };

        // Pass 1: Render world without ghost -> bgView, keeping scene_depth intact
        gpu.createCommandEncoder = function (...args) {
          const enc = rawCreateEncoder.apply(gpu, args);
          const origBegin = enc.beginRenderPass.bind(enc);
          enc.beginRenderPass = function (desc) {
            if (desc && Array.isArray(desc.colorAttachments) && desc.colorAttachments.length > 0) {
              const nextColor = desc.colorAttachments.map((att) => {
                if (!att) return att;
                const copy = { ...att };
                if (copy.resolveTarget) copy.resolveTarget = compositor.bgView;
                else copy.view = compositor.bgView;
                return copy;
              });
              const nextDesc = { ...desc, colorAttachments: nextColor };
              if (desc.depthStencilAttachment) {
                nextDesc.depthStencilAttachment = {
                  ...desc.depthStencilAttachment,
                  depthStoreOp: 'store',
                };
              }
              return origBegin(nextDesc);
            }
            return origBegin(desc);
          };
          return enc;
        };

        try {
          origRender.call(this, fs, worldRq);
        } finally {
          gpu.createCommandEncoder = rawCreateEncoder;
        }

        const worldDrawCount = this.drawCount;
        const worldTriCount = this.triangleCount;

        // Pass 2: Render ghost only -> ghostView, depth-tested against Pass 1's scene_depth
        gpu.createCommandEncoder = function (...args) {
          const enc = rawCreateEncoder.apply(gpu, args);
          const origBegin = enc.beginRenderPass.bind(enc);
          enc.beginRenderPass = function (desc) {
            if (!desc || !Array.isArray(desc.colorAttachments) || desc.colorAttachments.length === 0) {
              return NOOP_PASS_ENCODER;
            }
            const nextColor = desc.colorAttachments.map((att) => {
              if (!att) return att;
              const copy = { ...att };
              if (copy.resolveTarget) copy.resolveTarget = compositor.ghostView;
              else copy.view = compositor.ghostView;
              if (copy.loadOp === 'clear') {
                copy.clearValue = { r: 0, g: 0, b: 0, a: 0 };
              }
              return copy;
            });
            const nextDesc = { ...desc, colorAttachments: nextColor };
            if (desc.depthStencilAttachment) {
              nextDesc.depthStencilAttachment = {
                ...desc.depthStencilAttachment,
                depthLoadOp: desc.depthStencilAttachment.depthLoadOp === 'clear'
                  ? 'load'
                  : desc.depthStencilAttachment.depthLoadOp,
              };
            }
            return origBegin(nextDesc);
          };
          return enc;
        };

        try {
          origRender.call(this, fs, ghostRq);
        } finally {
          gpu.createCommandEncoder = rawCreateEncoder;
        }

        // Step 3: Fullscreen composite bgTex + tinted ghostTex -> swapView
        const enc3 = rawCreateEncoder.call(gpu, { label: 'terra_ghost_composite' });
        const pass3 = enc3.beginRenderPass({
          colorAttachments: [{
            view: swapView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
          }],
        });
        pass3.setPipeline(compositor.pipeline);
        pass3.setBindGroup(0, compositor.bindGroup);
        pass3.draw(3);
        pass3.end();
        rawSubmit.call(gpu.queue, [enc3.finish()]);

        this.drawCount = worldDrawCount + ghostDraws.length + 1;
        this.triangleCount = worldTriCount;
        render3d.diagShort = 'Avatar (ghost)';
        if (!compositor.loggedActive) {
          compositor.loggedActive = true;
          log(`WebGPU ghost compositor active (${swapTex.width}x${swapTex.height} ${format}, opacity=${Math.round(opacity * 100)}%, tint=${Math.round(tint * 100)}%)`);
        }
      } catch (e) {
        gpu.createCommandEncoder = rawCreateEncoder;
        compositor.disabled = true;
        render3d.diagShort = 'Avatar (opaque)';
        log('WebGPU ghost compositor disabled after error: ' + e);
        return origRender.call(this, fs, rq);
      }
    };
  }

  function installFeature(app) {
    hookedApp = app;
    installRcHook(app);
    unhookFeature = app.addFeature((scope, env) => ({
      frame(frameState, renderQueue) {
        try {
          if (cleaned) return;
          installCompositor(env);
          installRcHook(app);
          const curRc = app && (app.riderController || app.rideController);
          const rcDriven = !!(curRc && rcHook.rc === curRc && rcHook.calledOnce);
          const pose = rcDriven ? (race.lastPose || stepGhostState(0)) : stepGhostState();
          if (!pose || !frameState || !frameState.camera || !frameState.camera.viewProj || !frameState.origin) {
            destroyGhostAvatar();
            plateEl.style.display = 'none';
            dot2dEl.style.display = 'none';
            return;
          }

          let drew3d = false;
          if (S.show3dModel) {
            if (rcDriven && ghostAvatar.rider && ghostAvatar.rc === curRc && ghostAvatar.style === (S.avatarStyle || 'exact')) {
              drew3d = true;
            } else if (ensureGhostAvatar(pose)) {
              if (!rcDriven) updateGhostAvatar(pose);
              drew3d = true;
            } else {
              destroyGhostAvatar();
              if (!render3d.disabled && init3DMesh(scope, env)) {
                uploadGhostPose(pose);
                drew3d = pushGhostDraws(renderQueue);
              }
            }
          } else {
            destroyGhostAvatar();
          }

          // Project ghost nameplate + 2D fallback marker via camera viewProj
          const vp = frameState.camera.viewProj;
          const ox = frameState.origin[0] || 0;
          const oz = frameState.origin[1] || 0;
          const W = window.innerWidth || 1;
          const H = window.innerHeight || 1;

          if (S.showNameplate) {
            const rx = pose.wx - ox;
            const ry = pose.wy + 2.15;
            const rz = pose.wz - oz;
            const w = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];
            if (w > 0.15 && Number.isFinite(w)) {
              const iw = 1 / w;
              const nx = (vp[0] * rx + vp[4] * ry + vp[8] * rz + vp[12]) * iw;
              const ny = (vp[1] * rx + vp[5] * ry + vp[9] * rz + vp[13]) * iw;
              if (Number.isFinite(nx) && Number.isFinite(ny) && Math.abs(nx) <= 1.1 && Math.abs(ny) <= 1.1) {
                const sx = (nx * 0.5 + 0.5) * W;
                const sy = (1 - (ny * 0.5 + 0.5)) * H;
                const sc = clamp(10 / Math.max(10, w), 0.55, 1.0);
                const gapTxt = race.timeGapSec === null
                  ? ''
                  : ` · ${race.timeGapSec > 0.05 ? '+' : (race.timeGapSec < -0.05 ? '-' : '')}${Math.abs(race.timeGapSec).toFixed(1)}s`;
                const pwrTxt = pose.g.p > 0 ? ` · ${pose.g.p}W` : '';
                const label = `👻 Ghost${pwrTxt}${gapTxt}`;
                if (plateEl.textContent !== label) plateEl.textContent = label;
                plateEl.style.display = 'block';
                plateEl.style.transform =
                  `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) translate(-50%,-100%) scale(${sc.toFixed(3)})`;
              } else {
                plateEl.style.display = 'none';
              }
            } else {
              plateEl.style.display = 'none';
            }
          } else {
            plateEl.style.display = 'none';
          }

          // Subtle 2D body marker only when 3D geometry isn't active
          if (!drew3d) {
            const rx = pose.wx - ox;
            const ry = pose.wy + 1.05;
            const rz = pose.wz - oz;
            const w = vp[3] * rx + vp[7] * ry + vp[11] * rz + vp[15];
            if (w > 0.15 && Number.isFinite(w)) {
              const iw = 1 / w;
              const nx = (vp[0] * rx + vp[4] * ry + vp[8] * rz + vp[12]) * iw;
              const ny = (vp[1] * rx + vp[5] * ry + vp[9] * rz + vp[13]) * iw;
              if (Math.abs(nx) <= 1.05 && Math.abs(ny) <= 1.05) {
                const sx = (nx * 0.5 + 0.5) * W;
                const sy = (1 - (ny * 0.5 + 0.5)) * H;
                const sc = clamp(14 / Math.max(10, w), 0.45, 1.35);
                dot2dEl.style.display = 'block';
                dot2dEl.style.transform =
                  `translate3d(${sx.toFixed(1)}px,${sy.toFixed(1)}px,0) translate(-50%,-50%) scale(${sc.toFixed(3)})`;
              } else {
                dot2dEl.style.display = 'none';
              }
            } else {
              dot2dEl.style.display = 'none';
            }
          } else {
            dot2dEl.style.display = 'none';
          }
        } catch {
          /* Never throw inside Biketerra's frame ticker */
        }
      },
    }));
  }

  /* ── 9. Ride Broadcast Hook & Lifecycle ───────────────────────────────────── */
  try {
    unhookRide = terra.ride.onRide((frame) => {
      if (!frame || !frame.ego) return;
      const e = frame.ego;
      if (finite(e.speed) !== null) race.egoSpeedMps = finite(e.speed);
      if (finite(e.power) !== null) race.egoPowerW = finite(e.power);
      if (finite(e.lat) !== null && finite(e.lng) !== null) {
        race.egoLat = finite(e.lat);
        race.egoLng = finite(e.lng);
      }
    });
  } catch {}

  if (terra.settings && terra.settings.onChange) {
    terra.settings.onChange(async () => {
      try {
        const prevStyle = S.avatarStyle;
        const prevShow = S.show3dModel;
        S = { ...DEFAULTS, ...(await terra.settings.all()) };
        applyHudOpacity();
        if (!S.show3dModel || S.avatarStyle !== prevStyle || S.show3dModel !== prevShow) {
          destroyGhostAvatar();
        }
      } catch {}
    });
  }

  if (terra.settings && terra.settings.preview) {
    terra.settings.preview((slot) => {
      if (!slot) return;
      const pv = document.createElement('div');
      pv.className = 'tr-gr-card';
      pv.style.position = 'relative';
      pv.style.top = '0';
      pv.style.left = '0';
      pv.style.background = `rgba(15, 23, 42, ${(clamp(S.hudOpacity, 30, 100) / 100).toFixed(2)})`;
      pv.innerHTML = `
        <div class="tr-gr-head" style="cursor:default">
          <span class="tr-gr-badge">GHOST</span>
          <span class="tr-gr-title">Alpe d'Huez PR</span>
        </div>
        <div class="tr-gr-body">
          <div class="tr-gr-gap-row">
            <div class="tr-gr-gap-time ahead">-4.2s</div>
            <div class="tr-gr-gap-dist">34m ahead</div>
          </div>
          <div class="tr-gr-bar-wrap">
            <div class="tr-gr-bar-fill" style="width:52%"></div>
            <div class="tr-gr-dot ghost" style="left:52%"></div>
            <div class="tr-gr-dot ego" style="left:54%"></div>
          </div>
          <div class="tr-gr-stats">
            <div class="tr-gr-stat"><div class="tr-gr-stat-l">Ghost W</div><div class="tr-gr-stat-v">312 W</div></div>
            <div class="tr-gr-stat"><div class="tr-gr-stat-l">Ghost Spd</div><div class="tr-gr-stat-v">24.8</div></div>
            <div class="tr-gr-stat"><div class="tr-gr-stat-l">Ghost km</div><div class="tr-gr-stat-v">6.40</div></div>
          </div>
        </div>
      `;
      slot.appendChild(pv);
    });
  }

  await loadPersisted();
  if (activeTrack) race.ghostSample = sampleGhostAtTime(activeTrack, 0);
  renderHud();

  timer = setInterval(() => {
    if (cleaned) return;
    if (window.btApp && typeof window.btApp.addFeature === 'function' && (!unhookFeature || hookedApp !== window.btApp)) {
      if (unhookFeature) { try { unhookFeature(); } catch {} unhookFeature = null; }
      render3d.handle = null;
      render3d.draws.length = 0;
      render3d.disabled = false;
      installFeature(window.btApp);
      log('installed into btApp render loop');
    }
    if ((!unhookFeature || !rcHook.calledOnce) && (performance.now() - race.lastStepMs) > 260) {
      stepGhostState();
    }
    renderHud();
  }, 250);

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearInterval(timer);
    uninstallRcHook();
    destroyGhostAvatar();
    destroyCompositor();
    if (unhookFeature) { try { unhookFeature(); } catch {} unhookFeature = null; }
    hookedApp = null;
    if (unhookRide) { try { unhookRide(); } catch {} unhookRide = null; }
    if (ov.parentNode) ov.remove();
    if (card.parentNode) card.remove();
    try { delete window.__terraGhostCleanup; } catch {}
    log('cleaned up');
  }

  window.__terraGhostCleanup = cleanup;
  if (typeof terra.onCleanup === 'function') terra.onCleanup(cleanup);
  if (typeof terra.onNavigate === 'function') {
    terra.onNavigate(() => {
      uninstallRcHook();
      destroyGhostAvatar();
      ghostAvatar.disabled = false;
      compositor.disabled = false;
      cachedRoute = null;
      race.lastPose = null;
      race.prevEgoRoadDist = null;
      render3d.handle = null;
      render3d.draws.length = 0;
    });
  }

  log('ghost-rider ready');
})();
