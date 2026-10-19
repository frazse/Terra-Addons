// ===== Biketerra Universal Logger =====
// Ported from the Tampermonkey userscript (v8.15.2: FTMS/BC logger + social follow).
// What changed: credentials and zones are Terra addon settings (cog menu > Settings) instead of constants,
// network calls go through terra.http, files are saved by terra.files, the rowing machine is paired through
// Terra's chooser (and remembered), and everything is cleaned up when the addon is switched off.
// The graphs, FIT encoder and follow logic are unchanged.

const DEBUG = false;
const dlog = (...a) => { if (DEBUG) terra.log(...a); };

// Zones: fallbacks from the settings, overwritten by Intervals.icu when it answers
let ROWING_FTP   = 293;
let CYCLING_FTP  = 311;
let THRESHOLD_HR = 173;
let MAX_HR       = 190;
let intervalsId = '';
let stravaClientId = '';

const FTMS_SERVICE     = '00001826-0000-1000-8000-00805f9b34fb';
const ROWING_DATA_CHAR = '00002ad1-0000-1000-8000-00805f9b34fb';

let sportMode = 'ROW'; // restored from storage at the bottom
let targetGameSpeed = 0; let simulatedCycles = 0;
let bikeChannel = null; let lastLapCount = 0; let lapStartIdx = 0;
let lapList = []; let recording = false; let recordStart = null;
let recordTicks = []; let tickInterval = null;

let device = null;
let minimised = false; let routeName = null; let routeLength = null;
let navTimer = null, routeTimer = null, dragMove = null, dragUp = null;

// --- SOCIAL FOLLOW STATE ---
let followModeActive = false;
let targetRiderId = null;
let targetRiderName = "None";
let lastRiderList = [];
let powerGate = 100;

const live = {
  cadence: 0, strokes: 0, cycles: 0, dist: 0,
  watts: 0, hr: 0, lat: null, lng: null, alt: null,
  routePct: null, hasData: false, speed: 0,
  avgCadence: 0, avgWatts: 0, avgHr: 0, avgSpeed: 0, heartRateAvg: 0
};

// Graphing & Session Max State
const GRAPH_MAX_PTS = 120; // 2 minutes of history
const graphData = { watts: [], hr: [], speed: [], cadence: [], split: [], alt: [] };
let uiTickInterval = null;
let sessionMaxWatts = 0;
let sessionMaxHr = 0;
let sessionMaxSpeed = 0;
let sessionMaxCadence = 0;
let sessionMinSplit = 9999;
let sessionMaxAlt = -9999;
let sessionMinAlt = 9999;

// --- helpers for the Terra APIs ---
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const errText = (e) => String((e && e.message) || e);

async function loadSettings() {
  const s = await terra.settings.all();
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  ROWING_FTP = n(s.rowing_ftp, 293);
  CYCLING_FTP = n(s.cycling_ftp, 311);
  THRESHOLD_HR = n(s.threshold_hr, 173);
  MAX_HR = n(s.max_hr, 190);
  intervalsId = String(s.intervals_id || '').trim();
  stravaClientId = String(s.strava_client_id || '').trim();
}

