'use strict';

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
const CLAUDE_API_URL     = 'https://api.anthropic.com/v1/messages';

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scrapeAll') {
    handleScrapeAll(sendResponse);
    return true;
  }
  if (message.action === 'testOllama') {
    testOllamaConnection(message.url, sendResponse);
    return true;
  }
  if (message.action === 'testClaude') {
    testClaudeKey(message.key, message.model, sendResponse);
    return true;
  }
});

// ── URL helpers (hostname-exact matching) ─────────────────────────────────────

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const isClassroom = url => hostname(url) === 'classroom.google.com';
const isOutlook   = url => ['outlook.live.com', 'outlook.office.com', 'outlook.office365.com']
                             .includes(hostname(url));
const isOnCourse  = url => ['oncourse.cc', 'oncourseconnect.com', 'oncourse.iu.edu']
                             .includes(hostname(url));

// ── Main orchestrator ─────────────────────────────────────────────────────────

async function handleScrapeAll(sendResponse) {
  try {
    const settings = await getSettings();

    const allItems = [];
    const sources  = { classroom: false, outlook: false, oncourse: false };
    const warnings = [];
    const missing  = [];

    // Scrape one source: find/open tab, inject function, collect items
    const scrapeSource = async (key, matchFn, scrapeFn, defaultUrl) => {
      let tab = null;
      let created = false;
      try {
        const result = await openOrFindTab(matchFn, defaultUrl);
        tab     = result.tab;
        created = result.created;
        console.log(`[Ondo] ${key}: scraping tab ${tab.id} @ ${tab.url}`);

        const data = await executeScrapeFn(tab.id, scrapeFn);
        console.log(`[Ondo] ${key}: got ${data.length} items`);

        if (data.length > 0) {
          allItems.push(...data);
          sources[key] = true;
        } else {
          // Refresh and retry once — SPA may not have rendered yet
          await chrome.tabs.reload(tab.id);
          await waitForTabLoad(tab.id);
          await new Promise(r => setTimeout(r, 3000));
          const retry = await executeScrapeFn(tab.id, scrapeFn);
          console.log(`[Ondo] ${key}: retry got ${retry.length} items`);
          if (retry.length > 0) {
            allItems.push(...retry);
            sources[key] = true;
          } else {
            const tabUrl = (await chrome.tabs.get(tab.id).catch(() => ({url:'?'}))).url;
            warnings.push(`${key}: 0 items found at ${new URL(tabUrl).pathname}`);
            sources[key] = true;
          }
        }
      } catch (e) {
        if (e.message === 'NO_TAB') {
          missing.push(key);
        } else {
          warnings.push(`${key}: ${e.message}`);
          console.error(`[Ondo] ${key} error:`, e.message);
        }
      } finally {
        if (created && tab) chrome.tabs.remove(tab.id).catch(() => {});
      }
    };

    await Promise.all([
      // Classroom: open to-do page automatically if needed
      scrapeSource('classroom', isClassroom, classroomScrapeFn,
        'https://classroom.google.com/u/0/h'),
      // Outlook / OnCourse: existing tab only (too many URL variants to guess)
      scrapeSource('outlook',  isOutlook,  outlookScrapeFn,  null),
      scrapeSource('oncourse', isOnCourse, onCourseScrapeFn, null),
    ]);

    if (allItems.length === 0) {
      let msg;
      if (missing.length === 3) {
        msg = 'No matching tabs found. Open Outlook or OnCourse in a tab, then scan.';
      } else {
        const detail = warnings.length > 0
          ? '\n\n' + warnings.map(w => '• ' + w).join('\n')
          : '\n\nMake sure you are logged in to each service.';
        msg = 'Nothing was scraped from your open pages.' + detail;
      }
      sendResponse({ success: false, error: msg, missing, sources, warnings });
      return;
    }

    const result = await processWithAI(allItems, settings);

    if (result.parseError && result.items.length === 0) {
      sendResponse({
        success:   false,
        error:     `AI returned unusable output: ${result.parseError}`,
        errorCode: 'AI_PARSE_ERROR',
        rawText:   result.rawText,
        sources,
        warnings,
      });
      return;
    }

    await chrome.storage.local.set({
      lastScan: { todos: result.items, sources, warnings, ts: Date.now() },
    });

    sendResponse({
      success:  true,
      todos:    result.items,
      sources,
      warnings: result.parseError ? [...warnings, `AI: ${result.parseError}`] : warnings,
      rawCount: allItems.length,
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message, errorCode: err.code ?? null });
  }
}

