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

let currentSettings = { ...DEFAULT_SETTINGS };

document.addEventListener('DOMContentLoaded', loadSettings);

saveButton.addEventListener('click', saveSettings);
resetButton.addEventListener('click', resetSettings);
workerUrlInput.addEventListener('input', updateConnectionStatus);
providerInput.addEventListener('change', () => {
  const provider = providerInput.value;
  populateModelPresets(provider);
  setModelValue(getStoredModelForProvider(provider));
  updateModelControls();
});
modelPresetInput.addEventListener('change', updateModelControls);

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  applySettings(settings);
}

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

  updateConnectionStatus();
  showStatus('Settings saved. Refresh open pages to apply content-script changes.', 'success');
}

async function resetSettings() {
  applySettings(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(DEFAULT_SETTINGS);
  showStatus('Settings reset to recommended defaults.', 'success');
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
