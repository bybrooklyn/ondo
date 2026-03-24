'use strict';

const OLLAMA_DEFAULT_URL = 'http://localhost:11434';
const CLAUDE_API_URL     = 'https://api.anthropic.com/v1/messages';

// ── Badge ─────────────────────────────────────────────────────────────────────

function updateBadge(todos) {
  if (!Array.isArray(todos) || todos.length === 0) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  // Count tasks that need attention: high priority OR due within 7 days
  const urgent = todos.filter(t =>
    t.priority === 'high' ||
    (t.priority === 'medium' && typeof t.daysFromNow === 'number' && t.daysFromNow <= 7)
  ).length;

  if (urgent === 0) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: '#f26c6c' }); // --red
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
  chrome.action.setBadgeText({ text: urgent > 99 ? '99+' : String(urgent) });
}

// Restore badge on service worker startup (badge is lost on restart)
chrome.storage.local.get('lastScan', ({ lastScan }) => {
  if (lastScan?.todos) updateBadge(lastScan.todos);
});

// ── Scan state ─────────────────────────────────────────────────────────────────
// Tracked so a re-opened popup can pick up an in-progress scan
let scanInProgress = false;

// ── Auto-scan (alarms) ─────────────────────────────────────────────────────────

const ALARM_NAME = 'ondo-autoscan';

// Called on extension install and whenever auto-scan settings change
async function scheduleAutoScan() {
  await chrome.alarms.clear(ALARM_NAME);
  const settings = await getSettings();
  if (!settings.autoScanInterval || settings.autoScanInterval === 'off') return;
  const minutes = parseInt(settings.autoScanInterval, 10);
  if (!minutes || minutes < 1) return;
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  console.log(`[Ondo] Auto-scan scheduled every ${minutes} min`);
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;
  const settings = await getSettings();
  // Don't run if already scanning or no provider configured
  if (scanInProgress) return;
  if (settings.provider === 'ollama'  && !settings.ollamaModel) return;
  if (settings.provider === 'claude'  && !settings.claudeApiKey) return;
  if (settings.provider === 'openai'  && !settings.openaiApiKey) return;

  console.log('[Ondo] Auto-scan triggered');

  // Run silently — no popup interaction
  handleScrapeAll(result => {
    if (!result?.success || !result.todos) return;
    if (settings.notifications) maybeNotify(result.todos, settings);
  });
});

// On install/update, schedule auto-scan if configured
chrome.runtime.onInstalled.addListener(() => scheduleAutoScan());

// ── Notifications ──────────────────────────────────────────────────────────────

async function maybeNotify(newTodos, settings) {
  if (!settings.notifications) return;
  if (!Array.isArray(newTodos) || newTodos.length === 0) return;

  // Load previous scan to diff against
  const { lastNotified } = await chrome.storage.local.get('lastNotified');
  const prevIds = new Set(lastNotified?.ids || []);

  // Find newly urgent tasks (high priority + not seen before)
  const urgent = newTodos.filter(t =>
    t.priority === 'high' && !prevIds.has(taskId(t))
  );

  // Persist current high-priority IDs so we don't re-notify
  await chrome.storage.local.set({
    lastNotified: { ids: newTodos.filter(t => t.priority === 'high').map(taskId), ts: Date.now() },
  });

  if (urgent.length === 0) return;

  const title = urgent.length === 1
    ? `Due soon: ${urgent[0].title}`
    : `${urgent.length} urgent tasks due soon`;

  const body = urgent.length === 1
    ? [urgent[0].dueDate ? `Due: ${urgent[0].dueDate}` : '', urgent[0].source].filter(Boolean).join(' · ')
    : urgent.slice(0, 3).map(t => `• ${t.title}`).join('\n');

  chrome.notifications.create(`ondo-${Date.now()}`, {
    type:    'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: body || 'Open Ondo to review.',
    buttons: [{ title: 'Open Ondo' }],
  });
}

// Clicking the notification or its button opens the popup
chrome.notifications.onButtonClicked.addListener((notifId) => {
  if (!notifId.startsWith('ondo-')) return;
  chrome.action.openPopup?.().catch(() => {});
  chrome.notifications.clear(notifId);
});
chrome.notifications.onClicked.addListener(notifId => {
  if (!notifId.startsWith('ondo-')) return;
  chrome.action.openPopup?.().catch(() => {});
  chrome.notifications.clear(notifId);
});

