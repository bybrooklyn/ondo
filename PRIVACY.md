# Privacy Policy — Ondo

**Last updated: March 24, 2026**

---

## What Ondo Is

Ondo is a Chrome extension that reads assignment and task data from your school platforms (Google Classroom, Outlook, OnCourse) and uses an AI model to generate a prioritized to-do list. All processing happens locally on your device or through an AI service you configure yourself.

---

## Data Collection

**Ondo collects no user data.**

Ondo does not operate any servers. It does not collect, store, transmit, or share any personal information with the extension developer or any third party.

---

## What Ondo Reads (and Why)

When you click **Scan**, Ondo temporarily reads the following from your open browser tabs:

| What is read | Why |
|---|---|
| Assignment titles and due dates from Google Classroom | To build your to-do list |
| Email subjects from Outlook inbox | To identify school-related deadlines |
| Assignment names and due dates from OnCourse | To build your to-do list |

This data is read directly from your browser's DOM. It is:
- **Never sent to Ondo's servers** (Ondo has no servers)
- **Never logged, stored remotely, or shared**
- Processed entirely within your browser session, then discarded

---

## AI Processing

Ondo sends your scraped assignment data to one of two AI services **that you configure**:

### Option A — Local Ollama (default)
Your data is sent to `localhost:11434` — a process running on your own machine. Nothing leaves your device.

### Option B — Anthropic Claude API
If you choose to use Claude, your assignment data is sent to `api.anthropic.com` using **your own API key**. This is subject to [Anthropic's Privacy Policy](https://www.anthropic.com/privacy). Ondo does not see or store your API key beyond saving it locally in your browser's Chrome sync storage (encrypted by Google).

---

## Local Storage

Ondo stores the following **only on your device** using Chrome's built-in storage APIs:

| Data | Storage | Purpose |
|---|---|---|
| AI provider preference (Ollama or Claude) | `chrome.storage.sync` | Remember your settings |
| Model name / Ollama URL | `chrome.storage.sync` | Remember your settings |
| Claude API key (if provided) | `chrome.storage.sync` | Authenticate with Claude |
| Last scan results (assignment list) | `chrome.storage.local` | Show cached results instantly on open |

`chrome.storage.sync` data is encrypted by Google and synced across your Chrome profile. Ondo never has access to it outside your browser.

---

## Permissions Explained

| Permission | Why it's needed |
|---|---|
| `activeTab` | Inject scraping scripts into your currently active school platform tab |
| `scripting` | Programmatically inject scraping functions into Classroom, Outlook, and OnCourse tabs to read assignment data |
| `storage` | Save your settings and cache the last scan result locally |
| `tabs` | Identify which open tabs are school platform pages; open Classroom's to-do page if not already open |
| `classroom.google.com` host | Read assignments from Google Classroom |
| `outlook.*.com` hosts | Read school-related emails from Outlook |
| `oncourse.*` hosts | Read assignments from OnCourse |
| `localhost:11434` | Send data to your local Ollama AI (stays on your machine) |
| `api.anthropic.com` | Send data to Claude API using your own key (optional) |

---

## What Ondo Does NOT Do

- Does not collect names, emails, passwords, or any personal identifiers
- Does not track browsing history or user behavior
- Does not display ads or use data for advertising
- Does not sell, rent, or share any data with anyone
- Does not use remote code execution (all extension code is bundled locally)
- Does not communicate with any Ondo-operated server

---

## Children's Privacy

Ondo does not knowingly collect any information from anyone. Since it collects nothing, it is safe for users of any age.

---

## Changes to This Policy

If the extension is updated in a way that changes data handling, this policy will be updated and the "Last updated" date will change. You can always find the current version in the extension's source repository.

---

## Contact

Questions about this privacy policy can be directed to the extension's developer via the Chrome Web Store listing page.
