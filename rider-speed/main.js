(() => {
  const MARK = 'tr-rider-speed';

  let unit = 'km/h';
  let factor = 3.6; // internal speed is m/s
  let showDelta = false;
  let showTrend = false;
  let latest = null;
  let offRide = null;
  let btTimer = null;

  // Per-rider W/kg EMA state for trend detection (keyed by lowercased name or '__me__')
  const wkgTrend = new Map(); // key -> { fast, slow, arrow, lastT }

  async function loadSettings() {
    const s = await terra.settings.all();
    const v = String((s && s.speed_unit) || 'km/h').trim().toLowerCase();
    if (v === 'mph') { unit = 'mph'; factor = 2.236936; }
    else { unit = 'km/h'; factor = 3.6; }
    showDelta = !!(s && s.show_delta);
    showTrend = !!(s && s.show_trend);
  }

  const fmt = (ms) => (ms * factor).toFixed(1);
  const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const finite = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v) : null;

  function btSpeedMs(rider) {
    if (!rider || typeof rider !== 'object') return null;
    const srcs = [rider.sim, rider, rider.userData, rider.stats, rider.state, rider.telemetry];
    for (const src of srcs) {
      if (!src || typeof src !== 'object') continue;
      for (const k of ['speed', 'speedMs', 'vel']) {
        const n = finite(src[k]);
        if (n !== null) return n;
      }
      for (const k of ['speedKph', 'speedKmh', 'speed_kmh', 'kph']) {
        const n = finite(src[k]);
        if (n !== null) return n / 3.6;
      }
    }
    const v = rider.sim && rider.sim.velocity;
    if (v != null) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'object' && finite(v.x) !== null && finite(v.z) !== null) {
        return Math.hypot(finite(v.x), finite(v.y) || 0, finite(v.z));
      }
    }
    return null;
  }

  function btWkg(rider) {
    if (!rider || typeof rider !== 'object') return null;
    const srcs = [rider.sim, rider, rider.userData, rider.stats, rider.state, rider.telemetry];
    let pwr = null;
    for (const src of srcs) {
      if (!src || typeof src !== 'object') continue;
      for (const k of ['power', 'watts', 'wattage']) {
        const n = finite(src[k]);
        if (n !== null) { pwr = n; break; }
      }
      if (pwr !== null) break;
    }
    if (pwr === null) return null;
    const massG = (rider.config && finite(rider.config.mass)) ||
      (rider.userData && finite(rider.userData.weight)) || 75000;
    return (pwr * 1000) / massG;
  }

  function btRiderName(rider) {
    if (!rider || typeof rider !== 'object') return '';
    const cfg = rider.config || {}, ud = rider.userData || {};
    const first = String(ud.first_name ?? cfg.first_name ?? '').trim();
    const last = String(cfg.last_name ?? ud.last_name ?? '').trim();
    return normName(`${first} ${last}`);
  }

  function buildSnapshot() {
    const byName = new Map();
    let focalSpeed = null;
    let focalWkg = null;

    const rc = window.btApp && (window.btApp.riderController || window.btApp.rideController);
    if (rc) {
      const focal = rc.focalRider || rc.ego || null;
      if (focal) {
        focalSpeed = btSpeedMs(focal);
        focalWkg = btWkg(focal);
        const fn = btRiderName(focal);
        if (fn && (focalSpeed !== null || focalWkg !== null)) {
          byName.set(fn, { speed: focalSpeed, wkg: focalWkg });
        }
      }
      if (Array.isArray(rc.riders)) {
        for (const r of rc.riders) {
          if (!r) continue;
          const nm = btRiderName(r);
          if (!nm) continue;
          const sp = btSpeedMs(r);
          const wk = btWkg(r);
          if (sp !== null || wk !== null) byName.set(nm, { speed: sp, wkg: wk });
        }
      }
    }

    // Fallback/supplement from biketerra-ride broadcast
    if (latest) {
      if (focalSpeed === null && latest.ego && finite(latest.ego.speed) !== null) {
        focalSpeed = finite(latest.ego.speed);
      }
      if (focalWkg === null && latest.ego && finite(latest.ego.wkg) !== null) {
        focalWkg = finite(latest.ego.wkg);
      }
      if (Array.isArray(latest.riders)) {
        for (const r of latest.riders) {
          if (!r) continue;
          const nm = normName(r.name);
          if (!nm) continue;
          const cur = byName.get(nm) || { speed: null, wkg: null };
          if (cur.speed === null && finite(r.speed) !== null) cur.speed = finite(r.speed);
          if (cur.wkg === null && finite(r.wkg) !== null) cur.wkg = finite(r.wkg);
          if (cur.speed !== null || cur.wkg !== null) byName.set(nm, cur);
        }
      }
    }

    return { focalSpeed, focalWkg, byName };
  }

  function updateTrend(key, wkg, now) {
    if (wkg === null || !showTrend) return '';
    let st = wkgTrend.get(key);
    if (!st) {
      st = { fast: wkg, slow: wkg, arrow: '', lastT: now };
      wkgTrend.set(key, st);
      return '';
    }
    const dt = Math.min(2, Math.max(0.02, (now - st.lastT) / 1000));
    st.lastT = now;
    const aFast = 1 - Math.exp(-dt / 1.5);
    const aSlow = 1 - Math.exp(-dt / 8.0);
    st.fast += (wkg - st.fast) * aFast;
    st.slow += (wkg - st.slow) * aSlow;
    const diff = st.fast - st.slow;
    if (diff >= 0.28) st.arrow = 'up';
    else if (diff <= -0.28) st.arrow = 'down';
    else if (Math.abs(diff) < 0.12) st.arrow = '';
    return st.arrow;
  }

  function apply() {
    const snap = buildSnapshot();
    const now = performance.now();

    for (const row of document.querySelectorAll('.rider')) {
      const stats = row.querySelector('.rider-stats');
      if (!stats) continue;

      const isMe = row.classList.contains('is-me');
      const nameEl = row.querySelector('.rider-name');
      const nameKey = isMe ? '__me__' : normName(nameEl ? nameEl.textContent : '');
      const entry = isMe
        ? { speed: snap.focalSpeed, wkg: snap.focalWkg }
        : (nameKey ? snap.byName.get(nameKey) : null);

      const ms = entry ? entry.speed : null;
      const wkg = entry ? entry.wkg : null;

      let span = stats.querySelector('.' + MARK);
      if (ms == null) {
        if (span) span.remove();
        continue;
      }
      if (!span) {
        const s = document.createElement('span');
        s.className = MARK;
        s.setAttribute('data-' + MARK, '');
        s.title = 'Speed';
        const deltaEl = document.createElement('span');
        deltaEl.className = 'tr-delta';
        const num = document.createElement('span');
        num.className = 'num monospace';
        const u = document.createElement('span');
        u.className = 'unit';
        const trendEl = document.createElement('span');
        trendEl.className = 'tr-trend';
        s.append(deltaEl, num, ' ', u, trendEl, ' ');
        span = s;
        stats.append(span);
      }

      const value = stats.querySelector('.rider-stat-value');
      if (value) {
        if (value.previousElementSibling !== span) stats.insertBefore(span, value);
      } else if (stats.firstElementChild !== span) {
        stats.prepend(span);
      }

      span.querySelector('.unit').textContent = unit;
      span.querySelector('.num').textContent = fmt(ms);

      const deltaEl = span.querySelector('.tr-delta');
      if (showDelta && !isMe && snap.focalSpeed !== null) {
        const diff = (ms - snap.focalSpeed) * factor;
        if (Math.abs(diff) >= 0.2) {
          deltaEl.textContent = (diff > 0 ? '+' : '') + diff.toFixed(1) + ' ';
          deltaEl.className = 'tr-delta ' + (diff > 0 ? 'pos' : 'neg');
        } else {
          deltaEl.textContent = '';
          deltaEl.className = 'tr-delta';
        }
      } else {
        deltaEl.textContent = '';
        deltaEl.className = 'tr-delta';
      }

      const trendEl = span.querySelector('.tr-trend');
      const arrow = updateTrend(nameKey || '__anon__', wkg, now);
      if (arrow === 'up') {
        trendEl.textContent = ' \u25b2';
        trendEl.className = 'tr-trend up';
      } else if (arrow === 'down') {
        trendEl.textContent = ' \u25bc';
        trendEl.className = 'tr-trend down';
      } else {
        trendEl.textContent = '';
        trendEl.className = 'tr-trend';
      }
    }
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  };

  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true });

  if (terra.ride && terra.ride.onRide) {
    const seed = terra.ride.latest();
    if (seed) latest = seed;
    offRide = terra.ride.onRide((frame) => {
      if (!frame) return;
      latest = frame;
      if (!(window.btApp && (window.btApp.riderController || window.btApp.rideController))) {
        schedule();
      }
    });
  }

  // 5 Hz live polling when btApp.riderController is available
  btTimer = setInterval(() => {
    if (window.btApp && (window.btApp.riderController || window.btApp.rideController)) {
      schedule();
    }
  }, 200);

  const reloadSettings = () => loadSettings().then(schedule).catch((e) => terra.log('loadSettings failed: ' + e));
  if (terra.settings && terra.settings.onChange) terra.settings.onChange(reloadSettings);
  reloadSettings();

  terra.onCleanup(() => {
    if (btTimer) clearInterval(btTimer);
    mo.disconnect();
    if (offRide) offRide();
    document.querySelectorAll('.' + MARK).forEach((el) => el.remove());
  });

  terra.log('rider-speed ready');
})();
