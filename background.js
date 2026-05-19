/**
 * Arcks - Background Service Worker
 * Handles API proxy requests to Cloudflare Worker
 */

const FETCH_TIMEOUT_MS = 8000;
const WORKER_RETRY_MAX = 2;
const WORKER_RETRY_BASE_MS = 250;

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

  sendResponse({ error: 'Unknown action' });
  return false;
});

async function handleGetSummary(url, pageHint = '') {
  const settings = await getSettings();

  if (!settings.workerUrl) {
    return { error: 'Worker URL not configured. Set it in extension options.' };
  }

  if (!settings.enabled) {
    return { error: 'Extension is disabled' };
  }

  const body = {
    url,
    provider: settings.provider || 'openrouter',
    model: getProviderModel(settings),
    pageHint: pageHint || ''
  };

  const t0 = Date.now();
  const response = await fetchWorkerWithRetry(settings.workerUrl, body);
  const latencyMs = Date.now() - t0;

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(formatWorkerError(response.status, errorText));
  }

  const data = await response.json();

  // Surface client-observed latency + cache hit (worker may also set _cached)
  if (data && typeof data === 'object') {
    data._latencyMs = latencyMs;
    if (typeof data._cached !== 'boolean') {
      data._cached = data.cached === true;
    }
  }
  return data;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWorkerWithRetry(url, body) {
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };

  let lastError;
  for (let attempt = 0; attempt <= WORKER_RETRY_MAX; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, FETCH_TIMEOUT_MS);

      // Retry only on 5xx (transient server fault). 4xx is a real error.
      if (response.status >= 500 && response.status < 600 && attempt < WORKER_RETRY_MAX) {
        lastError = new Error(`Worker ${response.status}`);
      } else {
        return response;
      }
    } catch (err) {
      lastError = err;
      const isAbort = err && err.name === 'AbortError';
      const isNetwork = err && err.name === 'TypeError'; // fetch network failures throw TypeError
      const transient = isAbort || isNetwork;
      if (!transient || attempt === WORKER_RETRY_MAX) throw err;
    }

    if (attempt < WORKER_RETRY_MAX) {
      const delay = WORKER_RETRY_BASE_MS * Math.pow(4, attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError || new Error('Worker call failed');
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
