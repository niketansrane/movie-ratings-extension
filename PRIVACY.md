# Privacy Policy — Netflix Ratings Overlay

**Last updated:** February 7, 2026

## Overview

Netflix Ratings Overlay is a browser extension that shows IMDb and Rotten Tomatoes
ratings on Netflix movie and TV show posters. We take your privacy seriously.

## Data Collection

This extension **does not** collect, store, or transmit any personal data.

### What the extension accesses

| Data | Purpose | Stored where | Shared with |
|------|---------|-------------|-------------|
| Movie/show titles from Netflix DOM | To look up ratings | Not stored | Sent to OMDb API as search queries |
| OMDb API key (user-provided) | To authenticate API requests | `chrome.storage.local` (your device only) | Sent to OMDb API |
| Cached ratings | To avoid repeated API calls | `chrome.storage.local` (your device only) | Not shared |
| API call count (daily) | To respect the free-tier rate limit | `chrome.storage.local` (your device only) | Not shared |

### What the extension does NOT access

- Your Netflix account credentials or viewing history
- Any personal or financial information
- Cookies, browsing history, or data from other websites
- Analytics, telemetry, or crash reports

## Third-Party Services

The extension communicates with **one** external service:

- **OMDb API** (`https://www.omdbapi.com`) — to fetch movie ratings.
  OMDb's privacy policy: https://www.omdbapi.com/legal.htm

No other network requests are made.

## Data Storage

All data is stored locally on your device using Chrome's `chrome.storage.local` API.
Nothing is stored on external servers. Cached ratings expire automatically after 7 days.

## Permissions

| Permission | Reason |
|-----------|--------|
| `storage` | To cache ratings and store your API key locally |
| `host_permissions: omdbapi.com` | To fetch ratings from the OMDb API |
| `content_scripts: netflix.com` | To detect movie posters and show rating overlays |

## Changes

If this policy changes, the update will be reflected here with a new date.

## Contact

For questions, open an issue at:
https://github.com/niketansrane/movie-ratings-extension/issues
