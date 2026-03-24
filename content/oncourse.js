'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scrape') {
    try {
      sendResponse(scrapeOnCourse());
    } catch (e) {
      console.error('[Ondo/oncourse] scrape threw:', e);
      sendResponse([]);
    }
    return true;
  }
});

// Statuses that mean the item is done — case-insensitive substring checks
const DONE_STATUSES = [
  'submitted', 'turned in', 'complete', 'completed',
  'passed', 'graded', 'returned', 'scored', 'closed',
  'excused', 'accepted', 'collected',
];

const isDone = text => {
  const lower = (text || '').toLowerCase();
  return DONE_STATUSES.some(s => lower.includes(s));
};

// ── Main ──────────────────────────────────────────────────────────────────────

function scrapeOnCourse() {
  const items = [];
  const seen  = new Set();

  const add = item => {
    if (!item?.title) return;
    const key = item.url && item.url !== window.location.href ? item.url : item.title;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  // ── 1. Assignment tables ──────────────────────────────────────────────────
  document.querySelectorAll('table').forEach(table => {
    try {
      const headers = Array.from(table.querySelectorAll('th'))
        .map(th => th.textContent.trim().toLowerCase());
      const hasAssignment = headers.some(h => /assignment|task|name|title/.test(h));
      const hasDue        = headers.some(h => /due|date/.test(h));
      if (!hasAssignment && !hasDue) return;

      // Resolve column indices from headers, with safe fallbacks
      const nameIdx   = findColIdx(headers, /assignment|task|name|title/);
      const dueIdx    = findColIdx(headers, /due|date/);
      const statusIdx = findColIdx(headers, /status|submitted|complete|turned/);

      table.querySelectorAll('tbody tr').forEach(row => {
        try {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) return;

          // Use matched index, or first/second cell as fallback
          const nameCell   = cells[nameIdx >= 0 ? nameIdx : 0];
          const dueCell    = cells[dueIdx  >= 0 ? dueIdx  : 1];
          const statusCell = statusIdx >= 0 ? cells[statusIdx] : null;

          if (isDone(statusCell?.textContent)) return;

          const anchor = nameCell.querySelector('a');
          const title  = anchor?.textContent.trim() || nameCell.textContent.trim();
          if (!title || title.length < 2) return;

          const url     = anchor?.href || window.location.href;
          const dueDate = parseDate(dueCell?.textContent.trim());

          add({ title, dueDate, url, source: 'oncourse', type: 'assignment' });
        } catch {}
      });
    } catch {}
  });

  // ── 2. Card / list-item based layout ─────────────────────────────────────
  const cardSels = [
    '.assignment-card', '.task-card', '.todo-item', '.assignment-item',
    '[class*="assignment"]', '[class*="Assignment"]', '[data-assignment]',
    'li.assignment', 'li.task',
  ];
  cardSels.forEach(sel => {
    try {
      document.querySelectorAll(sel).forEach(card => {
        try {
          if (isDone(getText(card, ['.status', '[class*="status"]', '.state']))) return;

          const anchor = card.querySelector('a') || (card.tagName === 'A' ? card : null);
          const url    = anchor?.href || window.location.href;
          if (seen.has(url)) return;

          const title = getText(card, [
            '.assignment-title', '.task-title', '.name', 'h2', 'h3', 'h4', '.title', 'a',
          ]) || card.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);

          if (!title || title.length < 3) return;

          const dueDate = parseDate(getText(card, ['.due-date', '[class*="due"]', 'time', '.date']))
                       || extractDueFromText(card.textContent);

          add({ title, dueDate, url, source: 'oncourse', type: 'assignment' });
        } catch {}
      });
    } catch {}
  });

  // ── 3. Missing / overdue alert banners ───────────────────────────────────
  try {
    document.querySelectorAll(
      '.alert, .notification, .missing-work, [class*="missing"], [class*="overdue"]'
    ).forEach(el => {
      try {
        const anchor = el.querySelector('a');
        const url    = anchor?.href || window.location.href;
        if (seen.has(url)) return;
        const title = anchor?.textContent.trim() || el.textContent.trim().slice(0, 120);
        if (!title || title.length < 3) return;
        add({ title, dueDate: extractDueFromText(el.textContent), url, source: 'oncourse', type: 'missing' });
      } catch {}
    });
  } catch {}

  // ── 4. Last-resort: assignment-shaped links ───────────────────────────────
  if (items.length === 0) {
    try {
      document.querySelectorAll('a[href*="assignment"], a[href*="task"], a[href*="todo"]').forEach(anchor => {
        try {
          const url   = anchor.href;
          const title = anchor.textContent.trim();
          if (!title || title.length < 3 || seen.has(url)) return;
          add({ title, url, source: 'oncourse', type: 'assignment', dueDate: null });
        } catch {}
      });
    } catch {}
  }

  return items;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns column index whose header text matches regex, or -1 if not found
function findColIdx(headers, re) {
  for (let i = 0; i < headers.length; i++) {
    if (re.test(headers[i])) return i;
  }
  return -1;
}

function getText(el, selectors) {
  for (const sel of selectors) {
    try {
      const node = el?.querySelector?.(sel);
      if (node) {
        const t = node.textContent.trim();
        if (t) return t;
      }
    } catch {}
  }
  return null;
}

function parseDate(raw) {
  if (!raw || raw.trim() === '' || raw.trim() === '-' || raw.trim() === 'N/A') return null;
  const clean = raw.replace(/^[Dd]ue\s*:?\s*/, '').trim();
  // Only return if it looks date-like
  if (/\d/.test(clean) || /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow/i.test(clean)) {
    return clean;
  }
  return null;
}

function extractDueFromText(text) {
  const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const patterns = [
    new RegExp(`[Dd]ue\\s*(?:on|by|at)?\\s*:?\\s*(${MONTH}\\s+\\d{1,2}(?:,?\\s*\\d{4})?)`),
    /[Dd]ue\s*(?:on|by|at)?\s*:?\s*(\d{4}-\d{2}-\d{2})/,
    /[Dd]ue\s*(?:on|by|at)?\s*:?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/,
    /[Dd]ue\s*(?:on|by|at)?\s*:?\s*(today|tomorrow)/i,
  ];
  for (const re of patterns) {
    const m = text?.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}
