// Content script for Netflix Ratings Overlay
// Handles DOM interaction, hover events, and overlay display

const DEBOUNCE_MS = 300;
const HIDE_DELAY_MS = 500; // Delay before hiding to handle Netflix animations
const DEBUG = true;

let hoverTimeout = null;
let hideTimeout = null;
let currentHoveredElement = null;
let currentTitle = null;
let floatingOverlay = null;
let lastMouseX = 0;
let lastMouseY = 0;

function log(...args) {
  if (DEBUG) console.log('[Netflix Ratings]', ...args);
}

// Create floating overlay container (once)
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

// Title extraction functions
function extractTitleFromElement(element) {
  // Strategy 1: aria-label on the element or ancestors
  let ariaLabel = element.getAttribute('aria-label');
  if (!ariaLabel) {
    const parent = element.closest('[aria-label]');
    ariaLabel = parent?.getAttribute('aria-label');
  }
  if (ariaLabel && ariaLabel.length > 2 && !ariaLabel.includes('Account')) {
    log('Found aria-label:', ariaLabel);
    return parseAriaLabel(ariaLabel);
  }

  // Strategy 2: Image alt text
  const img = element.querySelector('img[alt]') ||
              element.querySelector('img') ||
              element.closest('[class*="card"]')?.querySelector('img[alt]');
  if (img?.alt && img.alt.length > 2) {
    log('Found img alt:', img.alt);
    return { title: img.alt.trim(), mediaType: 'movie' };
  }

  // Strategy 3: Look for title text in common locations (including preview modals)
  const titleSelectors = [
    '.fallback-text',
    '.title-card-title',
    '.previewModal-player-titleTreatment-logo',
    '.previewModal-title',
    '[class*="previewModal"] [class*="title"]',
    '[class*="jawBone"] [class*="title"]',
    '.bob-title',
    '[class*="title"]',
    'h1', 'h2', 'h3'
  ];

  for (const selector of titleSelectors) {
    const titleEl = element.querySelector(selector);
    if (titleEl) {
      // For logo images, check alt text
      if (titleEl.tagName === 'IMG' && titleEl.alt) {
        log('Found title via logo alt', selector, ':', titleEl.alt);
        return { title: titleEl.alt.trim(), mediaType: 'movie' };
      }
      // For text elements
      const text = titleEl.textContent?.trim();
      if (text && text.length > 2 && text.length < 100) {
        log('Found title via selector', selector, ':', text);
        return { title: text, mediaType: 'movie' };
      }
    }
  }

  // Strategy 4: Check for video player with title in nearby elements
  const videoTitleEl = document.querySelector('.watch-video--evidence-overlay-title, [class*="titleCard"] [class*="name"]');
  if (videoTitleEl?.textContent?.trim()) {
    log('Found title via video overlay:', videoTitleEl.textContent.trim());
    return { title: videoTitleEl.textContent.trim(), mediaType: 'movie' };
  }

  return null;
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

function normalizeTitle(title) {
  return title
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Floating overlay rendering
function showFloatingOverlay(element, data) {
  const overlay = createFloatingOverlay();

  // Build content
  if (data.loading) {
    overlay.innerHTML = '<div class="nro-ratings-loading"><span class="nro-spinner"></span></div>';
  } else if (data.error) {
    // Don't show errors - just hide
    hideFloatingOverlay();
    return;
  } else if (data.notFound) {
    // Don't show N/A - just hide
    hideFloatingOverlay();
    return;
  } else {
    const html = buildRatingHTML(data);
    if (!html) {
      // No ratings available - hide instead of showing N/A
      hideFloatingOverlay();
      return;
    }
    overlay.innerHTML = html;
  }

  // Position at top-left of the element
  positionOverlay(element);

  // Show it
  overlay.style.opacity = '1';
}

function positionOverlay(element) {
  if (!floatingOverlay) return;

  const rect = element.getBoundingClientRect();

  // For very small or collapsed elements, skip positioning
  if (rect.width < 10 || rect.height < 10) {
    return;
  }

  // Position at top-left of the element
  let left = rect.left + 8;
  let top = rect.top + 8;

  // Make sure it stays on screen
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

function hideFloatingOverlay() {
  if (floatingOverlay) {
    floatingOverlay.style.opacity = '0';
  }
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

  // Return null if no ratings available - we'll hide the overlay instead
  return parts.length > 0 ? parts.join('') : null;
}

// Event handlers
function handleMouseEnter(event) {
  const element = event.currentTarget;
  currentHoveredElement = element;

  // Cancel any pending hide
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

  // Don't immediately hide - use a delay to handle Netflix's animation
  // which creates new elements under the mouse
  clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    // Check if mouse is now over another Netflix element or the bob preview
    const elementUnderMouse = document.elementFromPoint(lastMouseX, lastMouseY);
    if (elementUnderMouse) {
      const isOverNetflixContent = elementUnderMouse.closest(
        '.slider-item, .title-card-container, .title-card, .bob-card, ' +
        '.mini-modal, [class*="previewModal"], [class*="jawBone"], ' +
        '.boxart-container, [class*="titleCard"], a[href*="/watch/"]'
      );

      if (isOverNetflixContent) {
        log('Mouse still over Netflix content, keeping overlay');
        // Re-attach to the new element
        currentHoveredElement = isOverNetflixContent;
        positionOverlay(currentHoveredElement);
        return;
      }
    }

    currentHoveredElement = null;
    currentTitle = null;
    hideFloatingOverlay();
  }, HIDE_DELAY_MS);
}

// Track mouse position globally (used for hide delay check)
function handleMouseMove(event) {
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
  // Note: We no longer update overlay position on mouse move
  // The overlay stays fixed at top-left of the element
}

async function fetchAndDisplayRating(element) {
  log('Fetching rating for element');

  // Check if extension context is still valid
  if (!chrome.runtime?.id) {
    log('Extension context invalidated - please refresh the page');
    return;
  }

  // Check if extension is enabled
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
    log('No title found for this element, keeping existing overlay');
    // Don't clear currentTitle - keep showing whatever we have
    return;
  }

  const normalizedTitle = normalizeTitle(titleInfo.title);

  // If we're already showing this title, don't refetch
  if (currentTitle === normalizedTitle && floatingOverlay?.style.opacity === '1') {
    log('Already showing rating for:', normalizedTitle);
    // Just reposition the overlay on the new element
    if (currentHoveredElement) {
      positionOverlay(currentHoveredElement);
    }
    return;
  }

  log('Title info:', titleInfo);
  currentTitle = normalizedTitle;

  // Show loading state
  showFloatingOverlay(element, { loading: true });

  try {
    log('Sending request for:', normalizedTitle);

    const rating = await chrome.runtime.sendMessage({
      type: 'FETCH_RATING',
      title: normalizedTitle,
      year: titleInfo.year,
      mediaType: titleInfo.mediaType
    });

    log('Received rating:', rating);

    // Show rating if we still have a hovered element and the title matches
    if (currentHoveredElement && currentTitle === normalizedTitle) {
      showFloatingOverlay(currentHoveredElement, rating);
    }
  } catch (error) {
    console.error('Netflix Ratings: Failed to fetch rating:', error);
    if (currentHoveredElement && currentTitle === normalizedTitle) {
      showFloatingOverlay(currentHoveredElement, { error: 'Failed to fetch rating' });
    }
  }
}

