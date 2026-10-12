(() => {
  let FALLBACK_FTP = 310;
  let FALLBACK_LTHR = 173;
  let INTERVALS_FTP = null;
  let INTERVALS_LTHR = null;
  let intervalsId = '';

  function getActiveFTP() {
    return window.location.pathname.includes('/spectate') ? FALLBACK_FTP : (INTERVALS_FTP || FALLBACK_FTP);
  }

  function getActiveLTHR() {
    return window.location.pathname.includes('/spectate') ? FALLBACK_LTHR : (INTERVALS_LTHR || FALLBACK_LTHR);
  }

  function getIntervalsColor(val, type) {
    if (type === 'power') {
      const pct = val / getActiveFTP();
      if (pct <= 0.55) return 'rgb(0, 158, 128)';
      if (pct <= 0.75) return 'rgb(0, 158, 0)';
      if (pct <= 0.90) return 'rgb(255, 203, 14)';
      if (pct <= 1.05) return 'rgb(255, 127, 14)';
      if (pct <= 1.20) return 'rgb(221, 4, 71)';
      if (pct <= 1.50) return 'rgb(102, 51, 204)';
      return 'rgb(80, 72, 97)';
    }
    if (type === 'hr') {
      const pct = val / getActiveLTHR();
      if (pct <= 0.80) return 'rgb(0, 158, 128)';
      if (pct <= 0.89) return 'rgb(0, 158, 0)';
      if (pct <= 0.93) return 'rgb(255, 203, 14)';
      if (pct <= 0.99) return 'rgb(255, 127, 14)';
      if (pct <= 1.02) return 'rgb(221, 4, 71)';
      if (pct <= 1.05) return 'rgb(102, 51, 204)';
      return 'rgb(80, 72, 97)';
    }
    if (type === 'cadence') return '#3b82f6';
    if (type === 'speed') return '#22c55e';
    return '#9ca3af';
  }

  async function loadSettings() {
    if (typeof terra === 'undefined' || !terra.settings) return;
    const s = await terra.settings.all();
    const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
    FALLBACK_FTP = n(s.fallback_ftp, 310);
    FALLBACK_LTHR = n(s.fallback_lthr, 173);
    intervalsId = String(s.intervals_id || '').trim();
  }

  async function fetchAthleteZonesFromIntervals() {
    if (typeof terra === 'undefined' || !terra.http || !intervalsId) return;

    if (window.location.pathname.includes('/spectate')) {
      terra.log('[Garmin HUD] Spectator mode: skipping personal Intervals.icu sync.');
      return;
    }

    const hasKey = await terra.settings.has('intervals_api_key');
    if (!hasKey) return;

    try {
      const r = await terra.http.request({
        method: 'GET',
        url: `https://intervals.icu/api/v1/athlete/${encodeURIComponent(intervalsId)}`,
                                         basic: { user: 'API_KEY', password: '{{setting:intervals_api_key}}' }
      });

      if (r.status >= 200 && r.status < 300) {
        const data = JSON.parse(r.body);
        let apiFtp = null;
        let apiLthr = null;

        if (data.ftp) apiFtp = data.ftp;
        if (data.lthr) apiLthr = data.lthr;

        if (Array.isArray(data.sportSettings)) {
          const ride = data.sportSettings.find(s => s.id === 'Ride' || s.id === 'VirtualRide') || data.sportSettings[0];
          if (ride) {
            apiFtp = ride.indoor_ftp || ride.ftp || apiFtp;
            apiLthr = ride.lthr || apiLthr;
          }
        }

        INTERVALS_FTP = apiFtp;
        INTERVALS_LTHR = apiLthr;

        terra.log(`[Garmin HUD] Synced Intervals.icu zones: FTP ${INTERVALS_FTP} | LTHR ${INTERVALS_LTHR}`);
      } else {
        terra.log(`[Garmin HUD] Intervals.icu error: HTTP ${r.status}`);
      }
    } catch (e) {
      terra.log('[Garmin HUD] Fetch error: ' + (e?.message || e));
    }
  }

  const graphs = {
    'W': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.strokeStyle = '#A855F7'; ctx.lineWidth = 2.5; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(13, 2); ctx.lineTo(3, 14); ctx.lineTo(12, 14);
        ctx.lineTo(11, 22); ctx.lineTo(21, 10); ctx.lineTo(12, 10); ctx.closePath();
        ctx.stroke(); ctx.restore();
      },
      data: Array.from({length: 60}, () => ({val: 0, color: 'rgb(0,158,128)'})), minScale: 350, type: 'power', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    },
    'rpm': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.strokeStyle = '#F59E0B'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(12, 12, 10, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(12, 12, 3, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      },
      data: Array.from({length: 60}, () => ({val: 0, color: '#3b82f6'})), minScale: 120, type: 'cadence', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    },
    'bpm': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.fillStyle = '#EF4444';
        ctx.fill(new Path2D('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z'));
        ctx.restore();
      },
      data: Array.from({length: 60}, () => ({val: 0, color: 'rgb(0,158,128)'})), minScale: 190, type: 'hr', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    },
    'kph': {
      drawIcon: (ctx, x, y, size) => {
        ctx.save(); ctx.translate(x, y - size / 2); ctx.scale(size / 24, size / 24);
        ctx.strokeStyle = '#3B82F6'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.stroke(new Path2D('M2 17.5a10 10 0 1 1 20 0')); ctx.stroke(new Path2D('M12 17.5L15 10'));
        ctx.fillStyle = '#3B82F6'; ctx.beginPath(); ctx.arc(12, 17.5, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      },
      data: Array.from({length: 60}, () => ({val: 0, color: '#22c55e'})), minScale: 50,  type: 'speed', allTimeSum: 0, allTimeCount: 0, allTimeMax: 0
    }
  };

  const historyLength = 60;
  let renderInterval = null;

  function startHudLoop() {
    renderInterval = setInterval(() => {
      const statCells = document.querySelectorAll('.stat-cell');

      // Measure a "normal" sized cell (like Heart Rate) to establish a global baseline
      let standardFontSize = 24;
      if (statCells.length > 1) {
        const normalValNode = statCells[1].querySelector('.stat-value');
        if (normalValNode) {
          standardFontSize = parseFloat(window.getComputedStyle(normalValNode).fontSize) || 24;
        }
      }

      statCells.forEach((cell) => {
        const valueNode = cell.querySelector('.stat-value');
        const unitNode = cell.querySelector('.stat-unit');
        if (!valueNode || !unitNode) return;

        const unit = unitNode.innerText.trim();
        const val = parseFloat(valueNode.innerText) || 0;

        const graphInfo = graphs[unit];
        if (!graphInfo) return;

        if (val > 0) {
          graphInfo.allTimeSum += val;
          graphInfo.allTimeCount += 1;
          if (val > graphInfo.allTimeMax) {
            graphInfo.allTimeMax = val;
          }
        }

        const liveColor = getIntervalsColor(val, graphInfo.type);
        graphInfo.data.push({ val: val, color: liveColor });
        graphInfo.data.shift();

        const valueStyle = window.getComputedStyle(valueNode);
        const unitStyle = window.getComputedStyle(unitNode);
        const valueFontFamily = valueStyle.fontFamily;
        const unitFontFamily = unitStyle.fontFamily;

        // Force all cells (including Power) to use the standard size
        const baseFontSize = standardFontSize;
        const cellHeight = baseFontSize * 3.2;
        const graphHeight = cellHeight * 0.45;

        let canvas = cell.querySelector('canvas.terra-dark-graph');
        if (!canvas) {
          cell.style.position = 'relative';
          cell.style.display = 'block';

          canvas = document.createElement('canvas');
          canvas.className = 'terra-dark-graph';
          canvas.style.cssText = 'position: absolute; top: 0; left: 0; z-index: 10; pointer-events: none; border-radius: 6px; overflow: hidden; background: #18181b;';
          cell.appendChild(canvas);
        }

        cell.style.height = `${cellHeight}px`;
        cell.style.minHeight = `${cellHeight}px`;

        const rect = cell.getBoundingClientRect();
        const displayWidth = Math.floor(rect.width);
        const displayHeight = Math.floor(cellHeight);
        const dpr = window.devicePixelRatio || 1;

        if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
          canvas.width = displayWidth * dpr;
          canvas.height = displayHeight * dpr;
          canvas.style.width = `${displayWidth}px`;
          canvas.style.height = `${displayHeight}px`;
        }

        const ctx = canvas.getContext('2d');
        ctx.resetTransform();
        ctx.scale(dpr, dpr);

        const width = displayWidth;
        const height = displayHeight;
        ctx.clearRect(0, 0, width, height);

        const validRollingVals = graphInfo.data.map(d => d.val).filter(v => v > 0);
        const windowMax = validRollingVals.length ? Math.max(...validRollingVals) : 0;
        const scaleMax = Math.max(graphInfo.minScale, windowMax);

        const allTimeAvg = graphInfo.allTimeCount > 0 ? Math.round(graphInfo.allTimeSum / graphInfo.allTimeCount) : 0;
        const allTimeMax = Math.round(graphInfo.allTimeMax);

        for (let i = 0; i < historyLength - 1; i++) {
          const pt1 = graphInfo.data[i];
          const pt2 = graphInfo.data[i + 1];

          const x1 = (i / (historyLength - 1)) * width;
          const y1 = height - ((pt1.val / scaleMax) * graphHeight);
          const x2 = ((i + 1) / (historyLength - 1)) * width;
          const y2 = height - ((pt2.val / scaleMax) * graphHeight);

          ctx.beginPath();
          ctx.moveTo(x1, height);
          ctx.lineTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineTo(x2, height);
          ctx.closePath();

          ctx.fillStyle = pt2.color;
          ctx.globalAlpha = 1.0;
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.strokeStyle = pt2.color;
          ctx.lineWidth = Math.max(1.5, baseFontSize * 0.08);
          ctx.stroke();
        }

        ctx.textBaseline = 'middle';
        const paddingX = baseFontSize * 0.4;

        const iconSize = baseFontSize * 0.95;
        graphInfo.drawIcon(ctx, paddingX, (height - graphHeight) / 2, iconSize);

        const valStr = (unit === 'kph') ? val.toFixed(1) : val.toString();

        ctx.font = `bold ${baseFontSize}px ${valueFontFamily}`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';

        const textOffset = paddingX + iconSize + (baseFontSize * 0.15);
        ctx.fillText(valStr, textOffset, (height - graphHeight) / 2 + (baseFontSize * 0.05));

        ctx.textAlign = 'right';
        ctx.fillStyle = '#9ca3af';
        ctx.font = `bold ${baseFontSize * 0.6}px ${unitFontFamily}`;
        ctx.fillText(`AVG ${allTimeAvg}`, width - paddingX, Math.floor((height - graphHeight) * 0.3));
        ctx.fillText(`MAX ${allTimeMax}`, width - paddingX, Math.floor((height - graphHeight) * 0.7));

        ctx.strokeStyle = '#27272a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(width, 0);
        ctx.stroke();
      });
    }, 1000);
  }

  (async () => {
    await loadSettings();
    await fetchAthleteZonesFromIntervals();

    if (typeof terra !== 'undefined' && terra.settings) {
      terra.settings.onChange(async () => {
        await loadSettings();
        await fetchAthleteZonesFromIntervals();
      });

      terra.onCleanup(() => {
        if (renderInterval) clearInterval(renderInterval);
        document.querySelectorAll('canvas.terra-dark-graph').forEach(c => c.remove());
      });
    }

    startHudLoop();
  })();
})();
