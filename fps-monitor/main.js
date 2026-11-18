const DEFAULTS = {
  show_frame_time: false,
  show_low_1pct: false,
  show_stalls: false,
  show_memory: false,
  show_resolution: false,
};

let S = { ...DEFAULTS };
try {
  S = { ...DEFAULTS, ...(await terra.settings.all()) };
} catch {}

const el = document.createElement('div');
el.id = 'terra-fps-stats';
el.innerHTML = [
  '<span data-wrap="fps"><span class="v" data-k="fps">--</span><small>fps</small></span>',
  '<span data-wrap="low1"><span class="v" data-k="low1">--</span><small>1% low</small></span>',
  '<span data-wrap="ft"><span class="v" data-k="ft">--</span><small>ms</small><small class="sub" data-k="ftmax"></small></span>',
  '<span data-wrap="stalls"><span class="v" data-k="stalls">0</span><small>hitch</small><small class="sub" data-k="jsstalls"></small></span>',
  '<span data-wrap="mem"><span class="v" data-k="mem">--</span><small>MB</small></span>',
  '<span data-wrap="res"><span class="v" data-k="res">--</span><small>px</small></span>',
].join('');
document.body.append(el);

const $k = (k) => el.querySelector(`[data-k="${k}"]`);
const $w = (k) => el.querySelector(`[data-wrap="${k}"]`);

const fpsEl = $k('fps');
const low1El = $k('low1');
const ftEl = $k('ft');
const ftMaxEl = $k('ftmax');
const stallsEl = $k('stalls');
const jsStallsEl = $k('jsstalls');
const memEl = $k('mem');
const resEl = $k('res');

const wraps = {
  low1: $w('low1'),
  ft: $w('ft'),
  stalls: $w('stalls'),
  mem: $w('mem'),
  res: $w('res'),
};

const syncVisibility = () => {
  wraps.low1.style.display = S.show_low_1pct ? '' : 'none';
  wraps.ft.style.display = S.show_frame_time ? '' : 'none';
  wraps.stalls.style.display = S.show_stalls ? '' : 'none';
  wraps.mem.style.display = S.show_memory && performance.memory ? '' : 'none';
  wraps.res.style.display = S.show_resolution ? '' : 'none';
};
syncVisibility();

const BASE_LEFT = 10;
const ROLLING_WINDOW_MS = 10000;
const HITCH_THRESHOLD_MS = 50;

let running = true;
let frameCount = 0;
let lastSecTime = performance.now();
let prevFrameTime = lastSecTime;
let maxFrameDt = 0;
let posTimer = 0;
const rollingFrames = []; // { t, dt }
const rollingLongTasks = []; // timestamp (ms)
let longTaskObs = null;

const syncLongTaskObserver = () => {
  if (longTaskObs) {
    try { longTaskObs.disconnect(); } catch {}
    longTaskObs = null;
  }
  if (!S.show_stalls || typeof PerformanceObserver === 'undefined') return;
  const supported = PerformanceObserver.supportedEntryTypes;
  if (!Array.isArray(supported) || !supported.includes('longtask')) return;
  try {
    longTaskObs = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) {
        if (entry.duration >= HITCH_THRESHOLD_MS) rollingLongTasks.push(now);
      }
    });
    longTaskObs.observe({ type: 'longtask', buffered: false });
  } catch {
    longTaskObs = null;
  }
};
syncLongTaskObserver();

const getRenderResolution = () => {
  let best = null;
  let bestArea = 0;
  for (const c of document.querySelectorAll('canvas')) {
    const area = (c.width || 0) * (c.height || 0);
    if (area > bestArea) {
      bestArea = area;
      best = c;
    }
  }
  if (best) return `${best.width}×${best.height}`;
  return `${window.innerWidth}×${window.innerHeight}`;
};

