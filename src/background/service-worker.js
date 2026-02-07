'use strict';

/**
 * Service Worker — Netflix Ratings Overlay
 *
 * Responsibilities:
 *  1. Listen for FETCH_RATING messages from the content script.
 *  2. Check the local rating cache (chrome.storage.local).
 *  3. Query OMDb API when cache misses, using smart search + scoring.
 *  4. Cache results for 7 days; prune old / over-limit entries.
 *  5. Track daily API usage to respect the free-tier limit.
 *
 * All state is in chrome.storage.local — the service worker is ephemeral.
 */

// ─── Constants (duplicated from src/constants/config.js — no ES imports in SW) ─

const CACHE_TTL_MS       = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE     = 1000;
const PRUNE_INTERVAL     = 50;
const API_DAILY_LIMIT    = 1000;
const API_WARN_THRESHOLD = 900;
const FETCH_TIMEOUT_MS   = 8000;
const CACHE_KEY_PREFIX   = 'rating_';
const PRUNE_COUNTER_KEY  = '_nro_cacheWriteCount';

// ─── Message listener ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.type !== 'FETCH_RATING') return false;

  handleFetchRating(request)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message || 'Unknown error' }));

  return true; // keep message channel open for async response
});

// ─── Top-level handler ────────────────────────────────────────

async function handleFetchRating({ title, year, mediaType }) {
  const keyTitle = title.toLowerCase().substring(0, 100);
  const cacheKey = `${CACHE_KEY_PREFIX}${keyTitle}_${year || ''}_${mediaType || 'any'}`;

  // 1. Cache hit?
  const cached = await getCached(cacheKey);
  if (cached) return cached;

  // 2. API key configured?
  const apiKey = (await chrome.storage.local.get('apiKey')).apiKey;
  if (!apiKey) {
    return { error: 'API key not configured. Click the extension icon to add your OMDb API key.' };
  }

  // 3. Under daily limit?
  if (await getApiCallCount() >= API_DAILY_LIMIT) {
    return { error: 'Daily API limit reached (1,000 requests). Ratings will resume tomorrow.' };
  }

  // 4. Query OMDb
  try {
    const result = await queryOMDb(apiKey, title, year, mediaType);

    if (result) {
      return await processAndCache(cacheKey, result);
    }

    // Cache the miss so we don't keep retrying
    const miss = { notFound: true, title, cachedAt: Date.now() };
    await writeCache(cacheKey, miss);
    return miss;
  } catch (err) {
    console.error('[NRO] OMDb error:', err);
    return { error: err.message || 'Failed to fetch rating.' };
  }
}

// ═══════════════════════════════════════════════════════════════
// OMDb SEARCH STRATEGIES
// ═══════════════════════════════════════════════════════════════

/**
 * Choose the best search strategy based on what metadata the content
 * script was able to extract from the Netflix DOM.
 */
async function queryOMDb(apiKey, title, year, mediaType) {
  if (year && mediaType) return exactSearch(apiKey, title, year, mediaType);
  if (year)             return searchBothTypes(apiKey, title, year);
  return smartSearch(apiKey, title, year, mediaType);
}

/** Precise search: title + year + type. */
async function exactSearch(apiKey, title, year, type) {
  const params = new URLSearchParams({ apikey: apiKey, t: title });
  if (year) params.set('y', year);
  if (type) params.set('type', type);

  const data = await omdbFetch(params);
  return data.Response === 'True' ? data : null;
}

/** We have a year but not a type — try movie, then series. */
async function searchBothTypes(apiKey, title, year) {
  const movie = await exactSearch(apiKey, title, year, 'movie');
  if (movie) return movie;

  if (await isOverLimit()) return null;

  return exactSearch(apiKey, title, year, 'series');
}

/**
 * Smart search — tries exact matches, then falls back to the OMDb
 * search API and scores candidates by title-similarity, year proximity,
 * and metadata quality.
 */
