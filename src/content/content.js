// Content script for Netflix Ratings Overlay
// Handles DOM interaction, hover events, and overlay display

const DEBOUNCE_MS = 300;
const HIDE_DELAY_MS = 600;
const POSITION_UPDATE_MS = 200; // Interval for repositioning overlay to track animations
const DEBUG = false; // Issue #14: Disabled for production

let hoverTimeout = null;
let hideTimeout = null;
let positionInterval = null;
let currentHoveredElement = null;
let currentTitle = null;
let floatingOverlay = null;
let lastMouseX = 0;
let lastMouseY = 0;
let extensionEnabled = true;

// Issue #3: Track initialization state to prevent duplicate setup
let initialized = false;
let mutationObserver = null;
let urlObserver = null;
let attachScanTimeout = null;
let attachScanTimeout2 = null;

// Issue #4: Debounce full-body scans from MutationObserver
let pendingBodyScan = null;

function log(...args) {
  if (DEBUG) console.log('[Netflix Ratings]', ...args);
}

// ─── Floating overlay (single instance) ───────────────────────

function createFloatingOverlay() {
  if (floatingOverlay) return floatingOverlay;

  floatingOverlay = document.createElement('div');
  floatingOverlay.id = 'nro-floating-overlay';
  floatingOverlay.style.cssText = `
    position: fixed !important;
    z-index: 999999 !important;
    pointer-events: none !important;
    opacity: 0;
    transition: opacity 0.15s ease-out;
    display: flex;
    gap: 4px;
  `;
  document.body.appendChild(floatingOverlay);
  return floatingOverlay;
}

// ─── Title extraction ─────────────────────────────────────────

// Issue #5: Use a curated list of Netflix-specific selectors only.
// Removed overly broad selectors like [class*="title"], h1, h2, h3
// that match section headers and navigation elements.
function extractTitleFromElement(element) {
  // Strategy 1: aria-label on the element or ancestors
  let ariaLabel = element.getAttribute('aria-label');
  if (!ariaLabel) {
    const parent = element.closest('[aria-label]');
    ariaLabel = parent?.getAttribute('aria-label');
  }
  if (ariaLabel && ariaLabel.length > 2 && !isNonTitleLabel(ariaLabel)) {
    log('Found aria-label:', ariaLabel);
    return parseAriaLabel(ariaLabel);
  }

  // Strategy 2: Image alt text
  const img = element.querySelector('img[alt]') ||
              element.closest('.title-card-container, .slider-item')?.querySelector('img[alt]');
  if (img?.alt && img.alt.length > 2 && !isNonTitleLabel(img.alt)) {
    log('Found img alt:', img.alt);
    return { title: img.alt.trim(), mediaType: 'movie' };
  }

  // Strategy 3: Netflix-specific title selectors only (no generic h1/h2/h3)
  const titleSelectors = [
    '.fallback-text',
    '.title-card-title',
    '.previewModal-player-titleTreatment-logo',
    '.previewModal-title',
    '.bob-title',
  ];

  for (const selector of titleSelectors) {
    const titleEl = element.querySelector(selector);
    if (titleEl) {
      if (titleEl.tagName === 'IMG' && titleEl.alt) {
        log('Found title via logo alt', selector, ':', titleEl.alt);
        return { title: titleEl.alt.trim(), mediaType: 'movie' };
      }
      const text = titleEl.textContent?.trim();
      if (text && text.length > 2 && text.length < 100 && !isNonTitleLabel(text)) {
        log('Found title via selector', selector, ':', text);
        return { title: text, mediaType: 'movie' };
      }
    }
  }

  // Strategy 4: Look in preview modal ancestors (for expanded cards)
  const previewModal = element.closest('[class*="previewModal"], [class*="jawBone"], .bob-card, .mini-modal');
  if (previewModal) {
    for (const selector of ['.previewModal-player-titleTreatment-logo', '.previewModal-title', '.bob-title']) {
      const titleEl = previewModal.querySelector(selector);
      if (titleEl) {
        if (titleEl.tagName === 'IMG' && titleEl.alt) {
          return { title: titleEl.alt.trim(), mediaType: 'movie' };
        }
        const text = titleEl.textContent?.trim();
        if (text && text.length > 2 && text.length < 100) {
          return { title: text, mediaType: 'movie' };
        }
      }
    }
  }

  return null;
}

