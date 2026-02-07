// Service Worker for Netflix Ratings Overlay
// Handles OMDb API calls, smart matching, and caching

const CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE = 1000;
const PRUNE_CHECK_INTERVAL = 50;
const API_DAILY_LIMIT = 1000;
const API_WARN_THRESHOLD = 900;

let cacheWriteCount = 0;

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'FETCH_RATING') {
    fetchRating(request.title, request.year, request.mediaType)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

async function fetchRating(title, year, mediaType) {
  // Cache key includes year and type so different versions of the same title
  // are cached separately
  const cacheKey = `rating_${title.toLowerCase()}_${year || ''}_${mediaType || 'any'}`;

  // Check cache first
  const cached = await getCachedRating(cacheKey);
  if (cached) return cached;

  // Fetch from OMDb API
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { error: 'API key not configured. Click the extension icon to add your OMDb API key.' };
  }

  const apiCallCount = await getApiCallCount();
  if (apiCallCount >= API_DAILY_LIMIT) {
    return { error: 'Daily API limit reached (1000 requests). Ratings will resume tomorrow.' };
  }

  try {
    let result;

    if (year && mediaType) {
      // Best case: we have both year and type — do a precise exact search
      result = await exactSearch(apiKey, title, year, mediaType);
    } else if (year) {
      // We have year but not type — try exact search without type restriction
      result = await exactSearchWithYear(apiKey, title, year);
    } else if (mediaType) {
      // We have type but no year — use search API to find best match
      result = await smartSearch(apiKey, title, null, mediaType);
    } else {
      // Neither year nor type — use search API for best match
      result = await smartSearch(apiKey, title, null, null);
    }

    if (result) {
      return await processAndCacheRating(cacheKey, result);
    }

    // Nothing found — cache the miss
    const notFoundResult = { notFound: true, title, cachedAt: Date.now() };
    await cacheRating(cacheKey, notFoundResult);
    return notFoundResult;

  } catch (error) {
    console.error('OMDb API error:', error);
    return { error: 'Failed to fetch rating. Please try again.' };
  }
}

// ─── Search strategies ────────────────────────────────────────

// Exact search with title, year, and type — most precise
async function exactSearch(apiKey, title, year, mediaType) {
  const params = new URLSearchParams({
    apikey: apiKey,
    t: title,
  });
  if (year) params.append('y', year);
  if (mediaType) params.append('type', mediaType);

  const response = await fetch(`https://www.omdbapi.com/?${params}`);
  const data = await response.json();
  await incrementApiCalls();

  if (isInvalidKeyError(data)) {
    throw new Error('Invalid API key. Please update your key in the extension settings.');
  }

  if (data.Response === 'True') {
    return data;
  }

  return null;
}

// Exact search with year but try both movie and series
async function exactSearchWithYear(apiKey, title, year) {
  // Try movie first
  const movieResult = await exactSearch(apiKey, title, year, 'movie');
  if (movieResult) return movieResult;

  // Check rate limit before second call
  if (await isRateLimited()) return null;

  // Try series
  const seriesResult = await exactSearch(apiKey, title, year, 'series');
  if (seriesResult) return seriesResult;

  return null;
}

// Smart search: use the OMDb search API to get multiple results,
// then score them to find the best match
async function smartSearch(apiKey, title, year, mediaType) {
  // Step 1: Try exact search first (it's the most reliable when it works)
  const exactType = mediaType || 'movie';
  const exactResult = await exactSearch(apiKey, title, year, exactType);
  if (exactResult) {
    // Verify the result looks reasonable
    if (isTitleMatch(title, exactResult.Title)) {
      return exactResult;
    }
  }

  // Check rate limit before continuing
  if (await isRateLimited()) return exactResult || null;

  // Step 2: If exact search failed or returned a poor match, try the other type
  const altType = (mediaType === 'series') ? 'movie' : 'series';
  const altResult = await exactSearch(apiKey, title, year, altType);
  if (altResult && isTitleMatch(title, altResult.Title)) {
    // If we had both results, prefer the one with a closer title match
    if (exactResult) {
      return pickBestMatch(title, year, [exactResult, altResult]);
    }
    return altResult;
  }

  // Check rate limit before search API
  if (await isRateLimited()) return exactResult || null;

  // Step 3: Use the search API for broader matching
  const searchParams = new URLSearchParams({
    apikey: apiKey,
    s: title,
  });
  if (mediaType) searchParams.append('type', mediaType);

  const searchResponse = await fetch(`https://www.omdbapi.com/?${searchParams}`);
  const searchData = await searchResponse.json();
  await incrementApiCalls();

  if (isInvalidKeyError(searchData)) {
    throw new Error('Invalid API key. Please update your key in the extension settings.');
  }

  if (searchData.Response !== 'True' || !searchData.Search?.length) {
    return exactResult || null;
  }

  // Score candidates and pick the best one
  const candidates = searchData.Search;
  const bestCandidate = pickBestMatch(title, year, candidates);

  if (!bestCandidate) return exactResult || null;

  // Check rate limit before fetching full details
  if (await isRateLimited()) return exactResult || null;

  // Fetch full details for the best candidate (search results don't include ratings)
  const detailParams = new URLSearchParams({
    apikey: apiKey,
    i: bestCandidate.imdbID,
  });

  const detailResponse = await fetch(`https://www.omdbapi.com/?${detailParams}`);
  const detailData = await detailResponse.json();
  await incrementApiCalls();

  if (detailData.Response === 'True') {
    return detailData;
  }

  return exactResult || null;
}

