/**
 * Arcks - Options Page Script
 */

const DEFAULT_SETTINGS = {
  hoverDelay: 250,
  workerUrl: 'https://arcks.rahulnilvan43.workers.dev',
  provider: 'openrouter',
  openrouterModel: 'google/gemini-2.5-flash',
  nvidiaModel: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  enabled: true
};

const MODEL_PRESETS = {
  openrouter: [
    ['google/gemini-2.5-flash', 'Gemini 2.5 Flash'],
    ['openai/gpt-4o-mini', 'GPT-4o mini'],
    ['anthropic/claude-sonnet-4', 'Claude Sonnet 4'],
    ['anthropic/claude-haiku-4.5', 'Claude Haiku 4.5'],
    ['meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B Instruct']
  ],
  nvidia: [
    ['nvidia/llama-3.3-nemotron-super-49b-v1.5', 'Llama 3.3 Nemotron Super 49B'],
    ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'Llama 3.1 Nemotron Ultra 253B'],
    ['nvidia/llama-3.1-nemotron-70b-instruct', 'Llama 3.1 Nemotron 70B'],
    ['meta/llama-3.1-70b-instruct', 'Llama 3.1 70B Instruct'],
    ['mistralai/mixtral-8x22b-instruct-v0.1', 'Mixtral 8x22B Instruct']
  ]
};

const TEST_TIMEOUT_MS = 5000;

const enabledInput = document.getElementById('enabled');
const hoverDelayInput = document.getElementById('hoverDelay');
const workerUrlInput = document.getElementById('workerUrl');
const providerInput = document.getElementById('provider');
const modelRow = document.getElementById('modelRow');
const customModelRow = document.getElementById('customModelRow');
const modelPresetInput = document.getElementById('modelPreset');
const customModelInput = document.getElementById('customModel');
const saveButton = document.getElementById('save');
const resetButton = document.getElementById('reset');
const statusEl = document.getElementById('status');
const connectionStatus = document.getElementById('connectionStatus');
const connectionText = document.getElementById('connectionText');
const testWorkerBtn = document.getElementById('testWorker');
const workerTestStatus = document.getElementById('workerTestStatus');
const extIdEl = document.getElementById('extId');
const copyExtIdBtn = document.getElementById('copyExtId');

let currentSettings = { ...DEFAULT_SETTINGS };
let dirty = false;

document.addEventListener('DOMContentLoaded', loadSettings);

saveButton.addEventListener('click', saveSettings);
resetButton.addEventListener('click', resetSettings);
workerUrlInput.addEventListener('input', () => {
  markDirty();
  updateConnectionStatus();
  clearTestStatus();
});
providerInput.addEventListener('change', () => {
  markDirty();
  const provider = providerInput.value;
  populateModelPresets(provider);
  setModelValue(getStoredModelForProvider(provider));
  updateModelControls();
});
modelPresetInput.addEventListener('change', () => { markDirty(); updateModelControls(); });
customModelInput.addEventListener('input', markDirty);
hoverDelayInput.addEventListener('input', markDirty);
enabledInput.addEventListener('change', markDirty);
testWorkerBtn.addEventListener('click', testWorkerConnection);
copyExtIdBtn.addEventListener('click', copyExtensionId);

window.addEventListener('beforeunload', (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = '';
});

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  applySettings(settings);
  populateExtensionId();
  dirty = false; // applying stored values isn't a user edit
}

function populateExtensionId() {
  const id = (chrome.runtime && chrome.runtime.id) || '';
  extIdEl.textContent = id || 'unavailable';
}

function markDirty() { dirty = true; }

function applySettings(settings) {
  currentSettings = { ...DEFAULT_SETTINGS, ...settings };
  enabledInput.checked = Boolean(currentSettings.enabled);
  hoverDelayInput.value = currentSettings.hoverDelay || DEFAULT_SETTINGS.hoverDelay;
  workerUrlInput.value = currentSettings.workerUrl || '';
  providerInput.value = currentSettings.provider || DEFAULT_SETTINGS.provider;
  populateModelPresets(providerInput.value);
  setModelValue(getStoredModelForProvider(providerInput.value));
  updateConnectionStatus();
  updateModelControls();
}

async function saveSettings() {
  const hoverDelay = parseInt(hoverDelayInput.value, 10);
  const workerUrl = workerUrlInput.value.trim();
  const provider = providerInput.value || DEFAULT_SETTINGS.provider;
  const selectedModel = getSelectedModel();

  if (Number.isNaN(hoverDelay) || hoverDelay < 100 || hoverDelay > 3000) {
    showStatus('Hover delay must be between 100 and 3000 ms.', 'error');
    return;
  }

  if (!workerUrl || !isValidWorkerUrl(workerUrl)) {
    showStatus('Worker URL must be a valid https:// address.', 'error');
    return;
  }

  if ((provider === 'openrouter' || provider === 'nvidia') && !isValidModelId(selectedModel)) {
    showStatus('Model id must look like provider/model-name.', 'error');
    return;
  }

  const nextSettings = {
    enabled: enabledInput.checked,
    hoverDelay,
    workerUrl,
    provider,
    openrouterModel: provider === 'openrouter' ? selectedModel : currentSettings.openrouterModel,
    nvidiaModel: provider === 'nvidia' ? selectedModel : currentSettings.nvidiaModel
  };

  await chrome.storage.sync.set(nextSettings);
  currentSettings = { ...currentSettings, ...nextSettings };
  dirty = false;

  updateConnectionStatus();
  showStatus('Settings saved. Refresh open pages to apply content-script changes.', 'success');
}

