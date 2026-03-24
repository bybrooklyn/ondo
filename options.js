'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const btnOllama        = document.getElementById('btn-ollama');
const btnClaude        = document.getElementById('btn-claude');
const btnOpenAI        = document.getElementById('btn-openai');
const ollamaConfig     = document.getElementById('ollama-config');
const claudeConfig     = document.getElementById('claude-config');
const openaiConfig     = document.getElementById('openai-config');
const ollamaUrl        = document.getElementById('ollama-url');
const ollamaModel      = document.getElementById('ollama-model');
const ollamaDatalist   = document.getElementById('ollama-model-datalist');
const claudeKey        = document.getElementById('claude-key');
const claudeModel      = document.getElementById('claude-model');
const openaiKey        = document.getElementById('openai-key');
const openaiBaseUrl    = document.getElementById('openai-base-url');
const openaiModel      = document.getElementById('openai-model');
const btnTestOllama    = document.getElementById('btn-test-ollama');
const btnTestClaude    = document.getElementById('btn-test-claude');
const btnTestOpenAI    = document.getElementById('btn-test-openai');
const ollamaResult     = document.getElementById('ollama-result');
const claudeResult     = document.getElementById('claude-result');
const openaiResult     = document.getElementById('openai-result');
const btnSave          = document.getElementById('btn-save');
const saveToast        = document.getElementById('save-toast');
const installedSection = document.getElementById('installed-section');
const installedList    = document.getElementById('installed-list');
const installedEmpty   = document.getElementById('installed-empty');
const corsFixBox       = document.getElementById('cors-fix');
const smartFilterToggle = document.getElementById('smart-filter-toggle');
const outlookCapInput   = document.getElementById('outlook-cap');

let activeProvider = 'ollama';

// ── Load saved settings + auto-fetch models ───────────────────────────────────

chrome.storage.sync.get({
  provider:      'ollama',
  ollamaUrl:     'http://localhost:11434',
  ollamaModel:   'qwen3:4b',
  claudeApiKey:  '',
  claudeModel:   'claude-haiku-4-5-20251001',
  openaiApiKey:  '',
  openaiModel:   'gpt-4o-mini',
  openaiBaseUrl: 'https://api.openai.com/v1',
  smartFilter:   false,
  outlookCap:    15,
}, s => {
  ollamaUrl.value            = s.ollamaUrl;
  ollamaModel.value          = s.ollamaModel;
  claudeKey.value             = s.claudeApiKey;
  claudeModel.value           = s.claudeModel;
  openaiKey.value             = s.openaiApiKey;
  openaiModel.value           = s.openaiModel;
  openaiBaseUrl.value         = s.openaiBaseUrl;
  smartFilterToggle.checked   = s.smartFilter;
  outlookCapInput.value       = s.outlookCap;
  setProvider(s.provider || 'ollama');
  syncPresets('ollama-presets', ollamaModel.value);
  syncPresets('claude-presets', claudeModel.value);
  syncPresets('openai-presets', openaiModel.value);

  if ((s.provider || 'ollama') === 'ollama') {
    loadInstalledModels(s.ollamaUrl || 'http://localhost:11434');
  }
});

// ── Provider toggle ───────────────────────────────────────────────────────────

btnOllama.addEventListener('click', () => setProvider('ollama'));
btnClaude.addEventListener('click', () => setProvider('claude'));
btnOpenAI.addEventListener('click', () => setProvider('openai'));

function setProvider(p) {
  activeProvider = p;
  btnOllama.classList.toggle('active', p === 'ollama');
  btnClaude.classList.toggle('active', p === 'claude');
  btnOpenAI.classList.toggle('active', p === 'openai');
  ollamaConfig.classList.toggle('hidden', p !== 'ollama');
  claudeConfig.classList.toggle('hidden', p !== 'claude');
  openaiConfig.classList.toggle('hidden', p !== 'openai');
}

// ── Model presets ─────────────────────────────────────────────────────────────

document.getElementById('ollama-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  ollamaModel.value = btn.dataset.model;
  syncPresets('ollama-presets', btn.dataset.model);
  highlightActiveModel(btn.dataset.model);
});

document.getElementById('claude-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  claudeModel.value = btn.dataset.model;
  syncPresets('claude-presets', btn.dataset.model);
});

document.getElementById('openai-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  openaiModel.value = btn.dataset.model;
  syncPresets('openai-presets', btn.dataset.model);
});

