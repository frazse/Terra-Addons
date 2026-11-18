(() => {
  let FALLBACK_FTP = 310;
  let FALLBACK_LTHR = 173;
  let INTERVALS_FTP = null;
  let INTERVALS_LTHR = null;
  let intervalsId = '';

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

        terra.log(`[Garmin HUD] Synced Intervals.icu zones: FTP ${INTERVALS_FTP} | LTHR ${INTERVALS_LTHR}`);
      } else {
        terra.log(`[Garmin HUD] Intervals.icu error: HTTP ${r.status}`);
      }
    } catch (e) {
      terra.log('[Garmin HUD] Fetch error: ' + (e?.message || e));
    }
  }

  const WINDOW_MS = 60000;   // 60s rolling window across all sample rates
  const BT_SAMPLE_MS = 100;  // 10Hz when btApp.riderController is active
  const DOM_SAMPLE_MS = 1000;
  const initNow = performance.now();
  const makeBaseline = (color) => [
    { val: 0, color, t: initNow - WINDOW_MS },
    { val: 0, color, t: initNow },
  ];

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
    'kph': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke(new Path2D('M2 17.5a10 10 0 1 1 20 0')); ctx.stroke(new Path2D('M12 17.5L15 10'));
        ctx.fillStyle = '#3B82F6'; ctx.beginPath(); ctx.arc(12, 17.5, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      },
      data: makeBaseline('#22c55e'), minScale: 50,  type: 'speed', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    }
  };

  // ---- Live telemetry priority:
  //   1. window.btApp.riderController (focalRider / ego)
  //   2. biketerra-ride broadcast (terra.ride)
  //   3. DOM scraping (.stat-cell .stat-value)
  let rideFrame = null;
  let offRide = null;
  let lastFeedAt = 0;
  let activeSource = null; // 'btApp' | 'ride' | 'dom'
  const FEED_FRESH_MS = 2500;

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
    if (unit === 'rpm') return pickNum(srcs, ['cadence', 'cad', 'rpm', 'cadenceRpm']);
    if (unit === 'bpm') return pickNum(srcs, ['heartRate', 'hr', 'heart_rate', 'bpm']);
    if (unit === 'kph') {
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
    if (btRider && (isSpectatingOther || window.location.pathname.includes('/spectate'))) {
      const { id, name } = riderIdentity(btRider);
      if (Array.isArray(rideFrame.riders)) {
        for (const r of rideFrame.riders) {
          if (!r || typeof r !== 'object') continue;
          if (id != null && r.id != null && String(r.id) === String(id)) return r;
          if (name && r.name && String(r.name).trim().toLowerCase() === name) return r;
        }
      }
      if (isSpectatingOther) return null; // never leak own frame.ego onto another rider
    }
    return rideFrame.ego || null;
  }

  function readFeedMetric(feedObj, unit) {
    if (!feedObj || typeof feedObj !== 'object') return null;
    const srcs = [feedObj];
    if (unit === 'W')   return pickNum(srcs, ['power', 'watts', 'wattage']);
    if (unit === 'rpm') return pickNum(srcs, ['cadence', 'cad', 'rpm', 'cadenceRpm']);
    if (unit === 'bpm') return pickNum(srcs, ['heartRate', 'hr', 'heart_rate', 'bpm']);
    if (unit === 'kph') {
      const kph = pickNum(srcs, ['speedKph', 'speedKmh', 'speed_kmh', 'kph']);
      if (kph !== null) return kph;
      const ms = pickNum(srcs, ['speed', 'speedMs', 'vel']);
      if (ms !== null) return ms * 3.6;
    }
    return null;
  }

  // Frames older than FEED_FRESH_MS mean the biketerra-ride feed is quiet (or never started).
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

  function initRideFeed() {
    if (typeof terra === 'undefined' || !terra.ride) return;
    if (terra.ride.latest) {
      const seed = terra.ride.latest();
      if (seed) {
        rideFrame = seed;
        if (seed.timestamp && Math.abs(Date.now() - seed.timestamp) < FEED_FRESH_MS) {
          lastFeedAt = performance.now();
        }
      }
    }
    if (terra.ride.onRide) {
      offRide = terra.ride.onRide((frame) => {
        if (!frame) return;
        rideFrame = frame;
        lastFeedAt = performance.now();
        const rc = getBtController();
        const btRider = getBtRider(rc);
        if (!btHasAnyMetric(btRider)) {
          noteSource('ride');
          tick();
        }
      });
    }
  }

  function readMetric(unit, valueNode, rc, btRider, feedObj, isFeedFresh) {
    if (btRider) {
      const btVal = readBtMetric(btRider, unit);
      if (btVal !== null) return btVal;
    }
    if (isFeedFresh && feedObj) {
      const feedVal = readFeedMetric(feedObj, unit);
      if (feedVal !== null) return feedVal;
    }
    return parseFloat(valueNode.innerText) || 0;
  }

  let renderInterval = null;

  // Sample every stat cell once: compute the live value, update the all-time stats, and
  // push it into the 60s time-windowed rolling buffer.
  function sampleOnce(rc, btRider, feedObj, isFeedFresh, now) {
    const windowStart = now - WINDOW_MS;
    document.querySelectorAll('.stat-cell').forEach((cell) => {
      const valueNode = cell.querySelector('.stat-value');
      const unitNode = cell.querySelector('.stat-unit');
      if (!valueNode || !unitNode) return;

      const unit = unitNode.innerText.trim();
      const graphInfo = graphs[unit];
      if (!graphInfo) return;

      const val = readMetric(unit, valueNode, rc, btRider, feedObj, isFeedFresh);

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

  // Redraw every stat-cell graph from the rolling buffer.
  function renderOnce(rc, btRider, feedObj, isFeedFresh, now) {
    const windowStart = now - WINDOW_MS;
    const statCells = document.querySelectorAll('.stat-cell');

    // Measure a "normal" sized cell (like Heart Rate) to establish a global baseline
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

      const unit = unitNode.innerText.trim();
      const graphInfo = graphs[unit];
      if (!graphInfo) return;

      const val = readMetric(unit, valueNode, rc, btRider, feedObj, isFeedFresh);

      const valueStyle = window.getComputedStyle(valueNode);
      const unitStyle = window.getComputedStyle(unitNode);
      const valueFontFamily = valueStyle.fontFamily;
      const unitFontFamily = unitStyle.fontFamily;

      // Force all cells (including Power) to use the standard size
      const baseFontSize = standardFontSize;
      const cellHeight = baseFontSize * 3.2;
      const graphHeight = cellHeight * 0.45;

      let canvas = cell.querySelector('canvas.terra-dark-graph');
      if (!canvas) {
        cell.style.position = 'relative';
        cell.style.display = 'block';

        canvas = document.createElement('canvas');
        canvas.className = 'terra-dark-graph';
        canvas.style.cssText = 'position: absolute; top: 0; left: 0; z-index: 10; pointer-events: none; border-radius: 6px; overflow: hidden; background: #18181b;';
        cell.appendChild(canvas);
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
      const scaleMax = Math.max(graphInfo.minScale, windowMax);

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

      const valStr = (unit === 'kph') ? val.toFixed(1) : Math.round(val).toString();

      ctx.font = `bold ${baseFontSize}px ${valueFontFamily}`;
      ctx.fillStyle = resolveValueColor(valueNode, valueStyle);
      ctx.textAlign = 'left';

      const textOffset = paddingX + iconSize + (baseFontSize * 0.15);
      ctx.fillText(valStr, textOffset, (height - graphHeight) / 2 + (baseFontSize * 0.05));

      ctx.textAlign = 'right';
      ctx.fillStyle = '#9ca3af';
      ctx.font = `bold ${baseFontSize * 0.6}px ${unitFontFamily}`;
      ctx.fillText(`AVG ${allTimeAvg}`, width - paddingX, Math.floor((height - graphHeight) * 0.3));
      ctx.fillText(`MAX ${allTimeMax}`, width - paddingX, Math.floor((height - graphHeight) * 0.7));

      ctx.strokeStyle = '#27272a';
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

  // Primary loop (~10Hz when btApp.riderController is active; ~1Hz for DOM fallback).
  // While btApp is absent and biketerra-ride frames are arriving, onRide drives ticks directly.
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
    await fetchAthleteZonesFromIntervals();

    if (typeof terra !== 'undefined' && terra.settings) {
      terra.settings.onChange(async () => {
        await loadSettings();
        await fetchAthleteZonesFromIntervals();
      });

      terra.onCleanup(() => {
        if (renderInterval) clearInterval(renderInterval);
        if (offRide) offRide();
        document.querySelectorAll('canvas.terra-dark-graph').forEach(c => c.remove());
      });
    }

    initRideFeed();
    startHudLoop();
  })();
})();