// Filter out non-title aria-labels and text
function isNonTitleLabel(text) {
  const lower = text.toLowerCase();
  const skipWords = ['account', 'profile', 'search', 'menu', 'navigation',
    'close', 'play', 'pause', 'volume', 'mute', 'forward', 'back',
    'next', 'previous', 'settings', 'audio', 'subtitles', 'notifications'];
  return skipWords.some(w => lower === w || (lower.length < 20 && lower.includes(w)));
}

function parseAriaLabel(label) {
  const yearMatch = label.match(/\((\d{4})\)/);
  const seasonMatch = label.match(/Season\s+\d+/i);
  const episodeMatch = label.match(/Episode\s+\d+/i);

  let title = label;
  let year = null;
  let mediaType = 'movie';

  if (yearMatch) {
    year = yearMatch[1];
    title = label.replace(/\s*\(\d{4}\)\s*/, ' ').trim();
  }

  if (seasonMatch || episodeMatch) {
    mediaType = 'series';
    title = title.replace(/\s*-?\s*Season\s+\d+.*/i, '').trim();
    title = title.replace(/\s*-?\s*Episode\s+\d+.*/i, '').trim();
  }

  // Remove trailer/teaser prefixes
  title = title.replace(/^(Trailer|Teaser):\s*/i, '').trim();
  title = title.replace(/\s*-\s*$/, '').trim();

  return { title, year, mediaType };
}

