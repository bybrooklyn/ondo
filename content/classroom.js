'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scrape') {
    try {
      sendResponse(scrapeClassroom());
    } catch (e) {
      console.error('[Ondo/classroom] scrape threw:', e);
      sendResponse([]);
    }
    return true;
  }
});

// ── Main ──────────────────────────────────────────────────────────────────────

function scrapeClassroom() {
  const items = [];
  const seen  = new Set();

  const add = item => {
    if (!item?.title) return;
    const key = item.url || item.title;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  // ── 1. Structured assignment cards (home to-do list) ─────────────────────
  document.querySelectorAll(
    'li[data-assignment-id], .hP9SIc li, [jscontroller] li[class], .HFNIWe'
  ).forEach(el => { try { add(extractCard(el)); } catch {} });

  // ── 2. Assignment links with /c/.../a/ shape ──────────────────────────────
  document.querySelectorAll('a[href*="/c/"][href*="/a/"]').forEach(anchor => {
    try {
      const url = anchor.href;
      if (seen.has(url)) return;
      const container = anchor.closest('li, article, [data-assignment-id], .hP9SIc > div');
      const title = getText(anchor, ['.WAJEZb', '.YVvGBb']) || anchor.textContent.trim();
      if (!title || title.length < 3) return;
      add({
        title,
        dueDate:    container ? extractDue(container) : null,
        url,
        source:     'classroom',
        courseName: container ? getText(container, ['.BpkGAb', '.kcCFCc', '.e0wFEe']) : null,
        type:       'assignment',
      });
    } catch {}
  });

  // ── 3. Classwork / material cards ────────────────────────────────────────
  document.querySelectorAll(
    '[data-assignment-id], .z3vRcc-MZArnb-LgbsSe, .aJKiyf'
  ).forEach(el => {
    try {
      const anchor = el.querySelector('a[href*="/c/"]') || el.querySelector('a');
      if (!anchor) return;
      const url = anchor.href;
      if (!url || seen.has(url)) return;
      const title = getText(el, ['.WAJEZb', '.YVvGBb', 'h2', 'h3', '.Zy1Fsf'])
                 || anchor.textContent.trim();
      if (!title || title.length < 3) return;
      add({ title, dueDate: extractDue(el), url, source: 'classroom', type: 'assignment' });
    } catch {}
  });

  // ── 4. Missing / not-turned-in work ──────────────────────────────────────
  document.querySelectorAll('[data-state="not-turned-in"] a, .Iy a').forEach(anchor => {
    try {
      const url = anchor.href;
      if (!url || seen.has(url)) return;
      const title = anchor.textContent.trim()
                 || getText(anchor.closest('li, div'), ['.WAJEZb']);
      if (!title || title.length < 3) return;
      add({ title, dueDate: extractDue(anchor.closest('li, div')), url, source: 'classroom', type: 'missing' });
    } catch {}
  });

  return items;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractCard(el) {
  const anchor = el.querySelector('a') || el.closest('a');
  const url    = anchor?.href || window.location.href;
  const title  = getText(el, ['.WAJEZb', '.YVvGBb', '.Zy1Fsf', 'h2', 'h3'])
              || anchor?.textContent.trim();
  if (!title || title.length < 2) return null;
  return {
    title,
    dueDate:    extractDue(el),
    url,
    source:     'classroom',
    courseName: getText(el, ['.BpkGAb', '.kcCFCc', '.e0wFEe']),
    type:       'assignment',
  };
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

function extractDue(el) {
  if (!el) return null;

  // 1. Dedicated element
  const dueEl = el.querySelector?.('.XoqCub, .pMBwqb, [data-due-date], time[datetime]');
  if (dueEl) return dueEl.getAttribute('datetime') || dueEl.textContent.trim() || null;

  // 2. Regex over inner text — more patterns including "due on/by", ISO, time
  const text = el.textContent || '';
  const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
  const patterns = [
    // "Due Jan 15, 2024" / "Due: January 15"
    new RegExp(`[Dd]ue\\s*(?:on|by|at)?\\s*:?\\s*(${MONTH}\\s+\\d{1,2}(?:,?\\s*\\d{4})?)`),
    // ISO 8601 after "due"
    /[Dd]ue\s*(?:on|by|at)?\s*:?\s*(\d{4}-\d{2}-\d{2})/,
    // Slash format: 1/15 or 1/15/2024
    /[Dd]ue\s*(?:on|by|at)?\s*:?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/,
    // Relative: today, tomorrow
    /[Dd]ue\s*(?:on|by|at)?\s*:?\s*(today|tomorrow)/i,
    // Named day
    /[Dd]ue\s*(?:on|by|at)?\s*:?\s*(Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}
