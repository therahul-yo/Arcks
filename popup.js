const DEFAULT_SETTINGS = {
  hoverDelay: 250,
  workerUrl: 'https://arcks.rahulnilvan43.workers.dev',
  provider: 'openrouter',
  openrouterModel: 'google/gemini-2.5-flash',
  nvidiaModel: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
  enabled: true
};

const TEST_TIMEOUT_MS = 5000;

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

const PROVIDER_LABELS = {
  openrouter: 'OpenRouter',
  gemini:     'Google Gemini',
  nvidia:     'NVIDIA NIM'
};

const enabledInput   = document.getElementById('enabled');
const healthBtn      = document.getElementById('health');
const healthText     = document.getElementById('healthText');
const healthDetail   = document.getElementById('healthDetail');
const healthAction   = document.getElementById('healthAction');
const providerSeg    = document.getElementById('providerSeg');
const modelLabel     = document.getElementById('modelLabel');
const modelHint      = document.getElementById('modelHint');
const delayInput     = document.getElementById('delay');
const delayVal       = document.getElementById('delayVal');
const delayValBig    = document.getElementById('delayValBig');
const settingsButton = document.getElementById('settings');
const refreshButton  = document.getElementById('refresh');
const versionEl      = document.getElementById('version');

let current = { ...DEFAULT_SETTINGS };

document.addEventListener('DOMContentLoaded', init);

async function init() {
  populateVersion();
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  current = { ...DEFAULT_SETTINGS, ...settings };
  renderAll();
  // Kick a background health probe so the pill stops saying "Checking" before
  // the user clicks Test.
  checkHealth({ silent: true });
}

function populateVersion() {
  try {
    const manifest = chrome.runtime.getManifest();
    versionEl.textContent = `v${manifest.version}`;
  } catch {
    versionEl.textContent = '';
  }
}

function renderAll() {
  enabledInput.checked = Boolean(current.enabled);
  document.body.classList.toggle('is-disabled', !current.enabled);

  // Provider segmented control
  for (const btn of providerSeg.querySelectorAll('.seg')) {
    btn.classList.toggle('active', btn.dataset.provider === current.provider);
  }

  // Model + hint
  const modelId = activeModelId();
  modelLabel.textContent = MODEL_LABELS[modelId] || modelId || '—';
  modelHint.textContent  = workerConfigured() ? PROVIDER_LABELS[current.provider] : 'Worker URL not set';

  // Hover delay
  const delay = Number.isFinite(current.hoverDelay) ? current.hoverDelay : DEFAULT_SETTINGS.hoverDelay;
  delayInput.value = String(delay);
  updateDelayLabel(delay);
  updateRangeFill();
}

function activeModelId() {
  if (current.provider === 'nvidia') return current.nvidiaModel || DEFAULT_SETTINGS.nvidiaModel;
  if (current.provider === 'gemini') return 'google/gemini-2.5-flash';
  return current.openrouterModel || DEFAULT_SETTINGS.openrouterModel;
}

function workerConfigured() {
  try {
    const u = new URL(current.workerUrl || '');
    return u.protocol === 'https:' && Boolean(u.hostname);
  } catch { return false; }
}

function updateDelayLabel(value) {
  delayVal.textContent    = String(value);
  delayValBig.textContent = `${value} ms`;
}

function updateRangeFill() {
  const min = Number(delayInput.min);
  const max = Number(delayInput.max);
  const val = Number(delayInput.value);
  const pct = ((val - min) / (max - min)) * 100;
  delayInput.style.setProperty('--fill', `${pct}%`);
}

// ---- Event wiring ----

enabledInput.addEventListener('change', async () => {
  current.enabled = enabledInput.checked;
  await chrome.storage.sync.set({ enabled: current.enabled });
  document.body.classList.toggle('is-disabled', !current.enabled);
  setHealth(current.enabled ? null : 'paused', current.enabled ? null : 'Previews paused');
  if (current.enabled) checkHealth({ silent: true });
});

providerSeg.addEventListener('click', async (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  const provider = btn.dataset.provider;
  if (!provider || provider === current.provider) return;
  current.provider = provider;
  await chrome.storage.sync.set({ provider });
  renderAll();
});

delayInput.addEventListener('input', () => {
  const v = Number(delayInput.value);
  updateDelayLabel(v);
  updateRangeFill();
});

delayInput.addEventListener('change', async () => {
  const v = Number(delayInput.value);
  current.hoverDelay = v;
  await chrome.storage.sync.set({ hoverDelay: v });
});

healthBtn.addEventListener('click', () => checkHealth({ silent: false }));
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
refreshButton.addEventListener('click', refreshActiveTab);

// ---- Health probe ----

async function checkHealth({ silent }) {
  if (!current.enabled) {
    setHealth('paused', 'Previews paused');
    return;
  }
  if (!workerConfigured()) {
    setHealth('warn', 'Set a Worker URL in Settings');
    return;
  }

  setHealth('test', silent ? 'Connecting…' : 'Testing…');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    let res;
    try {
      res = await fetch(joinUrl(current.workerUrl, '/health'), {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store'
      });
      if (res.status === 404 || res.status === 405) throw new Error('no-health');
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // Fallback for workers without /health
      res = await fetch(current.workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com', test: true }),
        signal: controller.signal
      });
    }
    const elapsed = Date.now() - t0;
    if (res.ok) setHealth('ok',  `Ready · ${elapsed} ms`);
    else        setHealth('bad', `HTTP ${res.status} · ${elapsed} ms`);
  } catch (err) {
    if (err.name === 'AbortError') setHealth('bad', `Timed out (${TEST_TIMEOUT_MS / 1000}s)`);
    else                            setHealth('bad', 'Worker unreachable');
  } finally {
    clearTimeout(timer);
  }
}

function setHealth(state, detail) {
  healthBtn.classList.remove('ok', 'warn', 'bad', 'test');
  if (state) healthBtn.classList.add(state);

  let label = 'Status';
  if (state === 'ok')     label = 'Live';
  else if (state === 'warn') label = 'Setup';
  else if (state === 'bad')  label = 'Down';
  else if (state === 'test') label = 'Test';
  else if (state === 'paused') label = 'Paused';

  healthText.firstElementChild.textContent = label;
  healthDetail.textContent = detail || '';
  healthAction.textContent = state === 'test' ? '' : 'Test';
}

// ---- Helpers ----

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

async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url || '')) return;
  await chrome.tabs.reload(tab.id);
  window.close();
}