// Issue #8: Preserve characters that are meaningful for OMDb searches
// Only collapse whitespace and trim — keep hyphens, apostrophes, colons, etc.
function normalizeTitle(title) {
  return title
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Overlay rendering ───────────────────────────────────────

function showFloatingOverlay(element, data) {
  const overlay = createFloatingOverlay();

  if (data.loading) {
    overlay.innerHTML = '<div class="nro-ratings-loading"><span class="nro-spinner"></span></div>';
  } else if (data.error) {
    hideFloatingOverlay();
    return;
  } else if (data.notFound) {
    hideFloatingOverlay();
    return;
  } else {
    const html = buildRatingHTML(data);
    if (!html) {
      hideFloatingOverlay();
      return;
    }
    overlay.innerHTML = html;
  }

  positionOverlay(element);
  overlay.style.opacity = '1';

  // Issue #6: Start interval to reposition overlay as Netflix animates the element
  startPositionTracking(element);
}

function positionOverlay(element) {
  if (!floatingOverlay) return;

  const rect = element.getBoundingClientRect();

  if (rect.width < 10 || rect.height < 10) {
    return;
  }

  let left = rect.left + 8;
  let top = rect.top + 8;

  const overlayRect = floatingOverlay.getBoundingClientRect();
  const overlayWidth = overlayRect.width || 150;
  const overlayHeight = overlayRect.height || 30;

  if (left + overlayWidth > window.innerWidth) {
    left = rect.right - overlayWidth - 8;
  }
  if (top + overlayHeight > window.innerHeight) {
    top = window.innerHeight - overlayHeight - 10;
  }
  if (left < 0) left = 10;
  if (top < 0) top = 10;

  floatingOverlay.style.left = `${left}px`;
  floatingOverlay.style.top = `${top}px`;
}

// Issue #6: Periodically reposition overlay to follow animated poster elements
function startPositionTracking(element) {
  stopPositionTracking();
  positionInterval = setInterval(() => {
    if (currentHoveredElement && floatingOverlay?.style.opacity === '1') {
      positionOverlay(currentHoveredElement);
    } else {
      stopPositionTracking();
    }
  }, POSITION_UPDATE_MS);
}

function stopPositionTracking() {
  if (positionInterval) {
    clearInterval(positionInterval);
    positionInterval = null;
  }
}

function hideFloatingOverlay() {
  if (floatingOverlay) {
    floatingOverlay.style.opacity = '0';
  }
  stopPositionTracking();
}

function buildRatingHTML(data) {
  const parts = [];

  if (data.imdbRating && data.imdbRating !== 'N/A') {
    parts.push(`
      <div class="nro-rating-badge nro-imdb">
        <span class="nro-rating-icon">IMDb</span>
        <span class="nro-rating-value">${data.imdbRating}</span>
      </div>
    `);
  }

  if (data.rottenTomatoes) {
    const score = parseInt(data.rottenTomatoes);
    const freshness = score >= 60 ? 'fresh' : 'rotten';
    parts.push(`
      <div class="nro-rating-badge nro-rt nro-${freshness}">
        <span class="nro-rating-icon">RT</span>
        <span class="nro-rating-value">${data.rottenTomatoes}</span>
      </div>
    `);
  }

  return parts.length > 0 ? parts.join('') : null;
}

// ─── Event handlers ───────────────────────────────────────────

function handleMouseEnter(event) {
  if (!extensionEnabled) return;

  const element = event.currentTarget;
  currentHoveredElement = element;

  clearTimeout(hideTimeout);
  clearTimeout(hoverTimeout);

  hoverTimeout = setTimeout(() => {
    if (currentHoveredElement === element) {
      fetchAndDisplayRating(element);
    }
  }, DEBOUNCE_MS);
}

// Issue #1: Improved mouseleave handling for Netflix's DOM-replacing animations.
// Uses a longer delay and checks whether we're now over a related Netflix element.
function handleMouseLeave(event) {
  clearTimeout(hoverTimeout);

  clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    const elementUnderMouse = document.elementFromPoint(lastMouseX, lastMouseY);
    if (elementUnderMouse) {
      // Find the best poster-level ancestor under the mouse
      const posterElement = findPosterAncestor(elementUnderMouse);

      if (posterElement) {
        log('Mouse still over Netflix content, keeping overlay');
        currentHoveredElement = posterElement;
        positionOverlay(currentHoveredElement);

        // Ensure listeners are attached to the new element
        ensureListenerAttached(posterElement);
        return;
      }
    }

    currentHoveredElement = null;
    currentTitle = null;
    hideFloatingOverlay();
  }, HIDE_DELAY_MS);
}

function handleMouseMove(event) {
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
}

async function fetchAndDisplayRating(element) {
  log('Fetching rating for element');

  if (!chrome.runtime?.id) {
    log('Extension context invalidated - please refresh the page');
    return;
  }

  let settings;
  try {
    settings = await chrome.storage.local.get('enabled');
  } catch (e) {
    log('Extension context invalidated - please refresh the page');
    return;
  }

  if (settings.enabled === false) {
    log('Extension is disabled');
    return;
  }

  const titleInfo = extractTitleFromElement(element);
  if (!titleInfo || !titleInfo.title) {
    log('No title found for this element');
    return;
  }

  const normalizedTitle = normalizeTitle(titleInfo.title);

  // If we're already showing this title, don't refetch
  if (currentTitle === normalizedTitle && floatingOverlay?.style.opacity === '1') {
    log('Already showing rating for:', normalizedTitle);
    if (currentHoveredElement) {
      positionOverlay(currentHoveredElement);
    }
    return;
  }

  log('Title info:', titleInfo);
  currentTitle = normalizedTitle;

  // Issue #11: Don't show loading spinner — let the service worker check cache first.
  // The cache check is fast (~1-5ms). Only show spinner if it takes longer than 150ms.
  let loadingShown = false;
  const loadingTimer = setTimeout(() => {
    if (currentHoveredElement === element && currentTitle === normalizedTitle) {
      showFloatingOverlay(element, { loading: true });
      loadingShown = true;
    }
  }, 150);

  try {
    log('Sending request for:', normalizedTitle);

    const rating = await chrome.runtime.sendMessage({
      type: 'FETCH_RATING',
      title: normalizedTitle,
      year: titleInfo.year,
      mediaType: titleInfo.mediaType
    });

    clearTimeout(loadingTimer);
    log('Received rating:', rating);

    if (currentHoveredElement && currentTitle === normalizedTitle) {
      showFloatingOverlay(currentHoveredElement, rating);
    }
  } catch (error) {
    clearTimeout(loadingTimer);
    console.error('Netflix Ratings: Failed to fetch rating:', error);
    if (currentHoveredElement && currentTitle === normalizedTitle) {
      showFloatingOverlay(currentHoveredElement, { error: 'Failed to fetch rating' });
    }
  }
}