function taskId(t) {
  return `${t.source}::${t.title}::${t.dueDate ?? ''}`;
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from this extension's own pages (popup, options)
  if (sender.id !== chrome.runtime.id) return;

  if (message.action === 'scrapeAll') {
    handleScrapeAll(sendResponse);
    return true;
  }
  if (message.action === 'getScanState') {
    sendResponse({ inProgress: scanInProgress });
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
  if (message.action === 'testOpenAI') {
    testOpenAIKey(message.key, message.model, message.baseUrl, sendResponse);
    return true;
  }
  if (message.action === 'clearBadge') {
    chrome.action.setBadgeText({ text: '' });
    sendResponse({ success: true });
    return true;
  }
  if (message.action === 'rescheduleAutoScan') {
    scheduleAutoScan().then(() => sendResponse({ success: true }));
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

const SCAN_TIMEOUT_MS = 240_000; // 4 minutes — Chrome SW max is ~5 min; Ollama on CPU can be slow

async function handleScrapeAll(sendResponse) {
  // Guard: only one scan at a time
  if (scanInProgress) {
    sendResponse({ success: false, error: 'A scan is already in progress.', errorCode: 'SCAN_IN_PROGRESS' });
    return;
  }

  // Wrap sendResponse so we can never call it twice (timeout + normal path)
  let responded = false;
  const timeoutId = setTimeout(() => {
    respond({
      success:   false,
      error:     'Scan timed out after 4 minutes.\n\n• If using Ollama: the model may be slow on CPU — try qwen3:4b if you haven\'t already\n• Try reloading your school pages before scanning\n• Check that Ollama is running: ollama serve',
      errorCode: 'SCAN_TIMEOUT',
    });
  }, SCAN_TIMEOUT_MS);

  const respond = data => {
    if (responded) return;
    responded = true;
    clearTimeout(timeoutId);
    scanInProgress = false;
    sendResponse(data);
  };

  scanInProgress = true;

  try {
    const settings = await getSettings();

    // Per-source item buckets (not a flat array — enables per-source caps and filtering)
    const scraped  = { classroom: [], outlook: [], oncourse: [] };
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

        // For existing tabs: check if they're on a login page before trying to inject
        if (!created) {
          const currentUrl = (await chrome.tabs.get(tab.id).catch(() => ({ url: '' }))).url || '';
          if (/accounts\.google\.com|\/signin|\/login/i.test(currentUrl)) {
            warnings.push(`${key}: tab is on a login page — please sign in to ${key} and scan again`);
            sources[key] = true;
            return;
          }
        }

        console.log(`[Ondo] ${key}: scraping tab ${tab.id} @ ${tab.url}`);

        let data;
        try {
          data = await executeScrapeFn(tab.id, scrapeFn);
        } catch (injectErr) {
          // "Cannot access contents of the page" means the tab was open before
          // the extension was installed/reloaded — Chrome needs a tab reload to
          // apply host permissions retroactively.
          if (!created && /cannot access|permission/i.test(injectErr.message)) {
            console.log(`[Ondo] ${key}: reloading pre-existing tab to apply permissions…`);
            await chrome.tabs.reload(tab.id);
            await waitForTabLoad(tab.id);
            await new Promise(r => setTimeout(r, 2000));
            data = await executeScrapeFn(tab.id, scrapeFn); // throws if still fails
          } else {
            throw injectErr;
          }
        }
        console.log(`[Ondo] ${key}: got ${data.length} items`);

        if (data.length > 0) {
          scraped[key].push(...data);
          sources[key] = true;
        } else if (created) {
          // Tab was opened by us — safe to reload and retry once for SPA render lag
          await chrome.tabs.reload(tab.id);
          await waitForTabLoad(tab.id);
          await new Promise(r => setTimeout(r, 3000));
          const retry = await executeScrapeFn(tab.id, scrapeFn);
          console.log(`[Ondo] ${key}: retry got ${retry.length} items`);
          if (retry.length > 0) {
            scraped[key].push(...retry);
            sources[key] = true;
          } else {
            const tabUrl = (await chrome.tabs.get(tab.id).catch(() => ({ url: '' }))).url;
            const path = (() => { try { return new URL(tabUrl).pathname; } catch { return tabUrl || key; } })();
            warnings.push(`${key}: 0 items found at ${path} — are you logged in?`);
            sources[key] = true;
          }
        } else {
          // User's existing tab — never reload it; just report empty
          const tabUrl = (await chrome.tabs.get(tab.id).catch(() => ({ url: '' }))).url;
          const path = (() => { try { return new URL(tabUrl).pathname; } catch { return tabUrl || key; } })();
          warnings.push(`${key}: 0 items on ${path} — try navigating to the assignments/inbox page`);
          sources[key] = true;
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

    // ── Post-scrape processing ─────────────────────────────────────────────

    // Apply configurable Outlook cap (scraper already sorted by relevance score)
    const outlookCap = settings.outlookCap || 15;
    if (scraped.outlook.length > outlookCap) {
      console.log(`[Ondo] Capping Outlook from ${scraped.outlook.length} to ${outlookCap}`);
      scraped.outlook = scraped.outlook.slice(0, outlookCap);
    }

    // Smart Filter: AI pre-filter for Outlook + OnCourse (skip Classroom — already structured)
    if (settings.smartFilter && (scraped.outlook.length > 0 || scraped.oncourse.length > 0)) {
      try {
        console.log('[Ondo] Running smart filter…');
        const filtered = await runSmartFilter(scraped, settings);
        if (Array.isArray(filtered.outlook))  scraped.outlook  = filtered.outlook;
        if (Array.isArray(filtered.oncourse)) scraped.oncourse = filtered.oncourse;
        console.log(`[Ondo] Smart filter: outlook ${scraped.outlook.length}, oncourse ${scraped.oncourse.length}`);
      } catch (e) {
        console.warn('[Ondo] Smart filter failed:', e.message);
        warnings.push(`Smart filter error: ${e.message} — using unfiltered data`);
      }
    }

    // Merge: Classroom first (highest signal), OnCourse second, Outlook last
    const allItems = [...scraped.classroom, ...scraped.oncourse, ...scraped.outlook];

    if (allItems.length === 0) {
      let msg;
      // Classroom auto-opens so it never ends up in `missing`; only outlook/oncourse can
      if (missing.includes('outlook') && missing.includes('oncourse') && !warnings.length) {
        msg = 'No Outlook or OnCourse tab found. Open one in Chrome, then scan.';
      } else {
        const detail = warnings.length > 0
          ? '\n\n' + warnings.map(w => '• ' + w).join('\n')
          : '\n\nMake sure you are logged in and on the assignments/inbox page.';
        msg = 'Nothing was scraped from your open pages.' + detail;
      }
      respond({ success: false, error: msg, missing, sources, warnings });
      return;
    }

    const result = await processWithAI(allItems, settings);

    if (result.parseError && result.items.length === 0) {
      respond({
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
      lastScan: { todos: result.items, sources, warnings, ts: Date.now(), model: activeModel(settings) },
    });
    updateBadge(result.items);

    respond({
      success:  true,
      todos:    result.items,
      sources,
      warnings: result.parseError ? [...warnings, `AI: ${result.parseError}`] : warnings,
      rawCount: allItems.length,
      model:    activeModel(settings),
      provider: settings.provider,
    });
  } catch (err) {
    respond({ success: false, error: err.message, errorCode: err.code ?? null });
  }
}

// ── Tab utilities ─────────────────────────────────────────────────────────────

// Wait for a tab to finish loading (resolves even on timeout)
function waitForTabLoad(tabId, timeoutMs = 25_000) {
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
    throw new Error(`redirected to a login page — please open the site in Chrome and sign in first`);
  }

  return { tab, created: true };
}

// Run a self-contained function in a tab's page context and return its result.
async function executeScrapeFn(tabId, fn) {
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: fn });
    if (results?.[0]?.error) {
      // Scraper threw inside the page context (not an inject permission error)
      // Log for debugging but treat as empty — not a fatal injection failure
      console.warn('[Ondo] Scraper threw in page context (0 items):', results[0].error);
      return [];
    }
    const result = results?.[0]?.result;
    if (!Array.isArray(result)) {
      console.warn('[Ondo] Scraper returned non-array:', typeof result, '— treating as 0 items');
      return [];
    }
    return result;
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
  // Patterns: /c/COURSE/a/ASSIGN, /c/COURSE/d/DOC, /c/COURSE/q/QUIZ, /c/COURSE/mc/MATERIAL,
  //           /c/COURSE/sa/ID (student submission), /c/COURSE/p/ID (post)
  const ASSIGN_RE = /classroom\.google\.com\/(?:u\/\d+\/)?c\/[^/]+\/(?:[adqmp][ac]?|sa)\/[^/?#]+/;
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

  // ── Weighted scoring for school-relevance ────────────────────────────────
  // Higher score = more likely to be a real school item.
  // Threshold of 4 eliminates most false positives (e.g. "COVID test results" = 1 point).
  const SCORE_MAP = [
    [5, ['assignment','homework','due date','submit by','submission deadline',
         'syllabus','graded','missing work','late work','extra credit',
         'rubric','plagiarism','turnitin','gradebook']],
    [3, ['course','professor','instructor','lecturer','lecture','semester','quarter',
         'canvas','classroom','oncourse','blackboard','moodle','brightspace','lms',
         'office hours','tutorial','recitation','ta ','teaching assistant']],
    [1, ['class','test','quiz','exam','grade','grades','project','essay',
         'report','presentation','lab','study','school','college','university',
         'midterm','final','teacher']],
  ];

  const schoolScore = (subject, sender, snippet) => {
    const text = `${subject} ${sender} ${snippet}`.toLowerCase();
    let score = 0;
    for (const [weight, keywords] of SCORE_MAP) {
      for (const k of keywords) if (text.includes(k)) score += weight;
    }
    // .edu sender domain → very strong signal
    if (/\.edu\b/i.test(sender)) score += 4;
    // Course code pattern in subject: [CS 201], MATH-151, BIO 101, etc.
    if (/\b[A-Z]{2,5}[\s\-]?\d{3,4}\b/.test(subject)) score += 2;
    return score;
  };

  const SCORE_THRESHOLD = 4;

  const buildUrl = convId => {
    const h = window.location.hostname;
    if (!convId) return window.location.href;
    if (h === 'outlook.live.com') return `https://outlook.live.com/mail/inbox/id/${encodeURIComponent(convId)}`;
    return `${window.location.origin}/mail/inbox/id/${encodeURIComponent(convId)}`;
  };

  const add = (item, score) => {
    if (!item?.title || item.title.length < 2) return;
    const urlKey = item.url && item.url !== window.location.href ? item.url : null;
    if (urlKey && seenUrls.has(urlKey)) return;
    if (!urlKey && seenTitles.has(item.title)) return;
    if (urlKey) seenUrls.add(urlKey);
    else seenTitles.add(item.title);
    items.push({ ...item, _score: score });
  };

  // ── Strategy 0: Outlook 2024+ redesign ───────────────────────────────────
  document.querySelectorAll('[data-app-section="ConversationListItem"],[class*="ms-List-cell"][aria-label]').forEach(row => {
    try {
      const ariaLabel = row.getAttribute('aria-label') || '';
      const subjectEl = row.querySelector('[class*="subject"],[class*="Subject"],[aria-label*="subject"]');
      const subject   = subjectEl?.textContent.trim() || ariaLabel.split(',')[0]?.trim() || '';
      if (!subject || subject.length < 3) return;
      const sender    = row.querySelector('[class*="sender"],[class*="Sender"],[class*="from"],[class*="From"]')?.textContent.trim() || '';
      const snippet   = row.querySelector('[class*="preview"],[class*="Preview"],[class*="body"],[class*="Body"]')?.textContent.trim() || '';
      const score     = schoolScore(subject, sender, snippet);
      if (score < SCORE_THRESHOLD) return;
      const convId    = row.getAttribute('data-convid') || row.getAttribute('data-item-id') || '';
      const dateEl    = row.querySelector('time,[class*="time"],[class*="Time"],[class*="date"],[class*="Date"]');
      const date      = dateEl?.getAttribute('datetime') || dateEl?.textContent.trim() || '';
      add({ title: subject, sender, date, snippet: snippet.slice(0,150), url: buildUrl(convId), source: 'outlook', type: 'email' }, score);
    } catch {}
  });

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
      const score     = schoolScore(subject, sender, snippet);
      if (score < SCORE_THRESHOLD) return;
      const dateEl    = row.querySelector('[data-testid="received-time"],time');
      const date      = dateEl?.getAttribute('datetime') || dateEl?.textContent.trim() || '';
      add({ title: subject, sender, date, snippet: snippet.slice(0,150), url: buildUrl(convId), source: 'outlook', type: 'email' }, score);
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
      const score     = schoolScore(subject, sender, '');
      if (score < SCORE_THRESHOLD) return;
      const date      = row.querySelector('time,td[class*="date"],.tA')?.textContent.trim() || '';
      add({ title: subject, sender, date, url: buildUrl(convId), source: 'outlook', type: 'email' }, score);
    } catch {}
  });

  // ── Strategy 3: open reading pane ────────────────────────────────────────
  try {
    const pane = document.querySelector('[data-testid="reading-pane"],[aria-label*="reading"],.readingPane,[class*="ReadingPane"]');
    if (pane) {
      const subjectEl = pane.querySelector('h1,[data-testid="message-subject"],[role="heading"],.aqY,.hq');
      const subject   = subjectEl?.textContent.trim() || '';
      if (subject.length >= 3) {
        const score = schoolScore(subject, '', pane.textContent?.slice(0, 500) || '');
        if (score >= SCORE_THRESHOLD) {
          add({ title: subject, url: window.location.href, source: 'outlook', type: 'email_open' }, score);
        }
      }
    }
  } catch {}

  // Sort by relevance score (highest first) — real cap applied by orchestrator
  items.sort((a, b) => (b._score || 0) - (a._score || 0));
  console.log('[Ondo/outlook] found', items.length, 'school-relevant items on', window.location.href);
  return items.slice(0, 25);
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
      provider:      'ollama',
      ollamaUrl:     OLLAMA_DEFAULT_URL,
      ollamaModel:   'qwen3:4b',
      claudeApiKey:  '',
      claudeModel:   'claude-haiku-4-5-20251001',
      openaiApiKey:  '',
      openaiModel:   'gpt-4o-mini',
      openaiBaseUrl: 'https://api.openai.com/v1',
      smartFilter:       false,
      outlookCap:        15,
      autoScanInterval:  'off',  // 'off' | '30' | '60' | '180' (minutes)
      notifications:     false,
    }, resolve);
  });
}

