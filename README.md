# Netflix Ratings Overlay

> See IMDb and Rotten Tomatoes ratings instantly when you hover over any movie or TV show on Netflix — no tab-switching needed.

![Chrome Extension](https://img.shields.io/badge/Platform-Chrome-green?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)
![License](https://img.shields.io/badge/License-MIT-yellow)

![Movie Ratings Extension Demo](assets/demo.gif)

## Features

| Feature | Description |
|---------|-------------|
| **IMDb Ratings** | Gold badge showing the IMDb score (e.g. 7.3) |
| **Rotten Tomatoes** | Red (Fresh ≥ 60%) or gray (Rotten < 60%) badge |
| **Hero Banner** | Works on the large featured banner at the top of Netflix |
| **Poster Cards** | Works on all small poster cards in browse rows |
| **Smart Caching** | Ratings cached for 7 days — fast & API-friendly |
| **Hover to View** | Non-intrusive — only appears when you hover |
| **Top-Left Anchor** | Badges always appear at the top-left corner of the poster |

## Installation

### 1. Get the extension

```bash
git clone https://github.com/niketansrane/movie-ratings-extension.git
```

### 2. Get a free OMDb API key

1. Go to [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx)
2. Choose the **FREE** tier (1,000 requests/day)
3. Enter your email → check inbox → activate

### 3. Load in Chrome

1. Navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `movie-ratings-extension` folder

### 4. Configure

1. Click the extension icon in Chrome's toolbar
2. Paste your OMDb API key
3. Click **Save**

## Usage

1. Open [netflix.com](https://www.netflix.com)
2. Hover over any movie poster or the hero banner
3. Rating badges appear at the top-left corner after ~300 ms

### Badge Guide

| Badge | Meaning |
|-------|---------|
| **IMDb 7.3** (gold) | IMDb rating out of 10 |
| **RT 85%** (red) | Rotten Tomatoes "Fresh" (≥ 60%) |
| **RT 42%** (gray) | Rotten Tomatoes "Rotten" (< 60%) |

No badge = no rating data available for that title.

## Project Structure

```
movie-ratings-extension/
├── manifest.json                  # Chrome extension config (MV3)
├── package.json                   # Project metadata & scripts
├── LICENSE                        # MIT license
├── PRIVACY.md                     # Privacy policy
│
├── src/
│   ├── background/
│   │   └── service-worker.js      # OMDb API, caching, rate limiting
│   ├── content/
│   │   ├── content.js             # DOM detection, hover handling, overlay
│   │   └── styles.css             # Rating badge styles
│   ├── popup/
│   │   ├── popup.html             # Settings UI
│   │   ├── popup.js               # Settings logic
│   │   └── popup.css              # Popup styles
│   └── constants/
│       └── config.js              # Shared constants reference
│
├── icons/                         # Extension icons (16/48/128 px)
├── scripts/
│   ├── generate-icons.js          # Icon generator
│   └── package.js                 # Build .zip for Chrome Web Store
│
├── assets/                        # Demo screenshots / videos
└── docs/plans/                    # Feature planning docs
```

## Architecture

```
┌──────────────────┐    chrome.runtime     ┌──────────────────┐
│   Content Script  │ ──── sendMessage ───▶ │  Service Worker   │
│   (netflix.com)   │ ◀── response ─────── │  (background)     │
│                   │                       │                   │
│  • Detect hover   │                       │  • OMDb API calls │
│  • Extract title  │                       │  • Smart search   │
│  • Render badges  │                       │  • Caching        │
│  • Position overlay│                      │  • Rate limiting  │
└──────────────────┘                       └──────────────────┘
         │                                          │
         └──────── chrome.storage.local ────────────┘
                   (cache + settings)
```

## Popup Settings

| Control | Function |
|---------|----------|
| **API Key** | Your OMDb API key (stored locally, never shared) |
| **Enable/Disable** | Toggle the extension on/off instantly |
| **Cached** | Number of ratings currently cached |
| **API calls today** | Today's OMDb API usage (limit: 1,000) |
| **Clear Cache** | Remove all cached ratings |

## Scripts

```bash
node scripts/generate-icons.js   # Regenerate extension icons
node scripts/package.js           # Build .zip for Chrome Web Store upload
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No ratings appear | Check API key in popup → make sure it's saved and valid |
| "Extension context invalidated" | Refresh the Netflix page |
| API limit reached | Free tier = 1,000/day. Cached ratings don't count. Wait until tomorrow. |
| Ratings wrong for a title | OMDb occasionally returns wrong matches for ambiguous titles |
| Extension icon grayed out | Make sure you're on `netflix.com` and the extension is enabled |

## Privacy

This extension:

- ✅ Only communicates with `omdbapi.com` to fetch ratings
- ✅ Stores everything locally on your device (`chrome.storage.local`)
- ❌ Does **not** collect personal data, analytics, or telemetry
- ❌ Does **not** access your Netflix account or viewing history

Full details: [PRIVACY.md](PRIVACY.md)

## Contributing

Contributions are welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
