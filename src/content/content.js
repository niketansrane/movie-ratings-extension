'use strict';

/**
 * Content Script — Netflix Ratings Overlay
 *
 * Injected into netflix.com pages. Detects poster cards and the hero
 * billboard, extracts movie/show titles from the DOM, asks the service
 * worker for ratings, and renders floating IMDb / Rotten Tomatoes badges.
 *
 * All mutable state is scoped inside an IIFE to avoid polluting the
 * page's global namespace.
 */

(() => {

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const DEBOUNCE_MS       = 300;
const HIDE_DELAY_MS     = 600;
const POSITION_POLL_MS  = 200;
const RESCAN_DELAYS     = [2000, 5000];  // delayed full-body rescans
const URL_POLL_MS       = 1000;          // how often we check for SPA navigation
const SPINNER_DELAY_MS  = 150;           // only show spinner if fetch is slower than this
const DEBUG             = false;

/** CSS selectors for poster cards (bottom-half rows). */
const CARD_SELECTORS = [
  '.slider-item',
  '.title-card-container',
  '.bob-card',
  '.mini-modal',
  '[class*="previewModal"]',
  '[class*="jawBone"]',
];

/** CSS selectors for the hero/billboard banner (top-half). */
const HERO_SELECTORS = [
  '.billboard-row',
  '[class*="billboard-row"]',
  '[class*="billboardRow"]',
  '[class*="hero-image"]',
  '[class*="hero_billboard"]',
  '[class*="heroImage"]',
  '.billboard',
  '[class*="billboard"]:not([class*="billboard-motion"])',
];

const ALL_SELECTORS      = [...CARD_SELECTORS, ...HERO_SELECTORS];
const ALL_SELECTOR_STR   = ALL_SELECTORS.join(', ');

/** Selectors for finding a title inside an element. */
const TITLE_SELECTORS = [
  // Hero / billboard
  '.billboard-title .title-logo',
  '.hero-title .title-logo',
  '[class*="billboard"] .title-logo',
  '[class*="hero"] .title-logo',
  '[class*="billboard"] [class*="title-treatment"]',
  '[class*="billboard"] [class*="titleTreatment"]',
  '[class*="billboard-title"]',
  '[class*="hero-title"]',
  '.title-treatment',
  // Card / modal
  '.fallback-text',
  '.title-card-title',
  '.previewModal-player-titleTreatment-logo',
  '.previewModal-title',
  '.bob-title',
];

/** Selectors for metadata containers that may hold year / duration info. */
const META_SELECTORS = [
  '.year', '[class*="year"]',
  '.duration', '[class*="duration"]',
  '.meta', '[class*="meta"]',
  '.supplemental-message', '[class*="supplemental"]',
  '.videoMetadata', '[class*="videoMetadata"]',
  '.previewModal--detailsMetadata-left', '[class*="detailsMetadata"]',
  '.episodeSelector', '[class*="episode"]',
  '[class*="billboard"] [class*="supplemental"]',
  '[class*="billboard"] [class*="info"]',
];

/** Words that indicate an aria-label is NOT a movie title. */
const NON_TITLE_WORDS = [
  'account', 'profile', 'search', 'menu', 'navigation',
  'close', 'play', 'pause', 'volume', 'mute', 'forward', 'back',
  'next', 'previous', 'settings', 'audio', 'subtitles', 'notifications',
];

const HERO_MATCH = '[class*="billboard"], [class*="hero-image"], [class*="hero_billboard"]';
const ANCESTOR_MATCH =
  '[class*="previewModal"], [class*="jawBone"], .bob-card, .mini-modal, ' + HERO_MATCH;

// ═══════════════════════════════════════════════════════════════
// MUTABLE STATE
// ═══════════════════════════════════════════════════════════════

let enabled           = true;
let initialized       = false;
let overlay           = null;   // the single floating overlay <div>
let hoveredEl         = null;   // element the user is currently hovering
let hoveredTitle      = null;   // dedup key for the currently-shown rating
let mouseX            = 0;
let mouseY            = 0;
let requestSeq        = 0;      // monotonically increasing; stale responses are ignored
let hoverTimer        = null;
let hideTimer         = null;
let posTimer          = null;
let scanTimers        = [];     // delayed rescan setTimeout IDs
let pendingBodyScan   = null;
let mutObs            = null;   // MutationObserver for new DOM nodes
let urlPollId         = null;   // setInterval ID for SPA nav detection
let lastUrl           = location.href;

// ═══════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════

function log(...args) {
  if (DEBUG) console.log('[NRO]', ...args);
}

// ═══════════════════════════════════════════════════════════════
// OVERLAY — single floating element, re-used across hovers
// ═══════════════════════════════════════════════════════════════

function ensureOverlay() {
  if (overlay && document.body.contains(overlay)) return overlay;
  overlay?.remove();

  overlay = document.createElement('div');
  overlay.id = 'nro-floating-overlay';
  // Positioning and visibility are driven by class + styles.css.
  // We only set the essentials inline so they survive even if the
  // stylesheet is somehow blocked.
  overlay.style.cssText =
    'position:fixed!important;z-index:999999!important;' +
    'pointer-events:none!important;opacity:0;' +
    'transition:opacity .15s ease-out;display:flex;gap:4px;';
  document.body.appendChild(overlay);
  return overlay;
}

function showOverlay(element, data) {
  const el = ensureOverlay();
  el.classList.toggle('nro-hero-mode', isHero(element));

  if (data.loading) {
    el.innerHTML = '<div class="nro-ratings-loading"><span class="nro-spinner"></span></div>';
  } else if (data.error || data.notFound) {
    hideOverlay();
    return;
  } else {
    const html = buildBadgesHTML(data);
    if (!html) { hideOverlay(); return; }
    el.innerHTML = html;
  }

  positionOverlay(element);
  el.style.opacity = '1';
  startPositionPoll(element);
}

function hideOverlay() {
  if (overlay) overlay.style.opacity = '0';
  stopPositionPoll();
}

// ─── Positioning — always top-left of the hovered element ─────

function positionOverlay(element) {
  if (!overlay || !document.body.contains(element)) return;

  const r = element.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return;

  const pad = isHero(element) ? 20 : 8;
  let left  = r.left + pad;
  let top   = r.top  + pad;

  const ow = overlay.offsetWidth  || 150;
  const oh = overlay.offsetHeight || 30;

  if (left + ow > window.innerWidth  - 10) left = window.innerWidth  - ow - 10;
  if (top  + oh > window.innerHeight - 10) top  = window.innerHeight - oh - 10;
  if (left < 10) left = 10;
  if (top  < 10) top  = 10;

  overlay.style.left = `${left}px`;
  overlay.style.top  = `${top}px`;
}

function startPositionPoll(element) {
  stopPositionPoll();
  posTimer = setInterval(() => {
    if (hoveredEl && overlay?.style.opacity === '1') {
      positionOverlay(hoveredEl);
    } else {
      stopPositionPoll();
    }
  }, POSITION_POLL_MS);
}

function stopPositionPoll() {
  if (posTimer) { clearInterval(posTimer); posTimer = null; }
}

function isHero(el) {
  try { return !!(el.matches?.(HERO_MATCH) || el.closest?.(HERO_MATCH)); }
  catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
// BADGE RENDERING
// ═══════════════════════════════════════════════════════════════

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildBadgesHTML(data) {
  const parts = [];

  if (data.imdbRating) {
    parts.push(
      `<div class="nro-rating-badge nro-imdb">` +
        `<span class="nro-rating-icon">IMDb</span>` +
        `<span class="nro-rating-value">${esc(data.imdbRating)}</span>` +
      `</div>`
    );
  }

  if (data.rottenTomatoes) {
    const fresh = parseInt(data.rottenTomatoes, 10) >= 60 ? 'fresh' : 'rotten';
    parts.push(
      `<div class="nro-rating-badge nro-rt nro-${fresh}">` +
        `<span class="nro-rating-icon">RT</span>` +
        `<span class="nro-rating-value">${esc(data.rottenTomatoes)}</span>` +
      `</div>`
    );
  }

  return parts.length ? parts.join('') : null;
}

// ═══════════════════════════════════════════════════════════════
// TITLE & METADATA EXTRACTION
// ═══════════════════════════════════════════════════════════════

function extractTitle(element) {
  let title = null, year = null, mediaType = null;

  // Strategy 1 — aria-label
  const label = element.getAttribute('aria-label')
    || element.closest('[aria-label]')?.getAttribute('aria-label');
  if (label && label.length > 2 && !isNonTitle(label)) {
    ({ title, year, mediaType } = parseAriaLabel(label));
  }

  // Strategy 2 — <img alt>
  if (!title) {
    const img = element.querySelector('img[alt]')
      || element.closest('.title-card-container, .slider-item')?.querySelector('img[alt]');
    if (img?.alt?.length > 2 && !isNonTitle(img.alt)) title = img.alt.trim();
  }

  // Strategy 3 — known title-element selectors within this element
  if (!title) title = findTitleText(element);

  // Strategy 4 — search ancestor (preview modal / billboard)
  if (!title) {
    for (const root of ancestorRoots(element)) {
      if (root === element) continue;
      title = findTitleText(root);
      if (title) break;
    }
  }

  if (!title) return null;

  if (!year)      year      = extractYear(element);
  if (!mediaType) mediaType = detectMediaType(element);

  return { title, year, mediaType: mediaType || null };
}

function findTitleText(root) {
  for (const sel of TITLE_SELECTORS) {
    const el = root.querySelector(sel);
    if (!el) continue;
    if (el.tagName === 'IMG' && el.alt) return el.alt.trim();
    const t = el.textContent?.trim();
    if (t && t.length > 2 && t.length < 100 && !isNonTitle(t)) return t;
  }
  return null;
}

function ancestorRoots(el) {
  const roots = [el];
  const a = el.closest(ANCESTOR_MATCH);
  if (a) roots.push(a);
  return roots;
}

function extractYear(element) {
  for (const root of ancestorRoots(element)) {
    for (const sel of META_SELECTORS) {
      for (const el of root.querySelectorAll(sel)) {
        const m = el.textContent?.match(/(?:^|\s)((?:19[5-9]\d|20[0-3]\d))(?:\s|$|,|\))/);
        if (m) {
          const y = parseInt(m[1], 10);
          if (y >= 1950 && y <= new Date().getFullYear() + 1) return m[1];
        }
      }
    }
  }
  return null;
}

function detectMediaType(element) {
  const SERIES_RE = /\b(\d+\s+Seasons?|\d+\s+Episodes?|Season\s+\d|Episode\s+\d|Limited Series|TV Series|Mini.?Series)\b/i;
  const MOVIE_RE  = /\b\d+h\s*\d*m?\b/i;

  for (const root of ancestorRoots(element)) {
    for (const sel of META_SELECTORS) {
      for (const el of root.querySelectorAll(sel)) {
        const t = el.textContent || '';
        if (SERIES_RE.test(t)) return 'series';
        if (MOVIE_RE.test(t))  return 'movie';
      }
    }
  }
  return null;
}

function isNonTitle(text) {
  const lc = text.toLowerCase();
  return NON_TITLE_WORDS.some(w => lc === w || (lc.length < 20 && lc.includes(w)));
}

function parseAriaLabel(label) {
  const ym = label.match(/\((\d{4})(?:\s*[-–]\s*\d{0,4})?\)/);
  const hasSeason  = /Season\s+\d+/i.test(label);
  const hasEpisode = /Episode\s+\d+/i.test(label);

  let title = label;
  let year  = null;
  let mediaType = null;

  if (ym) {
    year  = ym[1];
    title = label.replace(/\s*\(\d{4}(?:\s*[-–]\s*\d{0,4})?\)\s*/, ' ').trim();
  }
  if (hasSeason || hasEpisode) {
    mediaType = 'series';
    title = title.replace(/\s*-?\s*Season\s+\d+.*/i, '').trim();
    title = title.replace(/\s*-?\s*Episode\s+\d+.*/i, '').trim();
  }

  title = title.replace(/^(Trailer|Teaser):\s*/i, '').replace(/\s*-\s*$/, '').trim();
  return { title, year, mediaType };
}

function normalizeTitle(t) { return t.replace(/\s+/g, ' ').trim(); }

// ═══════════════════════════════════════════════════════════════
// EVENT HANDLERS
// ═══════════════════════════════════════════════════════════════

function onMouseEnter(e) {
  if (!enabled) return;
  const el = e.currentTarget;
  hoveredEl = el;
  clearTimeout(hideTimer);
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (hoveredEl === el) fetchRating(el);
  }, DEBOUNCE_MS);
}