// ─── Poster detection & listener attachment ───────────────────

// Issue #2: Use a single canonical selector to find the best poster-level
// element. Instead of attaching to every nested element, find the outermost
// poster container. This avoids multiple overlapping listeners.
const POSTER_SELECTORS = [
  '.slider-item',
  '.title-card-container',
  '.bob-card',
  '.mini-modal',
  '[class*="previewModal"]',
  '[class*="jawBone"]',
];

// Selector string for querySelectorAll
const POSTER_SELECTOR_STRING = POSTER_SELECTORS.join(', ');

// Given any element, find its outermost poster ancestor
function findPosterAncestor(el) {
  let best = null;
  let current = el;

  // Walk up to find the outermost poster container
  while (current && current !== document.body) {
    if (matchesPosterSelector(current)) {
      best = current;
    }
    current = current.parentElement;
  }

  // If no ancestor found, check if the element itself matches
  if (!best && matchesPosterSelector(el)) {
    best = el;
  }

  return best;
}

function matchesPosterSelector(el) {
  try {
    return el.matches && el.matches(POSTER_SELECTOR_STRING);
  } catch (e) {
    return false;
  }
}

function ensureListenerAttached(element) {
  if (element && !element.dataset.nroAttached) {
    const href = element.getAttribute('href') || '';
    if (href.includes('Account') || href.includes('profile')) return;

    element.dataset.nroAttached = 'true';
    element.addEventListener('mouseenter', handleMouseEnter);
    element.addEventListener('mouseleave', handleMouseLeave);
  }
}

// Issue #2: Attach listeners only to the outermost poster container,
// not to every nested child that matches a selector.
function attachHoverListeners(container) {
  const posters = container.querySelectorAll(POSTER_SELECTOR_STRING);

  posters.forEach(poster => {
    // Skip if already attached
    if (poster.dataset.nroAttached) return;

    // Issue #2: Skip if a parent poster already has listeners
    // (only attach to outermost poster element)
    const parentPoster = poster.parentElement?.closest(POSTER_SELECTOR_STRING);
    if (parentPoster && parentPoster.dataset.nroAttached) return;

    // Skip account/profile links
    const href = poster.getAttribute('href') || '';
    if (href.includes('Account') || href.includes('profile')) return;

    poster.dataset.nroAttached = 'true';
    poster.addEventListener('mouseenter', handleMouseEnter);
    poster.addEventListener('mouseleave', handleMouseLeave);
  });
}

// ─── MutationObserver ─────────────────────────────────────────

// Issue #3 & #4: Single observer, debounced body scans, no duplicate setup
function initObserver() {
  // Disconnect any existing observer
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }

  mutationObserver = new MutationObserver((mutations) => {
    // Attach to newly added nodes directly
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          attachHoverListeners(node);
        }
      }
    }

    // Issue #4: Debounce the full-body scan — at most once per second
    if (!pendingBodyScan) {
      pendingBodyScan = setTimeout(() => {
        pendingBodyScan = null;
        attachHoverListeners(document.body);
      }, 1000);
    }
  });

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  return mutationObserver;
}

