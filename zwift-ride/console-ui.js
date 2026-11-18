/* ---------- Console UI Layout Engine v6 (Clean Horizon SPA Reset & Exact Selectors) ---------- */

let consoleUiEnabled = false;
let hudEl = null;
let lastHudSig = '';
let uiRaf = 0;

function unwrapAthletePage() {
    document.querySelectorAll('.detail-page > .btz-athlete-right').forEach((wrap) => {
        const parent = wrap.parentElement;
        while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
        wrap.remove();
        parent.style.removeProperty('--btz-left-rows');
    });
}

function clearPageClasses() {
    document.documentElement.classList.remove(
        'btz-page-dash',
        'btz-page-routes',
        'btz-page-route-detail',
        'btz-page-events',
        'btz-page-event-detail',
        'btz-page-clubs',
        'btz-page-challenges',
        'btz-page-athlete'
    );
    // Clean up all btz layout classes on persistent SvelteKit wrappers (.main, .content, .wrap)
    const dirtyClasses = [
        'btz-wide-container',
        'btz-dash-root-3col',
        'btz-routes-grid',
        'btz-route-card-item',
        'btz-events-page-grid',
        'btz-event-card',
        'btz-events-page-card',
        'btz-events-date-header',
        'btz-clubs-grid',
        'btz-club-card-item',
        'btz-detail-cockpit-grid',
        'btz-athlete-grid',
        'btz-athlete-left-item'
    ];
    document.querySelectorAll('.main, .main .content, .main .wrap, .detail-page, .detail-page > *').forEach((el) => {
        el.classList.remove(...dirtyClasses);
    });
}

function widenMainContentWrap() {
    const mainWrap = document.querySelector('.main .content > .wrap, .main > .wrap');
    if (mainWrap) mainWrap.classList.add('btz-wide-container');
    return mainWrap;
}

