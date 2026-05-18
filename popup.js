const DEFAULT_SETTINGS = {
  hoverDelay: 250,
  workerUrl: 'https://arcks.rahulnilvan43.workers.dev',
  provider: 'openrouter',
  openrouterModel: 'google/gemini-2.5-flash',
  nvidiaModel: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  enabled: true
};

const MODEL_LABELS = {
  'google/gemini-2.5-flash': 'Gemini 2.5 Flash',
  'openai/gpt-4o-mini': 'GPT-4o mini',
  'anthropic/claude-sonnet-4': 'Claude Sonnet 4',
  'anthropic/claude-haiku-4.5': 'Claude Haiku 4.5',
  'meta-llama/llama-3.3-70b-instruct': 'Llama 3.3 70B',
  'nvidia/llama-3.3-nemotron-super-49b-v1.5': 'Nemotron Super 49B',
  'nvidia/llama-3.1-nemotron-ultra-253b-v1': 'Nemotron Ultra 253B',
  'nvidia/llama-3.1-nemotron-70b-instruct': 'Nemotron 70B',
  'meta/llama-3.1-70b-instruct': 'Llama 3.1 70B',
  'mistralai/mixtral-8x22b-instruct-v0.1': 'Mixtral 8x22B'
};

const enabledInput = document.getElementById('enabled');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const providerLabel = document.getElementById('providerLabel');
const modelLabel = document.getElementById('modelLabel');
const delayLabel = document.getElementById('delayLabel');
const settingsButton = document.getElementById('settings');
const refreshButton = document.getElementById('refresh');

document.addEventListener('DOMContentLoaded', loadSettings);
enabledInput.addEventListener('change', updateEnabled);
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
refreshButton.addEventListener('click', refreshActiveTab);

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  render(settings);
}

async function updateEnabled() {
  await chrome.storage.sync.set({ enabled: enabledInput.checked });
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  render(settings);
}

function render(settings) {
  const hasWorker = isValidWorkerUrl(settings.workerUrl);
  enabledInput.checked = Boolean(settings.enabled);

  statusEl.classList.toggle('ready', hasWorker && settings.enabled);
  if (!settings.enabled) {
    statusText.textContent = 'Previews are paused';
  } else if (hasWorker) {
    statusText.textContent = 'Ready on this browser';
  } else {
    statusText.textContent = 'Worker URL needs setup';
  }

  providerLabel.textContent =
    settings.provider === 'gemini' ? 'Google Gemini' :
    settings.provider === 'nvidia' ? 'NVIDIA NIM' :
    'OpenRouter';

  const model = settings.provider === 'nvidia'
    ? settings.nvidiaModel
    : settings.openrouterModel;

  modelLabel.textContent = settings.provider === 'gemini'
    ? 'Gemini 2.5 Flash'
    : MODEL_LABELS[model] || model || DEFAULT_SETTINGS.openrouterModel;
  delayLabel.textContent = `${settings.hoverDelay || DEFAULT_SETTINGS.hoverDelay} ms`;
}

function isValidWorkerUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
  await chrome.tabs.reload(tab.id);
  window.close();
}
