(() => {
  const DEFAULTS = {
    sensitivity: 'all',
    graph_roadmap: true,
    shift_callout: true,
    show_eta: true,
    approach_m: '250',
    zoom_elevation_svg: true,
    zoom_pad_m: '250',
    replace_road_dials: true,
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
  let hoveredClimbIndex = null;
  let lastDrawerKey = '';
  let timer = null;
  let cleaned = false;

  // Summit celebration state (4.5s hold after cresting an active climb)
  let lastActiveClimb = null;
  let summitHold = null;

  // Live climbing pace & VAM tracker (for steady time-to-summit & time-based shift lookahead)
  let paceLastMs = null;
  let paceLastDist = null;
  let paceLastElev = null;
  let speedEma = null; // m/s
  let vamEma = null;   // m/h
  let stoppedSinceMs = null;

  // Elevation SVG zoom & graph roadmap overlay state
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
  let overviewForceFull = false;
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

  // Active overlay metadata for graph roadmap
  let currentOverlayMeta = null; // { route, climb, curDist, mode, isInspected }
  let overlayGraphRef = null;
  let overlayBuiltKey = '';

  let dockedPanel = null;
  let hiddenGaugesRow = null;

  const CSS = `
/* Host elevation panel when Terra ClimbPro is docked seamlessly above .elev-graph */
.panel-profile.tr-cp-profile-host {
  height: auto !important;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.road-row.tr-cp-hide-gauges {
  justify-content: center;
}
.road-row.tr-cp-hide-gauges > .gauge {
  display: none !important;
}
.panel-profile.tr-cp-profile-host > .elev-graph {
  height: var(--hud-profile-h, min(6rem, 15svh));
  flex: none;
  position: relative;
}

/* Base card — mirrors Biketerra's in-ride HUD (--overlay-4, borderless, rem-scaled) */
.tr-cp {
  position: fixed;
  left: 1rem;
  bottom: 8.25rem;
  top: auto;
  z-index: 2147483640;
  width: 26rem;
  border-radius: var(--radius-md, 0.5rem);
  padding: 0.5rem 0.65rem;
  background-color: var(--overlay-4, rgba(0, 0, 0, 0.53));
  color: #fff;
  font-family: var(--font, "Overpass", system-ui, -apple-system, sans-serif);
  font-size: 0.85rem;
  line-height: 1.25;
  text-shadow: var(--hud-text-shadow, 1px 1px 2px var(--overlay-4, rgba(0, 0, 0, 0.5)));
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  box-sizing: border-box;
}
.tr-cp:active { cursor: grabbing; }
.tr-cp.compact { width: auto; min-width: 15.5rem; max-width: 26rem; padding: 0.42rem 0.6rem; }

/* Docked inside Biketerra's .panel-profile.bg-dark */
.tr-cp.tr-cp-docked {
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
  padding: 0.34rem 0.6rem 0.36rem;
  background: transparent;
  border-bottom: 1px solid var(--white-1, rgba(255, 255, 255, 0.1));
  cursor: default;
}
.tr-cp.tr-cp-docked:active { cursor: default; }
.tr-cp.tr-cp-docked.compact {
  width: 100%;
  max-width: none;
  padding: 0.3rem 0.6rem;
}

.tr-cp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.35rem 0.55rem;
}
.tr-cp-head-l {
  display: flex;
  align-items: center;
  gap: 0.42rem;
  min-width: 0;
}
.tr-cp-head-r {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
  margin-left: auto;
}

/* Live Draft pill (left edge) */
.tr-cp-draft {
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
.tr-cp-draft-fill {
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
.tr-cp-draft-lbl {
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
.tr-cp-draft-val {
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

/* Climb Category / Status badge (HC, CAT 1–4, WALL, CLIMB, SUMMIT, FLAT) */
.tr-cp-badge {
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
  padding: 0.14rem 0.44rem 0;
  border-radius: var(--radius-sm, 0.25rem);
  background: var(--bt-a, #ff6262);
  color: #fff;
  text-shadow: none;
  flex-shrink: 0;
  box-sizing: border-box;
}
.tr-cp-badge.cat-hc   { background: #a855f7; color: #fff; }
.tr-cp-badge.cat-1    { background: #ef4444; color: #fff; }
.tr-cp-badge.cat-2    { background: #f97316; color: #09090b; }
.tr-cp-badge.cat-3    { background: #facc15; color: #09090b; }
.tr-cp-badge.cat-4    { background: #4ade80; color: #09090b; }
.tr-cp-badge.cat-wall { background: #ef4444; color: #fff; }
.tr-cp-badge.approach { background: color-mix(in oklab, var(--bt-8, #ffa574) 85%, #000); color: #111; }
.tr-cp-badge.summit   { background: var(--success, #6dd44d); color: #09090b; }
.tr-cp-badge.flat     { background: var(--white-1, rgba(255, 255, 255, 0.1)); color: var(--white-4, rgba(255, 255, 255, 0.8)); }

.tr-cp-title {
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-weight: 700;
  font-size: 0.84rem;
  line-height: 1;
  padding-top: 0.12rem;
  font-variant-numeric: tabular-nums;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Inline KPIs (left / elev / rem / eta) */
.tr-cp-kpis {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  flex-wrap: wrap;
}
.tr-cp.tr-cp-docked .tr-cp-kpis {
  padding-left: 0.58rem;
  border-left: 1px solid var(--white-1, rgba(255, 255, 255, 0.14));
}
.tr-cp-kpi {
  display: inline-flex;
  align-items: baseline;
  gap: 0.25rem;
  padding-top: 0.12rem;
  white-space: nowrap;
}
.tr-cp-kpi-val {
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.9rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  color: #fff;
}
.tr-cp-kpi-lbl {
  font-size: 0.72rem;
  font-weight: 400;
  line-height: 1;
  color: var(--white-4, rgba(255, 255, 255, 0.75));
}

.tr-cp:not(.tr-cp-docked) .tr-cp-kpis {
  order: 3;
  flex-basis: 100%;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.32rem;
  margin-top: 0.25rem;
}
.tr-cp:not(.tr-cp-docked) .tr-cp-kpi {
  flex-direction: column-reverse;
  gap: 0.08rem;
  background: var(--overlay-2, rgba(0, 0, 0, 0.28));
  border-radius: var(--radius-sm, 0.25rem);
  padding: 0.28rem 0.4rem;
}
.tr-cp:not(.tr-cp-docked) .tr-cp-kpi-lbl {
  font-size: 0.62rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--white-3, rgba(255, 255, 255, 0.58));
}
.tr-cp:not(.tr-cp-docked) .tr-cp-kpi-val {
  font-size: 0.96rem;
}

/* Quiet Time-Adaptive Shift-Ahead Callout Pill */
.tr-cp-callout {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.28rem;
  height: 1.42rem;
  padding: 0.14rem 0.46rem 0;
  border-radius: var(--radius-sm, 0.25rem);
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
  box-sizing: border-box;
  text-shadow: none;
}
.tr-cp-callout.summit-near {
  background: rgba(255, 255, 255, 0.16);
  color: #fff;
  box-shadow: inset 3px 0 0 #fff;
}
.tr-cp-callout.dark-text {
  color: #09090b;
}
.tr-cp-callout.light-text {
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
}

/* Tilted-slope Current Grade pill (far right corner) */
.tr-cp-grade {
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
.tr-cp-grade-fill {
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
.tr-cp-grade-val {
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

.tr-cp-list-btn {
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
.tr-cp-list-btn:hover { background: var(--white-2, rgba(255, 255, 255, 0.22)); color: #fff; }
.tr-cp-list-btn.open { background: var(--white-2, rgba(255, 255, 255, 0.24)); color: #fff; }

.tr-cp-zoom-btn {
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
.tr-cp-zoom-btn:hover { background: var(--white-2, rgba(255, 255, 255, 0.22)); color: #fff; }
.tr-cp-zoom-btn.full { background: var(--white-2, rgba(255, 255, 255, 0.24)); color: var(--success, #6dd44d); }
.tr-cp-zoom-btn svg { width: 0.8rem; height: 0.8rem; display: block; pointer-events: none; }
.tr-cp-graph-interactive { cursor: pointer; }

/* Flat-road compact summary */
.tr-cp-compact-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.55rem;
  margin-top: 0.25rem;
  font-size: 0.78rem;
  color: var(--white-4, rgba(255, 255, 255, 0.8));
  font-variant-numeric: tabular-nums;
}
.tr-cp-compact-row strong {
  color: #fff;
  font-weight: 700;
}
.tr-cp.tr-cp-docked .tr-cp-compact-row {
  margin-top: 0;
  font-size: 0.76rem;
  line-height: 1;
  padding: 0.12rem 0 0 0.58rem;
  border-left: 1px solid var(--white-1, rgba(255, 255, 255, 0.14));
  white-space: nowrap;
}

/* Climb list drawer */
.tr-cp-drawer {
  margin-bottom: 0.42rem;
  border-bottom: 1px solid var(--white-1, rgba(255, 255, 255, 0.1));
  padding-bottom: 0.38rem;
  max-height: 9.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
}
.tr-cp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.26rem 0.48rem;
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
.tr-cp-item:hover { background: var(--white-1, rgba(255, 255, 255, 0.12)); color: #fff; }
.tr-cp-item.active { box-shadow: inset 2px 0 0 var(--bt-a, #ff6262); background: color-mix(in oklab, var(--bt-a, #ff6262) 14%, var(--overlay-2, rgba(0, 0, 0, 0.26))); color: #fff; }
.tr-cp-item.done { opacity: 0.5; }
.tr-cp-item.selected { box-shadow: inset 2px 0 0 var(--success, #6dd44d); background: var(--white-1, rgba(255, 255, 255, 0.14)); color: #fff; }
.tr-cp-item-l { display: inline-flex; align-items: center; gap: 0.4rem; font-weight: 700; white-space: nowrap; }
.tr-cp-item-r { font-family: var(--font-mono, "Overpass Mono", monospace); color: var(--white-3, rgba(255, 255, 255, 0.65)); font-size: 0.72rem; white-space: nowrap; }
.tr-cp-mini-cat {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.1rem 0.3rem 0;
  height: 1.05rem;
  border-radius: 0.2rem;
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.58rem;
  font-weight: 700;
  line-height: 1;
  text-transform: uppercase;
  text-shadow: none;
  box-sizing: border-box;
}

.tr-cp.preview { position: static; cursor: default; max-width: 100%; }

/* Zoomed elevation graph & Mountain Stage Roadmap overlays */
.tr-cp-elev-zoomed {
  overflow: hidden !important;
}
.tr-cp-elev-zoomed .elev-cursor {
  display: none !important;
  opacity: 0 !important;
  visibility: hidden !important;
  pointer-events: none !important;
}
.tr-cp-elev-zoomed .profile-riders {
  left: var(--tr-cp-pr-left, 0%) !important;
  width: var(--tr-cp-pr-width, 100%) !important;
  top: var(--tr-cp-pr-top, 0%) !important;
  height: var(--tr-cp-pr-height, 100%) !important;
  right: auto !important;
  bottom: auto !important;
}
.tr-cp-cursor {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  background: #ffffff;
  pointer-events: none;
  z-index: 5;
  box-sizing: border-box;
}
.tr-cp-graph-ov {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 3;
  overflow: hidden;
}

/* Dim conquered part of climb behind the cursor */
.tr-cp-conquered {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  background: linear-gradient(90deg, rgba(0, 0, 0, 0.52) 0%, rgba(0, 0, 0, 0.34) 100%);
  box-sizing: border-box;
}

/* Approach-only START hairline */
.tr-cp-mk-start {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  border-left: 1px dashed rgba(255, 255, 255, 0.45);
  box-sizing: border-box;
}
.tr-cp-mk-start .tr-cp-mk-tag {
  left: 0.22rem;
  background: rgba(0, 0, 0, 0.7);
  color: rgba(255, 255, 255, 0.85);
}

/* Checkered summit line */
.tr-cp-mk-summit {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  transform: translateX(-2px);
  background-image:
    linear-gradient(45deg, #09090b 25%, transparent 25%),
    linear-gradient(-45deg, #09090b 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #09090b 75%),
    linear-gradient(-45deg, transparent 75%, #09090b 75%);
  background-color: #ffffff;
  background-size: 4px 4px;
  background-position: 0 0, 0 2px, 2px -2px, -2px 0;
  opacity: 0.92;
}
.tr-cp-mk-summit .tr-cp-mk-tag {
  right: 0.35rem;
  background: rgba(255, 255, 255, 0.92);
  color: #09090b;
}
.tr-cp-mk-tag {
  position: absolute;
  top: 0.22rem;
  padding: 0.1rem 0.28rem 0;
  border-radius: 0.2rem;
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.56rem;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  text-shadow: none;
}

/* Top-sky Crux (steepest) & Relief (breather) pins */
.tr-cp-pin {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  border-left: 1px dashed rgba(255, 255, 255, 0.24);
  box-sizing: border-box;
  transition: opacity 0.2s ease;
}
.tr-cp-pin.passed {
  opacity: 0.32;
}
.tr-cp-pin-chip {
  position: absolute;
  top: 0.22rem;
  left: 0;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: 0.18rem;
  padding: 0.11rem 0.32rem 0.02rem;
  border-radius: 0.2rem;
  background: rgba(12, 12, 16, 0.82);
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.58rem;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 0.02em;
  white-space: nowrap;
  color: #fff;
  text-shadow: none;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

/* Bottom-anchored Tour-style km-to-summit milestone ticks */
.tr-cp-mile {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  border-left: 1px solid rgba(255, 255, 255, 0.14);
  box-sizing: border-box;
  transition: opacity 0.2s ease;
}
.tr-cp-mile.passed {
  opacity: 0.28;
}
.tr-cp-mile-lbl {
  position: absolute;
  bottom: 0.18rem;
  left: 0;
  transform: translateX(-50%);
  padding: 0.08rem 0.24rem 0;
  border-radius: 0.18rem;
  background: rgba(0, 0, 0, 0.62);
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.56rem;
  font-weight: 700;
  line-height: 1.15;
  color: rgba(255, 255, 255, 0.88);
  white-space: nowrap;
  text-shadow: none;
}

/* All-Climbs Route Overview spans & chips (when Climbs drawer is open) */
.tr-cp-ov-climb {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 3px;
  background: color-mix(in oklab, var(--tr-cat-bg, #ff6262) 22%, transparent);
  border-top: 2px solid var(--tr-cat-bg, #ff6262);
  border-left: 1px solid color-mix(in oklab, var(--tr-cat-bg, #ff6262) 55%, transparent);
  border-right: 1px solid color-mix(in oklab, var(--tr-cat-bg, #ff6262) 40%, transparent);
  box-sizing: border-box;
  pointer-events: auto;
  cursor: pointer;
  transition: opacity 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}
.tr-cp-ov-climb.done {
  opacity: 0.42;
}
.tr-cp-ov-climb.active {
  background: color-mix(in oklab, var(--tr-cat-bg, #ff6262) 32%, transparent);
  border-top-width: 3px;
}
.tr-cp-ov-climb:hover,
.tr-cp-ov-climb.hovered {
  opacity: 1;
  background: color-mix(in oklab, var(--tr-cat-bg, #ff6262) 40%, transparent);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.65);
  z-index: 4;
}
.tr-cp-ov-tag {
  position: absolute;
  top: 0.24rem;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.02rem;
  padding: 0.1rem 0.28rem 0;
  border-radius: 0.2rem;
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.56rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  white-space: nowrap;
  text-shadow: none;
  box-sizing: border-box;
  pointer-events: auto;
  cursor: pointer;
  z-index: 4;
  transition: opacity 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.tr-cp-ov-tag.row-2 {
  top: 1.38rem;
}
.tr-cp-ov-tag.done {
  opacity: 0.48;
}
.tr-cp-ov-tag.active {
  box-shadow: 0 0 0 1.5px #ffffff, 0 1px 4px rgba(0, 0, 0, 0.75);
}
.tr-cp-ov-tag:hover,
.tr-cp-ov-tag.hovered {
  opacity: 1;
  transform: translateX(-50%) scale(1.08);
  box-shadow: 0 0 0 1.5px #ffffff, 0 2px 6px rgba(0, 0, 0, 0.85);
  z-index: 5;
}
.tr-cp-ov-meta {
  position: absolute;
  bottom: 0.22rem;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.02rem;
  padding: 0.1rem 0.28rem 0;
  border-radius: 0.2rem;
  background: rgba(10, 10, 14, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.16);
  font-family: var(--font-mono, "Overpass Mono", monospace);
  font-size: 0.56rem;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.01em;
  color: rgba(255, 255, 255, 0.92);
  white-space: nowrap;
  text-shadow: none;
  box-sizing: border-box;
  pointer-events: auto;
  cursor: pointer;
  z-index: 4;
  transition: opacity 0.15s ease, border-color 0.15s ease, background-color 0.15s ease;
}
.tr-cp-ov-meta.row-2 {
  bottom: 1.36rem;
}
.tr-cp-ov-meta.done {
  opacity: 0.48;
}
.tr-cp-ov-meta.active {
  border-color: rgba(255, 255, 255, 0.55);
  background: rgba(10, 10, 14, 0.88);
  color: #ffffff;
}
.tr-cp-ov-meta.auto-hide {
  display: none;
}
.tr-cp-ov-meta:hover,
.tr-cp-ov-meta.hovered {
  opacity: 1;
  background: rgba(10, 10, 14, 0.94);
  border-color: var(--tr-cat-bg, #ffffff);
  color: #ffffff;
  z-index: 6;
}
.tr-cp-ov-meta.auto-hide.hovered {
  display: inline-flex;
}

svg.tr-cp-svg-zoomed path,
svg.tr-cp-svg-zoomed polyline,
svg.tr-cp-svg-zoomed line {
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
    root.className = 'tr-cp' + (isPreview ? ' preview' : '');
    root.innerHTML =
      '<div class="tr-cp-drawer" style="display:none"></div>' +
      '<div class="tr-cp-head">' +
        '<div class="tr-cp-head-l">' +
          '<span class="tr-cp-draft" style="display:none" title="Current draft">' +
            '<span class="tr-cp-draft-fill"></span>' +
            '<span class="tr-cp-draft-lbl">DRAFT</span>' +
            '<span class="tr-cp-draft-val">0</span>' +
          '</span>' +
          '<span class="tr-cp-badge flat">CLIMBPRO</span>' +
          '<span class="tr-cp-title">Waiting for route\u2026</span>' +
        '</div>' +
        '<div class="tr-cp-kpis" style="display:none">' +
          '<div class="tr-cp-kpi"><span class="tr-cp-kpi-val tr-k1-v">\u2014</span><span class="tr-cp-kpi-lbl tr-k1-l">left</span></div>' +
          '<div class="tr-cp-kpi"><span class="tr-cp-kpi-val tr-k2-v">\u2014</span><span class="tr-cp-kpi-lbl tr-k2-l">elev</span></div>' +
          '<div class="tr-cp-kpi"><span class="tr-cp-kpi-val tr-k3-v">\u2014</span><span class="tr-cp-kpi-lbl tr-k3-l">rem</span></div>' +
          '<div class="tr-cp-kpi tr-k4-wrap" style="display:none"><span class="tr-cp-kpi-val tr-k4-v">\u2014</span><span class="tr-cp-kpi-lbl tr-k4-l">eta</span></div>' +
        '</div>' +
        '<span class="tr-cp-callout" style="display:none"></span>' +
        '<div class="tr-cp-compact-row" style="display:none"></div>' +
        '<div class="tr-cp-head-r">' +
          '<button type="button" class="tr-cp-zoom-btn" style="display:none" title="Zoom out to full route"></button>' +
          '<button type="button" class="tr-cp-list-btn" title="Upcoming & completed climbs">Climbs</button>' +
          '<span class="tr-cp-grade" title="Current grade">' +
            '<span class="tr-cp-grade-fill"></span>' +
            '<span class="tr-cp-grade-val">\u2014%</span>' +
          '</span>' +
        '</div>' +
      '</div>';
    return {
      root,
      badge: root.querySelector('.tr-cp-badge'),
      title: root.querySelector('.tr-cp-title'),
      draft: root.querySelector('.tr-cp-draft'),
      draftFill: root.querySelector('.tr-cp-draft-fill'),
      draftVal: root.querySelector('.tr-cp-draft-val'),
      grade: root.querySelector('.tr-cp-grade'),
      gradeFill: root.querySelector('.tr-cp-grade-fill'),
      gradeVal: root.querySelector('.tr-cp-grade-val'),
      zoomBtn: root.querySelector('.tr-cp-zoom-btn'),
      listBtn: root.querySelector('.tr-cp-list-btn'),
      kpis: root.querySelector('.tr-cp-kpis'),
      k1l: root.querySelector('.tr-k1-l'), k1v: root.querySelector('.tr-k1-v'),
      k2l: root.querySelector('.tr-k2-l'), k2v: root.querySelector('.tr-k2-v'),
      k3l: root.querySelector('.tr-k3-l'), k3v: root.querySelector('.tr-k3-v'),
      k4Wrap: root.querySelector('.tr-k4-wrap'),
      k4l: root.querySelector('.tr-k4-l'), k4v: root.querySelector('.tr-k4-v'),
      callout: root.querySelector('.tr-cp-callout'),
      compactRow: root.querySelector('.tr-cp-compact-row'),
      drawer: root.querySelector('.tr-cp-drawer'),
    };
  }

  const ui = buildCard(false);
  document.body.appendChild(ui.root);

  let savedFloatPos = null;

  function applyFloatingPos() {
    if (!savedFloatPos || !Number.isFinite(savedFloatPos.x)) return;
    const w = ui.root.offsetWidth || 416;
    const h = ui.root.offsetHeight || 110;
    ui.root.style.left = clamp(savedFloatPos.x, 0, Math.max(0, window.innerWidth - w)) + 'px';
    if (Number.isFinite(savedFloatPos.bottom)) {
      ui.root.style.top = 'auto';
      ui.root.style.bottom = clamp(savedFloatPos.bottom, 0, Math.max(0, window.innerHeight - h)) + 'px';
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
      try { dockedPanel.classList.remove('tr-cp-profile-host'); } catch {}
      dockedPanel = null;
    }
    if (ui.root.classList.contains('tr-cp-docked')) {
      ui.root.classList.remove('tr-cp-docked');
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
        try { dockedPanel.classList.remove('tr-cp-profile-host'); } catch {}
      }
      dockedPanel = hostPanel;
      hostPanel.classList.add('tr-cp-profile-host');
      if (!ui.root.classList.contains('tr-cp-docked')) {
        ui.root.classList.add('tr-cp-docked');
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
    if (overviewForceFull) {
      drawerListOpen = false;
      inspectedClimbIndex = null;
      hoveredClimbIndex = null;
      zoomManualFull = false;
      ui.listBtn.classList.remove('open');
      tick();
      return;
    }
    if (!canToggleZoom) return;
    zoomManualFull = !zoomManualFull;
    tick();
  }

  function ensureGraphClickBinding(graph) {
    if (!graph || boundGraphs.has(graph) || typeof graph.addEventListener !== 'function') return;
    boundGraphs.add(graph);
    const onClick = (e) => {
      if ((!canToggleZoom && !overviewForceFull) || (e.target && e.target.closest && e.target.closest('button, a, .tr-cp, .tr-cp-ov-climb, .tr-cp-ov-tag, .tr-cp-ov-meta'))) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      toggleManualFullZoom();
    };
    graph.addEventListener('click', onClick, true);
    graphClickCleanups.push(() => {
      try {
        graph.removeEventListener('click', onClick, true);
        if (graph.classList) graph.classList.remove('tr-cp-graph-interactive');
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
    if (!drawerListOpen) {
      inspectedClimbIndex = null;
      hoveredClimbIndex = null;
    }
    ui.listBtn.classList.toggle('open', drawerListOpen);
    tick();
  });

  function applyBoxStyle() {
    if (ui.root.classList.contains('tr-cp-docked')) {
      ui.root.style.background = '';
      return;
    }
    const op = clamp(S.opacity, 30, 100) / 100;
    ui.root.style.background = `rgba(0, 0, 0, ${(op * 0.65).toFixed(2)})`;
  }

  // Draggable persistence (floating fallback only)
  (async () => {
    try {
      const pos = await terra.storage.get('pos', null);
      if (pos && Number.isFinite(pos.x)) {
        savedFloatPos = pos;
        if (!ui.root.classList.contains('tr-cp-docked')) applyFloatingPos();
      }
    } catch {}
  })();

  let dragging = null;
  ui.root.addEventListener('pointerdown', (e) => {
    if (ui.root.classList.contains('tr-cp-docked')) return;
    if (e.button !== 0 || e.target.closest('button, .tr-cp-item')) return;
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

  /* ---------- Gradient Palette & Cycling Climb Categorization ---------- */
  function gradeColor(g) {
    if (g >= 20.0) return '#a855f7';
    if (g >= 14.0) return '#e879f9';
    if (g >= 11.0) return '#ef4444';
    if (g >= 8.0)  return '#f97316';
    if (g >= 5.0)  return '#facc15';
    if (g >= 2.0)  return '#4ade80';
    if (g >= -0.5) return '#94a3b8';
    return '#38bdf8';
  }
  function isDarkColor(col) {
    return col === '#ef4444' || col === '#a855f7';
  }

  function classifyClimb(lengthM, avgGrade, score) {
    if (score >= 80000) return { label: 'HC', cls: 'cat-hc', bg: '#a855f7', fg: '#ffffff' };
    if (score >= 64000) return { label: 'CAT 1', cls: 'cat-1', bg: '#ef4444', fg: '#ffffff' };
    if (score >= 32000) return { label: 'CAT 2', cls: 'cat-2', bg: '#f97316', fg: '#09090b' };
    if (score >= 16000) return { label: 'CAT 3', cls: 'cat-3', bg: '#facc15', fg: '#09090b' };
    if (score >= 8000)  return { label: 'CAT 4', cls: 'cat-4', bg: '#4ade80', fg: '#09090b' };
    if (lengthM < 500 && avgGrade >= 7.0) {
      return { label: 'WALL', cls: 'cat-wall', bg: '#ef4444', fg: '#ffffff' };
    }
    return { label: 'CLIMB', cls: '', bg: '#ff6262', fg: '#ffffff' };
  }

  /* ---------- Mountain Stage Roadmap Landmarks (Crux, Relief, km-to-summit) ---------- */
  function buildClimbMilestones(climb) {
    const out = [];
    const len = climb.lengthM;
    if (isImp()) {
      const mi = len / 1609.344;
      let stepMi = 0;
      if (mi >= 6) stepMi = 1.0;
      else if (mi >= 1.0) stepMi = 0.5;
      if (stepMi > 0) {
        for (let rem = stepMi; rem < mi - 0.25; rem += stepMi) {
          const distM = climb.endDist - rem * 1609.344;
          if (distM > climb.startDist + 150) {
            const lbl = Number.isInteger(rem) ? `${rem}mi` : `${rem.toFixed(1)}mi`;
            out.push({ distM, label: lbl });
          }
        }
      }
      return out;
    }

    const rems = [];
    if (len >= 6500) {
      rems.push(1000);
      for (let m = 2000; m < len - 600; m += 2000) rems.push(m);
    } else if (len >= 2200) {
      for (let m = 1000; m < len - 400; m += 1000) rems.push(m);
    } else if (len >= 1200) {
      rems.push(500, 1000);
    } else if (len >= 700) {
      rems.push(500);
    }
    for (const rem of rems) {
      const distM = climb.endDist - rem;
      if (distM > climb.startDist + 120) {
        const label = rem >= 1000 ? `${rem / 1000}k` : `${rem}m`;
        out.push({ distM, label });
      }
    }
    return out;
  }

  function findClimbLandmarks(climb) {
    const segs = climb.segments || [];
    const pins = [];
    if (segs.length < 3) return pins;

    // 1. Crux (steepest sustained 100m pitch)
    const cruxWin = segs.length >= 4 ? 2 : 1;
    let bestMax = -Infinity;
    let bestMaxDist = 0;
    for (let i = 0; i <= segs.length - cruxWin; i++) {
      let sumG = 0, sumL = 0;
      for (let k = 0; k < cruxWin; k++) {
        sumG += segs[i + k].grade * segs[i + k].lenM;
        sumL += segs[i + k].lenM;
      }
      const g = sumL > 0 ? sumG / sumL : 0;
      if (g > bestMax) {
        bestMax = g;
        bestMaxDist = climb.startDist + segs[i].offsetM + sumL / 2;
      }
    }
    if (bestMax >= Math.max(8.0, climb.avgGrade + 1.8)) {
      pins.push({
        kind: 'crux',
        distM: bestMaxDist,
        label: `\u25b2 ${Math.round(bestMax)}%`,
        color: gradeColor(bestMax),
      });
    }

    // 2. Relief breather (lowest sustained 150m interior section on climbs >= 1 km)
    if (climb.lengthM >= 1000 && segs.length >= 6) {
      const relWin = 3;
      let bestMin = Infinity;
      let bestMinDist = 0;
      const minOff = climb.lengthM * 0.14;
      const maxOff = climb.lengthM * 0.86;
      for (let i = 0; i <= segs.length - relWin; i++) {
        const midOff = segs[i].offsetM + 75;
        if (midOff < minOff || midOff > maxOff) continue;
        let sumG = 0, sumL = 0;
        for (let k = 0; k < relWin; k++) {
          sumG += segs[i + k].grade * segs[i + k].lenM;
          sumL += segs[i + k].lenM;
        }
        const g = sumL > 0 ? sumG / sumL : 0;
        if (g < bestMin) {
          bestMin = g;
          bestMinDist = climb.startDist + segs[i].offsetM + sumL / 2;
        }
      }
      if (bestMin <= Math.min(3.5, climb.avgGrade - 2.8)) {
        const farFromCrux = !pins.length || Math.abs(bestMinDist - pins[0].distM) >= climb.lengthM * 0.14;
        if (farFromCrux) {
          pins.push({
            kind: 'relief',
            distM: bestMinDist,
            label: `\u25bc ${Math.round(bestMin)}%`,
            color: gradeColor(bestMin),
          });
        }
      }
    }
    return pins;
  }

  /* ---------- Elevation SVG Zoom + Mountain Roadmap Overlays ---------- */
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
    return null;
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
    return null;
  }

  function clearGraphOverlays(graph) {
    const target = graph || overlayGraphRef;
    if (target && target.querySelector) {
      const ov = target.querySelector('.tr-cp-graph-ov');
      if (ov) ov.remove();
    }
    if (!graph || graph === overlayGraphRef) {
      overlayGraphRef = null;
      overlayBuiltKey = '';
    }
  }

  function refreshOverviewHighlight() {
    if (!overlayGraphRef || !overlayGraphRef.querySelectorAll) return;
    const ov = overlayGraphRef.querySelector('.tr-cp-graph-ov');
    if (!ov) return;
    for (const el of ov.querySelectorAll('.tr-cp-ov-climb, .tr-cp-ov-tag, .tr-cp-ov-meta')) {
      const idx = parseInt(el.getAttribute('data-idx'), 10);
      const isHov = hoveredClimbIndex !== null && idx === hoveredClimbIndex;
      el.classList.toggle('hovered', isHov);
      if (el.classList.contains('tr-cp-ov-tag')) {
        const nextTxt = isHov ? el.getAttribute('data-full') : (el.getAttribute('data-base') || el.getAttribute('data-short'));
        if (nextTxt && el.textContent !== nextTxt) el.textContent = nextTxt;
      }
    }
  }

  function ensureOverviewOverlayEl(graph, items) {
    if (!graph || !graph.querySelector || typeof document.createElement !== 'function') return null;
    if (overlayGraphRef && overlayGraphRef !== graph) clearGraphOverlays(overlayGraphRef);
    let ov = graph.querySelector('.tr-cp-graph-ov');
    const sig = items.map((it) => `${it.climb.index}@${Math.round(it.climb.startDist)}-${Math.round(it.climb.endDist)}`).join('|');
    const key = `ov:${sig}:${S.units}`;
    if (!ov || overlayBuiltKey !== key) {
      if (ov) ov.remove();
      ov = document.createElement('div');
      ov.className = 'tr-cp-graph-ov';
      for (const it of items) {
        const c = it.climb;
        const cat = c.cat || { label: 'CLIMB', bg: '#ff6262', fg: '#fff' };
        const statsTxt = `${fmtDistShort(c.lengthM)} \u00b7 ${c.avgGrade.toFixed(1)}%`;
        const tip = `#${c.index} ${cat.label} \u00b7 ${fmtDistShort(c.lengthM)} @ ${c.avgGrade.toFixed(1)}% (+${fmtElev(c.ascentM)}) \u2014 Click to inspect`;

        const onSelect = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
          inspectedClimbIndex = c.index;
          hoveredClimbIndex = null;
          zoomManualFull = false;
          tick();
        };
        const onEnter = () => {
          hoveredClimbIndex = c.index;
          refreshOverviewHighlight();
        };
        const onLeave = () => {
          if (hoveredClimbIndex === c.index) {
            hoveredClimbIndex = null;
            refreshOverviewHighlight();
          }
        };

        const band = document.createElement('div');
        band.className = 'tr-cp-ov-climb';
        band.setAttribute('data-idx', String(c.index));
        band.setAttribute('data-s', c.startDist.toFixed(1));
        band.setAttribute('data-e', c.endDist.toFixed(1));
        band.style.setProperty('--tr-cat-bg', cat.bg);
        band.title = tip;
        band.addEventListener('click', onSelect);
        band.addEventListener('mouseenter', onEnter);
        band.addEventListener('mouseleave', onLeave);
        ov.appendChild(band);

        const tag = document.createElement('span');
        tag.className = 'tr-cp-ov-tag';
        tag.setAttribute('data-idx', String(c.index));
        tag.setAttribute('data-s', c.startDist.toFixed(1));
        tag.setAttribute('data-e', c.endDist.toFixed(1));
        tag.setAttribute('data-short', `#${c.index}`);
        tag.setAttribute('data-full', `#${c.index} ${cat.label}`);
        tag.setAttribute('data-base', `#${c.index}`);
        tag.style.backgroundColor = cat.bg;
        tag.style.color = cat.fg;
        tag.textContent = `#${c.index}`;
        tag.title = tip;
        tag.addEventListener('click', onSelect);
        tag.addEventListener('mouseenter', onEnter);
        tag.addEventListener('mouseleave', onLeave);
        ov.appendChild(tag);

        const meta = document.createElement('span');
        meta.className = 'tr-cp-ov-meta';
        meta.setAttribute('data-idx', String(c.index));
        meta.setAttribute('data-s', c.startDist.toFixed(1));
        meta.setAttribute('data-e', c.endDist.toFixed(1));
        meta.style.setProperty('--tr-cat-bg', cat.bg);
        meta.textContent = statsTxt;
        meta.title = tip;
        meta.addEventListener('click', onSelect);
        meta.addEventListener('mouseenter', onEnter);
        meta.addEventListener('mouseleave', onLeave);
        ov.appendChild(meta);
      }
      graph.appendChild(ov);
      overlayBuiltKey = key;
    }
    overlayGraphRef = graph;
    return ov;
  }

  function ensureGraphOverlayEl(graph, climb) {
    if (!graph || !graph.querySelector || typeof document.createElement !== 'function') return null;
    if (overlayGraphRef && overlayGraphRef !== graph) clearGraphOverlays(overlayGraphRef);
    let ov = graph.querySelector('.tr-cp-graph-ov');
    const key = `cl:${climb.index}:${Math.round(climb.startDist)}:${Math.round(climb.endDist)}:${S.units}`;
    if (!ov || overlayBuiltKey !== key) {
      if (ov) ov.remove();
      ov = document.createElement('div');
      ov.className = 'tr-cp-graph-ov';
      const milestones = buildClimbMilestones(climb);
      const pins = climb.landmarks || [];
      let html =
        '<div class="tr-cp-conquered" style="display:none"></div>' +
        '<div class="tr-cp-mk-start" style="display:none"><span class="tr-cp-mk-tag">START</span></div>';
      for (let i = 0; i < milestones.length; i++) {
        html += `<div class="tr-cp-mile" data-dist="${milestones[i].distM.toFixed(1)}" style="display:none"><span class="tr-cp-mile-lbl">${milestones[i].label}</span></div>`;
      }
      for (let i = 0; i < pins.length; i++) {
        const p = pins[i];
        html += `<div class="tr-cp-pin" data-dist="${p.distM.toFixed(1)}" style="display:none"><span class="tr-cp-pin-chip" style="border-color:${p.color}"><span style="color:${p.color}">${p.label}</span></span></div>`;
      }
      html += '<div class="tr-cp-mk-summit" style="display:none"><span class="tr-cp-mk-tag">TOP</span></div>';
      ov.innerHTML = html;
      graph.appendChild(ov);
      overlayBuiltKey = key;
    }
    overlayGraphRef = graph;
    return ov;
  }

  function updateGraphOverlaysFor(graph, vb, curVb, cursorPos = null) {
    if (!graph || !currentOverlayMeta || !currentOverlayMeta.route) {
      clearGraphOverlays(graph);
      return;
    }
    const { route } = currentOverlayMeta;
    if (!(route.totalLen > 0) || !curVb || !(curVb.w > 0)) {
      clearGraphOverlays(graph);
      return;
    }

    const toPct = (distM) => {
      const svgX = vb.x + clamp(distM / route.totalLen, 0, 1) * vb.w;
      return ((svgX - curVb.x) / curVb.w) * 100;
    };

    if (currentOverlayMeta.kind === 'overview') {
      const items = currentOverlayMeta.items || [];
      if (!items.length) {
        clearGraphOverlays(graph);
        return;
      }
      const ov = ensureOverviewOverlayEl(graph, items);
      if (!ov) return;

      const byIdx = new Map();
      for (const it of items) byIdx.set(it.climb.index, it);
      const actIdx = currentOverlayMeta.activeClimb ? currentOverlayMeta.activeClimb.index : null;

      for (const band of ov.querySelectorAll('.tr-cp-ov-climb')) {
        const idx = parseInt(band.getAttribute('data-idx'), 10);
        const sPct = toPct(parseFloat(band.getAttribute('data-s')));
        const ePct = toPct(parseFloat(band.getAttribute('data-e')));
        if (ePct <= -1 || sPct >= 101) {
          band.style.display = 'none';
          continue;
        }
        const visS = clamp(sPct, 0, 100);
        const visE = clamp(ePct, 0, 100);
        const it = byIdx.get(idx);
        band.style.display = '';
        band.style.left = `${visS.toFixed(3)}%`;
        band.style.width = `${Math.max(0.5, visE - visS).toFixed(3)}%`;
        band.classList.toggle('active', actIdx === idx);
        band.classList.toggle('done', Boolean(it && it.done));
        band.classList.toggle('hovered', hoveredClimbIndex !== null && idx === hoveredClimbIndex);
      }

      const graphW = (graph.clientWidth && graph.clientWidth > 50)
        ? graph.clientWidth
        : ((graph.getBoundingClientRect && graph.getBoundingClientRect().width) || 720);
      const rootPx = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function' && document.documentElement)
        ? (parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16)
        : 16;
      const estChipW = (txt) => (String(txt || '').length * (0.56 * rootPx * 0.62)) + (0.56 * rootPx) + 4;
      const GAP_PX = 5;

      let tagRow0Right = -Infinity;
      let tagRow1Right = -Infinity;
      for (const tag of ov.querySelectorAll('.tr-cp-ov-tag')) {
        const idx = parseInt(tag.getAttribute('data-idx'), 10);
        const sPct = toPct(parseFloat(tag.getAttribute('data-s')));
        const ePct = toPct(parseFloat(tag.getAttribute('data-e')));
        if (ePct <= -1 || sPct >= 101) {
          tag.style.display = 'none';
          continue;
        }
        const visS = clamp(sPct, 0, 100);
        const visE = clamp(ePct, 0, 100);
        const bandPx = ((visE - visS) / 100) * graphW;
        const fullTxt = tag.getAttribute('data-full');
        const shortTxt = tag.getAttribute('data-short');
        const fullW = estChipW(fullTxt);
        const baseTxt = bandPx >= fullW + 6 ? fullTxt : shortTxt;
        tag.setAttribute('data-base', baseTxt);
        const isHov = hoveredClimbIndex !== null && idx === hoveredClimbIndex;
        const nextTxt = isHov ? fullTxt : baseTxt;
        if (tag.textContent !== nextTxt) tag.textContent = nextTxt;

        const chipW = estChipW(baseTxt);
        const midPx = clamp(((visS + visE) / 2 / 100) * graphW, chipW / 2 + 3, Math.max(chipW / 2 + 3, graphW - chipW / 2 - 3));
        const leftPx = midPx - chipW / 2;
        const rightPx = midPx + chipW / 2;
        let useRow2 = false;
        if (leftPx >= tagRow0Right + GAP_PX) {
          tagRow0Right = rightPx;
        } else {
          useRow2 = true;
          tagRow1Right = Math.max(tagRow1Right, rightPx);
        }

        const it = byIdx.get(idx);
        tag.style.display = '';
        tag.style.left = `${((midPx / graphW) * 100).toFixed(3)}%`;
        tag.classList.toggle('row-2', useRow2);
        tag.classList.toggle('active', actIdx === idx);
        tag.classList.toggle('done', Boolean(it && it.done));
        tag.classList.toggle('hovered', isHov);
      }

      let metaRow0Right = -Infinity;
      let metaRow1Right = -Infinity;
      for (const meta of ov.querySelectorAll('.tr-cp-ov-meta')) {
        const idx = parseInt(meta.getAttribute('data-idx'), 10);
        const sPct = toPct(parseFloat(meta.getAttribute('data-s')));
        const ePct = toPct(parseFloat(meta.getAttribute('data-e')));
        if (ePct <= -1 || sPct >= 101) {
          meta.style.display = 'none';
          continue;
        }
        const visS = clamp(sPct, 0, 100);
        const visE = clamp(ePct, 0, 100);
        const chipW = estChipW(meta.textContent);
        const midPx = clamp(((visS + visE) / 2 / 100) * graphW, chipW / 2 + 3, Math.max(chipW / 2 + 3, graphW - chipW / 2 - 3));
        const leftPx = midPx - chipW / 2;
        const rightPx = midPx + chipW / 2;

        let useRow2 = false;
        let autoHide = false;
        if (leftPx >= metaRow0Right + GAP_PX) {
          metaRow0Right = rightPx;
        } else if (leftPx >= metaRow1Right + GAP_PX) {
          useRow2 = true;
          metaRow1Right = rightPx;
        } else {
          useRow2 = true;
          autoHide = true;
        }

        const it = byIdx.get(idx);
        const isHov = hoveredClimbIndex !== null && idx === hoveredClimbIndex;
        meta.style.display = '';
        meta.style.left = `${((midPx / graphW) * 100).toFixed(3)}%`;
        meta.classList.toggle('row-2', useRow2);
        meta.classList.toggle('auto-hide', autoHide);
        meta.classList.toggle('active', actIdx === idx);
        meta.classList.toggle('done', Boolean(it && it.done));
        meta.classList.toggle('hovered', isHov);
      }
      return;
    }

    if (!S.graph_roadmap || !currentOverlayMeta.climb) {
      clearGraphOverlays(graph);
      return;
    }
    const { climb, curDist, mode, isInspected } = currentOverlayMeta;
    const ov = ensureGraphOverlayEl(graph, climb);
    if (!ov) return;

    // 1. Conquered mountain scrim behind cursor (locked to the live rider marker)
    const conqEl = ov.querySelector('.tr-cp-conquered');
    if (conqEl) {
      if ((mode === 'active' || mode === 'summit') && !isInspected && curDist > climb.startDist) {
        let applied = false;
        const ovRect = ov.getBoundingClientRect ? ov.getBoundingClientRect() : null;

        if (cursorPos && Number.isFinite(cursorPos.screenX) && ovRect && ovRect.width > 0) {
          const ovLeft = ovRect.left + (ov.clientLeft || 0);
          const wPx = clamp(cursorPos.screenX - ovLeft, 0, ovRect.width);
          if (wPx > 0.5) {
            conqEl.style.display = '';
            conqEl.style.width = `${wPx.toFixed(2)}px`;
          } else {
            conqEl.style.display = 'none';
          }
          applied = true;
        }

        if (!applied && !cursorPos && graph.querySelector) {
          const origCursor = graph.querySelector('.elev-cursor');
          if (origCursor) {
            const isZoomed = graph.classList && graph.classList.contains('tr-cp-elev-zoomed');
            const cRect = (!isZoomed && origCursor.getBoundingClientRect) ? origCursor.getBoundingClientRect() : null;
            if (cRect && (cRect.width > 0 || cRect.left > 0) && ovRect && ovRect.width > 0) {
              const ovLeft = ovRect.left + (ov.clientLeft || 0);
              const wPx = clamp((cRect.left + cRect.width / 2) - ovLeft, 0, ovRect.width);
              if (wPx > 0.5) {
                conqEl.style.display = '';
                conqEl.style.width = `${wPx.toFixed(2)}px`;
              } else {
                conqEl.style.display = 'none';
              }
              applied = true;
            } else if (!detectedNativeBox) {
              const m = String(origCursor.style.left || '').match(/(-?\d+(?:\.\d+)?)%/);
              if (m) {
                const riderFrac = clamp(parseFloat(m[1]) / 100, 0, 1);
                const svgX = vb.x + riderFrac * vb.w;
                const curPct = clamp(((svgX - curVb.x) / curVb.w) * 100, 0, 100);
                if (curPct > 0.3) {
                  conqEl.style.display = '';
                  conqEl.style.width = `${curPct.toFixed(3)}%`;
                } else {
                  conqEl.style.display = 'none';
                }
                applied = true;
              }
            }
          }
        }

        if (!applied) {
          const curPct = cursorPos && Number.isFinite(cursorPos.frac)
            ? clamp(cursorPos.frac * 100, 0, 100)
            : clamp(toPct(curDist), 0, 100);
          if (curPct > 0.3) {
            conqEl.style.display = '';
            conqEl.style.width = `${curPct.toFixed(3)}%`;
          } else {
            conqEl.style.display = 'none';
          }
        }
      } else {
        conqEl.style.display = 'none';
      }
    }

    // 2. Approach-only START hairline (hidden once actively climbing past START)
    const startEl = ov.querySelector('.tr-cp-mk-start');
    if (startEl) {
      const showStart = (mode === 'approach' || isInspected || curDist <= climb.startDist + 20);
      const startPct = toPct(climb.startDist);
      if (showStart && startPct > 1.5 && startPct < 94) {
        startEl.style.display = '';
        startEl.style.left = `${startPct.toFixed(3)}%`;
      } else {
        startEl.style.display = 'none';
      }
    }

    // 3. Checkered summit line
    const summitEl = ov.querySelector('.tr-cp-mk-summit');
    const summitPct = toPct(climb.endDist);
    if (summitEl) {
      if (summitPct > 2 && summitPct < 99.5) {
        summitEl.style.display = '';
        summitEl.style.left = `${summitPct.toFixed(3)}%`;
      } else {
        summitEl.style.display = 'none';
      }
    }

    // 4. Bottom km-to-summit milestone ticks (auto-spaced, dimmed once passed)
    let lastMilePct = -100;
    for (const el of ov.querySelectorAll('.tr-cp-mile')) {
      const d = parseFloat(el.getAttribute('data-dist'));
      const pct = toPct(d);
      if (pct > 5 && pct < 93 && Math.abs(pct - summitPct) > 6 && Math.abs(pct - lastMilePct) > 7) {
        el.style.display = '';
        el.style.left = `${pct.toFixed(3)}%`;
        el.classList.toggle('passed', !isInspected && curDist >= d);
        lastMilePct = pct;
      } else {
        el.style.display = 'none';
      }
    }

    // 5. Top-sky Crux (▲) & Relief (▼) landmark pins
    let lastPinPct = -100;
    for (const el of ov.querySelectorAll('.tr-cp-pin')) {
      const d = parseFloat(el.getAttribute('data-dist'));
      const pct = toPct(d);
      if (pct > 7 && pct < 88 && Math.abs(pct - summitPct) > 10 && Math.abs(pct - lastPinPct) > 12) {
        el.style.display = '';
        el.style.left = `${pct.toFixed(3)}%`;
        el.classList.toggle('passed', !isInspected && curDist >= d);
        lastPinPct = pct;
      } else {
        el.style.display = 'none';
      }
    }
  }

  let lastCursorPx = null;
  let lastCursorWidth = null;
  let lastCursorHidden = false;

  function updateZoomedCursorFor(svg, graph, vb, curVb, fallbackFrac) {
    if (!svg || !graph) return;
    const origCursor = graph.querySelector ? graph.querySelector('.elev-cursor') : null;
    if (!origCursor) return;

    let trCursor = graph.querySelector ? graph.querySelector('.tr-cp-cursor') : null;
    if (!trCursor && typeof document.createElement === 'function') {
      trCursor = document.createElement('div');
      trCursor.className = 'tr-cp-cursor';
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
      updateGraphOverlaysFor(graph, vb, curVb, { frac: zoomedFrac, screenX: null });
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
    let cursorScreenX = null;

    if (refRect && refRect.width > 0) {
      const targetCenterX = refRect.left + frac * refRect.width;
      const rawScreenX = targetCenterX - cssW / 2;
      const snappedScreenX = Math.round(rawScreenX * dpr) / dpr;
      cursorScreenX = snappedScreenX + cssW / 2;
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
      const pct = `${(frac * 100).toFixed(2)}%`;
      if (pct !== lastCursorPx) {
        lastCursorPx = pct;
        trCursor.style.left = pct;
      }
    }

    updateGraphOverlaysFor(graph, vb, curVb, { frac: zoomedFrac, screenX: cursorScreenX });
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

  function setCssVarIfChanged(el, name, val) {
    if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
    if (typeof el.style.getPropertyValue === 'function' && el.style.getPropertyValue(name) === val) return;
    el.style.setProperty(name, val);
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
    if (graph.classList && !graph.classList.contains('tr-cp-elev-zoomed')) {
      graph.classList.add('tr-cp-elev-zoomed');
    }
    const nx = detectedNativeBox.x;
    const nw = detectedNativeBox.w;
    if (orig.vb.w > 0 && orig.vb.h > 0) {
      setCssVarIfChanged(graph, '--tr-cp-pr-left', `${(((nx - orig.vb.x) / orig.vb.w) * 100).toFixed(3)}%`);
      setCssVarIfChanged(graph, '--tr-cp-pr-width', `${((nw / orig.vb.w) * 100).toFixed(3)}%`);
      setCssVarIfChanged(graph, '--tr-cp-pr-top', '0.000%');
      setCssVarIfChanged(graph, '--tr-cp-pr-height', '100.000%');
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
            if (curVb.w < 0.99 || Math.abs(curVb.x) > 0.005) detectedNativeBox = curVb;
          }
          svg.setAttribute('viewBox', lastAppliedVbStr);
        }
        return;
      }
      if ((zoomManualFull || overviewForceFull) && (canToggleZoom || overviewForceFull) && guardedOrig && curStr !== guardedOrig.viewBox) {
        const curVb = parseViewBox(curStr);
        if (curVb && (curVb.w < 0.99 || Math.abs(curVb.x) > 0.005)) detectedNativeBox = curVb;
        svg.setAttribute('viewBox', guardedOrig.viewBox);
        if (guardedGraph && guardedRoute) {
          applyFullRouteOverride(svg, guardedGraph, guardedOrig, guardedRoute, guardedCurDist);
        }
      }
    });
    try { vbObserver.observe(svg, { attributes: true, attributeFilter: ['viewBox'] }); } catch {}
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
      const isNativeZoomed = curVb.w < 0.99 || Math.abs(curVb.x) > 0.005;
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
    if (svg.classList && !svg.classList.contains('tr-cp-svg-zoomed')) {
      svg.classList.add('tr-cp-svg-zoomed');
    }
    if (graph && graph.querySelector) {
      if (graph.classList && !graph.classList.contains('tr-cp-elev-zoomed')) {
        graph.classList.add('tr-cp-elev-zoomed');
      }
      const baseX = detectedNativeBox ? detectedNativeBox.x : orig.vb.x;
      const baseW = detectedNativeBox ? detectedNativeBox.w : orig.vb.w;
      const baseY = orig.vb.y;
      const baseH = orig.vb.h;
      if (box.w > 0 && box.h > 0) {
        setCssVarIfChanged(graph, '--tr-cp-pr-left', `${(((baseX - box.x) / box.w) * 100).toFixed(3)}%`);
        setCssVarIfChanged(graph, '--tr-cp-pr-width', `${((baseW / box.w) * 100).toFixed(3)}%`);
        setCssVarIfChanged(graph, '--tr-cp-pr-top', `${(((baseY - box.y) / box.h) * 100).toFixed(3)}%`);
        setCssVarIfChanged(graph, '--tr-cp-pr-height', `${((baseH / box.h) * 100).toFixed(3)}%`);
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
      if (orig) applyZoomViewBox(activeZoomedSvg, activeZoomedGraph, orig, box);
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
    const keepFullGuard = !immediate && (zoomManualFull || overviewForceFull) && (canToggleZoom || overviewForceFull);
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
        if (g.classList) g.classList.remove('tr-cp-elev-zoomed');
        if (g.style && typeof g.style.removeProperty === 'function') {
          g.style.removeProperty('--tr-cp-pr-left');
          g.style.removeProperty('--tr-cp-pr-width');
          g.style.removeProperty('--tr-cp-pr-top');
          g.style.removeProperty('--tr-cp-pr-height');
        }
        const trCursor = g.querySelector ? g.querySelector('.tr-cp-cursor') : null;
        if (trCursor) trCursor.remove();
        if (immediate || !currentOverlayMeta || (currentOverlayMeta.kind !== 'overview' && !S.graph_roadmap)) {
          clearGraphOverlays(g);
        }
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
      if (svg.classList) svg.classList.remove('tr-cp-svg-zoomed');
    } catch {}
    if (keepNativeOverride && g && orig && guardedRoute) {
      applyFullRouteOverride(svg, g, orig, guardedRoute, guardedCurDist);
    } else if (!immediate && g && orig && currentOverlayMeta && (currentOverlayMeta.kind === 'overview' || S.graph_roadmap)) {
      updateGraphOverlaysFor(g, orig.vb, orig.vb);
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
    if (zoomRestoring && vbApproxEq(zoomTargetVb, orig.vb)) return;
    zoomRestoring = true;
    zoomFromVb = { ...zoomCurrentVb };
    zoomTargetVb = { ...orig.vb };
    zoomAnimStart = nowMs();
    startCursorRaf();
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
      const isNativeZoomed = curVb.w < 0.99 || Math.abs(curVb.x) > 0.005;
      if (isNativeZoomed) detectedNativeBox = curVb;
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

  /* ---------- Route Extraction & 2-Stage Climb Detection ---------- */
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

      let totalAscent = 0;
      let totalDescent = 0;
      let prevSampleY = pts[0].y;
      let nextSampleD = 20;
      for (let i = 1; i < n; i++) {
        if (dist[i] >= nextSampleD || i === n - 1) {
          const dy = pts[i].y - prevSampleY;
          if (dy > 0) totalAscent += dy;
          else if (dy < 0) totalDescent += -dy;
          prevSampleY = pts[i].y;
          nextSampleD = dist[i] + 20;
        }
      }
      const netElev = pts[n - 1].y - pts[0].y;
      const avgGrade = (netElev / totalLen) * 100;

      cachedRoute = { listRef: list, pts, dist, grades, totalLen, isLoop, n, netElev, avgGrade, totalAscent, totalDescent };
      cachedClimbsKey = '';
      inspectedClimbIndex = null;
      lastActiveClimb = null;
      summitHold = null;
      paceLastMs = null;
      paceLastDist = null;
      paceLastElev = null;
      speedEma = null;
      vamEma = null;
      stoppedSinceMs = null;
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

    // Stage 1: Grade-aware seed extraction
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
      if (len >= 80 && gain >= 3) seeds.push({ s: sIdx, e: pIdx });
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
        if (sl >= CONT_GRADE) lastActiveIdx = i;
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

    // Stage 2: Merge adjacent seeds across short benches / dips
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

    // Stage 3: Trim edges, qualify, categorize, build 50m segments & roadmap landmarks
    const rawClimbs = [];
    const segM = 50;

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

      const segments = [];
      let segStart = startDist;
      while (segStart < endDist - 1) {
        let segEnd = Math.min(endDist, segStart + segM);
        if (endDist - segEnd > 0 && endDist - segEnd < 10) segEnd = endDist;
        const len = segEnd - segStart;
        const segGrade = ((sampleElev(segEnd) - sampleElev(segStart)) / Math.max(5, len)) * 100;
        segments.push({
          offsetM: segStart - startDist,
          lenM: len,
          grade: segGrade,
          color: gradeColor(segGrade),
        });
        segStart = segEnd;
      }

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

      const climbObj = {
        startDist,
        endDist,
        lengthM,
        startElev,
        endElev,
        ascentM: Math.max(netGain, cumAscent[steps]),
        avgGrade,
        score,
        cat: classifyClimb(lengthM, avgGrade, score),
        segments,
        cumAscent,
        landmarks: [],
      };
      climbObj.landmarks = findClimbLandmarks(climbObj);
      rawClimbs.push(climbObj);
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

  /* ---------- Live Pace, VAM & Time-to-Summit Estimator ---------- */
  function updatePaceTracker(tNow, focal, curDist, curElev, curGrade) {
    const simSpeed = focal && focal.sim && Number.isFinite(focal.sim.speed) && focal.sim.speed >= 0
      ? focal.sim.speed
      : null;

    let instSpeed = simSpeed;
    let instVam = null;
    let dtSec = 0;

    if (paceLastMs !== null && paceLastDist !== null && paceLastElev !== null) {
      dtSec = (tNow - paceLastMs) / 1000;
      const dd = curDist - paceLastDist;
      const dy = curElev - paceLastElev;
      if (dtSec > 0.05 && dtSec < 5.0 && Math.abs(dd) < 150) {
        if (instSpeed === null && dd >= 0) instSpeed = dd / dtSec;
        if (dy > 0) instVam = (dy / dtSec) * 3600;
      } else if (dtSec >= 5.0 || Math.abs(dd) >= 150) {
        speedEma = null;
        vamEma = null;
      }
    }
    paceLastMs = tNow;
    paceLastDist = curDist;
    paceLastElev = curElev;

    if (instSpeed !== null && Number.isFinite(instSpeed)) {
      if (instSpeed < 0.5) {
        if (stoppedSinceMs === null) stoppedSinceMs = tNow;
      } else {
        stoppedSinceMs = null;
        const alphaSpd = dtSec > 0 ? clamp(dtSec / 14, 0.02, 0.25) : 0.12;
        speedEma = speedEma === null ? instSpeed : speedEma + alphaSpd * (instSpeed - speedEma);

        const effGrade = Number.isFinite(curGrade) && curGrade > 1.0 ? curGrade : 0;
        const gradeVam = instSpeed * (effGrade / 100) * 3600;
        const sampleVam = (instVam !== null && instVam > 60) ? instVam : (gradeVam > 60 ? gradeVam : null);
        if (sampleVam !== null) {
          const clampedVam = clamp(sampleVam, 120, 2600);
          const alphaVam = dtSec > 0 ? clamp(dtSec / 24, 0.015, 0.18) : 0.1;
          vamEma = vamEma === null ? clampedVam : vamEma + alphaVam * (clampedVam - vamEma);
        }
      }
    }
  }

  function estimateSummitEtaSec(distLeft, ascentLeft, remAvgGrade) {
    if (!(distLeft > 5)) return 0;
    if (stoppedSinceMs !== null && (nowMs() - stoppedSinceMs) > 3000) return null;

    const spd = speedEma && speedEma >= 0.8 ? speedEma : null;
    const vam = vamEma && vamEma >= 150 ? vamEma : null;

    const etaBySpeed = spd ? distLeft / spd : null;
    const etaByVam = (vam && ascentLeft > 5) ? (ascentLeft / vam) * 3600 : null;

    if (etaByVam !== null && remAvgGrade >= 5.0) return etaByVam;
    if (etaByVam !== null && etaBySpeed !== null && remAvgGrade >= 3.0) {
      const wVam = clamp((remAvgGrade - 3.0) / 2.0, 0, 1);
      return etaByVam * wVam + etaBySpeed * (1 - wVam);
    }
    return etaBySpeed !== null ? etaBySpeed : etaByVam;
  }

  function fmtEta(sec) {
    if (sec === null || sec === undefined || !Number.isFinite(sec) || sec <= 0) return '\u2014';
    if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
    if (sec < 600) {
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      if (s === 60) return `${m + 1}:00`;
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    const mins = Math.round(sec / 60);
    if (mins < 60) return `~${mins}m`;
    const h = Math.floor(mins / 60);
    const remM = mins % 60;
    return `~${h}h ${String(remM).padStart(2, '0')}m`;
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
  function fmtStepDist(m) {
    if (isImp()) return `${Math.max(10, Math.round((m / 0.9144) / 10) * 10)}yd`;
    return `${Math.max(10, Math.round(m / 10) * 10)}m`;
  }
  function fmtElev(m) {
    if (isImp()) return `${Math.round(m / 0.3048)} ft`;
    return `${Math.round(m)} m`;
  }

  function describeNoClimbRoute(route) {
    if (!route || !(route.totalLen > 0)) {
      return { title: 'Flat Route', detail: 'No climbs detected', expandedTitle: 'No Climbs Detected' };
    }
    const { netElev = 0, avgGrade = 0, totalAscent = 0, totalDescent = 0, totalLen } = route;
    const km = Math.max(0.1, totalLen / 1000);
    if (netElev <= -25 && avgGrade <= -1.0 && totalDescent >= totalAscent * 1.5) {
      return {
        title: 'Downhill Route',
        detail: `-${fmtElev(Math.abs(netElev))} \u00b7 ${avgGrade.toFixed(1)}% avg`,
        expandedTitle: `Downhill Route (-${fmtElev(Math.abs(netElev))})`,
      };
    }
    if (totalAscent >= 50 && (totalAscent / km) >= 10) {
      return {
        title: 'Rolling Route',
        detail: `+${fmtElev(totalAscent)} \u00b7 no major climbs`,
        expandedTitle: 'Rolling Route',
      };
    }
    return {
      title: 'Flat Route',
      detail: 'No climbs detected',
      expandedTitle: 'No Climbs Detected',
    };
  }

  /* ---------- Time-Adaptive Quiet Shift-Ahead Callout ---------- */
  function computeShiftCallout(climb, distIntoClimb, distLeft, curGrade) {
    if (!climb || !climb.segments || !climb.segments.length) return null;

    const spd = (speedEma && speedEma >= 1.2) ? speedEma : 4.2;
    const minAheadM = clamp(spd * 3, 15, 45);
    const maxAheadM = clamp(spd * 30, 95, 240);
    const summitAlertM = clamp(spd * 30, 100, 200);

    if (distLeft > 5 && distLeft <= summitAlertM) {
      return {
        kind: 'summit',
        text: `TOP in ${fmtStepDist(distLeft)}`,
        bg: '',
        darkText: false,
      };
    }

    const baseG = Number.isFinite(curGrade) ? curGrade : climb.avgGrade;
    let steepHit = null;
    let easeHit = null;

    for (const seg of climb.segments) {
      const aheadM = seg.offsetM - distIntoClimb;
      if (aheadM < minAheadM) continue;
      if (aheadM > maxAheadM) break;

      if (seg.grade >= baseG + 2.5 && seg.grade >= 6.5) {
        if (!steepHit || seg.grade > steepHit.grade + 1.5) {
          steepHit = { aheadM, grade: seg.grade, color: seg.color };
        }
      }
      if (baseG >= 6.0 && seg.grade <= baseG - 3.0 && seg.grade <= 4.0) {
        if (!easeHit) {
          easeHit = { aheadM, grade: seg.grade, color: seg.color };
        }
      }
    }

    if (steepHit) {
      return {
        kind: 'steep',
        text: `\u2197 ${Math.round(steepHit.grade)}% in ${fmtStepDist(steepHit.aheadM)}`,
        bg: steepHit.color,
        darkText: !isDarkColor(steepHit.color),
      };
    }
    if (easeHit) {
      return {
        kind: 'ease',
        text: `\u2198 ${Math.round(easeHit.grade)}% in ${fmtStepDist(easeHit.aheadM)}`,
        bg: easeHit.color,
        darkText: !isDarkColor(easeHit.color),
      };
    }
    return null;
  }

  /* ---------- Live Native Gauges (Draft & Grade) ---------- */
  function syncRoadGauges() {
    const shouldHide =
      !cleaned &&
      Boolean(S.replace_road_dials) &&
      ui.root.classList.contains('tr-cp-docked') &&
      ui.root.style.display !== 'none';

    const row = shouldHide && typeof document.querySelector === 'function'
      ? document.querySelector('.zone-road .road-row, .road-row')
      : null;

    if (hiddenGaugesRow && hiddenGaugesRow !== row) {
      try { hiddenGaugesRow.classList.remove('tr-cp-hide-gauges'); } catch {}
      hiddenGaugesRow = null;
    }
    if (shouldHide && row) {
      row.classList.add('tr-cp-hide-gauges');
      hiddenGaugesRow = row;
    } else if (hiddenGaugesRow) {
      try { hiddenGaugesRow.classList.remove('tr-cp-hide-gauges'); } catch {}
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
        return { text: rawTxt || String(Math.round(pct)), pct, color };
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
    const col = gradeColor(g);
    const tiltDeg = -clamp((Math.atan(g / 100) * 180 / Math.PI) * 2.0, -28, 28);
    els.gradeFill.style.backgroundColor = col;
    els.gradeFill.style.transform = `rotate(${tiltDeg.toFixed(2)}deg)`;
  }

  function setCalloutPill(els, callout) {
    if (!els.callout) return;
    if (!callout) {
      els.callout.style.display = 'none';
      return;
    }
    els.callout.style.display = '';
    els.callout.textContent = callout.text;
    if (callout.kind === 'summit') {
      els.callout.className = 'tr-cp-callout summit-near';
      els.callout.style.backgroundColor = '';
    } else {
      els.callout.className = 'tr-cp-callout ' + (callout.darkText ? 'dark-text' : 'light-text');
      els.callout.style.backgroundColor = callout.bg || '';
    }
  }

  function renderDrawerList(els, items, activeClimb) {
    if (!drawerListOpen || !items.length) {
      if (els.drawer.style.display !== 'none') {
        els.drawer.style.display = 'none';
        els.drawer.replaceChildren();
        lastDrawerKey = '';
      }
      return;
    }
    els.drawer.style.display = 'flex';
    const parts = items.map((it) => {
      const isAct = activeClimb && it.climb === activeClimb;
      const isSel = inspectedClimbIndex === it.climb.index;
      const status = isAct ? 'NOW' : it.done ? 'Done' : `In ${fmtDistShort(it.distToStart)}`;
      return `${it.climb.index}:${isAct ? 1 : 0}:${it.done ? 1 : 0}:${isSel ? 1 : 0}:${status}`;
    });
    const drawerKey = `${S.units}|${parts.join('|')}`;
    if (drawerKey === lastDrawerKey && els.drawer.children.length === items.length) return;
    lastDrawerKey = drawerKey;

    const rows = items.map((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isAct = activeClimb && it.climb === activeClimb;
      const isSel = inspectedClimbIndex === it.climb.index;
      btn.className = 'tr-cp-item' + (isAct ? ' active' : '') + (it.done ? ' done' : '') + (isSel ? ' selected' : '');
      const status = isAct ? 'NOW' : it.done ? 'Done' : `In ${fmtDistShort(it.distToStart)}`;
      const cat = it.climb.cat || { label: 'CLIMB', bg: '#ff6262', fg: '#fff' };
      btn.innerHTML =
        `<span class="tr-cp-item-l">` +
          `<span class="tr-cp-mini-cat" style="background:${cat.bg};color:${cat.fg}">${cat.label}</span>` +
          `#${it.climb.index} \u00b7 ${fmtDistShort(it.climb.lengthM)} @ ${it.climb.avgGrade.toFixed(1)}%` +
        `</span>` +
        `<span class="tr-cp-item-r">+${fmtElev(it.climb.ascentM)} \u00b7 ${status}</span>`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        inspectedClimbIndex = (inspectedClimbIndex === it.climb.index) ? null : it.climb.index;
        hoveredClimbIndex = null;
        zoomManualFull = false;
        tick();
      });
      btn.addEventListener('mouseenter', () => {
        hoveredClimbIndex = it.climb.index;
        refreshOverviewHighlight();
      });
      btn.addEventListener('mouseleave', () => {
        if (hoveredClimbIndex === it.climb.index) {
          hoveredClimbIndex = null;
          refreshOverviewHighlight();
        }
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
        overviewForceFull = false;
        currentOverlayMeta = null;
        restoreElevationSvg(true);
      }
      els.root.classList.remove('compact');
      els.badge.className = 'tr-cp-badge flat';
      els.badge.textContent = 'CLIMBPRO';
      els.title.textContent = 'Waiting for route\u2026';
      setDraftPill(els, null);
      setGradePill(els, null);
      setCalloutPill(els, null);
      els.zoomBtn.style.display = 'none';
      els.listBtn.style.display = 'none';
      els.kpis.style.display = 'none';
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
    const isNearOrActive =
      view.mode === 'active' ||
      view.mode === 'summit' ||
      (view.mode === 'approach' && view.distToStart <= approachThreshold);

    const inspected = inspectedClimbIndex
      ? (view.allItems || []).find((it) => it.climb.index === inspectedClimbIndex)
      : null;

    const isOverview = !isPreview && drawerListOpen && !inspected && totalClimbs > 0;
    const zoomClimb = (inspected && inspected.climb) || (isNearOrActive ? view.climb : null);
    let toggleAvailable = false;

    if (!isPreview) {
      overviewForceFull = isOverview;
      if (isOverview && view.route) {
        currentOverlayMeta = {
          kind: 'overview',
          route: view.route,
          items: view.allItems || [],
          activeClimb: view.activeClimb,
          curDist: view.curDist,
        };
      } else if (zoomClimb && view.route) {
        currentOverlayMeta = {
          kind: 'climb',
          route: view.route,
          climb: zoomClimb,
          curDist: view.curDist,
          mode: view.mode,
          isInspected: Boolean(inspected && inspected.climb !== view.activeClimb),
        };
      } else {
        currentOverlayMeta = null;
      }
    }

    if (S.zoom_elevation_svg && zoomClimb && view.route && view.route.totalLen > 0) {
      const w0 = Math.max(0, zoomClimb.startDist - padM);
      const w1 = Math.min(view.route.totalLen, zoomClimb.endDist + padM);
      const spanFrac = (w1 - w0) / view.route.totalLen;
      toggleAvailable = spanFrac > 0.005 && spanFrac < 0.96;
      if (!isPreview) {
        canToggleZoom = toggleAvailable;
        if (toggleAvailable && !zoomManualFull && !isOverview) {
          stopFullRouteGuard();
          zoomElevationSvg(view.route, w0, w1, view.curDist);
        } else {
          restoreElevationSvg(false);
          if ((toggleAvailable && zoomManualFull) || isOverview) {
            ensureFullRouteGuard(view.route, view.curDist);
          } else {
            stopFullRouteGuard();
          }
        }
      }
    } else if (!isPreview) {
      canToggleZoom = false;
      zoomManualFull = false;
      if (isOverview && view.route) {
        restoreElevationSvg(false);
        ensureFullRouteGuard(view.route, view.curDist);
      } else {
        stopFullRouteGuard();
        restoreElevationSvg(false);
      }
    }

    if (!isPreview) {
      const svgForGraph = findElevationSvg();
      const graphEl = svgForGraph && ((svgForGraph.closest && svgForGraph.closest('.elev-graph')) || svgForGraph.parentNode);
      if (graphEl) {
        ensureGraphClickBinding(graphEl);
        if (graphEl.classList) graphEl.classList.toggle('tr-cp-graph-interactive', toggleAvailable || isOverview);
        if (!activeZoomedSvg) {
          if (currentOverlayMeta && (currentOverlayMeta.kind === 'overview' || S.graph_roadmap)) {
            const orig = svgOriginals.get(svgForGraph);
            const vb = (orig && orig.vb) || parseViewBox(svgForGraph.getAttribute('viewBox')) || { x: 0, y: 0, w: 1, h: 1 };
            updateGraphOverlaysFor(graphEl, vb, vb);
          } else {
            clearGraphOverlays(graphEl);
          }
        }
      }
    }

    if (!isPreview && toggleAvailable) {
      els.zoomBtn.style.display = '';
      const isZoomedOut = zoomManualFull || isOverview;
      const modeKey = isZoomedOut ? 'full' : 'zoom';
      if (els.zoomBtn.dataset.mode !== modeKey) {
        els.zoomBtn.dataset.mode = modeKey;
        els.zoomBtn.classList.toggle('full', isZoomedOut);
        els.zoomBtn.innerHTML = isZoomedOut ? ZOOM_IN_SVG : ZOOM_OUT_SVG;
        const tip = isZoomedOut ? 'Zoom back in on climb' : 'Zoom out to full route';
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
        els.drawer.style.display = 'none';
        setCalloutPill(els, null);
        els.compactRow.style.display = 'flex';
        els.badge.className = 'tr-cp-badge flat';
        els.badge.textContent = 'CLIMBPRO';
        if (view.mode === 'approach') {
          const c = view.climb;
          const catLabel = c.cat ? c.cat.label : 'CLIMB';
          els.title.textContent = `Next ${catLabel} #${c.index}/${c.totalClimbs}`;
          els.compactRow.innerHTML = `<span>In <strong>${fmtDist(view.distToStart)}</strong></span><span>${fmtDistShort(c.lengthM)} \u00b7 +${fmtElev(c.ascentM)} \u00b7 ${c.avgGrade.toFixed(1)}%</span>`;
        } else if (totalClimbs) {
          els.title.textContent = 'Climbs Done';
          els.compactRow.textContent = `All ${totalClimbs} climb(s) completed`;
        } else {
          const desc = describeNoClimbRoute(view.route);
          els.title.textContent = desc.title;
          els.compactRow.textContent = desc.detail;
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
      els.badge.className = 'tr-cp-badge flat';
      els.badge.textContent = 'CLIMBPRO';
      els.title.textContent = totalClimbs ? 'All Climbs Completed' : describeNoClimbRoute(view.route).expandedTitle;
      els.kpis.style.display = 'none';
      setCalloutPill(els, null);
      renderDrawerList(els, view.allItems || [], null);
      return;
    }

    els.kpis.style.display = '';
    const cat = showClimb.cat || { label: 'CLIMB', cls: '' };

    if (inspected && inspected.climb !== view.activeClimb) {
      els.badge.className = `tr-cp-badge ${cat.cls || 'approach'}`;
      els.badge.textContent = `${cat.label} ${showClimb.index}/${showClimb.totalClimbs}`;
      els.title.textContent = inspected.done ? 'Done' : `In ${fmtDist(inspected.distToStart)}`;
      els.k1l.textContent = inspected.done ? 'len' : 'to start';
      els.k1v.textContent = inspected.done ? fmtDist(showClimb.lengthM) : fmtDist(inspected.distToStart);
      els.k2l.textContent = 'ascent';
      els.k2v.textContent = `+${fmtElev(showClimb.ascentM)}`;
      els.k3l.textContent = 'avg';
      els.k3v.textContent = `${showClimb.avgGrade.toFixed(1)}%`;
      els.k4Wrap.style.display = 'none';
      setCalloutPill(els, null);
    } else if (view.mode === 'summit') {
      els.badge.className = 'tr-cp-badge summit';
      els.badge.textContent = 'SUMMIT \u2713';
      els.title.textContent = `${cat.label} ${showClimb.index}/${showClimb.totalClimbs}`;
      els.k1l.textContent = 'len';
      els.k1v.textContent = fmtDist(showClimb.lengthM);
      els.k2l.textContent = 'gained';
      els.k2v.textContent = `+${fmtElev(showClimb.ascentM)}`;
      els.k3l.textContent = 'avg';
      els.k3v.textContent = `${showClimb.avgGrade.toFixed(1)}%`;
      els.k4Wrap.style.display = 'none';
      setCalloutPill(els, null);
    } else if (view.mode === 'active') {
      const remAvg = view.distLeft > 20
        ? clamp((view.ascentLeft / view.distLeft) * 100, -25, 35)
        : showClimb.avgGrade;
      els.badge.className = `tr-cp-badge ${cat.cls}`;
      els.badge.textContent = `${cat.label} ${showClimb.index}/${showClimb.totalClimbs}`;
      els.title.textContent = `${Math.round(view.progressFrac * 100)}%`;
      els.k1l.textContent = 'left';
      els.k1v.textContent = fmtDist(view.distLeft);
      els.k2l.textContent = 'elev';
      els.k2v.textContent = `+${fmtElev(view.ascentLeft)}`;
      els.k3l.textContent = 'rem';
      els.k3v.textContent = `${remAvg.toFixed(1)}%`;

      const showEta = isPreview || Boolean(S.show_eta);
      const etaSec = view.etaSec !== undefined
        ? view.etaSec
        : estimateSummitEtaSec(view.distLeft, view.ascentLeft, remAvg);
      if (showEta && etaSec !== null && etaSec > 0) {
        els.k4Wrap.style.display = '';
        els.k4l.textContent = 'eta';
        els.k4v.textContent = fmtEta(etaSec);
        if (vamEma && vamEma >= 150) {
          els.k4Wrap.title = `Estimated time to summit (VAM ${Math.round(vamEma)} m/h)`;
        }
      } else {
        els.k4Wrap.style.display = 'none';
      }

      const wantCallout = isPreview || Boolean(S.shift_callout);
      const callout = wantCallout
        ? (view.sampleCallout || computeShiftCallout(showClimb, view.distIntoClimb, view.distLeft, view.curGrade))
        : null;
      setCalloutPill(els, callout);
    } else {
      els.badge.className = 'tr-cp-badge approach';
      els.badge.textContent = `NEXT ${cat.label}`;
      els.title.textContent = `In ${fmtDist(view.distToStart)}`;
      els.k1l.textContent = 'len';
      els.k1v.textContent = fmtDist(showClimb.lengthM);
      els.k2l.textContent = 'elev';
      els.k2v.textContent = `+${fmtElev(showClimb.ascentM)}`;
      els.k3l.textContent = 'avg';
      els.k3v.textContent = `${showClimb.avgGrade.toFixed(1)}%`;
      els.k4Wrap.style.display = 'none';
      setCalloutPill(els, null);
    }

    renderDrawerList(els, view.allItems || [], view.activeClimb);
  }

  function makeSampleView() {
    const lengthM = 9340;
    const climb = {
      index: 1, totalClimbs: 1, startDist: 500, endDist: 500 + lengthM,
      lengthM, ascentM: 761, avgGrade: 8.1, score: 75654,
      cat: classifyClimb(lengthM, 8.1, 75654),
      segments: [],
      cumAscent: new Float64Array([0, 380, 761]),
      landmarks: [],
    };
    return {
      mode: 'active',
      climb,
      activeClimb: climb,
      progressFrac: 0.28,
      distIntoClimb: 2615,
      distLeft: 6725,
      ascentLeft: 548,
      etaSec: 1920,
      curGrade: 7.4,
      draft: { text: '0', pct: 0, color: '' },
      sampleCallout: { kind: 'steep', text: '\u2197 13% in 90m', bg: '#ef4444', darkText: false },
      allItems: [{ climb, distToStart: 0, done: false }],
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
    const cacheKey = `${sensKey}`;
    if (cachedClimbsKey !== cacheKey) {
      cachedClimbs = detectClimbs(route, sensKey);
      cachedClimbsKey = cacheKey;
      overlayBuiltKey = '';
    }

    const { curDist } = findFocalDistance(route, focal, prev);
    const live = sampleRawAtDist(route, curDist);
    const curGrade = readLiveGrade(live.grade);
    const draft = readLiveDraft(focal);

    const tNow = nowMs();
    updatePaceTracker(tNow, focal, curDist, live.y, curGrade);

    let active = null;
    for (const c of cachedClimbs) {
      if (curDist >= c.startDist && curDist <= c.endDist) {
        active = c;
        break;
      }
    }

    if (active) {
      lastActiveClimb = active;
      summitHold = null;
    } else if (lastActiveClimb) {
      const pastTop = curDist - lastActiveClimb.endDist;
      if (pastTop > 0 && pastTop <= 180) {
        summitHold = { climb: lastActiveClimb, untilMs: tNow + 4500 };
      }
      lastActiveClimb = null;
    }
    if (summitHold && (tNow > summitHold.untilMs || curDist < summitHold.climb.endDist || curDist > summitHold.climb.endDist + 250)) {
      summitHold = null;
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
    } else if (summitHold) {
      renderView(ui, {
        mode: 'summit',
        route,
        curDist,
        climb: summitHold.climb,
        activeClimb: null,
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
    currentOverlayMeta = null;
    restoreElevationSvg(true);
    clearGraphOverlays();
    if (hiddenGaugesRow) {
      try { hiddenGaugesRow.classList.remove('tr-cp-hide-gauges'); } catch {}
      hiddenGaugesRow = null;
    }
    if (dockedPanel) {
      try { dockedPanel.classList.remove('tr-cp-profile-host'); } catch {}
      dockedPanel = null;
    }
    if (ui.root.parentNode) ui.root.remove();
  });

  terra.log('terra-climb (Terra ClimbPro v0.2.2) ready');
})();
