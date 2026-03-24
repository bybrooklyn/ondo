'use strict';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'scrape') {
    try {
      sendResponse(scrapeOutlook());
    } catch (e) {
      console.error('[Ondo/outlook] scrape threw:', e);
      sendResponse([]);
    }
    return true;
  }
});

// ── School-relevance filter ───────────────────────────────────────────────────

const SCHOOL_KW = [
  'assignment', 'homework', 'due', 'submit', 'submission', 'deadline',
  'exam', 'quiz', 'test', 'midterm', 'final', 'grade', 'graded', 'grades',
  'course', 'class', 'lecture', 'syllabus', 'teacher', 'professor',
  'instructor', 'school', 'college', 'university', 'semester', 'quarter',
  'canvas', 'classroom', 'oncourse', 'blackboard', 'moodle', 'lms',
  'missing work', 'late work', 'extra credit', 'office hours',
  'study', 'project', 'essay', 'report', 'presentation', 'lab',
];

const isSchoolRelated = text => {
  const lower = text.toLowerCase();
  return SCHOOL_KW.some(kw => lower.includes(kw));
};

// ── Main ──────────────────────────────────────────────────────────────────────

function scrapeOutlook() {
  const items = [];
  // Dedup by URL (preferred) then by subject title — fixes the same-subject bug
  const seenUrls   = new Set();
  const seenTitles = new Set();

  const add = item => {
    if (!item?.title) return;
    // Prefer URL-based dedup; fall back to title only if URL is the page root
    const urlKey = item.url && item.url !== window.location.href ? item.url : null;
    if (urlKey && seenUrls.has(urlKey)) return;
    if (!urlKey && seenTitles.has(item.title)) return;
    if (urlKey) seenUrls.add(urlKey);
    else        seenTitles.add(item.title);
    items.push(item);
  };

  // ── 1. New Outlook / OWA — [role="option"] email rows ────────────────────
  document.querySelectorAll('[role="option"][aria-label], [role="listitem"][aria-label]').forEach(row => {
    try {
      const ariaLabel = row.getAttribute('aria-label') || '';
      const convId    = row.getAttribute('data-convid') || row.getAttribute('data-itemid') || '';

      const subjectEl = row.querySelector(
        '[data-testid="subject"], span[title], .UGSvXb_messageSubject,' +
        ' [role="heading"], .lUbBFc, .Cp0tib, ._2lDLF'
      );
      const subject = subjectEl?.textContent.trim()
                   || ariaLabel.split(';')[0]?.trim()
                   || '';
      if (!subject || subject.length < 3) return;

      const senderEl  = row.querySelector('[data-testid="sender-name"], .afn, .EO4Vs, .FVpkif');
      const sender    = senderEl?.textContent.trim() || '';
      const snippet   = row.querySelector('[data-testid="email-preview"], .bodypreview, ._23RGT')
                            ?.textContent.trim() || '';

      if (!isSchoolRelated(`${subject} ${sender} ${snippet}`)) return;

      const dateEl  = row.querySelector('[data-testid="received-time"], time, .K5rRrb_timestamp, .Date');
      const date    = dateEl?.getAttribute('datetime') || dateEl?.textContent.trim() || '';
      const url     = buildOutlookUrl(convId);

      add({ title: subject, sender, date, snippet: snippet.slice(0, 150), url, source: 'outlook', type: 'email' });
    } catch {}
  });

  // ── 2. data-convid / data-itemid rows (older OWA) ────────────────────────
  document.querySelectorAll('[data-convid], [data-itemid]').forEach(row => {
    try {
      const convId    = row.getAttribute('data-convid') || row.getAttribute('data-itemid') || '';
      const subjectEl = row.querySelector('.I9SgZ, .lG0AC, .dEAXp, td[class*="subject"]');
      const subject   = subjectEl?.textContent.trim() || '';
      if (!subject || subject.length < 3) return;

      const senderEl  = row.querySelector('.iGSJe, .o6oGW, td[class*="from"]');
      const sender    = senderEl?.textContent.trim() || '';
      if (!isSchoolRelated(`${subject} ${sender}`)) return;

      const dateEl = row.querySelector('time, td[class*="date"], .tA');
      const date   = dateEl?.textContent.trim() || '';
      const url    = buildOutlookUrl(convId);

      add({ title: subject, sender, date, url, source: 'outlook', type: 'email' });
    } catch {}
  });

  // ── 3. Currently open email in reading pane ───────────────────────────────
  try {
    const pane = document.querySelector(
      '[data-testid="reading-pane"], [aria-label*="reading"], .readingPane,' +
      ' [class*="ReadingPane"], #ReadingPaneContainerId'
    );
    if (pane) {
      const subjectEl = pane.querySelector('h1, [data-testid="message-subject"], [role="heading"], .aqY, .hq');
      const subject   = subjectEl?.textContent.trim() || '';
      if (subject && subject.length >= 3 && isSchoolRelated(`${subject} ${pane.textContent}`)) {
        add({ title: subject, url: window.location.href, source: 'outlook', type: 'email_open' });
      }
    }
  } catch {}

  return items;
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildOutlookUrl(convId) {
  if (!convId) return window.location.href;
  const h = window.location.hostname;
  if (h === 'outlook.live.com') {
    return `https://outlook.live.com/mail/inbox/id/${encodeURIComponent(convId)}`;
  }
  // office.com, office365.com, or OWA on a custom domain
  return `${window.location.origin}/mail/inbox/id/${encodeURIComponent(convId)}`;
}
