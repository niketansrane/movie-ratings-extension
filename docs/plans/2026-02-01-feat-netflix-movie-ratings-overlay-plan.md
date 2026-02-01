---
title: Netflix Movie Ratings Overlay Chrome Extension
type: feat
date: 2026-02-01
---

# Netflix Movie Ratings Overlay Chrome Extension

## Overview

Build a Chrome extension that displays IMDb and Rotten Tomatoes ratings as overlay badges on movie/series posters when users browse Netflix. The extension extracts title information from Netflix's DOM, fetches ratings from the OMDb API, and displays them directly on the poster images.

## Problem Statement / Motivation

When browsing Netflix, users often want to know a movie or show's quality before committing to watch. Currently, this requires:
1. Noting the title
2. Opening a new tab
3. Searching on IMDb or Rotten Tomatoes
4. Returning to Netflix

This friction disrupts the browsing experience. By showing ratings directly on Netflix posters, users can make faster, more informed viewing decisions without leaving the platform.

## Proposed Solution

A Manifest V3 Chrome extension with:
- **Content Script**: Injected into Netflix pages to detect hover events and display rating overlays
- **Service Worker**: Handles OMDb API calls and manages caching
- **Storage**: Caches ratings locally to minimize API calls and improve performance

```
┌─────────────────────────────────────────────────────────────────┐
│                     Chrome Extension Architecture                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │   Netflix   │    │   Content   │    │   Service   │         │
│  │   DOM       │◄──►│   Script    │◄──►│   Worker    │         │
│  │             │    │             │    │             │         │
│  └─────────────┘    └──────┬──────┘    └──────┬──────┘         │
│                            │                   │                │
│                            │                   ▼                │
│                            │           ┌─────────────┐         │
│                            │           │   OMDb API  │         │
│                            │           └─────────────┘         │
│                            │                   │                │
│                            ▼                   ▼                │
│                     ┌─────────────────────────────────┐        │
│                     │     chrome.storage.local        │        │
│                     │     (Rating Cache)              │        │
│                     └─────────────────────────────────┘        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Technical Approach

### Architecture

#### File Structure

```
movie-ratings-extension/
├── manifest.json           # Extension configuration (Manifest V3)
├── src/
│   ├── content/
│   │   ├── content.js      # Main content script for Netflix
│   │   ├── titleExtractor.js   # DOM title extraction logic
│   │   ├── overlayRenderer.js  # Rating badge UI rendering
│   │   └── styles.css      # Overlay styling
│   ├── background/
│   │   └── service-worker.js   # API calls and caching
│   ├── popup/
│   │   ├── popup.html      # Extension popup UI
│   │   ├── popup.js        # Popup logic (API key config)
│   │   └── popup.css       # Popup styling
│   └── utils/
│       ├── cache.js        # Cache management utilities
│       └── constants.js    # Shared constants
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── docs/
    └── plans/
```

#### Manifest V3 Configuration

```json
// manifest.json
{
  "manifest_version": 3,
  "name": "Netflix Ratings Overlay",
  "version": "1.0.0",
  "description": "Shows IMDb and Rotten Tomatoes ratings on Netflix posters",
  "permissions": ["storage"],
  "host_permissions": ["https://www.omdbapi.com/*"],
  "content_scripts": [
    {
      "matches": ["https://www.netflix.com/*"],
      "js": ["src/content/content.js"],
      "css": ["src/content/styles.css"],
      "run_at": "document_idle"
    }
  ],
  "background": {
    "service_worker": "src/background/service-worker.js"
  },
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

### Implementation Phases

#### Phase 1: Core Infrastructure

**Tasks:**
- [x] Create manifest.json with Manifest V3 configuration
- [x] Set up service worker for background processing
- [x] Implement chrome.storage.local wrapper for caching
- [x] Create popup UI for API key configuration
- [x] Build basic content script skeleton

**Key Files:**

```javascript
// src/background/service-worker.js
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FETCH_RATING') {
    fetchRating(request.title, request.year, request.mediaType)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function fetchRating(title, year, mediaType) {
  const cacheKey = `rating_${title}_${year}_${mediaType}`;

  // Check cache first
  const cached = await getCachedRating(cacheKey);
  if (cached) return cached;

  // Fetch from OMDb API
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured');

  const params = new URLSearchParams({
    apikey: apiKey,
    t: title,
    type: mediaType || 'movie'
  });
  if (year) params.append('y', year);

  const response = await fetch(`https://www.omdbapi.com/?${params}`);
  const data = await response.json();

  if (data.Response === 'False') {
    return { notFound: true, title };
  }

  const rating = {
    imdbRating: data.imdbRating,
    rottenTomatoes: extractRottenTomatoes(data.Ratings),
    title: data.Title,
    year: data.Year,
    cachedAt: Date.now()
  };

  // Cache the result
  await cacheRating(cacheKey, rating);

  return rating;
}