// --- 2. DYNAMIC UI ---
function buildOverlay() {
  const el = document.createElement('div'); el.id = 'universal-overlay';

  const connBtnHTML = sportMode === 'ROW' ? '<button class="uni-btn" id="uni-btn-connect">Connect</button>' : '';
  const followBtnHTML = sportMode === 'ROW' ? '<button class="uni-btn" id="uni-btn-follow" style="margin-right:4px;">Follow: OFF</button>' : '';
  const readOnlyTag = sportMode === 'BIKE' ? '<span id="bike-read-only-tag">(Read-Only)</span>' : '';

  const distUnit = sportMode === 'ROW' ? 'm' : 'km';
  const countLabel = sportMode === 'ROW' ? 'STROKES' : 'CYCLES';
  const cadUnit = sportMode === 'ROW' ? 'spm' : 'rpm';
  const speedUnit = sportMode === 'ROW' ? 'm/s' : 'km/h';

  const g5Html = sportMode === 'ROW' ? `
      <div class="garmin-box">
        <canvas id="cvs-split" class="garmin-canvas" width="248" height="56"></canvas>
        <div class="garmin-overlay">
          <div class="garmin-left">
            <svg class="garmin-icon" viewBox="0 0 24 24" fill="none" stroke="#06B6D4" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <div class="garmin-current" id="gv-split-cur">--:--</div><span class="garmin-unit">/500m</span>
          </div>
          <div class="garmin-right">
            <div class="garmin-stat">AVG <span id="gv-split-avg">--:--</span></div>
            <div class="garmin-stat">BEST <span id="gv-split-max">--:--</span></div>
          </div>
        </div>
      </div>
  ` : `
      <div class="garmin-box">
        <canvas id="cvs-alt" class="garmin-canvas" width="248" height="56"></canvas>
        <div class="garmin-overlay">
          <div class="garmin-left">
            <svg class="garmin-icon" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2.5"><polyline points="3 17 9 11 13 15 21 7"/></svg>
            <div class="garmin-current" id="gv-alt-cur">--</div><span class="garmin-unit">m</span>
          </div>
          <div class="garmin-right">
            <div class="garmin-stat">MIN <span id="gv-alt-min">--</span></div>
            <div class="garmin-stat">MAX <span id="gv-alt-max">--</span></div>
          </div>
        </div>
      </div>
  `;

  el.innerHTML = `
    <div id="uni-header">
      <div id="uni-title-row">Biketerra Master Logger ${readOnlyTag}</div>
      <div id="uni-mode-row">
          <div id="uni-status"><div id="uni-dot"></div><span id="uni-status-text">WAITING...</span></div>
          <div id="uni-sport-toggle">SPORT: <span class="sport-opt" id="toggle-row">ROW 🚣</span> | <span class="sport-opt" id="toggle-bike">BIKE 🚴</span></div>
      </div>
    </div>
    <div id="uni-route-status">No route loaded</div>

    <div id="uni-body">
      <div class="uni-cell"><div class="uni-label">DISTANCE</div><div class="uni-value" id="uv-dist">--</div><div class="uni-unit">${distUnit}</div></div>

      <div class="uni-cell">
        <div class="uni-label">ROUTE</div>
        <div class="uni-value"><span id="uv-pct">--</span><span style="font-size:12px; margin-left:1px; color:rgba(255,255,255,0.4);">%</span></div>
        <div class="uni-unit" id="uv-gps" style="margin-top:2px; font-variant-numeric: tabular-nums;">--</div>
      </div>

      <div class="uni-cell"><div class="uni-label">LAPS</div><div class="uni-value" id="uv-laps">0</div><div class="uni-unit">count</div></div>
      <div class="uni-cell"><div class="uni-label">${countLabel}</div><div class="uni-value" id="uv-count">0</div><div class="uni-unit">total</div></div>
    </div>

    <div id="uni-graphs">

      <div class="garmin-box">
        <canvas id="cvs-watts" class="garmin-canvas" width="248" height="56"></canvas>
        <div class="garmin-overlay">
          <div class="garmin-left">
            <svg class="garmin-icon" viewBox="0 0 24 24" fill="none" stroke="#A855F7" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            <div class="garmin-current" id="gv-watts-cur">--</div><span class="garmin-unit">W</span>
          </div>
          <div class="garmin-right">
            <div class="garmin-stat">AVG <span id="gv-watts-avg">--</span></div>
            <div class="garmin-stat">MAX <span id="gv-watts-max">--</span></div>
          </div>
        </div>
      </div>

      <div class="garmin-box">
        <canvas id="cvs-hr" class="garmin-canvas" width="248" height="56"></canvas>
        <div class="garmin-overlay">
          <div class="garmin-left">
            <svg class="garmin-icon" viewBox="0 0 24 24" fill="#EF4444"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <div class="garmin-current" id="gv-hr-cur">--</div><span class="garmin-unit">bpm</span>
          </div>
          <div class="garmin-right">
            <div class="garmin-stat">AVG <span id="gv-hr-avg">--</span></div>
            <div class="garmin-stat">MAX <span id="gv-hr-max">--</span></div>
          </div>
        </div>
      </div>

      <div class="garmin-box">
        <canvas id="cvs-speed" class="garmin-canvas" width="248" height="56"></canvas>
        <div class="garmin-overlay">
          <div class="garmin-left">
            <svg class="garmin-icon" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 17.5a10 10 0 1 1 20 0"/>
              <path d="M12 17.5L15 10"/>
              <circle cx="12" cy="17.5" r="1" fill="#3B82F6"/>
            </svg>
            <div class="garmin-current" id="gv-speed-cur">--</div><span class="garmin-unit">${speedUnit}</span>
          </div>
          <div class="garmin-right">
            <div class="garmin-stat">AVG <span id="gv-speed-avg">--</span></div>
            <div class="garmin-stat">MAX <span id="gv-speed-max">--</span></div>
          </div>
        </div>
      </div>

      <div class="garmin-box">
        <canvas id="cvs-cadence" class="garmin-canvas" width="248" height="56"></canvas>
        <div class="garmin-overlay">
          <div class="garmin-left">
            <svg class="garmin-icon" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
            <div class="garmin-current" id="gv-cad-cur">--</div><span class="garmin-unit">${cadUnit}</span>
          </div>
          <div class="garmin-right">
            <div class="garmin-stat">AVG <span id="gv-cad-avg">--</span></div>
            <div class="garmin-stat">MAX <span id="gv-cad-max">--</span></div>
          </div>
        </div>
      </div>

      ${g5Html}

    </div>

    <div id="uni-footer">
        <span id="uni-rec-time"></span>
        ${followBtnHTML}
        ${connBtnHTML}
        <button class="uni-btn accent" id="uni-btn-rec" disabled>Record</button>
        <button class="uni-btn" id="uni-btn-settings" title="Credentials and zones (Terra settings)">\u2699</button>
        <button class="uni-btn" id="uni-btn-min">\u2014</button>
    </div>
    <div id="uni-social-row" style="display:none; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 0.5px solid rgba(255,255,255,0.1);">
      <div class="uni-cell" style="display:flex; flex-direction:column; justify-content:center; align-items:center; padding: 4px;">
          <div class="uni-label">POWER GATE</div>
          <div style="display:flex; align-items:center; gap:6px;">
              <button class="uni-btn" id="gate-down" style="padding:1px 6px;">-</button>
              <span id="gate-val" style="font-size:13px; font-weight:600; min-width:35px; text-align:center;">${powerGate}W</span>
              <button class="uni-btn" id="gate-up" style="padding:1px 6px;">+</button>
          </div>
      </div>
      <div class="uni-cell" style="display:flex; flex-direction:column; justify-content:center; align-items:center; cursor:pointer; padding: 4px;" id="uni-cell-target">
          <div class="uni-label">FOLLOW TARGET</div>
          <div id="uni-target-name-display" style="font-size:12px; font-weight:600; color:#5DCAA5; text-align:center;">None</div>
      </div>
    </div>
  `;
  document.body.appendChild(el);

  // --- FOLLOW UI LOGIC ---
  if (sportMode === 'ROW') {
    const followBtn = document.getElementById('uni-btn-follow');
    const socialRow = document.getElementById('uni-social-row');
    const targetCell = document.getElementById('uni-cell-target');
    const targetDisplay = document.getElementById('uni-target-name-display');

    followBtn.onclick = () => {
      followModeActive = !followModeActive;
      followBtn.textContent = `Follow: ${followModeActive ? 'ON' : 'OFF'}`;
      followBtn.classList.toggle('accent', followModeActive);
      socialRow.style.display = followModeActive ? 'grid' : 'none';
    };

    targetCell.onclick = () => {
      if (lastRiderList.length === 0) return;
      const currentIndex = lastRiderList.findIndex(r => r.id === targetRiderId);
      const nextRider = lastRiderList[(currentIndex + 1) % lastRiderList.length];
      targetRiderId = nextRider.id;
      targetRiderName = nextRider.name;
      targetDisplay.textContent = targetRiderName.split(' ')[0];
    };

    document.getElementById('gate-up').onclick = () => {
      powerGate += 10;
      document.getElementById('gate-val').textContent = `${powerGate}W`;
      terra.storage.set('powerGateSetting', powerGate);
    };
    document.getElementById('gate-down').onclick = () => {
      powerGate = Math.max(0, powerGate - 10);
      document.getElementById('gate-val').textContent = `${powerGate}W`;
      terra.storage.set('powerGateSetting', powerGate);
    };
  }

  document.getElementById('uni-btn-rec').addEventListener('click', onRecordClick);
  document.getElementById('uni-btn-min').addEventListener('click', toggleMinimise);
  document.getElementById('uni-btn-settings').addEventListener('click', () => terra.settings.open());
  makeDraggable(el, document.getElementById('uni-header'));

  document.getElementById('toggle-row').addEventListener('click', () => changeSportMode('ROW'));
  document.getElementById('toggle-bike').addEventListener('click', () => changeSportMode('BIKE'));
  document.getElementById(`toggle-${sportMode.toLowerCase()}`).classList.add('active');

  if (sportMode === 'ROW') {
    document.getElementById('uni-btn-connect').addEventListener('click', onConnectClick);
    document.getElementById('uni-status-text').textContent = 'FTMS DISCONNECTED';
    startSpeedSyncLoop();
  } else {
    document.getElementById('uni-status-text').textContent = 'WAITING FOR DATA...';
  }

  startUiTickLoop();
  fetchAthleteZonesFromIntervals();
}

