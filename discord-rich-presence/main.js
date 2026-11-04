/**
 * Discord Rich Presence for Biketerra rides.
 *
 * While on a ride (or spectating) it shows on your Discord profile:
 *
 *   Riding — Alpine Loop 50          (details, from the route/event name)
 *   42.3 km of 50 km · 04:12         (state, live distance + elapsed time)
 *   Elapsed time (Discord timer line, driven by `start`)
 *
 * Updates are handed straight to the Terra core (terra.discord.*), which talks to
 * Discord's local IPC socket itself. No sidecar, no extra process, no Node — the
 * core is the only thing that needs to reach Discord desktop's Unix socket.
 */

// ------------------------------------------------------------------- settings

const DEFAULTS = { updateSeconds: 20, imageKey: 'bike', showButton: true, showIdle: true };
let cachedSettings = null;
function s() {
  // terra.settings.all() may resolve to a partial object (e.g. {} after the
  // user has not touched the cog menu); merge over the defaults rather than
  // short-circuiting them.
  return Object.assign({}, DEFAULTS, cachedSettings);
}
terra.settings.all().then((v) => {
  cachedSettings = v;
});
terra.settings.onChange(() => {
  cachedSettings = null;
  terra.settings.all().then((v) => {
    cachedSettings = v;
    if (state.kind) { pushNow(); return; } // ride/spectate page (armed or landed-un-armed)
    if (idleEnabled()) { pushNow(); return; } // idle turned on
    clearPresence(true); // nothing to show
  });
});

// --------------------------------------------------------------------- state

const state = {
  kind: null,        // 'ride' | 'spectate' | 'event' | null (page kind)
  key: null,         // navigation identity (pathname + ride id) — guards against
                     // intra-page pushState/hash noise resetting a live ride
  name: null,        // route / event name (best effort)
  startedAt: null,   // ms epoch when the ride clock started (set once, kept stable)
  distanceM: null,   // latest ego.distance (meters)
  totalEgoM: null,   // ego.distance + ego.distanceRemaining (fallback route total)
  totalRouteM: null, // authoritative route length (route/event detail page, else geometry)
  riderCount: null,  // number of riders in the (spectated) ride, when known
  idleLabel: null,   // non-ride page label ('On dashboard' / 'Viewing results')
  riding: false,     // on a ride/spectate/event page (landing state before arming)
  landedAt: 0,       // when we last landed on the ride page without arming (grace timer)
  lastKey: null,     // JSON of the last successfully pushed payload
};
let lastFrameAt = 0;
let lastPushAt = 0;
let warnedNoClient = false;
let lastHealth = '';

// A ride is "live" while its frame stream is still flowing. Frames arrive ~2 Hz,
// so a gap past this means the ride has stopped (we left it, or it ended). Holding
// the green clock across such a gap would leak one session's timer into the next
// (e.g. spectate for 10 min -> leave -> new ride already reads 10:00).
const LIVE_MS = 8000;
function framesLive() {
  return lastFrameAt > 0 && (Date.now() - lastFrameAt) < LIVE_MS;
}

terra.log('Discord Rich Presence addon started');

function errMsg(e) {
  return (e && e.message) || String(e);
}

function updateMs() {
  return Math.max(5, Number(s().updateSeconds) || 20) * 1000;
}

function noteHealth(ok, msg) {
  const key = ok ? 'ok' : 'err:' + msg;
  if (key === lastHealth) return;
  lastHealth = key;
  if (ok) terra.log('Discord Rich Presence: updating Discord OK');
  else terra.log('Discord Rich Presence: ' + msg);
}

// ------------------------------------------------------ route / event naming

function describeUrl(u) {
  if (u.pathname.startsWith('/spectate')) {
    const name = u.searchParams.get('name') || u.searchParams.get('route') || u.searchParams.get('event') || null;
    return { kind: 'spectate', name, eventId: null };
  }
  // Biketerra marks spectating on a normal /ride URL with ?spectate=1.
  const spect = u.searchParams.get('spectate');
  if (u.pathname.startsWith('/ride')) {
    const event = u.searchParams.get('event');
    if (event) {
      const kind = spect ? 'spectate' : 'event';
      return { kind, name: spect ? null : 'Event ' + event, eventId: event };
    }
    const m = (document.title || '').match(/^Ride - (.+) - Biketerra$/);
    const kind = spect ? 'spectate' : 'ride';
    return { kind, name: m ? m[1].trim() : null, eventId: null };
  }
  return { kind: null, name: null, eventId: null };
}