async function resetSettings() {
  if (!confirm('Reset all settings to recommended defaults? This will overwrite your current values.')) return;
  applySettings(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
  dirty = false;
  showStatus('Settings reset to recommended defaults.', 'success');
}

async function testWorkerConnection() {
  const workerUrl = workerUrlInput.value.trim();
  if (!isValidWorkerUrl(workerUrl)) {
    setTestStatus('Enter a valid https:// URL first.', 'fail');
    return;
  }

  testWorkerBtn.disabled = true;
  setTestStatus('Testing…');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const started = Date.now();

  try {
    // Prefer /health (added in worker hardening commits) — falls back to a
    // minimal POST if the worker hasn't been redeployed yet.
    let res;
    try {
      res = await fetch(joinUrl(workerUrl, '/health'), { method: 'GET', signal: controller.signal });
      if (res.status === 404 || res.status === 405) throw new Error('no-health');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      res = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', test: true }),
        signal: controller.signal
      });
    }
    const elapsed = Date.now() - started;
    if (res.ok) {
      setTestStatus(`OK · ${elapsed}ms`, 'ok');
    } else {
      setTestStatus(`HTTP ${res.status} · ${elapsed}ms`, 'fail');
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      setTestStatus(`Timed out after ${TEST_TIMEOUT_MS / 1000}s`, 'fail');
    } else {
      setTestStatus('Could not reach worker', 'fail');
    }
  } finally {
    clearTimeout(timer);
    testWorkerBtn.disabled = false;
  }
}

function setTestStatus(message, tone) {
  workerTestStatus.textContent = message;
  workerTestStatus.classList.remove('ok', 'fail');
  if (tone) workerTestStatus.classList.add(tone);
}

function clearTestStatus() {
  workerTestStatus.textContent = '';
  workerTestStatus.classList.remove('ok', 'fail');
}

function joinUrl(base, path) {
  try {
    const u = new URL(base);
    u.pathname = path;
    u.search = '';
    return u.toString();
  } catch {
    return base.replace(/\/?$/, '') + path;
  }
}

async function copyExtensionId() {
  const id = (chrome.runtime && chrome.runtime.id) || '';
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
    const original = copyExtIdBtn.textContent;
    copyExtIdBtn.textContent = 'Copied';
    setTimeout(() => { copyExtIdBtn.textContent = original; }, 1500);
  } catch {
    showStatus('Could not copy — select the field manually.', 'error');
  }
}

function isValidWorkerUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function populateModelPresets(provider) {
  const models = MODEL_PRESETS[provider] || [];
  modelPresetInput.replaceChildren();

  for (const [value, label] of models) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    modelPresetInput.appendChild(option);
  }

  const customOption = document.createElement('option');
  customOption.value = 'custom';
  customOption.textContent = 'Custom model id';
  modelPresetInput.appendChild(customOption);
}

function getStoredModelForProvider(provider) {
  if (provider === 'nvidia') {
    return currentSettings.nvidiaModel || DEFAULT_SETTINGS.nvidiaModel;
  }

  return currentSettings.openrouterModel || DEFAULT_SETTINGS.openrouterModel;
}

function setModelValue(modelId) {
  const values = new Set((MODEL_PRESETS[providerInput.value] || []).map(([value]) => value));
  if (values.has(modelId)) {
    modelPresetInput.value = modelId;
    customModelInput.value = modelId;
    return;
  }

  modelPresetInput.value = 'custom';
  customModelInput.value = modelId;
}

function getSelectedModel() {
  if (modelPresetInput.value === 'custom') {
    return customModelInput.value.trim();
  }

  return modelPresetInput.value;
}

function isValidModelId(modelId) {
  return /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(modelId);
}

function updateModelControls() {
  const usesModel = providerInput.value === 'openrouter' || providerInput.value === 'nvidia';
  const isCustom = modelPresetInput.value === 'custom';

  modelRow.hidden = !usesModel;
  customModelRow.hidden = !usesModel || !isCustom;

  if (!isCustom) {
    customModelInput.value = modelPresetInput.value;
  }
}

function updateConnectionStatus() {
  const workerUrl = workerUrlInput.value.trim();
  const ready = isValidWorkerUrl(workerUrl);

  connectionStatus.classList.toggle('ready', ready);
  connectionText.textContent = ready ? 'Worker connected' : 'Worker not set';
}

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status visible ${type}`;
  clearTimeout(showStatus.timer);
  showStatus.timer = setTimeout(() => {
    statusEl.classList.remove('visible');
  }, 3800);
}