// --- 2.5 API SYNC FUNCTION ---
async function fetchAthleteZonesFromIntervals() {
  if (!intervalsId || !(await terra.settings.has('intervals_api_key'))) { dlog('no Intervals.icu credentials, using fallback zones'); return; }
  try {
    const r = await terra.http.request({
      method: 'GET',
      url: `https://intervals.icu/api/v1/athlete/${encodeURIComponent(intervalsId)}`,
      basic: { user: 'API_KEY', password: '{{setting:intervals_api_key}}' },
    });
    if (r.status >= 200 && r.status < 300) {
      const data = JSON.parse(r.body);
      if (data.ftp) CYCLING_FTP = data.ftp;
      if (data.lthr) THRESHOLD_HR = data.lthr;
      if (data.max_hr) MAX_HR = data.max_hr;

      if (data.sportSettings && Array.isArray(data.sportSettings)) {
        const ride = data.sportSettings.find(s => s.id === 'Ride' || s.id === 'VirtualRide') || data.sportSettings[0];
        const row = data.sportSettings.find(s => s.id === 'Rowing' || s.id === 'VirtualRow') || data.sportSettings[3];
        if (ride && sportMode === 'BIKE') {
          CYCLING_FTP = ride.indoor_ftp || ride.ftp || CYCLING_FTP;
          THRESHOLD_HR = ride.lthr || THRESHOLD_HR;
          MAX_HR = ride.max_hr || MAX_HR;
        }
        if (row && sportMode === 'ROW') {
          ROWING_FTP = row.indoor_ftp || row.ftp || ROWING_FTP;
          THRESHOLD_HR = row.lthr || THRESHOLD_HR;
          MAX_HR = row.max_hr || MAX_HR;
        }
      }
      terra.log('synced Intervals.icu zones');
    } else {
      terra.log(`Intervals.icu zones: HTTP ${r.status} (check the athlete ID and API key in the settings)`);
    }
  } catch (e) { terra.log('Intervals.icu zones: ' + errText(e)); }
}

function changeSportMode(newMode) {
  if (sportMode === newMode) return;
  terra.storage.set('lastSportMode', newMode).then(() => location.reload());
}

function makeDraggable(el, handle) {
  let ox = 0, oy = 0, dragging = false;
  handle.addEventListener('mousedown', e => { if (e.target.classList.contains('sport-opt')) return; dragging = true; const r = el.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; e.preventDefault(); });
  dragMove = e => { if (!dragging) return; el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.left = (e.clientX - ox) + 'px'; el.style.top = (e.clientY - oy) + 'px'; };
  dragUp = () => { dragging = false; };
  document.addEventListener('mousemove', dragMove);
  document.addEventListener('mouseup', dragUp);
}

function setRecordingStatus(rec) {
  const dot = document.getElementById('uni-dot'); const btn = document.getElementById('uni-btn-rec'); const txt = document.getElementById('uni-status-text');
  if (rec) {
    dot.className = 'recording'; txt.textContent = 'RECORDING ACTIVE';
    btn.textContent = 'Stop + Save'; btn.className = 'uni-btn danger';
  } else {
    btn.textContent = 'Record'; btn.className = 'uni-btn accent'; document.getElementById('uni-rec-time').textContent = '';
    if (sportMode === 'ROW') {
      dot.className = (device?.gatt.connected) ? 'connected' : '';
      txt.textContent = (device?.gatt.connected) ? 'FTMS CONNECTED' : 'FTMS DISCONNECTED';
    } else {
      dot.className = 'connected'; txt.textContent = 'BC CONNECTED';
    }
  }
}

