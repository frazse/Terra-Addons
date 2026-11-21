(() => {
  let FALLBACK_FTP = 310;
  let FALLBACK_LTHR = 173;
  let INTERVALS_FTP = null;
  let INTERVALS_LTHR = null;
  let intervalsId = '';
  let speedUnit = 'km/h';
  let powerSmoothing = 'instant';
  let WINDOW_MS = 60000;
  let bgOpacity = 45;

  function getActiveFTP() {
    return window.location.pathname.includes('/spectate') ? FALLBACK_FTP : (INTERVALS_FTP || FALLBACK_FTP);
  }

  function getActiveLTHR() {
    return window.location.pathname.includes('/spectate') ? FALLBACK_LTHR : (INTERVALS_LTHR || FALLBACK_LTHR);
  }

  function getIntervalsColor(val, type) {
    if (type === 'power') {
      const pct = val / getActiveFTP();
      if (pct <= 0.55) return 'rgb(0, 158, 128)';
      if (pct <= 0.75) return 'rgb(0, 158, 0)';
      if (pct <= 0.90) return 'rgb(255, 203, 14)';
      if (pct <= 1.05) return 'rgb(255, 127, 14)';
      if (pct <= 1.20) return 'rgb(221, 4, 71)';
      if (pct <= 1.50) return 'rgb(102, 51, 204)';
      return 'rgb(80, 72, 97)';
    }
    if (type === 'hr') {
      const pct = val / getActiveLTHR();
      if (pct <= 0.80) return 'rgb(0, 158, 128)';
      if (pct <= 0.89) return 'rgb(0, 158, 0)';
      if (pct <= 0.93) return 'rgb(255, 203, 14)';
      if (pct <= 0.99) return 'rgb(255, 127, 14)';
      if (pct <= 1.02) return 'rgb(221, 4, 71)';
      if (pct <= 1.05) return 'rgb(102, 51, 204)';
      return 'rgb(80, 72, 97)';
    }
    if (type === 'cadence') return '#3b82f6';
    if (type === 'speed') return '#22c55e';
    return '#9ca3af';
  }

  let colorProbeCtx = null;
  const cssColorCache = new Map();

  function parseCssRgb(c) {
    if (!c || typeof c !== 'string') return null;
    const key = c.trim();
    if (!key) return null;
    if (cssColorCache.has(key)) return cssColorCache.get(key);

    let out = null;
    let m = key.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (m) {
      out = [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
    } else if ((m = key.match(/^#([0-9a-f]{6})$/i))) {
      const h = m[1];
      out = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    } else if (typeof document !== 'undefined') {
      try {
        if (!colorProbeCtx) {
          const pc = document.createElement('canvas');
          pc.width = 1;
          pc.height = 1;
          colorProbeCtx = pc.getContext('2d', { willReadFrequently: true });
        }
        if (colorProbeCtx) {
          colorProbeCtx.clearRect(0, 0, 1, 1);
          colorProbeCtx.fillStyle = 'rgba(0, 0, 0, 0)';
          colorProbeCtx.fillStyle = key;
          colorProbeCtx.fillRect(0, 0, 1, 1);
          const d = colorProbeCtx.getImageData(0, 0, 1, 1).data;
          if (d && d[3] > 0) out = [d[0], d[1], d[2]];
        }
      } catch {}
    }
    cssColorCache.set(key, out);
    return out;
  }

  function resolveValueColor(valueNode, valueStyle) {
    const candidates = [valueStyle && valueStyle.color];
    if (valueNode && typeof valueNode.querySelectorAll === 'function') {
      for (const child of valueNode.querySelectorAll('*')) {
        candidates.push(window.getComputedStyle(child).color);
      }
    }
    let brightFallback = null;
    for (const c of candidates) {
      const rgb = parseCssRgb(c);
      if (!rgb) continue;
      const [r, g, b] = rgb;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      // Preserve colored state indicators (e.g. red braking speed text) and bright text;
      // fall back to white only if the page's color would be too dark on #18181b.
      if (chroma >= 40) return `rgb(${r}, ${g}, ${b})`;
      if (!brightFallback && luma >= 55) brightFallback = `rgb(${r}, ${g}, ${b})`;
    }
    return brightFallback || '#ffffff';
  }

  async function loadSettings() {
    if (typeof terra === 'undefined' || !terra.settings) return;
    const s = await terra.settings.all();
    const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    FALLBACK_FTP = n(s.fallback_ftp, 310);
    FALLBACK_LTHR = n(s.fallback_lthr, 173);
    intervalsId = String(s.intervals_id || '').trim();
    speedUnit = String(s.speed_unit || 'km/h').trim().toLowerCase() === 'mph' ? 'mph' : 'km/h';
    const ps = String(s.power_smoothing || 'instant').trim().toLowerCase();
    powerSmoothing = (ps === '3s' || ps === '10s') ? ps : 'instant';
    const ws = Number(s.window_seconds);
    WINDOW_MS = ((ws === 30 || ws === 60 || ws === 120) ? ws : 60) * 1000;
    const rawOp = s.bg_opacity === undefined || s.bg_opacity === '' ? 45 : Number(s.bg_opacity);
    bgOpacity = Number.isFinite(rawOp) ? Math.min(100, Math.max(0, rawOp)) : 45;
  }

  async function loadCachedZones() {
    if (typeof terra === 'undefined' || !terra.storage) return;
    if (window.location.pathname.includes('/spectate')) return;
    try {
      const cached = await terra.storage.get('intervals_cache', null);
      if (cached && (!intervalsId || cached.id === intervalsId)) {
        if (Number.isFinite(cached.ftp) && cached.ftp > 0) INTERVALS_FTP = cached.ftp;
        if (Number.isFinite(cached.lthr) && cached.lthr > 0) INTERVALS_LTHR = cached.lthr;
        if (INTERVALS_FTP || INTERVALS_LTHR) {
          terra.log(`[Garmin HUD] Loaded cached Intervals.icu zones: FTP ${INTERVALS_FTP} | LTHR ${INTERVALS_LTHR}`);
        }
      }
    } catch {}
  }

  async function fetchAthleteZonesFromIntervals() {
    if (typeof terra === 'undefined' || !terra.http || !intervalsId) return;

    if (window.location.pathname.includes('/spectate')) {
      terra.log('[Garmin HUD] Spectator mode: skipping personal Intervals.icu sync.');
      return;
    }

    const hasKey = await terra.settings.has('intervals_api_key');
    if (!hasKey) return;

    try {
      const r = await terra.http.request({
        method: 'GET',
        url: `https://intervals.icu/api/v1/athlete/${encodeURIComponent(intervalsId)}`,
        basic: { user: 'API_KEY', password: '{{setting:intervals_api_key}}' }
      });

      if (r.status >= 200 && r.status < 300) {
        const data = JSON.parse(r.body);
        let apiFtp = null;
        let apiLthr = null;

        if (data.ftp) apiFtp = data.ftp;
        if (data.lthr) apiLthr = data.lthr;

        if (Array.isArray(data.sportSettings)) {
          const ride = data.sportSettings.find(s => s.id === 'Ride' || s.id === 'VirtualRide') || data.sportSettings[0];
          if (ride) {
            apiFtp = ride.indoor_ftp || ride.ftp || apiFtp;
            apiLthr = ride.lthr || apiLthr;
          }
        }

        INTERVALS_FTP = apiFtp;
        INTERVALS_LTHR = apiLthr;
        if (terra.storage && (apiFtp || apiLthr)) {
          terra.storage.set('intervals_cache', {
            id: intervalsId, ftp: apiFtp, lthr: apiLthr, updatedAt: Date.now()
          }).catch(() => {});
        }

        terra.log(`[Garmin HUD] Synced Intervals.icu zones: FTP ${INTERVALS_FTP} | LTHR ${INTERVALS_LTHR}`);
      } else {
        terra.log(`[Garmin HUD] Intervals.icu error: HTTP ${r.status}`);
      }
    } catch (e) {
      terra.log('[Garmin HUD] Fetch error: ' + (e?.message || e));
    }
  }

  const BT_SAMPLE_MS = 100;    // 10Hz when btApp.riderController is active
  const DOM_SAMPLE_MS = 1000;
  const makeFeedState = () => ({ val: null, feedTs: 0, btAt: 0 });
  const feedMetricState = {
    speed: makeFeedState(),
    cadence: makeFeedState(),
    hr: makeFeedState(),
  };
  const initNow = performance.now();
  const makeBaseline = (color) => [
    { val: 0, color, t: initNow - 60000 },
    { val: 0, color, t: initNow },
  ];

  const speedGraph = {
    drawIcon: (ctx, x, y, size) => {
      ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
      ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(new Path2D('M2 17.5a10 10 0 1 1 20 0')); ctx.stroke(new Path2D('M12 17.5L15 10'));
      ctx.fillStyle = '#3B82F6'; ctx.beginPath(); ctx.arc(12, 17.5, 1.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    },
    data: makeBaseline('#22c55e'), minScale: 50, type: 'speed', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
  };

  const graphs = {
    'W': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.strokeStyle = '#A855F7'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(13, 2); ctx.lineTo(3, 14); ctx.lineTo(12, 14);
        ctx.lineTo(11, 22); ctx.lineTo(21, 10); ctx.lineTo(12, 10); ctx.closePath();
        ctx.stroke(); ctx.restore();
      },
      data: makeBaseline('rgb(0,158,128)'), minScale: 350, type: 'power', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    },
    'rpm': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(12, 12, 10, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(12, 12, 3, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      },
      data: makeBaseline('#3b82f6'), minScale: 120, type: 'cadence', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    },
    'bpm': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.fillStyle = '#EF4444';
        ctx.fill(new Path2D('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'));
        ctx.restore();
      },
      data: makeBaseline('rgb(0,158,128)'), minScale: 190, type: 'hr', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    },
    'kph': speedGraph,
    'mph': speedGraph,
  };
  graphs['spm'] = graphs['rpm'];

  // ---- Live telemetry priority:
  //   1. window.btApp.riderController (focalRider / ego)
  //   2. biketerra-ride broadcast (terra.ride)
  //   3. DOM scraping (.stat-cell .stat-value)
  let rideFrame = null;
  let offRide = null;
  let rideBroadcastChannel = null;
  let lastFeedAt = 0;
  let activeSource = null; // 'btApp' | 'ride' | 'dom'
  const FEED_FRESH_MS = 2500;
  const powerSamples = []; // { val, t } for optional 3s/10s readout smoothing

  function finiteNum(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function pickNum(sources, keys) {
    for (const src of sources) {
      if (!src || typeof src !== 'object') continue;
      for (const k of keys) {
        const n = finiteNum(src[k]);
        if (n !== null) return n;
      }
    }
    return null;
  }

  function getBtController() {
    const app = typeof window !== 'undefined' ? window.btApp : null;
    return (app && (app.riderController || app.rideController)) || null;
  }

  function getBtRider(rc) {
    if (!rc) return null;
    return rc.focalRider || rc.ego || null;
  }

  function readBtMetric(rider, unit) {
    if (!rider || typeof rider !== 'object') return null;
    const srcs = [rider.sim, rider, rider.userData, rider.stats, rider.state, rider.telemetry];
    if (unit === 'W')   return pickNum(srcs, ['power', 'watts', 'wattage']);
    if (unit === 'rpm' || unit === 'spm') return pickNum(srcs, ['cadence', 'cad', 'rpm', 'spm', 'cadenceRpm']);
    if (unit === 'bpm') return pickNum(srcs, ['heartRate', 'hr', 'heart_rate', 'bpm']);
    if (unit === 'kph' || unit === 'mph') {
      const kph = pickNum(srcs, ['speedKph', 'speedKmh', 'speed_kmh', 'kph']);
      if (kph !== null) return kph;
      const ms = pickNum(srcs, ['speed', 'speedMs', 'vel']);
      if (ms !== null) return ms * 3.6;
      const sim = rider.sim;
      if (sim && sim.velocity != null) {
        if (typeof sim.velocity === 'number' && Number.isFinite(sim.velocity)) return sim.velocity * 3.6;
        if (typeof sim.velocity === 'object') {
          const vx = finiteNum(sim.velocity.x), vy = finiteNum(sim.velocity.y) || 0, vz = finiteNum(sim.velocity.z);
          if (vx !== null && vz !== null) return Math.hypot(vx, vy, vz) * 3.6;
        }
      }
    }
    return null;
  }

  function btHasAnyMetric(rider) {
    if (!rider) return false;
    return readBtMetric(rider, 'W') !== null ||
      readBtMetric(rider, 'rpm') !== null ||
      readBtMetric(rider, 'bpm') !== null ||
      readBtMetric(rider, 'kph') !== null;
  }

  function riderIdentity(rider) {
    if (!rider || typeof rider !== 'object') return { id: null, name: '' };
    const sim = rider.sim || {};
    const cfg = rider.config || {};
    const ud = rider.userData || {};
    const id = sim.id ?? sim.athleteId ?? rider.id ?? rider.athleteId ?? null;
    const first = String((ud.first_name ?? cfg.first_name) || '').trim();
    const last = String((cfg.last_name ?? ud.last_name) || '').trim();
    const name = `${first} ${last}`.trim().toLowerCase();
    return { id, name };
  }

  function resolveFeedObject(rc, btRider) {
    if (!rideFrame) return null;
    const isSpectatingOther = !!(rc && rc.ego && btRider && btRider !== rc.ego);
    const matchInRiders = (targetRider) => {
      if (!targetRider || !Array.isArray(rideFrame.riders)) return null;
      const { id, name } = riderIdentity(targetRider);
      for (const r of rideFrame.riders) {
        if (!r || typeof r !== 'object') continue;
        if (id != null && r.id != null && String(r.id) === String(id)) return r;
        if (name && r.name && String(r.name).trim().toLowerCase() === name) return r;
      }
      return null;
    };
    if (btRider && (isSpectatingOther || window.location.pathname.includes('/spectate'))) {
      const matched = matchInRiders(btRider);
      if (matched) return matched;
      if (isSpectatingOther) return null;
    }
    const egoObj = (rideFrame.ego && typeof rideFrame.ego === 'object') ? rideFrame.ego : null;
    const matchedEgo = matchInRiders(btRider || (rc && rc.ego));
    if (egoObj && matchedEgo && egoObj !== matchedEgo) {
      const merged = { ...matchedEgo, ...egoObj };
      for (const [k, v] of Object.entries(matchedEgo)) {
        if (finiteNum(v) && !finiteNum(egoObj[k])) merged[k] = v;
      }
      return merged;
    }
    return egoObj || matchedEgo || rideFrame;
  }

  function readFeedMetric(feedObj, unit) {
    if (!feedObj || typeof feedObj !== 'object') return null;
    const srcs = [feedObj];
    if (rideFrame && typeof rideFrame === 'object' && feedObj !== rideFrame) {
      if (rideFrame.ego && typeof rideFrame.ego === 'object' && rideFrame.ego !== feedObj) {
        srcs.push(rideFrame.ego);
      }
      if (Array.isArray(rideFrame.riders) && rideFrame.riders.length === 1 && rideFrame.riders[0] && rideFrame.riders[0] !== feedObj) {
        srcs.push(rideFrame.riders[0]);
      }
      srcs.push(rideFrame);
    }
    const pickBest = (keys) => {
      let fallback = null;
      for (const src of srcs) {
        if (!src || typeof src !== 'object') continue;
        for (const k of keys) {
          const n = finiteNum(src[k]);
          if (n !== null) {
            if (n > 0) return n;
            if (fallback === null) fallback = n;
          }
        }
      }
      return fallback;
    };
    if (unit === 'W')   return pickBest(['power', 'watts', 'wattage']);
    if (unit === 'rpm' || unit === 'spm') return pickBest(['cadence', 'cad', 'rpm', 'spm', 'cadenceRpm']);
    if (unit === 'bpm') return pickBest(['heartRate', 'hr', 'heart_rate', 'bpm']);
    if (unit === 'kph' || unit === 'mph') {
      const kph = pickBest(['speedKph', 'speedKmh', 'speed_kmh', 'kph']);
      if (kph !== null) return kph;
      const ms = pickBest(['speed', 'speedMs', 'vel']);
      if (ms !== null) return ms * 3.6;
    }
    return null;
  }

  const feedFresh = () => rideFrame !== null && (performance.now() - lastFeedAt) < FEED_FRESH_MS;

  function noteSource(src) {
    if (activeSource === src || typeof terra === 'undefined' || !terra.log) return;
    activeSource = src;
    if (src === 'btApp') {
      terra.log('[Garmin HUD] Live: driving the HUD from btApp.riderController (focal/ego) (~10Hz).');
    } else if (src === 'ride') {
      terra.log('[Garmin HUD] Live: driving the HUD from biketerra-ride fallback (~2Hz).');
    } else if (src === 'dom') {
      terra.log('[Garmin HUD] Fallback: driving the HUD from DOM scraping (~1Hz).');
    }
  }

  function handleRideFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    rideFrame = frame;
    lastFeedAt = performance.now();
    const rc = getBtController();
    const btRider = getBtRider(rc);
    if (!btHasAnyMetric(btRider)) {
      noteSource('ride');
      tick();
    }
  }

  function initRideFeed() {
    if (typeof terra !== 'undefined' && terra.ride) {
      if (terra.ride.latest) {
        const seed = terra.ride.latest();
        if (seed) {
          rideFrame = seed;
          if (!seed.timestamp || Math.abs(Date.now() - seed.timestamp) < FEED_FRESH_MS) {
            lastFeedAt = performance.now();
          }
        }
      }
      if (terra.ride.onRide) {
        offRide = terra.ride.onRide(handleRideFrame);
      }
    }
    if (typeof BroadcastChannel !== 'undefined' && !rideBroadcastChannel) {
      try {
        rideBroadcastChannel = new BroadcastChannel('biketerra-ride');
        rideBroadcastChannel.addEventListener('message', (e) => {
          if (e && e.data) handleRideFrame(e.data);
        });
      } catch {}
    }
  }

  function readMetric(unit, valueNode, rc, btRider, feedObj, isFeedFresh) {
    let v = null;
    if (unit === 'W' || unit === 'w') {
      // Power stays on btApp.riderController (~10Hz)
      if (btRider) v = readBtMetric(btRider, unit);
      if (v === null && isFeedFresh && feedObj) v = readFeedMetric(feedObj, unit);
    } else {
      // Speed, cadence, and heart rate prefer biketerra-ride (~2Hz).
      // On /ride*, skip btApp fallback for cadence/HR so btApp's pre-start default (80 rpm) is never used.
      if (isFeedFresh && feedObj) v = readFeedMetric(feedObj, unit);
      if (v === null && btRider && ((unit === 'kph' || unit === 'mph') || window.location.pathname.includes('/spectate'))) {
        v = readBtMetric(btRider, unit);
      }
    }
    if (v === null) {
      const domVal = parseFloat(valueNode.innerText) || 0;
      v = (unit === 'mph') ? domVal * 1.609344 : domVal; // normalize internal speed to km/h
    }
    if (unit === 'kph' || unit === 'mph') {
      return speedUnit === 'mph' ? v * 0.62137119 : v;
    }
    return v;
  }

  function smoothedPower(instant, now) {
    if (powerSmoothing === 'instant') return instant;
    const span = powerSmoothing === '10s' ? 10000 : 3000;
    let sum = 0, cnt = 0;
    for (let i = powerSamples.length - 1; i >= 0; i--) {
      if (now - powerSamples[i].t > span) break;
      sum += powerSamples[i].val;
      cnt++;
    }
    return cnt > 0 ? sum / cnt : instant;
  }

  let renderInterval = null;

  function sampleOnce(rc, btRider, feedObj, isFeedFresh, now) {
    const windowStart = now - WINDOW_MS;
    document.querySelectorAll('.stat-cell').forEach((cell) => {
      const valueNode = cell.querySelector('.stat-value');
      const unitNode = cell.querySelector('.stat-unit');
      if (!valueNode || !unitNode) return;

      const unit = unitNode.innerText.trim().toLowerCase();
      const graphInfo = graphs[unit === 'w' ? 'W' : unit];
      if (!graphInfo) return;

      const st = feedMetricState[graphInfo.type];
      if (st) {
        const feedTs = (isFeedFresh && rideFrame)
          ? ((typeof rideFrame.timestamp === 'number' && rideFrame.timestamp > 0) ? rideFrame.timestamp : lastFeedAt)
          : 0;
        if (st.val !== null) {
          if (feedTs > 0) {
            if (feedTs === st.feedTs) return;
          } else if ((now - st.btAt) < 500) {
            return;
          }
        }
        const val = readMetric(unit === 'w' ? 'W' : unit, valueNode, rc, btRider, feedObj, isFeedFresh);
        st.val = val;
        if (feedTs > 0) st.feedTs = feedTs;
        st.btAt = now;
        if (val > 0) {
          graphInfo.allTimeSum += val;
          graphInfo.allTimeCount += 1;
          if (val > graphInfo.allTimeMax) graphInfo.allTimeMax = val;
        }
        graphInfo.data.push({ val, color: getIntervalsColor(val, graphInfo.type), t: now });
        while (graphInfo.data.length > 2 && graphInfo.data[1].t < windowStart) {
          graphInfo.data.shift();
        }
        return;
      }

      const val = readMetric(unit === 'w' ? 'W' : unit, valueNode, rc, btRider, feedObj, isFeedFresh);

      if (graphInfo.type === 'power') {
        powerSamples.push({ val, t: now });
        while (powerSamples.length > 0 && now - powerSamples[0].t > 12000) {
          powerSamples.shift();
        }
      }

      if (val > 0) {
        graphInfo.allTimeSum += val;
        graphInfo.allTimeCount += 1;
        if (val > graphInfo.allTimeMax) {
          graphInfo.allTimeMax = val;
        }
      }

      graphInfo.data.push({ val, color: getIntervalsColor(val, graphInfo.type), t: now });
      while (graphInfo.data.length > 2 && graphInfo.data[1].t < windowStart) {
        graphInfo.data.shift();
      }
    });
  }

  function renderOnce(rc, btRider, feedObj, isFeedFresh, now) {
    const windowStart = now - WINDOW_MS;
    const statCells = document.querySelectorAll('.stat-cell');

    let standardFontSize = 24;
    if (statCells.length > 1) {
      const normalValNode = statCells[1].querySelector('.stat-value');
      if (normalValNode) {
        standardFontSize = parseFloat(window.getComputedStyle(normalValNode).fontSize) || 24;
      }
    }

    statCells.forEach((cell) => {
      const valueNode = cell.querySelector('.stat-value');
      const unitNode = cell.querySelector('.stat-unit');
      if (!valueNode || !unitNode) return;

      const rawUnit = unitNode.innerText.trim();
      const unitKey = rawUnit.toLowerCase() === 'w' ? 'W' : rawUnit.toLowerCase();
      const graphInfo = graphs[unitKey];
      if (!graphInfo) return;

      const st = feedMetricState[graphInfo.type];
      const val = (st && st.val !== null)
        ? st.val
        : readMetric(unitKey, valueNode, rc, btRider, feedObj, isFeedFresh);
      const displayVal = graphInfo.type === 'power' ? smoothedPower(val, now) : val;

      const valueStyle = window.getComputedStyle(valueNode);
      const unitStyle = window.getComputedStyle(unitNode);
      const valueFontFamily = valueStyle.fontFamily;
      const unitFontFamily = unitStyle.fontFamily;

      const baseFontSize = standardFontSize;
      const cellHeight = baseFontSize * 3.2;
      const graphHeight = cellHeight * 0.45;

      let canvas = cell.querySelector('canvas.terra-dark-graph');
      if (!canvas) {
        cell.style.position = 'relative';
        cell.style.display = 'block';

        canvas = document.createElement('canvas');
        canvas.className = 'terra-dark-graph';
        canvas.style.cssText = 'position: absolute; top: 0; left: 0; z-index: 10; pointer-events: none; border-radius: 6px; overflow: hidden;';
        cell.appendChild(canvas);
      }
      canvas.style.background = `rgba(24, 24, 27, ${(bgOpacity / 100).toFixed(2)})`;
      for (const ch of cell.children) {
        if (ch !== canvas && ch.style && ch.style.opacity !== '0') {
          ch.style.opacity = '0';
        }
      }

      cell.style.height = `${cellHeight}px`;
      cell.style.minHeight = `${cellHeight}px`;

      const rect = cell.getBoundingClientRect();
      const displayWidth = Math.floor(rect.width);
      const displayHeight = Math.floor(cellHeight);
      const dpr = window.devicePixelRatio || 1;

      if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
        canvas.width = displayWidth * dpr;
        canvas.height = displayHeight * dpr;
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;
      }

      const ctx = canvas.getContext('2d');
      ctx.resetTransform();
      ctx.scale(dpr, dpr);

      const width = displayWidth;
      const height = displayHeight;
      ctx.clearRect(0, 0, width, height);

      let windowMax = 0;
      for (const d of graphInfo.data) {
        if (d.t >= windowStart && d.val > windowMax) windowMax = d.val;
      }
      const minScale = graphInfo.type === 'speed' ? (speedUnit === 'mph' ? 31 : 50) : graphInfo.minScale;
      const scaleMax = Math.max(minScale, windowMax);

      const allTimeAvg = graphInfo.allTimeCount > 0 ? Math.round(graphInfo.allTimeSum / graphInfo.allTimeCount) : 0;
      const allTimeMax = Math.round(graphInfo.allTimeMax);

      const pts = graphInfo.data;
      for (let i = 0; i < pts.length - 1; i++) {
        const pt1 = pts[i];
        const pt2 = pts[i + 1];

        const x1Raw = ((pt1.t - windowStart) / WINDOW_MS) * width;
        const x2Raw = ((pt2.t - windowStart) / WINDOW_MS) * width;
        if (x2Raw <= 0 || x1Raw >= width) continue;

        let x1 = x1Raw, v1 = pt1.val;
        if (x1 < 0 && pt2.t > pt1.t) {
          const frac = (windowStart - pt1.t) / (pt2.t - pt1.t);
          v1 = pt1.val + (pt2.val - pt1.val) * frac;
          x1 = 0;
        }
        let x2 = x2Raw, v2 = pt2.val;
        if (x2 > width && pt2.t > pt1.t) {
          const frac = (now - pt1.t) / (pt2.t - pt1.t);
          v2 = pt1.val + (pt2.val - pt1.val) * frac;
          x2 = width;
        }

        const y1 = height - ((v1 / scaleMax) * graphHeight);
        const y2 = height - ((v2 / scaleMax) * graphHeight);

        ctx.beginPath();
        ctx.moveTo(x1, height);
        ctx.lineTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x2, height);
        ctx.closePath();

        ctx.fillStyle = pt2.color;
        ctx.globalAlpha = 1.0;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = pt2.color;
        ctx.lineWidth = Math.max(1.5, baseFontSize * 0.08);
        ctx.stroke();
      }

      ctx.textBaseline = 'middle';
      const paddingX = baseFontSize * 0.4;

      const iconSize = baseFontSize * 0.95;
      graphInfo.drawIcon(ctx, paddingX, (height - graphHeight) / 2, iconSize);

      const isSpeed = graphInfo.type === 'speed';
      const valStr = isSpeed ? displayVal.toFixed(1) : Math.round(displayVal).toString();

      ctx.font = `bold ${baseFontSize}px ${valueFontFamily}`;
      ctx.fillStyle = resolveValueColor(valueNode, valueStyle);
      ctx.textAlign = 'left';

      const textOffset = paddingX + iconSize + (baseFontSize * 0.15);
      ctx.fillText(valStr, textOffset, (height - graphHeight) / 2 + (baseFontSize * 0.05));

      ctx.textAlign = 'right';
      ctx.fillStyle = '#9ca3af';
      ctx.font = `bold ${baseFontSize * 0.6}px ${unitFontFamily}`;
      const unitHint = isSpeed ? ` ${speedUnit}` : (graphInfo.type === 'power' && powerSmoothing !== 'instant' ? ` (${powerSmoothing})` : '');
      ctx.fillText(`AVG ${allTimeAvg}${unitHint}`, width - paddingX, Math.floor((height - graphHeight) * 0.3));
      ctx.fillText(`MAX ${allTimeMax}`, width - paddingX, Math.floor((height - graphHeight) * 0.7));

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(width, 0);
      ctx.stroke();
    });
  }

  function tick() {
    const now = performance.now();
    const rc = getBtController();
    const btRider = getBtRider(rc);
    const isFeedFresh = feedFresh();
    const feedObj = isFeedFresh ? resolveFeedObject(rc, btRider) : null;
    sampleOnce(rc, btRider, feedObj, isFeedFresh, now);
    renderOnce(rc, btRider, feedObj, isFeedFresh, now);
  }

  let lastDomTickAt = 0;
  function startHudLoop() {
    renderInterval = setInterval(() => {
      const rc = getBtController();
      const btRider = getBtRider(rc);
      if (btHasAnyMetric(btRider)) {
        noteSource('btApp');
        tick();
        return;
      }
      if (feedFresh()) return;
      const now = performance.now();
      if (now - lastDomTickAt < DOM_SAMPLE_MS - 20) return;
      lastDomTickAt = now;
      if (document.querySelector('.stat-cell')) noteSource('dom');
      tick();
    }, BT_SAMPLE_MS);
  }

  (async () => {
    await loadSettings();
    await loadCachedZones();
    await fetchAthleteZonesFromIntervals();

    if (typeof terra !== 'undefined' && terra.settings) {
      terra.settings.onChange(async () => {
        const prevUnit = speedUnit;
        await loadSettings();
        if (prevUnit !== speedUnit) {
          // Reset speed buffer when switching km/h <-> mph so curve doesn't mix units
          feedMetricState.speed = makeFeedState();
          speedGraph.data = makeBaseline('#22c55e');
          speedGraph.allTimeSum = 0;
          speedGraph.allTimeCount = 0;
          speedGraph.allTimeMax = 0;
        }
        await fetchAthleteZonesFromIntervals();
      });

      terra.onCleanup(() => {
        if (renderInterval) clearInterval(renderInterval);
        if (offRide) offRide();
        if (rideBroadcastChannel) {
          try { rideBroadcastChannel.close(); } catch {}
          rideBroadcastChannel = null;
        }
        document.querySelectorAll('.stat-cell').forEach((cell) => {
          cell.querySelectorAll('canvas.terra-dark-graph').forEach((c) => c.remove());
          for (const ch of cell.children) {
            if (ch.style && ch.style.opacity === '0') ch.style.opacity = '';
          }
        });
      });
    }

    initRideFeed();
    startHudLoop();
  })();
})();