// Attach hover listeners to poster elements
function attachHoverListeners(container) {
  // Netflix poster selectors - including expanded preview elements
  const selectors = [
    '.slider-item',
    '.title-card-container',
    '.title-card',
    '.boxart-container',
    '.ptrack-content',
    '[class*="titleCard"]',
    'a[href*="/watch/"]',
    '.boxart-rounded',
    // Netflix expanded preview elements
    '.bob-card',
    '.mini-modal',
    '[class*="previewModal"]',
    '[class*="jawBone"]'
  ];

  const posters = container.querySelectorAll(selectors.join(', '));

  posters.forEach(poster => {
    if (poster.dataset.nroAttached) return;

    // Skip account/profile links
    const href = poster.getAttribute('href') || '';
    if (href.includes('Account') || href.includes('profile')) return;

    poster.dataset.nroAttached = 'true';
    poster.addEventListener('mouseenter', handleMouseEnter);
    poster.addEventListener('mouseleave', handleMouseLeave);
  });

  // Also attach to Netflix images
  const images = container.querySelectorAll('img[src*="nflximg"], img[src*="nflxso"]');
  images.forEach(img => {
    const parent = img.closest('a, div[class*="card"], div[class*="item"], div[class*="boxart"]');
    if (parent && !parent.dataset.nroAttached) {
      const href = parent.getAttribute('href') || '';
      if (href.includes('Account') || href.includes('profile')) return;

      parent.dataset.nroAttached = 'true';
      parent.addEventListener('mouseenter', handleMouseEnter);
      parent.addEventListener('mouseleave', handleMouseLeave);
    }
  });
}

