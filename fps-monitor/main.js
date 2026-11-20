const DEFAULTS = {
  show_frame_time: false,
  show_low_1pct: false,
  show_stalls: false,
  show_cpu: false,
  show_gpu: false,
  show_render_ms: false,
  show_scene: false,
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
  '<span data-wrap="cpu"><span class="v" data-k="cpu">--</span><small data-k="cpulbl">cpu</small><small class="sub" data-k="cputemp"></small></span>',
  '<span data-wrap="gpu"><span class="v" data-k="gpu">--</span><small data-k="gpulbl">gpu</small><small class="sub" data-k="gputemp"></small></span>',
  '<span data-wrap="rm"><span class="v" data-k="rcpu">--</span><small>js</small><small class="sub" data-k="rgpu"></small></span>',
  '<span data-wrap="scene"><span class="v" data-k="draws">--</span><small>draws</small><small class="sub" data-k="tris"></small></span>',
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
const cpuEl = $k('cpu');
const cpuLblEl = $k('cpulbl');
const cpuTempEl = $k('cputemp');
const gpuEl = $k('gpu');
const gpuLblEl = $k('gpulbl');
const gpuTempEl = $k('gputemp');
const rcpuEl = $k('rcpu');
const rgpuEl = $k('rgpu');
const drawsEl = $k('draws');
const trisEl = $k('tris');
const memEl = $k('mem');
const resEl = $k('res');

const wraps = {
  fps: $w('fps'),
  low1: $w('low1'),
  ft: $w('ft'),
  stalls: $w('stalls'),
  cpu: $w('cpu'),
  gpu: $w('gpu'),
  rm: $w('rm'),
  scene: $w('scene'),
  mem: $w('mem'),
  res: $w('res'),
};

const BASE_LEFT = 10;
const ROLLING_WINDOW_MS = 10000;
const HITCH_THRESHOLD_MS = 50;

const THERMAL_SHORT = {
  none: 'ok',
  light: 'lt',
  moderate: 'mod',
  severe: 'sev',
  critical: 'crit',
  emergency: 'emerg',
  shutdown: 'shut',
};

let running = true;
let frameCount = 0;
let lastSecTime = performance.now();
let prevFrameTime = lastSecTime;
let maxFrameDt = 0;
let posTimer = 0;
const rollingFrames = []; // { t, dt }
const rollingLongTasks = []; // timestamp (ms)
let longTaskObs = null;

// Native telemetry state
let perfInFlight = false;
let perfRepollQueued = false;
let latestPerf = null;
let lastBaseFps = null;

// Biketerra 3D engine hook state
let hookedEngine = null;
let origEngineRender = null;
let wrappedEngineRender = null;
let removeBtFeature = null;
let btPollTimer = 0;
let renderCpuSum = 0;
let renderCpuCount = 0;
let gpuQueueSum = 0;
let gpuQueueCount = 0;
let gpuQueueInFlight = false;
let lastGpuQueueProbe = 0;

const formatTris = (tris) => {
  if (!Number.isFinite(tris) || tris < 0) return '';
  if (tris >= 1_000_000) return `${(tris / 1_000_000).toFixed(1)}M△`;
  if (tris >= 1000) return `${Math.round(tris / 1000)}k△`;
  return `${Math.round(tris)}△`;
};

const computeFramegenFps = (baseFps) => {
  const fg = latestPerf && latestPerf.framegen;
  if (!fg || !fg.active || baseFps == null) return null;
  if (fg.adaptive) {
    const target = fg.targetFps || 60;
    const maxMult = fg.maxMultiplier || 4;
    return baseFps >= target ? baseFps : Math.min(target, baseFps * maxMult);
  }
  const mult = fg.multiplier || 2;
  return baseFps * mult;
};

const renderFps = (baseFps) => {
  const fg = latestPerf && latestPerf.framegen;
  const fgOn = Boolean(fg && fg.active);
  wraps.fps.classList.toggle('fg-active', fgOn);
  if (baseFps == null) {
    fpsEl.textContent = '--';
    return;
  }
  const fgFps = computeFramegenFps(baseFps);
  fpsEl.textContent = fgFps != null ? `${baseFps}/${fgFps}` : String(baseFps);
};

const renderPerfStats = (p) => {
  renderFps(lastBaseFps);

  if (!p) {
    wraps.cpu.style.display = 'none';
    wraps.gpu.style.display = 'none';
    return;
  }

  if (S.show_cpu) {
    let val = null;
    let lbl = 'cpu';
    let sub = '';
    if (p.cpuPct != null) {
      val = `${Math.round(p.cpuPct)}%`;
      lbl = 'cpu';
      if (p.cpuTempC != null) sub = `${Math.round(p.cpuTempC)}°`;
    } else if (p.appCpuPct != null) {
      val = `${Math.round(p.appCpuPct)}%`;
      lbl = 'app cpu';
      if (p.cpuTempC != null) sub = `${Math.round(p.cpuTempC)}°`;
    } else if (p.cpuTempC != null) {
      val = `${Math.round(p.cpuTempC)}°`;
      lbl = 'cpu';
    }
    if (val != null) {
      cpuEl.textContent = val;
      cpuLblEl.textContent = lbl;
      cpuTempEl.textContent = sub;
      wraps.cpu.classList.toggle('has-sub', Boolean(sub));
      wraps.cpu.style.display = '';
    } else {
      wraps.cpu.style.display = 'none';
    }
  } else {
    wraps.cpu.style.display = 'none';
  }

  if (S.show_gpu) {
    let val = null;
    let lbl = 'gpu';
    let sub = '';
    if (p.gpuPct != null) {
      val = `${Math.round(p.gpuPct)}%`;
      lbl = 'gpu';
      if (p.gpuTempC != null) sub = `${Math.round(p.gpuTempC)}°`;
      else if (p.gpuProcCpuPct != null) sub = `· ${Math.round(p.gpuProcCpuPct)}% proc`;
    } else if (p.gpuTempC != null) {
      val = `${Math.round(p.gpuTempC)}°`;
      lbl = 'gpu';
      if (p.gpuProcCpuPct != null) sub = `· ${Math.round(p.gpuProcCpuPct)}% proc`;
    } else if (p.gpuProcCpuPct != null) {
      val = `${Math.round(p.gpuProcCpuPct)}%`;
      lbl = 'gpu proc';
    } else if (p.thermalStatus != null) {
      val = THERMAL_SHORT[p.thermalStatus] || p.thermalStatus;
      lbl = 'therm';
      const temp = p.cpuTempC != null ? p.cpuTempC : p.batteryTempC;
      if (temp != null) sub = `${Math.round(temp)}°`;
    } else if (p.batteryTempC != null) {
      val = `${Math.round(p.batteryTempC)}°`;
      lbl = 'batt';
    }
    if (val != null) {
      gpuEl.textContent = val;
      gpuLblEl.textContent = lbl;
      gpuTempEl.textContent = sub;
      wraps.gpu.classList.toggle('has-sub', Boolean(sub) && !sub.includes('proc'));
      wraps.gpu.classList.toggle('sub-wide', sub.includes('proc'));
      wraps.gpu.style.display = '';
    } else {
      wraps.gpu.style.display = 'none';
    }
  } else {
    wraps.gpu.style.display = 'none';
  }
};

const syncVisibility = () => {
  wraps.low1.style.display = S.show_low_1pct ? '' : 'none';
  wraps.ft.style.display = S.show_frame_time ? '' : 'none';
  wraps.stalls.style.display = S.show_stalls ? '' : 'none';
  wraps.rm.style.display = S.show_render_ms && hookedEngine ? '' : 'none';
  wraps.scene.style.display = S.show_scene && hookedEngine ? '' : 'none';
  wraps.mem.style.display = S.show_memory && performance.memory ? '' : 'none';
  wraps.res.style.display = S.show_resolution ? '' : 'none';
  renderPerfStats(latestPerf);
};
syncVisibility();

const pollPerfStats = (force = false) => {
  if (!running) return;
  if (perfInFlight) {
    if (force) perfRepollQueued = true;
    return;
  }
  if (!force && !(S.show_cpu || S.show_gpu)) return;
  if (!terra.perf || typeof terra.perf.stats !== 'function') return;

  perfInFlight = true;
  perfRepollQueued = false;
  terra.perf
    .stats()
    .then((res) => {
      if (!running || !res || res.__error) return;
      latestPerf = res;
      renderPerfStats(res);
      updatePosition();
    })
    .catch(() => {})
    .finally(() => {
      perfInFlight = false;
      if (perfRepollQueued && running) {
        perfRepollQueued = false;
        pollPerfStats(true);
      }
    });
};

const attachEngine = (eng) => {
  if (!eng || eng === hookedEngine || typeof eng.render !== 'function') return;
  if (hookedEngine && hookedEngine.render === wrappedEngineRender && origEngineRender) {
    hookedEngine.render = origEngineRender;
  }

  hookedEngine = eng;
  origEngineRender = eng.render;
  wrappedEngineRender = function (...args) {
    if (!running || (!S.show_render_ms && !S.show_scene)) {
      return origEngineRender.apply(this, args);
    }
    const t0 = performance.now();
    let res;
    try {
      res = origEngineRender.apply(this, args);
    } finally {
      if (S.show_render_ms) {
        const dt = performance.now() - t0;
        if (Number.isFinite(dt) && dt >= 0) {
          renderCpuSum += dt;
          renderCpuCount++;
        }
      }
    }
    if (S.show_render_ms && !gpuQueueInFlight) {
      try {
        const now = performance.now();
        if (now - lastGpuQueueProbe >= 200) {
          const q = eng.device && eng.device.gpu && eng.device.gpu.queue;
          if (q && typeof q.onSubmittedWorkDone === 'function') {
            gpuQueueInFlight = true;
            lastGpuQueueProbe = now;
            const q0 = now;
            Promise.resolve(q.onSubmittedWorkDone())
              .then(() => {
                const qdt = performance.now() - q0;
                if (Number.isFinite(qdt) && qdt >= 0) {
                  gpuQueueSum += qdt;
                  gpuQueueCount++;
                }
              })
              .catch(() => {})
              .finally(() => {
                gpuQueueInFlight = false;
              });
          }
        }
      } catch {}
    }
    return res;
  };
  eng.render = wrappedEngineRender;
  syncVisibility();
  updatePosition();
};

const detachEngine = () => {
  clearInterval(btPollTimer);
  btPollTimer = 0;
  if (typeof removeBtFeature === 'function') {
    try { removeBtFeature(); } catch {}
    removeBtFeature = null;
  }
  if (hookedEngine && hookedEngine.render === wrappedEngineRender && origEngineRender) {
    hookedEngine.render = origEngineRender;
  }
  hookedEngine = null;
  origEngineRender = null;
  wrappedEngineRender = null;
  renderCpuSum = 0;
  renderCpuCount = 0;
  gpuQueueSum = 0;
  gpuQueueCount = 0;
  syncVisibility();
};

const tryAttachBtApp = () => {
  if (!running || !(S.show_render_ms || S.show_scene)) return true;
  const bt = window.btApp;
  if (!bt) return false;
  if (bt.engine && typeof bt.engine.render === 'function') {
    attachEngine(bt.engine);
    return true;
  }
  if (!removeBtFeature && typeof bt.addFeature === 'function') {
    try {
      removeBtFeature = bt.addFeature((_scope, env) => ({
        frame() {
          if (env && env.engine && env.engine !== hookedEngine) {
            attachEngine(env.engine);
          }
        },
      }));
      return true;
    } catch {}
  }
  return false;
};

const syncEngineHook = () => {
  if (!(S.show_render_ms || S.show_scene)) {
    detachEngine();
    return;
  }
  if (hookedEngine || btPollTimer) return;
  if (!tryAttachBtApp()) {
    btPollTimer = setInterval(() => {
      if (tryAttachBtApp()) {
        clearInterval(btPollTimer);
        btPollTimer = 0;
      }
    }, 500);
  }
};

const syncLongTaskObserver = () => {
  if (longTaskObs) {
    try { longTaskObs.disconnect(); } catch {}
    longTaskObs = null;
  }
  if (!S.show_stalls || typeof PerformanceObserver === 'undefined') {
    wraps.stalls.classList.remove('has-longtask');
    return;
  }
  const supported = PerformanceObserver.supportedEntryTypes;
  if (!Array.isArray(supported) || !supported.includes('longtask')) {
    wraps.stalls.classList.remove('has-longtask');
    return;
  }
  try {
    longTaskObs = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) {
        if (entry.duration >= HITCH_THRESHOLD_MS) rollingLongTasks.push(now);
      }
    });
    longTaskObs.observe({ type: 'longtask', buffered: false });
    wraps.stalls.classList.add('has-longtask');
  } catch {
    longTaskObs = null;
    wraps.stalls.classList.remove('has-longtask');
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
  let nextLeft = '';
  if (shotBtn) {
    const r = shotBtn.getBoundingClientRect();
    const cs = getComputedStyle(shotBtn);
    if (r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') {
      const elRect = el.getBoundingClientRect();
      const top = elRect.height > 0 ? elRect.top : 10;
      const bottom = elRect.height > 0 ? elRect.bottom : 50;
      if (r.bottom > top && r.top < bottom && r.left < 420) {
        nextLeft = `${Math.max(BASE_LEFT, Math.ceil(r.right + 8))}px`;
      }
    }
  }
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
syncEngineHook();
pollPerfStats(true);

const unsubFramegen = terra.bus?.on
  ? terra.bus.on('terra:framegen-changed', () => {
      pollPerfStats(true);
    })
  : null;

const unsubSettings = terra.settings?.onChange
  ? terra.settings.onChange(async () => {
      try {
        S = { ...DEFAULTS, ...(await terra.settings.all()) };
      } catch {}
      syncVisibility();
      syncLongTaskObserver();
      syncEngineHook();
      pollPerfStats();
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

  if (S.show_cpu || S.show_gpu) {
    pollPerfStats();
  }

  if (S.show_render_ms && hookedEngine) {
    rcpuEl.textContent = renderCpuCount > 0 ? (renderCpuSum / renderCpuCount).toFixed(1) : '--';
    const rgpuText = gpuQueueCount > 0 ? `· ${(gpuQueueSum / gpuQueueCount).toFixed(1)} gpu` : '';
    rgpuEl.textContent = rgpuText;
    wraps.rm.classList.toggle('has-sub', Boolean(rgpuText));
    renderCpuSum = 0;
    renderCpuCount = 0;
    gpuQueueSum = 0;
    gpuQueueCount = 0;
  }

  if (S.show_scene && hookedEngine) {
    const draws = hookedEngine.drawCount;
    const tris = hookedEngine.triangleCount;
    let memMb = null;
    try {
      const st = hookedEngine.memory && typeof hookedEngine.memory.stats === 'function'
        ? hookedEngine.memory.stats()
        : null;
      if (st && Number.isFinite(st.totalBytes)) memMb = Math.round(st.totalBytes / 1048576);
    } catch {}
    drawsEl.textContent = Number.isFinite(draws) ? draws : '--';
    const subParts = [];
    const trisText = formatTris(tris);
    if (trisText) subParts.push(trisText);
    if (memMb != null) subParts.push(`${memMb}MB`);
    const trisOut = subParts.length ? `· ${subParts.join(' · ')}` : '';
    trisEl.textContent = trisOut;
    wraps.scene.classList.toggle('has-sub', Boolean(trisOut));
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
    const baseFps = Math.round((frameCount * 1000) / delta);
    lastBaseFps = baseFps;
    renderFps(baseFps);
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
  detachEngine();
  observer.disconnect();
  if (longTaskObs) {
    try { longTaskObs.disconnect(); } catch {}
  }
  if (typeof unsubSettings === 'function') unsubSettings();
  if (typeof unsubFramegen === 'function') unsubFramegen();
  window.removeEventListener('resize', schedulePositionUpdate);
  el.remove();
});

terra.log('FPS monitor ready');