// ── Data normalisation (run before building prompt) ───────────────────────────

const SOURCE_MAP = { classroom: 'Classroom', outlook: 'Outlook', oncourse: 'OnCourse' };

function normalizeItems(rawItems) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Date pattern — only keep Outlook hints that contain deadline-relevant info
  const DATE_HINT_RE = /due|by|before|deadline|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}/i;

  const SOURCE_PRIORITY = { Classroom: 0, OnCourse: 1, Outlook: 2 };

  const mapped = rawItems
    .filter(item => item?.title && String(item.title).trim().length > 1)
    .map(item => {
      const source = SOURCE_MAP[(item.source || '').toLowerCase()] ?? 'Classroom';

      // Only keep https?:// URLs — discard window.location.href fallbacks
      const url = typeof item.url === 'string' && /^https?:\/\//.test(item.url)
        ? item.url : null;

      // Pre-compute days-until-due so the AI doesn't have to do date arithmetic
      const daysFromNow = computeDaysFromNow(item.dueDate, today);

      // For Outlook items, only keep hint if it contains a date/deadline
      // (saves tokens — most email previews are useless filler)
      const snippet = item.snippet || '';
      const keepHint = source !== 'Outlook' || DATE_HINT_RE.test(snippet);

      const out = {
        title: String(item.title).trim().slice(0, 150),
        source,
        ...(url          ? { url }                                    : {}),
        ...(item.dueDate ? { dueDate: String(item.dueDate).slice(0, 60) } : {}),
        ...(daysFromNow !== null ? { daysFromNow }                    : {}),
        // Optional context hints (compressed)
        ...(item.courseName ? { course: String(item.courseName).slice(0, 40) } : {}),
        ...(keepHint && snippet ? { hint: String(snippet).slice(0, 80) } : {}),
      };
      return out;
    });

  // Sort: Classroom first (structured assignments), OnCourse second, Outlook last (noisiest)
  // Within each source, sort by urgency (daysFromNow ascending, nulls/unknowns last)
  mapped.sort((a, b) => {
    const sp = (SOURCE_PRIORITY[a.source] ?? 2) - (SOURCE_PRIORITY[b.source] ?? 2);
    if (sp !== 0) return sp;
    const da = a.daysFromNow ?? 9999;
    const db = b.daysFromNow ?? 9999;
    return da - db;
  });

  // Hard item cap, then a token-budget check (~4 chars per token, 6k token data budget)
  const capped = mapped.slice(0, 80);
  const TOKEN_BUDGET_CHARS = 6_000 * 4; // ~6k tokens
  let totalChars = 0;
  const budgeted = [];
  for (const item of capped) {
    const sz = JSON.stringify(item).length;
    if (totalChars + sz > TOKEN_BUDGET_CHARS && budgeted.length >= 10) break;
    totalChars += sz;
    budgeted.push(item);
  }
  if (budgeted.length < capped.length) {
    console.warn(`[Ondo] Token budget: trimmed ${capped.length} → ${budgeted.length} items`);
  }
  return budgeted;
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