async function smartSearch(apiKey, title, year, mediaType) {
  // Step 1 — exact match with preferred type
  const preferredType = mediaType || 'movie';
  const exact = await exactSearch(apiKey, title, year, preferredType);
  const exactOk = exact && isTitleMatch(title, exact.Title);

  // Step 2 — try the alternate type
  if (!await isOverLimit()) {
    const altType = preferredType === 'movie' ? 'series' : 'movie';
    const alt = await exactSearch(apiKey, title, year, altType);
    const altOk = alt && isTitleMatch(title, alt.Title);

    if (altOk && exactOk) return pickBest(title, year, [exact, alt]);
    if (altOk)            return alt;
  }

  if (exactOk) return exact;

  // Step 3 — OMDb search API for broader matching
  if (await isOverLimit()) return null;

  const searchParams = new URLSearchParams({ apikey: apiKey, s: title });
  if (mediaType) searchParams.set('type', mediaType);

  const searchData = await omdbFetch(searchParams);
  if (searchData.Response !== 'True' || !searchData.Search?.length) return null;

  const best = pickBest(title, year, searchData.Search);
  if (!best) return null;

  // Fetch full details (search results don't include ratings)
  if (await isOverLimit()) return null;

  const detail = await omdbFetch(new URLSearchParams({ apikey: apiKey, i: best.imdbID }));
  return detail.Response === 'True' ? detail : null;
}

// ═══════════════════════════════════════════════════════════════
// TITLE MATCHING & SCORING
// ═══════════════════════════════════════════════════════════════

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function isTitleMatch(query, result) {
  if (!query || !result) return false;
  const q = normalize(query);
  const r = normalize(result);

  if (q === r) return true;
  if (q.includes(r) || r.includes(q)) return true;

  const qw = q.split(' ').filter(w => w.length > 1);
  const rw = r.split(' ').filter(w => w.length > 1);
  if (!qw.length || !rw.length) return false;

  return qw.filter(w => rw.includes(w)).length / Math.max(qw.length, rw.length) >= 0.7;
}

function titleSimilarity(query, result) {
  if (!query || !result) return 0;
  const q = normalize(query);
  const r = normalize(result);

  if (q === r) return 1;
  if (q.includes(r) || r.includes(q)) {
    return 0.8 + 0.2 * Math.min(q.length, r.length) / Math.max(q.length, r.length);
  }

  const qw = q.split(' ').filter(w => w.length > 1);
  const rw = r.split(' ').filter(w => w.length > 1);
  if (!qw.length || !rw.length) return 0;

  return qw.filter(w => rw.includes(w)).length / Math.max(qw.length, rw.length);
}

function pickBest(queryTitle, queryYear, candidates) {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];

  let bestScore = -1;
  let bestCandidate = null;

  for (const c of candidates) {
    let score = titleSimilarity(queryTitle, c.Title) * 50;

    if (queryYear && c.Year) {
      const diff = Math.abs(parseInt(c.Year) - parseInt(queryYear));
      score += diff === 0 ? 30 : diff === 1 ? 20 : diff <= 3 ? 10 : 0;
    }

    if (c.imdbRating && c.imdbRating !== 'N/A') score += 10;
    if (c.Poster   && c.Poster   !== 'N/A') score += 5;
    if (c.Type === 'movie') score += 3;

    if (score > bestScore) { bestScore = score; bestCandidate = c; }
  }

  return bestCandidate;
}

// ═══════════════════════════════════════════════════════════════
// DATA PROCESSING
// ═══════════════════════════════════════════════════════════════

