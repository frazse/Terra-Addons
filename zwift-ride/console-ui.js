/* ---------- Console UI Layout Engine v4 (Clean 3-Col Equal Dashboard & Full-Bleed Fix) ---------- */

let consoleUiEnabled = true;
let hudEl = null;
let lastHudSig = '';
let uiRaf = 0;

function clearPageClasses() {
    document.documentElement.classList.remove(
        'btz-page-dash',
        'btz-page-routes',
        'btz-page-route-detail',
        'btz-page-events',
        'btz-page-event-detail',
        'btz-page-clubs'
    );
    // Remove any leftover .btz-wide-container from outer root/container wrappers so header/footer never get cut off
    document.querySelectorAll('.btz-wide-container').forEach((el) => {
        if (!el.matches('.main .wrap, .main .content')) {
            el.classList.remove('btz-wide-container');
        }
    });
}

function widenMainContentWrap() {
    const mainWrap = document.querySelector('.main .content > .wrap, .main > .wrap');
    if (mainWrap) mainWrap.classList.add('btz-wide-container');
}

/* 1. DASHBOARD (/dashboard) — 3 Equal Columns (Coming Up | Stats + Challenge | Community + Changelog) */
function layoutDashboard() {
    const colRoot = document.querySelector('.dashboard-wrap');
    if (!colRoot) return;

    document.documentElement.classList.add('btz-page-dash');
    widenMainContentWrap();
    colRoot.classList.add('btz-dash-root-3col');

    // Remove old injected quick tiles if present
    document.getElementById('btz-quick-tiles')?.remove();

    const headerRow = colRoot.querySelector('.welcome-row') || colRoot.firstElementChild;
    if (headerRow) {
        headerRow.classList.add('btz-dash-header');
        headerRow.style.gridColumn = '1 / -1';
        headerRow.style.gridRow = '1';

        // Ensure the native live rider pill ("13 riding") is visible and focusable
        const ridingPill = headerRow.querySelector('a.live-pill, a');
        if (ridingPill) {
            ridingPill.classList.remove('btz-hidden-riding-pill');
            ridingPill.style.display = '';
            delete ridingPill.dataset.btzSkip;
        }
    }

    const zones = [...colRoot.querySelectorAll(':scope > section.zone')];

    for (const zone of zones) {
        // Reset any old inline styles from earlier versions
        zone.classList.remove('btz-zone-unwrapped', 'btz-col-left', 'btz-col-right', 'btz-right-stack-item');
        zone.style.display = '';
        zone.style.gridArea = '';
        zone.style.marginTop = '';

        const headText = (zone.querySelector('.zone-head')?.textContent || '').trim().toLowerCase();

        // COLUMN 1 (Left): "Coming up"
        if (headText === 'coming up' || zone.querySelector('.event-row')) {
            zone.classList.add('btz-dash-col-events');
            zone.style.gridColumn = '1';
            zone.style.gridRow = '2';

            zone.querySelectorAll('.event-row').forEach((row) => {
                row.classList.add('btz-dash-event-row');
                const thumbLink = row.querySelector('a.event-row-thumb');
                if (thumbLink) thumbLink.dataset.btzSkip = '1';
                const titleLink = row.querySelector('.event-row-title a');
                if (titleLink) titleLink.classList.add('btz-dash-event-target');
            });
                continue;
        }

        // COLUMN 2 (Center): "Last 2 weeks" + Climbing Tier + Active Challenge
        if (zone.querySelector('.ds')) {
            zone.classList.add('btz-dash-col-stats');
            zone.style.gridColumn = '2';
            zone.style.gridRow = '2';
            // Clear old inline styles on children
            for (const child of zone.children) {
                child.style.gridArea = '';
                child.style.gridColumn = '';
                child.style.gridRow = '';
                child.style.marginTop = '';
            }
            continue;
        }

        // COLUMN 3 (Right): "Community" + Changelog
        if (headText === 'community' || zone.querySelector('.community')) {
            zone.classList.add('btz-dash-col-community');
            zone.style.gridColumn = '3';
            zone.style.gridRow = '2';
            continue;
        }
    }
}

/* 2. ROUTES LIST (/routes) — Widescreen 4-Column Console Grid */
function layoutRoutesList() {
    document.documentElement.classList.add('btz-page-routes');
    widenMainContentWrap();

    const routeLinks = [...document.querySelectorAll('a[href*="/routes/"]')].filter(
        (a) => !a.closest('nav, header')
    );
    if (!routeLinks.length) return;

    let card = routeLinks[0];
    while (card.parentElement && card.parentElement.querySelectorAll('a[href*="/routes/"]').length === 1) {
        card = card.parentElement;
    }
    const gridContainer = card.parentElement;
    if (!gridContainer) return;

    gridContainer.classList.add('btz-routes-grid');
    for (const child of gridContainer.children) {
        child.classList.add('btz-route-card-item');
    }
}

/* 3. EVENTS LIST (/events) — Widescreen 2-Column Event Cards */
function layoutEventsList() {
    document.documentElement.classList.add('btz-page-events');
    widenMainContentWrap();

    const eventLinks = [...document.querySelectorAll('a[href*="/events/"]')].filter(
        (a) => !a.closest('nav, header') && a.textContent.trim().toLowerCase() !== 'view series'
    );
    if (!eventLinks.length) return;

    const grids = new Set();
    for (const a of eventLinks) {
        let row = a.parentElement;
        while (row && row.parentElement && !row.querySelector('img') && row.parentElement.children.length > 1) {
            row = row.parentElement;
        }
        if (row && row.parentElement) {
            row.classList.add('btz-event-card', 'btz-events-page-card');
            row.parentElement.classList.add('btz-events-page-grid');
            grids.add(row.parentElement);
        }
    }

    for (const grid of grids) {
        for (const child of grid.children) {
            if (!child.classList.contains('btz-events-page-card')) {
                child.classList.add('btz-events-date-header');
            }
        }
    }
}

