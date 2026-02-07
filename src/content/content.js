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

// ─── Title & metadata extraction ──────────────────────────────

// Extract comprehensive metadata from the Netflix DOM element to
// improve OMDb matching accuracy. We gather: title, year, mediaType,
// and Netflix video ID when available.
function extractTitleFromElement(element) {
  let title = null;
  let year = null;
  let mediaType = null; // null = unknown, let service worker figure it out

  // ── Extract Netflix video ID from links ──
  const netflixId = extractNetflixId(element);

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
  if (!title) {
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

  // ── Strategy 4: Look in preview modal ancestors ──
  if (!title) {
    const previewModal = element.closest('[class*="previewModal"], [class*="jawBone"], .bob-card, .mini-modal');
    if (previewModal) {
      for (const selector of ['.previewModal-player-titleTreatment-logo', '.previewModal-title', '.bob-title']) {
        const titleEl = previewModal.querySelector(selector);
        if (titleEl) {
          if (titleEl.tagName === 'IMG' && titleEl.alt) {
            title = titleEl.alt.trim();
            break;
          }
          const text = titleEl.textContent?.trim();
          if (text && text.length > 2 && text.length < 100) {
            title = text;
            break;
          }
        }
      }
    }
  }

  if (!title) return null;

  // ── Now try to enrich year and mediaType from DOM if not already set ──

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
    netflixId
  };
}

// Extract Netflix video ID from <a href="/watch/12345"> links
function extractNetflixId(element) {
  // Check for a link with /watch/ or /title/ in the href
  const link = element.querySelector('a[href*="/watch/"], a[href*="/title/"]') ||
               element.closest('a[href*="/watch/"], a[href*="/title/"]');

  if (link) {
    const href = link.getAttribute('href') || '';
    const match = href.match(/\/(?:watch|title)\/(\d+)/);
    if (match) {
      log('Found Netflix ID:', match[1]);
      return match[1];
    }
  }

  // Also check data attributes that Netflix sometimes uses
  const dataId = element.getAttribute('data-id') ||
                 element.getAttribute('data-video-id') ||
                 element.closest('[data-id]')?.getAttribute('data-id') ||
                 element.closest('[data-video-id]')?.getAttribute('data-video-id');
  if (dataId) {
    log('Found Netflix data ID:', dataId);
    return dataId;
  }

  return null;
}

// Try to find a year in the DOM near the hovered element
function extractYearFromDOM(element) {
  // Search within the element and its preview modal for year-like text
  const searchRoots = [element];
  const previewModal = element.closest('[class*="previewModal"], [class*="jawBone"], .bob-card, .mini-modal');
  if (previewModal) searchRoots.push(previewModal);

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
    ];

    for (const sel of metaSelectors) {
      const els = root.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent?.trim();
        if (text) {
          // Match a standalone 4-digit year (1900-2099)
          const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
          if (yearMatch) {
            log('Found year from DOM metadata:', yearMatch[1], 'in selector:', sel);
            return yearMatch[1];
          }
        }
      }
    }
  }

  return null;
}

// Detect whether this is a series or movie from DOM clues
function detectMediaTypeFromDOM(element) {
  const searchRoots = [element];
  const previewModal = element.closest('[class*="previewModal"], [class*="jawBone"], .bob-card, .mini-modal');
  if (previewModal) searchRoots.push(previewModal);

  for (const root of searchRoots) {
    const textContent = root.textContent || '';

    // Look for series indicators
    if (/\b(Season|Episode|Series|Limited Series|Episodes)\b/i.test(textContent)) {
      // Make sure it's from metadata, not from a title like "American Horror Story"
      const metaSelectors = [
        '.duration', '[class*="duration"]',
        '.meta', '[class*="meta"]',
        '.supplemental-message', '[class*="supplemental"]',
        '.episodeSelector', '[class*="episode"]',
        '.previewModal--detailsMetadata-left', '[class*="detailsMetadata"]',
      ];

      for (const sel of metaSelectors) {
        const els = root.querySelectorAll(sel);
        for (const el of els) {
          const metaText = el.textContent || '';
          if (/\b(Season|Episode|Series|Limited Series|Episodes)\b/i.test(metaText)) {
            log('Detected series from DOM metadata:', sel);
            return 'series';
          }
        }
      }
    }

    // Look for movie indicators (duration like "1h 30m" or "2h 15m")
    const metaSelectors = [
      '.duration', '[class*="duration"]',
      '.meta', '[class*="meta"]',
      '.supplemental-message', '[class*="supplemental"]',
      '.previewModal--detailsMetadata-left', '[class*="detailsMetadata"]',
    ];

    for (const sel of metaSelectors) {
      const els = root.querySelectorAll(sel);
      for (const el of els) {
        const metaText = el.textContent || '';
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
  const yearMatch = label.match(/\((\d{4})\)/);
  const seasonMatch = label.match(/Season\s+\d+/i);
  const episodeMatch = label.match(/Episode\s+\d+/i);

  let title = label;
  let year = null;
  let mediaType = null;

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

  // Only show spinner after 150ms (cached results return faster)
  const loadingTimer = setTimeout(() => {
    if (currentHoveredElement === element && currentTitle === cacheDedup) {
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

    if (currentHoveredElement && currentTitle === cacheDedup) {
      showFloatingOverlay(currentHoveredElement, rating);
    }
  } catch (error) {
    clearTimeout(loadingTimer);
    console.error('Netflix Ratings: Failed to fetch rating:', error);
    if (currentHoveredElement && currentTitle === cacheDedup) {
      showFloatingOverlay(currentHoveredElement, { error: 'Failed to fetch rating' });
    }
  }
}

// ─── Poster detection & listener attachment ───────────────────

const POSTER_SELECTORS = [
  '.slider-item',
  '.title-card-container',
  '.bob-card',
  '.mini-modal',
  '[class*="previewModal"]',
  '[class*="jawBone"]',
];

const POSTER_SELECTOR_STRING = POSTER_SELECTORS.join(', ');

function findPosterAncestor(el) {
  let best = null;
  let current = el;

  while (current && current !== document.body) {
    if (matchesPosterSelector(current)) {
      best = current;
    }
    current = current.parentElement;
  }

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

function attachHoverListeners(container) {
  const posters = container.querySelectorAll(POSTER_SELECTOR_STRING);

  posters.forEach(poster => {
    if (poster.dataset.nroAttached) return;

    const parentPoster = poster.parentElement?.closest(POSTER_SELECTOR_STRING);
    if (parentPoster && parentPoster.dataset.nroAttached) return;

    const href = poster.getAttribute('href') || '';
    if (href.includes('Account') || href.includes('profile')) return;

    poster.dataset.nroAttached = 'true';
    poster.addEventListener('mouseenter', handleMouseEnter);
    poster.addEventListener('mouseleave', handleMouseLeave);
  });
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

// ─── Document-level mouseover for dynamic previews ────────────

function handleDocumentMouseOver(event) {
  if (!extensionEnabled) return;

  const target = event.target;
  const posterElement = findPosterAncestor(target);

  if (posterElement && !posterElement.dataset.nroAttached) {
    clearTimeout(hideTimeout);
    ensureListenerAttached(posterElement);

    if (floatingOverlay && floatingOverlay.style.opacity === '1') {
      currentHoveredElement = posterElement;
      positionOverlay(posterElement);
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
