/**
 * Arcks - Background Service Worker
 * Handles API proxy requests to Cloudflare Worker
 */

const DEFAULT_SETTINGS = {
  hoverDelay: 350,
  workerUrl: '',
  provider: 'gemini',
  enabled: true
};

async function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSummary') {
    handleGetSummary(request.url)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'getSettings') {
    getSettings().then(sendResponse);
    return true;
  }
});

async function handleGetSummary(url) {
  const settings = await getSettings();

  if (!settings.workerUrl) {
    return { error: 'Worker URL not configured. Set it in extension options.' };
  }

  if (!settings.enabled) {
    return { error: 'Extension is disabled' };
  }

  const response = await fetch(settings.workerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      provider: settings.provider || 'gemini'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}