// ── Tab utilities ─────────────────────────────────────────────────────────────

// Wait for a tab to finish loading (resolves even on timeout)
function waitForTabLoad(tabId, timeoutMs = 15_000) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || tab?.status === 'complete') { resolve(); return; }
      const timer = setTimeout(resolve, timeoutMs);
      const listener = (id, info) => {
        if (id !== tabId || info.status !== 'complete') return;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

// Find an existing matching tab, or open a new background tab to defaultUrl.
// Throws {message:'NO_TAB'} if no match and defaultUrl is null.
async function openOrFindTab(matchFn, defaultUrl) {
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(t => t.url && matchFn(t.url));
  if (existing) return { tab: existing, created: false };

  if (!defaultUrl) { throw new Error('NO_TAB'); }

  const tab = await chrome.tabs.create({ url: defaultUrl, active: false });
  await waitForTabLoad(tab.id);
  // Extra pause for SPA rendering (Google Classroom uses heavy React)
  await new Promise(r => setTimeout(r, 4000));

  // Check if tab redirected to a login page
  const loaded = await chrome.tabs.get(tab.id).catch(() => null);
  const finalUrl = loaded?.url || '';
  if (finalUrl.includes('accounts.google.com') || finalUrl.includes('/signin') || finalUrl.includes('/login')) {
    throw new Error(`classroom: redirected to login — please open Classroom in Chrome and sign in first`);
  }

  return { tab, created: true };
}

// Run a self-contained function in a tab's page context and return its result.
async function executeScrapeFn(tabId, fn) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn });
    const result = results?.[0]?.result;
    if (results?.[0]?.error) {
      console.error('[Ondo] executeScript page error:', results[0].error);
    }
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.error('[Ondo] executeScript inject error:', e.message);
    throw new Error(`Script injection failed: ${e.message}`);
  }
}

// ── Self-contained page scrapers ──────────────────────────────────────────────
// These run inside the tab's isolated world via executeScript.
// They MUST be fully self-contained — no closures over outer-scope variables.