/* 4. ROUTE DETAIL (/routes/:id) & EVENT DETAIL (/events/:id) — Widescreen 2-Column Cockpit */
function layoutDetailPage(isEvent) {
    document.documentElement.classList.add(isEvent ? 'btz-page-event-detail' : 'btz-page-route-detail');
    widenMainContentWrap();

    const h1 = document.querySelector('h1');
    if (!h1) return;

    let colRoot = document.querySelector('.detail-page');

    if (!colRoot) {
        // fallback: old heuristic
        colRoot = h1.parentElement;
        while (colRoot && colRoot.parentElement && colRoot.children.length < 2) {
            colRoot = colRoot.parentElement;
        }
        while (
            colRoot &&
            colRoot.parentElement &&
            !colRoot.parentElement.classList.contains('content') &&
            !colRoot.parentElement.classList.contains('main') &&
            colRoot.children.length < 3
        ) {
            colRoot = colRoot.parentElement;
        }
    }

    if (colRoot && !colRoot.classList.contains('container')) {
        colRoot.classList.add('btz-detail-cockpit-grid');

        const kids = [...colRoot.children];
        kids.forEach((child, idx) => {
            if (child.contains(h1) || idx === 0) {
                child.classList.add('btz-cockpit-header');
            } else if (
                child.querySelector('table') ||
                /\b(riders|teams)\b/i.test(child.textContent.slice(0, 40)) ||
                child.querySelector('.leaflet-container, .maplibregl-map, .mapboxgl-map')
            ) {
                child.classList.add('btz-cockpit-right');
            } else {
                child.classList.add('btz-cockpit-left');
            }
        });
    }

    const primaryBtn = findDefault();
    if (primaryBtn && !primaryBtn.classList.contains('btz-cta-hero')) {
        primaryBtn.classList.add('btz-cta-hero');
    }
}

function updateConsoleHud() {
    if (!consoleUiEnabled || mode === 'ride' || location.pathname.startsWith(SPECTATE_PATH_PREFIX)) {
        if (hudEl && hudEl.style.display !== 'none') hudEl.style.display = 'none';
        return;
    }
    if (!hudEl) {
        hudEl = document.createElement('div');
        hudEl.id = 'btz-console-hud';
        document.documentElement.appendChild(hudEl);
    }
    if (hudEl.style.display !== 'flex') hudEl.style.display = 'flex';

    let focusedText = 'D-Pad to Navigate';
    if (focused) {
        const card = focused.closest('.btz-dash-event-row, .btz-events-page-card, .btz-route-card-item');
        const raw = card ? card.textContent : (focused.getAttribute('aria-label') || focused.textContent || '');
        focusedText = raw.replace(/\s+/g, ' ').trim().slice(0, 42);
    }

    const sig = `${location.pathname}::${focusedText}`;
    if (sig === lastHudSig) return;
    lastHudSig = sig;

    const isPaginated =
    location.pathname === '/routes' ||
    location.pathname === '/routes/' ||
    location.pathname === '/events' ||
    location.pathname === '/events/';
    const pageHint = isPaginated ? 'Scroll / Next Page' : 'Scroll Up / Down';
    const card = focused.closest('.btz-dash-event-row, .btz-events-page-card, .btz-route-card-item, .postcard, .club-tile');
    hudEl.innerHTML = `
    <div class="btz-hud-target">${focusedText || 'Ready'}</div>
    <div class="btz-hud-keys">
    <span><kbd class="btz-k-a">A</kbd> Select</span>
    <span><kbd class="btz-k-b">B</kbd> Back</span>
    <span><kbd>D-Pad</kbd> Move</span>
    <span><kbd>RS / LS</kbd> ${pageHint}</span>
    <span><kbd class="btz-k-z">Z</kbd> Switch Tab</span>
    <span><kbd class="btz-k-y">Y</kbd> Top</span>
    </div>
    `;
}

function scheduleConsoleUi() {
    if (uiRaf) return;
    uiRaf = requestAnimationFrame(() => {
        uiRaf = 0;
        clearPageClasses();
        const path = location.pathname;
        if (mode === 'browse' && consoleUiEnabled) {
            if (path === '/dashboard' || path === '/dashboard/') layoutDashboard();
            else if (path === '/routes' || path === '/routes/') layoutRoutesList();
            else if (/^\/routes\/.+/.test(path)) layoutDetailPage(false);
            else if (path === '/events' || path === '/events/') layoutEventsList();
            else if (/^\/events\/.+/.test(path)) layoutDetailPage(true);
            else if (path === '/clubs' || path === '/clubs/') {
                document.documentElement.classList.add('btz-page-clubs');
                widenMainContentWrap();
            }
        }
        updateConsoleHud();
    });
}

const consoleObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
        if (
            m.target &&
            (m.target.id === 'btz-console-hud' ||
            m.target.id === 'btz-ring' ||
            m.target.closest?.('#btz-panel') ||
            m.target.closest?.('#btz-console-hud'))
        ) {
            continue;
        }
        scheduleConsoleUi();
        break;
    }
});
consoleObserver.observe(document.body, { childList: true, subtree: true });
scheduleConsoleUi();

terra.onCleanup(() => {
    consoleObserver.disconnect();
    if (uiRaf) cancelAnimationFrame(uiRaf);
    clearPageClasses();
    hudEl?.remove();
});
