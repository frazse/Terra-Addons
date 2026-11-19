/* Render Scale — Sub-native (0.5x / 0.75x) and custom 3D render scale
 * overrides for Biketerra WebGPU and WebGL renderers without blurring HUD UI.
 */
'use strict';

(async () => {
  const log = (...a) => {
    try { terra.log('[render-scale]', ...a); } catch { try { console.log('[render-scale]', ...a); } catch {} }
  };

  if (window.__terraRenderScaleCleanup) {
    try { window.__terraRenderScaleCleanup(); } catch {}
  }

  const DEFAULTS = { scale: '0.75x' };
  let S = { ...DEFAULTS };
  try { S = { ...DEFAULTS, ...(await terra.settings.all()) }; } catch {}

  let cleaned = false;

  function parseScaleSetting(raw) {
    const str = String(raw || '').trim().toLowerCase();
    if (!str || str.startsWith('auto')) return null;
    const n = parseFloat(str.replace(/x$/i, ''));
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.max(0.25, Math.min(3.0, n));
  }

  function computeScaledDimensions(vw, vh, scale, maxTex = 8192) {
    const safeVw = Math.max(1, Math.round(Number(vw) || 1280));
    const safeVh = Math.max(1, Math.round(Number(vh) || 720));
    const limit = Math.max(256, Number(maxTex) || 8192);
    const tw = Math.max(64, Math.min(limit, Math.round(safeVw * scale)));
    const th = Math.max(64, Math.min(limit, Math.round(safeVh * scale)));
    return { vw: safeVw, vh: safeVh, tw, th };
  }

  function nativeBiketerraScale() {
    let saved = 1;
    try {
      const raw = localStorage.getItem('render-scale');
      const parsed = raw !== null ? parseFloat(JSON.parse(raw)) : 1;
      if (Number.isFinite(parsed) && parsed > 0) saved = parsed;
    } catch {}
    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);
    return Math.max(1, Math.min(dpr, saved));
  }

  // WebGPU engine state
  let gpuEng = null;
  let gpuCanvas = null;
  let origGpuResize = null;
  let wrappedGpuResize = null;
  let origGpuRender = null;
  let wrappedGpuRender = null;
  let lastGpuW = 0;
  let lastGpuH = 0;

  // WebGL fallback state
  let glApp = null;
  let glRenderer = null;
  let origGlSetPixelRatio = null;
  let wrappedGlSetPixelRatio = null;
  let origGlResize = null;
  let wrappedGlResize = null;

  let featureHookedApp = null;
  let previewStatusUpdater = null;

  function updatePreviewStatus() {
    if (typeof previewStatusUpdater === 'function') {
      try { previewStatusUpdater(); } catch {}
    }
  }

  function getViewportSize(canvas) {
    const vw = window.innerWidth || (canvas && canvas.clientWidth) || 1280;
    const vh = window.innerHeight || (canvas && canvas.clientHeight) || 720;
    return { vw, vh };
  }

  function applyWebGpuScale(eng, scale) {
    const canvas = (eng && eng.device && eng.device.context && eng.device.context.canvas) || gpuCanvas;
    if (!eng || !canvas || !origGpuResize) return false;
    gpuCanvas = canvas;

    const { vw, vh } = getViewportSize(canvas);
    const maxTex = (eng.device && eng.device.limits && eng.device.limits.maxTextureDimension2D) || 8192;
    const effScale = scale !== null ? scale : nativeBiketerraScale();
    const { tw, th } = computeScaledDimensions(vw, vh, effScale, maxTex);

    const changed = canvas.width !== tw || canvas.height !== th || lastGpuW !== tw || lastGpuH !== th;
    if (canvas.width !== tw) canvas.width = tw;
    if (canvas.height !== th) canvas.height = th;
    const cssW = `${vw}px`;
    const cssH = `${vh}px`;
    if (canvas.style.width !== cssW) canvas.style.width = cssW;
    if (canvas.style.height !== cssH) canvas.style.height = cssH;

    if (changed) {
      lastGpuW = tw;
      lastGpuH = th;
      origGpuResize.call(eng, tw, th);
      updatePreviewStatus();
    }
    return true;
  }

  function installWebGpu(eng) {
    if (!eng || !eng.device || typeof eng.resize !== 'function' || typeof eng.render !== 'function') return false;
    if (gpuEng === eng) return true;

    uninstallWebGpu(false);

    gpuEng = eng;
    gpuCanvas = (eng.device.context && eng.device.context.canvas) || document.querySelector('canvas');
    origGpuResize = eng.resize;
    origGpuRender = eng.render;
    lastGpuW = 0;
    lastGpuH = 0;

    wrappedGpuResize = function (w, h) {
      const target = !cleaned ? parseScaleSetting(S.scale) : null;
      if (cleaned || target === null) {
        return origGpuResize.call(this, w, h);
      }
      const canvas = (this.device && this.device.context && this.device.context.canvas) || gpuCanvas;
      if (!canvas) return origGpuResize.call(this, w, h);
      gpuCanvas = canvas;
      const { vw, vh } = getViewportSize(canvas);
      const maxTex = (this.device && this.device.limits && this.device.limits.maxTextureDimension2D) || 8192;
      const { tw, th } = computeScaledDimensions(vw, vh, target, maxTex);
      if (canvas.width !== tw) canvas.width = tw;
      if (canvas.height !== th) canvas.height = th;
      canvas.style.width = `${vw}px`;
      canvas.style.height = `${vh}px`;
      lastGpuW = tw;
      lastGpuH = th;
      updatePreviewStatus();
      return origGpuResize.call(this, tw, th);
    };

    wrappedGpuRender = function (fs, rq) {
      const target = !cleaned ? parseScaleSetting(S.scale) : null;
      if (!cleaned && target !== null) {
        applyWebGpuScale(this, target);
      }
      return origGpuRender.call(this, fs, rq);
    };

    eng.resize = wrappedGpuResize;
    eng.render = wrappedGpuRender;

    const target = parseScaleSetting(S.scale);
    if (target !== null) {
      applyWebGpuScale(eng, target);
      log(`WebGPU scale active: ${target}x (${lastGpuW}x${lastGpuH})`);
    } else {
      log('WebGPU hook ready (Auto mode)');
    }
    return true;
  }

  function uninstallWebGpu(restoreSize = true) {
    const eng = gpuEng;
    if (!eng) return;
    if (restoreSize) {
      try { applyWebGpuScale(eng, null); } catch {}
    }
    try {
      if (eng.resize === wrappedGpuResize && origGpuResize) eng.resize = origGpuResize;
    } catch {}
    try {
      if (eng.render === wrappedGpuRender && origGpuRender) eng.render = origGpuRender;
    } catch {}
    gpuEng = null;
    gpuCanvas = null;
    origGpuResize = null;
    wrappedGpuResize = null;
    origGpuRender = null;
    wrappedGpuRender = null;
    lastGpuW = 0;
    lastGpuH = 0;
  }

  function applyWebGlScale(scale) {
    if (!glRenderer || !origGlSetPixelRatio) return false;
    const eff = scale !== null ? scale : Math.min(1, Number(window.devicePixelRatio) || 1);
    const { vw, vh } = getViewportSize(glRenderer.domElement);
    origGlSetPixelRatio.call(glRenderer, eff);
    if (typeof glRenderer.setSize === 'function') {
      glRenderer.setSize(vw, vh);
    }
    updatePreviewStatus();
    return true;
  }

  function installWebGl(app) {
    const renderer = app && app.renderer;
    if (!renderer || typeof renderer.setPixelRatio !== 'function' || typeof renderer.setSize !== 'function') return false;
    if (glRenderer === renderer) return true;

    uninstallWebGl(false);
    glApp = app;
    glRenderer = renderer;
    origGlSetPixelRatio = renderer.setPixelRatio;

    wrappedGlSetPixelRatio = function (pr) {
      const target = !cleaned ? parseScaleSetting(S.scale) : null;
      return origGlSetPixelRatio.call(this, target !== null ? target : pr);
    };
    renderer.setPixelRatio = wrappedGlSetPixelRatio;

    if (typeof app.resize === 'function') {
      origGlResize = app.resize;
      wrappedGlResize = function () {
        const target = !cleaned ? parseScaleSetting(S.scale) : null;
        if (target !== null) {
          origGlSetPixelRatio.call(renderer, target);
        }
        const out = origGlResize.apply(this, arguments);
        updatePreviewStatus();
        return out;
      };
      app.resize = wrappedGlResize;
    }

    const target = parseScaleSetting(S.scale);
    if (target !== null) {
      applyWebGlScale(target);
      log(`WebGL scale active: ${target}x`);
    }
    return true;
  }

  function uninstallWebGl(restoreSize = true) {
    if (!glRenderer) return;
    if (restoreSize) {
      try { applyWebGlScale(null); } catch {}
    }
    try {
      if (glRenderer.setPixelRatio === wrappedGlSetPixelRatio && origGlSetPixelRatio) {
        glRenderer.setPixelRatio = origGlSetPixelRatio;
      }
    } catch {}
    try {
      if (glApp && glApp.resize === wrappedGlResize && origGlResize) {
        glApp.resize = origGlResize;
      }
    } catch {}
    glApp = null;
    glRenderer = null;
    origGlSetPixelRatio = null;
    wrappedGlSetPixelRatio = null;
    origGlResize = null;
    wrappedGlResize = null;
  }

  function applyCurrentScale() {
    if (cleaned) return;
    const target = parseScaleSetting(S.scale);
    if (gpuEng) {
      applyWebGpuScale(gpuEng, target);
      if (target === null) {
        try { window.dispatchEvent(new Event('resize')); } catch {}
      }
    } else if (glRenderer) {
      applyWebGlScale(target);
      if (target === null) {
        try { window.dispatchEvent(new Event('resize')); } catch {}
      }
    }
    updatePreviewStatus();
  }

  function probeEngine() {
    if (cleaned) return;
    const app = window.btApp;
    if (!app) return;

    if (app.engine && typeof app.engine.render === 'function' && typeof app.engine.resize === 'function') {
      if (gpuEng !== app.engine) installWebGpu(app.engine);
      return;
    }

    if (!app.engine && typeof app.addFeature === 'function' && featureHookedApp !== app) {
      featureHookedApp = app;
      try {
        app.addFeature((scope, env) => ({
          frame() {
            if (!cleaned && env && env.engine && gpuEng !== env.engine) {
              installWebGpu(env.engine);
            }
          },
        }));
      } catch {}
    }

    if (app.renderer && typeof app.renderer.setPixelRatio === 'function' && glRenderer !== app.renderer) {
      installWebGl(app);
    }
  }

  const onWindowResize = () => {
    if (cleaned) return;
    const target = parseScaleSetting(S.scale);
    if (target === null) {
      updatePreviewStatus();
      return;
    }
    requestAnimationFrame(() => {
      if (!cleaned) applyCurrentScale();
    });
  };
  window.addEventListener('resize', onWindowResize);

  const watchTimer = setInterval(probeEngine, 250);
  probeEngine();

  let unsubSettings = null;
  if (terra.settings && terra.settings.onChange) {
    unsubSettings = terra.settings.onChange(async () => {
      try { S = { ...DEFAULTS, ...(await terra.settings.all()) }; } catch {}
      const target = parseScaleSetting(S.scale);
      log('setting changed ->', S.scale, target !== null ? `(${target}x)` : '(Auto)');
      applyCurrentScale();
    });
  }

  if (terra.settings && terra.settings.preview) {
    terra.settings.preview((slot) => {
      if (!slot) {
        previewStatusUpdater = null;
        return;
      }
      const box = document.createElement('div');
      box.style.cssText = 'display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;border:1px solid rgba(56,189,248,0.28);background:rgba(15,23,42,0.85);color:#e2e8f0;font-size:12px;';
      const line1 = document.createElement('div');
      line1.style.cssText = 'font-weight:600;color:#7dd3fc;';
      const line2 = document.createElement('div');
      line2.style.cssText = 'font-size:11.5px;color:#94a3b8;';

      previewStatusUpdater = () => {
        const target = parseScaleSetting(S.scale);
        const canvas = gpuCanvas || (glRenderer && glRenderer.domElement) || document.querySelector('canvas');
        const mode = gpuEng ? 'WebGPU' : (glRenderer ? 'WebGL' : 'Waiting for 3D engine');
        const { vw, vh } = getViewportSize(canvas);
        if (canvas && canvas.width && canvas.height) {
          const eff = (canvas.width / Math.max(1, vw)).toFixed(2);
          line1.textContent = `${mode} · ${canvas.width}×${canvas.height} (${eff}x of ${vw}×${vh})`;
          line2.textContent = target !== null
            ? `Override active: ${target}x (~${Math.round(target * target * 100)}% of 1x pixel fill-rate)`
            : 'Auto mode: Biketerra controls render scale natively.';
        } else {
          line1.textContent = mode;
          line2.textContent = 'Open a /ride or /spectate page to inspect live resolution.';
        }
      };

      previewStatusUpdater();
      box.append(line1, line2);
      slot.appendChild(box);
    });
  }

  function exportHelpersForTests() {
    return {
      parseScaleSetting,
      computeScaledDimensions,
      applyCurrentScale,
      probeEngine,
    };
  }
  window.__terraRenderScaleHelpers = exportHelpersForTests;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearInterval(watchTimer);
    window.removeEventListener('resize', onWindowResize);
    try { unsubSettings && unsubSettings(); } catch {}
    previewStatusUpdater = null;
    uninstallWebGpu(true);
    uninstallWebGl(true);
    try { window.dispatchEvent(new Event('resize')); } catch {}
    if (window.__terraRenderScaleCleanup === cleanup) delete window.__terraRenderScaleCleanup;
    if (window.__terraRenderScaleHelpers === exportHelpersForTests) delete window.__terraRenderScaleHelpers;
  }

  window.__terraRenderScaleCleanup = cleanup;
  terra.onCleanup(cleanup);
  terra.onNavigate((url) => {
    if (!/^https:\/\/biketerra\.com\/(ride|spectate)/i.test(String(url || ''))) {
      cleanup();
    }
  });

  log('render-scale ready (' + S.scale + ')');
})();
