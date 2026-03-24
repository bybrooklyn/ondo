# Ondo — Chrome Extension Build Recipes
# Requires: https://github.com/casey/just
# Install:  brew install just

set shell := ["bash", "-euo", "pipefail", "-c"]

ext_dir  := justfile_directory()
ext_name := "ondo"

# ── Default ───────────────────────────────────────────────────────────────────

# List available recipes
default:
    @just --list --unsorted

# ── Build ─────────────────────────────────────────────────────────────────────

# Full build: validate + regenerate icons + zip
build: validate icons zip
    @echo ""
    @printf "\033[92m✓ Build complete → %s.zip\033[0m\n" "{{ext_name}}"

# Package as .zip (Chrome Web Store upload or drag-and-drop sideload)
zip: validate
    @rm -f "{{ext_dir}}/{{ext_name}}.zip"
    cd "{{ext_dir}}" && zip -r "{{ext_name}}.zip" . \
        --exclude ".git/*" \
        --exclude ".claude/*" \
        --exclude ".DS_Store" \
        --exclude "*.zip" \
        --exclude "*.crx" \
        --exclude "*.pem" \
        --exclude "justfile" \
        --exclude "icons/generate_icons.js"
    @printf "\033[92m✓ Created %s.zip  (%s)\033[0m\n" \
        "{{ext_name}}" "$(du -sh {{ext_dir}}/{{ext_name}}.zip | cut -f1)"

# Pack as .crx using the system Chrome binary
# Generates ondo.pem (extension private key) on first run — keep it safe!
crx: validate icons
    #!/usr/bin/env bash
    set -euo pipefail

    # ── Locate Chrome ──────────────────────────────────────────────────────
    CHROME=""
    candidates=(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
        "/usr/bin/google-chrome"
        "/usr/bin/google-chrome-stable"
        "/usr/bin/chromium-browser"
        "/usr/bin/chromium"
        "/snap/bin/chromium"
    )
    for p in "${candidates[@]}"; do
        [[ -x "$p" ]] && { CHROME="$p"; break; }
    done

    if [[ -z "$CHROME" ]]; then
        echo "error: Chrome not found. Install Google Chrome or use 'just zip' instead."
        exit 1
    fi
    echo "Using Chrome: $CHROME"

    # ── Generate extension private key if missing ──────────────────────────
    KEY="{{ext_dir}}/{{ext_name}}.pem"
    if [[ ! -f "$KEY" ]]; then
        echo "Generating extension key → {{ext_name}}.pem  (keep this file safe — losing it means you can't update the same extension ID)"
        openssl genrsa -out "$KEY" 2048
    fi

    # ── Pack ───────────────────────────────────────────────────────────────
    # Chrome --pack-extension emits <parent-dir>/<ext-dir-name>.crx
    PARENT="$(dirname "{{ext_dir}}")"
    EXPECTED_CRX="$PARENT/{{ext_name}}.crx"

    "$CHROME" \
        --pack-extension="{{ext_dir}}" \
        --pack-extension-key="$KEY" \
        --no-message-box 2>/dev/null || true

    # Move output to the extension directory for convenience
    if [[ -f "$EXPECTED_CRX" ]]; then
        mv "$EXPECTED_CRX" "{{ext_dir}}/{{ext_name}}.crx"
        printf "\033[92m✓ Created %s.crx  (%s)\033[0m\n" \
            "{{ext_name}}" "$(du -sh {{ext_dir}}/{{ext_name}}.crx | cut -f1)"
    elif [[ -f "{{ext_dir}}/{{ext_name}}.crx" ]]; then
        printf "\033[92m✓ %s.crx already in place  (%s)\033[0m\n" \
            "{{ext_name}}" "$(du -sh {{ext_dir}}/{{ext_name}}.crx | cut -f1)"
    else
        echo "warning: .crx not found after packing — Chrome may have displayed an error."
        exit 1
    fi

# ── Development ───────────────────────────────────────────────────────────────

# Print load-unpacked instructions and open chrome://extensions/
dev:
    @echo ""
    @echo "  Load Unpacked steps:"
    @echo "    1.  chrome://extensions/"
    @echo "    2.  Enable Developer Mode (toggle, top-right)"
    @echo "    3.  Click 'Load Unpacked'"
    @echo "    4.  Select: {{ext_dir}}"
    @echo ""
    @open "chrome://extensions/" 2>/dev/null || true

# Watch for source changes and prompt manual reload (requires: brew install watchexec)
watch:
    watchexec \
        --watch "{{ext_dir}}" \
        --exts js,html,css,json \
        --ignore "*.zip,*.crx,*.pem,*.DS_Store" \
        -- echo "  ↺  Files changed — reload the extension card in chrome://extensions/"

