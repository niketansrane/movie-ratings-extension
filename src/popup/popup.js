'use strict';

/**
 * Popup Script — Netflix Ratings Overlay
 *
 * Manages the extension settings popup: API key configuration,
 * enable/disable toggle, cache stats, and cache clearing.
 */

const VALIDATE_TIMEOUT_MS = 8000;
const STATUS_DISPLAY_MS   = 3000;
const API_KEY_PATTERN     = /^[a-zA-Z0-9]+$/;

let statusTimer = null;

// ─── Bootstrap ────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get(['apiKey', 'enabled']);

  document.getElementById('apiKey').value   = settings.apiKey || '';
  document.getElementById('enabled').checked = settings.enabled !== false;

  await refreshStats();

  document.getElementById('save').addEventListener('click', onSave);
  document.getElementById('clearCache').addEventListener('click', onClearCache);
  document.getElementById('toggleVisibility').addEventListener('click', onToggleVisibility);
  document.getElementById('enabled').addEventListener('change', onToggleEnabled);
});

// ─── Save settings ───────────────────────────────────────────

async function onSave() {
  const apiKey  = document.getElementById('apiKey').value.trim();
  const enabledEl = document.getElementById('enabled');
  const saveBtn = document.getElementById('save');

  if (!apiKey) {
    showStatus('Please enter an API key.', 'error');
    return;
  }

  if (!API_KEY_PATTERN.test(apiKey)) {
    showStatus('API key should only contain letters and numbers.', 'error');
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Validating…';
  showStatus('Validating API key…', 'info');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);

    const res  = await fetch(
      `https://www.omdbapi.com/?apikey=${encodeURIComponent(apiKey)}&t=inception`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const data = await res.json();

    if (data.Response === 'False' && data.Error?.toLowerCase().includes('invalid api key')) {
      showStatus('Invalid API key. Please check and try again.', 'error');
      return;
    }

    await chrome.storage.local.set({ apiKey, enabled: enabledEl.checked });
    showStatus('Settings saved!', 'success');
  } catch (err) {
    // Network error — save anyway; key might still be valid
    await chrome.storage.local.set({ apiKey, enabled: enabledEl.checked });
    showStatus('Saved (could not validate — network error).', 'success');
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save';
  }
}

// ─── Toggle enabled ──────────────────────────────────────────

async function onToggleEnabled(e) {
  const on = e.target.checked;
  await chrome.storage.local.set({ enabled: on });
  showStatus(on ? 'Extension enabled.' : 'Extension disabled.', on ? 'success' : 'info');
}

// ─── Clear cache ─────────────────────────────────────────────

async function onClearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('rating_'));

  if (!keys.length) {
    showStatus('Cache is already empty.', 'info');
    return;
  }

  await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ _nro_cacheWriteCount: 0 });
  await refreshStats();
  showStatus(`Cleared ${keys.length} cached ratings.`, 'success');
}

// ─── Stats ───────────────────────────────────────────────────

async function refreshStats() {
  const all   = await chrome.storage.local.get(null);
  const count = Object.keys(all).filter(k => k.startsWith('rating_')).length;

  document.getElementById('cacheCount').textContent = count;

  const today = new Date().toDateString();
  const calls = all.apiCallsDate === today ? (all.apiCallsToday || 0) : 0;
  const el    = document.getElementById('apiCalls');
  el.textContent  = calls;
  el.style.color  = calls >= 900 ? '#dc3545' : '';
}

// ─── Password visibility toggle ─────────────────────────────

function onToggleVisibility() {
  const input = document.getElementById('apiKey');
  const icon  = document.getElementById('eyeIcon');

  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';

  icon.innerHTML = showing
    ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>'
    : '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
}

// ─── Status display ─────────────────────────────────────────

function showStatus(message, type) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className   = `status ${type}`;

  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.className = 'status';
    statusTimer  = null;
  }, STATUS_DISPLAY_MS);
}