function formatSplitSec(s) {
  if (!s || s <= 0 || !isFinite(s) || s > 3600) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// --- 3. GRAPHING ENGINE ---
function startUiTickLoop() {
  if (uiTickInterval) clearInterval(uiTickInterval);
  uiTickInterval = setInterval(() => {
    if (!live.hasData || minimised) return;

    const currentWatts = live.watts || 0;
    const currentHr = live.hr || 0;
    const currentSpeed = live.speed || 0;
    const currentCadence = live.cadence || 0;

    graphData.watts.push(currentWatts);
    graphData.hr.push(currentHr);
    graphData.speed.push(currentSpeed);
    graphData.cadence.push(currentCadence);

    if (currentWatts > sessionMaxWatts) sessionMaxWatts = currentWatts;
    if (currentHr > sessionMaxHr) sessionMaxHr = currentHr;
    if (currentSpeed > sessionMaxSpeed) sessionMaxSpeed = currentSpeed;
    if (currentCadence > sessionMaxCadence) sessionMaxCadence = currentCadence;

    if (graphData.watts.length > GRAPH_MAX_PTS) graphData.watts.shift();
    if (graphData.hr.length > GRAPH_MAX_PTS) graphData.hr.shift();
    if (graphData.speed.length > GRAPH_MAX_PTS) graphData.speed.shift();
    if (graphData.cadence.length > GRAPH_MAX_PTS) graphData.cadence.shift();

    document.getElementById('gv-watts-cur').textContent = Math.round(currentWatts);
    document.getElementById('gv-hr-cur').textContent = Math.round(currentHr);

    const spdMult = sportMode === 'ROW' ? 1 : 3.6;
    document.getElementById('gv-speed-cur').textContent = (currentSpeed * spdMult).toFixed(1);
    document.getElementById('gv-cad-cur').textContent = Math.round(currentCadence);

    document.getElementById('gv-watts-max').textContent = Math.round(sessionMaxWatts);
    document.getElementById('gv-hr-max').textContent = Math.round(sessionMaxHr);
    document.getElementById('gv-speed-max').textContent = (sessionMaxSpeed * spdMult).toFixed(1);
    document.getElementById('gv-cad-max').textContent = Math.round(sessionMaxCadence);

    // --- Compute AVGs from recordTicks for ROW (exclude zeros per metric) ---
    let displayAvgWatts, displayAvgHr, displayAvgSpeed, displayAvgCadence;

    if (sportMode === 'ROW' && recordTicks.length > 0) {
      const wattsArr   = recordTicks.map(t => t.power).filter(v => v > 0);
      const hrArr      = recordTicks.map(t => t.hr).filter(v => v > 0);
      const speedArr   = recordTicks.map(t => t.speed).filter(v => v > 0);
      const cadenceArr = recordTicks.map(t => t.cadence).filter(v => v > 0);

      displayAvgWatts   = wattsArr.length   ? wattsArr.reduce((a, b) => a + b, 0)   / wattsArr.length   : 0;
      displayAvgHr      = hrArr.length      ? hrArr.reduce((a, b) => a + b, 0)      / hrArr.length      : 0;
      displayAvgSpeed   = speedArr.length   ? speedArr.reduce((a, b) => a + b, 0)   / speedArr.length   : 0;
      displayAvgCadence = cadenceArr.length ? cadenceArr.reduce((a, b) => a + b, 0) / cadenceArr.length : 0;
    } else {
      // BIKE mode: averages come from the BroadcastChannel live object
      displayAvgWatts   = live.avgWatts   || 0;
      displayAvgHr      = live.heartRateAvg || live.avgHr || 0;
      displayAvgSpeed   = live.avgSpeed   || 0;
      displayAvgCadence = live.avgCadence || 0;
    }

    document.getElementById('gv-watts-avg').textContent  = Math.round(displayAvgWatts);
    document.getElementById('gv-hr-avg').textContent     = Math.round(displayAvgHr);
    document.getElementById('gv-speed-avg').textContent  = (displayAvgSpeed * spdMult).toFixed(1);
    document.getElementById('gv-cad-avg').textContent    = Math.round(displayAvgCadence);

    if (sportMode === 'ROW') {
      const currentSplitSec = live.speed > 0 ? 500 / live.speed : 0;
      graphData.split.push(currentSplitSec);
      if (currentSplitSec > 0 && currentSplitSec < sessionMinSplit) sessionMinSplit = currentSplitSec;
      if (graphData.split.length > GRAPH_MAX_PTS) graphData.split.shift();

      document.getElementById('gv-split-cur').textContent = formatSplitSec(currentSplitSec);
      document.getElementById('gv-split-avg').textContent = formatSplitSec(displayAvgSpeed > 0 ? 500 / displayAvgSpeed : 0);
      document.getElementById('gv-split-max').textContent = sessionMinSplit === 9999 ? '--:--' : formatSplitSec(sessionMinSplit);

      const validSplits = graphData.split.filter(s => s > 0 && s < 3600);
      const maxSplitScale = validSplits.length ? Math.max(150, ...validSplits) : 150;
      const minSplitScale = validSplits.length ? Math.min(90, ...validSplits) : 90;
      drawGraph('cvs-split', graphData.split, minSplitScale - 10, maxSplitScale + 10, 'split');

    } else {
      const currentAlt = live.alt !== null ? live.alt : 0;
      if (live.alt !== null) {
        graphData.alt.push(currentAlt);
        if (currentAlt > sessionMaxAlt) sessionMaxAlt = currentAlt;
        if (currentAlt < sessionMinAlt) sessionMinAlt = currentAlt;
        if (graphData.alt.length > GRAPH_MAX_PTS) graphData.alt.shift();
      }

      document.getElementById('gv-alt-cur').textContent = Math.round(currentAlt);
      document.getElementById('gv-alt-min').textContent = sessionMinAlt === 9999 ? '--' : Math.round(sessionMinAlt);
      document.getElementById('gv-alt-max').textContent = sessionMaxAlt === -9999 ? '--' : Math.round(sessionMaxAlt);

      const validAlts = graphData.alt;
      let maxAltScale = 10;
      let minAltScale = 0;
      if (validAlts.length > 0) {
        const cMax = Math.max(...validAlts);
        const cMin = Math.min(...validAlts);
        const spread = cMax - cMin;
        if (spread < 20) {
          const mid = (cMax + cMin) / 2;
          maxAltScale = mid + 10;
          minAltScale = mid - 10;
        } else {
          maxAltScale = cMax + (spread * 0.1);
          minAltScale = cMin - (spread * 0.1);
        }
      }
      drawGraph('cvs-alt', graphData.alt, minAltScale, maxAltScale, 'alt');
    }

    const ftp = sportMode === 'ROW' ? ROWING_FTP : CYCLING_FTP;
    const powerGraphMax = Math.max(ftp * 1.5, ...graphData.watts);
    drawGraph('cvs-watts', graphData.watts, 0, powerGraphMax, 'power', ftp);

    const hrGraphMax = Math.max(MAX_HR, ...graphData.hr);
    const minHrScale = Math.min(60, ...graphData.hr.filter(h => h > 0));
    drawGraph('cvs-hr', graphData.hr, minHrScale - 5, hrGraphMax + 5, 'hr');

    const maxSpeedScale = Math.max(sportMode === 'ROW' ? 5 : 12, ...graphData.speed);
    drawGraph('cvs-speed', graphData.speed, 0, maxSpeedScale, 'speed');

    const maxCadScale = Math.max(sportMode === 'ROW' ? 40 : 120, ...graphData.cadence);
    drawGraph('cvs-cadence', graphData.cadence, 0, maxCadScale, 'cadence');

  }, 1000);
}

function drawGraph(canvasId, data, minScale, maxScale, type, activeFTP = null) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;

  const range = maxScale - minScale || 1;
  const step = w / (GRAPH_MAX_PTS - 1);

  if (type === 'hr' || type === 'power') {
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      const x = w - ((data.length - 1 - i) * step);
      const boundedVal = Math.max(minScale, Math.min(maxScale, val));
      const y = h - (((boundedVal - minScale) / range) * h);
      ctx.fillStyle = getZoneColor(val, type, activeFTP);
      ctx.fillRect(x, y, Math.max(1.5, step), h - y);
    }
  } else {
    let grad = ctx.createLinearGradient(0, h, 0, 0);
    if (type === 'speed') { grad.addColorStop(0, 'rgba(100, 100, 100, 0.5)'); grad.addColorStop(1, 'rgba(96, 165, 250, 0.9)'); }
    else if (type === 'cadence') { grad.addColorStop(0, 'rgba(100, 100, 100, 0.5)'); grad.addColorStop(1, 'rgba(251, 191, 36, 0.9)'); }
    else if (type === 'split') { grad.addColorStop(0, 'rgba(100, 100, 100, 0.5)'); grad.addColorStop(1, 'rgba(34, 211, 238, 0.9)'); }
    else if (type === 'alt') { grad.addColorStop(0, 'rgba(100, 100, 100, 0.5)'); grad.addColorStop(1, 'rgba(52, 211, 153, 0.9)'); }
    ctx.beginPath();
    ctx.moveTo(w - ((data.length - 1) * step), h);
    for (let i = 0; i < data.length; i++) {
      const x = w - ((data.length - 1 - i) * step);
      let val = data[i];
      let y;
      if (type === 'split') {
        if (val <= 0 || val > 3600) { y = h; }
        else {
          let boundedVal = Math.max(minScale, Math.min(maxScale, val));
          y = ((boundedVal - minScale) / range) * h;
        }
      } else {
        let boundedVal = Math.max(minScale, Math.min(maxScale, val));
        y = h - (((boundedVal - minScale) / range) * h);
      }
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = w - ((data.length - 1 - i) * step);
    let val = data[i];
    let y;
    if (type === 'split') {
      if (val <= 0 || val > 3600) { y = h; }
      else {
        let boundedVal = Math.max(minScale, Math.min(maxScale, val));
        y = ((boundedVal - minScale) / range) * h;
      }
    } else {
      let boundedVal = Math.max(minScale, Math.min(maxScale, val));
      y = h - (((boundedVal - minScale) / range) * h);
    }
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.stroke();
}

function getZoneColor(val, type, activeFTP) {
  if (type === 'hr') {
    if (val >= THRESHOLD_HR * 1.06) return '#504861';
    if (val >= THRESHOLD_HR * 1.03) return '#6633CC';
    if (val >= THRESHOLD_HR * 1.00) return '#DD0447';
    if (val >= THRESHOLD_HR * 0.94) return '#FF7F0E';
    if (val >= THRESHOLD_HR * 0.90) return '#FFCB0E';
    if (val >= THRESHOLD_HR * 0.81) return '#009E00';
    return '#009E80';
  } else {
    if (val >= activeFTP * 1.51) return '#504861';
    if (val >= activeFTP * 1.21) return '#6633CC';
    if (val >= activeFTP * 1.06) return '#DD0447';
    if (val >= activeFTP * 0.91) return '#FF7F0E';
    if (val >= activeFTP * 0.76) return '#FFCB0E';
    if (val >= activeFTP * 0.56) return '#009E00';
    return '#009E80';
  }
}

function formatDistUni(d) { return sportMode === 'BIKE' ? (d/1000).toFixed(2) : Math.round(d); }

function updateDisplay() {
  document.getElementById('uv-dist').textContent = formatDistUni(live.dist);
  document.getElementById('uv-pct').textContent = live.routePct !== null ? live.routePct.toFixed(1) : '--';
  document.getElementById('uv-gps').textContent = live.lat !== null ? `${live.lat.toFixed(4)}, ${live.lng.toFixed(4)}` : '--';
  document.getElementById('uv-laps').textContent = lapList.length;
  document.getElementById('uv-count').textContent = sportMode === 'ROW' ? (live.strokes || 0) : (live.cycles || 0);
}

// --- 4. FTMS ROWING SPECIFIC ---
function setFtmsConnectionStatus(connected) {
  if (sportMode !== 'ROW') return;
  document.getElementById('uni-dot').classList.toggle('connected', connected);
  document.getElementById('uni-status-text').textContent = connected ? 'FTMS CONNECTED' : 'FTMS DISCONNECTED';
  document.getElementById('uni-btn-connect').textContent  = connected ? 'Disconnect' : 'Connect';
  if (!recording) document.getElementById('uni-btn-rec').disabled = !connected;
}
async function onConnectClick() { if (device && device.gatt.connected) disconnect(); else await connectFtmsBluetooth(); }
async function connectFtmsBluetooth() {
  if (!navigator.bluetooth) { alert('Web Bluetooth is not available.'); return; }
  try {
    // The rowing machine is paired through Terra's chooser once, then remembered for this addon.
    device = (await terra.ble.remembered())[0] || await terra.ble.request({ filters: [{ services: [FTMS_SERVICE] }] });
    device.addEventListener('gattserverdisconnected', onFtmsDisconnected);
    const server = await device.gatt.connect();
    const charRow = await (await server.getPrimaryService(FTMS_SERVICE)).getCharacteristic(ROWING_DATA_CHAR);
    charRow.addEventListener('characteristicvaluechanged', onFtmsRowingData);
    await charRow.startNotifications();
    setFtmsConnectionStatus(true);
  } catch (err) { console.error('FTMS error:', err); terra.log('FTMS error: ' + errText(err)); setFtmsConnectionStatus(false); }
}
function disconnect() { if (device?.gatt.connected) device.gatt.disconnect(); device = null; setFtmsConnectionStatus(false); if (recording) stopRecording(); }
function onFtmsDisconnected() { setFtmsConnectionStatus(false); if (recording) stopRecording(); }

function onFtmsRowingData(event) {
  if (sportMode !== 'ROW') return;
  const data = event.target.value; if (data.byteLength < 5) return; live.hasData = true;
  const flags = data.getUint16(0, true); let o = 2;
  live.cadence = data.getUint8(o) / 2; o += 1; live.strokes = data.getUint16(o, true); o += 2;
  if (flags & 0x0004) { live.dist = data.getUint8(o) | (data.getUint8(o+1) << 8) | (data.getUint8(o+2) << 16); o += 3; }
  if (flags & 0x0008) { live.split = data.getUint16(o, true); o += 2; }
  if (flags & 0x0010) { o += 2; }
  if (flags & 0x0020) { live.watts = data.getInt16(o, true); o += 2; }
  live.speed = (live.split && live.split > 0) ? 500 / live.split : 0;

  // Only sync game speed from live data when not in active follow mode
  if (!followModeActive || !targetRiderId || !recording) {
    targetGameSpeed = live.speed;
  }
  updateDisplay();
}

// --- 5. BIKE SPECIFIC ---
function simulateCyclingMetrics() { if (recording) { simulatedCycles += (live.cadence / 60); live.cycles = Math.floor(simulatedCycles); } }
function closeBikeChannel() { if (bikeChannel) { bikeChannel.close(); bikeChannel = null; } }
async function loadRouteDataOnNav() { closeBikeChannel(); routeTimer = setTimeout(loadRouteFromPage, 500); }

async function loadRouteFromPage() {
  const url = new URL(location.href);
  if (!bikeChannel) { try { bikeChannel = new BroadcastChannel('biketerra-ride'); bikeChannel.onmessage = onBikeMessage; } catch (e) { console.warn('BroadcastChannel failed:', e); } }
  if (url.pathname.startsWith('/spectate')) { if (!minimised) toggleMinimise(); setRouteStatus('Spectating — overlay minimised'); return; }
  const eventId = url.searchParams.get('event');
  if (eventId) {
    setRouteStatus(`Loading event ${eventId}…`);
    try {
      const res = await fetch(`${url.origin}/events/${eventId}`, { credentials: 'include' });
      if (res.ok) {
        const html = await res.text(); const matches = [...html.matchAll(/<title>([^<]+?)\s*-\s*Biketerra<\/title>/gi)];
        const validTitles = matches.map(m => m[1].trim()).filter(t => t !== 'Ride virtually, anywhere');
        routeName = validTitles.length > 0 ? validTitles[validTitles.length - 1] : `Event ${eventId}`;
      }
    } catch (_) { routeName = `Event ${eventId}`; }
    setRouteStatus(`Event: ${routeName} | waiting for GPS…`); return;
  }
  const routeId = url.searchParams.get('route');
  if (routeId && url.pathname.includes('/ride')) { const title = document.title || ''; const match = title.match(/^Ride - (.+?) - Biketerra$/); routeName = match ? match[1] : null; setRouteStatus(routeName ? `Route: ${routeName} | waiting for GPS…` : 'Waiting for ride…'); return; }
  setRouteStatus('Navigate to a ride or event');
}

function onBikeMessage(event) {
  let data = event?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (_) {}
  }
  console.log('[biketerra-logger] Received BroadcastChannel packet:', data);
  const ego = data?.ego; if (!ego) return;
  const riders = data?.riders || [];
  lastRiderList = riders;

  if (ego.lat != null) live.lat = ego.lat; if (ego.lng != null) live.lng = ego.lng;
  if (ego.elevation != null) live.alt = ego.elevation;
  if (ego.heartRate != null && ego.heartRate > 0) live.hr = ego.heartRate;
  if (ego.heartRateAvg != null && ego.heartRateAvg > 0) live.heartRateAvg = ego.heartRateAvg;

  if (ego.lapCount != null && ego.lapCount !== lastLapCount && recording) {
    lapList.push({ startIdx: lapStartIdx, endIdx: recordTicks.length, startTime: lapStartIdx === 0 ? recordStart : recordTicks[lapStartIdx].timestamp, endTime: new Date(), lapNum: lastLapCount + 1, });
    lapStartIdx = recordTicks.length; lastLapCount = ego.lapCount;
  }
  if (sportMode === 'BIKE') {
    live.hasData = true; document.getElementById('uni-btn-rec').disabled = false;
    document.getElementById('uni-dot').className = 'connected'; document.getElementById('uni-status-text').textContent = 'BC DATA ACTIVE';
    live.cadence = ego.cadence || 0; live.avgCadence = ego.cadenceAvg || 0;
    live.watts = ego.power || 0; live.avgWatts = ego.powerAvg || 0;
    live.speed = ego.speed || 0; live.avgSpeed = ego.speedAvg || 0; live.dist = ego.distance || 0;
    targetGameSpeed = live.speed;
  }

  if (sportMode === 'ROW' && followModeActive && targetRiderId && recording) {
    // Only follow while you are above the power gate; otherwise use your own speed
    const shouldFollow = live.watts >= powerGate;
    dlog('follow', { watts: live.watts, powerGate, shouldFollow, targetGameSpeed });
    if (shouldFollow) {
      const tr = riders.find(r => r.id === targetRiderId);
      if (tr && tr.speed !== undefined && tr.gap !== undefined) {
        const gap = Math.max(0, Math.min(10, tr.gap)); // keep the gap reasonable (0-10 m)
        targetGameSpeed = Math.max(0, tr.speed + ((gap - 3.0) * 0.15));
        document.getElementById('uni-status-text').style.opacity = "1";
      } else {
        targetGameSpeed = live.speed; // target data invalid: fall back to your own speed
      }
    } else {
      targetGameSpeed = live.speed;
    }
  } else {
    targetGameSpeed = live.speed;
  }
  if (ego.distance != null && ego.distanceRemaining != null) {
    const currentLapIndex = ego.lapCount || 0; const totalAccDistance = ego.distance + ego.distanceRemaining;
    if (totalAccDistance > 0) {
      const singleLapLength = totalAccDistance / (currentLapIndex + 1); const currentLapDistance = ego.distance - (currentLapIndex * singleLapLength);
      routeLength = singleLapLength; live.routePct = Math.min(100, Math.max(0, (currentLapDistance / singleLapLength) * 100));
    }
  }
  const nameStr = routeName ? routeName : 'route'; const distForRoute = sportMode === 'ROW' ? routeLength : (routeLength/1000);
  const unitForRoute = sportMode === 'ROW' ? 'm' : 'km'; const distStr = distForRoute ? ` ${distForRoute.toFixed( sportMode === 'ROW' ? 0 : 2)}${unitForRoute}` : '';
  const pctStr = live.routePct != null ? ` ${live.routePct.toFixed(1)}%` : '';
  setRouteStatus(`${nameStr}${distStr}${pctStr}`);

  updateDisplay();
}

