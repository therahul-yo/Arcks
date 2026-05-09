/**
 * Arcks - Options Page Script
 */

const DEFAULT_SETTINGS = {
  hoverDelay: 350,
  workerUrl: '',
  provider: 'gemini',
  enabled: true
};

const enabledInput = document.getElementById('enabled');
const hoverDelayInput = document.getElementById('hoverDelay');
const workerUrlInput = document.getElementById('workerUrl');
const providerInput = document.getElementById('provider');
const saveButton = document.getElementById('save');
const statusEl = document.getElementById('status');

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  enabledInput.checked = settings.enabled;
  hoverDelayInput.value = settings.hoverDelay;
  if (workerUrlInput) workerUrlInput.value = settings.workerUrl || '';
  if (providerInput) providerInput.value = settings.provider || 'gemini';
});

saveButton.addEventListener('click', async () => {
  const hoverDelay = parseInt(hoverDelayInput.value, 10);
  const workerUrl = workerUrlInput ? workerUrlInput.value.trim() : '';
  const provider = providerInput ? providerInput.value : 'gemini';

  if (isNaN(hoverDelay) || hoverDelay < 100 || hoverDelay > 3000) {
    showStatus('Hover delay must be between 100-3000ms', 'error');
    return;
  }

  if (workerUrl && !isValidUrl(workerUrl)) {
    showStatus("Worker URL must use https://", 'error');
    return;
  }

  await chrome.storage.sync.set({
    enabled: enabledInput.checked,
    hoverDelay: hoverDelay,
    workerUrl: workerUrl,
    provider: provider
  });

  showStatus('Settings saved!', 'success');
});

function isValidUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
  setTimeout(() => statusEl.classList.remove('visible'), 3000);
}
