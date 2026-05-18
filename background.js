/**
 * Arcks - Background Service Worker
 * Handles API proxy requests to Cloudflare Worker
 */

const DEFAULT_SETTINGS = {
  hoverDelay: 250,
  workerUrl: 'https://arcks.rahulnilvan43.workers.dev',
  provider: 'openrouter',
  openrouterModel: 'google/gemini-2.5-flash',
  nvidiaModel: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  enabled: true
};

async function getSettings() {
  return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSummary') {
    handleGetSummary(request.url, request.pageHint)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'getSettings') {
    getSettings().then(sendResponse);
    return true;
  }
});

async function handleGetSummary(url, pageHint = '') {
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
      provider: settings.provider || 'openrouter',
      model: getProviderModel(settings),
      pageHint: pageHint || ''
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(formatWorkerError(response.status, errorText));
  }

  return response.json();
}

function getProviderModel(settings) {
  if (settings.provider === 'nvidia') {
    return settings.nvidiaModel || 'nvidia/llama-3.3-nemotron-super-49b-v1.5';
  }

  return settings.openrouterModel || 'google/gemini-2.5-flash';
}

function formatWorkerError(status, errorText) {
  try {
    const parsed = JSON.parse(errorText);
    if (parsed?.error) return parsed.error;
  } catch {
    // Use the raw text below.
  }

  return `Preview service error (${status})`;
}
