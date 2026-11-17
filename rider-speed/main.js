(() => {
  const MARK = 'tr-rider-speed'; // class + data attribute on injected spans

  let unit = 'km/h';
  let factor = 3.6; // frame speed is m/s
  let latest = null; // newest ride frame
  let offRide = null;

  async function loadUnit() {
    const v = String((await terra.settings.get('speed_unit', 'km/h')) || 'km/h').trim().toLowerCase();
    if (v === 'mph') { unit = 'mph'; factor = 2.236936; }
    else { unit = 'km/h'; factor = 3.6; }
  }

  const fmt = (ms) => (ms * factor).toFixed(1);

  // Frame riders carry the name; ego is the rider marked .is-me in the list.
  function speedFor(row) {
    if (!latest) return null;
    if (row.classList.contains('is-me') && latest.ego && Number.isFinite(latest.ego.speed)) {
      return latest.ego.speed;
    }
    const nameEl = row.querySelector('.rider-name');
    const riders = latest.riders;
    if (nameEl && Array.isArray(riders)) {
      const name = nameEl.textContent.trim();
      for (const r of riders) {
        if (r && (r.name || '').trim() === name && Number.isFinite(r.speed)) return r.speed;
      }
    }
    return null;
  }

  function apply() {
    for (const row of document.querySelectorAll('.rider')) {
      const stats = row.querySelector('.rider-stats');
      if (!stats) continue;
      const ms = speedFor(row);
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
        const num = document.createElement('span');
        num.className = 'num monospace';
        const u = document.createElement('span');
        u.className = 'unit';
        // Trailing space (inside our span, survives Svelte re-renders) keeps a
        // single word-space between the unit and the W/kg value.
        s.append(num, ' ', u, ' ');
        span = s;
        stats.append(span);
      }
      // Keep the speed to the left of the W/kg value, even if Svelte reorders the row.
      const value = stats.querySelector('.rider-stat-value');
      if (value) {
        if (value.previousElementSibling !== span) stats.insertBefore(span, value);
      } else if (stats.firstElementChild !== span) {
        stats.prepend(span);
      }
      span.querySelector('.unit').textContent = unit;
      span.querySelector('.num').textContent = fmt(ms);
    }
  }

  // The rider list is a live Svelte component: DOM churn (rows added, stats updated)
  // can drop or reshuffle our spans, so reconcile on DOM changes and ride frames alike.
  // apply() is idempotent, so our own inserts do not loop the observer.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; apply(); });
  };

  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { childList: true, subtree: true });

  if (terra.ride.onRide) {
    const seed = terra.ride.latest();
    if (seed) latest = seed;
    offRide = terra.ride.onRide((frame) => {
      if (!frame) return;
      latest = frame;
      schedule();
    });
  }

  const applyUnit = () => loadUnit().then(schedule).catch((e) => terra.log('loadUnit failed: ' + e));
  if (terra.settings.onChange) terra.settings.onChange(applyUnit);
  applyUnit();

  terra.onCleanup(() => {
    mo.disconnect();
    if (offRide) offRide();
    document.querySelectorAll('.' + MARK).forEach((el) => el.remove());
  });

  terra.log('rider-speed ready');
})();