// A "ride identity" for a URL: the pathname plus whichever param names the ride
// (route / event / name). Used to tell a real navigation (new ride, or left the
// page) from intra-page pushState/hash change noise that Biketerra emits while a
// ride is live. Re-initializing on that noise is what was dropping the running
// presence's start clock back to now → the green timer snapping to 0:00.
function rideKey(href) {
  try {
    const u = new URL(href);
    const id =
      u.searchParams.get('route') ||
      u.searchParams.get('event') ||
      u.searchParams.get('name') ||
      '';
    // The spectate flag is part of the identity: riding a route vs spectating
    // the same route id (?spectate=1) must count as a real navigation so the
    // presence relabels itself.
    const spect = u.searchParams.get('spectate') ? 'S' : '';
    return u.pathname + '#' + id + spect;
  } catch (_) {
    return String(href);
  }
}

// ----------------------------------------------------- route name + total km
//
// ego.distance + ego.distanceRemaining is NOT a reliable route total when you
// load or spectate a ride already partway through. The authoritative length —
// and, when the page title is thin, the route/event's display name — live on
// the ride's detail page, the same page the app itself renders:
//
//   ride ?route=<id> → biketerra.com/routes/<id> → .route-stats
//   ride ?event=<id> → biketerra.com/events/<id> → .route-tile_stats
//
// We fetch that page, read the distance out of its stats element and the name
// out of its <title>. If the stats element isn't in the HTML we fall back to
// the ride's __data.json geometry length, then to the ego-derived total.

function haversineM(a, b) {
  const R = 6371000, t = Math.PI / 180;
  const dLat = (b[0] - a[0]) * t, dLng = (b[1] - a[1]) * t;
  const l1 = a[0] * t, l2 = b[0] * t;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(l1) * Math.cos(l2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function polylineM(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}
function findPolylines(obj, out) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    if (obj.length >= 2 && Array.isArray(obj[0]) && typeof obj[0][0] === 'number' && typeof obj[0][1] === 'number') {
      out.push(obj);
    } else {
      obj.forEach((x) => findPolylines(x, out));
    }
  } else {
    for (const k of Object.keys(obj)) findPolylines(obj[k], out);
  }
  return out;
}
// The page's __data.json URL, or null if this page has no route geometry.
function routeDataUrl(u) {
  if (u.pathname.startsWith('/spectate/')) {
    const id = u.pathname.split('/')[2];
    return id ? u.origin + '/spectate/' + id + '/__data.json' : null;
  }
  if (u.pathname.startsWith('/ride')) {
    const e = u.searchParams.get('event'), r = u.searchParams.get('route');
    if (e) return u.origin + '/ride/__data.json?event=' + encodeURIComponent(e);
    if (r) return u.origin + '/ride/__data.json?route=' + encodeURIComponent(r);
  }
  return null;
}
// Parse a distance out of a stats string like "50.2 km · 900 m of climbing".
// Kilometers and miles are matched by unit; bare meters are a last resort.
function extractDistanceM(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, ' ').trim();
  const num = (s) => { const v = parseFloat(String(s).replace(/[, ]/g, '')); return (isFinite(v) && v > 0) ? v : null; };
  let m, v;
  if ((m = t.match(/([\d][\d.,]*)\s*(?:km|kilomet(?:e|er)s?|kilometers?)/i))) {
    if ((v = num(m[1])) != null) return Math.round(v * 1000);
  }
  if ((m = t.match(/([\d][\d.,]*)\s*(?:mi\b|miles?|statute)/i))) {
    if ((v = num(m[1])) != null) return Math.round(v * 1609.34);
  }
  if ((m = t.match(/([\d][\d.,]*)\s*m(?![a-zA-Z])/i))) {
    if ((v = num(m[1])) != null) return Math.round(v);
  }
  return null;
}