function classroomScrapeFn() {
  const items = [];
  const seen  = new Set();

  const add = item => {
    if (!item?.title || String(item.title).trim().length < 2) return;
    const key = item.url && /^https?:\/\//.test(item.url) ? item.url : item.title;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...item, title: String(item.title).trim().slice(0, 150) });
  };

  const extractDue = el => {
    if (!el) return null;
    const timeEl = el.querySelector('time[datetime]');
    if (timeEl) return timeEl.getAttribute('datetime') || timeEl.textContent.trim() || null;
    const text = el.textContent || '';
    const m = text.match(
      /[Dd]ue\s*(?:on|by|at)?\s*:?\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(?:,?\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|today|tomorrow)/i
    );
    return m?.[1]?.trim() || null;
  };

  // Walk up to find a good container element
  const findContainer = anchor => {
    let el = anchor.parentElement;
    for (let i = 0; i < 8; i++) {
      if (!el) break;
      const tag  = el.tagName;
      const role = el.getAttribute?.('role') || '';
      if (tag === 'LI' || tag === 'ARTICLE' || role === 'listitem' || role === 'article') return el;
      el = el.parentElement;
    }
    return anchor.parentElement;
  };

  // Extract the best title text from a container
  const bestTitle = el => {
    if (!el) return null;
    // Headings first
    for (const sel of ['h2','h3','h4','h5','[role="heading"]']) {
      const t = el.querySelector(sel)?.textContent?.trim();
      if (t && t.length >= 2 && t.length <= 200) return t;
    }
    // aria-label on the element itself or a child anchor
    const label = el.getAttribute?.('aria-label') || el.querySelector('a[aria-label]')?.getAttribute('aria-label') || '';
    if (label) {
      const part = label.split('·')[0].trim();
      if (part && part.length >= 2) return part;
    }
    // First meaningful span/div that isn't a date/status string
    for (const node of el.querySelectorAll('span, div')) {
      const t = node.textContent?.trim();
      if (!t || t.length < 4 || t.length > 150 || t.includes('\n')) continue;
      if (/^(due|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/i.test(t) && t.length < 25) continue;
      if (/^(assignment|quiz|missing|turned|submitted)/i.test(t)) continue;
      return t;
    }
    return null;
  };

  // ── Strategy 1: any link whose href looks like a Classroom assignment ─────
  // Patterns: /c/COURSE/a/ASSIGN, /c/COURSE/d/DOC, /c/COURSE/q/QUIZ, /c/COURSE/mc/MATERIAL
  const ASSIGN_RE = /classroom\.google\.com\/(?:u\/\d+\/)?c\/[^/]+\/[adqm][ac]?\/[^/?#]+/;
  document.querySelectorAll('a[href]').forEach(anchor => {
    try {
      const href = anchor.href || '';
      if (!ASSIGN_RE.test(href) || seen.has(href)) return;

      const container = findContainer(anchor);
      const ariaLabel = anchor.getAttribute('aria-label') || '';
      const ariaTitle = ariaLabel.split('·')[0].trim();
      const title = ariaTitle || bestTitle(container) || anchor.textContent?.trim();
      if (!title || title.length < 2) return;

      const dueDate    = extractDue(container);
      const courseEl   = container?.querySelector('[class*="BpkGAb"]');
      const courseName = courseEl?.textContent?.trim() || null;
      add({ title, dueDate, url: href, source: 'classroom', courseName, type: 'assignment' });
    } catch {}
  });

  // ── Strategy 2: [data-assignment-id] elements ─────────────────────────────
  document.querySelectorAll('[data-assignment-id]').forEach(el => {
    try {
      const anchor = el.querySelector('a[href]');
      const url = anchor?.href;
      if (!url || seen.has(url)) return;
      const title = bestTitle(el) || anchor.textContent?.trim();
      if (!title || title.length < 2) return;
      add({ title, dueDate: extractDue(el), url, source: 'classroom', type: 'assignment' });
    } catch {}
  });

  // ── Strategy 3: aria-label scan on list items ─────────────────────────────
  document.querySelectorAll('li[aria-label], [role="listitem"][aria-label]').forEach(el => {
    try {
      const label = el.getAttribute('aria-label') || '';
      if (label.length < 4) return;
      const anchor = el.querySelector('a[href]');
      const href   = anchor?.href || '';
      if (seen.has(href || label)) return;
      // Classroom aria-labels: "Assignment title · Course · Due date"
      const parts   = label.split('·').map(p => p.trim());
      const title   = parts[0];
      if (!title || title.length < 2) return;
      const dueRaw  = parts.find(p => /due/i.test(p));
      const dueDate = dueRaw ? dueRaw.replace(/due\s*/i, '').trim() : null;
      add({ title: title.slice(0, 150), dueDate, url: href || window.location.href, source: 'classroom', type: 'assignment' });
    } catch {}
  });

  // ── Strategy 4: broad fallback — any classroom.google.com sub-link ────────
  if (items.length === 0) {
    document.querySelectorAll('a[href*="classroom.google.com"]').forEach(anchor => {
      try {
        const href = anchor.href || '';
        // Skip nav/settings links
        if (/\/(settings|notifications|profile|calendar|archive|u\/\d+\/?$)/.test(href)) return;
        if (seen.has(href)) return;
        const container = findContainer(anchor);
        const title = bestTitle(container) || anchor.textContent?.trim() || anchor.getAttribute('aria-label')?.split('·')[0]?.trim();
        if (!title || title.length < 2) return;
        add({ title, dueDate: extractDue(container), url: href, source: 'classroom', type: 'assignment' });
      } catch {}
    });
  }

  console.log('[Ondo/classroom] found', items.length, 'items on', window.location.href);
  return items;
}

function outlookScrapeFn() {
  const items = [];
  const seenUrls   = new Set();
  const seenTitles = new Set();

  const SCHOOL_KW = [
    'assignment','homework','due','submit','submission','deadline',
    'exam','quiz','test','midterm','final','grade','graded','grades',
    'course','class','lecture','syllabus','teacher','professor',
    'instructor','school','college','university','semester','quarter',
    'canvas','classroom','oncourse','blackboard','moodle','lms',
    'missing work','late work','extra credit','office hours',
    'study','project','essay','report','presentation','lab',
  ];
  const isSchool = text => { const l = text.toLowerCase(); return SCHOOL_KW.some(k => l.includes(k)); };

  const buildUrl = convId => {
    const h = window.location.hostname;
    if (!convId) return window.location.href;
    if (h === 'outlook.live.com') return `https://outlook.live.com/mail/inbox/id/${encodeURIComponent(convId)}`;
    return `${window.location.origin}/mail/inbox/id/${encodeURIComponent(convId)}`;
  };

  const add = item => {
    if (!item?.title || item.title.length < 2) return;
    const urlKey = item.url && item.url !== window.location.href ? item.url : null;
    if (urlKey && seenUrls.has(urlKey)) return;
    if (!urlKey && seenTitles.has(item.title)) return;
    if (urlKey) seenUrls.add(urlKey);
    else seenTitles.add(item.title);
    items.push(item);
  };

  // ── Strategy 1: [role="option"] / [role="listitem"] rows ─────────────────
  document.querySelectorAll('[role="option"][aria-label],[role="listitem"][aria-label]').forEach(row => {
    try {
      const ariaLabel = row.getAttribute('aria-label') || '';
      const convId    = row.getAttribute('data-convid') || row.getAttribute('data-itemid') || '';
      const subjectEl = row.querySelector('[data-testid="subject"],span[title],[role="heading"],.lUbBFc,.Cp0tib');
      const subject   = subjectEl?.textContent.trim() || ariaLabel.split(';')[0]?.trim() || '';
      if (!subject || subject.length < 3) return;
      const sender    = row.querySelector('[data-testid="sender-name"],.afn,.EO4Vs')?.textContent.trim() || '';
      const snippet   = row.querySelector('[data-testid="email-preview"],.bodypreview')?.textContent.trim() || '';
      if (!isSchool(`${subject} ${sender} ${snippet}`)) return;
      const dateEl    = row.querySelector('[data-testid="received-time"],time');
      const date      = dateEl?.getAttribute('datetime') || dateEl?.textContent.trim() || '';
      add({ title: subject, sender, date, snippet: snippet.slice(0,150), url: buildUrl(convId), source: 'outlook', type: 'email' });
    } catch {}
  });

  // ── Strategy 2: [data-convid] rows (older OWA) ───────────────────────────
  document.querySelectorAll('[data-convid],[data-itemid]').forEach(row => {
    try {
      const convId    = row.getAttribute('data-convid') || row.getAttribute('data-itemid') || '';
      const subjectEl = row.querySelector('.I9SgZ,.lG0AC,.dEAXp,td[class*="subject"]');
      const subject   = subjectEl?.textContent.trim() || '';
      if (!subject || subject.length < 3) return;
      const sender    = row.querySelector('.iGSJe,.o6oGW,td[class*="from"]')?.textContent.trim() || '';
      if (!isSchool(`${subject} ${sender}`)) return;
      const date      = row.querySelector('time,td[class*="date"],.tA')?.textContent.trim() || '';
      add({ title: subject, sender, date, url: buildUrl(convId), source: 'outlook', type: 'email' });
    } catch {}
  });

  // ── Strategy 3: open reading pane ────────────────────────────────────────
  try {
    const pane = document.querySelector('[data-testid="reading-pane"],[aria-label*="reading"],.readingPane,[class*="ReadingPane"]');
    if (pane) {
      const subjectEl = pane.querySelector('h1,[data-testid="message-subject"],[role="heading"],.aqY,.hq');
      const subject   = subjectEl?.textContent.trim() || '';
      if (subject.length >= 3 && isSchool(`${subject} ${pane.textContent}`)) {
        add({ title: subject, url: window.location.href, source: 'outlook', type: 'email_open' });
      }
    }
  } catch {}

  return items;
}

function onCourseScrapeFn() {
  const items = [];
  const seen  = new Set();

  const DONE_KW = ['submitted','turned in','complete','completed','passed','graded',
    'returned','scored','closed','excused','accepted','collected'];
  const isDone = text => { const l=(text||'').toLowerCase(); return DONE_KW.some(k=>l.includes(k)); };

  const add = item => {
    if (!item?.title || String(item.title).trim().length < 2) return;
    const key = item.url && /^https?:\/\//.test(item.url) ? item.url : item.title;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...item, title: String(item.title).trim().slice(0, 150) });
  };

  const parseDate = raw => {
    if (!raw) return null;
    const c = raw.replace(/^[Dd]ue\s*:?\s*/,'').trim();
    return (/\d/.test(c) || /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|today|tomorrow/i.test(c)) ? c : null;
  };

  const duePat = text => {
    const m = (text||'').match(/[Dd]ue\s*(?:on|by|at)?\s*:?\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\.?\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})/);
    return m?.[1]?.trim() || null;
  };

  // ── 1. Assignment tables ──────────────────────────────────────────────────
  document.querySelectorAll('table').forEach(table => {
    try {
      const headers = Array.from(table.querySelectorAll('th,thead td'))
        .map(th => th.textContent.trim().toLowerCase());
      const hasAssign = headers.some(h => /assignment|task|name|title|item/i.test(h));
      const hasDue    = headers.some(h => /due|date/i.test(h));
      if (!hasAssign && !hasDue) return;

      const nameIdx   = headers.findIndex(h => /assignment|task|name|title/i.test(h));
      const dueIdx    = headers.findIndex(h => /due|date/i.test(h));
      const statusIdx = headers.findIndex(h => /status|submitted|complete|grade/i.test(h));

      table.querySelectorAll('tbody tr,tr:not(:first-child)').forEach(row => {
        try {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 2) return;
          const nameCell   = cells[nameIdx >= 0 ? nameIdx : 0];
          const dueCell    = cells[dueIdx  >= 0 ? dueIdx  : 1];
          const statusCell = statusIdx >= 0 ? cells[statusIdx] : null;
          if (isDone(statusCell?.textContent)) return;
          const anchor = nameCell?.querySelector('a');
          const title  = anchor?.textContent?.trim() || nameCell?.textContent?.trim();
          if (!title || title.length < 2) return;
          add({ title, dueDate: parseDate(dueCell?.textContent?.trim()), url: anchor?.href || window.location.href, source: 'oncourse', type: 'assignment' });
        } catch {}
      });
    } catch {}
  });

  // ── 2. Sakai portlet / card selectors ────────────────────────────────────
  ['.portletBody li','.assignmentItem','[class*="assignment-item"]','.itemSummary','#assignmentList li',
   '.todo-item','.assignment-card','.task-card','[data-assignment]','li.assignment'].forEach(sel => {
    try {
      document.querySelectorAll(sel).forEach(el => {
        try {
          if (isDone(el.querySelector('[class*="status"],.state')?.textContent)) return;
          const anchor = el.querySelector('a');
          const url    = anchor?.href || window.location.href;
          if (seen.has(url)) return;
          const title  = anchor?.textContent?.trim() || el.querySelector('h3,h4,.title')?.textContent?.trim();
          if (!title || title.length < 2) return;
          add({ title, dueDate: duePat(el.textContent), url, source: 'oncourse', type: 'assignment' });
        } catch {}
      });
    } catch {}
  });

  // ── 3. Generic assignment/class links (last resort) ───────────────────────
  if (items.length === 0) {
    document.querySelectorAll('a[href*="assignment"],a[href*="quiz"],a[href*="task"]').forEach(a => {
      try {
        const title = a.textContent?.trim();
        if (!title || title.length < 2 || seen.has(a.href)) return;
        add({ title, dueDate: null, url: a.href, source: 'oncourse', type: 'assignment' });
      } catch {}
    });
  }

  return items;
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get({
      provider:     'ollama',
      ollamaUrl:    OLLAMA_DEFAULT_URL,
      ollamaModel:  'qwen3:4b',
      claudeApiKey: '',
      claudeModel:  'claude-haiku-4-5-20251001',
    }, resolve);
  });
}