// ── Smart Filter (optional AI pre-filter) ─────────────────────────────────────
// Runs each non-Classroom source through a lightweight AI call to strip noise
// before the main assignment-generation prompt. Off by default.

function trimForFilter(item) {
  // Send only the fields the AI needs to make a filtering decision — minimise tokens
  const out = { title: item.title, source: item.source };
  if (item.sender)     out.sender   = item.sender;
  if (item.date)       out.date     = item.date;
  if (item.dueDate)    out.dueDate  = item.dueDate;
  if (item.snippet)    out.snippet  = String(item.snippet).slice(0, 100);
  if (item.url)        out.url      = item.url;
  if (item.courseName) out.course   = item.courseName;
  if (item.type)       out.type     = item.type;
  return out;
}

function buildFilterPrompt(scraped) {
  const data = {};
  if (scraped.outlook?.length  > 0) data.outlook  = scraped.outlook.map(trimForFilter);
  if (scraped.oncourse?.length > 0) data.oncourse = scraped.oncourse.map(trimForFilter);

  const system = 'You are a data filter for a school task tracker. Output ONLY valid JSON. No prose, no markdown, no explanation.';

  const user =
`Filter the scraped data below. Keep ONLY items that are actual, actionable school tasks — assignments, homework, quizzes, exams, projects, or emails about specific deadlines the student must act on.

REMOVE:
- Newsletters, announcements, or promotional emails
- Completed, graded, submitted, or returned work
- General school info with no specific deadline or action
- Non-school content (personal emails, spam, social notifications)
- Duplicates (keep the one with more info)

Return a JSON object with the same keys as the input. Each key maps to an array of surviving items with ALL original fields preserved unchanged. If every item in a source was removed, use an empty array.

Example: {"outlook": [...surviving items...], "oncourse": [...surviving items...]}

DATA:
${JSON.stringify(data, null, 1)}`;

  return { system, user };
}

