'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const btnScan     = document.getElementById('btn-scan');
const btnOptions  = document.getElementById('btn-options');
const loadingBar  = document.getElementById('loading-bar');
const loadingProg = document.getElementById('loading-progress');
const statusStrip = document.getElementById('status-strip');
const statusText  = document.getElementById('status-text');
const statusStep  = document.getElementById('status-step');
const sourceBar   = document.getElementById('source-bar');
const taskList    = document.getElementById('task-list');
const introState  = document.getElementById('intro-state');
const emptyState  = document.getElementById('empty-state');
const errorState  = document.getElementById('error-state');
const errorHead   = document.getElementById('error-head');
const errorText   = document.getElementById('error-text');
const errorFix      = document.getElementById('error-fix');
const errorParseFix = document.getElementById('error-parse-fix');
const footerLeft    = document.getElementById('footer-left');
const btnCopy       = document.getElementById('btn-copy');

// ── Init: show cached results + clear badge when popup opens ──────────────────

(async () => {
  // Clear the badge — user has seen their tasks
  chrome.runtime.sendMessage({ action: 'clearBadge' });

  const cached = await getCached();
  if (cached?.todos?.length > 0) {
    render(cached.todos, cached.sources, cached.ts, null, cached.warnings, /*stale=*/true, cached.model);
  }
  // else: intro state is visible by default
})();

// ── Events ────────────────────────────────────────────────────────────────────

btnScan.addEventListener('click', runScan);
btnOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
btnCopy.addEventListener('click', copyTasks);

// ── Scan ──────────────────────────────────────────────────────────────────────

// Step messages — will be filtered down to only tabs that are actually open
const ALL_STEPS = ['Reading Classroom…', 'Reading Outlook…', 'Reading OnCourse…', 'Thinking with AI…'];
let scanInFlight = false;

async function runScan() {
  if (scanInFlight) return;
  scanInFlight = true;

  setState('loading');
  setProgress(0.04);

  let stepIdx = 0;
  statusText.textContent = ALL_STEPS[0];

  const stepTimer = setInterval(() => {
    stepIdx = Math.min(stepIdx + 1, ALL_STEPS.length - 1);
    statusText.textContent = ALL_STEPS[stepIdx];
    setProgress(0.08 + stepIdx * 0.22);
  }, 1500);

  chrome.runtime.sendMessage({ action: 'scrapeAll' }, response => {
    clearInterval(stepTimer);
    setProgress(1);
    scanInFlight = false;

    setTimeout(() => {
      if (chrome.runtime.lastError) {
        setState('error', chrome.runtime.lastError.message);
        return;
      }
      if (!response?.success) {
        setState('error', response?.error || 'Unknown error', response?.errorCode);
        return;
      }
      render(response.todos, response.sources, Date.now(), response.rawCount, response.warnings, false, response.model);
    }, 280);
  });
}

function setProgress(pct) {
  loadingProg.style.transform = `scaleX(${Math.min(1, pct)})`;
}

// ── Render ────────────────────────────────────────────────────────────────────

// Store current todos for copy
let currentTodos = [];

function render(todos, sources, ts, rawCount, warnings, stale = false, model = null) {
  currentTodos = todos || [];
  const counts = { classroom: 0, outlook: 0, oncourse: 0 };
  (todos || []).forEach(t => {
    const k = (t.source || '').toLowerCase();
    if (k in counts) counts[k]++;
  });

  updateSourceBar(sources, counts, warnings);

  if (!todos || todos.length === 0) {
    setState('empty');
    return;
  }

  // Group by priority
  const groups = { high: [], medium: [], low: [] };
  todos.forEach(t => {
    const p = VALID_PRIORITY.has(t.priority) ? t.priority : 'low';
    groups[p].push(t);
  });

  taskList.innerHTML = '';
  let delay = 0;

  const labels = { high: 'Urgent', medium: 'This Week', low: 'Later' };

  for (const [p, tasks] of Object.entries(groups)) {
    if (!tasks.length) continue;

    const hdr  = document.createElement('div');
    hdr.className = `grp-header grp-${p}`;
    hdr.appendChild(document.createTextNode(labels[p]));
    const line = document.createElement('span'); line.className = 'grp-line';
    const num  = document.createElement('span'); num.className  = 'grp-n';
    num.textContent = tasks.length;
    hdr.appendChild(line); hdr.appendChild(num);
    taskList.appendChild(hdr);

    tasks.forEach(task => {
      const el = buildCard(task, p);
      el.style.animationDelay = `${delay}ms`;
      delay += 28;
      taskList.appendChild(el);
    });
  }

  setState('results');

  // Footer
  const n = todos.length;
  footerLeft.textContent = '';

  const strong = document.createElement('strong');
  strong.textContent = n;
  footerLeft.appendChild(strong);
  footerLeft.append(` task${n !== 1 ? 's' : ''} · `);

  if (stale) {
    const hint = document.createElement('span');
    hint.className   = 'stale-hint';
    hint.textContent = `cached ${timeAgo(ts)} · hit Scan to refresh`;
    footerLeft.appendChild(hint);
  } else {
    footerLeft.append(timeAgo(ts));
  }

  if (model) {
    const m = document.createElement('span');
    m.className   = 'footer-model';
    m.textContent = ` · ${model}`;
    footerLeft.appendChild(m);
  }

  btnCopy.classList.remove('hidden');
}

