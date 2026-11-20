(() => {
  const DEFAULTS = {
    sensitivity: 'all',
    approach_m: '250',
    zoom_elevation_svg: true,
    zoom_pad_m: '250',
    replace_road_dials: true,
    ticker_mode: 'always',
    flat_mode: 'compact',
    units: 'metric',
    opacity: 88,
  };
  let S = { ...DEFAULTS };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));

  const SENSITIVITY_CFG = {
    all:    { minLen: 400, minAvgGrade: 3.0, minScore: 1200, punchyMinLen: 200, punchyMinGrade: 6.0, punchyMinScore: 1500 },
    medium: { minLen: 350, minAvgGrade: 3.0, minScore: 3000, punchyMinLen: 250, punchyMinGrade: 8.0, punchyMinScore: 2500 },
    large:  { minLen: 500, minAvgGrade: 3.0, minScore: 7500, punchyMinLen: 500, punchyMinGrade: 3.0, punchyMinScore: 7500 },
  };

  let cachedRoute = null;
  let cachedClimbsKey = '';
  let cachedClimbs = [];
  let lastIdx = 0;
  let drawerListOpen = false;
  let inspectedClimbIndex = null;
  let timer = null;
  let cleaned = false;

  // On-screen elevation SVG zoom state
  const svgOriginals = new WeakMap();
  const svgPathCache = new WeakMap();
  const ZOOM_ANIM_MS = 600;
  let activeZoomedSvg = null;
  let activeZoomedGraph = null;
  let activeZoomState = null;
  let cursorRafId = null;
  let zoomFromVb = null;
  let zoomTargetVb = null;
  let zoomCurrentVb = null;
  let zoomAnimStart = null;
  let zoomRestoring = false;
  let lastAppliedVbStr = null;
  let zoomManualFull = false;
  let canToggleZoom = false;
  let detectedNativeBox = null;
  let vbObserver = null;
  let observedSvg = null;
  let guardedOrig = null;
  let guardedGraph = null;
  let guardedRoute = null;
  let guardedCurDist = 0;
  const boundGraphs = new WeakSet();
  const graphClickCleanups = [];

  let dockedPanel = null;
  let hiddenGaugesRow = null;

  const CSS = `
/* Host elevation panel when Karoo Climber is docked seamlessly above .elev-graph */
.panel-profile.tr-cl-profile-host {
  height: auto !important;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.road-row.tr-cl-hide-gauges {
  justify-content: center;
}
.road-row.tr-cl-hide-gauges > .gauge {
  display: none !important;
}
.panel-profile.tr-cl-profile-host > .elev-graph {
  height: var(--hud-profile-h, min(6rem, 15svh));
  flex: none;
}

/* Base card — mirrors Biketerra's in-ride Rider Stat HUD (--overlay-4, borderless, rem-scaled) */
.tr-cl {
  position: fixed;
  left: 1rem;
  bottom: 8.25rem;
  top: auto;
  z-index: 2147483640;
  width: 21.5rem;
  border-radius: var(--radius-md, 0.5rem);
  padding: 0.55rem 0.7rem;
  background-color: var(--overlay-4, rgba(0, 0, 0, 0.53));
  color: #fff;
  font-family: var(--font, "Overpass", system-ui, -apple-system, sans-serif);
  font-size: 0.85rem;
  line-height: 1.3;
  text-shadow: var(--hud-text-shadow, 1px 1px 2px var(--overlay-4, rgba(0, 0, 0, 0.5)));
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  box-sizing: border-box;
}
.tr-cl:active { cursor: grabbing; }
.tr-cl.compact { width: auto; min-width: 15.5rem; max-width: 22rem; padding: 0.45rem 0.65rem; }

/* Docked inside Biketerra's .panel-profile.bg-dark (shares its native glass surface seamlessly) */
.tr-cl.tr-cl-docked {
  position: relative;
  left: auto;
  right: auto;
  top: auto;
  bottom: auto;
  z-index: auto;
  width: 100%;
  min-width: 0;
  max-width: none;
  border-radius: 0;
  padding: 0.35rem 0.6rem 0.4rem;
  background: transparent;
  border-bottom: 1px solid var(--white-1, rgba(255, 255, 255, 0.1));
  cursor: default;
}
.tr-cl.tr-cl-docked:active { cursor: default; }
.tr-cl.tr-cl-docked.compact {
  width: 100%;
  max-width: none;
  padding: 0.3rem 0.6rem;
}

.tr-cl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.35rem 0.6rem;
}
.tr-cl-head-l {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
}
.tr-cl-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.42rem;
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  padding: 0.14rem 0.42rem 0;
  border-radius: var(--radius-sm, 0.25rem);
  background: var(--bt-a, #ff6262);
  color: #fff;
  text-shadow: none;
  flex-shrink: 0;
  box-sizing: border-box;
}
.tr-cl-badge.approach {
  background: color-mix(in oklab, var(--bt-8, #ffa574) 85%, #000);
  color: #111;
}
.tr-cl-badge.flat {
  background: var(--white-1, rgba(255, 255, 255, 0.1));
  color: var(--white-4, rgba(255, 255, 255, 0.8));
}
.tr-cl-title {
  font-weight: 700;
  font-size: 0.84rem;
  line-height: 1;
  padding-top: 0.12rem;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tr-cl-head-r {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
  margin-left: auto;
}
.tr-cl-draft {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.3rem;
  min-width: 4.55rem;
  height: 1.42rem;
  padding: 0.14rem 0.42rem 0;
  border-radius: var(--radius-sm, 0.25rem);
  background: var(--overlay-3, rgba(0, 0, 0, 0.45));
  flex-shrink: 0;
  box-sizing: border-box;
}
.tr-cl-draft-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 0%;
  background: var(--success, #6dd44d);
  opacity: 0.62;
  transition: width 0.15s ease-out;
  pointer-events: none;
}
.tr-cl-draft-lbl {
  position: relative;
  z-index: 1;
  font-size: 0.58rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--white-4, rgba(255, 255, 255, 0.85));
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.88);
}
.tr-cl-draft-val {
  position: relative;
  z-index: 1;
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #fff;
  min-width: 2ch;
  text-align: right;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.92), 0 0 2px rgba(0, 0, 0, 0.78);
}
.tr-cl-grade {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 4.1rem;
  height: 1.42rem;
  padding: 0.16rem 0.45rem 0;
  border-radius: var(--radius-sm, 0.25rem);
  background: var(--overlay-3, rgba(0, 0, 0, 0.45));
  box-sizing: border-box;
}
.tr-cl-grade-fill {
  position: absolute;
  left: -40%;
  top: 50%;
  width: 180%;
  height: 160%;
  transform-origin: 50% 0%;
  background: transparent;
  opacity: 0.88;
  transition: transform 0.2s ease-out, background-color 0.2s ease-out;
  pointer-events: none;
}
.tr-cl-grade-val {
  position: relative;
  z-index: 1;
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.84rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.92), 0 0 2px rgba(0, 0, 0, 0.78);
}
.tr-cl-list-btn {
  border: 0;
  background: var(--white-1, rgba(255, 255, 255, 0.09));
  color: var(--white-4, rgba(255, 255, 255, 0.8));
  border-radius: var(--radius-sm, 0.25rem);
  height: 1.42rem;
  padding: 0.14rem 0.48rem 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  box-sizing: border-box;
}
.tr-cl-list-btn:hover { background: var(--white-2, rgba(255, 255, 255, 0.22)); color: #fff; }
.tr-cl-list-btn.open { background: var(--white-2, rgba(255, 255, 255, 0.24)); color: #fff; }

.tr-cl-zoom-btn {
  border: 0;
  background: var(--white-1, rgba(255, 255, 255, 0.09));
  color: var(--white-4, rgba(255, 255, 255, 0.8));
  border-radius: var(--radius-sm, 0.25rem);
  padding: 0 0.35rem;
  min-width: 1.5rem;
  height: 1.42rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-sizing: border-box;
}
.tr-cl-zoom-btn:hover { background: var(--white-2, rgba(255, 255, 255, 0.22)); color: #fff; }
.tr-cl-zoom-btn.full { background: var(--white-2, rgba(255, 255, 255, 0.24)); color: var(--success, #6dd44d); }
.tr-cl-zoom-btn svg { width: 0.8rem; height: 0.8rem; display: block; pointer-events: none; }
.tr-elev-graph-interactive { cursor: pointer; }

/* Inline Biketerra Rider-Stat KPI strip (horizontal in docked bar, 3-col grid in floating/preview) */
.tr-cl-kpis {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
}
.tr-cl.tr-cl-docked .tr-cl-kpis {
  padding-left: 0.6rem;
  border-left: 1px solid var(--white-1, rgba(255, 255, 255, 0.14));
}
.tr-cl-kpi {
  display: inline-flex;
  align-items: baseline;
  gap: 0.28rem;
  padding-top: 0.12rem;
  white-space: nowrap;
}
.tr-cl-kpi-val {
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.92rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: #fff;
}
.tr-cl-kpi-lbl {
  font-size: 0.72rem;
  font-weight: 400;
  line-height: 1;
  color: var(--white-4, rgba(255, 255, 255, 0.75));
}

.tr-cl:not(.tr-cl-docked) .tr-cl-kpis {
  order: 3;
  flex-basis: 100%;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.35rem;
  margin-top: 0.25rem;
}
.tr-cl:not(.tr-cl-docked) .tr-cl-kpi {
  flex-direction: column-reverse;
  gap: 0.08rem;
  background: var(--overlay-2, rgba(0, 0, 0, 0.28));
  border-radius: var(--radius-sm, 0.25rem);
  padding: 0.3rem 0.45rem;
}
.tr-cl:not(.tr-cl-docked) .tr-cl-kpi-lbl {
  font-size: 0.64rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--white-3, rgba(255, 255, 255, 0.58));
}
.tr-cl:not(.tr-cl-docked) .tr-cl-kpi-val {
  font-size: 1.05rem;
}

/* 500m Karoo color-block ticker strip */
.tr-cl-body {
  margin-top: 0.35rem;
}
.tr-cl-scroller-lbl {
  display: flex;
  justify-content: space-between;
  font-size: 0.65rem;
  color: var(--white-3, rgba(255, 255, 255, 0.58));
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 0.2rem;
}
.tr-cl.tr-cl-docked .tr-cl-scroller-lbl {
  display: none;
}
.tr-cl-ticker-canvas {
  display: block;
  width: 100%;
  height: 2.05rem;
  border-radius: var(--radius-sm, 0.25rem);
  background: var(--overlay-2, rgba(0, 0, 0, 0.28));
}
.tr-cl.tr-cl-docked .tr-cl-ticker-canvas {
  height: 1.42rem;
}

/* Flat-road compact summary */
.tr-cl-compact-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  margin-top: 0.28rem;
  font-size: 0.78rem;
  color: var(--white-4, rgba(255, 255, 255, 0.8));
  font-variant-numeric: tabular-nums;
}
.tr-cl-compact-row strong {
  color: #fff;
  font-weight: 700;
}
.tr-cl.tr-cl-docked .tr-cl-compact-row {
  margin-top: 0;
  gap: 0.55rem;
  font-size: 0.76rem;
  line-height: 1;
  padding: 0.12rem 0 0 0.6rem;
  border-left: 1px solid var(--white-1, rgba(255, 255, 255, 0.14));
  white-space: nowrap;
}

/* Climb list drawer */
.tr-cl-drawer {
  margin-bottom: 0.45rem;
  border-bottom: 1px solid var(--white-1, rgba(255, 255, 255, 0.1));
  padding-bottom: 0.4rem;
  max-height: 9.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.tr-cl-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.28rem 0.5rem;
  border-radius: var(--radius-sm, 0.25rem);
  background: var(--overlay-2, rgba(0, 0, 0, 0.26));
  border: 0;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  text-align: left;
  color: var(--white-4, rgba(255, 255, 255, 0.85));
}
.tr-cl-item:hover { background: var(--white-1, rgba(255, 255, 255, 0.12)); color: #fff; }
.tr-cl-item.active { box-shadow: inset 2px 0 0 var(--bt-a, #ff6262); background: color-mix(in oklab, var(--bt-a, #ff6262) 14%, var(--overlay-2, rgba(0, 0, 0, 0.26))); color: #fff; }
.tr-cl-item.done { opacity: 0.5; }
.tr-cl-item.selected { box-shadow: inset 2px 0 0 var(--success, #6dd44d); background: var(--white-1, rgba(255, 255, 255, 0.14)); color: #fff; }
.tr-cl-item-l { font-weight: 700; white-space: nowrap; }
.tr-cl-item-r { font-family: var(--font-mono, "Overpass Mono", monospace); color: var(--white-3, rgba(255, 255, 255, 0.65)); font-size: 0.72rem; white-space: nowrap; }

.tr-cl.preview { position: static; cursor: default; max-width: 100%; }

.tr-elev-graph-zoomed {
  overflow: hidden !important;
}
.tr-elev-graph-zoomed .elev-cursor {
  display: none !important;
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
.tr-elev-graph-zoomed .profile-riders {
  left: var(--tr-pr-left, 0%) !important;
  width: var(--tr-pr-width, 100%) !important;
  top: var(--tr-pr-top, 0%) !important;
  height: var(--tr-pr-height, 100%) !important;
  right: auto !important;
  bottom: auto !important;
}
.tr-elev-cursor {
  position: absolute; top: 0; bottom: 0; width: 2px;
  background: #ffffff;
  pointer-events: none; z-index: 4;
  box-sizing: border-box; margin: 0; padding: 0; border: 0;
}
svg.tr-elev-zoomed path,
svg.tr-elev-zoomed polyline,
svg.tr-elev-zoomed line {
  vector-effect: non-scaling-stroke;
}
`;
  terra.ui.addStyle(CSS);

  const ZOOM_OUT_SVG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="7" cy="7" r="4.8"></circle><line x1="10.6" y1="10.6" x2="14.2" y2="14.2"></line>' +
    '<line x1="4.8" y1="7" x2="9.2" y2="7"></line></svg>';
  const ZOOM_IN_SVG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="7" cy="7" r="4.8"></circle><line x1="10.6" y1="10.6" x2="14.2" y2="14.2"></line>' +
    '<line x1="4.8" y1="7" x2="9.2" y2="7"></line><line x1="7" y1="4.8" x2="7" y2="9.2"></line></svg>';

  function buildCard(isPreview = false) {
    const root = document.createElement('div');
    root.className = 'tr-cl' + (isPreview ? ' preview' : '');
    root.innerHTML =
      '<div class="tr-cl-drawer" style="display:none"></div>' +
      '<div class="tr-cl-head">' +
        '<div class="tr-cl-head-l">' +
          '<span class="tr-cl-draft" style="display:none" title="Current draft">' +
            '<span class="tr-cl-draft-fill"></span>' +
            '<span class="tr-cl-draft-lbl">DRAFT</span>' +
            '<span class="tr-cl-draft-val">0</span>' +
          '</span>' +
          '<span class="tr-cl-badge flat">CLIMBER</span>' +
          '<span class="tr-cl-title">Waiting for route\u2026</span>' +
        '</div>' +
        '<div class="tr-cl-kpis" style="display:none">' +
          '<div class="tr-cl-kpi"><span class="tr-cl-kpi-val tr-k1-v">\u2014</span><span class="tr-cl-kpi-lbl tr-k1-l">left</span></div>' +
          '<div class="tr-cl-kpi"><span class="tr-cl-kpi-val tr-k2-v">\u2014</span><span class="tr-cl-kpi-lbl tr-k2-l">elev</span></div>' +
          '<div class="tr-cl-kpi"><span class="tr-cl-kpi-val tr-k3-v">\u2014</span><span class="tr-cl-kpi-lbl tr-k3-l">avg</span></div>' +
        '</div>' +
        '<div class="tr-cl-compact-row" style="display:none"></div>' +
        '<div class="tr-cl-head-r">' +
          '<button type="button" class="tr-cl-zoom-btn" style="display:none" title="Zoom out to full route"></button>' +
          '<button type="button" class="tr-cl-list-btn" title="Upcoming & completed climbs">Climbs</button>' +
          '<span class="tr-cl-grade" title="Current grade">' +
            '<span class="tr-cl-grade-fill"></span>' +
            '<span class="tr-cl-grade-val">\u2014%</span>' +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="tr-cl-body">' +
        '<div class="tr-cl-scroller-wrap">' +
          '<div class="tr-cl-scroller-lbl"><span class="tr-cl-sc-title">Next 500 m</span><span class="tr-cl-sc-end">100 m steps</span></div>' +
          '<canvas class="tr-cl-ticker-canvas" width="318" height="36"></canvas>' +
        '</div>' +
      '</div>';
    return {
      root,
      badge: root.querySelector('.tr-cl-badge'),
      title: root.querySelector('.tr-cl-title'),
      draft: root.querySelector('.tr-cl-draft'),
      draftFill: root.querySelector('.tr-cl-draft-fill'),
      draftVal: root.querySelector('.tr-cl-draft-val'),
      grade: root.querySelector('.tr-cl-grade'),
      gradeFill: root.querySelector('.tr-cl-grade-fill'),
      gradeVal: root.querySelector('.tr-cl-grade-val'),
      zoomBtn: root.querySelector('.tr-cl-zoom-btn'),
      listBtn: root.querySelector('.tr-cl-list-btn'),
      kpis: root.querySelector('.tr-cl-kpis'),
      body: root.querySelector('.tr-cl-body'),
      k1l: root.querySelector('.tr-k1-l'), k1v: root.querySelector('.tr-k1-v'),
      k2l: root.querySelector('.tr-k2-l'), k2v: root.querySelector('.tr-k2-v'),
      k3l: root.querySelector('.tr-k3-l'), k3v: root.querySelector('.tr-k3-v'),
      scTitle: root.querySelector('.tr-cl-sc-title'),
      scEnd: root.querySelector('.tr-cl-sc-end'),
      tickerCanvas: root.querySelector('.tr-cl-ticker-canvas'),
      compactRow: root.querySelector('.tr-cl-compact-row'),
      drawer: root.querySelector('.tr-cl-drawer'),
    };
  }

  const ui = buildCard(false);
  document.body.appendChild(ui.root);

  let savedFloatPos = null;

  function applyFloatingPos() {
    if (!savedFloatPos || !Number.isFinite(savedFloatPos.x)) return;
    const w = ui.root.offsetWidth || 344;
    const h = ui.root.offsetHeight || 160;
    ui.root.style.left = clamp(savedFloatPos.x, 0, Math.max(0, window.innerWidth - w)) + 'px';
    if (Number.isFinite(savedFloatPos.bottom)) {
      ui.root.style.top = 'auto';
      ui.root.style.bottom = clamp(savedFloatPos.bottom, 0, Math.max(0, window.innerHeight - h)) + 'px';
    } else if (Number.isFinite(savedFloatPos.y)) {
      const estH = Math.max(h, 160);
      const bottom = Math.max(12, window.innerHeight - savedFloatPos.y - estH);
      ui.root.style.top = 'auto';
      ui.root.style.bottom = clamp(bottom, 0, Math.max(0, window.innerHeight - estH)) + 'px';
    }
  }

  function findElevationPanelHost() {
    if (typeof document.querySelector !== 'function') return null;
    const elevGraph = document.querySelector('.panel-profile .elev-graph');
    if (!elevGraph) return null;
    return (elevGraph.closest && elevGraph.closest('.panel-profile')) || elevGraph.parentElement || null;
  }

  function undockFromProfile() {
    if (dockedPanel) {
      try { dockedPanel.classList.remove('tr-cl-profile-host'); } catch {}
      dockedPanel = null;
    }
    if (ui.root.classList.contains('tr-cl-docked')) {
      ui.root.classList.remove('tr-cl-docked');
    }
    if (ui.root.parentNode !== document.body && document.body) {
      document.body.appendChild(ui.root);
    }
    applyBoxStyle();
    applyFloatingPos();
  }

  function syncDock() {
    if (cleaned) return false;
    const hostPanel = findElevationPanelHost();
    if (hostPanel) {
      if (dockedPanel && dockedPanel !== hostPanel) {
        try { dockedPanel.classList.remove('tr-cl-profile-host'); } catch {}
      }
      dockedPanel = hostPanel;
      hostPanel.classList.add('tr-cl-profile-host');
      if (!ui.root.classList.contains('tr-cl-docked')) {
        ui.root.classList.add('tr-cl-docked');
        ui.root.style.left = '';
        ui.root.style.top = '';
        ui.root.style.bottom = '';
        ui.root.style.background = '';
      }
      if (ui.root.parentNode !== hostPanel) {
        if (typeof hostPanel.insertBefore === 'function') {
          hostPanel.insertBefore(ui.root, hostPanel.firstChild || null);
        } else {
          hostPanel.appendChild(ui.root);
        }
      }
      return true;
    }
    undockFromProfile();
    return false;
  }

  function toggleManualFullZoom() {
    if (!canToggleZoom) return;
    zoomManualFull = !zoomManualFull;
    tick();
  }

  function ensureGraphClickBinding(graph) {
    if (!graph || boundGraphs.has(graph) || typeof graph.addEventListener !== 'function') return;
    boundGraphs.add(graph);
    const onClick = (e) => {
      if (!canToggleZoom || (e.target && e.target.closest && e.target.closest('button, a, .tr-cl'))) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      toggleManualFullZoom();
    };
    graph.addEventListener('click', onClick, true);
    graphClickCleanups.push(() => {
      try {
        graph.removeEventListener('click', onClick, true);
        if (graph.classList) graph.classList.remove('tr-elev-graph-interactive');
      } catch {}
    });
  }

  ui.zoomBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleManualFullZoom();
  });

  ui.listBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    drawerListOpen = !drawerListOpen;
    if (!drawerListOpen) inspectedClimbIndex = null;
    ui.listBtn.classList.toggle('open', drawerListOpen);
    tick();
  });

  function applyBoxStyle() {
    if (ui.root.classList.contains('tr-cl-docked')) {
      ui.root.style.background = '';
      return;
    }
    const op = clamp(S.opacity, 30, 100) / 100;
    ui.root.style.background = `rgba(0, 0, 0, ${(op * 0.65).toFixed(2)})`;
  }

  // Draggable persistence (only active in floating fallback when .panel-profile is absent)
  (async () => {
    try {
      const pos = await terra.storage.get('pos', null);
      if (pos && Number.isFinite(pos.x)) {
        savedFloatPos = pos;
        if (!ui.root.classList.contains('tr-cl-docked')) applyFloatingPos();
      }
    } catch {}
  })();

  let dragging = null;
  ui.root.addEventListener('pointerdown', (e) => {
    if (ui.root.classList.contains('tr-cl-docked')) return;
    if (e.button !== 0 || e.target.closest('button, .tr-cl-item')) return;
    const r = ui.root.getBoundingClientRect();
    dragging = {
      startLeft: r.left,
      startBottom: window.innerHeight - r.bottom,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
    };
    ui.root.setPointerCapture(e.pointerId);
  });
  ui.root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!dragging.moved && Math.hypot(e.clientX - dragging.sx, e.clientY - dragging.sy) > 4) {
      dragging.moved = true;
    }
    if (!dragging.moved) return;
    const x = clamp(dragging.startLeft + (e.clientX - dragging.sx), 0, Math.max(0, window.innerWidth - ui.root.offsetWidth));
    const bottom = clamp(dragging.startBottom - (e.clientY - dragging.sy), 0, Math.max(0, window.innerHeight - ui.root.offsetHeight));
    ui.root.style.left = x + 'px';
    ui.root.style.top = 'auto';
    ui.root.style.bottom = bottom + 'px';
  });
  const endDrag = () => {
    if (!dragging) return;
    const moved = dragging.moved;
    dragging = null;
    if (moved) {
      const r = ui.root.getBoundingClientRect();
      savedFloatPos = {
        x: Math.round(r.left),
        bottom: Math.round(window.innerHeight - r.bottom),
      };
      terra.storage.set('pos', savedFloatPos).catch(() => {});
    }
  };
  ui.root.addEventListener('pointerup', endDrag);
  ui.root.addEventListener('pointercancel', endDrag);

  // Karoo OS Build 1.634+ 7-band CLIMBER gradient colors
  function karooGradeColor(g) {
    if (g >= 20.0) return '#a855f7';
    if (g >= 14.0) return '#e879f9';
    if (g >= 11.0) return '#ef4444';
    if (g >= 8.0)  return '#f97316';
    if (g >= 5.0)  return '#facc15';
    if (g >= 2.0)  return '#4ade80';
    if (g >= -0.5) return '#94a3b8';
    return '#38bdf8';
  }
  function isDarkGradeBand(color) {
    return color === '#ef4444' || color === '#a855f7';
  }

  /* ---------- Biketerra On-Screen Elevation SVG viewBox Zoom ---------- */
  function parseViewBox(str) {
    if (!str) return null;
    const parts = String(str).trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    if (parts[2] <= 0 || parts[3] <= 0) return null;
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }

  function findElevationSvg() {
    if (typeof document.querySelector === 'function') {
      const direct = document.querySelector('.elev-graph svg.pathSVG, .panel-profile svg.pathSVG, .elev-graph svg');
      if (direct && parseViewBox(direct.getAttribute('viewBox'))) return direct;
    }
    if (typeof document.querySelectorAll !== 'function') return null;
    let best = null;
    let bestScore = -1;
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.closest && svg.closest('#terra-modal, .tr-cl, .nameplates-ov, .btz-panel, .action-buttons, .terra-cog, button, a')) {
        continue;
      }
      const vb = parseViewBox(svg.getAttribute('viewBox'));
      if (!vb) continue;
      const r = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { width: 0, height: 0 };
      if (r.width < 100 || r.height < 20 || r.width < r.height * 1.5) continue;

      let score = 0;
      if (svg.classList && svg.classList.contains('pathSVG')) score += 60;
      if (svg.closest && svg.closest('.elev-graph, .panel-profile, [class*="elev" i], [class*="profile" i], [class*="alt" i], [class*="climb" i], [id*="elev" i], [id*="profile" i]')) {
        score += 50;
      }
      if (svg.closest && svg.closest('.leaflet-container, .maplibregl-map, .mapboxgl-map')) {
        score -= 100;
      }
      const shapes = svg.querySelectorAll ? svg.querySelectorAll('polyline, path, polygon') : [];
      let hasWideShape = false;
      for (const sh of shapes) {
        try {
          const bb = sh.getBBox ? sh.getBBox() : null;
          if (bb && bb.width >= vb.w * 0.5) { hasWideShape = true; break; }
        } catch {}
      }
      if (hasWideShape) score += 35;
      if (r.width >= 200) score += 10;

      if (score > bestScore && score >= 35) {
        bestScore = score;
        best = svg;
      }
    }
    return best;
  }

  function parsePolylinePoints(str) {
    if (!str) return [];
    const nums = String(str).trim().split(/[\s,]+/).map(Number);
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      const x = nums[i], y = nums[i + 1];
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y });
    }
    return pts;
  }

  function getSvgSamples(svg, origVb) {
    if (!svg || !svg.querySelectorAll) return null;

    // Prefer <polyline> (Biketerra renders the full 0..1 elevation outline as one <polyline>)
    const polylines = Array.from(svg.querySelectorAll('polyline'));
    for (const pl of polylines) {
      const rawPts = parsePolylinePoints(pl.getAttribute('points'));
      if (rawPts.length >= 4) {
        const sig = `pl:${rawPts.length}:${rawPts[0].x},${rawPts[0].y}:${rawPts[rawPts.length - 1].x},${rawPts[rawPts.length - 1].y}`;
        const cached = svgPathCache.get(svg);
        if (cached && cached.sig === sig) return cached;
        let xMin = Infinity, xMax = -Infinity;
        for (const p of rawPts) {
          if (p.x < xMin) xMin = p.x;
          if (p.x > xMax) xMax = p.x;
        }
        const out = { sig, pts: rawPts, xMin, xMax };
        svgPathCache.set(svg, out);
        return out;
      }
    }

    let bestShape = null;
    let bestW = 0;
    for (const sh of svg.querySelectorAll('polyline, path, polygon')) {
      try {
        const bb = sh.getBBox ? sh.getBBox() : null;
        if (bb && bb.width > bestW) { bestW = bb.width; bestShape = sh; }
      } catch {}
    }
    if (!bestShape || bestW < origVb.w * 0.25) return null;

    const sig = (bestShape.getAttribute('d') || bestShape.getAttribute('points') || '') + '@' + origVb.w;
    const cached = svgPathCache.get(svg);
    if (cached && cached.sig === sig) return cached;

    const pts = [];
    let xMin = Infinity, xMax = -Infinity;
    if (typeof bestShape.getTotalLength === 'function' && typeof bestShape.getPointAtLength === 'function') {
      try {
        const total = bestShape.getTotalLength();
        if (total > 0) {
          const N = 160;
          for (let i = 0; i <= N; i++) {
            const p = bestShape.getPointAtLength((i / N) * total);
            if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
              pts.push({ x: p.x, y: p.y });
              if (p.x < xMin) xMin = p.x;
              if (p.x > xMax) xMax = p.x;
            }
          }
        }
      } catch {}
    }
    if (!pts.length) {
      const bb = bestShape.getBBox();
      xMin = bb.x;
      xMax = bb.x + bb.width;
      pts.push({ x: bb.x, y: bb.y }, { x: bb.x + bb.width, y: bb.y + bb.height });
    }
    const out = { sig, pts, xMin, xMax };
    svgPathCache.set(svg, out);
    return out;
  }

  let lastCursorPx = null;
  let lastCursorWidth = null;
  let lastCursorHidden = false;

  function updateZoomedCursorFor(svg, graph, vb, curVb, fallbackFrac) {
    if (!svg || !graph) return;
    const origCursor = graph.querySelector ? graph.querySelector('.elev-cursor') : null;
    if (!origCursor) return;

    let trCursor = graph.querySelector ? graph.querySelector('.tr-elev-cursor') : null;
    if (!trCursor && typeof document.createElement === 'function') {
      trCursor = document.createElement('div');
      trCursor.className = 'tr-elev-cursor';
      graph.appendChild(trCursor);
      lastCursorPx = null;
      lastCursorWidth = null;
      lastCursorHidden = false;
    }
    if (!trCursor) return;

    let svgX;
    if (detectedNativeBox) {
      svgX = vb.x + fallbackFrac * vb.w;
    } else {
      const m = String(origCursor.style.left || '').match(/(-?\d+(?:\.\d+)?)%/);
      const riderFrac = m ? clamp(parseFloat(m[1]) / 100, 0, 1) : fallbackFrac;
      svgX = vb.x + riderFrac * vb.w;
    }
    const zoomedFrac = curVb && curVb.w > 0 ? (svgX - curVb.x) / curVb.w : fallbackFrac;

    if (zoomedFrac < -0.02 || zoomedFrac > 1.02) {
      if (!lastCursorHidden) {
        lastCursorHidden = true;
        trCursor.style.display = 'none';
      }
      return;
    }
    if (lastCursorHidden) {
      lastCursorHidden = false;
      trCursor.style.display = '';
    }

    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1;
    const physW = Math.max(1, Math.round(2 * dpr));
    const cssW = physW / dpr;
    const wStr = Number(cssW.toFixed(6)) + 'px';
    if (wStr !== lastCursorWidth) {
      lastCursorWidth = wStr;
      trCursor.style.width = wStr;
    }

    const frac = clamp(zoomedFrac, 0, 1);
    const svgRect = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    const graphRect = graph.getBoundingClientRect ? graph.getBoundingClientRect() : null;
    const refRect = (svgRect && svgRect.width > 0) ? svgRect : (graphRect && graphRect.width > 0 ? graphRect : null);

    if (refRect && refRect.width > 0) {
      const targetCenterX = refRect.left + frac * refRect.width;
      const rawScreenX = targetCenterX - cssW / 2;
      const snappedScreenX = Math.round(rawScreenX * dpr) / dpr;
      const op = trCursor.offsetParent || graph;
      const opRect = (op && op.getBoundingClientRect) ? op.getBoundingClientRect() : null;
      const originX = (opRect && opRect.width > 0)
        ? opRect.left + (op.clientLeft || 0)
        : refRect.left;
      const localLeft = snappedScreenX - originX;
      const leftStr = Number(localLeft.toFixed(6)) + 'px';
      if (leftStr !== lastCursorPx) {
        lastCursorPx = leftStr;
        trCursor.style.left = leftStr;
      }
    } else {
      const w = graph.clientWidth || 0;
      if (w > 0) {
        const px = Math.round((frac * w - cssW / 2) * dpr) / dpr;
        const leftStr = Number(px.toFixed(6)) + 'px';
        if (leftStr !== lastCursorPx) {
          lastCursorPx = leftStr;
          trCursor.style.left = leftStr;
        }
      } else {
        const pct = `${(frac * 100).toFixed(2)}%`;
        if (pct !== lastCursorPx) {
          lastCursorPx = pct;
          trCursor.style.left = pct;
        }
      }
    }
  }

  function updateZoomedCursor() {
    if (!activeZoomedSvg || !activeZoomedGraph || !activeZoomState) return;
    const { vb, curVb, fallbackFrac } = activeZoomState;
    updateZoomedCursorFor(activeZoomedSvg, activeZoomedGraph, vb, curVb, fallbackFrac);
  }

  function nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  function vbApproxEq(a, b, eps = 1e-5) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) < eps &&
      Math.abs(a.y - b.y) < eps &&
      Math.abs(a.w - b.w) < eps &&
      Math.abs(a.h - b.h) < eps;
  }

  function interpZoomAxis(p0, s0, p1, s1, ease) {
    if (!(s0 > 0) || !(s1 > 0) || Math.abs(s1 - s0) < 1e-6) {
      return { p: p0 + (p1 - p0) * ease, s: s0 + (s1 - s0) * ease };
    }
    const s = s0 * Math.pow(s1 / s0, ease);
    const t = (s - s0) / (s1 - s0);
    return { p: p0 + (p1 - p0) * t, s };
  }

  function interpolateViewBox(from, to, ease) {
    const hx = interpZoomAxis(from.x, from.w, to.x, to.w, ease);
    const vy = interpZoomAxis(from.y, from.h, to.y, to.h, ease);
    return { x: hx.p, y: vy.p, w: hx.s, h: vy.s };
  }

  function stopVbObserver() {
    if (vbObserver) {
      try { vbObserver.disconnect(); } catch {}
      vbObserver = null;
    }
    observedSvg = null;
  }

  function applyFullRouteOverride(svg, graph, orig, route, curDist) {
    if (!svg || !graph || !orig || !detectedNativeBox) return;
    if (svg.getAttribute('viewBox') !== orig.viewBox) {
      svg.setAttribute('viewBox', orig.viewBox);
    }
    if (graph.classList && !graph.classList.contains('tr-elev-graph-zoomed')) {
      graph.classList.add('tr-elev-graph-zoomed');
    }
    const nx = detectedNativeBox.x;
    const nw = detectedNativeBox.w;
    if (orig.vb.w > 0 && orig.vb.h > 0) {
      setCssVarIfChanged(graph, '--tr-pr-left', `${(((nx - orig.vb.x) / orig.vb.w) * 100).toFixed(3)}%`);
      setCssVarIfChanged(graph, '--tr-pr-width', `${((nw / orig.vb.w) * 100).toFixed(3)}%`);
      setCssVarIfChanged(graph, '--tr-pr-top', '0.000%');
      setCssVarIfChanged(graph, '--tr-pr-height', '100.000%');
    }
    const fallbackFrac = route && route.totalLen > 0 ? clamp((curDist || 0) / route.totalLen, 0, 1) : 0;
    updateZoomedCursorFor(svg, graph, orig.vb, orig.vb, fallbackFrac);
  }

  function ensureVbObserver(svg) {
    if (!svg || typeof MutationObserver !== 'function') return;
    if (observedSvg === svg && vbObserver) return;
    stopVbObserver();
    observedSvg = svg;
    vbObserver = new MutationObserver(() => {
      if (cleaned || observedSvg !== svg) return;
      const curStr = svg.getAttribute('viewBox');
      if (activeZoomedSvg === svg && lastAppliedVbStr) {
        if (curStr !== lastAppliedVbStr) {
          const curVb = parseViewBox(curStr);
          const appliedVb = parseViewBox(lastAppliedVbStr);
          if (curVb && (!appliedVb || !vbApproxEq(curVb, appliedVb, 1e-4))) {
            if (curVb.w < 0.99 || Math.abs(curVb.x) > 0.005) {
              detectedNativeBox = curVb;
            }
          }
          svg.setAttribute('viewBox', lastAppliedVbStr);
        }
        return;
      }
      if (zoomManualFull && canToggleZoom && guardedOrig && curStr !== guardedOrig.viewBox) {
        const curVb = parseViewBox(curStr);
        if (curVb && (curVb.w < 0.99 || Math.abs(curVb.x) > 0.005)) {
          detectedNativeBox = curVb;
        }
        svg.setAttribute('viewBox', guardedOrig.viewBox);
        if (guardedGraph && guardedRoute) {
          applyFullRouteOverride(svg, guardedGraph, guardedOrig, guardedRoute, guardedCurDist);
        }
      }
    });
    try {
      vbObserver.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
    } catch {}
  }

  function stopFullRouteGuard() {
    guardedOrig = null;
    guardedGraph = null;
    guardedRoute = null;
    guardedCurDist = 0;
  }

  function ensureFullRouteGuard(route, curDist) {
    const svg = findElevationSvg();
    if (!svg) return;
    const graph = (svg.closest && svg.closest('.elev-graph')) || svg.parentNode;
    if (!graph || !graph.querySelector) return;
    let orig = svgOriginals.get(svg);
    if (!orig) {
      const curVbStr = svg.getAttribute('viewBox');
      const curVb = parseViewBox(curVbStr);
      if (!curVb) return;
      const isBiketerraElevSvg =
        (svg.classList && svg.classList.contains('pathSVG')) ||
        Boolean(svg.closest && svg.closest('.elev-graph'));
      const isNativeZoomed = isBiketerraElevSvg && (curVb.w < 0.99 || Math.abs(curVb.x) > 0.005);
      if (isNativeZoomed) detectedNativeBox = curVb;
      orig = {
        viewBox: isNativeZoomed ? '0 0 1 1' : curVbStr,
        vb: isNativeZoomed ? { x: 0, y: 0, w: 1, h: 1 } : curVb,
        par: svg.getAttribute('preserveAspectRatio'),
      };
      svgOriginals.set(svg, orig);
    }
    guardedOrig = orig;
    guardedGraph = graph;
    guardedRoute = route;
    guardedCurDist = curDist || 0;
    ensureVbObserver(svg);
    if (zoomAnimStart === null && !activeZoomedSvg && detectedNativeBox) {
      applyFullRouteOverride(svg, graph, orig, route, curDist);
    }
  }

  function applyZoomViewBox(svg, graph, orig, box) {
    const vbStr = `${box.x.toFixed(5)} ${box.y.toFixed(5)} ${box.w.toFixed(5)} ${box.h.toFixed(5)}`;
    if (vbStr !== lastAppliedVbStr || svg.getAttribute('viewBox') !== vbStr) {
      lastAppliedVbStr = vbStr;
      svg.setAttribute('viewBox', vbStr);
    }
    if (svg.getAttribute('preserveAspectRatio') !== 'none') {
      svg.setAttribute('preserveAspectRatio', 'none');
    }
    if (svg.classList && !svg.classList.contains('tr-elev-zoomed')) {
      svg.classList.add('tr-elev-zoomed');
    }
    if (graph && graph.querySelector) {
      if (graph.classList && !graph.classList.contains('tr-elev-graph-zoomed')) {
        graph.classList.add('tr-elev-graph-zoomed');
      }
      const baseX = detectedNativeBox ? detectedNativeBox.x : orig.vb.x;
      const baseW = detectedNativeBox ? detectedNativeBox.w : orig.vb.w;
      const baseY = orig.vb.y;
      const baseH = orig.vb.h;
      if (box.w > 0 && box.h > 0) {
        setCssVarIfChanged(graph, '--tr-pr-left', `${(((baseX - box.x) / box.w) * 100).toFixed(3)}%`);
        setCssVarIfChanged(graph, '--tr-pr-width', `${((baseW / box.w) * 100).toFixed(3)}%`);
        setCssVarIfChanged(graph, '--tr-pr-top', `${(((baseY - box.y) / box.h) * 100).toFixed(3)}%`);
        setCssVarIfChanged(graph, '--tr-pr-height', `${((baseH / box.h) * 100).toFixed(3)}%`);
      }
    }
    if (activeZoomState) {
      activeZoomState.curVb = { x: box.x, w: box.w };
    }
  }

  function stepZoomAndCursor() {
    if (cleaned || !activeZoomedSvg || !activeZoomedGraph || !activeZoomState) {
      cursorRafId = null;
      return;
    }
    if (zoomAnimStart !== null && zoomFromVb && zoomTargetVb) {
      const rawT = clamp((nowMs() - zoomAnimStart) / ZOOM_ANIM_MS, 0, 1);
      const ease = rawT < 0.5
        ? 4 * rawT * rawT * rawT
        : 1 - Math.pow(-2 * rawT + 2, 3) / 2;
      const box = rawT >= 1 ? { ...zoomTargetVb } : interpolateViewBox(zoomFromVb, zoomTargetVb, ease);
      zoomCurrentVb = box;
      const orig = svgOriginals.get(activeZoomedSvg);
      if (orig) {
        applyZoomViewBox(activeZoomedSvg, activeZoomedGraph, orig, box);
      }
      if (rawT >= 1) {
        zoomAnimStart = null;
        zoomFromVb = null;
        if (zoomRestoring) {
          zoomRestoring = false;
          finishRestoreElevationSvg(false);
          return;
        }
      }
    }
    updateZoomedCursor();
    cursorRafId = requestAnimationFrame(stepZoomAndCursor);
  }

  function startCursorRaf() {
    if (cursorRafId !== null || typeof requestAnimationFrame !== 'function') return;
    cursorRafId = requestAnimationFrame(stepZoomAndCursor);
  }

  function stopCursorRaf() {
    if (cursorRafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(cursorRafId);
    }
    cursorRafId = null;
  }

  function finishRestoreElevationSvg(immediate = false) {
    stopCursorRaf();
    const keepFullGuard = !immediate && zoomManualFull && canToggleZoom;
    const keepNativeOverride = keepFullGuard && Boolean(detectedNativeBox);
    activeZoomState = null;
    zoomFromVb = null;
    zoomTargetVb = null;
    zoomCurrentVb = null;
    zoomAnimStart = null;
    zoomRestoring = false;
    lastAppliedVbStr = null;
    lastCursorPx = null;
    lastCursorWidth = null;
    lastCursorHidden = false;
    if (!keepFullGuard) {
      stopFullRouteGuard();
      stopVbObserver();
      detectedNativeBox = null;
    }
    const g = activeZoomedGraph;
    activeZoomedGraph = null;
    if (g && !keepNativeOverride) {
      try {
        if (g.classList) g.classList.remove('tr-elev-graph-zoomed');
        if (g.style && typeof g.style.removeProperty === 'function') {
          g.style.removeProperty('--tr-pr-left');
          g.style.removeProperty('--tr-pr-width');
          g.style.removeProperty('--tr-pr-top');
          g.style.removeProperty('--tr-pr-height');
        }
        const trCursor = g.querySelector ? g.querySelector('.tr-elev-cursor') : null;
        if (trCursor) trCursor.remove();
      } catch {}
    }
    const svg = activeZoomedSvg;
    activeZoomedSvg = null;
    if (!svg) return;
    const orig = svgOriginals.get(svg);
    try {
      if (orig) {
        svg.setAttribute('viewBox', orig.viewBox);
        if (orig.par !== null) svg.setAttribute('preserveAspectRatio', orig.par);
        else svg.removeAttribute('preserveAspectRatio');
      }
      if (svg.classList) svg.classList.remove('tr-elev-zoomed');
    } catch {}
    if (keepNativeOverride && g && orig && guardedRoute) {
      applyFullRouteOverride(svg, g, orig, guardedRoute, guardedCurDist);
    }
  }

  function restoreElevationSvg(immediate = false) {
    if (immediate || typeof requestAnimationFrame !== 'function' || !activeZoomedSvg || !zoomCurrentVb) {
      finishRestoreElevationSvg(immediate);
      return;
    }
    const orig = svgOriginals.get(activeZoomedSvg);
    if (!orig || vbApproxEq(zoomCurrentVb, orig.vb)) {
      finishRestoreElevationSvg(false);
      return;
    }
    if (zoomRestoring && vbApproxEq(zoomTargetVb, orig.vb)) {
      return;
    }
    zoomRestoring = true;
    zoomFromVb = { ...zoomCurrentVb };
    zoomTargetVb = { ...orig.vb };
    zoomAnimStart = nowMs();
    startCursorRaf();
  }

  function setCssVarIfChanged(el, name, val) {
    if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
    if (typeof el.style.getPropertyValue === 'function' && el.style.getPropertyValue(name) === val) return;
    el.style.setProperty(name, val);
  }

  function zoomElevationSvg(route, winStartDist, winEndDist, curDist) {
    if (!S.zoom_elevation_svg || !route || !(route.totalLen > 0)) {
      restoreElevationSvg(!route);
      return;
    }
    const svg = findElevationSvg();
    if (!svg) {
      restoreElevationSvg(true);
      return;
    }
    if (activeZoomedSvg && activeZoomedSvg !== svg) {
      restoreElevationSvg(true);
    }
    let orig = svgOriginals.get(svg);
    const curVbStr = svg.getAttribute('viewBox');
    const curVb = parseViewBox(curVbStr);
    if (!orig) {
      if (!curVb) return;
      const isBiketerraElevSvg =
        (svg.classList && svg.classList.contains('pathSVG')) ||
        Boolean(svg.closest && svg.closest('.elev-graph'));
      const isNativeZoomed = isBiketerraElevSvg && (curVb.w < 0.99 || Math.abs(curVb.x) > 0.005);
      if (isNativeZoomed) {
        detectedNativeBox = curVb;
      }
      orig = {
        viewBox: isNativeZoomed ? '0 0 1 1' : curVbStr,
        vb: isNativeZoomed ? { x: 0, y: 0, w: 1, h: 1 } : curVb,
        par: svg.getAttribute('preserveAspectRatio'),
      };
      svgOriginals.set(svg, orig);
    }

    const sampled = getSvgSamples(svg, orig.vb);
    if (!sampled || !(sampled.xMax > sampled.xMin)) return;

    const f0 = clamp(winStartDist / route.totalLen, 0, 1);
    const f1 = clamp(winEndDist / route.totalLen, 0, 1);
    if (f1 - f0 <= 0.005 || f1 - f0 >= 0.96) {
      restoreElevationSvg(false);
      return;
    }

    const spanX = sampled.xMax - sampled.xMin;
    const sx0 = sampled.xMin + f0 * spanX;
    const sx1 = sampled.xMin + f1 * spanX;
    const sw = sx1 - sx0;

    let yMin = Infinity, yMax = -Infinity;
    for (const p of sampled.pts) {
      if (p.x >= sx0 && p.x <= sx1) {
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    }
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
      yMin = orig.vb.y;
      yMax = orig.vb.y + orig.vb.h;
    }
    const minYSpan = orig.vb.h * 0.12;
    const ySpan = Math.max(minYSpan, yMax - yMin);
    const sy0 = Math.max(orig.vb.y, yMin - ySpan * 0.18);
    const sy1 = Math.min(orig.vb.y + orig.vb.h, yMax + ySpan * 0.14);
    const svh = Math.max(orig.vb.h * 0.08, sy1 - sy0);

    const nextTarget = { x: sx0, y: sy0, w: sw, h: svh };
    const graph = (svg.closest && svg.closest('.elev-graph')) || svg.parentNode;
    if (!graph || !graph.querySelector) return;

    const fallbackFrac = clamp((curDist || 0) / route.totalLen, 0, 1);
    const isSameSvg = activeZoomedSvg === svg && activeZoomedGraph === graph && zoomCurrentVb;

    activeZoomedSvg = svg;
    activeZoomedGraph = graph;
    ensureVbObserver(svg);

    if (!activeZoomState) {
      activeZoomState = {
        vb: orig.vb,
        curVb: isSameSvg ? { x: zoomCurrentVb.x, w: zoomCurrentVb.w } : { x: orig.vb.x, w: orig.vb.w },
        fallbackFrac,
      };
    } else {
      activeZoomState.vb = orig.vb;
      activeZoomState.fallbackFrac = fallbackFrac;
    }

    if (typeof requestAnimationFrame !== 'function') {
      zoomCurrentVb = nextTarget;
      zoomTargetVb = nextTarget;
      zoomFromVb = null;
      zoomAnimStart = null;
      zoomRestoring = false;
      applyZoomViewBox(svg, graph, orig, nextTarget);
      updateZoomedCursor();
      return;
    }

    if (!isSameSvg) {
      const startVb = curVb ? { ...curVb } : { ...orig.vb };
      zoomCurrentVb = startVb;
      zoomFromVb = { ...startVb };
      zoomTargetVb = nextTarget;
      zoomAnimStart = nowMs();
      zoomRestoring = false;
      applyZoomViewBox(svg, graph, orig, zoomCurrentVb);
      updateZoomedCursor();
      startCursorRaf();
      return;
    }

    if (zoomRestoring || !vbApproxEq(zoomTargetVb, nextTarget)) {
      zoomRestoring = false;
      zoomFromVb = { ...zoomCurrentVb };
      zoomTargetVb = nextTarget;
      zoomAnimStart = nowMs();
      startCursorRaf();
    }
  }

  /* ---------- Route & Karoo Climb Detection ---------- */
  function resolveRoute() {
    try {
      const rc = window.btApp && (window.btApp.riderController || window.btApp.rideController);
      if (!rc) return null;
      const focal = rc.focalRider || rc.ego;
      const prev = focal && focal.sim && focal.sim.prevPathNode;
      if (!prev) return null;

      let list = null;
      if (prev.pathNode && Array.isArray(prev.pathNode.list) && prev.pathNode.list.length > 2) {
        list = prev.pathNode.list;
      } else if (Array.isArray(prev.list) && prev.list.length > 2) {
        list = prev.list;
      }
      if (!list || list.length < 3) return null;

      if (cachedRoute && cachedRoute.listRef === list) {
        return { route: cachedRoute, focal, prev };
      }

      restoreElevationSvg(true);

      const n = list.length;
      const pts = new Array(n);
      for (let i = 0; i < n; i++) {
        const node = list[i];
        const inner = (node && node.pathNode) ? node.pathNode : node;
        const p = inner && (inner.p || inner.pos || inner.position);
        if (!p || typeof p.x !== 'number') return null;
        pts[i] = { x: p.x, y: Number.isFinite(p.y) ? p.y : 0, z: Number.isFinite(p.z) ? p.z : 0 };
      }

      const dist = new Float64Array(n);
      for (let i = 1; i < n; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        const dz = pts[i].z - pts[i - 1].z;
        dist[i] = dist[i - 1] + Math.hypot(dx, dy, dz);
      }
      const totalLen = dist[n - 1];
      if (!(totalLen > 1)) return null;

      const loopGap = Math.hypot(pts[n - 1].x - pts[0].x, pts[n - 1].z - pts[0].z);
      const isLoop = n > 20 && loopGap < 80;

      const grades = new Float32Array(n);
      let back = 0, fwd = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[i];
        while (back < i && d - dist[back] > 18) back++;
        while (fwd + 1 < n && dist[fwd] - d < 18) fwd++;
        const span = Math.max(1, dist[fwd] - dist[back]);
        grades[i] = clamp(((pts[fwd].y - pts[back].y) / span) * 100, -35, 35);
      }

      cachedRoute = { listRef: list, pts, dist, grades, totalLen, isLoop, n };
      cachedClimbsKey = '';
      inspectedClimbIndex = null;
      zoomManualFull = false;
      canToggleZoom = false;
      lastIdx = 0;
      return { route: cachedRoute, focal, prev };
    } catch {
      return null;
    }
  }

  function sampleRawAtDist(route, targetDist) {
    const { pts, dist, grades, totalLen, n } = route;
    const d = clamp(targetDist, 0, totalLen);
    let lo = 0, hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segLen = dist[hi] - dist[lo];
    const t = segLen > 1e-6 ? clamp((d - dist[lo]) / segLen, 0, 1) : 0;
    return {
      y: pts[lo].y + (pts[hi].y - pts[lo].y) * t,
      grade: grades[lo] + (grades[hi] - grades[lo]) * t,
    };
  }

  const isImp = () => S.units === 'imperial';

  function detectClimbs(route, sensKey) {
    const cfg = SENSITIVITY_CFG[sensKey] || SENSITIVITY_CFG.all;
    const totalLen = route.totalLen;
    const absMinLen = Math.min(cfg.minLen, cfg.punchyMinLen || cfg.minLen);
    if (totalLen < absMinLen) return [];

    const STEP = 20;
    const m = Math.max(4, Math.floor(totalLen / STEP) + 1);
    const gridD = new Float64Array(m);
    const gridRawY = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      const d = Math.min(totalLen, i * STEP);
      gridD[i] = d;
      gridRawY[i] = sampleRawAtDist(route, d).y;
    }

    // 1-pass smoothed elevation for clean ascent math; 2-pass smoothed elevation for slope/peak detection
    const smoothPass = (src) => {
      const out = new Float64Array(m);
      out[0] = src[0];
      out[m - 1] = src[m - 1];
      for (let i = 1; i < m - 1; i++) {
        out[i] = 0.25 * src[i - 1] + 0.5 * src[i] + 0.25 * src[i + 1];
      }
      return out;
    };
    const gridElev = smoothPass(gridRawY);
    const gridY = smoothPass(gridElev);

    // Local smoothed grade over +/-40m window (80m span)
    const gridSlope = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const lo = Math.max(0, i - 2);
      const hi = Math.min(m - 1, i + 2);
      const span = Math.max(1, gridD[hi] - gridD[lo]);
      gridSlope[i] = ((gridY[hi] - gridY[lo]) / span) * 100;
    }

    const sampleElev = (d) => {
      const clamped = clamp(d, 0, totalLen);
      const fi = clamped / STEP;
      const i0 = clamp(Math.floor(fi), 0, m - 1);
      const i1 = Math.min(m - 1, i0 + 1);
      const span = gridD[i1] - gridD[i0];
      const t = span > 1e-6 ? clamp((clamped - gridD[i0]) / span, 0, 1) : 0;
      return gridElev[i0] + (gridElev[i1] - gridElev[i0]) * t;
    };

    // Stage 1: Grade-aware seed extraction (prevents long <2% false flats from swallowing real climbs)
    const START_GRADE = 2.2;
    const CONT_GRADE = 2.0;
    const MAX_SEED_DIP_M = 8;
    const MAX_SEED_FLAT_M = 200;

    const seeds = [];
    let inSeed = false;
    let seedStart = 0;
    let peakIdx = 0;
    let peakY = gridY[0];
    let lastActiveIdx = 0;
    let runStart = -1;

    const pushSeed = (sIdx, pIdx) => {
      if (pIdx <= sIdx) return;
      const len = gridD[pIdx] - gridD[sIdx];
      const gain = gridElev[pIdx] - gridElev[sIdx];
      if (len >= 80 && gain >= 3) {
        seeds.push({ s: sIdx, e: pIdx });
      }
    };

    for (let i = 0; i < m; i++) {
      const y = gridY[i];
      const sl = gridSlope[i];
      if (!inSeed) {
        if (sl >= START_GRADE) {
          if (runStart < 0) runStart = Math.max(0, i - 1);
          if (gridD[i] - gridD[runStart] >= 40 || y - gridY[runStart] >= 3) {
            inSeed = true;
            seedStart = runStart;
            peakIdx = i;
            peakY = y;
            lastActiveIdx = i;
          }
        } else {
          runStart = -1;
        }
      } else {
        if (sl >= CONT_GRADE) {
          lastActiveIdx = i;
        }
        if (y > peakY && (gridD[i] - gridD[lastActiveIdx]) <= 120) {
          peakY = y;
          peakIdx = i;
        }
        const drop = peakY - y;
        const flatSpan = gridD[i] - gridD[lastActiveIdx];
        if (drop >= MAX_SEED_DIP_M || flatSpan >= MAX_SEED_FLAT_M) {
          pushSeed(seedStart, peakIdx);
          inSeed = false;
          runStart = sl >= START_GRADE ? Math.max(peakIdx, i - 1) : -1;
        }
      }
    }
    if (inSeed) pushSeed(seedStart, peakIdx);

    // Stage 2: Merge adjacent seeds across brief flats/dips (benched / stepped climbs)
    let merged = true;
    while (merged && seeds.length > 1) {
      merged = false;
      for (let i = 0; i < seeds.length - 1; i++) {
        const a = seeds[i];
        const b = seeds[i + 1];
        if (b.e <= a.e) {
          seeds.splice(i + 1, 1);
          merged = true;
          break;
        }
        const gapLen = gridD[b.s] - gridD[a.e];
        const lenA = gridD[a.e] - gridD[a.s];
        const lenB = gridD[b.e] - gridD[b.s];
        const gainA = gridElev[a.e] - gridElev[a.s];
        const gainB = gridElev[b.e] - gridElev[b.s];
        const combLen = gridD[b.e] - gridD[a.s];
        const combGain = gridElev[b.e] - gridElev[a.s];
        const combAvg = combLen > 0 ? (combGain / combLen) * 100 : 0;

        let minGapY = gridY[a.e];
        for (let k = Math.max(0, a.e); k <= Math.min(m - 1, b.s); k++) {
          if (gridY[k] < minGapY) minGapY = gridY[k];
        }
        const gapDrop = Math.max(0, gridY[a.e] - minGapY);
        const maxGap = Math.min(600, Math.max(250, 0.35 * (lenA + lenB)));
        const maxDrop = Math.min(25, Math.max(12, 0.25 * (gainA + gainB)));

        if (
          gapLen <= maxGap &&
          gapDrop <= maxDrop &&
          combGain > Math.max(gainA, gainB) &&
          combAvg >= Math.max(2.6, cfg.minAvgGrade - 0.3)
        ) {
          a.e = b.e;
          seeds.splice(i + 1, 1);
          merged = true;
          break;
        }
      }
    }

    // Stage 3: Precision edge-trim, score-aware filter (incl. punchy kickers), and 50m segments
    const rawClimbs = [];
    const segM = isImp() ? 45.72 : 50;

    for (const seed of seeds) {
      let sIdx = seed.s;
      let pIdx = seed.e;

      while (sIdx + 2 <= pIdx) {
        const segD = Math.max(1, gridD[sIdx + 2] - gridD[sIdx]);
        const segG = ((gridY[sIdx + 2] - gridY[sIdx]) / segD) * 100;
        if (segG < 2.0) sIdx++;
        else break;
      }
      while (pIdx - 2 >= sIdx) {
        const segD = Math.max(1, gridD[pIdx] - gridD[pIdx - 2]);
        const segG = ((gridY[pIdx] - gridY[pIdx - 2]) / segD) * 100;
        if (segG < 1.0) pIdx--;
        else break;
      }
      if (pIdx <= sIdx) continue;

      const startDist = gridD[sIdx];
      const endDist = gridD[pIdx];
      const lengthM = endDist - startDist;
      const startElev = gridElev[sIdx];
      const endElev = gridElev[pIdx];
      const netGain = endElev - startElev;
      const avgGrade = lengthM > 0 ? (netGain / lengthM) * 100 : 0;
      const score = lengthM * avgGrade;

      const passesStd = lengthM >= cfg.minLen && avgGrade >= cfg.minAvgGrade && score >= cfg.minScore;
      const passesPunchy =
        lengthM >= (cfg.punchyMinLen || cfg.minLen) &&
        avgGrade >= (cfg.punchyMinGrade || cfg.minAvgGrade) &&
        score >= (cfg.punchyMinScore || cfg.minScore);
      if (!(passesStd || passesPunchy) || netGain <= 0) continue;

      // Climb-anchored 50m (or 50yd) segments so sharp ramps never get smeared across 100m boundaries
      const segments = [];
      let segStart = startDist;
      let segIdx = 0;
      while (segStart < endDist - 1) {
        let segEnd = Math.min(endDist, segStart + segM);
        if (endDist - segEnd > 0 && endDist - segEnd < 10) segEnd = endDist;
        const len = segEnd - segStart;
        const y0 = sampleElev(segStart);
        const y1 = sampleElev(segEnd);
        const segGrade = ((y1 - y0) / Math.max(5, len)) * 100;
        segments.push({
          idx: segIdx,
          offsetM: segStart - startDist,
          lenM: len,
          grade: segGrade,
          color: karooGradeColor(segGrade),
        });
        segStart = segEnd;
        segIdx++;
      }

      // Post-summit road preview (up to 500m / 500yd past the crest)
      const postSegments = [];
      const postLimit = Math.min(totalLen, endDist + 10 * segM);
      let pStart = endDist;
      let pSegIdx = 0;
      while (pStart < postLimit - 1) {
        let pEnd = Math.min(postLimit, pStart + segM);
        if (postLimit - pEnd > 0 && postLimit - pEnd < 10) pEnd = postLimit;
        const len = pEnd - pStart;
        const y0 = sampleElev(pStart);
        const y1 = sampleElev(pEnd);
        const segGrade = ((y1 - y0) / Math.max(5, len)) * 100;
        postSegments.push({
          idx: pSegIdx,
          offsetM: pStart - startDist,
          lenM: len,
          grade: segGrade,
          color: karooGradeColor(segGrade),
        });
        pStart = pEnd;
        pSegIdx++;
      }

      // Cumulative positive ascent table (smoothed elevation) for steady "Elev Left"
      const steps = 64;
      const cumAscent = new Float64Array(steps + 1);
      let prevY = sampleElev(startDist);
      for (let k = 1; k <= steps; k++) {
        const d = startDist + (k / steps) * lengthM;
        const y = sampleElev(d);
        const dy = y - prevY;
        cumAscent[k] = cumAscent[k - 1] + (dy > 0 ? dy : 0);
        prevY = y;
      }

      rawClimbs.push({
        startDist,
        endDist,
        lengthM,
        segM,
        startElev,
        endElev,
        ascentM: Math.max(netGain, cumAscent[steps]),
        avgGrade,
        segments,
        postSegments,
        cumAscent,
      });
    }

    const totalClimbs = rawClimbs.length;
    for (let i = 0; i < totalClimbs; i++) {
      rawClimbs[i].index = i + 1;
      rawClimbs[i].totalClimbs = totalClimbs;
    }
    return rawClimbs;
  }

  function findFocalDistance(route, focal, prev) {
    const { pts, dist, n } = route;
    const pos = focal && focal.sim && (focal.sim.midPosition || focal.sim.position);
    let hint = Number.isInteger(prev.index) && prev.index >= 0 && prev.index < n ? prev.index : lastIdx;
    if (!pos || typeof pos.x !== 'number') {
      lastIdx = hint;
      return { curDist: dist[hint], idx: hint };
    }

    let bestIdx = hint;
    let bestD2 = Infinity;
    const lo = Math.max(0, hint - 30);
    const hi = Math.min(n - 1, hint + 30);
    for (let i = lo; i <= hi; i++) {
      const dx = pts[i].x - pos.x;
      const dz = pts[i].z - pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
    }
    if (bestD2 > 900) {
      for (let i = 0; i < n; i++) {
        const dx = pts[i].x - pos.x;
        const dz = pts[i].z - pos.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
    }
    lastIdx = bestIdx;

    let curDist = dist[bestIdx];
    const trySeg = (a, b) => {
      const vx = pts[b].x - pts[a].x;
      const vz = pts[b].z - pts[a].z;
      const len2 = vx * vx + vz * vz;
      if (len2 < 1e-4) return null;
      const t = ((pos.x - pts[a].x) * vx + (pos.z - pts[a].z) * vz) / len2;
      if (t < 0 || t > 1) return null;
      const px = pts[a].x + vx * t;
      const pz = pts[a].z + vz * t;
      return { d: dist[a] + (dist[b] - dist[a]) * t, d2: (pos.x - px) ** 2 + (pos.z - pz) ** 2 };
    };
    const candA = bestIdx > 0 ? trySeg(bestIdx - 1, bestIdx) : null;
    const candB = bestIdx + 1 < n ? trySeg(bestIdx, bestIdx + 1) : null;
    if (candA && (!candB || candA.d2 <= candB.d2)) curDist = candA.d;
    else if (candB) curDist = candB.d;

    return { curDist, idx: bestIdx };
  }

  function ascentLeftOnClimb(climb, frac) {
    const f = clamp(frac, 0, 1) * (climb.cumAscent.length - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(climb.cumAscent.length - 1, i0 + 1);
    const t = f - i0;
    const done = climb.cumAscent[i0] + (climb.cumAscent[i1] - climb.cumAscent[i0]) * t;
    return Math.max(0, climb.ascentM - done);
  }

  function fmtDist(m) {
    if (isImp()) {
      const mi = m / 1609.344;
      if (mi >= 0.25) return `${mi.toFixed(2)} mi`;
      return `${Math.round(m / 0.9144)} yd`;
    }
    if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
    return `${Math.round(m)} m`;
  }
  function fmtDistShort(m) {
    if (isImp()) {
      const mi = m / 1609.344;
      return mi >= 0.25 ? `${mi.toFixed(1)}mi` : `${Math.round(m / 0.9144)}yd`;
    }
    return m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`;
  }
  function fmtElev(m) {
    if (isImp()) return `${Math.round(m / 0.3048)} ft`;
    return `${Math.round(m)} m`;
  }

  // Smooth DPI-aware 500m upcoming gradient strip (50m resolution, merged color bands, summit + post-crest preview)
  function renderTickerCanvas(canvas, scTitle, scEnd, climb, distIntoClimb) {
    const unitTag = isImp() ? 'yd' : 'm';
    scTitle.textContent = `Next 500${unitTag}`;
    scEnd.textContent = `50${unitTag} bands`;

    const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio > 0) ? window.devicePixelRatio : 1, 2);
    const w = (canvas.clientWidth && canvas.clientWidth > 20) ? canvas.clientWidth : 318;
    const h = (canvas.clientHeight && canvas.clientHeight > 10) ? canvas.clientHeight : 24;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!climb || !climb.segments || !climb.segments.length) return;

    const winSpan = isImp() ? 457.2 : 500;
    const winStart = distIntoClimb !== null && distIntoClimb > 0 ? clamp(distIntoClimb, 0, climb.lengthM) : 0;
    const winEnd = winStart + winSpan;
    const pctPx = Math.max(10, Math.round(h * 0.50));

    const formatBandLen = (m) => {
      if (isImp()) {
        const yd = m / 0.9144;
        if (yd >= 440) {
          const mi = m / 1609.344;
          return `${mi >= 1 ? mi.toFixed(1) : mi.toFixed(2)}mi`;
        }
        return `${Math.max(10, Math.round(yd / 10) * 10)}yd`;
      }
      if (m >= 1000) return `${(m / 1000).toFixed(1)}km`;
      return `${Math.max(10, Math.round(m / 10) * 10)}m`;
    };

    const buildMergedRuns = (segList) => {
      // Merge contiguous same-color segments across the full list so each box knows its true length
      const fullRuns = [];
      for (const seg of segList) {
        const s0 = seg.offsetM;
        const s1 = seg.offsetM + seg.lenM;
        const prev = fullRuns.length ? fullRuns[fullRuns.length - 1] : null;
        if (prev && prev.color === seg.color && Math.abs(s0 - prev.s1) < 1) {
          prev.segs.push(seg);
          prev.s1 = s1;
        } else {
          fullRuns.push({ s0, s1, color: seg.color, segs: [seg] });
        }
      }

      const visible = [];
      for (const run of fullRuns) {
        const v0 = Math.max(winStart, run.s0);
        const v1 = Math.min(winEnd, run.s1);
        if (v1 <= v0) continue;
        const remStart = Math.max(winStart, run.s0);
        let gradeWeighted = 0;
        let remLen = 0;
        for (const seg of run.segs) {
          const r0 = Math.max(remStart, seg.offsetM);
          const r1 = seg.offsetM + seg.lenM;
          if (r1 > r0) {
            const dl = r1 - r0;
            gradeWeighted += seg.grade * dl;
            remLen += dl;
          }
        }
        visible.push({
          v0,
          v1,
          color: run.color,
          remLen: Math.max(v1 - v0, remLen),
          avgGrade: remLen > 0 ? gradeWeighted / remLen : 0,
        });
      }
      return visible;
    };

    const drawRuns = (runs, alpha) => {
      ctx.save();
      if (alpha < 1) ctx.globalAlpha = alpha;
      const lenPx = Math.max(9, Math.round(pctPx * 0.86));
      const pctFont = `700 ${pctPx}px "Overpass Mono", "Overpass", sans-serif`;
      const lenFont = `600 ${lenPx}px "Overpass Mono", "Overpass", sans-serif`;
      const measureW = (txt, px) => (
        typeof ctx.measureText === 'function'
          ? ctx.measureText(txt).width
          : txt.length * (px * 0.62)
      );

      for (let i = 0; i < runs.length; i++) {
        const run = runs[i];
        const x0 = ((run.v0 - winStart) / winSpan) * w;
        const x1 = ((run.v1 - winStart) / winSpan) * w;
        const bw = x1 - x0;

        ctx.fillStyle = run.color;
        ctx.fillRect(x0, 0, bw + 0.5, h);

        if (i < runs.length - 1 && x1 < w - 0.5) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
          ctx.fillRect(x1 - 1, 0, 1.5, h);
        }

        if (bw >= 24) {
          const cx = x0 + bw / 2;
          const pctTxt = `${Math.round(run.avgGrade)}%`;
          const lenTxt = formatBandLen(run.remLen);

          ctx.font = pctFont;
          const pctW = measureW(pctTxt, pctPx);
          ctx.font = lenFont;
          const lenW = measureW(lenTxt, lenPx);

          const darkBg = isDarkGradeBand(run.color);
          const textY = h * 0.54;
          const minGap = 3;
          const maxGap = Math.max(6, Math.round(pctPx * 0.8));
          const sidePad = 6;
          const availGap = bw - sidePad - pctW - lenW;

          ctx.textBaseline = 'middle';
          if (availGap >= minGap) {
            // Smoothly shrink gap between grade% and countdown before dropping countdown
            const gap = clamp(availGap * 0.35, minGap, maxGap);
            const totalW = pctW + gap + lenW;
            const startX = cx - totalW / 2;
            ctx.textAlign = 'left';

            ctx.font = pctFont;
            if (darkBg) {
              ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
              ctx.fillText(pctTxt, startX, textY + 1);
              ctx.fillStyle = '#ffffff';
            } else {
              ctx.fillStyle = '#09090b';
            }
            ctx.fillText(pctTxt, startX, textY);

            ctx.font = lenFont;
            const lenX = startX + pctW + gap;
            if (darkBg) {
              ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
              ctx.fillText(lenTxt, lenX, textY + 1.5);
              ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
            } else {
              ctx.fillStyle = 'rgba(9, 9, 11, 0.78)';
            }
            ctx.fillText(lenTxt, lenX, textY + 0.5);
          } else if (bw >= pctW + 4) {
            ctx.font = pctFont;
            ctx.textAlign = 'center';
            if (darkBg) {
              ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
              ctx.fillText(pctTxt, cx, textY + 1);
              ctx.fillStyle = '#ffffff';
            } else {
              ctx.fillStyle = '#09090b';
            }
            ctx.fillText(pctTxt, cx, textY);
          }
        }
      }
      ctx.restore();
    };

    drawRuns(buildMergedRuns(climb.segments), 1);

    if (climb.postSegments && climb.postSegments.length && winEnd > climb.lengthM) {
      drawRuns(buildMergedRuns(climb.postSegments), 0.46);
    }

    // Crisp checkered summit marker when crest enters the 500m window
    if (climb.lengthM > winStart && climb.lengthM < winEnd) {
      const sx = ((climb.lengthM - winStart) / winSpan) * w;
      const cell = Math.max(3, Math.round(h / 6));
      for (let row = 0; row * cell < h; row++) {
        const cy = row * cell;
        const ch = Math.min(cell, h - cy);
        ctx.fillStyle = (row % 2 === 0) ? '#ffffff' : '#09090b';
        ctx.fillRect(sx - 2, cy, 2, ch);
        ctx.fillStyle = (row % 2 === 0) ? '#09090b' : '#ffffff';
        ctx.fillRect(sx, cy, 2, ch);
      }
    }

    // Crisp left-edge NOW marker
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 2, h);
  }

  function syncRoadGauges() {
    const shouldHide =
      !cleaned &&
      Boolean(S.replace_road_dials) &&
      ui.root.classList.contains('tr-cl-docked') &&
      ui.root.style.display !== 'none';

    const row = shouldHide && typeof document.querySelector === 'function'
      ? document.querySelector('.zone-road .road-row, .road-row')
      : null;

    if (hiddenGaugesRow && hiddenGaugesRow !== row) {
      try { hiddenGaugesRow.classList.remove('tr-cl-hide-gauges'); } catch {}
      hiddenGaugesRow = null;
    }
    if (shouldHide && row) {
      row.classList.add('tr-cl-hide-gauges');
      hiddenGaugesRow = row;
    } else if (hiddenGaugesRow) {
      try { hiddenGaugesRow.classList.remove('tr-cl-hide-gauges'); } catch {}
      hiddenGaugesRow = null;
    }
  }

  function readLiveDraft(focal) {
    if (typeof document.querySelector === 'function') {
      const draftGauge = document.querySelector('.road-row .gauge.draft, .gauge.draft');
      if (draftGauge) {
        const valEl = draftGauge.querySelector ? draftGauge.querySelector('.gauge-value') : null;
        const fillEl = draftGauge.querySelector ? draftGauge.querySelector('.gauge-fill') : null;
        const rawTxt = valEl ? String(valEl.textContent || '').trim() : '';
        const parsedVal = parseFloat(rawTxt);
        const hStr = fillEl && fillEl.style ? String(fillEl.style.height || '') : '';
        const hm = hStr.match(/(-?\d+(?:\.\d+)?)%/);
        const pct = hm
          ? clamp(parseFloat(hm[1]), 0, 100)
          : (Number.isFinite(parsedVal) ? clamp(parsedVal, 0, 100) : 0);
        const color = fillEl && fillEl.style && fillEl.style.backgroundColor ? fillEl.style.backgroundColor : '';
        return {
          text: rawTxt || String(Math.round(pct)),
          pct,
          color,
        };
      }
    }
    if (focal && focal.sim && Number.isFinite(focal.sim.draftFactor)) {
      const pct = clamp(Math.round((1 - focal.sim.draftFactor) * 100), 0, 100);
      return { text: String(pct), pct, color: '' };
    }
    return null;
  }

  function setDraftPill(els, draft) {
    if (!els.draft) return;
    if (!draft) {
      els.draft.style.display = 'none';
      return;
    }
    els.draft.style.display = '';
    els.draftVal.textContent = draft.text;
    els.draftFill.style.width = `${clamp(draft.pct, 0, 100).toFixed(1)}%`;
    els.draftFill.style.backgroundColor = draft.color || '';
  }

  function readLiveGrade(fallbackGrade) {
    if (typeof document.querySelector === 'function') {
      const valEl = document.querySelector('.road-row .gauge.grade .gauge-value, .gauge.grade .gauge-value');
      if (valEl) {
        const parsed = parseFloat(String(valEl.textContent || '').trim());
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return fallbackGrade;
  }

  function setGradePill(els, g) {
    if (g === null || g === undefined || !Number.isFinite(g)) {
      els.gradeVal.textContent = '\u2014%';
      els.gradeFill.style.backgroundColor = 'transparent';
      els.gradeFill.style.transform = 'rotate(0deg)';
      return;
    }
    els.gradeVal.textContent = `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`;
    const col = karooGradeColor(g);
    // True geometric slope angle atan(grade) scaled 2x so subtle gradients read clearly in the pill
    const tiltDeg = -clamp((Math.atan(g / 100) * 180 / Math.PI) * 2.0, -28, 28);
    els.gradeFill.style.backgroundColor = col;
    els.gradeFill.style.transform = `rotate(${tiltDeg.toFixed(2)}deg)`;
  }

  function renderDrawerList(els, items, activeClimb) {
    if (!drawerListOpen || !items.length) {
      els.drawer.style.display = 'none';
      els.drawer.replaceChildren();
      return;
    }
    els.drawer.style.display = 'flex';
    const rows = items.map((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isAct = activeClimb && it.climb === activeClimb;
      const isSel = inspectedClimbIndex === it.climb.index;
      btn.className = 'tr-cl-item' + (isAct ? ' active' : '') + (it.done ? ' done' : '') + (isSel ? ' selected' : '');
      const status = isAct ? 'NOW' : it.done ? 'Done' : `In ${fmtDistShort(it.distToStart)}`;
      btn.innerHTML =
        `<span class="tr-cl-item-l">#${it.climb.index} \u00b7 ${fmtDistShort(it.climb.lengthM)} @ ${it.climb.avgGrade.toFixed(1)}%</span>` +
        `<span class="tr-cl-item-r">+${fmtElev(it.climb.ascentM)} \u00b7 ${status}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        inspectedClimbIndex = (inspectedClimbIndex === it.climb.index) ? null : it.climb.index;
        zoomManualFull = false;
        tick();
      });
      return btn;
    });
    els.drawer.replaceChildren(...rows);
  }

  function renderView(els, view, isPreview = false) {
    if (!view) {
      if (!isPreview) {
        els.root.style.display = '';
        canToggleZoom = false;
        zoomManualFull = false;
        restoreElevationSvg(true);
      }
      els.root.classList.remove('compact');
      els.badge.className = 'tr-cl-badge flat';
      els.badge.textContent = 'CLIMBER';
      els.title.textContent = 'Waiting for route\u2026';
      setDraftPill(els, null);
      setGradePill(els, null);
      els.zoomBtn.style.display = 'none';
      els.listBtn.style.display = 'none';
      els.kpis.style.display = 'none';
      els.body.style.display = 'none';
      els.compactRow.style.display = 'none';
      els.drawer.style.display = 'none';
      if (!isPreview) syncRoadGauges();
      return;
    }

    const totalClimbs = view.allItems ? view.allItems.length : 0;
    els.listBtn.style.display = totalClimbs ? '' : 'none';
    els.listBtn.textContent = `Climbs (${totalClimbs})`;
    els.listBtn.classList.toggle('open', drawerListOpen);
    setDraftPill(els, view.draft);
    setGradePill(els, view.curGrade);

    const approachThreshold = clamp(parseInt(S.approach_m, 10) || 250, 50, 5000);
    const padM = clamp(parseInt(S.zoom_pad_m, 10) || 250, 0, 5000);
    const isNearOrActive = view.mode === 'active' || (view.mode === 'approach' && view.distToStart <= approachThreshold);

    const inspected = inspectedClimbIndex
      ? (view.allItems || []).find((it) => it.climb.index === inspectedClimbIndex)
      : null;

    // Zoom Biketerra's on-screen elevation SVG when inspecting, approaching within threshold, or actively climbing
    const zoomClimb = (inspected && inspected.climb) || (isNearOrActive ? view.climb : null);
    let toggleAvailable = false;
    if (S.zoom_elevation_svg && zoomClimb && view.route && view.route.totalLen > 0) {
      const w0 = Math.max(0, zoomClimb.startDist - padM);
      const w1 = Math.min(view.route.totalLen, zoomClimb.endDist + padM);
      const spanFrac = (w1 - w0) / view.route.totalLen;
      toggleAvailable = spanFrac > 0.005 && spanFrac < 0.96;
      if (!isPreview) {
        canToggleZoom = toggleAvailable;
        if (toggleAvailable && !zoomManualFull) {
          stopFullRouteGuard();
          zoomElevationSvg(view.route, w0, w1, view.curDist);
        } else {
          restoreElevationSvg(false);
          if (toggleAvailable && zoomManualFull) {
            ensureFullRouteGuard(view.route, view.curDist);
          } else {
            stopFullRouteGuard();
          }
        }
      }
    } else if (!isPreview) {
      canToggleZoom = false;
      zoomManualFull = false;
      stopFullRouteGuard();
      restoreElevationSvg(false);
    }

    if (!isPreview) {
      const svgForGraph = findElevationSvg();
      const graphEl = svgForGraph && ((svgForGraph.closest && svgForGraph.closest('.elev-graph')) || svgForGraph.parentNode);
      if (graphEl) {
        ensureGraphClickBinding(graphEl);
        if (graphEl.classList) graphEl.classList.toggle('tr-elev-graph-interactive', toggleAvailable);
      }
    }

    if (!isPreview && toggleAvailable) {
      els.zoomBtn.style.display = '';
      const modeKey = zoomManualFull ? 'full' : 'zoom';
      if (els.zoomBtn.dataset.mode !== modeKey) {
        els.zoomBtn.dataset.mode = modeKey;
        els.zoomBtn.classList.toggle('full', zoomManualFull);
        els.zoomBtn.innerHTML = zoomManualFull ? ZOOM_IN_SVG : ZOOM_OUT_SVG;
        const tip = zoomManualFull ? 'Zoom back in on climb' : 'Zoom out to full route';
        els.zoomBtn.title = tip;
        els.zoomBtn.setAttribute('aria-label', tip);
      }
    } else {
      els.zoomBtn.style.display = 'none';
    }

    if (!isPreview && !isNearOrActive && !drawerListOpen && !inspectedClimbIndex) {
      if (S.flat_mode === 'hidden') {
        els.root.style.display = 'none';
        syncRoadGauges();
        return;
      }
      if (S.flat_mode === 'compact') {
        els.root.style.display = '';
        els.root.classList.add('compact');
        els.kpis.style.display = 'none';
        els.body.style.display = 'none';
        els.drawer.style.display = 'none';
        els.compactRow.style.display = 'flex';
        els.badge.className = 'tr-cl-badge flat';
        els.badge.textContent = 'CLIMBER';
        if (view.mode === 'approach') {
          const c = view.climb;
          els.title.textContent = `Next #${c.index}/${c.totalClimbs}`;
          els.compactRow.innerHTML = `<span>In <strong>${fmtDist(view.distToStart)}</strong></span><span>${fmtDistShort(c.lengthM)} \u00b7 +${fmtElev(c.ascentM)} \u00b7 ${c.avgGrade.toFixed(1)}%</span>`;
        } else {
          els.title.textContent = totalClimbs ? 'Climbs Done' : 'Flat Route';
          els.compactRow.textContent = totalClimbs ? `All ${totalClimbs} climb(s) completed` : 'No climbs >= 400m @ 3%';
        }
        syncRoadGauges();
        return;
      }
    }

    els.root.style.display = '';
    els.root.classList.remove('compact');
    els.compactRow.style.display = 'none';
    if (!isPreview) syncRoadGauges();

    const showClimb = inspected ? inspected.climb : view.climb;
    if (!showClimb) {
      els.badge.className = 'tr-cl-badge flat';
      els.badge.textContent = 'CLIMBER';
      els.title.textContent = totalClimbs ? 'All Climbs Completed' : 'No Climbs Detected';
      els.kpis.style.display = 'none';
      els.body.style.display = 'none';
      renderDrawerList(els, view.allItems || [], null);
      return;
    }

    const tickerMode = S.ticker_mode || 'always';
    const showTicker = isPreview || (tickerMode === 'always') || (tickerMode === 'long' && showClimb.lengthM >= 1000);

    els.kpis.style.display = '';
    els.body.style.display = showTicker ? '' : 'none';
    if (inspected && inspected.climb !== view.activeClimb) {
      els.badge.className = 'tr-cl-badge approach';
      els.badge.textContent = `#${showClimb.index}/${showClimb.totalClimbs}`;
      els.title.textContent = inspected.done ? 'Completed' : `In ${fmtDist(inspected.distToStart)}`;
      els.k1l.textContent = inspected.done ? 'len' : 'to start';
      els.k1v.textContent = inspected.done ? fmtDist(showClimb.lengthM) : fmtDist(inspected.distToStart);
      els.k2l.textContent = 'ascent';
      els.k2v.textContent = `+${fmtElev(showClimb.ascentM)}`;
      els.k3l.textContent = 'avg';
      els.k3v.textContent = `${showClimb.avgGrade.toFixed(1)}%`;
      if (showTicker) renderTickerCanvas(els.tickerCanvas, els.scTitle, els.scEnd, showClimb, 0);
    } else if (view.mode === 'active') {
      const remAvg = view.distLeft > 20
        ? clamp((view.ascentLeft / view.distLeft) * 100, -25, 35)
        : showClimb.avgGrade;
      els.badge.className = 'tr-cl-badge';
      els.badge.textContent = `CLIMB ${showClimb.index}/${showClimb.totalClimbs}`;
      els.title.textContent = `${Math.round(view.progressFrac * 100)}%`;
      els.k1l.textContent = 'left';
      els.k1v.textContent = fmtDist(view.distLeft);
      els.k2l.textContent = 'elev';
      els.k2v.textContent = `+${fmtElev(view.ascentLeft)}`;
      els.k3l.textContent = 'avg';
      els.k3v.textContent = `${remAvg.toFixed(1)}%`;
      if (showTicker) renderTickerCanvas(els.tickerCanvas, els.scTitle, els.scEnd, showClimb, view.distIntoClimb);
    } else {
      els.badge.className = 'tr-cl-badge approach';
      els.badge.textContent = `NEXT ${showClimb.index}/${showClimb.totalClimbs}`;
      els.title.textContent = `In ${fmtDist(view.distToStart)}`;
      els.k1l.textContent = 'to start';
      els.k1v.textContent = fmtDist(view.distToStart);
      els.k2l.textContent = 'len';
      els.k2v.textContent = fmtDist(showClimb.lengthM);
      els.k3l.textContent = 'avg';
      els.k3v.textContent = `${showClimb.avgGrade.toFixed(1)}%`;
      if (showTicker) renderTickerCanvas(els.tickerCanvas, els.scTitle, els.scEnd, showClimb, 0);
    }

    renderDrawerList(els, view.allItems || [], view.activeClimb);
  }

  function makeSampleView() {
    const lengthM = 950;
    const segGrades = [5.5, 5.8, 6.2, 9.2, 9.6, 11.8, 12.2, 11.4, 4.1, 4.4, 8.8, 9.4, 12.6, 12.0, 6.2, 5.8, 4.5, 3.8, 3.2];
    const segments = segGrades.map((grade, idx) => ({
      idx, offsetM: idx * 50, lenM: 50, grade, color: karooGradeColor(grade),
    }));
    const postSegments = [-2.5, -4.0, -4.5, -3.8].map((grade, idx) => ({
      idx, offsetM: lengthM + idx * 50, lenM: 50, grade, color: karooGradeColor(grade),
    }));
    const cumAscent = new Float64Array([0, 38, 76]);
    const climb = {
      index: 2, totalClimbs: 4, startDist: 3200, endDist: 3200 + lengthM,
      lengthM, segM: 50, ascentM: 76, avgGrade: 8.0, segments, postSegments, cumAscent,
    };
    return {
      mode: 'active',
      climb,
      activeClimb: climb,
      progressFrac: 0.45,
      distIntoClimb: 425,
      distLeft: lengthM - 425,
      ascentLeft: ascentLeftOnClimb(climb, 0.45),
      curGrade: 9.4,
      draft: { text: '48', pct: 48, color: '' },
      allItems: [
        { climb: { index: 1, totalClimbs: 4, lengthM: 680, avgGrade: 5.2, ascentM: 35 }, distToStart: 0, done: true },
        { climb, distToStart: 0, done: false },
        { climb: { index: 3, totalClimbs: 4, lengthM: 940, avgGrade: 6.8, ascentM: 64 }, distToStart: 2400, done: false },
      ],
    };
  }

  if (terra.settings && terra.settings.preview) {
    terra.settings.preview((slot) => {
      if (!slot) return;
      const pv = buildCard(true);
      pv.root.style.background = `rgba(0, 0, 0, ${(clamp(S.opacity, 30, 100) / 100 * 0.65).toFixed(2)})`;
      slot.appendChild(pv.root);
      renderView(pv, makeSampleView(), true);
    });
  }

  async function reloadSettings() {
    try {
      const all = await terra.settings.all();
      S = { ...DEFAULTS, ...all };
      applyBoxStyle();
      syncRoadGauges();
    } catch {}
  }

  function tick() {
    if (cleaned) return;
    syncDock();
    const resolved = resolveRoute();
    if (!resolved) {
      renderView(ui, null);
      return;
    }

    const { route, focal, prev } = resolved;
    const sensKey = SENSITIVITY_CFG[S.sensitivity] ? S.sensitivity : 'all';
    const cacheKey = `${sensKey}:${S.units}`;
    if (cachedClimbsKey !== cacheKey) {
      cachedClimbs = detectClimbs(route, sensKey);
      cachedClimbsKey = cacheKey;
    }

    const { curDist } = findFocalDistance(route, focal, prev);
    const live = sampleRawAtDist(route, curDist);
    const curGrade = readLiveGrade(live.grade);
    const draft = readLiveDraft(focal);

    let active = null;
    for (const c of cachedClimbs) {
      if (curDist >= c.startDist && curDist <= c.endDist) {
        active = c;
        break;
      }
    }

    const allItems = cachedClimbs.map((c) => {
      if (active === c) return { climb: c, distToStart: 0, done: false };
      if (c.startDist > curDist) return { climb: c, distToStart: c.startDist - curDist, done: false };
      if (route.isLoop) return { climb: c, distToStart: (c.startDist - curDist) + route.totalLen, done: false };
      return { climb: c, distToStart: 0, done: true };
    });

    const upcoming = allItems.filter((it) => !it.done && it.climb !== active)
      .sort((a, b) => a.distToStart - b.distToStart);

    if (active) {
      const distIntoClimb = Math.max(0, curDist - active.startDist);
      const frac = clamp(distIntoClimb / Math.max(1, active.lengthM), 0, 1);
      renderView(ui, {
        mode: 'active',
        route,
        curDist,
        climb: active,
        activeClimb: active,
        progressFrac: frac,
        distIntoClimb,
        distLeft: Math.max(0, active.endDist - curDist),
        ascentLeft: ascentLeftOnClimb(active, frac),
        curGrade,
        draft,
        allItems,
      });
    } else if (upcoming.length > 0) {
      const next = upcoming[0];
      renderView(ui, {
        mode: 'approach',
        route,
        curDist,
        climb: next.climb,
        activeClimb: null,
        distToStart: next.distToStart,
        curGrade,
        draft,
        allItems,
      });
    } else {
      renderView(ui, {
        mode: 'none',
        route,
        curDist,
        climb: null,
        activeClimb: null,
        curGrade,
        draft,
        allItems,
      });
    }
  }

  if (terra.settings && terra.settings.onChange) terra.settings.onChange(reloadSettings);
  reloadSettings().then(() => {
    if (cleaned) return;
    tick();
    timer = setInterval(tick, 100);
  });

  terra.onCleanup(() => {
    cleaned = true;
    if (timer) clearInterval(timer);
    for (const off of graphClickCleanups) { try { off(); } catch {} }
    graphClickCleanups.length = 0;
    restoreElevationSvg(true);
    if (hiddenGaugesRow) {
      try { hiddenGaugesRow.classList.remove('tr-cl-hide-gauges'); } catch {}
      hiddenGaugesRow = null;
    }
    if (dockedPanel) {
      try { dockedPanel.classList.remove('tr-cl-profile-host'); } catch {}
      dockedPanel = null;
    }
    if (ui.root.parentNode) ui.root.remove();
  });

  terra.log('climb-profile (Karoo Climber) ready');
})();