// Candidate ride/event detail pages for the current URL, in preference order.
// Two spectate URL shapes exist: /ride?route=<id>&spectate=1 and a direct
// /spectate/<id> page whose id may be an event id OR a route id. For the
// direct page we try both public detail pages and use whichever the site
// actually publishes for that id (the other 404s).
function detailCandidates(u) {
  const out = [];
  try {
    const origin = u.origin;
    const routeId = u.searchParams.get('route');
    const eventId = u.searchParams.get('event');
    if (u.pathname.startsWith('/spectate/')) {
      const id = u.pathname.split('/')[2];
      if (id) {
        out.push(origin + '/events/' + encodeURIComponent(id));
        out.push(origin + '/routes/' + encodeURIComponent(id));
      }
    } else {
      if (routeId) out.push(origin + '/routes/' + encodeURIComponent(routeId));
      if (eventId) out.push(origin + '/events/' + encodeURIComponent(eventId));
    }
  } catch (_) { /* leave empty */ }
  return out;
}

let routeFetchPending = null;
// Returns { lengthM, name } for the ride's route/event. Either field may be null:
//   name    → the detail page's <title> (skipping Biketerra's boilerplate)
//   lengthM → the detail page's stats element, else the __data.json geometry
async function fetchRouteMeta(href) {
  if (routeFetchPending) return routeFetchPending; // coalesce duplicate fetches
  let details = null, geo = null;
  try {
    const u = new URL(href);
    details = detailCandidates(u);
    geo = routeDataUrl(u);
  } catch (_) { /* handled below */ }
  if (!details.length && !geo) return { lengthM: null, name: null };

  routeFetchPending = (async () => {
    const out = { lengthM: null, name: null };
    // Detail page(s): name from <title>, distance from the stats element.
    // /spectate/<id> may publish under /events/<id> or /routes/<id> — try in
    // order, keep the first page that yields a name.
    for (const page of details) {
      try {
        const res = await fetch(page, { credentials: 'include' });
        if (!res.ok) continue;
        const html = await res.text();
        terra.log('detail page ok: ' + page);
        const title = html.match(/<title>([^<]+?)\s*-\s*Biketerra<\/title>/i);
        if (title) {
          const n = title[1].trim();
          if (n && n !== 'Ride virtually, anywhere') out.name = n;
        }
        if (typeof DOMParser === 'function') {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const el = doc.querySelector('.route-stats') || doc.querySelector('.route-tile_stats');
          if (el && out.lengthM == null) out.lengthM = extractDistanceM(el.textContent);
        }
        if (out.name != null) break;
      } catch (e) { /* try next candidate */ }
    }
    // 2) __data.json geometry as the fallback distance source.
    if (out.lengthM == null && geo) {
      try {
        const res = await fetch(geo, { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          const lines = findPolylines(data, []);
          if (lines.length) {
            const m = Math.max(...lines.map(polylineM));
            if (m > 100 && m < 2e7) out.lengthM = Math.round(m);
          }
        }
      } catch (e) { /* best effort */ }
    }
    return out;
  })();
  const r = await routeFetchPending;
  routeFetchPending = null;
  return r;
}

async function initForUrl(href) {
  const u = new URL(href);
  const info = describeUrl(u);
  state.key = rideKey(href);
  state.kind = info.kind;
  if (state.startedAt) {
    terra.log('[reinit] DROPPING a running presence clock before init: had start=' + state.startedAt
      + ' kind=' + state.kind + ', new kind=' + info.kind + ' href=' + href);
  }
  state.name = info.name;
  state.startedAt = null;
  state.distanceM = null;
  state.totalEgoM = null;
  state.totalRouteM = null;
  state.lastKey = null;
  // Pull the authoritative route meta (the "XX of YY km" total, plus the
  // route/event name) from the ride's detail page. Best-effort — the ego-derived
  // total and the title-derived name remain as the fallbacks.
  if (state.kind === 'ride' || state.kind === 'event' || state.kind === 'spectate') {
    fetchRouteMeta(href).then((meta) => {
      if (!(state.kind === 'ride' || state.kind === 'event' || state.kind === 'spectate')) return;
      if (meta.lengthM != null) {
        state.totalRouteM = meta.lengthM;
        terra.log('route length from detail page: ' + (meta.lengthM / 1000).toFixed(1) + ' km');
      }
      // Override the name only when the detail page offers a real display name
      // and what we have is weak (a raw id, or the "Event <id>" default).
      // Note: event/championship names can be long ("🕒Chrono Championship
      // october 2026 - Week 5 - Island Harbour Loop" = 65 chars), so don't cap
      // at 60, and don't require a space (single-word names are legitimate).
      const looksLikeId = (n) => /^event\s+[\d-]+$/i.test(n) || /^[0-9a-f_-]+$/i.test(n) || /^[\d._-]+$/.test(n);
      const generic = (n) => /^(ride|virtual ride|log in|sign in|pricing|about|blog|help center?|terms|privacy|compare apps)$/i.test(n);
      const isDisplay = (n) => typeof n === 'string' && n.trim().length > 0 && n.trim().length <= 100 && !looksLikeId(n.trim()) && !generic(n.trim());
      if (isDisplay(meta.name) && !isDisplay(state.name)) {
        const had = state.name;
        state.name = meta.name;
        state.lastKey = null;
        pushNow(); // re-render the name (armed OR landed-un-armed ride page)
        terra.log('route name from detail page: ' + meta.name + (had ? ' (was ' + had + ')' : ''));
      } else if (meta.name && !isDisplay(meta.name)) {
        terra.log('detail page name rejected by display gate: ' + meta.name + ' (len=' + meta.name.length + ')');
      }
    }).catch(() => {});
  }
  if (state.kind === 'ride' && !state.name) {
    // document.title may render after activation; re-check it once it looks right.
    const check = () => {
      if (state.kind !== 'ride') return false;
      const m = (document.title || '').match(/^Ride - (.+) - Biketerra$/);
      if (m) {
        state.name = m[1].trim();
        return true;
      }
      return false;
    };
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (check() || n > 10) clearInterval(t);
    }, 1500);
  }
  if (state.kind) {
    // Ride/spectate/event page: show the presence the moment we land (name, no
    // clock yet) so the stale "On dashboard" / previous page is replaced
    // instantly. The distance line + green timer appear on arming (movement for
    // rides, first broadcast frame for spectating). If the ride never starts,
    // the grace timer in the main loop drops it again (no fake presence).
    state.idleLabel = null;
    state.riding = true;
    state.landedAt = Date.now();
    pushNow();
  } else {
    // Non-ride page: swap in the idle presence now (clearPresence in onNavigate
    // already dropped whatever we showed before). Idle pages have no clock to
    // arm, so there is nothing to wait for.
    state.riding = false;
    state.landedAt = 0;
    state.idleLabel = idleEnabled() ? idleLabel(href) : null;
    pushNow();
  }
  return state.kind;
}