function extractRottenTomatoes(ratings) {
  const rt = ratings?.find(r => r.Source === 'Rotten Tomatoes');
  return rt?.Value || null;
}
```

```javascript
// src/utils/cache.js
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE = 1000; // Maximum cached entries

export async function getCachedRating(key) {
  const result = await chrome.storage.local.get(key);
  const cached = result[key];

  if (!cached) return null;

  // Check if cache is expired
  if (Date.now() - cached.cachedAt > CACHE_TTL) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return cached;
}

export async function cacheRating(key, data) {
  await chrome.storage.local.set({ [key]: data });
  await pruneCache();
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const ratingKeys = Object.keys(all).filter(k => k.startsWith('rating_'));

  if (ratingKeys.length > MAX_CACHE_SIZE) {
    // Remove oldest entries
    const entries = ratingKeys.map(k => ({ key: k, cachedAt: all[k].cachedAt }));
    entries.sort((a, b) => a.cachedAt - b.cachedAt);

    const toRemove = entries.slice(0, ratingKeys.length - MAX_CACHE_SIZE);
    await chrome.storage.local.remove(toRemove.map(e => e.key));
  }
}
```

**Success Criteria:**
- Extension loads without errors
- API key can be saved and retrieved from storage
- Service worker responds to messages from content script

#### Phase 2: Netflix DOM Integration

**Tasks:**
- [x] Research and document Netflix DOM selectors for title extraction
- [x] Implement MutationObserver to detect dynamically loaded content
- [x] Create debounced hover event handler (300ms)
- [x] Build title extraction logic with fallbacks
- [x] Handle different Netflix page types (home, search, browse, My List)

**Key Files:**

```javascript
// src/content/titleExtractor.js
export function extractTitleFromElement(element) {
  // Netflix uses various methods to display titles
  // Try multiple strategies in order of reliability

  // Strategy 1: aria-label on the title card
  const ariaLabel = element.closest('[data-uia]')?.getAttribute('aria-label');
  if (ariaLabel) {
    return parseAriaLabel(ariaLabel);
  }

  // Strategy 2: Title in the bob-card (expanded hover state)
  const bobTitle = element.closest('.title-card-container')
    ?.querySelector('.bob-title, .fallback-text');
  if (bobTitle?.textContent) {
    return { title: bobTitle.textContent.trim() };
  }

  // Strategy 3: Image alt text
  const img = element.querySelector('img[alt]') || element.closest('.title-card')?.querySelector('img[alt]');
  if (img?.alt) {
    return { title: img.alt.trim() };
  }

  // Strategy 4: Title from parent container's data attributes
  const titleCard = element.closest('.title-card, .slider-item');
  const titleData = titleCard?.querySelector('[data-uia="title-card-title"]');
  if (titleData?.textContent) {
    return { title: titleData.textContent.trim() };
  }

  return null;
}

function parseAriaLabel(label) {
  // aria-label often contains format like "Title Name - Season X"
  // or "Title Name (2024)"
  const yearMatch = label.match(/\((\d{4})\)/);
  const seasonMatch = label.match(/Season\s+\d+/i);

  let title = label;
  let year = null;
  let mediaType = 'movie';

  if (yearMatch) {
    year = yearMatch[1];
    title = label.replace(/\s*\(\d{4}\)\s*/, ' ').trim();
  }

  if (seasonMatch) {
    mediaType = 'series';
    title = title.replace(/\s*-?\s*Season\s+\d+.*/i, '').trim();
  }

  return { title, year, mediaType };
}

export function normalizeTitle(title) {
  return title
    .replace(/[^\w\s]/g, ' ')  // Remove special characters
    .replace(/\s+/g, ' ')       // Collapse whitespace
    .trim();
}
```

```javascript
// src/content/content.js
import { extractTitleFromElement, normalizeTitle } from './titleExtractor.js';
import { renderOverlay, removeOverlay } from './overlayRenderer.js';

const DEBOUNCE_MS = 300;
let hoverTimeout = null;
let currentHoveredElement = null;

// Initialize MutationObserver for dynamic content
const observer = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        attachHoverListeners(node);
      }
    });
  });
});

