/* sbs3d v0.8 — Side-by-Side Stereo 3D for Viture XR glasses.
 * Single-window double-render WebGPU stereo 3D + 3D Depth Scale & Convergence Distance
 * + 50vw Left-Eye Root & Right-Eye Mirror + Stereo 3D Mouse Cursor & Input Bridge.
 */
(async function () {
  'use strict';

  const log = (...a) => { try { terra.log('[sbs3d]', ...a); } catch (e) { try { console.log('[sbs3d]', ...a); } catch (e2) {} } };

  /* ── state ────────────────────────────────────────────────────────────────── */
  const S = {
    eng: null, gpu: null, ctx: null, format: null,
 left: null, right: null, leftView: null, rightView: null,
 sampler: null, compositePipeline: null, compositeGroup: null,
 ew: 0, eh: 0, offW: 0, offH: 0, aspect: 1,
 savedGetTex: null,
 enabled: true,
 hudMirror: true,
 hudDepth: 6,          // px inward convergence so HUD floats slightly in front
 ipd: 0.060,           // metres; physical Viture IPD ≈ 58–72mm, default 60mm
 depthScale: 1.5,      // 3D depth multiplier (0.0x = flat 2D, 1.0x = 1:1, 1.5x–5.0x = enhanced 3D depth)
convergence: 6.0,     // metres; zero-parallax distance (objects at this distance sit at screen depth)
swap: false,          // if parallax is inverted, flip left/right
 errors: 0, warned: false, disabled: false, err: null,
 frames: 0,
 el: null, statusEl: null,
  };

  /* ── persistent storage ───────────────────────────────────────────────────── */
  let saveTimer = 0;
  try {
    if (typeof terra !== 'undefined' && terra.storage?.get) {
      const saved = await terra.storage.get('sbs3dConfig', null);
      if (saved && typeof saved === 'object') {
        if (typeof saved.enabled === 'boolean') S.enabled = saved.enabled;
        if (typeof saved.hudMirror === 'boolean') S.hudMirror = saved.hudMirror;
        if (Number.isFinite(saved.hudDepth)) S.hudDepth = saved.hudDepth;
        if (Number.isFinite(saved.ipd)) S.ipd = saved.ipd;
        if (Number.isFinite(saved.depthScale)) S.depthScale = saved.depthScale;
        if (Number.isFinite(saved.convergence)) S.convergence = saved.convergence;
        if (typeof saved.swap === 'boolean') S.swap = saved.swap;
      }
    }
  } catch (e) {}

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        if (typeof terra !== 'undefined' && terra.storage?.set) {
          terra.storage.set('sbs3dConfig', {
            enabled: S.enabled,
            hudMirror: S.hudMirror,
            hudDepth: S.hudDepth,
            ipd: S.ipd,
            depthScale: S.depthScale,
            convergence: S.convergence,
            swap: S.swap,
          }).catch?.(() => {});
        }
      } catch (e) {}
    }, 350);
  }

  function rightAxis(cam) {
    try {
      const v = cam.view;
      let r = [v[0], v[4], v[8]];
      const len = Math.hypot(r[0], r[1], r[2]);
      if (len > 1e-6) return [r[0] / len, r[1] / len, r[2] / len];
    } catch (e) {}
    try {
      const f = cam.fwd;
      let rx = -f.z, ry = 0, rz = f.x;
      const len = Math.hypot(rx, ry, rz) || 1;
      return [rx / len, ry / len, rz / len];
    } catch (e2) {
      return [1, 0, 0];
    }
  }

  function rotationFromView(cam) {
    const v = cam.view;
    return [v[0], v[4], v[8], v[1], v[5], v[9], v[2], v[6], v[10]];
  }

  // Rotate camera basis [R(0..2), U(3..5), B(6..8)] around its local Up axis by `angleRad`
  // for toe-in convergence at `S.convergence` metres.
  function yawBasisAroundUp(rot, angleRad) {
    if (!angleRad || Math.abs(angleRad) < 1e-6) return rot;
    const c = Math.cos(angleRad), s = Math.sin(angleRad);
    const rx = rot[0], ry = rot[1], rz = rot[2];
    const ux = rot[3], uy = rot[4], uz = rot[5];
    const bx = rot[6], by = rot[7], bz = rot[8];
    return [
      rx * c + bx * s, ry * c + by * s, rz * c + bz * s,
      ux,              uy,              uz,
      bx * c - rx * s, by * c - ry * s, bz * c - rz * s,
    ];
  }

  function bumpError(stage, e) {
    S.errors++;
    if (S.errors > 3) { S.disabled = true; S.err = String(e); if (S.statusEl) paintStatus(); }
    else if (!S.warned) { S.warned = true; log('⚠️ sbs3d ' + stage + ' error (' + S.errors + '/3): ' + e); }
  }

  /* ── Fast 1:1 Dual-Eye HUD Mirror ────────────────────────────────────────── */
  let hudRoot = null;
  let gameCanvas = null;
  let mirrorContainer = null;
  let hudObs = null;
  let fullRebuildQueued = false;
  const srcToMirror = new WeakMap();
  const canvasPairs = [];

  function findHudRoot() {
    const c = (S.ctx && S.ctx.canvas) || document.getElementById('ride-canvas') || document.querySelector('canvas');
    if (!c) return null;
    let p = c.parentElement;
    while (p && p !== document.body) {
      const kids = [...p.children].filter(el => el !== c && el.id !== 'sbs3d-hud-mirror' && el.id !== 'sbs3d-cursor' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE');
      if (kids.length > 0) return { root: p, canvas: c };
      p = p.parentElement;
    }
    return { root: document.body, canvas: c };
  }

  function pinToEyeViewport(srcEl) {
    if (!srcEl || srcEl.nodeType !== 1) return;
    const cs = window.getComputedStyle(srcEl);
    if (cs.position === 'fixed') {
      srcEl.classList.add('sbs3d-fixed-to-abs');
    }
    for (const child of srcEl.children) {
      pinToEyeViewport(child);
    }
  }

  function cloneAndMapSubtree(srcNode) {
    if (srcNode.nodeType === 1 && S.enabled && S.hudMirror) {
      pinToEyeViewport(srcNode);
    }
    const clone = srcNode.cloneNode(false);
    if (clone.nodeType === 1) {
      if (srcNode.tagName === 'CANVAS') {
        canvasPairs.push({ src: srcNode, dst: clone });
      }
      if (srcNode.tagName === 'INPUT') {
        clone.value = srcNode.value;
      }
      fixFullWidthPixelPos(srcNode, clone);
    }
    srcToMirror.set(srcNode, clone);

    let child = srcNode.firstChild;
    while (child) {
      clone.appendChild(cloneAndMapSubtree(child));
      child = child.nextSibling;
    }
    return clone;
  }

  const PX_TRANSLATE_RE = /translate(?:3d)?\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px/i;
  function fixFullWidthPixelPos(srcEl, dstEl) {
    if (!srcEl || srcEl.nodeType !== 1 || !S.enabled || !S.hudMirror) return;
    const rawStyle = srcEl.getAttribute('style');
    if (!rawStyle) {
      if (dstEl) dstEl.removeAttribute('style');
      return;
    }

    const m = rawStyle.match(PX_TRANSLATE_RE);
    if (m) {
      const x = parseFloat(m[1]);
      const halfW = window.innerWidth * 0.5;
      if (x > halfW * 0.65) {
        const halfX = (x * 0.5).toFixed(1);
        const patched = rawStyle.replace(PX_TRANSLATE_RE, (full, _x) => full.replace(`${_x}px`, `${halfX}px`));
        if (dstEl) dstEl.setAttribute('style', patched);
        srcEl.style.marginLeft = `${-(x * 0.5).toFixed(1)}px`;
        if (dstEl) dstEl.style.marginLeft = '0px';
        return;
      }
    }
    if (dstEl) dstEl.setAttribute('style', rawStyle);
  }

  function syncHudCanvases() {
    if (!S.enabled || !S.hudMirror) return;
    for (let i = canvasPairs.length - 1; i >= 0; i--) {
      const { src, dst } = canvasPairs[i];
      if (!src.isConnected || !dst.isConnected) {
        canvasPairs.splice(i, 1);
        continue;
      }
      if (src.width === 0 || src.height === 0) continue;
      try {
        if (dst.width !== src.width) dst.width = src.width;
        if (dst.height !== src.height) dst.height = src.height;
        const ctx2d = dst.getContext('2d');
        if (ctx2d) {
          ctx2d.clearRect(0, 0, dst.width, dst.height);
          ctx2d.drawImage(src, 0, 0);
        }
      } catch (e) {}
    }
  }

  function isIgnoredHudNode(el, canvasEl) {
    if (!el || el.nodeType !== 1) return false;
    if (el === canvasEl || el.contains(canvasEl)) return true;
    if (el.id === 'sbs3d-hud-mirror' || el.id === 'sbs3d-cursor' || el.id === 'svelte-announcer' || el.id?.startsWith('btz-')) return true;
    if (el.classList?.contains('sbs-probe-chip') || (el.textContent || '').includes('SBS Probe')) return true;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') return true;
    return false;
  }

  function fullRebuildHudMirror() {
    fullRebuildQueued = false;
    canvasPairs.length = 0;

    if (!S.enabled || !S.hudMirror) {
      document.documentElement.classList.remove('sbs3d-hud-active');
      document.querySelectorAll('.sbs3d-hud-root').forEach(el => el.classList.remove('sbs3d-hud-root'));
      document.querySelectorAll('.sbs3d-game-canvas').forEach(el => el.classList.remove('sbs3d-game-canvas'));
      document.querySelectorAll('.sbs3d-hud-src').forEach(el => el.classList.remove('sbs3d-hud-src'));
      document.querySelectorAll('.sbs3d-fixed-to-abs').forEach(el => el.classList.remove('sbs3d-fixed-to-abs'));
      if (mirrorContainer) mirrorContainer.style.display = 'none';
      return;
    }

    const found = findHudRoot();
    if (!found) return;
    hudRoot = found.root;
    gameCanvas = found.canvas;

    document.documentElement.classList.add('sbs3d-hud-active');
    hudRoot.classList.add('sbs3d-hud-root');
    gameCanvas.classList.add('sbs3d-game-canvas');

    const shift = S.swap ? -S.hudDepth : S.hudDepth;
    document.documentElement.style.setProperty('--sbs-hud-shift', shift + 'px');

    if (!mirrorContainer) {
      mirrorContainer = document.createElement('div');
      mirrorContainer.id = 'sbs3d-hud-mirror';
      document.body.appendChild(mirrorContainer);
    }
    mirrorContainer.style.display = 'block';

    const frag = document.createDocumentFragment();
    const rootsToScan = hudRoot === document.body ? [document.body] : [hudRoot, document.body];
    const seen = new Set();

    for (const rootEl of rootsToScan) {
      for (const el of rootEl.children) {
        if (seen.has(el) || isIgnoredHudNode(el, gameCanvas)) continue;
        if (el === hudRoot) continue;
        seen.add(el);
        el.classList.add('sbs3d-hud-src');
        frag.appendChild(cloneAndMapSubtree(el));
      }
    }

    mirrorContainer.replaceChildren(frag);
    syncHudCanvases();
  }

  function queueFullRebuild() {
    if (fullRebuildQueued) return;
    fullRebuildQueued = true;
    requestAnimationFrame(fullRebuildHudMirror);
  }

  function startHudObserver() {
    if (hudObs) hudObs.disconnect();
    fullRebuildHudMirror();

    hudObs = new MutationObserver((mutations) => {
      if (!S.enabled || !S.hudMirror) return;

      for (const m of mutations) {
        const t = m.target;
        if (t && t.nodeType === 1 && (t.id === 'sbs3d-hud-mirror' || t.id === 'sbs3d-cursor' || t.closest?.('#sbs3d-hud-mirror, #sbs3d-cursor'))) {
          continue;
        }

        if (m.type === 'characterData') {
          const mirrorNode = srcToMirror.get(t);
          if (mirrorNode) {
            mirrorNode.nodeValue = t.nodeValue;
          } else {
            queueFullRebuild();
            return;
          }
        } else if (m.type === 'attributes') {
          const mirrorEl = srcToMirror.get(t);
          if (mirrorEl && mirrorEl.nodeType === 1) {
            const attr = m.attributeName;
            if (attr === 'style') {
              fixFullWidthPixelPos(t, mirrorEl);
            } else if (attr === 'class') {
              mirrorEl.className = t.className;
            } else if (attr === 'value' && t.tagName === 'INPUT') {
              mirrorEl.value = t.value;
            } else {
              const val = t.getAttribute(attr);
              if (val === null) mirrorEl.removeAttribute(attr);
              else mirrorEl.setAttribute(attr, val);
            }
          } else {
            queueFullRebuild();
            return;
          }
        } else if (m.type === 'childList') {
          queueFullRebuild();
          return;
        }
      }
    });

    hudObs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'd', 'transform', 'width', 'height', 'viewBox', 'aria-pressed', 'hidden', 'open', 'value'],
    });
  }

  function stopHudObserver() {
    if (hudObs) { hudObs.disconnect(); hudObs = null; }
    document.documentElement.classList.remove('sbs3d-hud-active');
    document.querySelectorAll('.sbs3d-hud-root').forEach(el => el.classList.remove('sbs3d-hud-root'));
    document.querySelectorAll('.sbs3d-game-canvas').forEach(el => el.classList.remove('sbs3d-game-canvas'));
    document.querySelectorAll('.sbs3d-fixed-to-abs').forEach(el => el.classList.remove('sbs3d-fixed-to-abs'));
    document.querySelectorAll('.sbs3d-hud-src').forEach((el) => {
      el.classList.remove('sbs3d-hud-src');
      el.style.marginLeft = '';
    });
    if (mirrorContainer) { mirrorContainer.remove(); mirrorContainer = null; }
  }

  /* ── Stereo Cursor & Right-Eye -> Left-Eye Interactive Input Bridge ───────── */
  const cursorEl = document.createElement('div');
  cursorEl.id = 'sbs3d-cursor';
  cursorEl.innerHTML = '<svg viewBox="0 0 18 24" width="18" height="24" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M1 1L1 19L5.5 14.5L9.2 22L12 20.5L8.3 13L15 13L1 1Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/>' +
  '</svg>';
  document.body.appendChild(cursorEl);

  let cursorHideTimer = 0;
  let forwardingEvent = false;

  function rightToLeftX(clientX) {
    const halfW = window.innerWidth * 0.5;
    const shift = S.swap ? -S.hudDepth : S.hudDepth;
    return clientX - halfW + 2 * shift;
  }

  function updateStereoCursor(e) {
    if (!S.enabled || !S.hudMirror || !e.isTrusted) {
      cursorEl.style.display = 'none';
      return;
    }
    const halfW = window.innerWidth * 0.5;
    const shift = S.swap ? -S.hudDepth : S.hudDepth;
    const mirrorX = e.clientX < halfW
    ? (e.clientX + halfW - 2 * shift)
    : (e.clientX - halfW + 2 * shift);

    cursorEl.style.display = 'block';
    cursorEl.style.transform = `translate3d(${Math.round(mirrorX)}px, ${Math.round(e.clientY)}px, 0)`;

    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => { cursorEl.style.display = 'none'; }, 3000);
  }

  function forwardRightEyeEvent(e) {
    if (forwardingEvent || !S.enabled || !S.hudMirror || !e.isTrusted) return;
    const halfW = window.innerWidth * 0.5;
    if (e.clientX < halfW) return;

    const lx = rightToLeftX(e.clientX);
    const ly = e.clientY;
    if (lx < 0 || lx >= halfW) return;

    const target = document.elementFromPoint(lx, ly);
    if (!target || target === gameCanvas || (target.tagName === 'CANVAS' && target.classList.contains('sbs3d-game-canvas'))) {
      return;
    }

    e.stopPropagation();
    if (e.type === 'click' || e.type === 'mousedown' || e.type === 'pointerdown') {
      e.preventDefault();
    }

    forwardingEvent = true;
    try {
      if (e.type === 'click') {
        if (target.tagName === 'INPUT' && target.type === 'range') {
          const r = target.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (lx - r.left) / (r.width || 1)));
          const min = parseFloat(target.min || 0);
          const max = parseFloat(target.max || 100);
          const step = parseFloat(target.step || 1);
          const val = Math.round((min + pct * (max - min)) / step) * step;
          target.value = val;
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          target.click();
        }
      } else if (e.type === 'wheel') {
        target.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, view: window,
          clientX: lx, clientY: ly,
          deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode,
        }));
      } else if (e.type.startsWith('pointer')) {
        target.dispatchEvent(new PointerEvent(e.type, {
          bubbles: true, cancelable: true, view: window,
          clientX: lx, clientY: ly, screenX: lx, screenY: ly,
          button: e.button, buttons: e.buttons,
          pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary,
        }));
      } else {
        target.dispatchEvent(new MouseEvent(e.type, {
          bubbles: true, cancelable: true, view: window,
          clientX: lx, clientY: ly, screenX: lx, screenY: ly,
          button: e.button, buttons: e.buttons,
        }));
      }
    } finally {
      forwardingEvent = false;
    }
  }

  const FORWARD_TYPES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel'];
  addEventListener('pointermove', updateStereoCursor, { capture: true, passive: true });
  for (const t of FORWARD_TYPES) {
    addEventListener(t, forwardRightEyeEvent, { capture: true });
  }

  function cleanupStereoPointer() {
    clearTimeout(cursorHideTimer);
    removeEventListener('pointermove', updateStereoCursor, { capture: true });
    for (const t of FORWARD_TYPES) {
      removeEventListener(t, forwardRightEyeEvent, { capture: true });
    }
    try { cursorEl.remove(); } catch (e) {}
  }

  /* ── WebGPU resources ─────────────────────────────────────────────────────── */
  function ensureResources(backbufTex) {
    const cw = backbufTex.width;
    const ch = backbufTex.height;
    const fmt = backbufTex.format || S.format || 'bgra8unorm';

    if (S.left && S.right && S.compositePipeline && S.offW === cw && S.offH === ch && S.format === fmt) {
      return;
    }

    try { if (S.left) S.left.destroy(); } catch (e) {}
    try { if (S.right) S.right.destroy(); } catch (e) {}

    S.format = fmt;
    S.offW = cw;
    S.offH = ch;
    S.ew = Math.max(1, Math.floor(cw / 2));
    S.eh = Math.max(1, ch);
    S.aspect = S.ew / S.eh;

    const eyeTex = (eye) => S.gpu.createTexture({
      label: 'sbs3d-eye-' + eye,
      size: { width: S.offW, height: S.offH, depthOrArrayLayers: 1 },
      format: S.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    S.left = eyeTex('L');
    S.right = eyeTex('R');
    S.leftView = S.left.createView();
    S.rightView = S.right.createView();

    if (!S.sampler) {
      S.sampler = S.gpu.createSampler({
        label: 'sbs3d-sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      });
    }

    const wgsl = `
    @group(0) @binding(0) var texL : texture_2d<f32>;
    @group(0) @binding(1) var texR : texture_2d<f32>;
    @group(0) @binding(2) var samp : sampler;

    @vertex fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
      var p = array<vec4f, 3>(
        vec4f(-1.0, -1.0, 0.0, 1.0),
                              vec4f( 3.0, -1.0, 0.0, 1.0),
                              vec4f(-1.0,  3.0, 0.0, 1.0)
      );
      return p[vi];
    }

    @fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
      let dims = vec2f(textureDimensions(texL, 0));
      let eyeW = dims.x * 0.5;
      let eyeH = dims.y;
      let right = pos.x >= eyeW;
      let localX = (pos.x - select(0.0, eyeW, right)) / eyeW;
      let localY = pos.y / eyeH;
      let uv = vec2f(localX, localY);
      if (right) {
        return textureSampleLevel(texR, samp, uv, 0.0);
      }
      return textureSampleLevel(texL, samp, uv, 0.0);
    }
    `;

    const module = S.gpu.createShaderModule({ label: 'sbs3d-composite', code: wgsl });
    S.compositePipeline = S.gpu.createRenderPipeline({
      label: 'sbs3d-pipeline',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: S.format }] },
      primitive: { topology: 'triangle-list' },
      multisample: { count: 1 },
    });

    S.compositeGroup = S.gpu.createBindGroup({
      label: 'sbs3d-group',
      layout: S.compositePipeline.getBindGroupLayout(0),
                                             entries: [
                                               { binding: 0, resource: S.leftView },
                                               { binding: 1, resource: S.rightView },
                                               { binding: 2, resource: S.sampler },
                                             ],
    });

    log(`sbs3d resources ready: offscreen=${S.offW}x${S.offH} eye=${S.ew}x${S.eh} format=${S.format}`);
  }

  /* ── the render wrap ──────────────────────────────────────────────────────── */
  function installSBS(eng) {
    const D = eng.device;
    S.gpu = D.gpu;
    S.ctx = D.context;
    S.format = D.format || (navigator.gpu && navigator.gpu.getPreferredCanvasFormat ? navigator.gpu.getPreferredCanvasFormat() : 'bgra8unorm');

    S.savedGetTex = S.ctx.getCurrentTexture;
    const realRender = window.__btRealRender || eng.render;
    window.__btRealRender = realRender; // Expose raw engine render so pip-cam can render single-eye views cleanly!

    startHudObserver();

    eng.render = function (fs, rq) {
      if (!S.enabled || S.disabled) { realRender.call(this, fs, rq); return; }

      let realBackbufTex = null;
      let cam = null, orig = null;
      try {
        realBackbufTex = S.savedGetTex.call(S.ctx);
        if (!realBackbufTex || !realBackbufTex.width || !realBackbufTex.height) {
          realRender.call(this, fs, rq);
          return;
        }
        ensureResources(realBackbufTex);

        cam = fs && fs.camera;
        if (!cam || typeof cam.update !== 'function' || !cam.view) {
          realRender.call(this, fs, rq);
          return;
        }
        orig = {
          wp: { x: cam.worldPosition.x, y: cam.worldPosition.y, z: cam.worldPosition.z },
          rotation: rotationFromView(cam),
                                             fov: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far, zoom: cam.zoom,
                                             origin: fs.origin,
        };
      } catch (e) {
        bumpError('setup', e);
        realRender.call(this, fs, rq);
        return;
      }

      const r = rightAxis(cam);
      // Effective stereo separation = IPD × 3D Depth Scale
      const effIpd = S.ipd * S.depthScale;
      const off = (effIpd / 2) * (S.swap ? -1 : 1);

      // Toe-in convergence angle so objects at `S.convergence` metres sit at zero parallax (screen plane)
      const convDist = Math.max(0.5, S.convergence || 6.0);
      const toeAngle = Math.atan2(off, convDist);
      const rotL = yawBasisAroundUp(orig.rotation, -toeAngle);
      const rotR = yawBasisAroundUp(orig.rotation, +toeAngle);

      const base = { fov: orig.fov, aspect: S.aspect, near: orig.near, far: orig.far, zoom: orig.zoom, origin: orig.origin };
      let frameOK = false;

      try {
        // LEFT eye → left offscreen
        cam.update({
          worldPosition: { x: orig.wp.x - r[0] * off, y: orig.wp.y - r[1] * off, z: orig.wp.z - r[2] * off },
          rotation: rotL,
          ...base
        });
        S.ctx.getCurrentTexture = () => S.left;
        realRender.call(this, fs, rq);

        // RIGHT eye → right offscreen
        cam.update({
          worldPosition: { x: orig.wp.x + r[0] * off, y: orig.wp.y + r[1] * off, z: orig.wp.z + r[2] * off },
          rotation: rotR,
          ...base
        });
        S.ctx.getCurrentTexture = () => S.right;
        realRender.call(this, fs, rq);
        frameOK = true;
      } catch (e) {
        bumpError('render', e);
      } finally {
        try { S.ctx.getCurrentTexture = S.savedGetTex; } catch (e2) {}
        try { cam.update({ worldPosition: orig.wp, rotation: orig.rotation, ...base, aspect: orig.aspect }); } catch (e2) {}
      }

      if (frameOK && S.compositePipeline && realBackbufTex) {
        try {
          const backbufView = realBackbufTex.createView();
          const enc = S.gpu.createCommandEncoder();
          const rp = enc.beginRenderPass({
            colorAttachments: [{ view: backbufView, loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
          });
          rp.setPipeline(S.compositePipeline);
          rp.setBindGroup(0, S.compositeGroup);
          rp.draw(3);
          rp.end();
          S.gpu.queue.submit([enc.finish()]);
          S.frames++;
          if (S.errors > 0) S.errors = 0;
        } catch (e) {
          bumpError('composite', e);
        }
      }

      if (S.frames % 6 === 0 && S.hudMirror) syncHudCanvases();
      if (S.frames % 30 === 0) paintStatus();
    };
  }

  function uninstallSBS() {
    stopHudObserver();
    try { if (S.left) S.left.destroy(); } catch (e) {}
    try { if (S.right) S.right.destroy(); } catch (e) {}
    S.left = S.right = S.leftView = S.rightView = null;
    S.compositePipeline = S.compositeGroup = null;
  }

  /* ── overlay + Dual-Eye HUD CSS ───────────────────────────────────────────── */
  terra.ui.addStyle(
    ':root { --sbs-hud-shift: 6px; }' +
    'html.sbs3d-hud-active body,' +
    'html.sbs3d-hud-active .sbs3d-hud-root {' +
    '  position: fixed !important; top: 0 !important; left: 0 !important;' +
    '  width: 50vw !important; height: 100vh !important; margin: 0 !important;' +
    '}' +
    'html.sbs3d-hud-active canvas.sbs3d-game-canvas {' +
    '  position: fixed !important; top: 0 !important; left: 0 !important;' +
    '  width: 100vw !important; height: 100vh !important; max-width: none !important;' +
    '}' +
    'html.sbs3d-hud-active .sbs3d-fixed-to-abs {' +
    '  position: absolute !important;' +
    '}' +
    'html.sbs3d-hud-active .sbs3d-hud-root > .sbs3d-hud-src,' +
    'html.sbs3d-hud-active body > .sbs3d-hud-src {' +
    '  margin-left: var(--sbs-hud-shift, 6px);' +
    '}' +
    '#sbs3d-hud-mirror {' +
    '  position: fixed !important; top: 0 !important; left: 50vw !important;' +
    '  width: 50vw !important; height: 100vh !important;' +
    '  pointer-events: none !important; user-select: none !important;' +
    '  overflow: hidden !important; z-index: 2147483640 !important;' +
    '  contain: layout paint !important;' +
    '  transform: translateZ(0) !important;' +
    '}' +
    '#sbs3d-hud-mirror > .sbs3d-hud-src {' +
    '  margin-left: calc(-1 * var(--sbs-hud-shift, 6px)) !important;' +
    '}' +
    '#sbs3d-cursor {' +
    '  position: fixed !important; top: 0 !important; left: 0 !important;' +
    '  width: 18px !important; height: 24px !important;' +
    '  pointer-events: none !important; z-index: 2147483647 !important;' +
    '  display: none;' +
    '  filter: drop-shadow(0 2px 4px rgba(0,0,0,0.65));' +
    '}' +
    '.sbs3d-chip{position:fixed;top:10px;left:96px;z-index:2147483647;background:#0aa;color:#04141a;' +
    'border:1px solid #0dd;border-radius:8px;padding:6px 11px;cursor:pointer;font:600 12px/1 -apple-system,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.4);}' +
    '.sbs3d-ov{position:fixed;top:44px;left:96px;z-index:2147483647;width:390px;' +
    'display:none;flex-direction:column;gap:8px;background:rgba(6,22,26,0.96);color:#cfffff;border:1px solid #0d7;border-radius:10px;' +
    'padding:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;user-select:none;}' +
    '.sbs3d-ov .row{display:flex;align-items:center;justify-content:space-between;gap:5px;}' +
    '.sbs3d-ov .row label{flex:1;color:#9fe;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
    '.sbs3d-ov input[type=range]{width:118px;accent-color:#0dd;cursor:pointer;margin:0;}' +
    '.sbs3d-ov .sbs-step{padding:1px 5px;font-size:11px;line-height:1.1;background:#09292e;color:#8fe;border:1px solid #078;border-radius:4px;cursor:pointer;}' +
    '.sbs3d-ov .sbs-val{width:64px;text-align:right;color:#fff;font-size:11px;font-variant-numeric:tabular-nums;cursor:text;padding:1px 4px;border-radius:4px;border:1px solid transparent;background:rgba(0,0,0,0.25);}' +
    '.sbs3d-ov .sbs-val:hover{border-color:#0aa;background:#04181c;}' +
    '.sbs3d-ov .sbs-val-edit{width:64px;text-align:right;color:#0ff;font:inherit;font-size:11px;padding:1px 4px;border-radius:4px;border:1px solid #0ff;background:#021014;outline:none;box-sizing:border-box;}' +
    '.sbs3d-ov button.toggle-btn{background:#0a4;color:#031;border:1px solid #0dd;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit;font-weight:700;}' +
    '.sbs3d-ov button.toggle-btn.off{background:#12383d;color:#8cc;border-color:#078;font-weight:400;}' +
    '.sbs3d-ov button:hover{filter:brightness(1.15);}' +
    '.sbs3d-ov .st{color:#8fe;font-size:11px;white-space:pre-wrap;border-bottom:1px solid rgba(0,220,220,0.2);padding-bottom:6px;}'
  );

  const chip = document.createElement('button'); chip.type = 'button'; chip.id = 'sbs3d-chip'; chip.className = 'sbs3d-chip';
  chip.textContent = '🥽 SBS 3D';
  const ov = document.createElement('div'); ov.id = 'sbs3d-ov'; ov.className = 'sbs3d-ov';
  const statusEl = document.createElement('div'); statusEl.className = 'st';
  ov.appendChild(statusEl);

  function addSliderRow(label, min, max, step, getVal, setVal, unit, defVal) {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    l.title = 'Double-click slider to reset • Click number to type exact value • Shift=10x step, Alt=0.1x step';

    const btnMinus = document.createElement('button');
    btnMinus.type = 'button';
    btnMinus.className = 'sbs-step';
    btnMinus.textContent = '−';

    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = getVal();

    const btnPlus = document.createElement('button');
    btnPlus.type = 'button';
    btnPlus.className = 'sbs-step';
    btnPlus.textContent = '+';

    const v = document.createElement('span');
    v.className = 'sbs-val';
    v.title = 'Click to type exact value';
    const decimals = (String(step).split('.')[1] || '').length;
    const fmt = (n) => Number(n).toFixed(decimals) + unit;
    v.textContent = fmt(getVal());

    const apply = (n, allowOutOfBounds = false) => {
      if (!Number.isFinite(n)) return;
      const clamped = allowOutOfBounds ? n : Math.max(min, Math.min(max, n));
      const clean = Number(clamped.toFixed(4));
      if (clean < Number(inp.min)) inp.min = clean;
      if (clean > Number(inp.max)) inp.max = clean;
      inp.value = clean;
      setVal(clean);
      v.textContent = fmt(clean);
      paintStatus();
      scheduleSave();
    };

    inp.oninput = () => apply(Number(inp.value), false);
    inp.ondblclick = () => apply(defVal, true);

    const stepMul = (e) => e.shiftKey ? 10 : (e.altKey || e.ctrlKey) ? 0.1 : 1;
    btnMinus.onclick = (e) => apply(getVal() - step * stepMul(e), true);
    btnPlus.onclick = (e) => apply(getVal() + step * stepMul(e), true);

    row.addEventListener('wheel', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      apply(getVal() + dir * step * stepMul(e), true);
    });

    v.onclick = (e) => {
      e.stopPropagation();
      const edit = document.createElement('input');
      edit.type = 'text';
      edit.className = 'sbs-val-edit';
      edit.value = String(getVal());
      v.replaceWith(edit);
      edit.focus();
      edit.select();

      let done = false;
      const commit = (save) => {
        if (done) return;
        done = true;
        if (save) {
          const parsed = parseFloat(edit.value.replace(',', '.'));
          if (Number.isFinite(parsed)) apply(parsed, true);
        }
        edit.replaceWith(v);
      };

      edit.addEventListener('keydown', (ke) => {
        ke.stopPropagation();
        if (ke.key === 'Enter') { ke.preventDefault(); commit(true); }
        else if (ke.key === 'Escape') { ke.preventDefault(); commit(false); }
        else if (ke.key === 'ArrowUp') { ke.preventDefault(); edit.value = (parseFloat(edit.value || 0) + step * stepMul(ke)).toFixed(3); }
        else if (ke.key === 'ArrowDown') { ke.preventDefault(); edit.value = (parseFloat(edit.value || 0) - step * stepMul(ke)).toFixed(3); }
      });
      edit.addEventListener('keyup', (ke) => ke.stopPropagation());
      edit.addEventListener('keypress', (ke) => ke.stopPropagation());
      edit.addEventListener('blur', () => commit(true));
    };

    row.append(l, btnMinus, inp, btnPlus, v);
    ov.appendChild(row);
  }

  function addToggle(key, label, cb) {
    const row = document.createElement('div');
    row.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    const b = document.createElement('button');
    b.type = 'button';
    const syncBtn = () => {
      b.className = 'toggle-btn' + (S[key] ? '' : ' off');
      b.textContent = (S[key] ? 'ON · ' : 'OFF · ') + label;
    };
    syncBtn();
    b.onclick = () => {
      S[key] = !S[key];
      syncBtn();
      if (cb) cb();
      paintStatus();
      scheduleSave();
    };
    row.append(l, b);
    ov.appendChild(row);
  }

  // 1. 3D Depth Scale slider (0.0x flat -> 5.0x deep stereo)
  addSliderRow('3D Depth Scale', 0.0, 5.0, 0.05, () => S.depthScale, (v) => { S.depthScale = v; }, 'x', 1.5);

  // 2. 3D Convergence Distance slider (screen-plane distance in metres)
  addSliderRow('3D Convergence', 1.0, 60.0, 0.25, () => S.convergence, (v) => { S.convergence = Math.max(0.5, v); }, 'm', 6.0);

  // 3. Physical IPD slider (mm)
  addSliderRow('Eye IPD', 40, 80, 0.5, () => +(S.ipd * 1000).toFixed(1), (v) => { S.ipd = v / 1000; }, 'mm', 60.0);

  // 4. HUD Stereo Depth slider (px)
  addSliderRow('HUD Pop Depth', -15, 30, 0.5, () => S.hudDepth, (v) => {
    S.hudDepth = v;
    const shift = S.swap ? -S.hudDepth : S.hudDepth;
    document.documentElement.style.setProperty('--sbs-hud-shift', shift + 'px');
  }, 'px', 6);

  addToggle('enabled', 'SBS 3D', () => fullRebuildHudMirror());
  addToggle('hudMirror', 'Dual HUD', () => fullRebuildHudMirror());
  addToggle('swap', 'Swap Eyes', () => fullRebuildHudMirror());
  S.statusEl = statusEl;

  function paintStatus() {
    if (!S.statusEl) return;
    const effMm = Math.round(S.ipd * S.depthScale * 1000);
    let txt = 'eye ' + S.ew + '×' + S.eh + ' (aspect ' + (S.aspect).toFixed(3) + ')\n' +
    'effective baseline: ' + effMm + 'mm (' + S.depthScale.toFixed(2) + 'x) · conv: ' + S.convergence.toFixed(1) + 'm\n' +
    (S.disabled ? '❌ DISABLED (' + (S.err || '?') + ')\n' : (S.enabled ? '✅ SBS on · ' : '⏸ SBS off · ')) +
    'frames=' + S.frames + (S.swap ? ' (swapped)' : '');
    S.statusEl.textContent = txt;
  }

  chip.onclick = () => { ov.style.display = (ov.style.display === 'flex') ? 'none' : 'flex'; paintStatus(); };
  document.body.appendChild(chip); document.body.appendChild(ov);

  function cleanup() {
    clearTimeout(saveTimer);
    cleanupStereoPointer();
    try { if (S.ctx && S.savedGetTex) S.ctx.getCurrentTexture = S.savedGetTex; } catch (e) {}
    uninstallSBS();
    try { if (chip.parentNode) chip.remove(); } catch (e) {}
    try { if (ov.parentNode) ov.remove(); } catch (e) {}
    log('sbs3d cleaned up');
  }

  /* ── boot ─────────────────────────────────────────────────────────────────── */
  function waitForBT(ms) {
    ms = ms || 20000;
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const poke = () => {
        const a = window.btApp;
        if (a && typeof a.addFeature === 'function') return resolve(a);
        if (performance.now() - t0 > ms) return reject(new Error('btApp not found within ' + ms + 'ms'));
        requestAnimationFrame(poke);
      };
      poke();
    });
  }

  try {
    const app = await waitForBT();
    let eng = null; try { eng = app.engine || null; } catch (e) {}
    if (!eng) {
      const got = await new Promise((res) => {
        app.addFeature((scope, env) => ({
          frame() { const e2 = env && env.engine; if (e2) res(e2); }
        }));
        setTimeout(() => res(null), 4000);
      });
      eng = got;
    }
    if (!eng || typeof eng.render !== 'function') {
      chip.textContent = '🥽 SBS 3D — no engine';
      log('sbs3d: engine/render not found; aborting install');
      return;
    }
    installSBS(eng);
    paintStatus();
    log('sbs3d v0.8 installed (depth ' + S.depthScale + 'x, conv ' + S.convergence + 'm)');
  } catch (err) {
    chip.textContent = '🥽 SBS 3D — err';
    log('sbs3d boot error: ' + ((err && err.message) || err));
  }

  try { terra.onCleanup(cleanup); } catch (e) {}
})();