function updateGameBreakpointStatus() {
  const el = document.getElementById('uni-route-status'); if (!el || sportMode !== 'ROW') return;
  const base = el.textContent.split(' | ')[0]; const gm = window.gameManager; const isEngineRunning = !!(gm?.ego?.entity?.state);
  const suffix = isEngineRunning ? ` | game speed sync: ACTIVE` : ` | game speed sync: BP MISSING`; el.textContent = base + suffix;
}

function setRouteStatus(msg) { const el = document.getElementById('uni-route-status'); if (el) el.textContent = msg; }
function toggleMinimise() { minimised = !minimised; document.getElementById('universal-overlay').classList.toggle('minimised', minimised); document.getElementById('uni-btn-min').textContent = minimised ? '+' : '\u2014'; }

// --- 6. RECORDING ---
function onRecordClick() { if (recording) stopRecording(); else startRecording(); }
function startRecording() {
  recording = true; recordStart = new Date(); recordTicks = [];
  lastLapCount = 0; lapStartIdx = 0; lapList = []; simulatedCycles = 0;
  setRecordingStatus(true);
  tickInterval = setInterval(() => {
    if (sportMode === 'BIKE') simulateCyclingMetrics();
    const count = sportMode === 'ROW' ? (live.strokes || 0) : (live.cycles || 0);
    recordTicks.push({ timestamp: new Date(), lat: live.lat, lng: live.lng, alt: live.alt, hr: live.hr || 0, power: Math.round(live.watts || 0), cadence: Math.round(live.cadence || 0), dist: live.dist || 0, speed: live.speed || 0, count: count });
    const elapsed = Math.floor((Date.now() - recordStart) / 1000);
    document.getElementById('uni-rec-time').textContent = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
    if (sportMode === 'ROW') updateGameBreakpointStatus();
  }, 1000);
}

