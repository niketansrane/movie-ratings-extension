'use strict';

/**
 * Shared constants for Netflix Ratings Overlay.
 * Imported by the service worker; content scripts duplicate these values
 * because content scripts cannot use ES module imports in Manifest V3
 * without a build step.
 */

/** How long cached ratings remain valid (7 days). */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum number of cached rating entries before pruning. */
const MAX_CACHE_SIZE = 1000;

/** Storage writes between prune checks. */
const PRUNE_INTERVAL = 50;

/** OMDb free-tier daily limit. */
const API_DAILY_LIMIT = 1000;

/** Warn in console when this many calls have been made today. */
const API_WARN_THRESHOLD = 900;

/** Timeout for each OMDb API fetch (ms). */
const FETCH_TIMEOUT_MS = 8000;

/** Prefix for all rating cache keys in chrome.storage.local. */
const CACHE_KEY_PREFIX = 'rating_';

/** Internal storage key for the prune counter. */
const PRUNE_COUNTER_KEY = '_nro_cacheWriteCount';