async function callAIRaw(prompt, settings) {
  if (settings.provider === 'claude')  return callClaude(prompt, settings,  { raw: true });
  if (settings.provider === 'openai')  return callOpenAI(prompt, settings,  { raw: true });
  return callOllama(prompt, settings, { raw: true });
}

async function runSmartFilter(scraped, settings) {
  const prompt  = buildFilterPrompt(scraped);
  const rawText = await callAIRaw(prompt, settings);

  // Parse the filter response — expect { outlook: [...], oncourse: [...] }
  let s = rawText.trim();
  // Strip thinking tags (qwen3)
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/<think>[\s\S]*/gi, '').trim();
  // Strip markdown fences
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const objStart = s.indexOf('{');
  const objEnd   = s.lastIndexOf('}');
  if (objStart === -1 || objEnd === -1) {
    throw new Error('Filter returned non-JSON output');
  }

  const obj = JSON.parse(s.slice(objStart, objEnd + 1));

  // Map filtered items back to original scraped items by URL/title to preserve all fields
  // (the AI may have stripped internal fields like _score)
  const mapBack = (filtered, originals) => {
    if (!Array.isArray(filtered)) return originals;
    const origMap = new Map();
    for (const item of originals) {
      const key = item.url || item.title;
      if (!origMap.has(key)) origMap.set(key, item);
    }
    // Return original items that match filtered titles/urls
    return filtered.reduce((acc, f) => {
      const key = f.url || f.title;
      const orig = origMap.get(key);
      if (orig) acc.push(orig);
      else acc.push(f); // AI kept it but we can't map back — use as-is
      return acc;
    }, []);
  };

  return {
    outlook:  mapBack(obj.outlook,  scraped.outlook  || []),
    oncourse: mapBack(obj.oncourse, scraped.oncourse || []),
  };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(rawItems, provider = 'ollama') {
  const todayStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const items = normalizeItems(rawItems);

  // OpenAI's response_format:json_object requires an object at the top level — not a bare array.
  // Ollama/Claude can return either form; the parser handles both.
  const isOpenAI = provider === 'openai';

  // System message: short and authoritative.
  // /no_think is appended in callOllama only (Ollama-specific directive).
  const system = isOpenAI
    ? 'You are a JSON extraction tool. Output ONLY a JSON object with a single key "todos" ' +
      'whose value is an array of task objects. No prose, no markdown, no explanation.'
    : 'You are a JSON extraction tool. Output ONLY a JSON array of task objects. ' +
      'No prose, no markdown, no explanation.';

  // User message: clear schema, explicit field-by-field guidance, then data.
  const user =
`Today: ${todayStr}

You have school task data scraped from websites. Convert it to ${isOpenAI ? '{"todos":[...]}' : 'a JSON array'}.

Each output item must have this exact shape:
{
  "title":    string,                              // clean task name (trim noise)
  "source":   "Classroom" | "Outlook" | "OnCourse",
  "dueDate":  string | null,                       // human-readable date (see rules below)
  "url":      string,                              // copy from input url exactly; "#" if absent
  "priority": "high" | "medium" | "low",           // see rules below
  "notes":    string                               // extra context (see rules below); "" if nothing
}

INPUT FIELD GUIDE — each input item may contain:
  title       → use as-is for output title (clean up "Missing:" or "[LATE]" prefixes if present)
  source      → copy to output source unchanged
  url         → copy to output url EXACTLY — do not modify or reconstruct
  dueDate     → raw date text; copy to output dueDate
  daysFromNow → integer days until due (negative = overdue). PRIMARY signal for priority & dueDate.
  course      → class/course name (Classroom items) → put in output notes
  hint        → email body snippet (Outlook items) → extract deadline or action and put in notes

PRIORITY RULES (prefer daysFromNow when present):
  "high"   → daysFromNow ≤ 2  OR  daysFromNow < 0 (overdue)  OR  title contains "missing"/"overdue"/"late"
  "medium" → daysFromNow 3–7
  "low"    → daysFromNow > 7  OR  no due date and no urgency signal
  For Outlook items with no daysFromNow: scan hint for date words (today/tomorrow/Monday…Sunday/
  "due [date]"/"by [date]") relative to today's date above, and infer priority accordingly.

DUEDATE RULES:
  - Copy dueDate from input if present
  - If dueDate absent: daysFromNow < 0 → "Overdue", daysFromNow=0 → "Today", daysFromNow=1 → "Tomorrow"
  - If dueDate absent and no daysFromNow: try to extract a date from the hint field if one exists
  - Otherwise null — never invent a date

NOTES RULES:
  - Classroom: put the course name (from "course" field) e.g. "AP Calculus"
  - Outlook: extract the key action/deadline from the "hint" field e.g. "Submit by Friday 11:59 PM"
  - OnCourse: leave "" unless hint or course provides useful context
  - Max ~80 characters; omit filler like "Please", "Reminder:", "FYI"

FILTER RULES:
  - Skip items already submitted / complete / graded / returned / closed
  - Skip Outlook items that have no school context (no deadline, no assignment/course reference)
  - Deduplicate: if two items have the same title, keep only the one with a real URL (not "#")

OUTPUT NOTHING outside the JSON ${isOpenAI ? 'object' : 'array'}.

DATA:
${JSON.stringify(items, null, 1)}`;

  return { system, user };
}