async function stopRecording() {
  if (!recording) return;
  clearInterval(tickInterval); tickInterval = null; recording = false; setRecordingStatus(false);
  let fitBuffer = null, savedPath = null;
  try { if (recordTicks.length > 0) { fitBuffer = encodeFIT(recordTicks, recordStart); savedPath = await downloadFIT(fitBuffer, recordStart); } } catch (e) { console.error("FIT error:", e); terra.log('FIT error: ' + errText(e)); }
  try { showSummaryModal(fitBuffer, savedPath); } catch (e) { console.error("Modal error:", e); }
}

// Saved by Terra into ~/Downloads/Terra (the webview cannot do <a download>); falls back to a browser download.
async function downloadFIT(buf, startTime) {
  const sportPrefix = sportMode === 'ROW' ? 'rowing' : 'cycling';
  const name = `${sportPrefix}_${startTime.toISOString().replace(/[:.]/g, '-')}.fit`;
  try {
    const path = await terra.files.save(name, buf);
    terra.log('saved ' + path);
    return path;
  } catch (e) {
    terra.log('could not save the FIT file (' + errText(e) + '), trying a browser download');
    const url = URL.createObjectURL(new Blob([buf])); const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    return null;
  }
}

// --- 7. MODAL ---
function showSummaryModal(fitBuffer, savedPath) {
  let bg = document.getElementById('uni-summary-bg');
  if (!bg) { bg = document.createElement('div'); bg.id = 'uni-summary-bg'; bg.style.cssText = "position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.8); backdrop-filter: blur(8px); z-index: 9999999; display: none; align-items: center; justify-content: center; overflow-y: auto; padding: 20px;"; document.body.appendChild(bg); }
  const n = recordTicks.length || 1; const elapsedS = Math.floor((Date.now() - recordStart) / 1000);
  const mm = String(Math.floor(elapsedS / 60)).padStart(2, '0'); const ss = String(elapsedS % 60).padStart(2, '0');
  const totalDistRaw = recordTicks.length ? recordTicks[n-1].dist : 0; const distStr = sportMode === 'ROW' ? `${Math.round(totalDistRaw)} m` : `${(totalDistRaw/1000).toFixed(2)} km`;

  // exclude zeros from all averages in the summary
  const wattsArr   = recordTicks.map(t => t.power).filter(v => v > 0);
  const cadArr     = recordTicks.map(t => t.cadence).filter(v => v > 0);
  const speedArr   = recordTicks.map(t => t.speed).filter(v => v > 0);
  const hrArr      = recordTicks.map(t => t.hr).filter(v => v > 0);

  const avgWatts   = wattsArr.length   ? Math.round(wattsArr.reduce((a, b) => a + b, 0)   / wattsArr.length)   : 0;
  const avgCadence = cadArr.length     ? Math.round(cadArr.reduce((a, b) => a + b, 0)     / cadArr.length)     : 0;
  const avgSpeed   = speedArr.length   ? speedArr.reduce((a, b) => a + b, 0) / speedArr.length                 : 0;
  const avgHr      = hrArr.length      ? Math.round(hrArr.reduce((a, b) => a + b, 0)      / hrArr.length)      : 0;

  let speedRowStr = ""; if (sportMode === 'ROW') { const split = avgSpeed > 0 ? 500/avgSpeed : 0; speedRowStr = `${Math.floor(split/60)}:${String(Math.floor(split%60)).padStart(2, '0')} <span style="font-size:11px;color:#888;">/500m avg</span>`; } else { speedRowStr = `${(avgSpeed * 3.6).toFixed(1)} <span style="font-size:11px;color:#888;">km/h avg</span>`; }
  const startCount = recordTicks[0].count; const endCount = recordTicks[n-1].count; let totalCount = endCount - startCount; const countLabel = sportMode === 'ROW' ? 'Strokes' : 'Cycles';
  const mapHTML = generateMapSvgHTML();
  const savedHTML = savedPath ? `<div style="font-size:10px;color:#888;text-align:center;margin:-8px 0 12px;word-break:break-all;">Saved: ${savedPath}</div>` : '';
  const dualStat = (lbl, val, unt) => `<div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;"><div style="font-size: 10px; color: rgba(255,255,255,0.45); text-transform: uppercase; margin-bottom: 2px;">${lbl}</div><div style="font-size: 20px; font-weight: 600;">${val} <span style="font-size:11px;color:#888;">${unt}</span></div></div>`;
  bg.innerHTML = `<div id="uni-summary-box" style="background: #1A1A1A; border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 24px; width: 400px; max-width: 90vw; font-family: -apple-system, sans-serif; color: #fff; box-shadow: 0 20px 40px rgba(0,0,0,0.8);"><div style="font-size: 11px; color: #aaa; text-align: center; margin-bottom: 2px;">${sportMode} WORKOUT</div><div id="sum-title" style="font-size: 18px; font-weight: 600; margin-bottom: 16px; color: #5DCAA5; text-align: center;">${routeName || 'Workout Complete'}</div>${savedHTML}${mapHTML}<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;"><div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; text-align: center;"><div style="font-size: 11px; color: rgba(255,255,255,0.45); text-transform: uppercase;">Time</div><div style="font-size: 24px; font-weight: 600; margin: 4px 0 2px 0;">${mm}:${ss}</div></div><div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; text-align: center;"><div style="font-size: 11px; color: rgba(255,255,255,0.45); text-transform: uppercase;">Distance</div><div style="font-size: 24px; font-weight: 600; margin: 4px 0 2px 0;">${distStr}</div></div></div><div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px;">${dualStat('Power', avgWatts, 'W avg')}${dualStat('Cadence', avgCadence, sportMode === 'ROW'?'SPM':'RPM')}${dualStat('Heart Rate', avgHr, 'BPM avg')}<div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;"><div style="font-size: 10px; color: rgba(255,255,255,0.45); text-transform: uppercase; margin-bottom: 2px;">Speed</div><div style="font-size: 20px; font-weight: 600;">${speedRowStr}</div></div><div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;"><div style="font-size: 10px; color: rgba(255,255,255,0.45); text-transform: uppercase; margin-bottom: 2px;">${countLabel}</div><div style="font-size: 20px; font-weight: 600;">${Math.round(totalCount)}</div></div><div style="background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px;"><div style="font-size: 10px; color: rgba(255,255,255,0.45); text-transform: uppercase; margin-bottom: 2px;">Laps</div><div style="font-size: 20px; font-weight: 600;">${lapList.length}</div></div></div><div style="display: flex; gap: 8px;"><button id="uni-summary-close" style="flex: 1; padding: 10px; border-radius: 8px; background: rgba(255,255,255,0.1); color: #fff; border: none; font-weight: 600; font-size: 12px; cursor: pointer;">Close</button><button id="uni-summary-upload" style="flex: 1.5; padding: 10px; border-radius: 8px; background: #5DCAA5; color: #000; border: none; font-weight: 600; font-size: 12px; cursor: pointer;">Intervals.icu</button><button id="uni-summary-strava" style="flex: 1.5; padding: 10px; border-radius: 8px; background: rgba(252, 76, 2, 0.2); color: #FC4C02; border: 1px solid #FC4C02; font-weight: 600; font-size: 12px; cursor: pointer;">Strava</button></div></div>`;
  document.getElementById('uni-summary-close').addEventListener('click', () => { bg.style.display = 'none'; });
  const upBtn = document.getElementById('uni-summary-upload'); const newUpBtn = upBtn.cloneNode(true); upBtn.parentNode.replaceChild(newUpBtn, upBtn);
  newUpBtn.addEventListener('click', () => { if (fitBuffer) uploadToIntervals(fitBuffer, recordStart, newUpBtn); });
  const stravaBtn = document.getElementById('uni-summary-strava'); const newStravaBtn = stravaBtn.cloneNode(true); stravaBtn.parentNode.replaceChild(newStravaBtn, stravaBtn);
  newStravaBtn.addEventListener('click', () => { if (fitBuffer) uploadToStrava(fitBuffer, recordStart, newStravaBtn); });
  bg.style.display = 'flex';
}

