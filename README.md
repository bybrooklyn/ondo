# Ondo

**AI-powered task radar for students.** Ondo scrapes your Google Classroom, Outlook, and OnCourse tabs, sends the data to a local or cloud AI, and returns a clean prioritized to-do list with direct links — all in one click.

![Ondo icon](https://raw.githubusercontent.com/bybrooklyn/ondo/main/icons/icon128.png)

---

## Features

- **Unified task list** — Classroom assignments, school emails, and OnCourse work in one place
- **AI prioritization** — ranks tasks by due date, flags overdue and missing work
- **Badge count** — icon shows the number of urgent tasks at a glance; clears when you open the popup
- **Intelligent Outlook filtering** — scored keyword system filters noise (newsletters, spam) before sending to AI
- **Smart Filter** *(optional)* — extra AI pre-filter pass for Outlook + OnCourse; strips non-assignments before the main prompt
- **Local-first** — defaults to [Ollama](https://ollama.com) running on your machine; nothing leaves your device
- **Cloud AI options** — Anthropic Claude or OpenAI (GPT-4o, o4-mini, GPT-4.1) with your own key
- **OpenAI-compatible** — any local server with a `/v1` endpoint works (LM Studio, LocalAI, Jan, Ollama shim)
- **Auto-opens Classroom** — if no Classroom tab is open, Ondo opens the to-do page in the background, scrapes, and closes it
- **Cached results** — last scan shown instantly on open, even offline
- **Copy to clipboard** — copy all tasks as a Markdown checklist grouped by priority
- **Dark terminal UI** — lime/teal/amber on black, monospace font

---

## Supported Sources

| Source | URL |
|---|---|
| Google Classroom | `classroom.google.com` |
| Outlook | `outlook.live.com`, `outlook.office.com`, `outlook.office365.com` |
| OnCourse (IU) | `oncourse.iu.edu`, `oncourseconnect.com`, `oncourse.cc` |

---

## Requirements

- Chrome (or any Chromium browser)
- **For local AI:** [Ollama](https://ollama.com) running with `qwen3:4b` pulled
- **For cloud AI:** An [Anthropic API key](https://console.anthropic.com) or [OpenAI API key](https://platform.openai.com)

---

## Installation

### Load unpacked (development)

1. Clone the repo:
   ```bash
   git clone https://github.com/bybrooklyn/ondo.git
   cd ondo
   ```
2. Go to `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select the `ondo` folder

### Build a CRX

Requires [`just`](https://github.com/casey/just):

```bash
just build   # validate + icon generation check
just crx     # pack signed .crx (generates ondo.pem on first run)
just zip     # zip for Chrome Web Store upload
```

> **Keep `ondo.pem` safe.** It's gitignored. Losing it means you can't update a packed CRX with the same extension ID.

---

## Setup

### Option A — Local Ollama (default, recommended)

1. Install Ollama: https://ollama.com
2. Pull the default model:
   ```bash
   ollama pull qwen3:4b
   ```
3. Start Ollama with CORS allowed (required for Chrome extensions):
   ```bash
   OLLAMA_ORIGINS="*" ollama serve
   ```
   > On macOS: quit the Ollama menu-bar app first, then run this command.
4. Click **Scan** — Ondo connects to `localhost:11434` automatically.

### Option B — Claude API

1. Open Ondo's **Options** (gear icon)
2. Select **Claude** as the provider
3. Paste your [Anthropic API key](https://console.anthropic.com)
4. Choose a model (Haiku 4.5 is fast and cheap; Sonnet 4.6 for better results)
5. Save and scan

### Option C — OpenAI / compatible API

1. Open Ondo's **Options** (gear icon)
2. Select **OpenAI** as the provider
3. Paste your [OpenAI API key](https://platform.openai.com) (or any API key for compatible servers)
4. Optionally set a custom **Base URL** for LM Studio (`http://localhost:1234/v1`), LocalAI, Jan, or Ollama's OpenAI shim
5. Choose a model (e.g. `gpt-4o-mini`, `gpt-4.1`, `o4-mini`)
6. Save and scan

---

## Usage

1. Open Outlook and/or OnCourse in a Chrome tab (log in if needed)
2. Click the **Ondo** extension icon
3. Click **Scan**
4. Ondo opens Classroom in the background, reads all three sources, and returns a prioritized list
5. Click any task title to open it directly
6. Use **⎘ Copy** to copy tasks as a Markdown checklist

### Priority colors

| Color | Meaning |
|---|---|
| 🔴 Red stripe | High — due within 2 days or overdue |
| 🟡 Amber stripe | Medium — due within a week |
| ⬛ Gray stripe | Low — due later or no due date |

---

## Options

| Setting | Default | Description |
|---|---|---|
| AI Provider | Ollama | Local (Ollama), Claude, or OpenAI |
| Ollama URL | `http://localhost:11434` | Base URL for your Ollama instance |
| Ollama Model | `qwen3:4b` | Any model pulled in Ollama |
| Claude Model | `claude-haiku-4-5-20251001` | Haiku, Sonnet, or Opus |
| OpenAI Key | — | API key for OpenAI or compatible service |
| OpenAI Base URL | `https://api.openai.com/v1` | Override for LM Studio, LocalAI, etc. |
| OpenAI Model | `gpt-4o-mini` | Any model supported by the endpoint |
| Smart Filter | Off | AI pre-filter pass for Outlook + OnCourse before main prompt |
| Outlook Email Cap | 15 | Max emails sent to AI per scan (ranked by school-relevance) |

---

## Troubleshooting

### "Ollama 403: Forbidden"
Ollama blocks requests from Chrome extension origins by default. Fix:
```bash
OLLAMA_ORIGINS="*" ollama serve
```
To persist across restarts, add `OLLAMA_ORIGINS=*` to your shell profile (`~/.zshrc` or `~/.bashrc`).

### "Nothing was scraped"
- Make sure you're **logged in** to the services you want scraped
- **Reload the extension** after any update (`chrome://extensions` → ↺)
- Check the error detail — it shows which source failed and what URL it was at

### "AI returned unusable output"
The model produced malformed JSON. Try switching to `qwen3:4b` or `gemma3:4b` in Options, or make sure the model is fully downloaded.

### Smart Filter errors
Smart Filter requires a capable model. Use Claude Haiku, GPT-4o-mini, or at minimum `qwen3:8b` locally. Small models (< 4B params) may drop valid tasks or return malformed JSON.

---

## Privacy

Ondo collects nothing. All data stays on your device or goes to the AI service you configure yourself (your Ollama instance or your API account). See [PRIVACY.md](./PRIVACY.md) for the full policy.

---

## Development

```bash
just validate   # check all required files exist, parse manifest
just audit      # scan for eval(), unescaped innerHTML, stray API keys
just dev        # validate + open chrome://extensions
just clean      # remove build artifacts
```

### File structure

```
ondo/
├── manifest.json          # MV3 manifest
├── background.js          # service worker: scraping, AI calls, badge
├── popup.html/js/css      # extension popup UI
├── options.html/js/css    # settings page
├── icons/
│   └── icon{16,32,48,128}.png
├── justfile               # build recipes
├── PRIVACY.md
└── Backlog.md             # planned features
```

---

## License

MIT
