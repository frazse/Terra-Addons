/* sbs3d v0.7 — DEV throwaway.
 * Single-window double-render WebGPU stereo 3D + 50vw Left-Eye Root & Right-Eye Mirror
 * + Stereo 3D Mouse Cursor & Right-Eye -> Left-Eye Interactive Input Bridge.
 */
(async function () {
  'use strict';

  const log = (...a) => { try { terra.log(...a); } catch (e) { try { console.log('[sbs3d]', ...a); } catch (e2) {} } };

  /* ── state ────────────────────────────────────────────────────────────────── */
  const S = {
    eng: null, gpu: null, ctx: null, format: null,
 left: null, right: null, leftView: null, rightView: null,
 sampler: null, compositePipeline: null, compositeGroup: null,
 ew: 0, eh: 0, offW: 0, offH: 0, aspect: 1,
 savedGetTex: null,
 enabled: true,
 hudMirror: true,
 hudDepth: 6,         // px inward convergence so HUD floats slightly in front
 ipd: 0.060,          // metres; Viture IPD ≈ 58–72mm, default 60
 swap: false,          // if parallax is inverted, flip left/right
 errors: 0, warned: false, disabled: false, err: null,
 frames: 0,
 el: null, statusEl: null,
  };

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
      // Preserve clone.id so #id CSS rules (like the FPS counter addon) style the right-eye clone!
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
    if (e.clientX < halfW) return; // Already on the real Left Eye UI

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
    const realRender = eng.render;

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
      const off = (S.ipd / 2) * (S.swap ? -1 : 1);
      const base = { rotation: orig.rotation, fov: orig.fov, aspect: S.aspect, near: orig.near, far: orig.far, zoom: orig.zoom, origin: orig.origin };
      let frameOK = false;

      try {
        // LEFT eye → left offscreen
        cam.update({ worldPosition: { x: orig.wp.x - r[0] * off, y: orig.wp.y, z: orig.wp.z - r[2] * off }, ...base });
        S.ctx.getCurrentTexture = () => S.left;
        realRender.call(this, fs, rq);

        // RIGHT eye → right offscreen
        cam.update({ worldPosition: { x: orig.wp.x + r[0] * off, y: orig.wp.y, z: orig.wp.z + r[2] * off }, ...base });
        S.ctx.getCurrentTexture = () => S.right;
        realRender.call(this, fs, rq);
        frameOK = true;
      } catch (e) {
        bumpError('render', e);
      } finally {
        try { S.ctx.getCurrentTexture = S.savedGetTex; } catch (e2) {}
        try { cam.update({ worldPosition: orig.wp, ...base, aspect: orig.aspect }); } catch (e2) {}
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
    '.sbs3d-ov{position:fixed;top:44px;left:96px;z-index:2147483647;width:340px;' +
    'display:none;flex-direction:column;gap:8px;background:rgba(6,22,26,0.96);color:#cfffff;border:1px solid #0d7;border-radius:10px;' +
    'padding:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;}' +
    '.sbs3d-ov .row{display:flex;align-items:center;justify-content:space-between;gap:10px;}' +
    '.sbs3d-ov .row label{flex:1;}' +
    '.sbs3d-ov input[type=range]{width:130px;}' +
    '.sbs3d-ov button{background:#0a4;color:#031;border:1px solid #0dd;border-radius:6px;padding:3px 9px;cursor:pointer;font:inherit;}' +
    '.sbs3d-ov button:hover{background:#0c6;}' +
    '.sbs3d-ov .st{color:#8fe;font-size:11px;white-space:pre-wrap;}'
  );

  const chip = document.createElement('button'); chip.type = 'button'; chip.id = 'sbs3d-chip'; chip.className = 'sbs3d-chip';
  chip.textContent = '🥽 SBS 3D';
  const ov = document.createElement('div'); ov.id = 'sbs3d-ov'; ov.className = 'sbs3d-ov';
  const statusEl = document.createElement('div'); statusEl.className = 'st';
  ov.appendChild(statusEl);
  function addRow(label, control) { const row = document.createElement('div'); row.className = 'row'; const l = document.createElement('label'); l.textContent = label; row.appendChild(l); row.appendChild(control); ov.appendChild(row); }
  function addToggle(key, label, val, cb) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = (val ? 'ON ' : 'OFF ') + label;
    b.onclick = () => { S[key] = !S[key]; b.textContent = (S[key] ? 'ON ' : 'OFF ') + label; cb && cb(); paintStatus(); };
    addRow(label, b);
  }
  // IPD slider
  (function () {
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = 40; inp.max = 80; inp.step = 1; inp.value = Math.round(S.ipd * 1000);
    const val = document.createElement('span'); val.textContent = Math.round(S.ipd * 1000) + 'mm';
    const wrap = document.createElement('span'); wrap.appendChild(inp); wrap.appendChild(val);
    inp.oninput = () => {
      S.ipd = Number(inp.value) / 1000;
      inp.setAttribute('value', inp.value);
      val.textContent = inp.value + 'mm';
      paintStatus();
    };
    addRow('IPD', wrap);
  })();
  // HUD Stereo Depth slider
  (function () {
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = -10; inp.max = 24; inp.step = 1; inp.value = S.hudDepth;
    const val = document.createElement('span'); val.textContent = S.hudDepth + 'px';
    const wrap = document.createElement('span'); wrap.appendChild(inp); wrap.appendChild(val);
    inp.oninput = () => {
      S.hudDepth = Number(inp.value);
      inp.setAttribute('value', inp.value);
      val.textContent = inp.value + 'px';
      const shift = S.swap ? -S.hudDepth : S.hudDepth;
      document.documentElement.style.setProperty('--sbs-hud-shift', shift + 'px');
    };
    addRow('HUD depth', wrap);
  })();
  addToggle('enabled', 'SBS', S.enabled, () => fullRebuildHudMirror());
  addToggle('hudMirror', 'Dual HUD', S.hudMirror, () => fullRebuildHudMirror());
  addToggle('swap', 'swap eyes', S.swap, () => fullRebuildHudMirror());
  S.statusEl = statusEl;

  function paintStatus() {
    if (!S.statusEl) return;
    let txt = 'eye ' + S.ew + '×' + S.eh + ' (aspect ' + (S.aspect).toFixed(3) + ')\n' +
    'offscreen ' + S.offW + '×' + S.offH + ' fmt=' + (S.format || '?') + '\n' +
    (S.disabled ? '❌ DISABLED (' + (S.err || '?') + ')\n' : (S.enabled ? '✅ SBS on\n' : '⏸ SBS off\n')) +
    'frames=' + S.frames + ' errs=' + S.errors + ' ipd=' + Math.round(S.ipd * 1000) + 'mm' + (S.swap ? ' (swapped)' : '');
    S.statusEl.textContent = txt;
  }

  chip.onclick = () => { ov.style.display = (ov.style.display === 'block') ? 'none' : 'block'; paintStatus(); };
  document.body.appendChild(chip); document.body.appendChild(ov);

  function cleanup() {
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
    log('sbs3d installed (ipd ' + Math.round(S.ipd * 1000) + 'mm)');
  } catch (err) {
    chip.textContent = '🥽 SBS 3D — err';
    log('sbs3d boot error: ' + ((err && err.message) || err));
  }

  try { terra.onCleanup(cleanup); } catch (e) {}
})();