function generateMapSvgHTML() {
  const gpsTicks = recordTicks.filter(t => t.lat != null && t.lng != null); if (gpsTicks.length < 3) return "";
  const minLat = Math.min(...gpsTicks.map(t => t.lat)), maxLat = Math.max(...gpsTicks.map(t => t.lat)), minLng = Math.min(...gpsTicks.map(t => t.lng)), maxLng = Math.max(...gpsTicks.map(t => t.lng));
  const latRange = (maxLat - minLat) || 0.0001, lngRange = (maxLng - minLng) || 0.0001, w = 360, h = 140, pad = 15;
  const scale = Math.min((w - pad * 2) / lngRange, (h - pad * 2) / latRange); const cx = (w - lngRange * scale) / 2, cy = (h - latRange * scale) / 2;
  const pts = gpsTicks.map(t => `${(cx + (t.lng - minLng) * scale).toFixed(1)},${(h - cy - (t.lat - minLat) * scale).toFixed(1)}`);
  return `<div style="margin-bottom: 16px;"><svg viewBox="0 0 ${w} ${h}" style="width: 100%; height: ${h}px; background: rgba(0,0,0,0.25); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);"><path d="M${pts.join(' L')}" fill="none" stroke="#5DCAA5" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
}

// --- 8. UPLOAD (through terra.http; credentials are filled in by Terra from the settings, never read by this script) ---
async function uploadToIntervals(fitBuffer, startTime, btnElement) {
  if (!intervalsId || !(await terra.settings.has('intervals_api_key'))) { btnElement.textContent = "Add credentials ⚙"; terra.settings.open(); return; }
  btnElement.textContent = "Uploading..."; btnElement.disabled = true; const sportPrefix = sportMode === 'ROW' ? 'rowing' : 'cycling';
  const filename = `${sportPrefix}_${startTime.toISOString().slice(0,19).replace(/[T:]/g, '-')}.fit`;
  try {
    const r = await terra.http.request({
      method: 'POST',
      url: `https://intervals.icu/api/v1/athlete/${encodeURIComponent(intervalsId)}/activities`,
      basic: { user: 'API_KEY', password: '{{setting:intervals_api_key}}' },
      form: { file: { field: 'file', filename, contentType: 'application/octet-stream', base64: b64(fitBuffer) } },
    });
    if (r.status >= 200 && r.status < 300) { btnElement.textContent = "Uploaded!"; btnElement.style.background = "#4CAF50"; }
    else { btnElement.textContent = `Error ${r.status}`; btnElement.disabled = false; terra.log('Intervals.icu upload: ' + r.status + ' ' + r.body.slice(0, 200)); }
  } catch (e) { btnElement.textContent = "Error"; btnElement.disabled = false; terra.log('Intervals.icu upload: ' + errText(e)); }
}