// Start observing
observer.observe(document.body, {
  childList: true,
  subtree: true
});

// Attach listeners to existing content
attachHoverListeners(document.body);

function attachHoverListeners(container) {
  const posters = container.querySelectorAll('.title-card, .slider-item, .title-card-container');
  posters.forEach(poster => {
    if (poster.dataset.ratingsAttached) return;
    poster.dataset.ratingsAttached = 'true';

    poster.addEventListener('mouseenter', handleMouseEnter);
    poster.addEventListener('mouseleave', handleMouseLeave);
  });
}

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
  const titleInfo = extractTitleFromElement(element);
  if (!titleInfo) return;

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
    console.error('Failed to fetch rating:', error);
    if (currentHoveredElement === element) {
      renderOverlay(element, { error: true });
    }
  }
}
```

**Success Criteria:**
- Titles are correctly extracted from Netflix DOM
- Hover events properly debounced
- New dynamically loaded content is detected and processed

#### Phase 3: Rating Overlay UI

**Tasks:**
- [x] Design and implement overlay badge component
- [x] Create loading, success, error, and "not found" states
- [x] Style badges with IMDb (gold) and Rotten Tomatoes (red/green) colors
- [x] Position overlays in bottom-left corner of posters
- [x] Add smooth fade-in/fade-out transitions
- [x] Ensure overlays don't interfere with Netflix's native hover cards

**Key Files:**

```javascript
// src/content/overlayRenderer.js
const OVERLAY_CLASS = 'ratings-overlay';

export function renderOverlay(element, data) {
  removeOverlay(element);

  const overlay = document.createElement('div');
  overlay.className = OVERLAY_CLASS;

  if (data.loading) {
    overlay.innerHTML = `<div class="ratings-loading"><span class="spinner"></span></div>`;
  } else if (data.error) {
    overlay.innerHTML = `<div class="ratings-error">!</div>`;
  } else if (data.notFound) {
    overlay.innerHTML = `<div class="ratings-na">N/A</div>`;
  } else {
    overlay.innerHTML = buildRatingHTML(data);
  }

  // Position relative to poster image
  const poster = element.querySelector('img') || element;
  const container = poster.parentElement;
  container.style.position = 'relative';
  container.appendChild(overlay);
}

export function removeOverlay(element) {
  const existing = element.querySelector(`.${OVERLAY_CLASS}`);
  if (existing) {
    existing.remove();
  }
}

function buildRatingHTML(data) {
  const parts = [];

  if (data.imdbRating && data.imdbRating !== 'N/A') {
    parts.push(`
      <div class="rating-badge imdb">
        <span class="rating-icon">IMDb</span>
        <span class="rating-value">${data.imdbRating}</span>
      </div>
    `);
  }

  if (data.rottenTomatoes) {
    const score = parseInt(data.rottenTomatoes);
    const freshness = score >= 60 ? 'fresh' : 'rotten';
    parts.push(`
      <div class="rating-badge rt ${freshness}">
        <span class="rating-icon">RT</span>
        <span class="rating-value">${data.rottenTomatoes}</span>
      </div>
    `);
  }

  return parts.length > 0
    ? parts.join('')
    : `<div class="ratings-na">No ratings</div>`;
}
```

```css
/* src/content/styles.css */
.ratings-overlay {
  position: absolute;
  bottom: 8px;
  left: 8px;
  display: flex;
  gap: 4px;
  z-index: 100;
  opacity: 0;
  animation: fadeIn 0.2s ease-out forwards;
}

@keyframes fadeIn {
  to {
    opacity: 1;
  }
}

.rating-badge {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: 4px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
}