// ── AI dispatch ───────────────────────────────────────────────────────────────

async function processWithAI(items, settings) {
  const prompt = buildPrompt(items, settings.provider);
  if (settings.provider === 'claude')  return callClaude(prompt, settings);
  if (settings.provider === 'openai')  return callOpenAI(prompt, settings);
  return callOllama(prompt, settings);
}

function activeModel(settings) {
  if (settings.provider === 'claude') return settings.claudeModel  || 'claude-haiku-4-5-20251001';
  if (settings.provider === 'openai') return settings.openaiModel  || 'gpt-4o-mini';
  return settings.ollamaModel || 'qwen3:4b';
}

// ── Ollama ────────────────────────────────────────────────────────────────────

async function callOllama(prompt, settings, opts) {
  const base  = (settings.ollamaUrl || OLLAMA_DEFAULT_URL).replace(/\/$/, '');
  const model = (settings.ollamaModel || 'qwen3:4b').trim();

  const isQwen3  = /^qwen3/i.test(model);
  const isGptOss = /^gpt-oss/i.test(model);

  // ── Request body ───────────────────────────────────────────────────────────
  const body = {
    model,
    messages: [
      // Append /no_think to system content here (Ollama-only directive; ignored by Claude/OpenAI)
      { role: 'system', content: prompt.system + ' /no_think' },
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
  if (opts?.raw) return text;
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

async function callClaude(prompt, settings, opts) {
  if (!settings.claudeApiKey) {
    throw new Error('Claude API key not set. Open Options → add your key.');
  }

  const res = await fetch(CLAUDE_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type':                            'application/json',
      'x-api-key':                               settings.claudeApiKey,
      'anthropic-version':                       '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
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
  if (opts?.raw) return text;
  return parseAndValidateAI(text, 'claude');
}

// ── OpenAI-compatible API ─────────────────────────────────────────────────────
// Works with: api.openai.com, LM Studio, LocalAI, Ollama /v1, Jan, etc.

async function callOpenAI(prompt, settings, opts) {
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key not set. Open Options → add your key.');
  }

  const base  = (settings.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = (settings.openaiModel  || 'gpt-4o-mini').trim();

  // o1/o3/o4 reasoning models don't support response_format or temperature
  const isReasoning = /^o[134][-\s]/i.test(model) || model === 'o1' || model === 'o3';

  const reqBody = {
    model,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user',   content: prompt.user   },
    ],
    ...(isReasoning ? {} : {
      temperature:     0,
      response_format: { type: 'json_object' }, // structured JSON output (non-reasoning only)
    }),
  };

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${settings.openaiApiKey}`,
      },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    throw new Error(`Cannot reach OpenAI endpoint at ${base}. Check your base URL and network.`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`OpenAI ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (opts?.raw) return text;
  return parseAndValidateAI(text, model);
}

async function testOpenAIKey(key, model, baseUrl, sendResponse) {
  try {
    const base = (baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res  = await fetch(`${base}/chat/completions`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model:      model || 'gpt-4o-mini',
        max_tokens: 10,
        messages:   [{ role: 'user', content: 'Say: ok' }],
      }),
    });
    if (res.ok) {
      sendResponse({ success: true });
    } else {
      const errData = await res.json().catch(() => ({}));
      const errMsg  = errData.error?.message
        || (res.status === 401 ? 'Invalid API key'
          : res.status === 403 ? 'Access denied — check key permissions'
          : `HTTP ${res.status}`);
      sendResponse({ success: false, error: errMsg });
    }
  } catch (e) {
    sendResponse({ success: false, error: `Cannot reach ${(baseUrl||'').replace(/\/$/, '') || 'endpoint'}. Check Base URL and network.` });
  }
}

async function testClaudeKey(key, model, sendResponse) {
  try {
    const res = await fetch(CLAUDE_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':                            'application/json',
        'x-api-key':                               key,
        'anthropic-version':                       '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model:      model || 'claude-haiku-4-5-20251001',
        max_tokens: 32,
        messages:   [{ role: 'user', content: 'Reply with the single word: ok' }],
      }),
    });
    if (res.ok) {
      sendResponse({ success: true });
    } else {
      const errData = await res.json().catch(() => ({}));
      const errMsg  = errData.error?.message
        || (res.status === 401 ? 'Invalid API key'
          : res.status === 403 ? 'Access denied — check key permissions'
          : `HTTP ${res.status}`);
      sendResponse({ success: false, error: errMsg });
    }
  } catch (e) {
    sendResponse({ success: false, error: 'Cannot reach Anthropic API. Check network.' });
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
      const arr = obj.todos ?? obj.items ?? obj.tasks ?? obj.assignments ?? obj.data ?? null;
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

    const resolvedSource = VALID_SOURCES.has(item.source) ? item.source : guessSource(item);
    if (!VALID_SOURCES.has(item.source)) {
      console.warn('[Ondo] AI returned unknown source:', item.source, '→ guessed', resolvedSource);
    }
    acc.push({
      title,
      source:   resolvedSource,
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
