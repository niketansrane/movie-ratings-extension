// Content script for Netflix Ratings Overlay
// Handles DOM interaction, hover events, and overlay display

const DEBOUNCE_MS = 300;
const HIDE_DELAY_MS = 600;
const POSITION_UPDATE_MS = 200;
const DEBUG = false;

let hoverTimeout = null;
let hideTimeout = null;
let positionInterval = null;
let currentHoveredElement = null;
let currentTitle = null;
let floatingOverlay = null;
let lastMouseX = 0;
let lastMouseY = 0;
let extensionEnabled = true;

let initialized = false;
let mutationObserver = null;
let urlObserver = null;
let attachScanTimeout = null;
let attachScanTimeout2 = null;
let pendingBodyScan = null;
let requestId = 0; // Monotonically increasing ID to track latest request

function log(...args) {
  if (DEBUG) console.log('[Netflix Ratings]', ...args);
}

// ─── Floating overlay (single instance) ───────────────────────

function createFloatingOverlay() {
  // Check if existing overlay is still in the DOM (SPA navigation can orphan it)
  if (floatingOverlay && document.body.contains(floatingOverlay)) {
    return floatingOverlay;
  }

  // Remove stale reference if orphaned
  if (floatingOverlay) {
    floatingOverlay = null;
  }

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

// ─── Title & metadata extraction ──────────────────────────────

// Extract comprehensive metadata from the Netflix DOM element to
// improve OMDb matching accuracy. We gather: title, year, mediaType.
function extractTitleFromElement(element) {
  let title = null;
  let year = null;
  let mediaType = null; // null = unknown, let service worker figure it out

  // ── Strategy 1: aria-label (richest source — often has year, season info) ──
  let ariaLabel = element.getAttribute('aria-label');
  if (!ariaLabel) {
    const parent = element.closest('[aria-label]');
    ariaLabel = parent?.getAttribute('aria-label');
  }
  if (ariaLabel && ariaLabel.length > 2 && !isNonTitleLabel(ariaLabel)) {
    log('Found aria-label:', ariaLabel);
    const parsed = parseAriaLabel(ariaLabel);
    title = parsed.title;
    year = parsed.year;
    mediaType = parsed.mediaType;
  }

  // ── Strategy 2: Image alt text ──
  if (!title) {
    const img = element.querySelector('img[alt]') ||
                element.closest('.title-card-container, .slider-item')?.querySelector('img[alt]');
    if (img?.alt && img.alt.length > 2 && !isNonTitleLabel(img.alt)) {
      log('Found img alt:', img.alt);
      title = img.alt.trim();
    }
  }

  // ── Strategy 3: Netflix-specific title selectors ──
  // Covers both small poster cards AND the large hero/billboard banner
  if (!title) {
    const titleSelectors = [
      // Hero banner / billboard selectors
      '.billboard-title .title-logo',
      '.hero-title .title-logo',
      '[class*="billboard"] .title-logo',
      '[class*="hero"] .title-logo',
      '[class*="billboard"] [class*="title-treatment"]',
      '[class*="billboard"] [class*="titleTreatment"]',
      '[class*="billboard-title"]',
      '[class*="hero-title"]',
      '.title-treatment',
      // Small poster card selectors
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
          title = titleEl.alt.trim();
          break;
        }
        const text = titleEl.textContent?.trim();
        if (text && text.length > 2 && text.length < 100 && !isNonTitleLabel(text)) {
          log('Found title via selector', selector, ':', text);
          title = text;
          break;
        }
      }
    }
  }

  // ── Strategy 4: Look in preview modal / billboard ancestors ──
  if (!title) {
    const roots = getSearchRoots(element);
    rootSearch:
    for (const root of roots) {
      if (root === element) continue; // Already searched element in strategies 1-3
      const ancestorTitleSelectors = [
        '.billboard-title .title-logo',
        '[class*="billboard"] .title-logo',
        '[class*="billboard"] [class*="title-treatment"]',
        '[class*="billboard"] [class*="titleTreatment"]',
        '[class*="billboard-title"]',
        '[class*="hero-title"]',
        '.title-treatment',
        '.previewModal-player-titleTreatment-logo',
        '.previewModal-title',
        '.bob-title',
      ];
      for (const selector of ancestorTitleSelectors) {
        const titleEl = root.querySelector(selector);
        if (titleEl) {
          if (titleEl.tagName === 'IMG' && titleEl.alt) {
            title = titleEl.alt.trim();
            break rootSearch;
          }
          const text = titleEl.textContent?.trim();
          if (text && text.length > 2 && text.length < 100) {
            title = text;
            break rootSearch;
          }
        }
      }
    }
  }

  if (!title) return null;

  // Try to extract year from nearby DOM elements
  if (!year) {
    year = extractYearFromDOM(element);
  }

  // Try to detect series vs movie from DOM clues
  if (!mediaType || mediaType === 'movie') {
    const detectedType = detectMediaTypeFromDOM(element);
    if (detectedType) {
      mediaType = detectedType;
    }
  }

  return {
    title,
    year,
    mediaType: mediaType || null, // null = let service worker search both
  };
}

