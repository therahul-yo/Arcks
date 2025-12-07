/**
 * Arcks - Options Page Script
 */

const DEFAULT_SETTINGS = {
  hoverDelay: 800,
  enabled: true
};

// DOM elements
const enabledInput = document.getElementById('enabled');
const hoverDelayInput = document.getElementById('hoverDelay');
const saveButton = document.getElementById('save');
const statusEl = document.getElementById('status');

// Load settings on page load
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  
  enabledInput.checked = settings.enabled;
  hoverDelayInput.value = settings.hoverDelay;
});

// Save settings
saveButton.addEventListener('click', async () => {
  const hoverDelay = parseInt(hoverDelayInput.value, 10);
  
  // Validate hover delay
  if (isNaN(hoverDelay) || hoverDelay < 200 || hoverDelay > 3000) {
    showStatus('Hover delay must be between 200-3000ms', 'error');
    return;
  }
  
  // Save to storage
  await chrome.storage.sync.set({
    enabled: enabledInput.checked,
    hoverDelay: hoverDelay
  });
  
  showStatus('Settings saved!', 'success');
});

// Show status message
function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
  
  setTimeout(() => {
    statusEl.classList.remove('visible');
  }, 3000);
}