function onMouseLeave() {
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    const under = document.elementFromPoint(mouseX, mouseY);
    if (under) {
      const card = findAncestorCard(under);
      if (card) {
        hoveredEl = card;
        positionOverlay(card);
        attach(card);
        return;
      }
    }
    hoveredEl = null;
    hoveredTitle = null;
    hideOverlay();
  }, HIDE_DELAY_MS);
}

function onMouseMove(e) { mouseX = e.clientX; mouseY = e.clientY; }

function onDocMouseOver(e) {
  if (!enabled || !e.target?.closest) return;
  const card = findAncestorCard(e.target);
  if (card && !card.dataset.nroAttached) {
    clearTimeout(hideTimer);
    attach(card);
    if (overlay?.style.opacity === '1') {
      hoveredEl = card;
      positionOverlay(card);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// FETCH & DISPLAY
// ═══════════════════════════════════════════════════════════════

async function fetchRating(element) {
  if (!chrome.runtime?.id) { log('context invalidated'); return; }
  if (!enabled) return;

  const info = extractTitle(element);
  if (!info?.title) { log('no title found'); return; }

  const norm  = normalizeTitle(info.title);
  const dedup = `${norm}|${info.year || ''}|${info.mediaType || ''}`;

  if (hoveredTitle === dedup && overlay?.style.opacity === '1') {
    positionOverlay(element);
    return;
  }
  hoveredTitle = dedup;

  const seq = ++requestSeq;

  const spinnerTimer = setTimeout(() => {
    if (requestSeq === seq && hoveredEl === element) {
      showOverlay(element, { loading: true });
    }
  }, SPINNER_DELAY_MS);

  try {
    const rating = await chrome.runtime.sendMessage({
      type: 'FETCH_RATING',
      title: norm,
      year: info.year || null,
      mediaType: info.mediaType || null,
    });
    clearTimeout(spinnerTimer);
    if (requestSeq === seq && hoveredEl) showOverlay(hoveredEl, rating);
  } catch (err) {
    clearTimeout(spinnerTimer);
    console.error('[NRO] fetch failed:', err);
    if (requestSeq === seq && hoveredEl) {
      showOverlay(hoveredEl, { error: 'Failed to fetch rating' });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// CARD DETECTION & LISTENER ATTACHMENT
// ═══════════════════════════════════════════════════════════════

function findAncestorCard(el) {
  let best = null, cur = el;
  while (cur && cur !== document.body) {
    if (matchesCard(cur)) best = cur;
    cur = cur.parentElement;
  }
  return best;
}

function matchesCard(el) {
  try { return el.matches?.(ALL_SELECTOR_STR); }
  catch { return false; }
}

function attach(el) {
  if (!el || el.dataset.nroAttached) return;
  const href = el.getAttribute('href') || '';
  if (href.includes('Account') || href.includes('profile')) return;
  el.dataset.nroAttached = 'true';
  el.addEventListener('mouseenter', onMouseEnter);
  el.addEventListener('mouseleave', onMouseLeave);
}

function attachAll(container) {
  for (const el of container.querySelectorAll(ALL_SELECTOR_STR)) {
    if (el.dataset.nroAttached) continue;
    // Only attach outermost matched element
    const parent = el.parentElement?.closest(ALL_SELECTOR_STR);
    if (parent && (parent.dataset.nroAttached || container.contains(parent))) continue;
    attach(el);
  }
  // If the container itself matches, attach it too
  if (matchesCard(container)) attach(container);
}

// ═══════════════════════════════════════════════════════════════
// MUTATION OBSERVER
// ═══════════════════════════════════════════════════════════════

function startObserver() {
  stopObserver();
  mutObs = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) attachAll(node);
      }
    }
    // Coalesce: one full-body rescan per second max
    if (!pendingBodyScan) {
      pendingBodyScan = setTimeout(() => {
        pendingBodyScan = null;
        attachAll(document.body);
      }, 1000);
    }
  });
  mutObs.observe(document.body, { childList: true, subtree: true });
}

function stopObserver() {
  mutObs?.disconnect();
  mutObs = null;
}

// ═══════════════════════════════════════════════════════════════
// SPA NAVIGATION DETECTION
// ═══════════════════════════════════════════════════════════════

// Netflix is a SPA — the URL changes without a page reload.
// We poll location.href every second instead of observing the
// entire DOM just to detect URL changes.

function startUrlPoll() {
  stopUrlPoll();
  urlPollId = setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('URL changed → reinit');
      setTimeout(init, 500);
    }
  }, URL_POLL_MS);
}