ollamaModel.addEventListener('input', () => {
  syncPresets('ollama-presets', ollamaModel.value);
  highlightActiveModel(ollamaModel.value);
});
claudeModel.addEventListener('input', () => syncPresets('claude-presets', claudeModel.value));
openaiModel.addEventListener('input', () => syncPresets('openai-presets', openaiModel.value));

function syncPresets(containerId, value) {
  document.querySelectorAll(`#${containerId} .preset-btn`).forEach(btn => {
    btn.classList.toggle('active', btn.dataset.model === value);
  });
}

// ── Installed model list ──────────────────────────────────────────────────────

// Direct fetch from extension page — works once OLLAMA_ORIGINS is set
async function loadInstalledModels(baseUrl) {
  const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${url}/api/tags`);

    if (res.status === 403) {
      showCorsBox(true);
      return;
    }
    showCorsBox(false);

    if (!res.ok) return;

    const data   = await res.json();
    const models = data.models || [];
    renderInstalledModels(models);
    populateDatalist(models);
  } catch (_) {
    // Ollama not running or CORS blocked — show a subtle hint in the installed list
    renderInstalledModels([]);
    if (installedSection && !installedSection.classList.contains('hidden')) return;
    // Show the section with a dim "not reachable" note so user knows why list is empty
    if (installedEmpty) {
      installedSection?.classList.remove('hidden');
      installedEmpty.style.display = '';
      installedEmpty.textContent   = 'Ollama not reachable — run "ollama serve" then refresh';
    }
  }
}

function renderInstalledModels(models) {
  installedList.textContent = '';
  const current = ollamaModel.value.trim();

  if (models.length === 0) {
    installedSection.classList.add('hidden');
    return;
  }

  installedSection.classList.remove('hidden');
  installedEmpty.style.display = 'none';

  models.forEach(m => {
    const row  = document.createElement('div');
    row.className = 'model-row' + (m.name === current ? ' active-model' : '');
    row.dataset.model = m.name;

    const sizeStr   = m.size   ? fmtBytes(m.size) : '';
    // Handle both raw API shape (m.details.*) and mapped shape from testOllama (m.params/m.quant)
    const paramsStr = m.params ?? m.details?.parameter_size      ?? '';
    const quantStr  = m.quant  ?? m.details?.quantization_level  ?? '';
    const meta      = [paramsStr, quantStr, sizeStr].filter(Boolean).join(' · ');

    const info = document.createElement('div');
    info.className = 'model-row-info';

    const nameEl = document.createElement('div');
    nameEl.className   = 'model-row-name';
    nameEl.textContent = m.name;

    const metaEl = document.createElement('div');
    metaEl.className   = 'model-row-meta';
    metaEl.textContent = meta;

    info.appendChild(nameEl);
    if (meta) info.appendChild(metaEl);

    const useBtn = document.createElement('button');
    useBtn.className   = 'model-use-btn';
    useBtn.textContent = m.name === current ? 'Active' : 'Use';
    useBtn.addEventListener('click', () => {
      ollamaModel.value = m.name;
      syncPresets('ollama-presets', m.name);
      highlightActiveModel(m.name);
    });

    row.appendChild(info);
    row.appendChild(useBtn);
    installedList.appendChild(row);
  });
}

function populateDatalist(models) {
  ollamaDatalist.textContent = '';
  models.forEach(m => {
    const opt   = document.createElement('option');
    opt.value   = m.name;
    ollamaDatalist.appendChild(opt);
  });
}

function highlightActiveModel(name) {
  installedList.querySelectorAll('.model-row').forEach(row => {
    const active = row.dataset.model === name;
    row.classList.toggle('active-model', active);
    const btn = row.querySelector('.model-use-btn');
    if (btn) btn.textContent = active ? 'Active' : 'Use';
  });
}

function showCorsBox(visible) {
  corsFixBox.classList.toggle('hidden', !visible);
}

function fmtBytes(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1_000_000_000;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1_000_000).toFixed(0)} MB`;
}

// Re-fetch when URL changes
ollamaUrl.addEventListener('change', () => {
  loadInstalledModels(ollamaUrl.value);
});

// ── Test Ollama ───────────────────────────────────────────────────────────────