// ─── Document-level mouseover for dynamic previews ────────────

function handleDocumentMouseOver(event) {
  if (!extensionEnabled) return;

  const target = event.target;

  // Find the poster element under the mouse
  const posterElement = findPosterAncestor(target);

  if (posterElement && !posterElement.dataset.nroAttached) {
    clearTimeout(hideTimeout);

    ensureListenerAttached(posterElement);

    // If we have a current overlay showing, update to track new element
    if (floatingOverlay && floatingOverlay.style.opacity === '1') {
      currentHoveredElement = posterElement;
      positionOverlay(posterElement);
    }
  }
}

// ─── Listen for enable/disable changes from popup ─────────────

// Issue #9: React to storage changes (enable/disable toggle)
function onStorageChanged(changes, area) {
  if (area !== 'local') return;

  if ('enabled' in changes) {
    extensionEnabled = changes.enabled.newValue !== false;
    log('Extension enabled changed to:', extensionEnabled);

    if (!extensionEnabled) {
      // Immediately hide overlay and clear state
      clearTimeout(hoverTimeout);
      clearTimeout(hideTimeout);
      currentHoveredElement = null;
      currentTitle = null;
      hideFloatingOverlay();
    }
  }
}

// ─── Cleanup ──────────────────────────────────────────────────

// Issue #3: Proper cleanup so re-init doesn't stack listeners/observers
function cleanup() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }

  clearTimeout(hoverTimeout);
  clearTimeout(hideTimeout);
  clearTimeout(attachScanTimeout);
  clearTimeout(attachScanTimeout2);
  clearTimeout(pendingBodyScan);
  stopPositionTracking();

  hoverTimeout = null;
  hideTimeout = null;
  attachScanTimeout = null;
  attachScanTimeout2 = null;
  pendingBodyScan = null;

  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseover', handleDocumentMouseOver);

  // Note: We do NOT remove per-element mouseenter/mouseleave listeners
  // because they are guarded by dataset.nroAttached and are harmless to keep.
}

// ─── Initialization ───────────────────────────────────────────

// Issue #3: Guard against duplicate initialization
async function init() {
  log('Starting initialization...');

  // Clean up any previous state
  cleanup();

  let settings;
  try {
    settings = await chrome.storage.local.get(['enabled', 'apiKey']);
  } catch (e) {
    log('Extension context invalidated');
    return;
  }

  extensionEnabled = settings.enabled !== false;
  log('Settings:', { enabled: extensionEnabled, hasApiKey: !!settings.apiKey });

  if (!extensionEnabled) {
    log('Extension is disabled');
    // Still set up storage listener so we can re-enable
    if (!initialized) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }
    initialized = true;
    return;
  }

  if (!settings.apiKey) {
    log('WARNING: No API key configured!');
  }

  // Create floating overlay
  createFloatingOverlay();

  // Track mouse movement
  document.addEventListener('mousemove', handleMouseMove, { passive: true });

  // Global mouseover to catch dynamically created preview elements
  document.addEventListener('mouseover', handleDocumentMouseOver, { passive: true });

  // Issue #9: Listen for storage changes (enable/disable from popup)
  if (!initialized) {
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  // Initial scan
  attachHoverListeners(document.body);
  log('Initial scan complete');

  // Watch for dynamically loaded content
  initObserver();
  log('Observer started');

  // Re-scan after delays for lazy-loaded content
  attachScanTimeout = setTimeout(() => attachHoverListeners(document.body), 2000);
  attachScanTimeout2 = setTimeout(() => attachHoverListeners(document.body), 5000);

  initialized = true;
  log('Initialization complete!');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Issue #3: Reinitialize on URL changes without stacking observers.
// Use a single URL observer, and call init() which cleans up first.
let lastUrl = location.href;
urlObserver = new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    log('URL changed, reinitializing...');
    setTimeout(init, 1000);
  }
});
urlObserver.observe(document, { subtree: true, childList: true });
