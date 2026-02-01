// Popup script for Netflix Ratings Extension

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
  document.getElementById('toggleVisibility').addEventListener('click', togglePasswordVisibility);
  document.getElementById('enabled').addEventListener('change', toggleEnabled);
});

async function saveSettings() {
  const apiKey = document.getElementById('apiKey').value.trim();
  const enabled = document.getElementById('enabled').checked;

  if (!apiKey) {
    showStatus('Please enter an API key', 'error');
    return;
  }

  // Validate API key by making a test request
  showStatus('Validating API key...', 'success');

  try {
    const response = await fetch(`https://www.omdbapi.com/?apikey=${apiKey}&t=inception`);
    const data = await response.json();

    if (data.Error && data.Error.includes('Invalid API key')) {
      showStatus('Invalid API key', 'error');
      return;
    }

    await chrome.storage.local.set({ apiKey, enabled });
    showStatus('Settings saved!', 'success');
  } catch (error) {
    // Save anyway if network error (key might still be valid)
    await chrome.storage.local.set({ apiKey, enabled });
    showStatus('Saved (could not validate)', 'success');
  }
}

async function toggleEnabled(event) {
  const enabled = event.target.checked;
  await chrome.storage.local.set({ enabled });
}

async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const ratingKeys = Object.keys(all).filter(k => k.startsWith('rating_'));

  if (ratingKeys.length === 0) {
    showStatus('Cache is already empty', 'success');
    return;
  }

  await chrome.storage.local.remove(ratingKeys);
  await updateStats();
  showStatus(`Cleared ${ratingKeys.length} cached ratings`, 'success');
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

function togglePasswordVisibility() {
  const input = document.getElementById('apiKey');
  const eyeIcon = document.getElementById('eyeIcon');

  if (input.type === 'password') {
    input.type = 'text';
    eyeIcon.innerHTML = `
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
      <line x1="1" y1="1" x2="23" y2="23"></line>
    `;
  } else {
    input.type = 'password';
    eyeIcon.innerHTML = `
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
      <circle cx="12" cy="12" r="3"></circle>
    `;
  }
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `status ${type}`;

  // Auto-hide after 3 seconds
  setTimeout(() => {
    status.className = 'status';
  }, 3000);
}