// ── Data normalisation (run before building prompt) ───────────────────────────

const SOURCE_MAP = { classroom: 'Classroom', outlook: 'Outlook', oncourse: 'OnCourse' };

function normalizeItems(rawItems) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return rawItems
    .filter(item => item?.title && String(item.title).trim().length > 1)
    .slice(0, 80) // cap to avoid token overflow
    .map(item => {
      const source = SOURCE_MAP[(item.source || '').toLowerCase()] ?? 'Classroom';

      // Only keep https?:// URLs — discard window.location.href fallbacks
      const url = typeof item.url === 'string' && /^https?:\/\//.test(item.url)
        ? item.url : null;

      // Pre-compute days-until-due so the AI doesn't have to do date arithmetic
      const daysFromNow = computeDaysFromNow(item.dueDate, today);

      const out = {
        title: String(item.title).trim().slice(0, 150),
        source,
        ...(url          ? { url }                                    : {}),
        ...(item.dueDate ? { dueDate: String(item.dueDate).slice(0, 60) } : {}),
        ...(daysFromNow !== null ? { daysFromNow }                    : {}),
        // Optional context hints (compressed)
        ...(item.courseName ? { course: String(item.courseName).slice(0, 40) } : {}),
        ...(item.snippet    ? { hint:   String(item.snippet).slice(0, 80)    } : {}),
      };
      return out;
    });
}