const VALID_PRIORITY = new Set(['high', 'medium', 'low']);

// ── Card ──────────────────────────────────────────────────────────────────────

function buildCard(task, priority) {
  const a      = document.createElement('a');
  a.className  = 'task-item';
  a.href       = task.url || '#';
  a.target     = '_blank';
  a.rel        = 'noopener noreferrer';
  a.title      = task.title;

  const srcKey   = (task.source || '').toLowerCase();
  const dueClass = priority === 'high'   ? 'task-due urgent'
                 : priority === 'medium' ? 'task-due soon'
                 : 'task-due';

  a.innerHTML = /* all user data wrapped in esc() below */ `
    <div class="task-stripe ${priority}"></div>
    <div class="task-body">
      <span class="task-title">${esc(task.title)}</span>
      <div class="task-meta">
        <span class="pill ${srcKey}">
          <span class="pill-dot"></span>${esc(task.source || srcKey)}
        </span>
        ${task.dueDate ? `<span class="${dueClass}">⏱ ${esc(task.dueDate)}</span>` : ''}
      </div>
      ${task.notes ? `<div class="task-notes">${esc(task.notes)}</div>` : ''}
    </div>
    <div class="task-arrow">↗</div>
  `;

  return a;
}

// ── State machine ─────────────────────────────────────────────────────────────

function copyTasks() {
  if (!currentTodos.length) return;
  const lines = ['# Ondo Task List', ''];
  const groups = { high: 'Urgent', medium: 'This Week', low: 'Later' };
  for (const [p, label] of Object.entries(groups)) {
    const tasks = currentTodos.filter(t => (t.priority || 'low') === p);
    if (!tasks.length) continue;
    lines.push(`## ${label}`);
    tasks.forEach(t => {
      const due = t.dueDate ? ` (due ${t.dueDate})` : '';
      lines.push(`- [ ] [${t.title}](${t.url || '#'}) — ${t.source}${due}`);
    });
    lines.push('');
  }
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const orig = btnCopy.textContent;
    btnCopy.textContent = '✓ Copied';
    setTimeout(() => { btnCopy.textContent = orig; }, 1500);
  });
}

function setState(state, msg, errorCode) {
  [loadingBar, statusStrip, sourceBar, taskList, introState, emptyState, errorState]
    .forEach(hide);
  btnCopy.classList.add('hidden');

  btnScan.disabled    = false;
  btnScan.textContent = 'Scan';
  setProgress(0);

  switch (state) {
    case 'loading':
      btnScan.disabled       = true;
      btnScan.textContent    = '…';
      statusStep.textContent = '';
      show(loadingBar);
      show(statusStrip);
      break;

    case 'results':
      show(sourceBar);
      show(taskList);
      break;

    case 'empty':
      show(sourceBar);
      show(emptyState);
      break;

    case 'error': {
      const isCors   = errorCode === 'OLLAMA_CORS';
      const isParse  = errorCode === 'AI_PARSE_ERROR';
      errorHead.textContent = isCors  ? 'Ollama: Origin Blocked'
                            : isParse ? 'AI Response Error'
                            : 'Something went wrong';
      errorText.textContent = msg || 'Unknown error';
      if (isCors)  show(errorFix);      else hide(errorFix);
      if (isParse) show(errorParseFix); else hide(errorParseFix);
      show(errorState);
      break;
    }

    default: // intro
      show(introState);
  }
}

// ── Source bar ────────────────────────────────────────────────────────────────

function updateSourceBar(sources, counts, warnings) {
  const warnSet = new Set(
    (warnings || []).map(w => w.split(':')[0].trim().toLowerCase())
  );

  for (const key of ['classroom', 'outlook', 'oncourse']) {
    const chip  = document.getElementById(`chip-${key}`);
    const cntEl = document.getElementById(`cnt-${key}`);
    if (!chip) continue;

    const found = !!sources?.[key];
    const hasWarn = warnSet.has(key);

    chip.classList.remove('found', 'warn', 'classroom', 'outlook', 'oncourse');
    if (found && !hasWarn) {
      chip.classList.add('found', key);
    } else if (hasWarn) {
      chip.classList.add('warn');
    }

    const n = counts?.[key] ?? 0;
    cntEl.textContent = n > 0 ? `(${n})` : '';
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function show(el) { el?.classList.remove('hidden'); }
function hide(el) { el?.classList.add('hidden'); }

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getCached() {
  return new Promise(r => chrome.storage.local.get('lastScan', d => r(d.lastScan || null)));
}
