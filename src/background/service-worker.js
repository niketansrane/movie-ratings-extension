// Service Worker for Netflix Ratings Overlay
// Handles OMDb API calls and caching

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE = 1000;
const PRUNE_CHECK_INTERVAL = 50; // Only check pruning every N cache writes
const API_DAILY_LIMIT = 1000;
const API_WARN_THRESHOLD = 900; // Warn when approaching limit

let cacheWriteCount = 0; // Track writes since last prune check

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FETCH_RATING') {
    fetchRating(request.title, request.year, request.mediaType)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

async function fetchRating(title, year, mediaType) {
  const cacheKey = `rating_${title.toLowerCase()}_${year || ''}_${mediaType || 'movie'}`;

  // Check cache first
  const cached = await getCachedRating(cacheKey);
  if (cached) return cached;

  // Fetch from OMDb API
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { error: 'API key not configured. Click the extension icon to add your OMDb API key.' };
  }

  // Issue #7: Check if we're approaching the daily API limit
  const apiCallCount = await getApiCallCount();
  if (apiCallCount >= API_DAILY_LIMIT) {
    return { error: 'Daily API limit reached (1000 requests). Ratings will resume tomorrow.' };
  }

  const params = new URLSearchParams({
    apikey: apiKey,
    t: title,
    type: mediaType || 'movie'
  });
  if (year) params.append('y', year);

  try {
    const response = await fetch(`https://www.omdbapi.com/?${params}`);
    const data = await response.json();

    // Track API usage
    await incrementApiCalls();

    // Issue #10: Detect invalid API key specifically
    if (data.Response === 'False') {
      if (data.Error && data.Error.toLowerCase().includes('invalid api key')) {
        return { error: 'Invalid API key. Please update your key in the extension settings.' };
      }

      // If movie not found and we searched for movie, try series
      if (mediaType === 'movie' || !mediaType) {
        // Issue #7: Check limit again before second call
        const currentCalls = await getApiCallCount();
        if (currentCalls >= API_DAILY_LIMIT) {
          const notFoundResult = { notFound: true, title, cachedAt: Date.now() };
          await cacheRating(cacheKey, notFoundResult);
          return notFoundResult;
        }

        params.set('type', 'series');
        const seriesResponse = await fetch(`https://www.omdbapi.com/?${params}`);
        const seriesData = await seriesResponse.json();
        await incrementApiCalls();

        // Issue #10: Check for invalid key on retry too
        if (seriesData.Response === 'False' && seriesData.Error &&
            seriesData.Error.toLowerCase().includes('invalid api key')) {
          return { error: 'Invalid API key. Please update your key in the extension settings.' };
        }

        if (seriesData.Response === 'True') {
          return await processAndCacheRating(cacheKey, seriesData);
        }
      }

      // Cache the "not found" result to avoid repeated API calls
      const notFoundResult = { notFound: true, title, cachedAt: Date.now() };
      await cacheRating(cacheKey, notFoundResult);
      return notFoundResult;
    }

    return await processAndCacheRating(cacheKey, data);
  } catch (error) {
    console.error('OMDb API error:', error);
    return { error: 'Failed to fetch rating. Please try again.' };
  }
}

async function processAndCacheRating(cacheKey, data) {
  const rating = {
    imdbRating: data.imdbRating,
    rottenTomatoes: extractRottenTomatoes(data.Ratings),
    title: data.Title,
    year: data.Year,
    type: data.Type,
    cachedAt: Date.now()
  };

  await cacheRating(cacheKey, rating);
  return rating;
}

function extractRottenTomatoes(ratings) {
  if (!ratings || !Array.isArray(ratings)) return null;
  const rt = ratings.find(r => r.Source === 'Rotten Tomatoes');
  return rt?.Value || null;
}

async function getApiKey() {
  const result = await chrome.storage.local.get('apiKey');
  return result.apiKey;
}

async function getCachedRating(key) {
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

async function cacheRating(key, data) {
  await chrome.storage.local.set({ [key]: data });

  // Issue #12: Only prune periodically, not on every write
  cacheWriteCount++;
  if (cacheWriteCount >= PRUNE_CHECK_INTERVAL) {
    cacheWriteCount = 0;
    await pruneCache();
  }
}

async function pruneCache() {
  const all = await chrome.storage.local.get(null);
  const ratingKeys = Object.keys(all).filter(k => k.startsWith('rating_'));

  if (ratingKeys.length > MAX_CACHE_SIZE) {
    const entries = ratingKeys.map(k => ({ key: k, cachedAt: all[k]?.cachedAt || 0 }));
    entries.sort((a, b) => a.cachedAt - b.cachedAt);

    const toRemove = entries.slice(0, ratingKeys.length - MAX_CACHE_SIZE);
    await chrome.storage.local.remove(toRemove.map(e => e.key));
  }
}

async function getApiCallCount() {
  const today = new Date().toDateString();
  const result = await chrome.storage.local.get(['apiCallsToday', 'apiCallsDate']);

  if (result.apiCallsDate === today) {
    return result.apiCallsToday || 0;
  }
  return 0;
}

async function incrementApiCalls() {
  const today = new Date().toDateString();
  const result = await chrome.storage.local.get(['apiCallsToday', 'apiCallsDate']);

  let count;
  if (result.apiCallsDate === today) {
    count = (result.apiCallsToday || 0) + 1;
  } else {
    count = 1;
  }

  await chrome.storage.local.set({ apiCallsToday: count, apiCallsDate: today });

  // Issue #7: Log a warning when approaching limit
  if (count === API_WARN_THRESHOLD) {
    console.warn(`[Netflix Ratings] Approaching daily API limit: ${count}/${API_DAILY_LIMIT} calls used.`);
  }
}