.rating-badge.imdb {
  background: linear-gradient(135deg, #f5c518 0%, #d4a50d 100%);
  color: #000;
}

.rating-badge.rt {
  color: #fff;
}

.rating-badge.rt.fresh {
  background: linear-gradient(135deg, #fa320a 0%, #d42c08 100%);
}

.rating-badge.rt.rotten {
  background: linear-gradient(135deg, #6c757d 0%, #495057 100%);
}

.rating-icon {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.rating-value {
  font-weight: 700;
}

.ratings-loading {
  padding: 6px 10px;
  background: rgba(0, 0, 0, 0.7);
  border-radius: 4px;
}

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.ratings-error,
.ratings-na {
  padding: 4px 8px;
  background: rgba(0, 0, 0, 0.7);
  color: #999;
  border-radius: 4px;
  font-size: 11px;
}
```

**Success Criteria:**
- Overlays display correctly on all poster sizes
- Smooth animations without jank
- No interference with Netflix's native hover behavior
- Clear visual distinction between IMDb and RT scores

#### Phase 4: Popup & Configuration

**Tasks:**
- [x] Build popup UI for API key entry
- [x] Add link to OMDb API key registration
- [x] Show current rate limit usage (approximate)
- [x] Add enable/disable toggle
- [x] Display cache statistics

**Key Files:**

```html
<!-- src/popup/popup.html -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="popup-container">
    <h1>Netflix Ratings</h1>

    <div class="section">
      <label for="apiKey">OMDb API Key</label>
      <input type="password" id="apiKey" placeholder="Enter your API key">
      <a href="https://www.omdbapi.com/apikey.aspx" target="_blank" class="help-link">
        Get free API key
      </a>
    </div>

    <div class="section">
      <label class="toggle">
        <input type="checkbox" id="enabled" checked>
        <span class="slider"></span>
        <span class="label">Extension enabled</span>
      </label>
    </div>

    <div class="section stats">
      <div class="stat">
        <span class="stat-label">Cached ratings</span>
        <span class="stat-value" id="cacheCount">0</span>
      </div>
      <div class="stat">
        <span class="stat-label">API calls today</span>
        <span class="stat-value" id="apiCalls">0</span>
      </div>
    </div>

    <button id="clearCache" class="secondary">Clear Cache</button>
    <button id="save" class="primary">Save</button>

    <div id="status" class="status"></div>
  </div>
  <script src="popup.js"></script>
</body>
</html>
```

```javascript
// src/popup/popup.js
document.addEventListener('DOMContentLoaded', async () => {
  // Load saved settings
  const settings = await chrome.storage.local.get([
    'apiKey', 'enabled', 'apiCallsToday', 'apiCallsDate'
  ]);

  document.getElementById('apiKey').value = settings.apiKey || '';
  document.getElementById('enabled').checked = settings.enabled !== false;

  // Update stats
  await updateStats();

  // Event listeners
  document.getElementById('save').addEventListener('click', saveSettings);
  document.getElementById('clearCache').addEventListener('click', clearCache);
});

async function saveSettings() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const enabled = document.getElementById('enabled').checked;

  await chrome.storage.local.set({ apiKey, enabled });

  showStatus('Settings saved!', 'success');
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const ratingKeys = Object.keys(all).filter(k => k.startsWith('rating_'));
  await chrome.storage.local.remove(ratingKeys);

  await updateStats();
  showStatus('Cache cleared!', 'success');
}

async function updateStats() {
  const all = await chrome.storage.local.get(null);
  const ratingKeys = Object.keys(all).filter(k => k.startsWith('rating_'));

  document.getElementById('cacheCount').textContent = ratingKeys.length;

  // API calls tracking
  const today = new Date().toDateString();
  if (all.apiCallsDate === today) {
    document.getElementById('apiCalls').textContent = all.apiCallsToday || 0;
  } else {
    document.getElementById('apiCalls').textContent = '0';
  }
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;
  setTimeout(() => {
    status.className = 'status';
  }, 3000);
}
```

**Success Criteria:**
- Users can save and update their API key
- Cache can be cleared manually
- Basic usage statistics are visible

## Edge Cases & Error Handling

### Title Extraction Challenges

| Scenario | Solution |
|----------|----------|
| Netflix changes DOM structure | Multiple fallback selectors, graceful degradation |
| Title contains special characters | Normalize before API query (remove punctuation) |
| Foreign language titles | Search with original title, fallback to English |
| Remakes/reboots (same title, different year) | Extract year from Netflix metadata when available |
| TV Series vs Movie ambiguity | Check for season/episode indicators in aria-label |

### API Edge Cases

| Scenario | Solution |
|----------|----------|
| Title not found in OMDb | Display "No ratings" badge |
| Only IMDb rating available (no RT) | Display IMDb only |
| Rate limit exceeded (429) | Queue requests, show "unavailable" temporarily |
| Network timeout | 5 second timeout, show error state |
| API returns malformed data | Validate response, fallback to error state |

### UI Edge Cases

| Scenario | Solution |
|----------|----------|
| User hovers rapidly between posters | Cancel pending requests, debounce 300ms |
| Poster loads after hover starts | Re-check title extraction on DOMContentLoaded |
| Netflix's hover card overlaps overlay | Position overlay in bottom-left, z-index management |
| Very long titles | Truncate with ellipsis in cache key normalization |

## Acceptance Criteria

### Functional Requirements

- [ ] Extension installs successfully from Chrome Web Store
- [ ] User can configure OMDb API key in popup
- [ ] Hovering over Netflix poster shows rating overlay within 500ms (cached) or 2s (uncached)
- [ ] IMDb rating displayed with gold badge styling
- [ ] Rotten Tomatoes rating displayed with red (fresh) or gray (rotten) badge
- [ ] Ratings are cached for 7 days
- [ ] Extension works on Netflix homepage, search, browse, and My List pages
- [ ] Moving mouse away from poster removes overlay

### Non-Functional Requirements

- [ ] Content script adds < 50ms to page load time
- [ ] Memory usage < 10MB for cached data
- [ ] No console errors during normal operation
- [ ] Works on Chrome version 100+

### Quality Gates

- [ ] Manual testing on 3+ Netflix pages
- [ ] Edge cases documented and handled
- [ ] No data sent to external servers except OMDb API
- [ ] API key stored securely in chrome.storage.local

## Dependencies & Prerequisites

### External Dependencies

| Dependency | Purpose | Risk |
|------------|---------|------|
| OMDb API | Rating data source | Rate limits (1000/day free), potential downtime |
| Netflix DOM structure | Title extraction | Changes without notice, requires maintenance |
| Chrome Extension APIs | Core functionality | Stable, well-documented |

### User Requirements

1. **OMDb API Key**: Users must register for a free API key at [omdbapi.com](https://www.omdbapi.com/apikey.aspx)
2. **Chrome Browser**: Version 100 or higher (Manifest V3 support)
3. **Netflix Subscription**: Active Netflix account to browse content

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Netflix DOM changes break extension | High | High | Multiple fallback selectors, monitoring for changes |
| OMDb API rate limits exceeded | Medium | Medium | Aggressive caching, clear usage indicators |
| Poor title matching accuracy | Medium | Medium | Normalize titles, support manual correction |
| Extension conflicts with Netflix UI | Low | Medium | Careful z-index management, non-intrusive design |

## Future Considerations

### Phase 2 (Post-MVP)

- Support for Amazon Prime Video and Disney+
- Show trailer links
- Add "watched" tracking integration
- Configurable overlay position
- Keyboard accessibility support

### Phase 3 (Long-term)

- Metacritic scores
- Letterboxd integration
- Community ratings/reviews
- Personalized recommendations based on watched ratings

## References & Research

### External References

- [Chrome Extensions Manifest V3 Documentation](https://developer.chrome.com/docs/extensions/)
- [OMDb API Documentation](https://www.omdbapi.com/)
- [OMDb API Response Format](https://github.com/omdbapi/OMDb-API)
- [Building Netflix Extensions (Medium)](https://medium.com/@saquiboye/how-i-created-a-chrome-extension-for-netflix-over-a-weekend-4ce7b1397e8c)
- [IMDb Rating on Mouse Hover Tutorial](https://dev.to/dhilipkmr/imdb-rating-on-mouse-hover-1ij6)

### Technical Notes

- Netflix DOM selectors change frequently; build resilient extraction
- Use `chrome.storage.local` for caching (persists across sessions)
- Service worker in Manifest V3 is ephemeral; don't rely on in-memory state
- OMDb API free tier: 1000 requests/day per API key
- Debounce hover events to prevent excessive API calls

---

## MVP Implementation Checklist

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Netflix Ratings Overlay",
  "version": "1.0.0",
  "description": "Shows IMDb and Rotten Tomatoes ratings on Netflix posters",
  "permissions": ["storage"],
  "host_permissions": ["https://www.omdbapi.com/*"],
  "content_scripts": [
    {
      "matches": ["https://www.netflix.com/*"],
      "js": ["src/content/content.js"],
      "css": ["src/content/styles.css"]
    }
  ],
  "background": {
    "service_worker": "src/background/service-worker.js"
  },
  "action": {
    "default_popup": "src/popup/popup.html"
  }
}
```

### Files to Create

1. `manifest.json` - Extension configuration
2. `src/background/service-worker.js` - API calls and caching
3. `src/content/content.js` - DOM interaction and hover handling
4. `src/content/titleExtractor.js` - Netflix title extraction
5. `src/content/overlayRenderer.js` - Rating badge rendering
6. `src/content/styles.css` - Overlay styling
7. `src/popup/popup.html` - Settings UI
8. `src/popup/popup.js` - Settings logic
9. `src/popup/popup.css` - Settings styling
10. `icons/icon16.png`, `icon48.png`, `icon128.png` - Extension icons