# ── Quality ───────────────────────────────────────────────────────────────────

# Validate manifest and confirm all required files exist
validate:
    #!/usr/bin/env bash
    set -euo pipefail
    ok=0; fail=0

    check() {
        if [[ -f "{{ext_dir}}/$1" ]]; then
            printf "  \033[92m✓\033[0m  %s\n" "$1"
            ((ok+=1))
        else
            printf "  \033[91m✗\033[0m  %-40s  ← MISSING\n" "$1"
            ((fail+=1))
        fi
    }

    echo "Required files:"
    check manifest.json
    check background.js
    check popup.html;    check popup.js;    check popup.css
    check options.html;  check options.js;  check options.css
    check content/classroom.js
    check content/outlook.js
    check content/oncourse.js
    check icons/icon16.png;  check icons/icon32.png
    check icons/icon48.png;  check icons/icon128.png

    echo ""
    echo "Manifest:"
    node -e "
    const m = require('{{ext_dir}}/manifest.json');
    if (m.manifest_version !== 3) throw new Error('Not MV3');
    if (!m.background?.service_worker) throw new Error('Missing service_worker');
    const perms = m.permissions ?? [];
    const host  = m.host_permissions ?? [];
    console.log('  \x1b[92m✓\x1b[0m  MV3 · service_worker: ' + m.background.service_worker);
    console.log('  \x1b[92m✓\x1b[0m  permissions: [' + perms.join(', ') + ']');
    console.log('  \x1b[92m✓\x1b[0m  host_permissions: ' + host.length + ' entries');
    "

    echo ""
    if (( fail > 0 )); then
        printf "\033[91m%d file(s) missing — fix before packing.\033[0m\n" "$fail"
        exit 1
    fi
    printf "\033[92m✓ All %d files present.\033[0m\n" "$ok"

# Run ESLint over all extension JS (auto-bootstraps via npx)
lint:
    #!/usr/bin/env bash
    echo "Linting…"
    cd "{{ext_dir}}"
    npx --yes eslint \
        --env browser,es2022 \
        --parser-options ecmaVersion:2022 \
        --rule 'no-unused-vars: warn' \
        --rule 'no-undef: error' \
        background.js popup.js options.js content/classroom.js \
        content/outlook.js content/oncourse.js 2>&1 || true

# Scan for obvious security issues (eval, unescaped innerHTML, stray keys)
audit:
    #!/usr/bin/env bash
    cd "{{ext_dir}}"
    issues=0

    banner() { printf "\n  \033[93m⚠\033[0m  %s\n" "$1"; }

    echo "Security scan…"

    if grep -rn 'eval(' --include='*.js' . 2>/dev/null; then
        banner "eval() usage found — avoid in extensions"; ((issues+=1))
    fi

    # innerHTML assignments that carry string/template interpolation without esc()
    # Excludes: clearing (= ''), hardcoded HTML-only strings, and lines that do call esc()
    if grep -n 'innerHTML\s*=\s*`' popup.js options.js 2>/dev/null \
            | grep -v 'esc(' \
            | grep -v '^\s*//' \
            | grep -qv 'innerHTML\s*=\s*`\s*`'; then
        banner "Possible unescaped innerHTML with template literal — review manually"; ((issues+=1))
    fi

    if grep -rn 'sk-ant' --include='*.js' . 2>/dev/null; then
        banner "Possible API key literal in source"; ((issues+=1))
    fi

    if (( issues == 0 )); then
        printf "\033[92m✓ No obvious security issues.\033[0m\n"
    else
        printf "\n\033[91m%d issue(s) found.\033[0m\n" "$issues"
    fi

# ── Icons ─────────────────────────────────────────────────────────────────────

# Regenerate all PNG icons using the zero-dependency Node.js generator
icons:
    @echo "Generating icons…"
    node "{{ext_dir}}/icons/generate_icons.js"

# Quick visual check — opens icon128.png
inspect-icon: icons
    @open "{{ext_dir}}/icons/icon128.png" 2>/dev/null \
        || xdg-open "{{ext_dir}}/icons/icon128.png" 2>/dev/null \
        || echo "Open icons/icon128.png manually"

# ── Cleanup ───────────────────────────────────────────────────────────────────

# Remove build artifacts (.zip, .crx)
clean:
    @rm -f "{{ext_dir}}/{{ext_name}}.zip" "{{ext_dir}}/{{ext_name}}.crx"
    @printf "\033[92m✓ Removed zip + crx.\033[0m\n"

# Remove build artifacts AND generated icons (icons regenerate on next build)
clean-all: clean
    @rm -f "{{ext_dir}}/icons"/icon*.png
    @printf "\033[92m✓ Full clean — icons will regenerate on next build.\033[0m\n"