// Keep clear of Biketerra's top-left screenshot tab when screenshots exist
const updatePosition = () => {
  if (!running) return;
  const shotBtn = document.querySelector('button.shot-tab, .shot-tab');
  let targetLeft = BASE_LEFT;
  if (shotBtn) {
    const r = shotBtn.getBoundingClientRect();
    const cs = getComputedStyle(shotBtn);
    if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
      const elRect = el.getBoundingClientRect();
      const top = elRect.height > 0 ? elRect.top : 10;
      const bottom = elRect.height > 0 ? elRect.bottom : 50;
      if (r.bottom > top && r.top < bottom && r.left < 420) {
        targetLeft = Math.max(BASE_LEFT, Math.ceil(r.right + 8));
      }
    }
  }
  const nextLeft = `${targetLeft}px`;
  if (el.style.left !== nextLeft) el.style.left = nextLeft;
};

const schedulePositionUpdate = () => {
  updatePosition();
  clearTimeout(posTimer);
  posTimer = setTimeout(updatePosition, 250);
};

const observer = new MutationObserver(schedulePositionUpdate);
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style', 'aria-expanded'],
});
window.addEventListener('resize', schedulePositionUpdate);
updatePosition();

const unsubSettings = terra.settings?.onChange
  ? terra.settings.onChange(async () => {
      try {
        S = { ...DEFAULTS, ...(await terra.settings.all()) };
      } catch {}
      syncVisibility();
      syncLongTaskObserver();
      schedulePositionUpdate();
    })
  : null;

const updateExtraMetrics = (now, delta, count) => {
  const cutoff = now - ROLLING_WINDOW_MS;
  while (rollingFrames.length && rollingFrames[0].t < cutoff) rollingFrames.shift();
  while (rollingLongTasks.length && rollingLongTasks[0] < cutoff) rollingLongTasks.shift();

  if (S.show_frame_time) {
    ftEl.textContent = (delta / Math.max(1, count)).toFixed(1);
    ftMaxEl.textContent = `max ${Math.round(maxFrameDt)}`;
  }

  if (S.show_low_1pct && rollingFrames.length) {
    const sorted = rollingFrames.map((f) => f.dt).sort((a, b) => b - a);
    const nSlow = Math.max(1, Math.ceil(sorted.length * 0.01));
    let sum = 0;
    for (let i = 0; i < nSlow; i++) sum += sorted[i];
    const avgSlow = sum / nSlow;
    low1El.textContent = avgSlow > 0 ? Math.round(1000 / avgSlow) : '--';
  }

  if (S.show_stalls) {
    let hitches = 0;
    for (const f of rollingFrames) {
      if (f.dt >= HITCH_THRESHOLD_MS) hitches++;
    }
    stallsEl.textContent = hitches;
    jsStallsEl.textContent = rollingLongTasks.length ? `· ${rollingLongTasks.length} js` : '';
  }

  if (S.show_memory && performance.memory) {
    memEl.textContent = Math.round(performance.memory.usedJSHeapSize / 1048576);
  }

  if (S.show_resolution) {
    resEl.textContent = getRenderResolution();
  }
};

// Calculate and update FPS every second
const loop = (now) => {
  if (!running) return;
  frameCount++;

  const frameDt = now - prevFrameTime;
  prevFrameTime = now;
  if (frameDt > 0 && frameDt <= 2000) {
    if (frameDt > maxFrameDt) maxFrameDt = frameDt;
    if (S.show_low_1pct || S.show_stalls) {
      rollingFrames.push({ t: now, dt: frameDt });
    }
  }

  const delta = now - lastSecTime;
  if (delta >= 1000) {
    fpsEl.textContent = Math.round((frameCount * 1000) / delta);
    updateExtraMetrics(now, delta, frameCount);
    frameCount = 0;
    maxFrameDt = 0;
    lastSecTime = now;
    updatePosition();
  }

  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

terra.onCleanup(() => {
  running = false;
  clearTimeout(posTimer);
  observer.disconnect();
  if (longTaskObs) {
    try { longTaskObs.disconnect(); } catch {}
  }
  if (typeof unsubSettings === 'function') unsubSettings();
  window.removeEventListener('resize', schedulePositionUpdate);
  el.remove();
});

terra.log('FPS monitor ready');