function stopUrlPoll() {
  if (urlPollId) { clearInterval(urlPollId); urlPollId = null; }
}

// ═══════════════════════════════════════════════════════════════
// STORAGE LISTENER — react to enable/disable from popup
// ═══════════════════════════════════════════════════════════════

function onStorageChanged(changes, area) {
  if (area !== 'local' || !('enabled' in changes)) return;

  enabled = changes.enabled.newValue !== false;
  log('enabled →', enabled);

  if (!enabled) {
    clearTimeout(hoverTimer);
    clearTimeout(hideTimer);
    hoveredEl = null;
    hoveredTitle = null;
    hideOverlay();
  } else {
    init();
  }
}

// ═══════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════

function cleanup() {
  stopObserver();
  stopPositionPoll();
  clearTimeout(hoverTimer);
  clearTimeout(hideTimer);
  clearTimeout(pendingBodyScan);
  scanTimers.forEach(clearTimeout);

  hoverTimer = hideTimer = pendingBodyScan = null;
  scanTimers = [];
  requestSeq = 0;

  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseover', onDocMouseOver);
}

async function init() {
  log('init');
  cleanup();

  try {
    const s = await chrome.storage.local.get(['enabled', 'apiKey']);
    enabled = s.enabled !== false;
    if (!s.apiKey) log('WARNING: no API key configured');
  } catch {
    log('context invalidated');
    return;
  }

  if (!enabled) {
    if (!initialized) chrome.storage.onChanged.addListener(onStorageChanged);
    initialized = true;
    return;
  }

  ensureOverlay();

  document.addEventListener('mousemove', onMouseMove, { passive: true });
  document.addEventListener('mouseover', onDocMouseOver, { passive: true });

  if (!initialized) chrome.storage.onChanged.addListener(onStorageChanged);

  attachAll(document.body);
  startObserver();

  // Delayed rescans to catch lazy-loaded content
  scanTimers = RESCAN_DELAYS.map(ms =>
    setTimeout(() => attachAll(document.body), ms)
  );

  startUrlPoll();

  initialized = true;
  log('ready');
}

// ─── Bootstrap ────────────────────────────────────────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}

// ─── Page unload cleanup ──────────────────────────────────────

window.addEventListener('pagehide', () => {
  cleanup();
  stopUrlPoll();
});

})(); // end IIFE
