/* group-spectate v0.2.1
 * Focuses Biketerra's camera on the mean position of a group of riders instead of a single rider.
 * - Ctrl+click a group header in Biketerra's rider list (or pick a live <25m cluster in the Group Cam panel).
 * - Automatically keeps btApp.riderController.focalRider on a rider inside the spectated group so 3D models & LOD stay loaded.
 * - Dynamically adjusts the group when riders drop behind (> clusterRadius) or bridge across, and follows the leader on even splits.
 * - Hooks btApp.camera.update (single call per frame) so 3D scene, tiles, and 2D nameplates stay perfectly aligned.
 */
'use strict';
(async () => {
  const log = (...a) => {
    try { terra.log(...a); } catch { console.log('[group-spectate]', ...a); }
  };

  const DEFAULTS = {
    framingMode: 'auto',     // 'fixed' | 'auto'
    trackMode: 'cluster',    // 'cluster' | 'dom'
    clusterRadius: 25,
    pullBackFactor: 1.6,
    smoothing: 0.14,
  };
  let S = Object.assign({}, DEFAULTS);
  try { S = Object.assign({}, DEFAULTS, await terra.settings.all()); } catch {}

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(+v) ? +v : lo));
  const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // Optional 2Hz broadcast map (id -> name) to improve name matching when btApp config lacks full names
  const nameById = new Map();
  try {
    terra.ride.onRide((frame) => {
      if (!frame || !Array.isArray(frame.riders)) return;
      nameById.clear();
      for (const r of frame.riders) {
        if (!r || !r.name || r.id == null) continue;
        const nk = normName(r.name);
        if (nk) nameById.set(String(r.id), nk);
      }
    });
  } catch {}

  try {
    terra.settings.onChange(async () => {
      try {
        S = Object.assign({}, DEFAULTS, await terra.settings.all());
        syncUi();
      } catch {}
    });
  } catch {}

  const state = {
    active: false,
    label: '',
    activatedAt: 0,
    seedNames: new Set(),     // originally clicked/selected rider names
    seedKeys: new Set(),      // originally clicked/selected rider keys
    trackedNames: new Set(),  // current pack rider names (dynamic in cluster mode)
    trackedKeys: new Set(),   // current pack rider keys
    preferredRow: null,       // fallback DOM row from initial Ctrl+click
    smoothCenter: null,       // { x, y, z }
    smoothBack: 0,
    lastMemberCount: 0,
    lastSpread: 0,
    focalLabel: '',
    hideFocalRider: false,
    lastFocalAttemptAt: 0,
    lastFocalDomAttemptAt: 0,
    lastFocalTargetKey: null,
  };

  function riderIdOf(r) {
    const sim = r && r.sim;
    if (!sim) return null;
    if (sim.athleteId != null) return String(sim.athleteId);
    if (sim.id != null) return String(sim.id);
    return null;
  }

  function riderNamesOf(r, isFocal, rc) {
    const out = [];
    const cfg = (r && r.config) || {};
    const ud = (r && r.userData) || {};
    const first = String(ud.first_name != null ? ud.first_name : (cfg.first_name || '')).trim();
    const last = String(cfg.last_name != null ? cfg.last_name : (ud.last_name || '')).trim();
    const full = normName(first + ' ' + last);
    if (full) out.push(full);
    for (const cand of [cfg.name, cfg.fullName, cfg.displayName, ud.name, ud.fullName]) {
      const n = normName(cand);
      if (n && !out.includes(n)) out.push(n);
    }
    const id = riderIdOf(r);
    if (id && nameById.has(id)) {
      const n = nameById.get(id);
      if (n && !out.includes(n)) out.push(n);
    }
    if (isFocal && rc && rc.ego === r) out.push('__me__');
    return out;
  }

  function riderDisplayName(r) {
    if (!r) return '';
    const cfg = r.config || {};
    const ud = r.userData || {};
    const first = String(ud.first_name != null ? ud.first_name : (cfg.first_name || '')).trim();
    const last = String(cfg.last_name != null ? cfg.last_name : (ud.last_name || '')).trim();
    return (first + ' ' + last).trim() || String(cfg.name || cfg.fullName || 'Rider').trim();
  }

  function riderKey(r) {
    const id = riderIdOf(r);
    if (id) return 'id:' + id;
    const names = riderNamesOf(r, false, null);
    if (names.length) return 'name:' + names[0];
    return null;
  }

  function allBtRiders(rc) {
    const list = [];
    const seen = new Set();
    const push = (r, isFocal) => {
      if (!r || !r.sim || !r.sim.midPosition) return;
      if (r._isTerraGhost) return;
      if (seen.has(r)) return;
      seen.add(r);
      const p = r.sim.midPosition;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
      list.push({
        r,
        isFocal,
        culled: r.sim.curLod === 0,
        pos: p,
        key: riderKey(r),
        names: riderNamesOf(r, isFocal, rc),
      });
    };
    if (rc.focalRider) push(rc.focalRider, true);
    if (rc.ego && rc.ego !== rc.focalRider) push(rc.ego, false);
    for (const r of (rc.riders || [])) push(r, r === rc.focalRider);
    return list;
  }

  // Wake Biketerra's throttled rider LOD countdown (`updateCounter`) so far-away target riders un-cull on the next frame
  function wakeGroupRiders(rc, entries) {
    if (!rc) return;
    const list = entries || allBtRiders(rc);
    const keyRef = S.trackMode === 'dom' ? state.seedKeys : state.trackedKeys;
    const nameRef = S.trackMode === 'dom' ? state.seedNames : state.trackedNames;
    const focalPos = rc.focalRider && rc.focalRider.sim && rc.focalRider.sim.midPosition;
    const wakeR2 = Math.pow(clamp(S.clusterRadius, 3, 200) * 2.5, 2);
    for (const e of list) {
      if (!e.r || typeof e.r.updateCounter !== 'number') continue;
      const isTarget = entryMatches(e, keyRef, nameRef);
      let nearFocal = false;
      if (!isTarget && focalPos) {
        const dx = e.pos.x - focalPos.x;
        const dy = e.pos.y - focalPos.y;
        const dz = e.pos.z - focalPos.z;
        nearFocal = dx * dx + dy * dy + dz * dz <= wakeR2;
      }
      if ((isTarget || nearFocal) && e.r.updateCounter > 0) {
        e.r.updateCounter = 0;
      }
    }
  }

  // Single-linkage spatial clustering over the caller-supplied entry list
  function computeClusters(entries, radiusM) {
    const n = entries.length;
    const visited = new Uint8Array(n);
    const clusters = [];
    const r2 = radiusM * radiusM;
    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const queue = [i];
      visited[i] = 1;
      const members = [];
      while (queue.length) {
        const cur = queue.pop();
        const a = entries[cur];
        members.push(a);
        for (let j = 0; j < n; j++) {
          if (visited[j]) continue;
          const b = entries[j];
          const dx = a.pos.x - b.pos.x;
          const dy = a.pos.y - b.pos.y;
          const dz = a.pos.z - b.pos.z;
          if (dx * dx + dy * dy + dz * dz <= r2) {
            visited[j] = 1;
            queue.push(j);
          }
        }
      }
      clusters.push(members);
    }
    clusters.sort((a, b) => {
      const aHasFocal = a.some((m) => m.isFocal) ? 1 : 0;
      const bHasFocal = b.some((m) => m.isFocal) ? 1 : 0;
      if (aHasFocal !== bHasFocal) return bHasFocal - aHasFocal;
      return b.length - a.length;
    });
    return clusters;
  }

  function entryMatches(entry, keySet, nameSet) {
    if (entry.key && keySet.has(entry.key)) return true;
    return entry.names.some((n) => nameSet.has(n));
  }

  function meanPos(members) {
    let sx = 0, sy = 0, sz = 0;
    for (const m of members) {
      sx += m.pos.x;
      sy += m.pos.y;
      sz += m.pos.z;
    }
    const inv = 1 / members.length;
    return { x: sx * inv, y: sy * inv, z: sz * inv };
  }

  function pickIdealFocal(members, center) {
    let best = members[0] || null;
    let bestD2 = Infinity;
    for (const m of members) {
      const dx = m.pos.x - center.x;
      const dy = m.pos.y - center.y;
      const dz = m.pos.z - center.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = m;
      }
    }
    return best;
  }

  const domRankByName = new Map(); // cached in watchTimer: normName -> 0-based index (0 = leader)

  function refreshDomRanks() {
    domRankByName.clear();
    const rows = document.querySelectorAll('.hud-zone.zone-people .rider:not(.is-group), .riders-main .rider:not(.is-group)');
    let idx = 0;
    for (const row of rows) {
      const rn = extractRowName(row);
      if (rn && !domRankByName.has(rn)) domRankByName.set(rn, idx++);
    }
  }

  // Note: Do NOT use r.rideDistance — Biketerra only increments rideDistance on the focal rider (others stay 0).
  // sim.currentPathDistance + sim.lapCount are updated for every rider (and used by Biketerra's own gap math).
  function riderProgressScore(entry) {
    const sim = entry && entry.r && entry.r.sim;
    if (!sim) return -Infinity;
    const pathDist = numOrNull(sim.currentPathDistance);
    if (pathDist !== null) {
      const lap = numOrNull(sim.lapCount) ?? 0;
      return lap * 1e6 + pathDist;
    }
    for (const n of (entry.names || [])) {
      if (domRankByName.has(n)) return -domRankByName.get(n);
    }
    return -Infinity;
  }

  function clusterLeaderScore(members) {
    let best = -Infinity;
    for (const m of members) {
      const sc = riderProgressScore(m);
      if (sc > best) best = sc;
    }
    return best;
  }

  function scoreDistToPrev(members) {
    if (!state.smoothCenter) return 0;
    const c = meanPos(members);
    return -Math.hypot(c.x - state.smoothCenter.x, c.y - state.smoothCenter.y, c.z - state.smoothCenter.z);
  }

  function compareClusterScores(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  function resolveTargetGroup(rc, opts) {
    const updateTracked = !!(opts && opts.updateTracked);
    const entries = allBtRiders(rc);
    const focalEntry = entries.find((e) => e.isFocal) || null;
    if (!entries.length) return null;

    const radius = clamp(S.clusterRadius, 3, 200);
    const keyRef = S.trackMode === 'dom' ? state.seedKeys : state.trackedKeys;
    const nameRef = S.trackMode === 'dom' ? state.seedNames : state.trackedNames;
    const focalMatchesTarget = !!(focalEntry && entryMatches(focalEntry, keyRef, nameRef));

    // Include all un-culled riders, PLUS if focalRider is already in the target group, include target riders
    // within 2*radius of focalRider while their throttled curLod wakes up from 0 -> 4.
    const wakeR2 = (radius * 2) * (radius * 2);
    const activeEntries = entries.filter((e) => {
      if (!e.culled) return true;
      if (e.isFocal && focalMatchesTarget) return true;
      if (focalMatchesTarget && focalEntry && entryMatches(e, keyRef, nameRef)) {
        const dx = e.pos.x - focalEntry.pos.x;
        const dy = e.pos.y - focalEntry.pos.y;
        const dz = e.pos.z - focalEntry.pos.z;
        return dx * dx + dy * dy + dz * dz <= wakeR2;
      }
      return false;
    });

    const hasCulledTarget = entries.some((e) => e.culled && entryMatches(e, keyRef, nameRef));
    if (hasCulledTarget && focalMatchesTarget) {
      wakeGroupRiders(rc, entries);
    }

    let selected = [];

    if (S.trackMode === 'dom') {
      // Strictly track riders from the clicked group, pruned by <clusterRadius so dropped riders are NOT counted
      const matchedActive = activeEntries.filter(
        (e) => entryMatches(e, state.seedKeys, state.seedNames)
      );
      if (updateTracked) {
        for (const e of matchedActive) {
          if (e.key) state.seedKeys.add(e.key);
        }
      }
      if (matchedActive.length) {
        const subClusters = computeClusters(matchedActive, radius);
        subClusters.sort((a, b) => {
          const sa = [
            a.length,
            clusterLeaderScore(a),
            a.some((m) => m.isFocal) ? 1 : 0,
            scoreDistToPrev(a),
          ];
          const sb = [
            b.length,
            clusterLeaderScore(b),
            b.some((m) => m.isFocal) ? 1 : 0,
            scoreDistToPrev(b),
          ];
          return compareClusterScores(sb, sa);
        });
        selected = subClusters[0] || [];
      }
    } else {
      // Live pack mode: dynamically follow the <clusterRadius pack with highest overlap with tracked group.
      // Automatically drops riders who fall >clusterRadius behind and includes riders who join; on an even split, follows the leader.
      const clusters = computeClusters(activeEntries, radius);
      const hasTracked = state.trackedKeys.size > 0 || state.trackedNames.size > 0;
      let best = null;
      let bestScore = null;

      for (const cl of clusters) {
        const overlap = hasTracked
          ? cl.reduce((acc, m) => acc + (entryMatches(m, state.trackedKeys, state.trackedNames) ? 1 : 0), 0)
          : (cl.some((m) => m.isFocal) ? 1 : 0);
        if (overlap <= 0) continue;
        const sc = [
          overlap,
          cl.length,
          clusterLeaderScore(cl),
          cl.some((m) => m.isFocal) ? 1 : 0,
          scoreDistToPrev(cl),
        ];
        if (!bestScore || compareClusterScores(sc, bestScore) > 0) {
          bestScore = sc;
          best = cl;
        }
      }

      if (best && best.length) {
        selected = best;
        // Don't shrink/wipe trackedKeys during the brief settle window while newly switched teammates' LOD wakes up
        const settling = (Date.now() - state.activatedAt) < 800 && hasCulledTarget;
        if (updateTracked && !settling) {
          const nextKeys = new Set();
          const nextNames = new Set();
          for (const m of best) {
            if (m.key) nextKeys.add(m.key);
            for (const n of m.names) {
              if (n !== '__me__') nextNames.add(n);
            }
          }
          if (nextKeys.size) state.trackedKeys = nextKeys;
          if (nextNames.size) state.trackedNames = nextNames;
        }
      }
    }

    if (!selected.length) {
      // Group is outside focalRider's current draw distance -> find a culled candidate to switch focalRider to
      const culledMatches = entries.filter((e) => entryMatches(e, keyRef, nameRef));
      if (culledMatches.length) {
        return {
          waitingForFocal: true,
          focalCandidate: culledMatches[Math.floor(culledMatches.length / 2)],
          focalPos: focalEntry ? focalEntry.pos : null,
          center: null,
          spread: 0,
          count: 0,
          selected: [],
        };
      }
      return null;
    }

    const center = meanPos(selected);
    let maxR = 0;
    for (const m of selected) {
      const d = Math.hypot(m.pos.x - center.x, m.pos.y - center.y, m.pos.z - center.z);
      if (d > maxR) maxR = d;
    }

    const focalInSelected = selected.some((m) => m.isFocal);
    const idealFocal = focalInSelected ? focalEntry : pickIdealFocal(selected, center);

    return {
      waitingForFocal: false,
      focalPos: focalEntry ? focalEntry.pos : null,
      focalInSelected,
      idealFocal,
      selected,
      center,
      spread: maxR,
      count: selected.length,
    };
  }

  // ---- Switching focalRider into the spectated group ----
  function isSpectateMode(rc) {
    try {
      const loc = window.location;
      const p = String((loc && loc.pathname) || '');
      const s = String((loc && loc.search) || '');
      if (p.startsWith('/spectate')) return true;
      if (/[?&]spectate=/.test(s)) return true;
    } catch {}
    return !!(rc && (!rc.ego || (rc.focalRider && rc.focalRider !== rc.ego)));
  }

  function extractRowName(row) {
    if (!row || (row.classList && row.classList.contains('is-group'))) return '';
    const nameEl = row.querySelector ? row.querySelector('.rider-name-btn, .rider-name') : null;
    const nm = normName(nameEl ? nameEl.textContent : '');
    if (nm) return nm;
    if (row.classList && row.classList.contains('is-me')) return '__me__';
    return '';
  }

  function findDomRowByNames(nameSetOrArr) {
    const wanted = nameSetOrArr instanceof Set ? nameSetOrArr : new Set(nameSetOrArr || []);
    if (!wanted.size) return null;
    const rows = document.querySelectorAll('.hud-zone.zone-people .rider:not(.is-group), .riders-main .rider:not(.is-group), .rider:not(.is-group)');
    const matched = [];
    for (const row of rows) {
      const rn = extractRowName(row);
      if (rn && wanted.has(rn)) matched.push(row);
    }
    if (!matched.length) return null;
    return matched[Math.floor(matched.length / 2)];
  }

  function triggerDomRowClick(row) {
    if (!row) return false;
    const isGroupHdr = row.classList && row.classList.contains('is-group');
    const target = isGroupHdr
      ? row
      : ((row.querySelector && (
          row.querySelector('.rider-name-btn') ||
          row.querySelector('button') ||
          row.querySelector('a, [role="button"]') ||
          row.querySelector('.rider-name')
        )) || row);
    try {
      if (typeof target.click === 'function') {
        target.click();
        return true;
      }
    } catch {}
    try {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {}
    return false;
  }

  function tryDirectFocalSetter(rc, targetRider) {
    if (!rc || !targetRider) return false;
    // In Biketerra's RiderController, setFocalRider(athleteId) expects the numeric/string athleteId (NOT the rider object).
    const athleteId = targetRider.sim && (targetRider.sim.athleteId != null ? targetRider.sim.athleteId : targetRider.sim.id);
    if (typeof rc.setFocalRider === 'function' && athleteId != null) {
      try {
        rc.setFocalRider(athleteId);
        if (rc.focalRider && (rc.focalRider === targetRider || (rc.focalRider.sim && rc.focalRider.sim.athleteId == athleteId))) {
          wakeGroupRiders(rc);
          log('switched focalRider via rc.setFocalRider(' + athleteId + ')');
          return true;
        }
      } catch {}
    }
    return false;
  }

  function canWriteFocalProperty(rc) {
    if (!rc) return false;
    const own = Object.getOwnPropertyDescriptor(rc, 'focalRider');
    if (own) return !!(own.writable || own.set);
    const proto = Object.getPrototypeOf(rc);
    const pd = proto && Object.getOwnPropertyDescriptor(proto, 'focalRider');
    if (pd) return !!(pd.writable || pd.set);
    return true;
  }

  function ensureFocalInGroup(rc, targetMember, forceImmediate) {
    if (!state.active || !rc) return;
    const now = Date.now();
    const targetKey = (targetMember && targetMember.key) || '__dom__';

    if (!forceImmediate && now - state.lastFocalAttemptAt < 250) {
      return;
    }
    state.lastFocalAttemptAt = now;
    state.lastFocalTargetKey = targetKey;

    if (targetMember && rc.focalRider === targetMember.r) {
      state.preferredRow = null;
      wakeGroupRiders(rc);
      return;
    }

    // 1) Prefer clicking Biketerra's .rider-name-btn in the DOM so Svelte stores (Qr/ut) & #_e() teleport stay in sync
    const domRow =
      (targetMember && findDomRowByNames(targetMember.names)) ||
      state.preferredRow ||
      findDomRowByNames(state.trackedNames.size ? state.trackedNames : state.seedNames);
    if (domRow) {
      const domAttemptAgo = now - state.lastFocalDomAttemptAt;
      state.lastFocalDomAttemptAt = now;
      triggerDomRowClick(domRow);
      state.preferredRow = null;
      wakeGroupRiders(rc);
      if (targetMember && rc.focalRider === targetMember.r) {
        log('switched focalRider via DOM click ->', riderDisplayName(targetMember.r));
        return;
      }
      // Give Biketerra 1 tick after a fresh DOM click to process Svelte store -> #se() before falling back
      if (forceImmediate && domAttemptAgo > 250) {
        return;
      }
    }

    // 2) Fallback: call rc.setFocalRider(athleteId) (never pass the rider object or Biketerra clears focalRider!)
    if (targetMember && isSpectateMode(rc) && tryDirectFocalSetter(rc, targetMember.r)) {
      return;
    }

    // 3) Last-resort fallback for environments without setFocalRider
    if (targetMember && typeof rc.setFocalRider !== 'function' && isSpectateMode(rc) && canWriteFocalProperty(rc)) {
      try {
        rc.focalRider = targetMember.r;
        wakeGroupRiders(rc);
        log('assigned rc.focalRider directly ->', riderDisplayName(targetMember.r));
      } catch {}
    }
  }

  // ---- DOM Group header detection (Ctrl+Click) ----
  function findPeopleRoot(el) {
    if (!el || typeof el.closest !== 'function') return null;
    const ridersMain = el.closest('.riders-main');
    if (ridersMain) return ridersMain;
    const zone = el.closest('.hud-zone.zone-people');
    if (!zone) return null;
    if (zone.querySelector('.riders-main')) return null;
    return zone;
  }

  function collectGroupSiblingRows(groupHdr) {
    const rows = [];
    let cur = groupHdr && groupHdr.nextElementSibling;
    while (cur && cur.classList && cur.classList.contains('rider') && !cur.classList.contains('is-group')) {
      rows.push(cur);
      cur = cur.nextElementSibling;
    }
    return rows;
  }

  // Supports Biketerra's native `.rider.is-group` headers (with sibling `.rider.grouped-rider` rows when expanded),
  // plus generic nested/flat group wrappers as fallback.
  function findGroupFromTarget(target) {
    const root = findPeopleRoot(target);
    if (!root) return null;

    // Native Biketerra group header has class `.rider.is-group`
    const groupHdr = target.closest('.rider.is-group');
    if (groupHdr && root.contains(groupHdr)) {
      const nameEl = groupHdr.querySelector ? groupHdr.querySelector('.group-name, .rider-name') : null;
      const label = (nameEl ? nameEl.textContent : groupHdr.textContent || '').trim();
      const rows = collectGroupSiblingRows(groupHdr);
      return { headerEl: groupHdr, rows, needsExpand: rows.length === 0, label };
    }

    if (target.closest('.rider')) return null;

    let node = target;
    while (node && node !== root && node.parentElement) {
      if (node.querySelector && node.querySelector('.rider')) {
        if (!node.classList.contains('riders-main') && !node.classList.contains('zone-people') && !node.querySelector('.riders-main')) {
          const rows = [...node.querySelectorAll('.rider:not(.is-group)')];
          if (rows.length >= 1) {
            return { headerEl: target.closest('button, [role="button"], div, span, header') || node, rows, needsExpand: false, label: (node.firstElementChild?.textContent || '').trim() };
          }
        }
        break;
      }
      const parent = node.parentElement;
      const childRiders = [...parent.children].filter((c) => c.classList && c.classList.contains('rider') && !c.classList.contains('is-group'));
      if (childRiders.length > 0) {
        const sibs = [];
        let cur = node.nextElementSibling;
        while (cur && cur.classList && cur.classList.contains('rider') && !cur.classList.contains('is-group')) {
          sibs.push(cur);
          cur = cur.nextElementSibling;
        }
        if (sibs.length > 0) {
          return { headerEl: node, rows: sibs, needsExpand: false, label: (node.textContent || '').trim() };
        }
        if (!parent.classList.contains('riders-main') && !parent.classList.contains('zone-people')) {
          return { headerEl: node, rows: [...parent.querySelectorAll('.rider:not(.is-group)')], needsExpand: false, label: (node.textContent || '').trim() };
        }
      }
      node = parent;
    }
    return null;
  }

  function markDetectedHeaders() {
    document.querySelectorAll('[data-gs-group-header]').forEach((el) => el.removeAttribute('data-gs-group-header'));
    const root =
      document.querySelector('.hud-zone.zone-people .riders-main') ||
      document.querySelector('.riders-main') ||
      document.querySelector('.hud-zone.zone-people');
    if (!root) return;
    const seen = new Set();
    for (const gh of root.querySelectorAll('.rider.is-group')) {
      seen.add(gh);
      gh.setAttribute('data-gs-group-header', '1');
      if (!gh.title) gh.title = 'Ctrl+Click to spectate this group center';
    }
    const rows = [...root.querySelectorAll('.rider:not(.is-group)')];
    if (!rows.length) return;
    for (const row of rows) {
      const prev = row.previousElementSibling;
      if (prev && !prev.classList.contains('rider') && !seen.has(prev)) {
        seen.add(prev);
        prev.setAttribute('data-gs-group-header', '1');
        if (!prev.title) prev.title = 'Ctrl+Click to spectate this group center';
      }
      const parent = row.parentElement;
      if (parent && parent !== root && !parent.classList.contains('riders-main') && !parent.classList.contains('zone-people')) {
        const hdr = parent.firstElementChild;
        if (hdr && !hdr.classList.contains('rider') && !seen.has(hdr)) {
          seen.add(hdr);
          hdr.setAttribute('data-gs-group-header', '1');
          if (!hdr.title) hdr.title = 'Ctrl+Click to spectate this group center';
        }
      }
    }
  }

  function activateGroup({ label, names, keys, clickRow, skipInitialClick }) {
    state.active = true;
    state.label = label || `${names.length} riders`;
    state.activatedAt = Date.now();
    state.seedNames = new Set((names || []).filter(Boolean));
    state.seedKeys = new Set((keys || []).filter(Boolean));
    state.trackedNames = new Set((names || []).filter(Boolean));
    state.trackedKeys = new Set((keys || []).filter(Boolean));
    state.preferredRow = clickRow || findDomRowByNames(state.seedNames);
    state.smoothCenter = null;
    state.smoothBack = 0;
    state.lastFocalAttemptAt = 0;
    state.lastFocalDomAttemptAt = 0;
    state.lastFocalTargetKey = null;

    const app = window.btApp;
    const rc = app && app.riderController;
    if (rc) {
      wakeGroupRiders(rc);
      if (!skipInitialClick) {
        const grp = resolveTargetGroup(rc, { updateTracked: false });
        if (grp && grp.waitingForFocal && grp.focalCandidate) {
          ensureFocalInGroup(rc, grp.focalCandidate, true);
        } else if (grp && !grp.focalInSelected && grp.idealFocal) {
          ensureFocalInGroup(rc, grp.idealFocal, true);
        } else if (!grp) {
          const focalNames = rc.focalRider ? riderNamesOf(rc.focalRider, true, rc) : [];
          const focalInGroup = focalNames.some((n) => state.seedNames.has(n));
          if (!focalInGroup) {
            ensureFocalInGroup(rc, null, true);
          }
        }
      }
      state.focalLabel = rc.focalRider ? riderDisplayName(rc.focalRider) : '';
    }
    syncUi();
    log('activated group spectate:', state.label, [...state.seedNames]);
  }

  function stopGroupSpectate() {
    state.active = false;
    state.preferredRow = null;
    state.smoothCenter = null;
    state.smoothBack = 0;
    state.lastMemberCount = 0;
    state.lastSpread = 0;
    state.focalLabel = '';
    document.querySelectorAll('.gs-group-active-hdr').forEach((el) => el.classList.remove('gs-group-active-hdr'));
    syncUi();
    log('stopped group spectate');
  }

  function finishActivationFromHeader(headerEl, rows, label, skipInitialClick) {
    const names = rows.map(extractRowName).filter(Boolean);
    if (!names.length) return false;
    const midRow = rows[Math.floor(rows.length / 2)];
    document.querySelectorAll('.gs-group-active-hdr').forEach((el) => el.classList.remove('gs-group-active-hdr'));
    if (headerEl) headerEl.classList.add('gs-group-active-hdr');
    activateGroup({
      label: label ? label.slice(0, 28) : `${names.length} riders`,
      names,
      clickRow: midRow,
      skipInitialClick: !!skipInitialClick,
    });
    return true;
  }

  const onCaptureClick = (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const grp = findGroupFromTarget(e.target);
    if (!grp) return;
    e.preventDefault();
    e.stopPropagation();

    if (grp.rows.length > 0) {
      finishActivationFromHeader(grp.headerEl, grp.rows, grp.label, false);
      return;
    }

    // Collapsed Biketerra `.rider.is-group` (▸): native click expands it AND calls onSpectateGroup -> spectates riders[0].
    // Poll briefly for the expanded rows instead of hard-waiting, and avoid triggering a redundant second focal switch.
    if (grp.needsExpand && grp.headerEl) {
      const wantedLabel = grp.label;
      triggerDomRowClick(grp.headerEl);
      let tries = 0;
      const pollExpanded = () => {
        if (cleanedUp) return;
        let hdr = grp.headerEl;
        if (!hdr || !hdr.isConnected) {
          hdr = [...document.querySelectorAll('.riders-main .rider.is-group, .hud-zone.zone-people .rider.is-group')]
            .find((el) => ((el.querySelector('.group-name, .rider-name')?.textContent || el.textContent || '').trim() === wantedLabel)) || null;
        }
        const expandedRows = hdr ? collectGroupSiblingRows(hdr) : [];
        if (expandedRows.length) {
          finishActivationFromHeader(hdr, expandedRows, wantedLabel, true);
          return;
        }
        if (++tries < 8) setTimeout(pollExpanded, 25);
      };
      setTimeout(pollExpanded, 16);
    }
  };
  document.addEventListener('click', onCaptureClick, true);

  const onKeyDown = (e) => {
    if (e.key === 'Control' || e.key === 'Meta') {
      document.body.classList.add('gs-ctrl-held');
      markDetectedHeaders();
    } else if (e.key === 'Escape') {
      if (state.active) {
        stopGroupSpectate();
      } else if (panel.classList.contains('open')) {
        setPanelOpen(false);
      }
    }
  };
  const onKeyUp = (e) => {
    if (e.key === 'Control' || e.key === 'Meta') {
      document.body.classList.remove('gs-ctrl-held');
    }
  };
  const onBlur = () => document.body.classList.remove('gs-ctrl-held');
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  // ---- Camera override via btApp.camera.update (single call per frame; syncs 3D, tiles, and 2D nameplates) ----
  let hookedCam = null;
  let prevCamUpdate = null;
  let wrappedCamUpdate = null;
  let hookedEng = null;
  let prevRender = null;
  let wrappedRender = null;
  let inEngineRender = false;
  let camShiftedThisFrame = false;
  let cleanedUp = false;
  let featureApp = null;

  function computeShiftedWorldPos(origWp, bx, by, bz, grp) {
    state.lastMemberCount = grp.count;
    state.lastSpread = grp.spread;
    const rc = window.btApp && window.btApp.riderController;
    state.focalLabel = rc && rc.focalRider ? riderDisplayName(rc.focalRider) : '';

    const alpha = clamp(S.smoothing, 0.02, 1.0);
    if (!state.smoothCenter) {
      state.smoothCenter = { ...grp.center };
    } else {
      const jumpDist = Math.hypot(
        grp.center.x - state.smoothCenter.x,
        grp.center.y - state.smoothCenter.y,
        grp.center.z - state.smoothCenter.z
      );
      if (jumpDist > 120) {
        // Snap immediately when jumping to a distant group instead of flying across terrain
        state.smoothCenter = { ...grp.center };
      } else {
        state.smoothCenter.x += (grp.center.x - state.smoothCenter.x) * alpha;
        state.smoothCenter.y += (grp.center.y - state.smoothCenter.y) * alpha;
        state.smoothCenter.z += (grp.center.z - state.smoothCenter.z) * alpha;
      }
    }

    const targetBack = S.framingMode === 'auto'
      ? Math.max(0, grp.spread * clamp(S.pullBackFactor, 0.2, 5.0) - 1.2)
      : 0;
    state.smoothBack += (targetBack - state.smoothBack) * alpha;

    const shiftX = state.smoothCenter.x - grp.focalPos.x;
    const shiftY = state.smoothCenter.y - grp.focalPos.y;
    const shiftZ = state.smoothCenter.z - grp.focalPos.z;

    // Move strictly along the camera backward axis so smoothCenter remains centered in the viewport
    const back = state.smoothBack;
    const pulledY = origWp.y + shiftY + by * back;
    const safeY = back > 0 ? Math.max(pulledY, state.smoothCenter.y + 0.6) : pulledY;

    return {
      x: origWp.x + shiftX + bx * back,
      y: safeY,
      z: origWp.z + shiftZ + bz * back,
    };
  }

  function installCamUpdateHook(cam) {
    if (cleanedUp || !cam || typeof cam.update !== 'function' || hookedCam === cam) return;
    if (hookedCam && prevCamUpdate && hookedCam.update === wrappedCamUpdate) {
      try { hookedCam.update = prevCamUpdate; } catch {}
    }
    hookedCam = cam;
    prevCamUpdate = cam.update;

    wrappedCamUpdate = function (params) {
      if (
        cleanedUp ||
        inEngineRender ||
        !state.active ||
        state.hideFocalRider ||
        !params ||
        !params.worldPosition ||
        !params.rotation ||
        params.rotation.length < 9
      ) {
        return prevCamUpdate.call(this, params);
      }
      const app = window.btApp;
      const rc = app && app.riderController;
      if (!rc) return prevCamUpdate.call(this, params);

      let grp = null;
      try {
        grp = resolveTargetGroup(rc, { updateTracked: true });
      } catch {
        return prevCamUpdate.call(this, params);
      }
      if (grp && grp.waitingForFocal && grp.focalCandidate) {
        const cand = grp.focalCandidate;
        setTimeout(() => { try { ensureFocalInGroup(rc, cand, false); } catch {} }, 0);
        return prevCamUpdate.call(this, params);
      }
      if (!grp || !grp.center || !grp.focalPos) {
        return prevCamUpdate.call(this, params);
      }
      if (!grp.focalInSelected && grp.idealFocal) {
        const cand = grp.idealFocal;
        setTimeout(() => { try { ensureFocalInGroup(rc, cand, false); } catch {} }, 0);
      }

      // In BgDVnBH9.js: camera backward axis = [rotation[6], rotation[7], rotation[8]]
      const r = params.rotation;
      const newWp = computeShiftedWorldPos(params.worldPosition, r[6], r[7], r[8], grp);
      camShiftedThisFrame = true;
      return prevCamUpdate.call(this, { ...params, worldPosition: newWp });
    };
    cam.update = wrappedCamUpdate;
    log('hooked btApp.camera.update');
  }

  function installCameraHook(eng) {
    if (cleanedUp || !eng || typeof eng.render !== 'function' || hookedEng === eng) return;
    if (hookedEng && prevRender && hookedEng.render === wrappedRender) {
      try { hookedEng.render = prevRender; } catch {}
    }
    hookedEng = eng;
    prevRender = eng.render;

    wrappedRender = function (fs, rq) {
      if (cleanedUp) {
        return prevRender.call(this, fs, rq);
      }
      state.hideFocalRider = !!(fs && fs.rig && fs.rig.hideFocalRider);
      const cam = fs && fs.camera;
      if (cam && hookedCam !== cam) {
        installCamUpdateHook(cam);
      }

      const alreadyShifted = camShiftedThisFrame;
      camShiftedThisFrame = false;

      if (alreadyShifted || !state.active || state.hideFocalRider || !cam || typeof cam.update !== 'function' || !cam.view) {
        inEngineRender = true;
        try {
          return prevRender.call(this, fs, rq);
        } finally {
          inEngineRender = false;
        }
      }

      // Fallback path (e.g. first frame before cam.update ran, or synthetic render calls)
      const app = window.btApp;
      const rc = app && app.riderController;
      if (!rc) {
        return prevRender.call(this, fs, rq);
      }

      let grp = null;
      try {
        grp = resolveTargetGroup(rc, { updateTracked: true });
      } catch {
        return prevRender.call(this, fs, rq);
      }
      if (grp && grp.waitingForFocal && grp.focalCandidate) {
        const cand = grp.focalCandidate;
        setTimeout(() => { try { ensureFocalInGroup(rc, cand, false); } catch {} }, 0);
        return prevRender.call(this, fs, rq);
      }
      if (!grp || !grp.center || !grp.focalPos) {
        return prevRender.call(this, fs, rq);
      }
      if (!grp.focalInSelected && grp.idealFocal) {
        const cand = grp.idealFocal;
        setTimeout(() => { try { ensureFocalInGroup(rc, cand, false); } catch {} }, 0);
      }

      const v = cam.view;
      const origRot = [v[0], v[4], v[8], v[1], v[5], v[9], v[2], v[6], v[10]];
      const origWp = { x: cam.worldPosition.x, y: cam.worldPosition.y, z: cam.worldPosition.z };
      const origState = {
        worldPosition: origWp,
        rotation: origRot,
        fov: cam.fov,
        aspect: cam.aspect,
        near: cam.near,
        far: cam.far,
        zoom: cam.zoom,
        origin: fs.origin,
      };
      const newWp = computeShiftedWorldPos(origWp, v[2], v[6], v[10], grp);

      inEngineRender = true;
      try {
        cam.update({
          worldPosition: newWp,
          rotation: origRot,
          fov: cam.fov,
          aspect: cam.aspect,
          near: cam.near,
          far: cam.far,
          zoom: cam.zoom,
          origin: fs.origin,
        });
        return prevRender.call(this, fs, rq);
      } catch (e) {
        return prevRender.call(this, fs, rq);
      } finally {
        try { cam.update(origState); } catch {}
        inEngineRender = false;
      }
    };
    eng.render = wrappedRender;
    log('hooked engine.render');
  }

  // ---- Native-styled Biketerra HUD pill (mounted inside `.people-status`) + anchored popover ----
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'list-pill hud-pill bg-dark gs-chip gs-chip-hidden';
  chip.title = 'Group Spectate — click for controls, or Ctrl+click a group header';

  const chipDot = document.createElement('span');
  chipDot.className = 'gs-dot';
  const chipLbl = document.createElement('span');
  chipLbl.className = 'gs-chip-lbl';
  chipLbl.textContent = 'Group Cam';
  chip.append(chipDot, chipLbl);

  const panel = document.createElement('div');
  panel.className = 'gs-panel';

  const statusEl = document.createElement('div');
  statusEl.className = 'gs-status';

  const framingFixedBtn = document.createElement('button');
  framingFixedBtn.type = 'button';
  framingFixedBtn.className = 'gs-btn';
  framingFixedBtn.textContent = 'Fixed dist';

  const framingAutoBtn = document.createElement('button');
  framingAutoBtn.type = 'button';
  framingAutoBtn.className = 'gs-btn';
  framingAutoBtn.textContent = 'Auto pull-back';

  const trackClusterBtn = document.createElement('button');
  trackClusterBtn.type = 'button';
  trackClusterBtn.className = 'gs-btn';
  trackClusterBtn.textContent = 'Live 25m pack';

  const trackDomBtn = document.createElement('button');
  trackDomBtn.type = 'button';
  trackDomBtn.className = 'gs-btn';
  trackDomBtn.textContent = 'Clicked group';

  const gapSlider = document.createElement('input');
  gapSlider.type = 'range';
  gapSlider.min = '10';
  gapSlider.max = '60';
  gapSlider.step = '5';
  const gapVal = document.createElement('span');
  gapVal.className = 'gs-val';

  const pullBackSlider = document.createElement('input');
  pullBackSlider.type = 'range';
  pullBackSlider.min = '0.5';
  pullBackSlider.max = '4.0';
  pullBackSlider.step = '0.1';
  const pullBackVal = document.createElement('span');
  pullBackVal.className = 'gs-val';

  const smoothSlider = document.createElement('input');
  smoothSlider.type = 'range';
  smoothSlider.min = '0.02';
  smoothSlider.max = '1.00';
  smoothSlider.step = '0.01';
  const smoothVal = document.createElement('span');
  smoothVal.className = 'gs-val';

  const groupsWrap = document.createElement('div');
  groupsWrap.className = 'gs-groups';

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'gs-btn danger';
  stopBtn.textContent = 'Stop (Esc)';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'gs-close-btn';
  closeBtn.title = 'Close';
  closeBtn.textContent = '\u00d7';

  const head = document.createElement('div');
  head.className = 'gs-head';
  const titleSpan = document.createElement('span');
  titleSpan.textContent = 'Group Spectate';
  head.append(titleSpan, closeBtn);

  const hint = document.createElement('div');
  hint.className = 'gs-hint';
  hint.textContent = 'Ctrl+click a group header in the rider list, or pick a live cluster below.';

  const framingSeg = document.createElement('div');
  framingSeg.className = 'gs-seg';
  framingSeg.append(framingFixedBtn, framingAutoBtn);

  const trackSeg = document.createElement('div');
  trackSeg.className = 'gs-seg';
  trackSeg.append(trackClusterBtn, trackDomBtn);

  const gapRow = document.createElement('div');
  gapRow.className = 'gs-range-row';
  const gapLbl = document.createElement('label');
  gapLbl.textContent = 'Group gap (drop)';
  gapRow.append(gapLbl, gapSlider, gapVal);

  const pullRow = document.createElement('div');
  pullRow.className = 'gs-range-row';
  const pullLbl = document.createElement('label');
  pullLbl.textContent = 'Pull-back scale';
  pullRow.append(pullLbl, pullBackSlider, pullBackVal);

  const smoothRow = document.createElement('div');
  smoothRow.className = 'gs-range-row';
  const smoothLbl = document.createElement('label');
  smoothLbl.textContent = 'Smoothing';
  smoothRow.append(smoothLbl, smoothSlider, smoothVal);

  panel.append(head, hint, statusEl, framingSeg, trackSeg, gapRow, pullRow, smoothRow, groupsWrap, stopBtn);
  document.body.append(panel);

  function findPeopleStatus() {
    return (
      document.querySelector('.hud-zone.zone-people .people-status') ||
      document.querySelector('.people-status')
    );
  }

  function ensureChipMounted() {
    if (cleanedUp) return;
    const statusBar = findPeopleStatus();
    if (statusBar) {
      chip.classList.remove('gs-chip-floating', 'gs-chip-hidden');
      if (chip.parentElement !== statusBar) {
        if (typeof statusBar.prepend === 'function') {
          statusBar.prepend(chip);
        } else {
          statusBar.append(chip);
        }
      }
      return;
    }
    // If Biketerra's `.people-status` isn't mounted yet, only show fallback floating chip once btApp is live
    if (chip.parentElement !== document.body) {
      document.body.append(chip);
    }
    chip.classList.add('gs-chip-floating');
    chip.classList.toggle('gs-chip-hidden', !window.btApp);
  }

  function positionPanel() {
    if (!panel.classList.contains('open')) return;
    if (typeof chip.getBoundingClientRect !== 'function') return;
    const rect = chip.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    const statusBar = chip.closest ? chip.closest('.people-status') : null;
    const anchor = (statusBar && typeof statusBar.getBoundingClientRect === 'function')
      ? statusBar.getBoundingClientRect()
      : rect;
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 720;
    const pad = 8;
    const gap = 6;
    const panelW = panel.offsetWidth || 300;
    const rightEdge = (anchor && anchor.right > 0) ? anchor.right : rect.right;
    const left = Math.max(pad, Math.min(vw - panelW - pad, rightEdge - panelW));
    const top = Math.max(pad, rect.bottom + gap);
    panel.style.left = Math.round(left) + 'px';
    panel.style.right = 'auto';
    panel.style.top = Math.round(top) + 'px';
    panel.style.maxHeight = Math.max(180, Math.round(vh - top - pad)) + 'px';
  }

  function setPanelOpen(open) {
    panel.classList.toggle('open', !!open);
    chip.classList.toggle('open', !!open);
    if (open) {
      refreshClustersList();
      positionPanel();
    }
  }

  const onDocOutsideClick = (e) => {
    if (!panel.classList.contains('open')) return;
    if (e.ctrlKey || e.metaKey) return;
    const path = typeof e.composedPath === 'function' ? e.composedPath() : null;
    if ((path && (path.includes(panel) || path.includes(chip))) || panel.contains(e.target) || chip.contains(e.target)) {
      return;
    }
    setPanelOpen(false);
  };
  document.addEventListener('click', onDocOutsideClick, false);

  const onResize = () => positionPanel();
  window.addEventListener('resize', onResize);

  ensureChipMounted();
  const quickMountTimer = setTimeout(ensureChipMounted, 150);

  chip.addEventListener('click', () => {
    setPanelOpen(!panel.classList.contains('open'));
  });
  closeBtn.addEventListener('click', () => setPanelOpen(false));
  stopBtn.addEventListener('click', stopGroupSpectate);

  async function saveSetting(key, val) {
    S[key] = val;
    syncUi();
    try { await terra.settings.set(key, val); } catch {}
  }

  framingFixedBtn.addEventListener('click', () => saveSetting('framingMode', 'fixed'));
  framingAutoBtn.addEventListener('click', () => saveSetting('framingMode', 'auto'));
  trackDomBtn.addEventListener('click', () => saveSetting('trackMode', 'dom'));
  trackClusterBtn.addEventListener('click', () => saveSetting('trackMode', 'cluster'));
  gapSlider.addEventListener('input', () => {
    S.clusterRadius = Number(gapSlider.value);
    gapVal.textContent = Math.round(S.clusterRadius) + ' m';
  });
  gapSlider.addEventListener('change', () => saveSetting('clusterRadius', Number(gapSlider.value)));
  pullBackSlider.addEventListener('input', () => {
    S.pullBackFactor = Number(pullBackSlider.value);
    pullBackVal.textContent = S.pullBackFactor.toFixed(1) + 'x';
  });
  pullBackSlider.addEventListener('change', () => saveSetting('pullBackFactor', Number(pullBackSlider.value)));
  smoothSlider.addEventListener('input', () => {
    S.smoothing = Number(smoothSlider.value);
    smoothVal.textContent = S.smoothing.toFixed(2);
  });
  smoothSlider.addEventListener('change', () => saveSetting('smoothing', Number(smoothSlider.value)));

  function syncUi() {
    chip.classList.toggle('active', state.active);
    chipLbl.textContent = state.active
      ? `Group \u00b7 ${state.lastMemberCount || '?'}`
      : 'Group Cam';
    const focalTxt = state.focalLabel ? ` \u00b7 focal: ${state.focalLabel}` : '';
    statusEl.classList.toggle('active', state.active);
    statusEl.textContent = state.active
      ? `${state.label} \u00b7 ${state.lastMemberCount} riders${focalTxt} \u00b7 ${state.lastSpread.toFixed(1)} m radius \u00b7 +${state.smoothBack.toFixed(1)} m`
      : 'Inactive \u2014 watching single rider normally.';
    framingFixedBtn.classList.toggle('on', S.framingMode === 'fixed');
    framingAutoBtn.classList.toggle('on', S.framingMode === 'auto');
    trackDomBtn.classList.toggle('on', S.trackMode === 'dom');
    trackClusterBtn.classList.toggle('on', S.trackMode === 'cluster');
    gapSlider.value = String(clamp(S.clusterRadius, 10, 60));
    gapVal.textContent = Math.round(clamp(S.clusterRadius, 10, 60)) + ' m';
    pullBackSlider.value = String(clamp(S.pullBackFactor, 0.5, 4.0));
    pullBackVal.textContent = clamp(S.pullBackFactor, 0.5, 4.0).toFixed(1) + 'x';
    pullRow.style.display = S.framingMode === 'auto' ? '' : 'none';
    smoothSlider.value = String(clamp(S.smoothing, 0.02, 1.0));
    smoothVal.textContent = clamp(S.smoothing, 0.02, 1.0).toFixed(2);
    stopBtn.style.display = state.active ? '' : 'none';
    if (panel.classList.contains('open')) positionPanel();
  }

  function refreshClustersList() {
    if (!panel.classList.contains('open')) return;
    const app = window.btApp;
    const rc = app && app.riderController;
    groupsWrap.replaceChildren();
    if (!rc) {
      groupsWrap.append(Object.assign(document.createElement('div'), { className: 'gs-hint', textContent: 'Waiting for Biketerra engine\u2026' }));
      return;
    }
    const entries = allBtRiders(rc).filter((e) => !e.culled);
    const clusters = computeClusters(entries, clamp(S.clusterRadius, 3, 200));
    if (!clusters.length) {
      groupsWrap.append(Object.assign(document.createElement('div'), { className: 'gs-hint', textContent: 'No active riders visible.' }));
      return;
    }
    clusters.slice(0, 8).forEach((cl, idx) => {
      const names = [];
      const keys = [];
      for (const m of cl) {
        if (m.names.length) names.push(m.names[0]);
        if (m.key) keys.push(m.key);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      const isCurrent = state.active && keys.some((k) => state.trackedKeys.has(k));
      btn.className = 'gs-btn gs-group-btn' + (isCurrent ? ' on' : '');
      const hasFocal = cl.some((m) => m.isFocal);
      const firstLabel = cl.map((m) => {
        const cfg = m.r.config || {};
        return (cfg.first_name || cfg.name || 'Rider').trim();
      }).slice(0, 2).join(', ');
      const title = document.createElement('span');
      title.textContent = `Group ${idx + 1}${hasFocal ? ' \u2605' : ''}: ${firstLabel}${cl.length > 2 ? '\u2026' : ''}`;
      const meta = document.createElement('span');
      meta.className = 'gs-group-meta';
      meta.textContent = `${cl.length} rider${cl.length === 1 ? '' : 's'}`;
      btn.append(title, meta);
      btn.addEventListener('click', (e) => {
        if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
        activateGroup({
          label: `Group ${idx + 1}`,
          names,
          keys,
        });
        refreshClustersList();
      });
      groupsWrap.append(btn);
    });
  }

  syncUi();

  const watchTimer = setInterval(() => {
    ensureChipMounted();
    if (document.body.classList.contains('gs-ctrl-held')) {
      markDetectedHeaders();
    }
    refreshDomRanks();
    const app = window.btApp;
    const rc = app && app.riderController;
    if (app && app.camera && typeof app.camera.update === 'function' && hookedCam !== app.camera) {
      installCamUpdateHook(app.camera);
    }

    if (state.active && rc) {
      const grp = resolveTargetGroup(rc, { updateTracked: false });
      if (grp && grp.waitingForFocal && grp.focalCandidate) {
        ensureFocalInGroup(rc, grp.focalCandidate, false);
      } else if (grp && !grp.focalInSelected && grp.idealFocal) {
        ensureFocalInGroup(rc, grp.idealFocal, false);
      }
      state.focalLabel = rc.focalRider ? riderDisplayName(rc.focalRider) : '';
    }

    if (state.active || panel.classList.contains('open')) syncUi();
    refreshClustersList();

    if (!app) return;
    if (app.engine && typeof app.engine.render === 'function' && hookedEng !== app.engine) {
      installCameraHook(app.engine);
      return;
    }
    if (!app.engine && typeof app.addFeature === 'function' && featureApp !== app) {
      featureApp = app;
      try {
        app.addFeature((scope, env) => ({
          frame(fs) {
            if (fs && fs.camera && hookedCam !== fs.camera) {
              installCamUpdateHook(fs.camera);
            }
            if (env && env.engine && hookedEng !== env.engine) {
              installCameraHook(env.engine);
            }
          },
        }));
      } catch {}
    }
  }, 400);

  terra.onCleanup(() => {
    cleanedUp = true;
    clearTimeout(quickMountTimer);
    clearInterval(watchTimer);
    document.removeEventListener('click', onCaptureClick, true);
    document.removeEventListener('click', onDocOutsideClick, false);
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', onResize);
    document.body.classList.remove('gs-ctrl-held');
    document.querySelectorAll('.gs-group-active-hdr').forEach((el) => el.classList.remove('gs-group-active-hdr'));
    document.querySelectorAll('[data-gs-group-header]').forEach((el) => el.removeAttribute('data-gs-group-header'));
    try {
      if (hookedCam && prevCamUpdate && hookedCam.update === wrappedCamUpdate) {
        hookedCam.update = prevCamUpdate;
      }
    } catch {}
    try {
      if (hookedEng && prevRender && hookedEng.render === wrappedRender) {
        hookedEng.render = prevRender;
      }
    } catch {}
    try { chip.remove(); panel.remove(); } catch {}
    log('cleaned up');
  });
})();
