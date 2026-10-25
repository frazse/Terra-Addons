// Karoo Bridge: streams live Biketerra ride telemetry over UDP to a Hammerhead Karoo.
// The companion app (karoo-apk) receives the datagrams and injects them as mock GPS.
(async (terra) => {
  terra.log('KAROO BRIDGE loaded');

  // --- current gear state (from the realistic-gears addon) ---
  let gears = null; // { fd, fdMax, fdTeeth, rd, rdMax, rdTeeth, ratio }
  terra.bus.on('realistic-gears:changed', (g) => {
    if (!g) return;
    gears = {
      fd: g.frontIndex,
      fdMax: g.frontTotal,
      fdTeeth: g.frontTeeth,
      rd: g.rearIndex,
      rdMax: g.rearTotal,
      rdTeeth: g.rearTeeth,
      ratio: Number(g.ratio || 0)
    };
  });

  // --- coordinate/numeric helpers ---
  const FIT_DIV = 11930464.71; // FIT "semicircles"/"scale-by-4" encoding -> degrees

  // Elevation calibration (m). The Karoo's altitude display can sit above or
  // below the game's elevation (geoid / mean-sea-level correction on the
  // device). To make them match, the user enters (game − Karoo) in the
  // `alt_offset` setting; we apply it here to the shipped altitude.
  // Read via the settings API: `{{setting:...}}` placeholders are only expanded by
  // Rust in the terra.http / terra.udp request paths — in page code they stay
  // literal (a Number() of that string is NaN), so the settings API is the way.
  const ALT_OFFSET_M = Number(await terra.settings.get('alt_offset')) || 0;

  const num = (v) => {
    // 'missing' (null/undefined) must stay missing — Number(null) === 0 would
    // fabricate a fake 0 reading for a value that was never reported.
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const normCoord = (v) => {
    const n = num(v);
    if (n == null) return null;
    // Values with |v| > 180 cannot be degrees on Earth -> assume FIT-encoded.
    return Math.abs(n) > 180 ? n / FIT_DIV : n;
  };

  const haversineMeters = (lat1, lng1, lat2, lng2) => {
    const R = 6371000, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLng = (lng2 - lng1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  };

  const forwardAzimuthDeg = (lat1, lng1, lat2, lng2) => {
    const toRad = Math.PI / 180;
    const y = Math.sin((lng2 - lng1) * toRad) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
      Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lng2 - lng1) * toRad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };

  // --- Biketerra's native ride broadcast channel ---
  const ch = new BroadcastChannel('biketerra-ride');
  let prevPoint = null; // last confirmed {lat, lng}
  let bearing = 0;      // degrees true, updated only while actually moving
  let lastTx = 0;       // last UDP send (throttle to ~4 Hz)
  let txErrors = 0;     // log the first failure, stay quiet until a send succeeds again
  let firstFrameLogged = false;
  let frameCount = 0;        // telemetry frames seen since load
  let dbgCaptured = false;   // true once the first riding frame is logged + persisted
  let lastDbgAt = 0;         // throttle for the continuous dbg_latest snapshot
  let lastHbFrame = -15;     // heartbeat every ~15 frames

  // --- feed-quality diagnostics (v3.3) --------------------------------------
  // The 10-24 Karoo FIT proved the broadcast's instantaneous speed/cadence
  // were dead while the ride state was live (game distance accumulated).
  // Per-field present/non-zero counters + first-non-zero timestamps settle,
  // from the outside, exactly which fields the feed carries:
  // ~/.local/share/terra/addon-data/karoo-bridge.json after the ride.
  const fieldStats = {};
  for (const k of ['power', 'cadence', 'hr', 'speedFeed', 'speedOut', 'cadenceOut']) {
    fieldStats[k] = { present: 0, nonZero: 0, firstNonZero: null };
  }
  const bump = (k, v) => {
    const st = fieldStats[k];
    if (!st || v == null) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    st.present++;
    if (n > 0) {
      st.nonZero++;
      if (!st.firstNonZero) {
        st.firstNonZero = { frame: frameCount, value: n, at: new Date().toISOString() };
        terra.log(`KAROO dbg: first non-zero ${k} = ${n} @ frame ${frameCount}`);
      }
    }
  };
  const ring = []; // last ~20 samples: raw feed vs what we actually ship
  let lastDist = null, lastDistAt = 0;              // Δdistance/Δt speed derivation
  const WHEEL_RADIUS_M = 0.339;                     // 700 x 28c ≈ 678 mm outer diameter

  ch.onmessage = (e) => {
    const data = e && e.data;
    if (!data || typeof data !== 'object') return;
    frameCount++;

    const egoRaw = (data.ego && typeof data.ego === 'object') ? data.ego : null;
    const rider0 = (Array.isArray(data.riders) && data.riders[0] && typeof data.riders[0] === 'object') ? data.riders[0] : null;

    if (!firstFrameLogged) {
      firstFrameLogged = true;
      terra.log('first bike-terra frame keys: ' + JSON.stringify(Object.keys(data)));
      terra.log('ego keys: ' + JSON.stringify(egoRaw ? Object.keys(egoRaw) : []));
      terra.log('rider[0] keys: ' + JSON.stringify(rider0 ? Object.keys(rider0) : []));
    }

    // One-shot diagnostic: capture the first *riding* frame (any non-zero
    // power/cadence/heart-rate/speed), falling back to the 8th frame, and persist the
    // raw values so the exact field names/values can be inspected from
    // ~/.local/share/terra/addon-data/karoo-bridge.json without
    // needing Terra's DevTools console.
    if (!dbgCaptured) {
      const anyRiding = [egoRaw, rider0].some((o) => o &&
        [o.power, o.watts, o.wattage, o.cadence, o.cad, o.rpm, o.heartRate, o.hr, o.bpm, o.speed, o.vel]
          .some((v) => (Number(v) || 0) > 0));
      if (anyRiding || frameCount >= 8) {
        dbgCaptured = true;
        const g = (o, k) => (o ? (k in o ? o[k] : '∅missing') : '∅no-obj');
        const tag = 'frame#' + frameCount + (anyRiding ? ' (riding)' : ' (fallback)');
        terra.log('KAROO dbg ' + tag + ' ego  -> cadence=' + g(egoRaw, 'cadence') + ' speed=' + g(egoRaw, 'speed') + ' power=' + g(egoRaw, 'power') + ' heartRate=' + g(egoRaw, 'heartRate'));
        if (rider0) terra.log('KAROO dbg ' + tag + ' rider0 -> cadence=' + g(rider0, 'cadence') + ' speed=' + g(rider0, 'speed') + ' power=' + g(rider0, 'power') + ' heartRate=' + g(rider0, 'heartRate'));
        try { terra.storage.set('dbg_first_frame', { at: new Date().toISOString(), frameCount, riding: !!anyRiding, rawEgo: egoRaw, rawRider0: rider0 }); }
        catch (eErr) { terra.log('KAROO dbg: storage.set failed: ' + eErr); }
      }
    }

    // Normalized view: the nested `ego` object if present, otherwise the flat frame.
    const s = data.ego && typeof data.ego === 'object' ? data.ego : data;

    const lat = normCoord(s.lat ?? s.latitude);
    const lng = normCoord(s.lng ?? s.lon ?? s.longitude);
    let alt = num(s.alt ?? s.altitude ?? s.elevation);
    if (alt != null && ALT_OFFSET_M !== 0) alt = Math.round((alt + ALT_OFFSET_M) * 10) / 10;

    const grade = num(s.grade ?? s.gradePct);
    const rawPower = num(s.power ?? s.watts ?? s.wattage);
    const rawCadence = num(s.cadence ?? s.cad ?? s.rpm ?? s.cadenceRpm);
    const rawHr = num(s.hr ?? s.heartRate ?? s.bpm);
    const rawSpeed = num(s.speedMs ?? s.speed ?? s.vel);
    const dist = num(s.dist ?? s.distance);

    // --- feed-gap fill (v3.3) ------------------------------------------------
    // Evidence from the 10-24 test ride (Karoo FIT): the broadcast carried
    // live power/HR but dead instantaneous speed/cadence (game distance still
    // accumulated, speedAvg/cadenceAvg were realistic). The Karoo records one
    // 0 m/s speed sample, zero cadence samples, and auto-paused the ride.
    // So: prefer an ALIVE feed reading (> 0), otherwise synthesize a
    // physically consistent one and tag the source for the diagnostics:
    //   speed   = Δdistance / Δtime        (game distance is reliable)
    //   cadence = wheel rpm ÷ gear ratio   (needs the gear state)
    let speed = rawSpeed;
    if (speed == null) {
      const kph = num(s.speedKph ?? s.speedKmh ?? s.speed_kmh);
      if (kph != null) speed = kph / 3.6;
    }
    if (speed != null && speed > 45) speed = speed / 3.6; // nobody rides >45 m/s; assume km/h
    let speedSrc = 'feed';
    if ((speed == null || speed <= 0) && dist != null && lastDist != null) {
      const dt = (Date.now() - lastDistAt) / 1000;
      const dd = dist - lastDist;
      if (dt >= 0.05 && dd >= 0 && dd / dt > 0 && dd / dt < 40) { // 40 m/s ≈ 144 km/h sanity cap
        speed = dd / dt;
        speedSrc = 'dist';
      }
    }
    if (dist != null) { lastDist = dist; lastDistAt = Date.now(); }

    let cadence = rawCadence;
    let cadenceSrc = 'feed';
    if ((cadence == null || cadence <= 0) && speed > 0 && gears && gears.ratio >= 0.5 && gears.ratio <= 10) {
      const c = ((speed / (2 * Math.PI * WHEEL_RADIUS_M)) * 60) / gears.ratio;
      if (c > 0 && c < 220) { cadence = c; cadenceSrc = `speed/gears(r=${gears.ratio})`; }
    }

    // Per-frame diagnostics: what the feed said vs what we actually ship.
    bump('power', rawPower);
    bump('cadence', rawCadence);
    bump('hr', rawHr);
    bump('speedFeed', rawSpeed);
    bump('speedOut', speed);
    bump('cadenceOut', cadence);
    ring.push({
      at: new Date().toISOString(),
      p: rawPower, hr: rawHr,
      spdF: rawSpeed, spdO: speed == null ? null : Math.round(speed * 100) / 100, spdSrc: speedSrc,
      cadF: rawCadence, cadO: cadence == null ? null : Math.round(cadence * 10) / 10, cadSrc: cadenceSrc,
      dist,
    });
    if (ring.length > 20) ring.shift();

    // True compass bearing from movement (Haversine distance + forward azimuth).
    // Ignore sub-0.25 m drift so we don't spin the needle when standing still.
    if (lat != null && lng != null) {
      if (prevPoint && haversineMeters(prevPoint.lat, prevPoint.lng, lat, lng) > 0.25) {
        bearing = forwardAzimuthDeg(prevPoint.lat, prevPoint.lng, lat, lng);
      }
      prevPoint = { lat, lng };
    }

    // Semantics: `null` = the field wasn't in the frame (Karoo side shows
    // nothing), `0` = a genuine reading (coasting, standing still, 0 W).
    // The companion app must treat these two distinctly.
    const packet = {
      ts: Date.now(),
      lat: lat,              // null → no GPS fix this frame
      lng: lng,
      alt: alt,
      speed: speed,          // m/s (Android Location expects m/s); 0 = stopped/coasting
      bearing: Math.round(bearing),
      grade: grade,
      power: rawPower,       // 0 W is real (coasting); null = no power sample
      cadence: cadence,      // rpm; 0 = standing still; null = missing AND no derivation
      hr: rawHr,
      dist: dist,
      gears: gears || { fd: 0, fdMax: 0, fdTeeth: 0, rd: 0, rdMax: 0, rdTeeth: 0, ratio: 0 }
    };

    // Also publish in-page (e.g. for the garmin-hud style local viewers).
    terra.bus.emit('biketerra:telemetry', packet);

    // Low-rate steady-state snapshot (≤1 per 5 s) + a periodic human-readable
    // heartbeat. After the ride, fieldStats (per-field present/non-zero +
    // first-non-zero) and the raw-vs-output ring in
    // ~/.local/share/terra/addon-data/karoo-bridge.json settle, from the
    // outside, exactly which fields the broadcast carried.
    const nowMs = Date.now();
    if (nowMs - lastDbgAt >= 5000) {
      lastDbgAt = nowMs;
      try {
        terra.storage.set('dbg_latest', {
          at: new Date().toISOString(),
          frameCount,
          rawEgo: egoRaw,
          rawRider0: rider0,
          fieldStats: JSON.parse(JSON.stringify(fieldStats)),
          ring: ring.slice(-20),
        });
      } catch { /* best effort */ }
      if (frameCount - lastHbFrame >= 15) {
        lastHbFrame = frameCount;
        const q = (o, k) => (o && k in o) ? o[k] : '-';
        const abbr = { power: 'p', cadence: 'c', hr: 'hr', speedFeed: 'sf', speedOut: 'so', cadenceOut: 'co' };
        const stats = Object.keys(fieldStats)
          .map((k) => `${abbr[k] || k}=${fieldStats[k].nonZero}/${fieldStats[k].present}`)
          .join(' ');
        terra.log(`KAROO heartbeat: feed p=${q(egoRaw, 'power')} cad=${q(egoRaw, 'cadence')} hr=${q(egoRaw, 'heartRate')} spd=${q(egoRaw, 'speed')}`
          + ` | out spd=${speed == null ? '-' : speed.toFixed(2)}(${speedSrc}) cad=${cadence == null ? '-' : cadence.toFixed(1)}(${cadenceSrc}) dist=${q(egoRaw, 'distance')}`
          + ` :: ${stats}`);
      }
    }

    // Throttle UDP to ~4 Hz (Karoo's map is fine with that).
    const now = Date.now();
    if (now - lastTx < 250) return;
    lastTx = now;

    terra.udp.send('{{setting:karoo_ip}}:{{setting:karoo_port}}', packet)
      .then(() => { txErrors = 0; })
      .catch((err) => {
        txErrors++;
        if (txErrors === 1) terra.log('UDP send failed (silent until a send succeeds again): ' + err);
      });
  };

  // --- Route ---------------------------------------------------------------
  // On a ride/spectate page the Biketerra route is a nested [lat,lng,alt] array
  // inside the Remix loader data (the page's `__data.json`). Extract it,
  // simplify it, encode it as a 5-digit polyline, and ship the encoded string
  // in ~3.4 KB datagrams. The companion app reassembles the pieces and draws
  // them as a map polyline (Karoo extension `startMap` hook).

  const TARGET = '{{setting:karoo_ip}}:{{setting:karoo_port}}';
  const ROUTE_CHUNK = 3400; // chars per datagram (app buffer is 4 KB incl. overhead)
  let routeTimer = null;

  // Canonical Google/Mapbox polyline (5-digit): each 6-bit chunk is written
  // as charCode = value + 63 — a contiguous run of ASCII `?`..`~` in which
  // digits never appear. (The old base64-alphabet output was rejected by the
  // Karoo's decoder — rideapp crashed inside its polyline parse.)
  function py2Round(v) {
    // Python 2 rounding: half away from zero (what the canonical impl uses).
    return Math.floor(Math.abs(v) + 0.5) * (v >= 0 ? 1 : -1);
  }
  function encVal(v) {
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v = v / 32; }
    return s + String.fromCharCode((v | 0) + 63);
  }

  // points: [[lat,lng],…], 5-digit canonical Google/Mapbox polyline (altitude dropped).
  function encodePolyline(points) {
    const F = 1e5;
    let s = '', pLat = 0, pLng = 0;
    for (const p of points) {
      const cLat = py2Round(p[0] * F), cLng = py2Round(p[1] * F);
      let dLat = (cLat - pLat) * 2; if (dLat < 0) dLat = -dLat - 1;
      let dLng = (cLng - pLng) * 2; if (dLng < 0) dLng = -dLng - 1;
      s += encVal(dLat) + encVal(dLng);
      pLat = cLat; pLng = cLng;
    }
    return s;
  }

  // Ramer–Douglas–Peucker over [lat,lng]; drops points within `tol` degrees
  // (~4 m) of the chord — visually identical on a bike-computer map.
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = 1; keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a][0], ay = pts[a][1];
      const dx = pts[b][0] - ax, dy = pts[b][1] - ay;
      const len2 = dx * dx + dy * dy;
      let maxD = -1, idx = -1;
      for (let i = a + 1; i < b; i++) {
        // Distance to the a→b chord; when the chord has (near) zero length — a
        // closed loop where start≈end — "distance to chord" is undefined, so
        // fall back to distance from the anchor point (else the whole loop
        // collapses to 2 points).
        const d = len2 > 1e-24
          ? Math.abs(dx * (pts[i][0] - ay) - dy * (pts[i][1] - ax)) / Math.sqrt(len2)
          : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  // Where does this page's route live? (same logic as the 3D routeview userscript)
  function routeDataUrl() {
    const { pathname, search } = location;
    if (pathname.startsWith('/spectate/')) {
      const id = pathname.split('/')[2];
      return id ? `https://biketerra.com/spectate/${id}/__data.json` : null;
    }
    if (pathname.startsWith('/ride')) {
      const p = new URLSearchParams(search);
      if (p.get('event')) return `https://biketerra.com/ride/__data.json?event=${p.get('event')}`;
      if (p.get('route')) return `https://biketerra.com/ride/__data.json?route=${p.get('route')}`;
    }
    return null;
  }

  function findRoutes(obj, out = []) {
    if (!obj) return out;
    if (Array.isArray(obj)) {
      if (obj.length > 0 && Array.isArray(obj[0]) && typeof obj[0][0] === 'number') out.push(obj);
      else obj.forEach((el) => findRoutes(el, out));
    } else if (typeof obj === 'string') {
      try { findRoutes(JSON.parse(obj), out); } catch { /* not JSON */ }
    } else if (typeof obj === 'object') Object.values(obj).forEach((v) => findRoutes(v, out));
    return out;
  }

  // --- Hammerhead route sync --------------------------------------------------
  // Pushes this route into the Hammerhead account through the dashboard's own
  // GPX import endpoint — it then shows up as a native route in the Hammerhead
  // app / on the Karoo, no manual browser import. Uploads once per unique route
  // signature per page load; the 2-minute route re-pushes must not re-upload.
  const hhUploaded = new Set();  // route signatures already uploaded this page load
  let hhSkipHintLogged = false;  // log the "settings missing" hint only once
  let routeShapeLogged = false;  // one-time log of the raw point-array shapes

  // --- Hammerhead JWT auto-auth ------------------------------------------------
  // Priority: 1) cached JWT  2) refresh-token grant  3) email/password grant  4) manual hh_token.
  // The password travels only inside {{setting:...}} placeholders, expanded Rust-side.

  // Decode a JWT payload segment — read-only (no signature verification).
  function decodeJwtPayload(jwt) {
    try {
      const seg = String(jwt).split('.')[1];
      if (!seg) return null;
      const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return null; }
  }

  // Persist a token-grant response: cache it for reuse and auto-fill the hh_user_id setting.
  async function saveHammerheadTokenResponse(data, prevRefreshToken) {
    const accessToken = String(data.access_token || data.token || '');
    const refreshToken = data.refresh_token || prevRefreshToken || null;
    const claims = accessToken ? decodeJwtPayload(accessToken) : null;
    const fallbackId = String((await terra.settings.get('hh_user_id')) || '').trim();
    const userId = (claims && (claims.sub || claims.user_id)) || data.user_id || fallbackId || '';
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = (claims && Number(claims.exp)) || Number(data.expires_at) || (nowSec + (Number(data.expires_in) || 3600));
    try {
      await terra.storage.set('hh_auth_cache', { accessToken, refreshToken: refreshToken || null, userId, expiresAt, savedAt: nowSec });
    } catch (e) { terra.log('HH auth: cache write failed: ' + e); }
    if (userId) {
      try { await terra.settings.set('hh_user_id', String(userId)); } catch { /* setting not declared */ }
    }
    terra.log('HH auth: JWT acquired (userId=' + (userId || 'unknown')
      + ', valid ~' + Math.max(0, Math.round((expiresAt - nowSec) / 60)) + ' min)');
    return { tokenHeader: 'Bearer ' + accessToken, userId };
  }

  async function postJwtGrant(body) {
    const res = await terra.http.request({
      method: 'POST',
      url: 'https://dashboard.hammerhead.io/v1/auth/token',
      headers: { 'Accept': 'application/json; charset=UTF-8', 'Content-Type': 'application/json' },
      body,
      timeoutMs: 15000,
    });
    let data = null;
    try { data = JSON.parse(res.body); } catch { /* non-JSON error body */ }
    return { status: res.status, data, body: res.body };
  }

  async function getValidHammerheadAuth(forceRefresh = false) {
    const nowSec = Math.floor(Date.now() / 1000);
    let cached = null;
    try { cached = await terra.storage.get('hh_auth_cache', null); } catch {}

    // 1) Cached token, while >2 min of validity remains.
    if (!forceRefresh && cached && cached.accessToken && cached.expiresAt > nowSec + 120) {
      const userId = cached.userId || String((await terra.settings.get('hh_user_id')) || '').trim();
      if (userId) return { tokenHeader: 'Bearer ' + cached.accessToken, userId };
    }

    // 2) Refresh-token grant (cached token first, else the pasted fallback setting).
    const cachedRT = cached && cached.refreshToken;
    if (cachedRT || (await terra.settings.has('hh_refresh_token'))) {
      try {
        const { status, data, body } = await postJwtGrant(JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: cachedRT || '{{setting:hh_refresh_token}}', // expanded Rust-side (never set into the page)
        }));
        if (status >= 200 && status < 300 && data && data.access_token) {
          return await saveHammerheadTokenResponse(data, cachedRT || null);
        }
        terra.log('HH auth: refresh-token grant rejected (HTTP ' + status + '): ' + String(body).slice(0, 180));
      } catch (e) { terra.log('HH auth: refresh-token grant error: ' + e); }
    }

    // 3) Email/password grant.
    if ((await terra.settings.has('hh_username')) && (await terra.settings.has('hh_password'))) {
      try {
        const { status, data, body } = await postJwtGrant(JSON.stringify({
          grant_type: 'password',
          username: '{{setting:hh_username}}',
          password: '{{setting:hh_password}}',
        }));
        if (status >= 200 && status < 300 && data && data.access_token) {
          return await saveHammerheadTokenResponse(data, null);
        }
        terra.log('HH auth: password grant rejected (HTTP ' + status + '): ' + String(body).slice(0, 180));
      } catch (e) { terra.log('HH auth: password grant error: ' + e); }
    }

    // 4) Manual override: hh_token + hh_user_id pasted by the user.
    const manualUserId = String((await terra.settings.get('hh_user_id')) || '').trim();
    if (manualUserId && (await terra.settings.has('hh_token'))) {
      return { tokenHeader: 'Bearer {{setting:hh_token}}', userId: manualUserId, isManual: true };
    }
    return null;
  }

  const xmlEsc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  // gpxPts: [[lat, lng, altOrNull], …] — GPX 1.1 with <ele> where the game had altitude.
  function buildGpx(gpxPts, name) {
    const trkpts = gpxPts.map((p) => {
      const ele = p[2] != null ? `\n      <ele>${p[2].toFixed(1)}</ele>\n    ` : '';
      return `    <trkpt lat="${p[0]}" lon="${p[1]}">${ele}</trkpt>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Terra (karoo-bridge)"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <name>${xmlEsc(name)}</name>
  <trk>
    <name>${xmlEsc(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
  }

  async function uploadRouteToHammerhead(gpxPts) {
    const auth = await getValidHammerheadAuth(false);
    if (!auth || !auth.userId) {
      if (!hhSkipHintLogged) {
        hhSkipHintLogged = true;
        terra.log('HH route: not uploaded yet — enter the Hammerhead Email & Password in the '
          + 'karoo-bridge addon settings (auto-login fetches your 1h dashboard JWT + user ID). '
          + 'Manual override: also fill "Hammerhead user ID" and "Hammerhead dashboard token".');
      }
      return;
    }
    const first = gpxPts[0], last = gpxPts[gpxPts.length - 1];
    const sig = [first[0], first[1], last[0], last[1], gpxPts.length].join('|');
    if (hhUploaded.has(sig)) return; // the 2-min re-pushes must not re-upload

    const name = (document.title || '').trim().slice(0, 80) || 'Biketerra ride';
    const route = simplify(gpxPts, 0.00004); // same detail as the Karoo map polyline
    const gpx = buildGpx(route, name);
    // UTF-8 -> base64 (the multipart part is base64, expanded/decoded Rust-side)
    const bytes = new TextEncoder().encode(gpx);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const post = (au) => terra.http.request({
      method: 'POST',
      url: `https://dashboard.hammerhead.io/v1/users/${au.userId}/routes/import/file`,
      headers: { Authorization: au.tokenHeader }, // literal 'Bearer …' or expanded Rust-side (manual override)
      form: {
        fields: {},
        file: { field: 'file', filename: 'biketerra-route.gpx', contentType: 'application/gpx+xml', base64: btoa(bin) },
      },
      timeoutMs: 60000,
    });
    let r = await post(auth);
    if ((r.status === 401 || r.status === 403) && !auth.isManual) {
      // Token expired mid-session: force a fresh one (cache skipped) and retry once.
      terra.log('HH route: rejected (HTTP ' + r.status + ') — refreshing the token and retrying once…');
      const fresh = await getValidHammerheadAuth(true);
      if (fresh && fresh.userId) r = await post(fresh);
    }
    if (r.status >= 200 && r.status < 300) {
      let id;
      try {
        const data = JSON.parse(r.body);
        id = Array.isArray(data) ? (data.find((x) => x && x.id) || data[0] || {}).id
                                : (data && data.id);
      } catch { /* non-JSON success body */ }
      hhUploaded.add(sig);
      const eleCount = route.reduce((n, p) => n + (p[2] != null ? 1 : 0), 0);
      terra.log(`HH route: uploaded ${route.length} pts (${(gpx.length / 1024).toFixed(0)} KB, ele on ${eleCount}/${route.length})`
        + (id != null ? ` (route id ${id})` : '')
        + ' — it is now in your Hammerhead routes; select it on the Karoo/Hammerhead app to start the ride');
    } else if (r.status === 401 || r.status === 403) {
      terra.log('HH route: rejected (HTTP ' + r.status + ') even with a fresh token — check the Hammerhead '
        + 'Email & Password (or refresh token / manual token) in the addon settings.');
    } else {
      terra.log(`HH route: upload failed (HTTP ${r.status}): ${String(r.body).slice(0, 200)}`);
    }
  }

  async function sendRoute() {
    const url = routeDataUrl();
    if (!url) return;
    let j = null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (r.ok) j = await r.json();
    } catch (e) { terra.log('KAROO route fetch failed: ' + ((e && e.message) || e)); }
    if (!j) j = window.__remixContext?.state?.loaderData || null; // what the page itself loaded
    const candidates = findRoutes(j);
    if (candidates.length === 0) { terra.log('KAROO route: no point array in page data'); return; }
    const countAlt = (c) => { let n = 0; for (let i = 0; i < c.length; i++) { const p = c[i]; if (Array.isArray(p) && typeof p[2] === 'number' && Number.isFinite(p[2])) n++; } return n; };
    const longest = (arr) => (arr.length ? arr.reduce((a, b) => (b.length > a.length ? b : a)) : null);
    // v3.3: pick the LONGEST point array. The first-found one used to be a
    // tiny helper array ("route assembled: 12 chars") ahead of the real route.
    // v3.4: a bare [lat,lng] track with no altitude used to win on length —
    // then the GPX arrived with zero <ele>. Prefer an array that actually
    // carries altitude on a majority of its points, and only fall back to
    // the longest overall when none do.
    const withAlt = candidates.filter((c) => c.length >= 3 && countAlt(c) * 2 > c.length);
    const points = longest(withAlt) || longest(candidates);

    if (!routeShapeLogged) {
      routeShapeLogged = true;
      terra.log(`KAROO route shape: ${candidates.length} point array(s) found — `
        + candidates.map((c) => `${c.length}pts, alt=${countAlt(c)}${c === points ? ' *' : ''}, first=${JSON.stringify(c[0])}`).join(' ; '));
    }

    const valid = points
      .filter((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number'
        && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    const pts = valid.map((p) => [p[0], p[1]]); // pairs: the Karoo map polyline
    const gpxPts = valid.map((p) => [p[0], p[1],
      (typeof p[2] === 'number' && Number.isFinite(p[2])) ? p[2] : null]); // triples: the GPX
    if (pts.length < 2) return;

    // Hammerhead route sync: fire-and-forget, independent of the UDP push below.
    // Never throws into the route pipeline (caught + logged in the helper).
    if (gpxPts.length >= 2) {
      void uploadRouteToHammerhead(gpxPts)
        .catch((e) => terra.log('HH route: ' + ((e && e.message) || e)));
    }

    const line = encodePolyline(simplify(pts, 0.00004));
    const chunks = [];
    for (let i = 0; i < line.length; i += ROUTE_CHUNK) chunks.push(line.slice(i, i + ROUTE_CHUNK));
    const start = [pts[0][0], pts[0][1]];
    const end = [pts[pts.length - 1][0], pts[pts.length - 1][1]];

    const sendAll = async () => {
      for (let seq = 0; seq < chunks.length; seq++) {
        const o = { seq, total: chunks.length, poly: chunks[seq] };
        if (seq === 0) { o.start = start; o.end = end; }
        await terra.udp.send(TARGET, JSON.stringify({ route: o }));
      }
    };

    for (let pass = 0; pass < 3; pass++) { // repeats in case of a dropped datagram
      if (pass > 0) await new Promise((r) => setTimeout(r, 500));
      try {
        await sendAll();
        terra.log(`KAROO route: ${pts.length} pts → ${line.length} chars in ${chunks.length} datagram(s)`);
        return;
      } catch (e) { if (pass === 2) terra.log('KAROO route send failed: ' + ((e && e.message) || e)); }
    }
  }

  const queueRoute = () => {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => sendRoute().catch((e) => terra.log('KAROO route: ' + ((e && e.message) || e))), 2000);
  };
  if (routeDataUrl()) queueRoute(); // after load: page data is usually ready by then
  terra.onNavigate(() => { if (routeDataUrl()) queueRoute(); });
  const routeRepush = setInterval(() => {      // re-push keeps the route alive across (re)starts
    if (routeDataUrl() && !document.hidden) queueRoute();
  }, 120000);

  terra.onCleanup(() => {
    try { ch.close(); } catch {}
    clearTimeout(routeTimer);
    clearInterval(routeRepush);
  });
  terra.log('KAROO BRIDGE ready' + (gears ? ' (gear state known)' : ' (waiting for gear state)')
    + (routeDataUrl() ? ' (+ route: sending to Karoo)' : ''));
})(terra);