// Helper: get the element and its relevant ancestors as search roots
function getSearchRoots(element) {
  const roots = [element];
  // Look for preview modal or billboard ancestor
  const ancestor = element.closest(
    '[class*="previewModal"], [class*="jawBone"], .bob-card, .mini-modal, ' +
    '[class*="billboard"], [class*="hero-image"], [class*="hero_billboard"]'
  );
  if (ancestor) roots.push(ancestor);
  return roots;
}

// Try to find a year in the DOM near the hovered element
function extractYearFromDOM(element) {
  const searchRoots = getSearchRoots(element);

  for (const root of searchRoots) {
    // Look in supplemental/metadata text elements
    const metaSelectors = [
      '.year',
      '[class*="year"]',
      '.duration',
      '[class*="duration"]',
      '.meta',
      '[class*="meta"]',
      '.supplemental-message',
      '[class*="supplemental"]',
      '.videoMetadata',
      '[class*="videoMetadata"]',
      '.previewModal--detailsMetadata-left',
      '[class*="detailsMetadata"]',
      // Hero banner metadata
      '[class*="billboard"] [class*="supplemental"]',
      '[class*="billboard"] [class*="info"]',
    ];

    for (const sel of metaSelectors) {
      const els = root.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent?.trim();
        if (text) {
          const yearMatch = text.match(/(?:^|\s)((?:19[5-9]\d|20[0-3]\d))(?:\s|$|,|\))/);
          if (yearMatch) {
            const candidateYear = parseInt(yearMatch[1]);
            const currentYear = new Date().getFullYear();
            if (candidateYear >= 1950 && candidateYear <= currentYear + 1) {
              log('Found year from DOM metadata:', yearMatch[1], 'in selector:', sel);
              return yearMatch[1];
            }
          }
        }
      }
    }
  }

  return null;
}

// Detect whether this is a series or movie from DOM clues
function detectMediaTypeFromDOM(element) {
  const searchRoots = getSearchRoots(element);

  const metaSelectors = [
    '.duration', '[class*="duration"]',
    '.meta', '[class*="meta"]',
    '.supplemental-message', '[class*="supplemental"]',
    '.episodeSelector', '[class*="episode"]',
    '.previewModal--detailsMetadata-left', '[class*="detailsMetadata"]',
    // Hero banner metadata
    '[class*="billboard"] [class*="supplemental"]',
    '[class*="billboard"] [class*="info"]',
  ];

  for (const root of searchRoots) {
    for (const sel of metaSelectors) {
      const els = root.querySelectorAll(sel);
      for (const el of els) {
        const metaText = el.textContent || '';

        // Series indicators — require specific patterns to avoid false positives
        // from titles like "A Series of Unfortunate Events"
        if (/\b(\d+\s+Seasons?|\d+\s+Episodes?|Season\s+\d|Episode\s+\d|Limited Series|TV Series|Mini.?Series)\b/i.test(metaText)) {
          log('Detected series from DOM metadata:', sel);
          return 'series';
        }

        // Movie indicators (duration like "1h 30m" or "2h 15m")
        if (/\b\d+h\s*\d*m?\b/i.test(metaText)) {
          log('Detected movie from duration format:', sel);
          return 'movie';
        }
      }
    }
  }

  return null;
}

