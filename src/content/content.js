// Content script for Netflix Ratings Overlay
// Handles DOM interaction, hover events, and overlay display

const DEBOUNCE_MS = 300;
let hoverTimeout = null;
let currentHoveredElement = null;

// Title extraction functions
function extractTitleFromElement(element) {
  // Netflix uses various methods to display titles
  // Try multiple strategies in order of reliability

  // Strategy 1: aria-label on the title card or its ancestors
  let ariaLabel = element.getAttribute('aria-label');
  if (!ariaLabel) {
    const parent = element.closest('[aria-label]');
    ariaLabel = parent?.getAttribute('aria-label');
  }
  if (ariaLabel && ariaLabel.length > 2) {
    return parseAriaLabel(ariaLabel);
  }

  // Strategy 2: Title in the bob-card (expanded hover state)
  const bobTitle = element.closest('.title-card-container')?.querySelector('.bob-title, .fallback-text');
  if (bobTitle?.textContent) {
    return { title: bobTitle.textContent.trim(), mediaType: 'movie' };
  }

  // Strategy 3: Image alt text
  const img = element.querySelector('img[alt]') || element.closest('.title-card')?.querySelector('img[alt]');
  if (img?.alt && img.alt.length > 2) {
    return { title: img.alt.trim(), mediaType: 'movie' };
  }

  // Strategy 4: data-uia title elements
  const titleCard = element.closest('.title-card, .slider-item, .title-card-container');
  if (titleCard) {
    const titleData = titleCard.querySelector('[data-uia*="title"]');
    if (titleData?.textContent) {
      return { title: titleData.textContent.trim(), mediaType: 'movie' };
    }
  }

  // Strategy 5: Look for any text content in typical Netflix title locations
  const possibleTitleElements = element.querySelectorAll('p, span, div');
  for (const el of possibleTitleElements) {
    const text = el.textContent?.trim();
    if (text && text.length > 2 && text.length < 100 && !text.includes('\n')) {
      return { title: text, mediaType: 'movie' };
    }
  }

  return null;
}

function parseAriaLabel(label) {
  // aria-label often contains format like "Title Name - Season X"
  // or "Title Name (2024)" or just "Title Name"
  const yearMatch = label.match(/\((\d{4})\)/);
  const seasonMatch = label.match(/Season\s+\d+/i);
  const episodeMatch = label.match(/Episode\s+\d+/i);

  let title = label;
  let year = null;
  let mediaType = 'movie';

  // Extract year if present
  if (yearMatch) {
    year = yearMatch[1];
    title = label.replace(/\s*\(\d{4}\)\s*/, ' ').trim();
  }

  // Detect if it's a series
  if (seasonMatch || episodeMatch) {
    mediaType = 'series';
    title = title.replace(/\s*-?\s*Season\s+\d+.*/i, '').trim();
    title = title.replace(/\s*-?\s*Episode\s+\d+.*/i, '').trim();
  }

  // Clean up common suffixes
  title = title.replace(/\s*-\s*$/, '').trim();

  return { title, year, mediaType };
}

function normalizeTitle(title) {
  return title
    .replace(/[^\w\s]/g, ' ')  // Remove special characters
    .replace(/\s+/g, ' ')       // Collapse whitespace
    .trim();
}

// Overlay rendering functions
const OVERLAY_CLASS = 'nro-ratings-overlay';

function renderOverlay(element, data) {
  removeOverlay(element);

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;

  if (data.loading) {
    overlay.innerHTML = '<div class="nro-ratings-loading"><span class="nro-spinner"></span></div>';
  } else if (data.error) {
    overlay.innerHTML = `<div class="nro-ratings-error" title="${data.error}">!</div>`;
  } else if (data.notFound) {
    overlay.innerHTML = '<div class="nro-ratings-na">N/A</div>';
  } else {
    overlay.innerHTML = buildRatingHTML(data);
  }

  // Find the best container to append the overlay
  const img = element.querySelector('img');
  let container = img?.parentElement || element;

  // Make sure container has relative positioning
  const computedStyle = window.getComputedStyle(container);
  if (computedStyle.position === 'static') {
    container.style.position = 'relative';
  }

  container.appendChild(overlay);
}

function removeOverlay(element) {
  // Remove from the element and all its children
  const existing = element.querySelectorAll(`.${OVERLAY_CLASS}`);
  existing.forEach(el => el.remove());

  // Also check parent containers
  const parent = element.closest('.title-card, .slider-item, .title-card-container');
  if (parent) {
    const parentOverlays = parent.querySelectorAll(`.${OVERLAY_CLASS}`);
    parentOverlays.forEach(el => el.remove());
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

  return parts.length > 0
    ? parts.join('')
    : '<div class="nro-ratings-na">No ratings</div>';
}

// Event handlers
function handleMouseEnter(event) {
  const element = event.currentTarget;
  currentHoveredElement = element;

  clearTimeout(hoverTimeout);
  hoverTimeout = setTimeout(() => {
    if (currentHoveredElement === element) {
      fetchAndDisplayRating(element);
    }
  }, DEBOUNCE_MS);
}

function handleMouseLeave(event) {
  clearTimeout(hoverTimeout);
  currentHoveredElement = null;
  removeOverlay(event.currentTarget);
}

async function fetchAndDisplayRating(element) {
  // Check if extension is enabled
  const settings = await chrome.storage.local.get('enabled');
  if (settings.enabled === false) return;

  const titleInfo = extractTitleFromElement(element);
  if (!titleInfo || !titleInfo.title) return;

  // Show loading state
  renderOverlay(element, { loading: true });

  try {
    const rating = await chrome.runtime.sendMessage({
      type: 'FETCH_RATING',
      title: normalizeTitle(titleInfo.title),
      year: titleInfo.year,
      mediaType: titleInfo.mediaType
    });

    if (currentHoveredElement === element) {
      renderOverlay(element, rating);
    }
  } catch (error) {
    console.error('Netflix Ratings: Failed to fetch rating:', error);
    if (currentHoveredElement === element) {
      renderOverlay(element, { error: 'Failed to fetch rating' });
    }
  }
}

// Attach hover listeners to poster elements
function attachHoverListeners(container) {
  // Netflix poster selectors - these may change as Netflix updates their UI
  const selectors = [
    '.title-card',
    '.slider-item',
    '.title-card-container',
    '[data-uia="title-card"]',
    '.boxart-container'
  ];

  const posters = container.querySelectorAll(selectors.join(', '));

  posters.forEach(poster => {
    if (poster.dataset.nroAttached) return;
    poster.dataset.nroAttached = 'true';

    poster.addEventListener('mouseenter', handleMouseEnter);
    poster.addEventListener('mouseleave', handleMouseLeave);
  });
}

// Initialize MutationObserver for dynamic content
function initObserver() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          attachHoverListeners(node);
        }
      });
    });
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  return observer;
}

// Initialize the extension
async function init() {
  // Check if extension is enabled
  const settings = await chrome.storage.local.get('enabled');
  if (settings.enabled === false) {
    console.log('Netflix Ratings: Extension is disabled');
    return;
  }

  console.log('Netflix Ratings: Initializing...');

  // Attach to existing content
  attachHoverListeners(document.body);

  // Watch for dynamically loaded content
  initObserver();

  console.log('Netflix Ratings: Ready');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