// ─── Matching & scoring ──────────────────────────────────────

// Check if the OMDb result title is a reasonable match for our query
function isTitleMatch(queryTitle, resultTitle) {
  if (!queryTitle || !resultTitle) return false;

  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const q = normalize(queryTitle);
  const r = normalize(resultTitle);

  // Exact match
  if (q === r) return true;

  // One contains the other
  if (q.includes(r) || r.includes(q)) return true;

  // Check word overlap (at least 70% of words match)
  const qWords = q.split(' ').filter(w => w.length > 1);
  const rWords = r.split(' ').filter(w => w.length > 1);
  if (qWords.length === 0 || rWords.length === 0) return false;

  const commonWords = qWords.filter(w => rWords.includes(w));
  const overlapRatio = commonWords.length / Math.max(qWords.length, rWords.length);

  return overlapRatio >= 0.7;
}

// Pick the best match from a list of OMDb results
function pickBestMatch(queryTitle, queryYear, candidates) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const scored = candidates.map(candidate => {
    let score = 0;

    // Title similarity score (0-50 points)
    score += titleSimilarityScore(queryTitle, candidate.Title) * 50;

    // Year match (0-30 points)
    if (queryYear && candidate.Year) {
      const candidateYear = parseInt(candidate.Year);
      const targetYear = parseInt(queryYear);
      const yearDiff = Math.abs(candidateYear - targetYear);

      if (yearDiff === 0) {
        score += 30;
      } else if (yearDiff === 1) {
        score += 20; // Off by one year is common (production vs release)
      } else if (yearDiff <= 3) {
        score += 10;
      }
      // More than 3 years off: no year bonus
    }

    // Prefer entries with ratings available (0-10 points)
    if (candidate.imdbRating && candidate.imdbRating !== 'N/A') {
      score += 10;
    }

    // Prefer entries with a poster (indicates a real, well-known entry) (0-5 points)
    if (candidate.Poster && candidate.Poster !== 'N/A') {
      score += 5;
    }

    // Small bonus for movies (OMDb default, usually what Netflix users want) (0-5 points)
    if (candidate.Type === 'movie') {
      score += 3;
    }

    return { candidate, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored[0].candidate;
}

// Compute title similarity as a ratio between 0 and 1
function titleSimilarityScore(queryTitle, resultTitle) {
  if (!queryTitle || !resultTitle) return 0;

  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const q = normalize(queryTitle);
  const r = normalize(resultTitle);

  if (q === r) return 1.0;

  // Check containment
  if (q.includes(r) || r.includes(q)) {
    const shorter = Math.min(q.length, r.length);
    const longer = Math.max(q.length, r.length);
    return 0.8 + (0.2 * shorter / longer);
  }

  // Word overlap ratio
  const qWords = q.split(' ').filter(w => w.length > 1);
  const rWords = r.split(' ').filter(w => w.length > 1);
  if (qWords.length === 0 || rWords.length === 0) return 0;

  const commonWords = qWords.filter(w => rWords.includes(w));
  return commonWords.length / Math.max(qWords.length, rWords.length);
}

// ─── Rate limit helpers ──────────────────────────────────────

async function isRateLimited() {
  const count = await getApiCallCount();
  return count >= API_DAILY_LIMIT;
}

function isInvalidKeyError(data) {
  return data.Response === 'False' && data.Error &&
    data.Error.toLowerCase().includes('invalid api key');
}

// ─── Data processing ─────────────────────────────────────────

async function processAndCacheRating(cacheKey, data) {
  const rating = {
    imdbRating: data.imdbRating,
    rottenTomatoes: extractRottenTomatoes(data.Ratings),
    title: data.Title,
    year: data.Year,
    type: data.Type,
    imdbID: data.imdbID,
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

// ─── Storage helpers ─────────────────────────────────────────

async function getApiKey() {
  const result = await chrome.storage.local.get('apiKey');
  return result.apiKey;
}

async function getCachedRating(key) {
  const result = await chrome.storage.local.get(key);
  const cached = result[key];

  if (!cached) return null;

  if (Date.now() - cached.cachedAt > CACHE_TTL) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return cached;
}

async function cacheRating(key, data) {
  await chrome.storage.local.set({ [key]: data });

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

  if (count === API_WARN_THRESHOLD) {
    console.warn(`[Netflix Ratings] Approaching daily API limit: ${count}/${API_DAILY_LIMIT} calls used.`);
  }
}
