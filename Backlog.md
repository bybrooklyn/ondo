# Ondo — Backlog

Planned features in rough priority order. Items marked **🔥** are high-impact for daily active use.

---

## 🔥 Auto-scan on interval (#6)

**What:** A background alarm (Chrome `alarms` API) that re-runs the scrape + AI pipeline on a configurable interval (e.g. every 30 or 60 minutes), without the user needing to open the popup.

**Why:** Students forget to check. Auto-scan makes Ondo feel alive — the badge updates on its own throughout the day.

**Details:**
- Add `alarms` to manifest permissions
- `chrome.alarms.create('autoScan', { periodInMinutes: 60 })` on install + settings save
- `chrome.alarms.onAlarm` listener in background.js calls `handleScrapeAll` silently
- New option: **Auto-scan interval** (Off / 30 min / 60 min / 3 hr) — default Off
- Only run if a provider is configured and credentials are valid
- Update badge after silent scan; don't pop open the popup

---

## 🔥 Notifications (#7)

**What:** Chrome notifications (`notifications` permission) when urgent tasks appear or something becomes overdue.

**Why:** The badge is visible but silent. A notification actually interrupts and ensures students don't miss a deadline.

**Details:**
- Send a notification when auto-scan detects a new `high` priority item not present in the previous scan
- Send a notification when an item transitions from `medium → high` (task crossed the 2-day threshold)
- Notification body: task title + due date, click opens Ondo popup
- New option: **Notifications** toggle (default Off)
- Respect Chrome's notification permission prompt

---

## Google Calendar integration (#8)

**What:** One-click export of scanned tasks to Google Calendar as events due on the assignment deadline.

**Why:** Most students live in their calendar. Getting assignments there is the highest-value action Ondo could take after scanning.

**Details:**
- Requires Google OAuth (identity permission + `https://www.googleapis.com/auth/calendar.events` scope)
- Add **"Add to Calendar"** button per task (and a bulk "Export all" button)
- Create events with: title, description (notes + source URL), due date as all-day event or with a 11:59 PM time
- Skip items with no dueDate
- Handle token refresh; show auth prompt if not yet granted
- Consider: sync vs. one-shot export

---

## Canvas / Blackboard / Moodle support (#9)

**What:** Scrapers for the three most popular LMS platforms beyond the current three.

**Why:** Canvas alone covers ~40% of US higher ed. Supporting it dramatically expands the potential user base.

**Details:**
- **Canvas:** Has a public REST API — students can generate a personal access token. Endpoint: `GET /api/v1/users/self/todo`. API is much more reliable than DOM scraping.
- **Blackboard:** DOM scraping of `blackboard.com` and institutional subdomains. Assignment list at `/ultra/courses`.
- **Moodle:** REST API available via site token, or DOM scraping of `/my/` dashboard.
- Add per-source enable/disable toggles in Options
- Update host_permissions in manifest for canvas.instructure.com, *.blackboard.com, *.moodlecloud.com

---

## Dark / light theme toggle (#10)

**What:** A theme toggle in Options (and/or auto-detect from `prefers-color-scheme`) to switch between the current dark terminal theme and a clean light mode.

**Why:** Some students use light mode systemwide; a pitch-black popup looks jarring on a white desktop.

**Details:**
- Add CSS variables for a light theme (white bg, dark text, muted lime/teal accents)
- `@media (prefers-color-scheme: light)` as default fallback
- Manual toggle in Options saves to `chrome.storage.sync`
- Apply to both popup and options page

---

## Export formats (#11)

**What:** More export targets beyond the current Markdown copy button.

**Why:** Students use different productivity systems. Meeting them where they are increases daily value.

**Priority order:**
1. **CSV** — universal; works in Excel, Google Sheets, Notion import
2. **Google Tasks API** — tight Google integration, works alongside Classroom
3. **Todoist API** — popular among students, has a free tier
4. **Notion API** — popular for student dashboards
5. **Apple Reminders** (via `x-apple-reminder://` URL scheme on macOS)

**Details:**
- Add export menu in popup footer (small dropdown from a `⬡ Export` button)
- CSV: `title,dueDate,priority,source,url` columns
- API integrations: OAuth or personal API token in Options
- Each integration shows as an optional card in Options (only configure what you use)

---

## Onboarding flow (#12)

**What:** A first-run screen that guides new users from zero to first successful scan.

**Why:** Currently, a new user sees a blank popup with no context. The TTFV (time to first value) is high — they need to: configure a provider, open school sites, understand what to do. Most will bounce.

**Details:**
- Detect first run: `chrome.storage.sync.get('onboardingDone')` — if false/absent, show onboarding
- Step 1: **Pick your AI** — provider cards with one-sentence descriptions, links to get API keys
- Step 2: **Open your school sites** — animated prompt showing which sites to have open, with direct links
- Step 3: **Your first scan** — big Scan button, celebrate the first result
- Mark `onboardingDone: true` after step 3
- Allow skipping from step 1 (for returning users who reinstalled)
- Accessible via a "Setup guide" link in the options page footer

---

*Last updated: 2026-03-24*