function isNonTitleLabel(text) {
  const lower = text.toLowerCase();
  const skipWords = ['account', 'profile', 'search', 'menu', 'navigation',
    'close', 'play', 'pause', 'volume', 'mute', 'forward', 'back',
    'next', 'previous', 'settings', 'audio', 'subtitles', 'notifications'];
  return skipWords.some(w => lower === w || (lower.length < 20 && lower.includes(w)));
}

function parseAriaLabel(label) {
  // Match year formats: (2020), (2020–2024), (2020-2024), (2020-)
  const yearMatch = label.match(/\((\d{4})(?:\s*[-–]\s*\d{0,4})?\)/);
  const seasonMatch = label.match(/Season\s+\d+/i);
  const episodeMatch = label.match(/Episode\s+\d+/i);

  let title = label;
  let year = null;
  let mediaType = null;

  if (yearMatch) {
    year = yearMatch[1]; // Always use the start year
    title = label.replace(/\s*\(\d{4}(?:\s*[-–]\s*\d{0,4})?\)\s*/, ' ').trim();
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

function normalizeTitle(title) {
  return title
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Overlay rendering ───────────────────────────────────────

function showFloatingOverlay(element, data) {
  const overlay = createFloatingOverlay();

  // Toggle hero-mode class for larger badges on hero banners
  const heroMode = isHeroBanner(element);
  overlay.classList.toggle('nro-hero-mode', heroMode);

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
  startPositionTracking(element);
}

// ─── Overlay positioning — always top-left of the element ─────

function positionOverlay(element) {
  if (!floatingOverlay) return;

  // Check element is still in the DOM (Netflix animations can remove it)
  if (!document.body.contains(element)) return;

  const rect = element.getBoundingClientRect();

  // Skip if element is too small or not visible
  if (rect.width < 10 || rect.height < 10) return;

  // Determine if this is a hero/billboard banner (large element, typically full width)
  const isHero = isHeroBanner(element);
  const padding = isHero ? 20 : 8;

  // Always anchor to top-left corner of the element
  let left = rect.left + padding;
  let top = rect.top + padding;

  // Ensure the overlay stays within the viewport
  const overlayRect = floatingOverlay.getBoundingClientRect();
  const overlayWidth = overlayRect.width || 150;
  const overlayHeight = overlayRect.height || 30;

  // If top-left would push overlay off-screen right, clamp to right edge
  if (left + overlayWidth > window.innerWidth - 10) {
    left = window.innerWidth - overlayWidth - 10;
  }
  // If the element's top is above viewport (scrolled), clamp to top of viewport
  if (top < 10) top = 10;
  // If pushed below viewport, clamp
  if (top + overlayHeight > window.innerHeight - 10) {
    top = window.innerHeight - overlayHeight - 10;
  }
  if (left < 10) left = 10;

  floatingOverlay.style.left = `${left}px`;
  floatingOverlay.style.top = `${top}px`;
}

function isHeroBanner(element) {
  // Check if this element or an ancestor is a hero/billboard banner
  try {
    return !!(
      element.matches('[class*="billboard"], [class*="hero-image"], [class*="hero_billboard"]') ||
      element.closest('[class*="billboard"], [class*="hero-image"], [class*="hero_billboard"]')
    );
  } catch (e) {
    return false;
  }
}

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

// Escape HTML to prevent XSS from malformed API responses
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildRatingHTML(data) {
  const parts = [];

  if (data.imdbRating) {
    parts.push(`
      <div class="nro-rating-badge nro-imdb">
        <span class="nro-rating-icon">IMDb</span>
        <span class="nro-rating-value">${escapeHTML(data.imdbRating)}</span>
      </div>
    `);
  }

  if (data.rottenTomatoes) {
    const score = parseInt(data.rottenTomatoes);
    const freshness = score >= 60 ? 'fresh' : 'rotten';
    parts.push(`
      <div class="nro-rating-badge nro-rt nro-${freshness}">
        <span class="nro-rating-icon">RT</span>
        <span class="nro-rating-value">${escapeHTML(data.rottenTomatoes)}</span>
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

function handleMouseLeave(event) {
  clearTimeout(hoverTimeout);

  clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    const elementUnderMouse = document.elementFromPoint(lastMouseX, lastMouseY);
    if (elementUnderMouse) {
      const posterElement = findPosterAncestor(elementUnderMouse);

      if (posterElement) {
        log('Mouse still over Netflix content, keeping overlay');
        currentHoveredElement = posterElement;
        positionOverlay(currentHoveredElement);
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

  if (!extensionEnabled) {
    log('Extension is disabled');
    return;
  }

  const titleInfo = extractTitleFromElement(element);
  if (!titleInfo || !titleInfo.title) {
    log('No title found for this element');
    return;
  }

  const normalizedTitle = normalizeTitle(titleInfo.title);

  // Build a unique key that includes year and type for cache dedup
  const cacheDedup = `${normalizedTitle}|${titleInfo.year || ''}|${titleInfo.mediaType || ''}`;

  // If we're already showing this exact title+year+type, don't refetch
  if (currentTitle === cacheDedup && floatingOverlay?.style.opacity === '1') {
    log('Already showing rating for:', cacheDedup);
    if (currentHoveredElement) {
      positionOverlay(currentHoveredElement);
    }
    return;
  }

  log('Title info:', titleInfo);
  currentTitle = cacheDedup;

  // Increment request ID so stale in-flight responses are discarded
  const thisRequestId = ++requestId;

  // Only show spinner after 150ms (cached results return faster)
  const loadingTimer = setTimeout(() => {
    if (requestId === thisRequestId && currentHoveredElement === element) {
      showFloatingOverlay(element, { loading: true });
    }
  }, 150);

  try {
    log('Sending request for:', normalizedTitle, 'year:', titleInfo.year, 'type:', titleInfo.mediaType);

    const rating = await chrome.runtime.sendMessage({
      type: 'FETCH_RATING',
      title: normalizedTitle,
      year: titleInfo.year || null,
      mediaType: titleInfo.mediaType || null,
    });

    clearTimeout(loadingTimer);
    log('Received rating:', rating);

    // Only apply if this is still the latest request
    if (requestId === thisRequestId && currentHoveredElement) {
      showFloatingOverlay(currentHoveredElement, rating);
    }
  } catch (error) {
    clearTimeout(loadingTimer);
    console.error('Netflix Ratings: Failed to fetch rating:', error);
    if (requestId === thisRequestId && currentHoveredElement) {
      showFloatingOverlay(currentHoveredElement, { error: 'Failed to fetch rating' });
    }
  }
}

// ─── Poster & banner detection ────────────────────────────────

// Selectors for small poster cards (bottom half — rows of movies/series)
const POSTER_SELECTORS = [
  '.slider-item',
  '.title-card-container',
  '.bob-card',
  '.mini-modal',
  '[class*="previewModal"]',
  '[class*="jawBone"]',
];

// Selectors for the hero/billboard banner (top half — featured movie)
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

const ALL_SELECTORS = [...POSTER_SELECTORS, ...HERO_SELECTORS];
const ALL_SELECTOR_STRING = ALL_SELECTORS.join(', ');

function findPosterAncestor(el) {
  let best = null;
  let current = el;

  while (current && current !== document.body) {
    if (matchesAnySelector(current)) {
      best = current;
    }
    current = current.parentElement;
  }

  return best;
}

function matchesAnySelector(el) {
  try {
    return el.matches && el.matches(ALL_SELECTOR_STRING);
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

function attachHoverListeners(container) {
  const elements = container.querySelectorAll(ALL_SELECTOR_STRING);

  elements.forEach(el => {
    if (el.dataset.nroAttached) return;

    // Skip if any ancestor is already attached (outermost-only strategy)
    const parentEl = el.parentElement?.closest(ALL_SELECTOR_STRING);
    if (parentEl && parentEl.dataset.nroAttached) return;

    // If parent exists within this container but isn't attached yet,
    // skip this child — the parent will be processed in its own iteration.
    if (parentEl && container.contains(parentEl)) return;

    const href = el.getAttribute('href') || '';
    if (href.includes('Account') || href.includes('profile')) return;

    el.dataset.nroAttached = 'true';
    el.addEventListener('mouseenter', handleMouseEnter);
    el.addEventListener('mouseleave', handleMouseLeave);
  });

  // Also attach directly to the container if it matches (e.g., MutationObserver
  // adds a billboard node itself, not just children)
  if (!container.dataset?.nroAttached && matchesAnySelector(container)) {
    container.dataset.nroAttached = 'true';
    container.addEventListener('mouseenter', handleMouseEnter);
    container.addEventListener('mouseleave', handleMouseLeave);
  }
}

// ─── MutationObserver ─────────────────────────────────────────

function initObserver() {
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }

  mutationObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          attachHoverListeners(node);
        }
      }
    }

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

// ─── Document-level mouseover for dynamic content ─────────────

function handleDocumentMouseOver(event) {
  if (!extensionEnabled) return;

  const target = event.target;

  // Early bail: skip non-element targets
  if (!target || !target.closest) return;

  const matchedElement = findPosterAncestor(target);

  if (matchedElement && !matchedElement.dataset.nroAttached) {
    clearTimeout(hideTimeout);
    ensureListenerAttached(matchedElement);

    if (floatingOverlay && floatingOverlay.style.opacity === '1') {
      currentHoveredElement = matchedElement;
      positionOverlay(matchedElement);
    }
  }
}

// ─── Listen for enable/disable changes from popup ─────────────

function onStorageChanged(changes, area) {
  if (area !== 'local') return;

  if ('enabled' in changes) {
    extensionEnabled = changes.enabled.newValue !== false;
    log('Extension enabled changed to:', extensionEnabled);

    if (!extensionEnabled) {
      clearTimeout(hoverTimeout);
      clearTimeout(hideTimeout);
      currentHoveredElement = null;
      currentTitle = null;
      hideFloatingOverlay();
    } else {
      // Re-initialize when re-enabled so overlay, observers, and listeners are set up
      init();
    }
  }
}

// ─── Cleanup ──────────────────────────────────────────────────

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
  requestId = 0;

  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseover', handleDocumentMouseOver);
}

// ─── Initialization ───────────────────────────────────────────

async function init() {
  log('Starting initialization...');

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
    if (!initialized) {
      chrome.storage.onChanged.addListener(onStorageChanged);
    }
    initialized = true;
    return;
  }

  if (!settings.apiKey) {
    log('WARNING: No API key configured!');
  }

  createFloatingOverlay();

  document.addEventListener('mousemove', handleMouseMove, { passive: true });
  document.addEventListener('mouseover', handleDocumentMouseOver, { passive: true });

  if (!initialized) {
    chrome.storage.onChanged.addListener(onStorageChanged);
  }

  attachHoverListeners(document.body);
  log('Initial scan complete');

  initObserver();
  log('Observer started');

  attachScanTimeout = setTimeout(() => attachHoverListeners(document.body), 2000);
  attachScanTimeout2 = setTimeout(() => attachHoverListeners(document.body), 5000);

  initialized = true;
  log('Initialization complete!');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

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

// Clean up intervals and observers when the page unloads
window.addEventListener('beforeunload', () => {
  cleanup();
  if (urlObserver) {
    urlObserver.disconnect();
    urlObserver = null;
  }
});