// Initialize MutationObserver for dynamic content
function initObserver() {
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    mutations.forEach(mutation => {
      if (mutation.addedNodes.length > 0) {
        shouldScan = true;
        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            attachHoverListeners(node);
          }
        });
      }
    });

    if (shouldScan) {
      setTimeout(() => attachHoverListeners(document.body), 500);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  return observer;
}

// Global document mouseover to catch Netflix's dynamically created previews
function handleDocumentMouseOver(event) {
  const target = event.target;

  // Check if we're now over a Netflix preview element
  const previewElement = target.closest(
    '.bob-card, .mini-modal, [class*="previewModal"], [class*="jawBone"], ' +
    '.slider-item, .title-card-container, .title-card, .boxart-container'
  );

  if (previewElement && !previewElement.dataset.nroAttached) {
    // Cancel any pending hide
    clearTimeout(hideTimeout);

    // Attach listeners to this new element
    previewElement.dataset.nroAttached = 'true';
    previewElement.addEventListener('mouseenter', handleMouseEnter);
    previewElement.addEventListener('mouseleave', handleMouseLeave);

    // If we have a current overlay showing and this is a new preview element,
    // update the reference and keep showing
    if (floatingOverlay && floatingOverlay.style.opacity === '1') {
      currentHoveredElement = previewElement;
      positionOverlay(previewElement);
    }
  }
}

// Initialize the extension
async function init() {
  log('Starting initialization...');

  const settings = await chrome.storage.local.get(['enabled', 'apiKey']);
  log('Settings:', { enabled: settings.enabled, hasApiKey: !!settings.apiKey });

  if (settings.enabled === false) {
    log('Extension is disabled');
    return;
  }

  if (!settings.apiKey) {
    log('WARNING: No API key configured!');
  }

  // Create floating overlay
  createFloatingOverlay();

  // Track mouse movement for position updates
  document.addEventListener('mousemove', handleMouseMove, { passive: true });

  // Global mouseover to catch Netflix's dynamically created preview elements
  document.addEventListener('mouseover', handleDocumentMouseOver, { passive: true });

  // Initial scan
  attachHoverListeners(document.body);
  log('Initial scan complete');

  // Watch for dynamically loaded content
  initObserver();
  log('Observer started');

  // Re-scan after delays
  setTimeout(() => attachHoverListeners(document.body), 2000);
  setTimeout(() => attachHoverListeners(document.body), 5000);

  log('Initialization complete!');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Reinitialize when URL changes (Netflix SPA)
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    log('URL changed, reinitializing...');
    setTimeout(init, 1000);
  }
}).observe(document, { subtree: true, childList: true });
