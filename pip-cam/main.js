/* pip-cam v0.2.1 — Picture-in-Picture secondary WebGPU camera addon for Biketerra.
 * Continuous engine hook for SPA navigation, native 3D route geometry (ego.sim.prevPathNode),
 * Static World Tripod, Rear-View Mirror, and Chase Drone modes.
 */
(async function () {
    'use strict';

    const log = (...a) => {
        try { terra.log('[pip-cam]', ...a); }
        catch (e) { try { console.log('[pip-cam]', ...a); } catch (e2) {} }
    };

    if (window.__btPipCleanup) {
        try { window.__btPipCleanup(); } catch (e) {}
    }

    const isRideOrSpectate = () => /^\/(ride|spectate)\b/.test(location.pathname);

    /* ── 1. State & Persistent Storage ────────────────────────────────────────── */
    const DEFAULTS = {
        enabled: true,         // Start ON by default so the PiP window opens immediately in rides
 mode: 'pinned',        // 'pinned' | 'route' | 'rear' | 'drone'
 mirror: false,
 every: 2,              // 1 = 60fps, 2 = 30fps, 3 = 20fps
 fovScale: 1.0,
 nearClip: 0.0,
 rect: { x: 0.36, y: 0.13, w: 0.28, h: 0.20 },
 tripodCfg: {
     fwd: 25, right: 3.2, up: 1.8, worldX: 0, worldZ: 0,
 trackRider: false, focusFwd: 0, focusRight: 0, focusHeight: 1.0,
 yaw: 180, pitch: -4, roll: 0,
 },
 routeCfg: {
     followRider: false, distM: 40, fineAlongM: 0, aheadMeters: 45,
 shoulderMeters: 3.0, heightMeters: 1.8, worldX: 0, worldZ: 0,
 trackRider: false, lookAlongMeters: -30, lookShoulderMeters: 0,
 focusHeight: 0.8, yawTrim: 0, pitchTrim: 0, rollTrim: 0,
 },
 rel: { fwd: 4.5, right: 0.0, up: -0.2, yaw: 0, pitch: -4, roll: 0 },
 drone: { back: 12, up: 14, right: 0, focusFwd: 4, focusHeight: 0.5 },
    };

    const clone = (o) => JSON.parse(JSON.stringify(o));

    const P = Object.assign(clone(DEFAULTS), {
        tripod: null,
        smoothWp: null,
        egoDistM: 0,
        lastMainWp: { x: 0, y: 0, z: 0 },
        lastMainFwd: { x: 0, y: 0, z: -1 },
        lastMainRight: { x: 1, y: 0, z: 0 },
        tex: null, view: null, sampler: null, pipe: null, bg: null, ubo: null,
        w: 0, h: 0, fmt: null, frame: 0,
    });

    let saveTimer = 0;
    async function loadSavedState() {
        try {
            if (typeof terra !== 'undefined' && terra.storage && typeof terra.storage.get === 'function') {
                const saved = await terra.storage.get('pipConfig', null);
                if (saved && typeof saved === 'object') {
                    if (typeof saved.enabled === 'boolean') P.enabled = saved.enabled;
                    if (saved.mode) P.mode = saved.mode;
                    if (typeof saved.mirror === 'boolean') P.mirror = saved.mirror;
                    if (Number.isFinite(saved.every)) P.every = saved.every;
                    if (Number.isFinite(saved.fovScale)) P.fovScale = saved.fovScale;
                    if (Number.isFinite(saved.nearClip)) P.nearClip = saved.nearClip;
                    if (saved.rect) Object.assign(P.rect, saved.rect);
                    if (saved.tripodCfg) Object.assign(P.tripodCfg, saved.tripodCfg);
                    if (saved.routeCfg) Object.assign(P.routeCfg, saved.routeCfg);
                    if (saved.rel) Object.assign(P.rel, saved.rel);
                    if (saved.drone) Object.assign(P.drone, saved.drone);
                }
            }
        } catch (e) {}
    }

    function scheduleSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                if (typeof terra !== 'undefined' && terra.storage && typeof terra.storage.set === 'function') {
                    const payload = {
                        enabled: P.enabled, mode: P.mode, mirror: P.mirror, every: P.every,
                        fovScale: P.fovScale, nearClip: P.nearClip, rect: P.rect,
                        tripodCfg: P.tripodCfg, routeCfg: P.routeCfg, rel: P.rel, drone: P.drone,
                    };
                    const p = terra.storage.set('pipConfig', payload);
                    if (p && p.catch) p.catch(() => {});
                }
            } catch (e) {}
        }, 400);
    }

    await loadSavedState();

    /* ── 2. Native 3D World Route Resolution (from ego.sim.prevPathNode) ───────── */
    let route3D = null;

    function resolveNative3DRoute() {
        try {
            const rc = window.btApp && window.btApp.riderController;
            if (!rc) return null;
            const ego = rc.ego || rc.focalRider;
            const prev = ego && ego.sim && ego.sim.prevPathNode;
            if (!prev) return null;

            let list = null;
            if (prev.pathNode && Array.isArray(prev.pathNode.list) && prev.pathNode.list.length > 2) {
                list = prev.pathNode.list;
            } else if (Array.isArray(prev.list) && prev.list.length > 2) {
                list = prev.list;
            }
            if (!list || list.length < 2) return null;

            if (route3D && route3D.listRef === list) return route3D;

            const n = list.length;
            const pts = new Array(n);
            const norms = new Array(n);
            for (let i = 0; i < n; i++) {
                const node = list[i];
                const inner = (node && node.pathNode) ? node.pathNode : node;
                const p = inner && (inner.p || inner.pos || inner.position);
                const nm = inner && (inner.n || inner.normal);
                if (!p || typeof p.x !== 'number') return null;
                pts[i] = { x: p.x, y: p.y || 0, z: p.z };
                norms[i] = (nm && typeof nm.x === 'number') ? { x: nm.x, z: nm.z } : null;
            }

            const dist = new Float64Array(n);
            const tangs = new Array(n);
            for (let i = 1; i < n; i++) {
                const dx = pts[i].x - pts[i - 1].x;
                const dy = pts[i].y - pts[i - 1].y;
                const dz = pts[i].z - pts[i - 1].z;
                dist[i] = dist[i - 1] + Math.hypot(dx, dy, dz);
            }
            const totalLen = dist[n - 1];
            if (!(totalLen > 0)) return null;

            for (let i = 0; i < n; i++) {
                const i0 = Math.max(0, i - 2);
                const i1 = Math.min(n - 1, i + 2);
                let tx = pts[i1].x - pts[i0].x;
                let tz = pts[i1].z - pts[i0].z;
                const tl = Math.hypot(tx, tz) || 1;
                tx /= tl; tz /= tl;
                tangs[i] = { x: tx, z: tz };
                if (!norms[i] || (norms[i].x === 0 && norms[i].z === 0)) {
                    norms[i] = { x: -tz, z: tx };
                }
            }

            route3D = { listRef: list, pts, norms, tangs, dist, totalLen, n };
            log(`Resolved native 3D route: ${n} nodes, ${(totalLen / 1000).toFixed(2)} km`);
            if (panel.style.display === 'flex' && P.mode === 'route') renderPanel();
            return route3D;
        } catch (e) {
            return null;
        }
    }

    function sampleRoute3D(distM) {
        const r = route3D || resolveNative3DRoute();
        if (!r) return null;
        const total = r.totalLen;
        const d = ((distM % total) + total) % total;

        let lo = 0, hi = r.n - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (r.dist[mid] < d) lo = mid + 1;
            else hi = mid;
        }
        const i1 = lo;
        const i0 = Math.max(0, i1 - 1);
        const a = r.pts[i0], b = r.pts[i1];
        const d0 = r.dist[i0], d1 = r.dist[i1];
        const t = (d1 > d0) ? (d - d0) / (d1 - d0) : 0;

        const p = {
            x: a.x + (b.x - a.x) * t,
 y: a.y + (b.y - a.y) * t,
 z: a.z + (b.z - a.z) * t,
        };

        const n0 = r.norms[i0], n1 = r.norms[i1];
        let nx = n0.x + (n1.x - n0.x) * t;
        let nz = n0.z + (n1.z - n0.z) * t;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl; nz /= nl;

        const t0 = r.tangs[i0], t1 = r.tangs[i1];
        let tx = t0.x + (t1.x - t0.x) * t;
        let tz = t0.z + (t1.z - t0.z) * t;
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;

        return { p, n: { x: nx, z: nz }, tang: { x: tx, z: tz }, distM: d };
    }

    function updateEgoRouteDist(bikePos) {
        const r = route3D;
        if (!r) return 0;
        let bestI = 0, bestD2 = Infinity;
        const pts = r.pts;
        for (let i = 0; i < r.n; i++) {
            const dx = pts[i].x - bikePos.x;
            const dy = pts[i].y - bikePos.y;
            const dz = pts[i].z - bikePos.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < bestD2) { bestD2 = d2; bestI = i; }
        }
        P.egoDistM = r.dist[bestI];
        return P.egoDistM;
    }

    /* ── 3. Camera Math Helpers ──────────────────────────────────────────────── */
    function lookAtRot(eye, target) {
        let bx = eye.x - target.x, by = eye.y - target.y, bz = eye.z - target.z;
        let bl = Math.hypot(bx, by, bz) || 1;
        bx /= bl; by /= bl; bz /= bl;
        let rx = bz, ry = 0, rz = -bx;
        let rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-5) { rx = 1; ry = 0; rz = 0; } else { rx /= rl; rz /= rl; }
        const ux = by * rz - bz * ry, uy = bz * rx - bx * rz, uz = bx * ry - by * rx;
        return [rx, ry, rz, ux, uy, uz, bx, by, bz];
    }

    function rotateBasis(R, U, B, yawDeg, pitchDeg, rollDeg = 0) {
        let [rx, ry, rz] = R, [ux, uy, uz] = U, [bx, by, bz] = B;
        if (yawDeg) {
            const a = yawDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
            [rx, rz] = [rx * c + rz * s, -rx * s + rz * c];
            [ux, uz] = [ux * c + uz * s, -ux * s + uz * c];
            [bx, bz] = [bx * c + bz * s, -bx * s + bz * c];
        }
        if (pitchDeg) {
            const a = pitchDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
            const nux = ux * c + bx * s, nuy = uy * c + by * s, nuz = uz * c + bz * s;
            const nbx = bx * c - ux * s, nby = by * c - uy * s, nbz = bz * c - uz * s;
            ux = nux; uy = nuy; uz = nuz;
            bx = nbx; by = nby; bz = nbz;
        }
        if (rollDeg) {
            const a = rollDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
            const nrx = rx * c + ux * s, nry = ry * c + uy * s, nrz = rz * c + uz * s;
            const nux = ux * c - rx * s, nuy = uy * c - ry * s, nuz = uz * c - rz * s;
            rx = nrx; ry = nry; rz = nrz;
            ux = nux; uy = nuy; uz = nuz;
        }
        return [rx, ry, rz, ux, uy, uz, bx, by, bz];
    }

    function dropTripodAtCurrentBike() {
        let fx = P.lastMainFwd.x, fz = P.lastMainFwd.z;
        const fl = Math.hypot(fx, fz) || 1;
        fx /= fl; fz /= fl;
        const rx = -fz, rz = fx;
        P.tripod = {
            basePos: {
                x: P.lastMainWp.x + fx * 4.0,
 y: P.lastMainWp.y - 1.3,
 z: P.lastMainWp.z + fz * 4.0,
            },
 fwd: { x: fx, y: 0, z: fz },
 right: { x: rx, y: 0, z: rz },
        };
    }

    /* ── 4. UI Styles & Interactive Elements ─────────────────────────────────── */
    const CSS = `
    .pip-chip {
        position: fixed; top: 10px; left: 195px; z-index: 2147483647;
        background: #0aa; color: #04141a; border: 1px solid #0dd; border-radius: 8px;
        padding: 6px 11px; cursor: pointer; font: 600 12px/1 -apple-system, system-ui, sans-serif;
        box-shadow: 0 4px 14px rgba(0,0,0,.4);
    }
    .pip-panel {
        position: fixed; top: 44px; left: 195px; z-index: 2147483647; width: 440px;
        max-height: calc(100vh - 60px); overflow-y: auto;
        display: none; flex-direction: column; gap: 6px;
        background: rgba(6, 22, 26, 0.96); color: #cfffff; border: 1px solid #0d7;
        border-radius: 10px; padding: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.6);
        font: 11.5px/1.35 ui-monospace, Menlo, Consolas, monospace; user-select: none;
    }
    .pip-panel .pip-hdr { font-weight: 700; color: #5ff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
    .pip-panel .pip-row { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .pip-panel .pip-row label { flex: 1; color: #9fe; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pip-panel input[type=range] { width: 118px; accent-color: #0dd; cursor: pointer; margin: 0; }
    .pip-panel .pip-step {
        padding: 1px 5px; font-size: 11px; line-height: 1.1; background: #09292e; color: #8fe;
        border: 1px solid #078; border-radius: 4px; cursor: pointer;
    }
    .pip-panel .pip-val {
        width: 68px; text-align: right; color: #fff; font-size: 11px;
        font-variant-numeric: tabular-nums; cursor: text; padding: 1px 4px;
        border-radius: 4px; border: 1px solid transparent; background: rgba(0,0,0,0.25);
    }
    .pip-panel .pip-val:hover { border-color: #0aa; background: #04181c; }
    .pip-panel .pip-val-edit {
        width: 68px; text-align: right; color: #0ff; font: inherit; font-size: 11px;
        padding: 1px 4px; border-radius: 4px; border: 1px solid #0ff; background: #021014;
        outline: none; box-sizing: border-box;
    }
    .pip-panel .pip-tabs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-bottom: 2px; }
    .pip-panel button {
        background: #0f383e; color: #bff; border: 1px solid #09a; border-radius: 6px;
        padding: 4px 7px; cursor: pointer; font: inherit;
    }
    .pip-panel button.active, .pip-panel button.primary { background: #0cc; color: #022; font-weight: 700; border-color: #5ff; }
    .pip-panel button.warn { background: #e65100; color: #fff; border-color: #ff9800; font-weight: 700; }
    .pip-panel button:hover { filter: brightness(1.15); }
    .pip-panel .pip-sec { border-top: 1px solid rgba(0, 220, 220, 0.22); padding-top: 6px; margin-top: 2px; display: flex; flex-direction: column; gap: 5px; }
    .pip-graphs { display: grid; grid-template-columns: 1.35fr 1fr; gap: 6px; }
    .pip-route-svg, .pip-map-svg {
        width: 100%; height: 74px; background: #041014; border: 1px solid #075;
        border-radius: 6px; cursor: crosshair; display: block;
    }
    .pip-drag-box {
        position: fixed; z-index: 2147483630; box-sizing: border-box;
        border: 2px dashed rgba(0, 255, 255, 0); cursor: move;
    }
    .pip-drag-box:hover, .pip-drag-box.dragging {
        border-color: rgba(0, 255, 255, 0.85); background: rgba(0, 255, 255, 0.06);
    }
    .pip-resize-handle {
        position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; background: linear-gradient(135deg, transparent 50%, #0dd 50%);
        opacity: 0;
    }
    .pip-drag-box:hover .pip-resize-handle, .pip-drag-box.dragging .pip-resize-handle { opacity: 1; }
    `;

    let uninjectCss = null;
    if (typeof terra !== 'undefined' && terra.ui && typeof terra.ui.addStyle === 'function') {
        uninjectCss = terra.ui.addStyle(CSS);
    } else {
        const s = document.createElement('style');
        s.textContent = CSS;
        document.head.appendChild(s);
        uninjectCss = () => s.remove();
    }

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pip-chip';
    chip.textContent = '🎥 PiP Cam';

    const panel = document.createElement('div');
    panel.className = 'pip-panel';

    const dragBox = document.createElement('div');
    dragBox.className = 'pip-drag-box';
    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'pip-resize-handle';
    dragBox.appendChild(resizeHandle);

    function syncDragOverlay() {
        const onRide = isRideOrSpectate();
        chip.style.display = onRide ? 'block' : 'none';
        if (!onRide) panel.style.display = 'none';
        if (!P.enabled || !onRide) {
            dragBox.style.display = 'none';
            return;
        }
        dragBox.style.display = 'block';
        const sbsActive = document.documentElement.classList.contains('sbs3d-hud-active');
        const vw = sbsActive ? window.innerWidth * 0.5 : window.innerWidth;
        const vh = window.innerHeight;
        dragBox.style.left = Math.round(P.rect.x * vw) + 'px';
        dragBox.style.top = Math.round(P.rect.y * vh) + 'px';
        dragBox.style.width = Math.round(P.rect.w * vw) + 'px';
        dragBox.style.height = Math.round(P.rect.h * vh) + 'px';
    }

    let dragState = null;
    dragBox.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        dragBox.setPointerCapture(e.pointerId);
        dragBox.classList.add('dragging');
        const sbsActive = document.documentElement.classList.contains('sbs3d-hud-active');
        const vw = sbsActive ? window.innerWidth * 0.5 : window.innerWidth;
        const vh = window.innerHeight;
        dragState = { resizing: e.target === resizeHandle, startX: e.clientX, startY: e.clientY, vw, vh, orig: { ...P.rect } };
    });
    dragBox.addEventListener('pointermove', (e) => {
        if (!dragState) return;
        const dx = (e.clientX - dragState.startX) / dragState.vw;
        const dy = (e.clientY - dragState.startY) / dragState.vh;
        if (dragState.resizing) {
            P.rect.w = Math.max(0.10, Math.min(0.80, dragState.orig.w + dx));
            P.rect.h = Math.max(0.08, Math.min(0.80, dragState.orig.h + dy));
        } else {
            P.rect.x = Math.max(0.0, Math.min(1 - P.rect.w, dragState.orig.x + dx));
            P.rect.y = Math.max(0.0, Math.min(1 - P.rect.h, dragState.orig.y + dy));
        }
        syncDragOverlay();
        scheduleSave();
    });
    const endDrag = () => { dragState = null; dragBox.classList.remove('dragging'); };
    dragBox.addEventListener('pointerup', endDrag);
    dragBox.addEventListener('pointercancel', endDrag);

    /* ── Interactive 3D Elevation Profile + 2D Top-Down Course Map ──────────── */
    let routeSvgEl = null, camPinEl = null, riderPinEl = null;
    let mapSvgEl = null, mapCamDotEl = null, mapRiderDotEl = null, mapBounds = null;
    let kmSliderCtl = null;

    function buildRouteGraphs() {
        const wrap = document.createElement('div');
        wrap.className = 'pip-graphs';
        const NS = 'http://www.w3.org/2000/svg';
        const r = route3D || resolveNative3DRoute();
        const totalM = r ? r.totalLen : 0;

        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('class', 'pip-route-svg');
        svg.setAttribute('viewBox', '0 0 220 74');
        if (r && r.n >= 2) {
            let minY = r.pts[0].y, maxY = r.pts[0].y;
            for (let i = 0; i < r.n; i++) {
                const y = r.pts[i].y;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            const spanY = (maxY - minY) || 1;
            let d = 'M 0 74 ';
            const step = Math.max(1, Math.floor(r.n / 150));
            for (let i = 0; i < r.n; i += step) {
                const x = (r.dist[i] / totalM) * 220;
                const y = 68 - ((r.pts[i].y - minY) / spanY) * 58;
                d += `L ${x.toFixed(1)} ${y.toFixed(1)} `;
            }
            d += 'L 220 74 Z';
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'rgba(0, 210, 170, 0.35)');
            path.setAttribute('stroke', '#0fd');
            path.setAttribute('stroke-width', '1.5');
            svg.appendChild(path);

            riderPinEl = document.createElementNS(NS, 'circle');
            riderPinEl.setAttribute('r', '4');
            riderPinEl.setAttribute('fill', '#ff8c2e');
            riderPinEl.setAttribute('cy', '37');
            svg.appendChild(riderPinEl);

            camPinEl = document.createElementNS(NS, 'line');
            camPinEl.setAttribute('y1', '0');
            camPinEl.setAttribute('y2', '74');
            camPinEl.setAttribute('stroke', '#00ffff');
            camPinEl.setAttribute('stroke-width', '2.5');
            svg.appendChild(camPinEl);

            const pickProfile = (ev) => {
                const rect = svg.getBoundingClientRect();
                const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / (rect.width || 1)));
                P.routeCfg.followRider = false;
                P.routeCfg.distM = frac * totalM;
                if (kmSliderCtl) kmSliderCtl.setExternal(+(P.routeCfg.distM / 1000).toFixed(3));
                updateRouteSvgMarkers();
                scheduleSave();
            };
            let scrub = false;
            svg.addEventListener('pointerdown', (e) => { scrub = true; svg.setPointerCapture(e.pointerId); pickProfile(e); });
            svg.addEventListener('pointermove', (e) => { if (scrub) pickProfile(e); });
            svg.addEventListener('pointerup', () => { scrub = false; });
        }
        routeSvgEl = svg;

        const msvg = document.createElementNS(NS, 'svg');
        msvg.setAttribute('class', 'pip-map-svg');
        msvg.setAttribute('viewBox', '0 0 160 74');
        if (r && r.n >= 2) {
            let minX = r.pts[0].x, maxX = r.pts[0].x, minZ = r.pts[0].z, maxZ = r.pts[0].z;
            for (let i = 0; i < r.n; i++) {
                const p = r.pts[i];
                if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
                if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
            }
            const pad = 6, W = 160, H = 74;
            const sX = (maxX - minX) || 1, sZ = (maxZ - minZ) || 1;
            const scale = Math.min((W - 2 * pad) / sX, (H - 2 * pad) / sZ);
            const ox = pad + ((W - 2 * pad) - sX * scale) / 2;
            const oz = pad + ((H - 2 * pad) - sZ * scale) / 2;
            mapBounds = { minX, maxX, minZ, maxZ, scale, ox, oz };

            const X = wx => ox + (wx - minX) * scale;
            const Y = wz => oz + (wz - minZ) * scale;

            let d = '';
            const step = Math.max(1, Math.floor(r.n / 220));
            for (let i = 0; i < r.n; i += step) {
                d += (i === 0 ? 'M' : 'L') + X(r.pts[i].x).toFixed(1) + ' ' + Y(r.pts[i].z).toFixed(1) + ' ';
            }
            const line = document.createElementNS(NS, 'path');
            line.setAttribute('d', d.trim());
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', '#3b82f6');
            line.setAttribute('stroke-width', '2');
            msvg.appendChild(line);

            mapRiderDotEl = document.createElementNS(NS, 'circle');
            mapRiderDotEl.setAttribute('r', '3.5');
            mapRiderDotEl.setAttribute('fill', '#ff8c2e');
            msvg.appendChild(mapRiderDotEl);

            mapCamDotEl = document.createElementNS(NS, 'circle');
            mapCamDotEl.setAttribute('r', '4.5');
            mapCamDotEl.setAttribute('fill', '#00ffff');
            mapCamDotEl.setAttribute('stroke', '#002222');
            mapCamDotEl.setAttribute('stroke-width', '1.2');
            msvg.appendChild(mapCamDotEl);

            const pickMap = (ev) => {
                const rect = msvg.getBoundingClientRect();
                const mx = ((ev.clientX - rect.left) / (rect.width || 1)) * W;
                const my = ((ev.clientY - rect.top) / (rect.height || 1)) * H;
                let bestIdx = 0, bestD2 = Infinity;
                for (let i = 0; i < r.n; i++) {
                    const dx = X(r.pts[i].x) - mx, dy = Y(r.pts[i].z) - my;
                    const d2 = dx * dx + dy * dy;
                    if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
                }
                P.routeCfg.followRider = false;
                P.routeCfg.distM = r.dist[bestIdx];
                if (kmSliderCtl) kmSliderCtl.setExternal(+(P.routeCfg.distM / 1000).toFixed(3));
                updateRouteSvgMarkers();
                scheduleSave();
            };
            let mscrub = false;
            msvg.addEventListener('pointerdown', (e) => { mscrub = true; msvg.setPointerCapture(e.pointerId); pickMap(e); });
            msvg.addEventListener('pointermove', (e) => { if (mscrub) pickMap(e); });
            msvg.addEventListener('pointerup', () => { mscrub = false; });
        }
        mapSvgEl = msvg;

        wrap.append(svg, msvg);
        updateRouteSvgMarkers();
        return wrap;
    }

    function updateRouteSvgMarkers() {
        const r = route3D;
        if (!r || !r.totalLen) return;
        const totalM = r.totalLen;
        const egoFrac = P.egoDistM / totalM;
        const camDist = ((P.routeCfg.distM + P.routeCfg.fineAlongM) % totalM + totalM) % totalM;
        const camFrac = camDist / totalM;

        if (routeSvgEl) {
            if (riderPinEl) riderPinEl.setAttribute('cx', (egoFrac * 220).toFixed(1));
            if (camPinEl) {
                const x = (camFrac * 220).toFixed(1);
                camPinEl.setAttribute('x1', x);
                camPinEl.setAttribute('x2', x);
            }
        }
        if (mapSvgEl && mapBounds) {
            const { minX, minZ, scale, ox, oz } = mapBounds;
            const X = wx => ox + (wx - minX) * scale;
            const Y = wz => oz + (wz - minZ) * scale;
            const rs = sampleRoute3D(P.egoDistM);
            const cs = sampleRoute3D(camDist);
            if (rs && mapRiderDotEl) {
                mapRiderDotEl.setAttribute('cx', X(rs.p.x).toFixed(1));
                mapRiderDotEl.setAttribute('cy', Y(rs.p.z).toFixed(1));
            }
            if (cs && mapCamDotEl) {
                mapCamDotEl.setAttribute('cx', X(cs.p.x).toFixed(1));
                mapCamDotEl.setAttribute('cy', Y(cs.p.z).toFixed(1));
            }
        }
    }

    function mkSlider(label, min, max, step, getVal, setVal, unit = '', defVal = null) {
        const initial = defVal !== null ? defVal : getVal();
        const row = document.createElement('div');
        row.className = 'pip-row';
        const l = document.createElement('label');
        l.textContent = label;
        l.title = 'Double-click slider to reset • Click number to type exact value • Shift=10x step, Alt=0.1x step';

        const btnMinus = document.createElement('button');
        btnMinus.type = 'button';
        btnMinus.className = 'pip-step';
        btnMinus.textContent = '−';

        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = getVal();

        const btnPlus = document.createElement('button');
        btnPlus.type = 'button';
        btnPlus.className = 'pip-step';
        btnPlus.textContent = '+';

        const v = document.createElement('span');
        v.className = 'pip-val';
        v.title = 'Click to type exact value';
        const baseDecimals = Math.max(2, (String(step).split('.')[1] || '').length);
        const fmt = (n) => {
            const num = Number(n);
            if (!Number.isFinite(num)) return '0' + unit;
            const s = num.toFixed(Math.max(baseDecimals, 3)).replace(/0+$/, '').replace(/\.$/, '');
            const parts = s.split('.');
            const dec = parts[1] ? parts[1].length : 0;
            return num.toFixed(Math.max(baseDecimals, dec)) + unit;
        };
        v.textContent = fmt(getVal());

        const apply = (n, allowOutOfBounds = false) => {
            if (!Number.isFinite(n)) return;
            const val = allowOutOfBounds ? n : Math.max(min, Math.min(max, n));
            const clean = Number(val.toFixed(5));
            if (clean < Number(inp.min)) inp.min = clean;
            if (clean > Number(inp.max)) inp.max = clean;
            inp.value = clean;
            setVal(clean);
            v.textContent = fmt(clean);
            scheduleSave();
        };

        inp.oninput = () => apply(Number(inp.value), false);
        inp.ondblclick = () => apply(initial, true);

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
            edit.className = 'pip-val-edit';
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
        return { row, inp, v, setExternal: (val) => { inp.value = val; v.textContent = fmt(val); } };
    }

    function mkHeader(text) {
        const h = document.createElement('div');
        h.className = 'pip-hdr';
        h.textContent = text;
        return h;
    }

    function renderPanel() {
        panel.replaceChildren();
        resolveNative3DRoute();

        const topRow = document.createElement('div');
        topRow.className = 'pip-row';
        const btnOn = document.createElement('button');
        btnOn.type = 'button';
        btnOn.className = P.enabled ? 'active' : '';
        btnOn.textContent = P.enabled ? 'ON' : 'OFF';
        btnOn.onclick = () => { P.enabled = !P.enabled; syncDragOverlay(); renderPanel(); scheduleSave(); };

        const btnMir = document.createElement('button');
        btnMir.type = 'button';
        btnMir.className = P.mirror ? 'active' : '';
        btnMir.textContent = P.mirror ? 'Mirror: ON' : 'Mirror: OFF';
        btnMir.onclick = () => { P.mirror = !P.mirror; renderPanel(); scheduleSave(); };

        const btnFps = document.createElement('button');
        btnFps.type = 'button';
        btnFps.textContent = P.every === 1 ? '60fps' : P.every === 2 ? '30fps' : '20fps';
        btnFps.onclick = () => { P.every = P.every === 1 ? 2 : P.every === 2 ? 3 : 1; renderPanel(); scheduleSave(); };

        topRow.append(btnOn, btnMir, btnFps);
        panel.appendChild(topRow);

        const tabs = document.createElement('div');
        tabs.className = 'pip-tabs';
        for (const [id, label] of [['pinned', '📌 Tripod'], ['route', '🛣️ Route'], ['rear', '🪞 Rear'], ['drone', '🚁 Drone']]) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = P.mode === id ? 'active' : '';
            b.textContent = label;
            b.onclick = () => { P.mode = id; renderPanel(); scheduleSave(); };
            tabs.appendChild(b);
        }
        panel.appendChild(tabs);

        const sec = document.createElement('div');
        sec.className = 'pip-sec';

        if (P.mode === 'pinned') {
            const tc = P.tripodCfg;
            const rowBtns = document.createElement('div');
            rowBtns.className = 'pip-row';
            const btnDrop = document.createElement('button');
            btnDrop.type = 'button';
            btnDrop.className = 'primary';
            btnDrop.textContent = '📍 Plant Tripod Near Me';
            btnDrop.onclick = () => { dropTripodAtCurrentBike(); renderPanel(); };

            const btnTrack = document.createElement('button');
            btnTrack.type = 'button';
            btnTrack.className = tc.trackRider ? 'active' : 'warn';
            btnTrack.textContent = tc.trackRider ? '🎯 Auto-Pan to Rider' : '🔒 Fixed Road Spot';
            btnTrack.onclick = () => { tc.trackRider = !tc.trackRider; renderPanel(); scheduleSave(); };
            rowBtns.append(btnDrop, btnTrack);
            sec.appendChild(rowBtns);

            sec.append(
                mkHeader('Camera Position (Click any number to type)'),
                       mkSlider('Move Down/Up Road', -300, 600, 0.05, () => tc.fwd, v => tc.fwd = v, 'm', 25).row,
                       mkSlider('Road Shoulder (L/R)', -30, 30, 0.01, () => tc.right, v => tc.right = v, 'm', 3.2).row,
                       mkSlider('Tripod Height', -5, 60, 0.01, () => tc.up, v => tc.up = v, 'm', 1.8).row,
                       mkSlider('World X Fine Trim', -50, 50, 0.01, () => tc.worldX, v => tc.worldX = v, 'm', 0).row,
                       mkSlider('World Z Fine Trim', -50, 50, 0.01, () => tc.worldZ, v => tc.worldZ = v, 'm', 0).row,

                       mkHeader(tc.trackRider ? 'Rider Focus Target & Trim' : 'Road Focus Target & Camera Angles'),
                       mkSlider('Focus Height', -10, 25, 0.01, () => tc.focusHeight, v => tc.focusHeight = v, 'm', 1.0).row,
                       mkSlider('Focus Ahead/Back', -50, 50, 0.01, () => tc.focusFwd, v => tc.focusFwd = v, 'm', 0).row,
                       mkSlider('Focus Side (L/R)', -15, 15, 0.01, () => tc.focusRight, v => tc.focusRight = v, 'm', 0).row,
            );
            if (!tc.trackRider) {
                sec.append(
                    mkSlider('Aim Yaw (180=Back)', -180, 180, 0.05, () => tc.yaw, v => tc.yaw = v, '°', 180).row,
                           mkSlider('Aim Pitch (Tilt)', -85, 85, 0.05, () => tc.pitch, v => tc.pitch = v, '°', -4).row,
                );
            }
            sec.appendChild(mkSlider('Camera Roll', -45, 45, 0.05, () => tc.roll, v => tc.roll = v, '°', 0).row);

        } else if (P.mode === 'route') {
            const rc = P.routeCfg;
            const totalM = (route3D && route3D.totalLen) || 1000;
            sec.appendChild(mkHeader('Click 3D Elevation Profile or 2D Map to Place Camera'));
            sec.appendChild(buildRouteGraphs());

            const modeRow = document.createElement('div');
            modeRow.className = 'pip-row';
            const btnPin = document.createElement('button');
            btnPin.type = 'button';
            btnPin.className = !rc.followRider ? 'warn' : '';
            btnPin.textContent = '🔒 Pin at Fixed KM';
            btnPin.onclick = () => { rc.followRider = false; renderPanel(); scheduleSave(); };

            const btnFollow = document.createElement('button');
            btnFollow.type = 'button';
            btnFollow.className = rc.followRider ? 'active' : '';
            btnFollow.textContent = '🚴 Pace Ahead';
            btnFollow.onclick = () => { rc.followRider = true; renderPanel(); scheduleSave(); };

            const btnHere = document.createElement('button');
            btnHere.type = 'button';
            btnHere.textContent = '📍 Snap +35m Ahead';
            btnHere.onclick = () => {
                rc.followRider = false;
                rc.distM = ((P.egoDistM + 35) % totalM + totalM) % totalM;
                renderPanel();
                scheduleSave();
            };

            modeRow.append(btnPin, btnFollow, btnHere);
            sec.appendChild(modeRow);

            sec.appendChild(mkHeader('Camera Position Along 3D Route (Click # to type)'));
            if (rc.followRider) {
                sec.appendChild(mkSlider('Pace Distance Ahead', -150, 600, 0.1, () => rc.aheadMeters, v => { rc.aheadMeters = v; updateRouteSvgMarkers(); }, 'm', 45).row);
            } else {
                const maxKm = +(totalM / 1000).toFixed(3) || 20;
                kmSliderCtl = mkSlider('Course KM Mark', 0, maxKm, 0.001, () => +(rc.distM / 1000).toFixed(3), v => {
                    rc.distM = v * 1000;
                    updateRouteSvgMarkers();
                }, 'km');
                sec.appendChild(kmSliderCtl.row);
                sec.appendChild(mkSlider('Fine Along-Road', -100, 100, 0.01, () => rc.fineAlongM, v => { rc.fineAlongM = v; updateRouteSvgMarkers(); }, 'm', 0).row);
            }

            sec.append(
                mkSlider('Road Shoulder (L/R)', -30, 30, 0.01, () => rc.shoulderMeters, v => rc.shoulderMeters = v, 'm', 3.0).row,
                       mkSlider('Camera Height', -5, 60, 0.01, () => rc.heightMeters, v => rc.heightMeters = v, 'm', 1.8).row,
                       mkSlider('World X Fine Nudge', -50, 50, 0.01, () => rc.worldX, v => rc.worldX = v, 'm', 0).row,
                       mkSlider('World Z Fine Nudge', -50, 50, 0.01, () => rc.worldZ, v => rc.worldZ = v, 'm', 0).row,
            );

            sec.appendChild(mkHeader('Focus Target & Camera Aim'));
            const aimRow = document.createElement('div');
            aimRow.className = 'pip-row';
            const btnRoad = document.createElement('button');
            btnRoad.type = 'button';
            btnRoad.className = !rc.trackRider ? 'active' : '';
            btnRoad.textContent = '🛣️ Look at Road Target';
            btnRoad.onclick = () => { rc.trackRider = false; renderPanel(); scheduleSave(); };

            const btnTrack = document.createElement('button');
            btnTrack.type = 'button';
            btnTrack.className = rc.trackRider ? 'active' : '';
            btnTrack.textContent = '🎯 Auto-Pan to Rider';
            btnTrack.onclick = () => { rc.trackRider = true; renderPanel(); scheduleSave(); };
            aimRow.append(btnRoad, btnTrack);
            sec.appendChild(aimRow);

            if (!rc.trackRider) {
                sec.appendChild(mkSlider('Look Dist Along Road', -150, 150, 0.05, () => rc.lookAlongMeters, v => rc.lookAlongMeters = v, 'm', -30).row);
            }
            sec.append(
                mkSlider('Focus Target Height', -10, 25, 0.01, () => rc.focusHeight, v => rc.focusHeight = v, 'm', 0.8).row,
                       mkSlider('Focus Target L/R', -15, 15, 0.01, () => rc.lookShoulderMeters, v => rc.lookShoulderMeters = v, 'm', 0).row,
                       mkSlider('Yaw Trim', -180, 180, 0.05, () => rc.yawTrim, v => rc.yawTrim = v, '°', 0).row,
                       mkSlider('Pitch Trim', -85, 85, 0.05, () => rc.pitchTrim, v => rc.pitchTrim = v, '°', 0).row,
                       mkSlider('Camera Roll', -45, 45, 0.05, () => rc.rollTrim, v => rc.rollTrim = v, '°', 0).row,
            );

        } else if (P.mode === 'rear') {
            sec.append(
                mkHeader('Rear Camera Position & Aim'),
                       mkSlider('Forward offset', -10, 20, 0.01, () => P.rel.fwd, v => P.rel.fwd = v, 'm', 4.5).row,
                       mkSlider('Side offset', -10, 10, 0.01, () => P.rel.right, v => P.rel.right = v, 'm', 0).row,
                       mkSlider('Height offset', -3, 10, 0.01, () => P.rel.up, v => P.rel.up = v, 'm', -0.2).row,
                       mkSlider('Pitch tilt', -85, 85, 0.05, () => P.rel.pitch, v => P.rel.pitch = v, '°', -4).row,
                       mkSlider('Yaw pan', -180, 180, 0.05, () => P.rel.yaw, v => P.rel.yaw = v, '°', 0).row,
                       mkSlider('Roll tilt', -45, 45, 0.05, () => P.rel.roll, v => P.rel.roll = v, '°', 0).row,
            );
        } else if (P.mode === 'drone') {
            sec.append(
                mkHeader('Chase Drone Position & Focus'),
                       mkSlider('Distance back', -40, 60, 0.05, () => P.drone.back, v => P.drone.back = v, 'm', 12).row,
                       mkSlider('Height up', -2, 80, 0.05, () => P.drone.up, v => P.drone.up = v, 'm', 14).row,
                       mkSlider('Side offset', -30, 30, 0.05, () => P.drone.right, v => P.drone.right = v, 'm', 0).row,
                       mkSlider('Focus Ahead of Bike', -20, 40, 0.05, () => P.drone.focusFwd, v => P.drone.focusFwd = v, 'm', 4).row,
                       mkSlider('Focus Height on Bike', -5, 15, 0.01, () => P.drone.focusHeight, v => P.drone.focusHeight = v, 'm', 0.5).row,
            );
        }

        const commonSec = document.createElement('div');
        commonSec.className = 'pip-sec';
        commonSec.append(
            mkHeader('Lens & Clipping (Click # to type exact value)'),
                         mkSlider('Lens FOV Scale', 0.1, 3.0, 0.01, () => P.fovScale, v => P.fovScale = v, 'x', 1.0).row,
                         mkSlider('Near Clip Plane', 0.0, 5.0, 0.001, () => P.nearClip, v => P.nearClip = v, 'm', 0.0).row,
        );
        panel.append(sec, commonSec);
    }

    chip.onclick = () => {
        const show = panel.style.display !== 'flex';
        if (show && !P.enabled) {
            // Automatically turn PiP ON if user clicks the chip while it was saved as OFF
            P.enabled = true;
            syncDragOverlay();
            scheduleSave();
        }
        panel.style.display = show ? 'flex' : 'none';
        if (show) renderPanel();
    };

        document.body.append(chip, panel, dragBox);
        syncDragOverlay();

        /* ── 5. WebGPU Hook & Continuous Engine Watcher ───────────────────────────── */
        let hookedEng = null;
        let prevRender = null;
        let savedGetTex = null;

        function installPip(eng) {
            if (!eng || !eng.device || hookedEng === eng) return;

            // If switching from an older engine instance on SPA re-entry, restore the old one first
            if (hookedEng && prevRender) {
                try { hookedEng.render = prevRender; } catch (e) {}
            }

            const gpu = eng.device.gpu;
            const ctx = eng.device.context;
            savedGetTex = ctx.getCurrentTexture;
            prevRender = eng.render;
            hookedEng = eng;
            P.tex = null;
            P.tripod = null;
            route3D = null;

            function ensurePipGPU(backTex) {
                const cw = backTex.width, ch = backTex.height, fmt = backTex.format || eng.device.format || 'bgra8unorm';
                if (P.tex && P.w === cw && P.h === ch && P.fmt === fmt) return;
                try { if (P.tex) P.tex.destroy(); if (P.ubo) P.ubo.destroy(); } catch (e) {}

                P.w = cw; P.h = ch; P.fmt = fmt;
                P.tex = gpu.createTexture({
                    label: 'pip-tex',
                    size: { width: cw, height: ch, depthOrArrayLayers: 1 },
                    format: fmt,
                        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                });
                P.view = P.tex.createView();
                P.sampler = P.sampler || gpu.createSampler({ magFilter: 'linear', minFilter: 'linear' });
                P.ubo = gpu.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

                const module = gpu.createShaderModule({
                    label: 'pip-shader',
                    code: `
                    struct PipCfg { rect : vec4f, opts : vec4f };
                    @group(0) @binding(0) var pipTex : texture_2d<f32>;
                    @group(0) @binding(1) var samp : sampler;
                    @group(0) @binding(2) var<uniform> cfg : PipCfg;

                    @vertex fn vs(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
                        var p = array<vec4f, 3>(vec4f(-1.0, -1.0, 0.0, 1.0), vec4f(3.0, -1.0, 0.0, 1.0), vec4f(-1.0, 3.0, 0.0, 1.0));
                        return p[vi];
                    }

                    @fragment fn fs(@builtin(position) pos : vec4f) -> @location(0) vec4f {
                        let eyeW = cfg.opts.z;
                        let localX = select(pos.x, pos.x - select(0.0, eyeW, pos.x >= eyeW), cfg.opts.y > 0.5);
                        let rx = cfg.rect.x; let ry = cfg.rect.y; let rw = cfg.rect.z; let rh = cfg.rect.w;
                        if (localX < rx || localX > rx + rw || pos.y < ry || pos.y > ry + rh) { discard; }
                        let bw = 2.5;
                        if (localX < rx + bw || localX > rx + rw - bw || pos.y < ry + bw || pos.y > ry + rh - bw) {
                            return vec4f(0.0, 0.85, 0.85, 1.0);
                        }
                        var u = (localX - rx) / rw;
                        if (cfg.opts.x > 0.5) { u = 1.0 - u; }
                        let v = (pos.y - ry) / rh;
                        return textureSampleLevel(pipTex, samp, vec2f(u, v), 0.0);
                    }
                    `
                });

                P.pipe = gpu.createRenderPipeline({
                    label: 'pip-pipeline',
                    layout: 'auto',
                    vertex: { module, entryPoint: 'vs' },
                    fragment: { module, entryPoint: 'fs', targets: [{ format: fmt }] },
                    primitive: { topology: 'triangle-list' },
                });

                P.bg = gpu.createBindGroup({
                    layout: P.pipe.getBindGroupLayout(0),
                                           entries: [
                                               { binding: 0, resource: P.view },
                                               { binding: 1, resource: P.sampler },
                                               { binding: 2, resource: { buffer: P.ubo } },
                                           ],
                });
            }

            eng.render = function (fs, rq) {
                prevRender.call(this, fs, rq);
                if (!P.enabled || !isRideOrSpectate()) return;

                const cam = fs && fs.camera;
                if (!cam || typeof cam.update !== 'function' || !cam.view) return;

                let backTex;
                try { backTex = savedGetTex.call(ctx); } catch (e) { return; }
                if (!backTex || !backTex.width) return;
                ensurePipGPU(backTex);

                const sbsActive = document.documentElement.classList.contains('sbs3d-hud-active');
                const viewW = sbsActive ? backTex.width * 0.5 : backTex.width;
                const viewH = backTex.height;
                const pxW = Math.round(P.rect.w * viewW);
                const pxH = Math.round(P.rect.h * viewH);
                const pxX = Math.round(P.rect.x * viewW);
                const pxY = Math.round(P.rect.y * viewH);

                if (P.frame++ % P.every === 0) {
                    const v = cam.view;
                    const origRot = [v[0], v[4], v[8], v[1], v[5], v[9], v[2], v[6], v[10]];
                    const origWp = { x: cam.worldPosition.x, y: cam.worldPosition.y, z: cam.worldPosition.z };
                    const origState = {
                        worldPosition: origWp, rotation: origRot,
                        fov: cam.fov, aspect: cam.aspect, near: cam.near, far: cam.far, zoom: cam.zoom, origin: fs.origin
                    };

                    const rx = v[0], ry = v[4], rz = v[8];
                    const fx = -v[2], fy = -v[6], fz = -v[10];

                    P.lastMainWp = origWp;
                    P.lastMainFwd = { x: fx, y: fy, z: fz };
                    P.lastMainRight = { x: rx, y: ry, z: rz };

                    if (!route3D || P.frame % 60 === 0) resolveNative3DRoute();
                    if (!P.tripod) dropTripodAtCurrentBike();

                    let hfx = fx, hfz = fz;
                    const hfl = Math.hypot(hfx, hfz) || 1;
                    hfx /= hfl; hfz /= hfl;
                    const hrx = -hfz, hrz = hfx;

                    let bikeGround = {
                        x: origWp.x + hfx * 4.0,
 y: origWp.y - 1.3,
 z: origWp.z + hfz * 4.0,
                    };
                    try {
                        const rc = window.btApp && window.btApp.riderController;
                        const ego = rc && (rc.ego || rc.focalRider);
                        const simPos = ego && ego.sim && (ego.sim.position || ego.sim.midPosition);
                        if (simPos && Number.isFinite(simPos.x) && Number.isFinite(simPos.z)) {
                            bikeGround = { x: simPos.x, y: simPos.y || 0, z: simPos.z };
                        }
                    } catch (e) {}

                    if (route3D) updateEgoRouteDist(bikeGround);

                    let pipWp = { ...origWp };
                    let pipRot = origRot;

                    if (P.mode === 'pinned') {
                        const T = P.tripod;
                        const tc = P.tripodCfg;
                        pipWp = {
                            x: T.basePos.x + T.fwd.x * tc.fwd + T.right.x * tc.right + tc.worldX,
 y: T.basePos.y + tc.up,
 z: T.basePos.z + T.fwd.z * tc.fwd + T.right.z * tc.right + tc.worldZ,
                        };
                        if (tc.trackRider) {
                            const target = {
                                x: bikeGround.x + hfx * tc.focusFwd + hrx * tc.focusRight,
 y: bikeGround.y + tc.focusHeight,
 z: bikeGround.z + hfz * tc.focusFwd + hrz * tc.focusRight,
                            };
                            const base = lookAtRot(pipWp, target);
                            pipRot = rotateBasis([base[0], base[1], base[2]], [base[3], base[4], base[5]], [base[6], base[7], base[8]], 0, 0, tc.roll);
                        } else {
                            const roadFocus = {
                                x: T.basePos.x + T.fwd.x * tc.focusFwd + T.right.x * tc.focusRight + tc.worldX,
 y: T.basePos.y + tc.focusHeight,
 z: T.basePos.z + T.fwd.z * tc.focusFwd + T.right.z * tc.focusRight + tc.worldZ,
                            };
                            const baseR = [T.right.x, 0, T.right.z];
                            const baseU = [0, 1, 0];
                            const baseB = [-T.fwd.x, 0, -T.fwd.z];
                            const dy = roadFocus.y - pipWp.y;
                            const distHoriz = Math.hypot(roadFocus.x - pipWp.x, roadFocus.z - pipWp.z) || 25;
                            const focusPitchDeg = Math.atan2(dy, distHoriz) * 180 / Math.PI;
                            pipRot = rotateBasis(baseR, baseU, baseB, tc.yaw, tc.pitch + focusPitchDeg, tc.roll);
                        }
                    } else if (P.mode === 'route' && route3D) {
                        const rc = P.routeCfg;
                        const totalM = route3D.totalLen;
                        const baseDistM = rc.followRider
                        ? ((P.egoDistM + rc.aheadMeters) % totalM + totalM) % totalM
                        : rc.distM;
                        if (rc.followRider) rc.distM = baseDistM;

                        const actualCamDistM = ((baseDistM + rc.fineAlongM) % totalM + totalM) % totalM;
                        const camSample = sampleRoute3D(actualCamDistM);
                        const lookSample = sampleRoute3D(actualCamDistM + rc.lookAlongMeters);

                        if (camSample && lookSample) {
                            const rawWp = {
                                x: camSample.p.x + camSample.n.x * rc.shoulderMeters + rc.worldX,
 y: camSample.p.y + rc.heightMeters,
 z: camSample.p.z + camSample.n.z * rc.shoulderMeters + rc.worldZ,
                            };

                            if (rc.followRider && P.smoothWp) {
                                const a = 0.15;
                                P.smoothWp = {
                                    x: P.smoothWp.x + (rawWp.x - P.smoothWp.x) * a,
 y: P.smoothWp.y + (rawWp.y - P.smoothWp.y) * a,
 z: P.smoothWp.z + (rawWp.z - P.smoothWp.z) * a,
                                };
                                pipWp = P.smoothWp;
                            } else {
                                pipWp = rawWp;
                                P.smoothWp = rawWp;
                            }

                            if (rc.trackRider) {
                                const targetW = {
                                    x: bikeGround.x + hrx * rc.lookShoulderMeters,
 y: bikeGround.y + rc.focusHeight,
 z: bikeGround.z + hrz * rc.lookShoulderMeters,
                                };
                                const baseRot = lookAtRot(pipWp, targetW);
                                pipRot = rotateBasis(
                                    [baseRot[0], baseRot[1], baseRot[2]],
                                    [baseRot[3], baseRot[4], baseRot[5]],
                                    [baseRot[6], baseRot[7], baseRot[8]],
                                    rc.yawTrim, rc.pitchTrim, rc.rollTrim
                                );
                            } else {
                                const targetW = {
                                    x: lookSample.p.x + lookSample.n.x * rc.lookShoulderMeters + rc.worldX,
 y: lookSample.p.y + rc.focusHeight,
 z: lookSample.p.z + lookSample.n.z * rc.lookShoulderMeters + rc.worldZ,
                                };
                                const baseRot = lookAtRot(pipWp, targetW);
                                pipRot = rotateBasis(
                                    [baseRot[0], baseRot[1], baseRot[2]],
                                    [baseRot[3], baseRot[4], baseRot[5]],
                                    [baseRot[6], baseRot[7], baseRot[8]],
                                    rc.yawTrim, rc.pitchTrim, rc.rollTrim
                                );
                            }
                        }
                    } else if (P.mode === 'rear') {
                        pipWp = {
                            x: origWp.x + hfx * P.rel.fwd + hrx * P.rel.right,
 y: origWp.y + P.rel.up,
 z: origWp.z + hfz * P.rel.fwd + hrz * P.rel.right,
                        };
                        pipRot = rotateBasis([-hrx, 0, -hrz], [0, 1, 0], [hfx, 0, hfz], P.rel.yaw, P.rel.pitch, P.rel.roll);
                    } else if (P.mode === 'drone') {
                        pipWp = {
                            x: origWp.x - hfx * P.drone.back + hrx * P.drone.right,
 y: origWp.y + P.drone.up,
 z: origWp.z - hfz * P.drone.back + hrz * P.drone.right,
                        };
                        const target = {
                            x: bikeGround.x + hfx * P.drone.focusFwd,
 y: bikeGround.y + P.drone.focusHeight,
 z: bikeGround.z + hfz * P.drone.focusFwd,
                        };
                        pipRot = lookAtRot(pipWp, target);
                    }

                    try {
                        const safeNear = Math.max(1e-5, P.nearClip);
                        cam.update({
                            worldPosition: pipWp,
                            rotation: pipRot,
                            fov: cam.fov * P.fovScale,
                            aspect: pxW / Math.max(1, pxH),
                                   near: safeNear,
                                   far: cam.far,
                                   zoom: cam.zoom,
                                   origin: fs.origin,
                        });
                        ctx.getCurrentTexture = () => P.tex;
                        (window.__btRealRender || prevRender).call(this, fs, rq);
                    } catch (e) {
                        log('render err:', e);
                    } finally {
                        ctx.getCurrentTexture = savedGetTex;
                        cam.update(origState);
                    }
                }

                try {
                    const mirrorFlag = (P.mode === 'rear' && P.mirror) ? 1.0 : 0.0;
                    gpu.queue.writeBuffer(P.ubo, 0, new Float32Array([
                        pxX, pxY, pxW, pxH,
                        mirrorFlag, sbsActive ? 1.0 : 0.0, viewW, 0
                    ]));

                    const enc = gpu.createCommandEncoder();
                    const rp = enc.beginRenderPass({
                        colorAttachments: [{ view: backTex.createView(), loadOp: 'load', storeOp: 'store' }],
                    });
                    rp.setPipeline(P.pipe);
                    rp.setBindGroup(0, P.bg);
                    rp.draw(3);
                    rp.end();
                    gpu.queue.submit([enc.finish()]);
                } catch (e) {}

                syncDragOverlay();
                if (P.frame % 15 === 0) updateRouteSvgMarkers();
            };

                chip.textContent = '🎥 PiP Cam';
                syncDragOverlay();
                log('installed into engine (v0.2.1)');
        }

        // Poll every 400ms so we catch btApp.engine whether loaded directly on /ride or navigated via SPA
        let featureHookedApp = null;
        const watchTimer = setInterval(() => {
            syncDragOverlay();
            if (!isRideOrSpectate()) return;
            const app = window.btApp;
            if (!app) return;

            if (app.engine && typeof app.engine.render === 'function' && hookedEng !== app.engine) {
                installPip(app.engine);
                return;
            }

            if (!app.engine && typeof app.addFeature === 'function' && featureHookedApp !== app) {
                featureHookedApp = app;
                try {
                    app.addFeature((scope, env) => ({
                        frame() {
                            if (env && env.engine && hookedEng !== env.engine) {
                                installPip(env.engine);
                            }
                        }
                    }));
                } catch (e) {}
            }
        }, 400);

        function cleanup() {
            clearInterval(watchTimer);
            clearTimeout(saveTimer);
            P.enabled = false;
            try {
                if (hookedEng && prevRender) hookedEng.render = prevRender;
                if (hookedEng && hookedEng.device && hookedEng.device.context && savedGetTex) {
                    hookedEng.device.context.getCurrentTexture = savedGetTex;
                }
            } catch (e) {}
            try { if (P.tex) P.tex.destroy(); if (P.ubo) P.ubo.destroy(); } catch (e) {}
            try { chip.remove(); panel.remove(); dragBox.remove(); } catch (e) {}
            try { if (uninjectCss) uninjectCss(); } catch (e) {}
            log('cleaned up');
        }

        window.__btPipCleanup = cleanup;
        try { if (typeof terra !== 'undefined' && terra.onCleanup) terra.onCleanup(cleanup); } catch (e) {}
        try {
            if (typeof terra !== 'undefined' && terra.onNavigate) {
                terra.onNavigate(() => {
                    route3D = null;
                    P.tripod = null;
                    syncDragOverlay();
                });
            }
        } catch (e) {}
})();