// -------------------------------------------------------------- idle presence
//
// While not riding or spectating we still show a low-key "what am I doing"
// presence. Labels come from the URL path + <title>; the app's known pages get
// specific labels and everything else (login, settings, …) reads as the
// dashboard. No green timer — the clock stays reserved for riding/watching.

function idleEnabled() {
  return s().showIdle !== false;
}
// Non-ride page → label. Known pages get a real name; the rest (dashboard,
// login, athletes, …) falls back to "On dashboard" — per user preference.
const IDLE_LABELS = [
  [/^\/routes(\/|$)/,         'Browsing routes'],
  [/^\/events(\/|$)/,         'Browsing events'],
  [/^\/clubs(\/|$)/,          'Browsing clubs'],
  [/^\/challenges(\/|$)/,     'Browsing challenges'],
  [/^\/(activities\/[^/]+|results)/, 'Viewing results'],
];
function idleLabel(href) {
  try {
    const u = new URL(href);
    const path = u.pathname.toLowerCase();
    for (const [re, label] of IDLE_LABELS) if (re.test(path)) return label;
    if ((document.title || '').toLowerCase().includes('result')) return 'Viewing results';
  } catch (_) {}
  return 'On dashboard';
}

// ------------------------------------------------------------- ride tracking

let egoKeysLogged = false;
let ridersLogged = false;
const offRide = terra.ride.onRide((frame) => {
  lastFrameAt = Date.now();
  const ego = frame && frame.ego;
  if (!ego) return;
  // Track who is in the ride (the presence's "N riders" for spectating, and a
  // useful field to have). Also sniff the shape once so we can surface names.
  const riders = frame && frame.riders;
  if (Array.isArray(riders) && riders.length) state.riderCount = riders.length;
  if (!ridersLogged) {
    ridersLogged = true;
    try {
      const shape = Array.isArray(riders) ? ('array[' + riders.length + ']') : String(typeof riders);
      const sample = Array.isArray(riders) && riders[0] ? JSON.stringify(riders[0]).slice(0, 240) : '';
      terra.log('riders field: ' + shape + (sample ? ' — sample: ' + sample : ''));
    } catch (_) {}
  }
  if (!egoKeysLogged) {
    egoKeysLogged = true;
    terra.log('ego frame fields: ' + Object.keys(ego).join(', '));
  }
  if (typeof ego.distance === 'number' && isFinite(ego.distance)) {
    state.distanceM = ego.distance;
    // Fallback route total (used only when __data.json didn't give us one).
    if (typeof ego.distanceRemaining === 'number' && isFinite(ego.distanceRemaining)) {
      state.totalEgoM = ego.distance + ego.distanceRemaining;
    }
  }
  // Don't arm (or re-arm) a presence unless we are on a ride/spectate/event
  // page. This is what stops the "still counting after I quit" case: once we
  // navigate to a non-ride page, state.kind is null and further frames are
  // ignored instead of re-starting the clock.
  if (!state.kind) return;
  const moving =
    (typeof ego.distance === 'number' && ego.distance > 0) ||
    ((ego.speed || 0) > 0.5 && (ego.cadence || 0) > 5);
  // Spectating: we are already "in" the ride — arm on the first frame, no
  // movement required (the broadcast ego usually doesn't track you moving).
  // Riding / in an event: wait for real movement so we don't show a fake live
  // presence while merely sitting on the ride page.
  const active = state.kind === 'spectate' || moving;
  if (active && !state.startedAt) {
    state.startedAt = Date.now();
    state.riding = true;
    state.landedAt = 0;
    terra.log((state.kind === 'spectate' ? 'spectate' : 'ride') + ' presence starting: ' + (state.name || '(name pending)'));
    pushNow();
  }
});