btnTestOllama.addEventListener('click', async () => {
  const url = ollamaUrl.value.trim() || 'http://localhost:11434';
  setChip(ollamaResult, 'testing', 'Connecting…');
  btnTestOllama.disabled = true;

  // Load installed models at the same time
  loadInstalledModels(url);

  chrome.runtime.sendMessage({ action: 'testOllama', url }, res => {
    btnTestOllama.disabled = false;

    if (res?.errorCode === 'OLLAMA_CORS') {
      setChip(ollamaResult, 'err', '✗ 403 — see fix below');
      showCorsBox(true);
      return;
    }
    showCorsBox(false);

    if (res?.success) {
      const n = res.models?.length ?? 0;
      setChip(ollamaResult, 'ok', `✓ Connected · ${n} model${n !== 1 ? 's' : ''}`);
      renderInstalledModels(res.models || []);
      populateDatalist(res.models || []);
    } else {
      setChip(ollamaResult, 'err', `✗ ${res?.error || 'Cannot reach Ollama'}`);
    }
  });
});

// ── Test OpenAI ───────────────────────────────────────────────────────────────

btnTestOpenAI.addEventListener('click', () => {
  const key     = openaiKey.value.trim();
  const model   = openaiModel.value.trim()   || 'gpt-4o-mini';
  const baseUrl = openaiBaseUrl.value.trim() || 'https://api.openai.com/v1';

  if (!key) {
    setChip(openaiResult, 'err', '✗ Enter a key first');
    return;
  }

  setChip(openaiResult, 'testing', 'Verifying…');
  btnTestOpenAI.disabled = true;

  chrome.runtime.sendMessage({ action: 'testOpenAI', key, model, baseUrl }, res => {
    btnTestOpenAI.disabled = false;
    if (res?.success) {
      setChip(openaiResult, 'ok', '✓ Key valid');
    } else {
      setChip(openaiResult, 'err', `✗ ${res?.error || 'Invalid key'}`);
    }
  });
});

// ── Test Claude ───────────────────────────────────────────────────────────────

btnTestClaude.addEventListener('click', () => {
  const key   = claudeKey.value.trim();
  const model = claudeModel.value.trim() || 'claude-haiku-4-5-20251001';

  if (!key) {
    setChip(claudeResult, 'err', '✗ Enter a key first');
    return;
  }

  setChip(claudeResult, 'testing', 'Verifying…');
  btnTestClaude.disabled = true;

  chrome.runtime.sendMessage({ action: 'testClaude', key, model }, res => {
    btnTestClaude.disabled = false;
    if (res?.success) {
      setChip(claudeResult, 'ok', '✓ Key valid');
    } else {
      setChip(claudeResult, 'err', `✗ ${res?.error || 'Invalid key'}`);
    }
  });
});

// ── Save ──────────────────────────────────────────────────────────────────────

btnSave.addEventListener('click', () => {
  if (activeProvider === 'claude' && !claudeKey.value.trim()) {
    setChip(claudeResult, 'err', '✗ Paste your API key before saving');
    claudeKey.focus();
    return;
  }
  if (activeProvider === 'openai' && !openaiKey.value.trim()) {
    setChip(openaiResult, 'err', '✗ Paste your API key before saving');
    openaiKey.focus();
    return;
  }

  const settings = {
    provider:      activeProvider,
    ollamaUrl:     ollamaUrl.value.trim()      || 'http://localhost:11434',
    ollamaModel:   ollamaModel.value.trim()    || 'qwen3:4b',
    claudeApiKey:  claudeKey.value.trim(),
    claudeModel:   claudeModel.value.trim()    || 'claude-haiku-4-5-20251001',
    openaiApiKey:  openaiKey.value.trim(),
    openaiModel:   openaiModel.value.trim()    || 'gpt-4o-mini',
    openaiBaseUrl: openaiBaseUrl.value.trim()  || 'https://api.openai.com/v1',
    smartFilter:   smartFilterToggle.checked,
    outlookCap:    Math.max(1, Math.min(50, parseInt(outlookCapInput.value, 10) || 15)),
  };

  chrome.storage.sync.set(settings, () => {
    saveToast.classList.add('show');
    setTimeout(() => saveToast.classList.remove('show'), 2000);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function setChip(el, state, text) {
  el.textContent  = text;
  el.className    = 'test-chip';
  el.style.display = 'flex'; // always visible when called; CSS classes control color
  if (state === 'ok')       el.classList.add('ok');
  else if (state === 'err') el.classList.add('err');
  // else: 'testing' — neutral style, display already set above
}
