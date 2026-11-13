// Auto Trainer — decide bike vs row and steer Terra's auto-pair at the right trainer.
//
// There is no "row lobby" — the same activities are done on a bike or a rower, and the
// mode is whatever the user set up. So the decision is made from intent signals, in order
// (cog setting "Mode"):
//   1. manual override          mode = bike | row
//   2. the Ride controller      zwift-ride publishes window.__zwiftRideState:
//                               connected → bike (the instant it links); controller
//                               stowed → row; no controller in play → no signal
//   3. last-used trainer        the mode of the most recently paired trainer (any manual pick
//                               or auto-pair updates it — pair the other trainer once to switch)
//   4. default                  bike
//
// Publishes for Terra core (the shim's silent auto-pair) and wifi-trainer-bridge:
//   window.__terraMode       'bike' | 'row'
//   window.__terraModeReady  promise resolving once the mode is decided
//   window.__terraPrefer     { bike: <namePrefix>, row: <namePrefix> }
(() => {
  const W = window;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).trim();

  async function settings() {
    try { return (await terra.settings.all()) || {}; } catch { return {}; }
  }

  // The Ride controller (zwift-ride's button controller) is the bike/row signal:
  //   connected > 0 → it's up     → bike (the instant it links)
  //   waiting > 0   → it's stowed → row
  //   neither       → no controller in play → no signal (→ last-used)
  //
  // It's already linked by the time a ride starts (paired on the dashboard via zwift-ride),
  // so a connected one resolves bike immediately and a stowed one is a row — no long wait.
  // Two small hedges, neither of which is "waiting for your controller":
  //   • zwift-ride may boot AFTER us (auto-trainer sorts first) → poll until it publishes.
  //   • a just-registered controller still finishing its attach reads {connected:0,waiting:1}
  //     for a moment, identical to a stowed one → give it ~1 s to finish linking before we
  //     call it stowed. So the only real cost left is ~1 s on a row session.
  async function controllerSignal() {
    const GRACE = 1000, deadline = Date.now() + 3000;
    let stowedSince = null;
    for (;;) {
      const st = W.__zwiftRideState;
      if (st) {
        if (st.connected > 0) return 'bike';
        if (st.waiting > 0) {
          if (stowedSince === null) stowedSince = Date.now();
          if (Date.now() - stowedSince >= GRACE) return 'row';
        }
      }
      if (Date.now() >= deadline) return stowedSince !== null ? 'row' : null;
      await sleep(200);
    }
  }

  async function lastUsed() {
    try {
      const m = await terra.storage.get('lastUsed', null);
      return m === 'bike' || m === 'row' ? m : null;
    } catch { return null; }
  }

  async function resolve() {
    const s = await settings();
    const forced = norm(s.mode || 'auto').toLowerCase();
    if (forced === 'bike' || forced === 'row') return { mode: forced, source: 'override' };
    const ctrl = await controllerSignal();
    if (ctrl) return { mode: ctrl, source: 'controller' };
    const lu = await lastUsed();
    if (lu) return { mode: lu, source: 'last-used' };
    return { mode: 'bike', source: 'default' };
  }

  function modeForName(name, s) {
    const n = String(name || '').trim();
    const bike = norm(s.bikePrefix || 'KICKR');
    const row = norm(s.rowPrefix || 'MRK-R11S');
    if (bike && n.startsWith(bike)) return 'bike';
    if (row && n.startsWith(row)) return 'row';
    return null;
  }

  // Whatever trainer actually gets paired (a manual pick or an auto-pair) is what the
  // user is riding right now → remember it as the default for next time. Pairing the
  // other trainer once is how you switch.
  terra.ble.onPaired(async (e) => {
    try {
      const s = await settings();
      const m = modeForName(e && e.name, s);
      if (m) {
        await terra.storage.set('lastUsed', m);
        terra.log('last-used trainer =', m, '(' + (e && e.name) + ')');
      }
    } catch (err) {
      // Never let a bookkeeping hiccup break the actual pairing; but don't swallow it
      // silently — "lastUsed not updating" is otherwise invisible while debugging.
      try { terra.log('onPaired (last-used) skipped:', err && err.message || err); } catch {}
    }
  });

  let inFlight = null;
  function apply() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { mode, source } = await resolve();
        const s = await settings();
        W.__terraMode = mode;
        W.__terraPrefer = { bike: norm(s.bikePrefix || 'KICKR'), row: norm(s.rowPrefix || 'MRK-R11S') };
        try { terra.bus.emit('terra:mode', { mode, source, prefer: W.__terraPrefer }); } catch {}
        terra.log('mode=' + mode, 'via', source, 'prefer', W.__terraPrefer);
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  // Decide at boot; re-decide only when a setting changes (the mode is per session setup,
  // not per page — there is no row lobby to detect).
  W.__terraModeReady = apply();
  W.__terraModeReady.catch(() => {}); // never leak an unhandled rejection
  terra.settings.onChange(() => apply());

  terra.onCleanup(() => {
    delete W.__terraMode;
    delete W.__terraPrefer;
    delete W.__terraModeReady;
  });
})();