// --------------------------------------------------------------- presence

function fmtDist(m) {
  if (m == null || !isFinite(m) || m < 0) return null;
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
}

// Read the live ride elapsed time from the app's DOM (.timer-elapsed, e.g. "03:46").
// Falls back to the addon's own startedAt clock.
function getRideElapsedSec() {
  try {
    const el = document.querySelector('.timer-elapsed');
    if (el && el.textContent) {
      const parts = el.textContent.trim().split(':').map(Number);
      if (parts.length >= 2 && parts.every((n) => Number.isFinite(n) && n >= 0)) {
        return parts.reduce((acc, n) => acc * 60 + n, 0);
      }
    }
  } catch (_) {}
  if (state.startedAt) {
    return Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  }
  return 0;
}

function fmtElapsed(sec) {
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h > 0 ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function withButton(p) {
  const showBtn = s().showButton === undefined ? true : Boolean(s().showButton);
  if (showBtn) p.buttons = [{ label: 'biketerra.com', url: 'https://biketerra.com' }];
  return p;
}

function buildPayload() {
  const cid = String(s().clientId || '').trim();
  if (!cid) return null;
  const name = (state.name || '').trim();

  // Non-ride page (dashboard, results, login, …): the idle "what am I doing"
  // line, no green timer (that's reserved for riding/watching).
  if (!state.kind) {
    if (!idleEnabled()) return null;
    return withButton({
      clientId: cid,
      details: state.idleLabel || 'On dashboard',
      // no `start` on purpose: idle pages carry no elapsed clock
      largeImage: String(s().imageKey || 'bike').slice(0, 32),
      largeText: 'Biketerra',
    });
  }

  // Spectating: the ride's distance/clock aren't the point (the broadcast ego
  // often reads 0 here anyway). Show the route context and who's riding, and
  // keep the green "elapsed" timer (time spent watching).
  if (state.kind === 'spectate') {
    const details = name ? 'Spectating — ' + name : 'Spectating on Biketerra';
    const totalM = state.totalRouteM != null ? state.totalRouteM : state.totalEgoM;
    let line = '';
    if (totalM != null) line = fmtDist(totalM) + ' route';
    if (state.riderCount) line += (line ? ' · ' : '') + state.riderCount + (state.riderCount === 1 ? ' rider' : ' riders');
    return withButton({
      clientId: cid,
      details,
      state: line,
      start: state.startedAt,
      largeImage: String(s().imageKey || 'bike').slice(0, 32),
      largeText: (name || 'Biketerra').slice(0, 32),
    });
  }

  // Riding / in an event: show the route the moment we land on the page; the
  // distance line + green timer appear only once the ride is armed (moving).
  const armed = Boolean(state.startedAt);
  const label = state.kind === 'event' ? 'In event' : 'Riding';
  const details = name ? label + ' — ' + name : label + ' on Biketerra';
  let line = '';
  if (armed) {
    const dist = fmtDist(state.distanceM);
    // Prefer the authoritative route length; fall back to the ego-derived one.
    const totalM = state.totalRouteM != null ? state.totalRouteM : state.totalEgoM;
    const total = fmtDist(totalM);
    const elapsedStr = fmtElapsed(getRideElapsedSec());
    if (dist) line = dist;
    // Only show "of YY" when it is a sensible upper bound (>= current distance).
    if (totalM != null && dist && total !== dist && totalM >= state.distanceM) line += (line ? ' of ' : '') + total;
    if (elapsedStr) line += (line ? ' · ' : '') + elapsedStr;
  }
  const payload = {
    clientId: cid,
    details,
    state: line,
    largeImage: String(s().imageKey || 'bike').slice(0, 32),
    largeText: (name || 'Biketerra').slice(0, 32),
  };
  if (armed) payload.start = state.startedAt;
  return withButton(payload);
}

function warnNoClient() {
  if (warnedNoClient) return;
  warnedNoClient = true;
  terra.log('Discord Rich Presence: set the "Discord application Client ID" setting ' +
    '(discord.com/developers → your app → General Information → Client ID). The Terra ' +
    'core pushes it straight to Discord desktop — no sidecar needed.');
}

async function pushNow() {
  const cid = String(s().clientId || '').trim();
  if (!cid) {
    warnNoClient();
    return;
  }
  // A ride/spectate presence exists while it is armed, or while we are on that
  // ride page waiting to arm (the "landing" state). After a clear (quit, stale
  // frames, addon off) riding=false keeps an un-armed "Riding…" from
  // resurrecting — it only comes back when we arm again or land on a ride page.
  if (state.kind && !state.startedAt && !state.riding) return;
  const payload = buildPayload();
  if (!payload) return; // idle presence turned off — nothing to show
  const key = JSON.stringify(payload);
  if (key === state.lastKey && Date.now() - lastPushAt < updateMs()) return; // rate window
  try {
    await terra.discord.setActivity(payload);
    state.lastKey = key;
    lastPushAt = Date.now();
    terra.log('[push] OK start=' + payload.start + ' | ' + (payload.details || '') + ' | ' + (payload.state || ''));
    noteHealth(true, '');
  } catch (e) {
    state.lastKey = null; // retry on the next tick (the core reconnects to Discord)
    noteHealth(false, errMsg(e));
  }
}

async function clearPresence(silent) {
  const cid = String(s().clientId || '').trim();
  if (!cid) {
    if (!silent) terra.log('clearPresence: no clientId set, skipping');
    return;
  }
  // A cleared session has no live clock: kill the green timer locally so the NEXT
  // ride/spectate arms a fresh `start` instead of inheriting this one. Clearing the
  // Discord presence and ending the local session are the same moment, so the clock
  // should always die here — regardless of whether the socket write succeeds.
  state.startedAt = null;
  state.riding = false;
  state.landedAt = 0;
  state.lastKey = null;
  lastPushAt = 0;
  if (!silent) terra.log('[clear] clearing presence (clientId=' + cid + ')');
  try {
    await terra.discord.clear(cid);
    state.lastKey = null;
    if (!silent) noteHealth(true, '');
  } catch (e) {
    const msg = errMsg(e);
    if (!silent) noteHealth(false, 'clearing presence: ' + msg);
    else terra.log('[clear] error: ' + msg);
  }
}

// ------------------------------------------------------------------ main loop

// Every 5 s: push presence (distance/elapsed updates), and drop it if the
// frame stream has been silent for STALE_MS (ride ended / tab closed).
// Frames stopped = ride ended (the app stops broadcasting). 15 s is short
// enough to feel prompt on a real quit when the app stays on the same page,
// yet long enough to ride through a brief BLE/broadcast hiccup mid-ride.
const STALE_MS = 15 * 1000;
// The landed (not-yet-moving) ride presence is a brief "we're on the ride page"
// state. If no ride actually starts within this grace, drop it again — no fake
// presence while merely sitting on the page. The normal flow (land → start
// riding within seconds) arms well inside it; on arming the grace is cleared.
const LAND_GRACE_MS = 30 * 1000;
const timer = setInterval(async () => {
  try {
    if (state.startedAt && lastFrameAt > 0 && Date.now() - lastFrameAt > STALE_MS) {
      const silentSec = Math.round((Date.now() - lastFrameAt) / 1000);
      terra.log('frame stream silent for ' + silentSec + 's — clearing presence');
      await clearPresence();
      return;
    }
    if (state.kind && !state.startedAt && state.riding && state.landedAt
      && Date.now() - state.landedAt > LAND_GRACE_MS) {
      terra.log('no ride started within ' + LAND_GRACE_MS / 1000 + 's of landing — dropping presence');
      await clearPresence();
      return;
    }
    await pushNow();
  } catch (e) {
    noteHealth(false, errMsg(e));
  }
}, 5000);

terra.onNavigate((href) => {
  const k = rideKey(href);
  // Still on a ride-like page AND same identity → live ride, don't disturb it
  // (intra-page pushState/hash noise). Everything else is a real navigation.
  const rideLik = (() => { try { const u = new URL(href); return u.pathname.startsWith('/ride') || u.pathname.startsWith('/spectate'); } catch (_) { return false; } })();
  if (k === state.key && rideLik) {
    terra.log('[onNavigate] same identity (' + k + ') — ignoring');
    return;
  }
  // A live-ride page that navigates *without* its route/event id (the app does
  // intra-ride URL rewrites) is STILL the ride: resetting the presence here is
  // what snapped the green timer back to 0:00 on every update. Hold the clock
  // and let the next id-carrying frame/push reconcile the name.
  if (state.startedAt && rideLik) {
    const newId = (() => { try { const u = new URL(href); return u.searchParams.get('route') || u.searchParams.get('event') || u.searchParams.get('name') || ''; } catch (_) { return ''; } })();
    // Only preserve the running clock when the ride is STILL live (frames flowing)
    // — that's the intra-ride URL rewrite that used to snap the timer back to 0:00.
    // When the frame stream has gone quiet, an id-less ride page is a transition /
    // leave, not a live ride, so fall through and RESET below (clearPresence kills
    // the clock, and the next ride will arm a fresh start instead of the old one).
    if (!newId && framesLive()) {
      terra.log('[onNavigate] id-less ride-page navigate while ride is live — holding clock: ' + href);
      return;
    }
    if (!newId) {
      terra.log('[onNavigate] id-less ride-page navigate, ride not live — resetting presence: ' + href);
    }
  }
  terra.log('[onNavigate] ' + href + '  [' + (state.key || 'none') + ' -> ' + k + ']');
  state.key = k;
  // Genuinely different page (or a non-ride page): drop the stale presence.
  clearPresence(true);
  initForUrl(href);
});

terra.onCleanup(() => {
  clearInterval(timer);
  offRide();
  clearPresence(true); // best effort: don't let a stale presence linger in Discord
});

const kind = await (async () => {
  // Make sure settings are actually in hand before the very first push: the
  // settings promise is async, and pushing before it resolves made an idle
  // page fire a false "set the Client ID" warning on startup.
  if (!cachedSettings) {
    try { cachedSettings = await terra.settings.all(); } catch (_) {}
  }
  return initForUrl(location.href);
})();
terra.log('ready on page kind: ' + (kind || 'unknown'));