async function uploadToStrava(fitBuffer, startTime, btnElement) {
  if (!stravaClientId || !(await terra.settings.has('strava_client_secret')) || !(await terra.settings.has('strava_refresh_token'))) {
    btnElement.textContent = "Add credentials ⚙"; terra.settings.open(); return;
  }
  btnElement.textContent = "Auth..."; btnElement.disabled = true;
  try {
    const auth = await terra.http.request({
      method: 'POST',
      url: `https://www.strava.com/oauth/token?client_id=${encodeURIComponent(stravaClientId)}&client_secret={{setting:strava_client_secret}}&grant_type=refresh_token&refresh_token={{setting:strava_refresh_token}}`,
    });
    const tok = JSON.parse(auth.body);
    if (!tok.access_token) throw new Error('Strava auth failed (HTTP ' + auth.status + ')');
    // Strava can hand out a new refresh token: keep the latest one
    if (tok.refresh_token) terra.settings.set('strava_refresh_token', tok.refresh_token).catch(() => {});
    btnElement.textContent = "Uploading...";
    const sportPrefix = sportMode === 'ROW' ? 'Rowterra' : 'Biketerra';
    const r = await terra.http.request({
      method: 'POST',
      url: 'https://www.strava.com/api/v3/uploads',
      headers: { Authorization: `Bearer ${tok.access_token}` },
      form: {
        fields: { name: routeName ? `${sportPrefix} - ${routeName}` : 'Virtual Workout', data_type: 'fit' },
        file: { field: 'file', filename: `workout_${startTime.getTime()}.fit`, contentType: 'application/octet-stream', base64: b64(fitBuffer) },
      },
    });
    if (r.status >= 200 && r.status < 300) { btnElement.textContent = "Uploaded!"; btnElement.style.background = "#FC4C02"; }
    else { btnElement.textContent = `Error ${r.status}`; btnElement.disabled = false; terra.log('Strava upload: ' + r.status + ' ' + r.body.slice(0, 200)); }
  } catch (e) { btnElement.textContent = "Auth Error"; btnElement.disabled = false; terra.log('Strava: ' + errText(e)); }
}

// --- 10. SPEED SYNC ---
let speedSyncActive = false; let internalGameSpeed = 0;
function startSpeedSyncLoop() {
  if (speedSyncActive || sportMode !== 'ROW') return; speedSyncActive = true; let lastTime = performance.now();
  function updateSpeed(time) {
    if (!speedSyncActive) return;
    requestAnimationFrame(updateSpeed);
    const dt = (time - lastTime) / 1000;
    lastTime = time;
    if (dt > 0.1 || dt <= 0) return;

    try {
      const gm = window.gameManager;
      if (gm && gm.ego && gm.ego.entity && gm.ego.entity.state) {
        const diff = targetGameSpeed - internalGameSpeed;
        const maxDelta = 3.0 * dt;
        if (Math.abs(diff) <= maxDelta) {
          internalGameSpeed = targetGameSpeed;
        } else {
          internalGameSpeed += Math.sign(diff) * maxDelta;
        }
        gm.ego.entity.state.speed = internalGameSpeed;
      }
    } catch (_) {}
  }
  requestAnimationFrame(updateSpeed);
}

function watchNavigation() { let lastHref = location.href; navTimer = setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; loadRouteDataOnNav(); } }, 1000); }
function init() { if (document.getElementById('universal-overlay')) return; buildOverlay(); routeTimer = setTimeout(loadRouteFromPage, 2000); watchNavigation(); }

// ---- cleanup: switching the addon off in the cog menu removes everything it added ----
terra.onCleanup(() => {
  clearInterval(uiTickInterval); clearInterval(tickInterval); clearInterval(navTimer); clearTimeout(routeTimer);
  speedSyncActive = false;
  closeBikeChannel();
  if (dragMove) document.removeEventListener('mousemove', dragMove);
  if (dragUp) document.removeEventListener('mouseup', dragUp);
  try { device?.removeEventListener('gattserverdisconnected', onFtmsDisconnected); } catch (_) {}
  document.getElementById('universal-overlay')?.remove();
  document.getElementById('uni-summary-bg')?.remove();
});

// ---- start ----
sportMode = await terra.storage.get('lastSportMode', 'BIKE');
powerGate = await terra.storage.get('powerGateSetting', 100);
await loadSettings();
terra.settings.onChange(async () => { await loadSettings(); fetchAthleteZonesFromIntervals(); });
init();
// A rowing machine paired earlier reconnects by itself
if (sportMode === 'ROW') terra.ble.remembered().then((list) => { if (list.length) connectFtmsBluetooth(); }).catch(() => {});