async function processAndCache(cacheKey, data) {
  const imdbRating     = data.imdbRating !== 'N/A' ? data.imdbRating : null;
  const rottenTomatoes = extractRT(data.Ratings);

  if (!imdbRating && !rottenTomatoes) {
    const miss = { notFound: true, title: data.Title, cachedAt: Date.now() };
    await writeCache(cacheKey, miss);
    return miss;
  }

  const rating = {
    imdbRating,
    rottenTomatoes,
    title:    data.Title,
    year:     data.Year,
    type:     data.Type,
    imdbID:   data.imdbID,
    cachedAt: Date.now(),
  };
  await writeCache(cacheKey, rating);
  return rating;
}

function extractRT(ratings) {
  if (!Array.isArray(ratings)) return null;
  return ratings.find(r => r.Source === 'Rotten Tomatoes')?.Value ?? null;
}

// ═══════════════════════════════════════════════════════════════
// HTTP HELPER
// ═══════════════════════════════════════════════════════════════

async function omdbFetch(params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`https://www.omdbapi.com/?${params}`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await res.json();
    await incrementApiCalls();

    if (data.Response === 'False' && data.Error?.toLowerCase().includes('invalid api key')) {
      throw new Error('Invalid API key. Please update your key in the extension settings.');
    }

    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. OMDb API may be slow — please try again.');
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// CACHE & STORAGE
// ═══════════════════════════════════════════════════════════════

async function getCached(key) {
  const result = await chrome.storage.local.get(key);
  const entry  = result[key];
  if (!entry) return null;

  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }
  return entry;
}

async function writeCache(key, data) {
  const { [PRUNE_COUNTER_KEY]: prev } = await chrome.storage.local.get(PRUNE_COUNTER_KEY);
  const count = (prev || 0) + 1;

  await chrome.storage.local.set({
    [key]: data,
    [PRUNE_COUNTER_KEY]: count >= PRUNE_INTERVAL ? 0 : count,
  });

  if (count >= PRUNE_INTERVAL) await pruneCache();
}

async function pruneCache() {
  const all  = await chrome.storage.local.get(null);
  const now  = Date.now();
  const toRemove = [];
  const valid    = [];

  for (const key of Object.keys(all)) {
    if (!key.startsWith(CACHE_KEY_PREFIX)) continue;
    const entry = all[key];
    if (!entry?.cachedAt || now - entry.cachedAt > CACHE_TTL_MS) {
      toRemove.push(key);
    } else {
      valid.push({ key, cachedAt: entry.cachedAt });
    }
  }

  if (valid.length > MAX_CACHE_SIZE) {
    valid.sort((a, b) => a.cachedAt - b.cachedAt);
    for (const e of valid.slice(0, valid.length - MAX_CACHE_SIZE)) {
      toRemove.push(e.key);
    }
  }

  if (toRemove.length) await chrome.storage.local.remove(toRemove);
}

// ═══════════════════════════════════════════════════════════════
// RATE-LIMIT TRACKING
// ═══════════════════════════════════════════════════════════════

async function getApiCallCount() {
  const today = new Date().toDateString();
  const { apiCallsToday, apiCallsDate } = await chrome.storage.local.get(['apiCallsToday', 'apiCallsDate']);
  return apiCallsDate === today ? (apiCallsToday || 0) : 0;
}

async function isOverLimit() {
  return (await getApiCallCount()) >= API_DAILY_LIMIT;
}

// Simple lock to serialise concurrent increments
let _counterLock = null;

async function incrementApiCalls() {
  while (_counterLock) await _counterLock;

  let unlock;
  _counterLock = new Promise(r => { unlock = r; });

  try {
    const today = new Date().toDateString();
    const { apiCallsToday, apiCallsDate } = await chrome.storage.local.get(['apiCallsToday', 'apiCallsDate']);
    const count = apiCallsDate === today ? (apiCallsToday || 0) + 1 : 1;

    await chrome.storage.local.set({ apiCallsToday: count, apiCallsDate: today });

    if (count === API_WARN_THRESHOLD) {
      console.warn(`[NRO] Approaching daily API limit: ${count}/${API_DAILY_LIMIT}`);
    }
  } finally {
    _counterLock = null;
    unlock();
  }
}