function computeDaysFromNow(rawDate, today) {
  if (!rawDate) return null;
  const s = String(rawDate).trim();
  if (!s) return null;

  const base = today || (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();

  if (/^today$/i.test(s))    return 0;
  if (/^tomorrow$/i.test(s)) return 1;
  if (/overdue|missing|late/i.test(s)) return -1;

  // Named day of week → next occurrence
  const DOW_RE = /^(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?)/i;
  const DOW    = ['sun','mon','tue','wed','thu','fri','sat'];
  const dowM   = s.match(DOW_RE);
  if (dowM) {
    const target = DOW.findIndex(d => dowM[1].toLowerCase().startsWith(d));
    if (target >= 0) {
      const diff = ((target - base.getDay()) + 7) % 7;
      return diff === 0 ? 7 : diff;
    }
  }

  // Direct Date parse (handles ISO, RFC, "Mar 15 2024", etc.)
  const direct = new Date(s);
  if (!isNaN(direct.getTime())) {
    direct.setHours(0, 0, 0, 0);
    return Math.floor((direct - base) / 86_400_000);
  }

  // "Mar 15" with no year → assume current year, roll to next year if past
  const withYear = new Date(`${s} ${base.getFullYear()}`);
  if (!isNaN(withYear.getTime())) {
    withYear.setHours(0, 0, 0, 0);
    const diff = Math.floor((withYear - base) / 86_400_000);
    if (diff < -180) {
      const nextYear = new Date(`${s} ${base.getFullYear() + 1}`);
      if (!isNaN(nextYear.getTime())) {
        nextYear.setHours(0, 0, 0, 0);
        return Math.floor((nextYear - base) / 86_400_000);
      }
    }
    return diff;
  }

  return null;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(rawItems) {
  const todayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const items = normalizeItems(rawItems);

  // System message: short, authoritative, disables qwen3 thinking via /no_think
  const system =
    'You are a JSON extraction tool. Output ONLY a JSON array with no prose, no markdown, ' +
    'no explanation. The first character of your response must be [ and the last must be ]. /no_think';

  // User message: schema + rules + compact data
  const user =
`Today: ${todayStr}

Convert the school task data below into a JSON array. Each element must be:
{"title":string,"source":"Classroom"|"Outlook"|"OnCourse","dueDate":string|null,"url":string,"priority":"high"|"medium"|"low","notes":string}

Priority rules — use the daysFromNow field if present:
  "high"   → daysFromNow < 0 (overdue) OR daysFromNow 0/1/2, OR title contains "missing"/"overdue"
  "medium" → daysFromNow 3-7
  "low"    → daysFromNow > 7 OR no due date and no urgency signal

Extra rules:
- Skip items already submitted / complete / graded / returned
- For Outlook items, skip non-school emails; extract deadlines from email subject/hint
- Deduplicate by title; prefer items with a specific URL over generic ones
- url must start with http — use "#" only if no URL exists
- Output NOTHING outside the JSON array

DATA:
${JSON.stringify(items)}`;

  return { system, user };
}

// ── AI dispatch ───────────────────────────────────────────────────────────────

async function processWithAI(items, settings) {
  const prompt = buildPrompt(items);
  if (settings.provider === 'claude') return callClaude(prompt, settings);
  return callOllama(prompt, settings);
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function callOllama(prompt, settings) {
  const base  = (settings.ollamaUrl || OLLAMA_DEFAULT_URL).replace(/\/$/, '');
  const model = (settings.ollamaModel || 'qwen3:4b').trim();

  const isQwen3  = /^qwen3/i.test(model);
  const isGptOss = /^gpt-oss/i.test(model);

  // ── Request body ───────────────────────────────────────────────────────────
  const body = {
    model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user',   content: prompt.user   },
    ],
    // format: "json" constrains Ollama to emit valid JSON.
    // IMPORTANT: must NOT be combined with think:true (Ollama bug #10929).
    format: 'json',
    stream: false,
    options: {
      temperature: 0,     // deterministic — better for structured output
      num_ctx:     8192,  // enough context for the full prompt + response
      num_predict: 4096,  // max tokens for the response
    },
  };

  // ── Model-specific thinking flags ──────────────────────────────────────────
  // MUST be top-level, NOT inside options (Ollama bug #14793 — silently ignored there)
  if (isQwen3)  body.think = false;   // boolean — disables CoT for Qwen3
  if (isGptOss) body.think = 'low';   // string  — gpt-oss uses "low"/"medium"/"high"

  let res;
  try {
    res = await fetch(`${base}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    throw ollamaError('OLLAMA_UNREACHABLE',
      `Cannot reach Ollama at ${base}. Is Ollama running?`);
  }

  if (res.status === 403) {
    throw ollamaError('OLLAMA_CORS',
      'Ollama blocked the request (403 Forbidden). ' +
      "The extension's origin is not in Ollama's allowed list.");
  }
  if (!res.ok) {
    const body2 = await res.json().catch(() => ({}));
    throw new Error(`Ollama ${res.status}: ${body2.error || res.statusText}`);
  }

  const data = await res.json();
  const text = data.message?.content ?? data.response ?? '';
  return parseAndValidateAI(text, model);
}

async function testOllamaConnection(url, sendResponse) {
  try {
    const base = (url || OLLAMA_DEFAULT_URL).replace(/\/$/, '');
    const res  = await fetch(`${base}/api/tags`);

    if (res.status === 403) {
      sendResponse({ success: false, errorCode: 'OLLAMA_CORS',
        error: 'Ollama returned 403 — the extension origin is blocked.' });
      return;
    }
    if (res.ok) {
      const data   = await res.json();
      const models = (data.models || []).map(m => ({
        name:   m.name,
        size:   m.size,
        params: m.details?.parameter_size  ?? null,
        quant:  m.details?.quantization_level ?? null,
        family: m.details?.family          ?? null,
      }));
      sendResponse({ success: true, models });
    } else {
      sendResponse({ success: false, error: `HTTP ${res.status}` });
    }
  } catch (e) {
    sendResponse({ success: false, errorCode: 'OLLAMA_UNREACHABLE', error: e.message });
  }
}

function ollamaError(code, message) {
  const e = new Error(message);
  e.code  = code;
  return e;
}

// ── Claude ────────────────────────────────────────────────────────────────────

async function callClaude(prompt, settings) {
  if (!settings.claudeApiKey) {
    throw new Error('Claude API key not set. Open Options → add your key.');
  }

  const res = await fetch(CLAUDE_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         settings.claudeApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      settings.claudeModel || 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system:     prompt.system,
      messages:   [{ role: 'user', content: prompt.user }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Claude ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';
  return parseAndValidateAI(text, 'claude');
}

async function testClaudeKey(key, model, sendResponse) {
  try {
    const res = await fetch(CLAUDE_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      model || 'claude-haiku-4-5-20251001',
        max_tokens: 32,
        messages:   [{ role: 'user', content: 'Reply with the single word: ok' }],
      }),
    });
    sendResponse({ success: res.ok, error: res.ok ? null : `HTTP ${res.status}` });
  } catch (e) {
    sendResponse({ success: false, error: e.message });
  }
}

// ── AI response parser ────────────────────────────────────────────────────────
// Returns { items: TodoItem[], parseError: string|null, rawText: string }

const VALID_SOURCES  = new Set(['Classroom', 'Outlook', 'OnCourse']);
const VALID_PRIORITY = new Set(['high', 'medium', 'low']);

function parseAndValidateAI(text, modelHint = '') {
  const rawText = text;

  if (!text || text.trim() === '') {
    const tip = /qwen3/i.test(modelHint)
      ? ' Qwen3 may have used all tokens for thinking. Ensure Ollama ≥v0.9 and think:false is supported.'
      : '';
    return { items: [], parseError: `AI returned empty output.${tip}`, rawText };
  }

  let s = text.trim();

  // 1. Strip <think>...</think> blocks (qwen3 CoT leakage, even with think:false on older Ollama)
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Also strip unclosed opening tag and everything after it
  s = s.replace(/<think>[\s\S]*/gi, '').trim();

  // 2. Strip markdown code fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  // 3. Try JSON array directly
  const arrStart = s.indexOf('[');
  const arrEnd   = s.lastIndexOf(']');

  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    const slice = s.slice(arrStart, arrEnd + 1);
    try {
      const parsed = JSON.parse(slice);
      if (Array.isArray(parsed)) {
        return { items: sanitizeItems(parsed), parseError: null, rawText };
      }
    } catch (e) {
      // fall through to object fallback
    }
  }

  // 4. Fallback: maybe AI wrapped array in an object { items: [...] }
  const objStart = s.indexOf('{');
  const objEnd   = s.lastIndexOf('}');
  if (objStart !== -1 && objEnd !== -1) {
    try {
      const obj = JSON.parse(s.slice(objStart, objEnd + 1));
      const arr = obj.items ?? obj.tasks ?? obj.todos ?? obj.assignments ?? obj.data ?? null;
      if (Array.isArray(arr)) {
        return { items: sanitizeItems(arr), parseError: null, rawText };
      }
    } catch {}
  }

  const preview = s.slice(0, 200).replace(/\n/g, ' ');
  return {
    items:      [],
    parseError: `Could not extract a JSON array from the AI response. Preview: "${preview}"`,
    rawText,
  };
}

function sanitizeItems(arr) {
  return arr.reduce((acc, item) => {
    if (!item || typeof item !== 'object') return acc;

    const title = String(item.title ?? '').trim().slice(0, 200);
    if (!title) return acc;

    const url = typeof item.url === 'string' && /^https?:\/\//.test(item.url)
      ? item.url : '#';

    acc.push({
      title,
      source:   VALID_SOURCES.has(item.source)   ? item.source   : guessSource(item),
      dueDate:  item.dueDate ? String(item.dueDate).trim().slice(0, 60) : null,
      url,
      priority: VALID_PRIORITY.has(item.priority) ? item.priority : 'low',
      notes:    String(item.notes ?? '').trim().slice(0, 300),
    });
    return acc;
  }, []);
}

function guessSource(item) {
  const u = (item.url || '').toLowerCase();
  if (u.includes('classroom.google')) return 'Classroom';
  if (u.includes('outlook') || u.includes('office.com')) return 'Outlook';
  if (u.includes('oncourse'))  return 'OnCourse';
  return 'Classroom';
}