/* 1. DASHBOARD (/dashboard) — 3 Equal Columns (Coming Up | Stats + Challenge | Community + Changelog) */
function layoutDashboard() {
    const welcome = document.querySelector('.welcome-row');
    const colRoot =
    document.querySelector('.dashboard-wrap') ||
    (welcome && welcome.parentElement) ||
    document.querySelector('.main .content > .wrap');
    if (!colRoot) return;

    document.documentElement.classList.add('btz-page-dash');
    widenMainContentWrap();
    colRoot.classList.add('btz-dash-root-3col');

    document.getElementById('btz-quick-tiles')?.remove();

    const headerRow = colRoot.querySelector('.welcome-row') || colRoot.firstElementChild;
    if (headerRow) {
        headerRow.classList.add('btz-dash-header');
        headerRow.style.gridColumn = '1 / -1';
        headerRow.style.gridRow = '1';

        const ridingPill = headerRow.querySelector('a.live-pill, a');
        if (ridingPill) {
            ridingPill.classList.remove('btz-hidden-riding-pill');
            ridingPill.style.display = '';
            delete ridingPill.dataset.btzSkip;
        }
    }

    const zones = [...colRoot.querySelectorAll(':scope > section.zone')];

    for (const zone of zones) {
        zone.classList.remove(
            'btz-zone-unwrapped',
            'btz-col-left',
            'btz-col-right',
            'btz-right-stack-item',
            'btz-dash-col-events',
            'btz-dash-col-stats',
            'btz-dash-col-community'
        );
        zone.style.display = '';
        zone.style.gridArea = '';
        zone.style.marginTop = '';

        const headText = (zone.querySelector('.zone-head h2, .zone-head')?.textContent || '').trim().toLowerCase();

        // COLUMN 1 (Left): "Coming up"
        if (headText.startsWith('coming up') || zone.querySelector('.itin-row, .event-row')) {
            zone.classList.add('btz-dash-col-events');
            zone.style.gridColumn = '1';
            zone.style.gridRow = '2';

            zone.querySelectorAll('.itin-row, .event-row').forEach((row) => {
                row.classList.add('btz-dash-event-row');
                const thumbLink = row.querySelector('a.itin-thumb, a.event-row-thumb');
                if (thumbLink) thumbLink.dataset.btzSkip = '1';
                const titleLink = row.querySelector('.itin-title a, .event-row-title a');
                if (titleLink) titleLink.classList.add('btz-dash-event-target');
            });
                continue;
        }

        // COLUMN 2 (Center): "Last 2 weeks" + Climbing Tier + Active Challenge
        if (zone.querySelector('.ds')) {
            zone.classList.add('btz-dash-col-stats');
            zone.style.gridColumn = '2';
            zone.style.gridRow = '2';
            for (const child of zone.children) {
                child.style.gridArea = '';
                child.style.gridColumn = '';
                child.style.gridRow = '';
                child.style.marginTop = '';
            }
            continue;
        }

        // COLUMN 3 (Right): "Community" + Changelog
        if (headText.startsWith('community') || zone.querySelector('.community, .feed')) {
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
    const wrap = widenMainContentWrap();
    if (!wrap) return;

    const gridContainer = wrap.querySelector('.grid.grid-cols-3, .grid');
    if (!gridContainer) return;

    gridContainer.classList.add('btz-routes-grid');
    for (const child of gridContainer.children) {
        if (child.classList.contains('route-tile') || child.classList.contains('postcard')) {
            child.classList.add('btz-route-card-item');
        }
    }
}

/* 3. EVENTS LIST (/events) — Widescreen 2-Column Event Cards */
function layoutEventsList() {
    document.documentElement.classList.add('btz-page-events');
    const wrap = widenMainContentWrap();
    if (!wrap) return;

    const itins = wrap.querySelectorAll('.itin');
    for (const itin of itins) {
        itin.classList.add('btz-events-page-grid');
        for (const child of itin.children) {
            if (child.classList.contains('itin-row') || child.classList.contains('event-row')) {
                child.classList.add('btz-event-card', 'btz-events-page-card');
                const thumbLink = child.querySelector('a.itin-thumb, a.event-row-thumb');
                if (thumbLink) thumbLink.dataset.btzSkip = '1';
            } else {
                child.classList.add('btz-events-date-header');
            }
        }
    }
}

/* 4. CLUBS LIST (/clubs) — Widescreen 3-Column Club Grid */
function layoutClubsList() {
    document.documentElement.classList.add('btz-page-clubs');
    const wrap = widenMainContentWrap();
    if (!wrap) return;

    const gridContainer = wrap.querySelector('.grid.grid-cards, .grid');
    if (!gridContainer) return;

    gridContainer.classList.add('btz-clubs-grid');
    for (const child of gridContainer.children) {
        child.classList.add('btz-club-card-item');
    }
}

/* 5. CHALLENGES LIST (/challenges) */
function layoutChallengesList() {
    document.documentElement.classList.add('btz-page-challenges');
    widenMainContentWrap();
}

/* 6. ROUTE DETAIL (/routes/:id) & EVENT DETAIL (/events/:id) — Widescreen 2-Column Cockpit */
function layoutDetailPage(isEvent) {
    document.documentElement.classList.add(isEvent ? 'btz-page-event-detail' : 'btz-page-route-detail');
    widenMainContentWrap();

    const h1 = document.querySelector('h1');
    if (!h1) return;

    let colRoot = document.querySelector('.detail-page');

    if (!colRoot) {
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

/* 7. ATHLETE DETAIL (/athletes/:id) — Left: profile/stats/highlights, Right: nav-pills + conditional tiles */
function layoutAthletePage() {
    document.documentElement.classList.add('btz-page-athlete');
    widenMainContentWrap();

    const detailPage = document.querySelector('.detail-page');
    if (!detailPage) return;

    let rightCol = detailPage.querySelector(':scope > .btz-athlete-right');
    const directRight = [...detailPage.children].filter(
        (el) => el.classList.contains('nav-pills') || el.classList.contains('tile')
    );

    if (!rightCol && !directRight.length) return;

    if (!rightCol) {
        rightCol = document.createElement('div');
        rightCol.className = 'btz-athlete-right';
        detailPage.appendChild(rightCol);
    }
    for (const el of directRight) {
        rightCol.appendChild(el);
    }

    let leftCount = 0;
    for (const child of detailPage.children) {
        if (child === rightCol) continue;
        child.classList.add('btz-athlete-left-item');
        leftCount++;
    }

    detailPage.classList.add('btz-athlete-grid');
    detailPage.style.setProperty('--btz-left-rows', String(Math.max(1, leftCount)));
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
    if (focused && focused.isConnected) {
        const card = focused.closest(
            '.btz-dash-event-row, .itin-row, .btz-events-page-card, .btz-route-card-item, .btz-club-card-item, .feed-row'
        );
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
    location.pathname === '/events/' ||
    location.pathname === '/clubs' ||
    location.pathname === '/clubs/';
    const pageHint = isPaginated ? 'Scroll / Next Page' : 'Scroll Up / Down';

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
        const active = mode === 'browse' && consoleUiEnabled;
        if (!active || !/^\/athletes\/[^/]+/.test(path)) unwrapAthletePage();
        if (active) {
            if (path === '/dashboard' || path === '/dashboard/') layoutDashboard();
            else if (path === '/routes' || path === '/routes/') layoutRoutesList();
            else if (/^\/routes\/.+/.test(path)) layoutDetailPage(false);
            else if (path === '/events' || path === '/events/') layoutEventsList();
            else if (/^\/events\/.+/.test(path)) layoutDetailPage(true);
            else if (path === '/clubs' || path === '/clubs/') layoutClubsList();
            else if (path === '/challenges' || path === '/challenges/') layoutChallengesList();
            else if (/^\/athletes\/[^/]+/.test(path)) layoutAthletePage();
        }
        updateConsoleHud();
    });
}

const consoleObserver = new MutationObserver((mutations) => {
    if (!consoleUiEnabled) return;
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

terra.onCleanup(() => {
    consoleObserver.disconnect();
    if (uiRaf) cancelAnimationFrame(uiRaf);
    unwrapAthletePage();
    clearPageClasses();
    hudEl?.remove();
});
