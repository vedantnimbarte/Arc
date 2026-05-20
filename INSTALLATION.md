# Installation Guide — ARC

This guide covers all deployment modes: **desktop app** (Tauri), **browser frontend** (development only), and setup notes for **server/Docker** (planned).

## Prerequisites

### Required

- **Node.js** 20.12 or later (check: `node --version`)
- **pnpm** 9.15 or later (install: `npm install -g pnpm`, then check: `pnpm --version`)
- **Rust** 1.80 or later (install from [rustup.rs](https://rustup.rs), then check: `rustc --version`)
- **Git** (any recent version)

### Platform-Specific: Tauri Dependencies

If you plan to run the desktop app, install the Tauri prerequisites for your OS:

#### macOS
- **Xcode Command Line Tools** (required for C compilers and SDK headers):
  ```bash
  xcode-select --install
  ```
- **Minimum OS:** macOS 12

#### Windows
- **WebView2 Runtime** (required by Tauri 2):
  - Download and install from https://developer.microsoft.com/en-us/microsoft-edge/webview2/
  - Or if you have Microsoft Edge 92+ installed, WebView2 is already present
- **Microsoft Visual C++ Build Tools** (for Rust compilation):
  - Download from https://visualstudio.microsoft.com/visual-cpp-build-tools/
  - Or install the full Visual Studio with C++ support
- **Minimum OS:** Windows 10 Build 19041+

#### Linux
- **GTK 3** development libraries and **WebKit2GTK** (Tauri uses WebKit for rendering):
  - **Debian/Ubuntu:** `sudo apt-get install libgtk-3-0 libwebkit2gtk-4.1-0 libwebkit2gtk-4.1-dev`
  - **Fedora/RHEL:** `sudo dnf install gtk3 webkit2gtk4-devel`
  - **Arch:** `sudo pacman -S gtk3 webkit2gtk`
  - **Alpine:** `apk add gtk+3.0-dev webkitgtk-dev`

## Installation Steps

### 1. Clone the Repository

```bash
git clone https://github.com/anthropics/arc.git
cd arc
```

### 2. Install JavaScript Dependencies

```bash
pnpm install
```

This installs Node dependencies for all workspaces (frontend, desktop, and shared packages) and links them via pnpm.

Expect: ~2–5 minutes depending on your connection and disk speed.

### 3. Verify Installation

```bash
pnpm typecheck
cargo check --workspace
```

If both commands complete without errors, you're ready to run the app.

---

## Running ARC

### Option A: Desktop App (Tauri) — Recommended

This launches the full app with terminal, editor, file tree, and AI chat.

```bash
pnpm tauri:dev
```

**What happens:**
1. Rust backend compiles (first run: ~3–5 minutes)
2. Vite frontend dev server starts at http://127.0.0.1:5173 (hot reload enabled)
3. Tauri window opens, loads the frontend from the dev server
4. PTY, AI, filesystem, and all other features are live

**Keyboard shortcuts:**
- `Ctrl+T` / `Cmd+T` — New terminal tab
- `Ctrl+,` / `Cmd+,` — Settings (set API keys here)
- `Ctrl+J` / `Cmd+J` — Toggle AI chat popover
- `Ctrl+P` / `Cmd+P` — Search files
- `Ctrl+R` / `Cmd+R` — Command history
- See **Settings > Keyboard Shortcuts** for the full list (editable)

**Logs:**
- Environment variable `RUST_LOG` controls Rust logging (default: `arc=debug,...,info`)
  ```bash
  RUST_LOG=arc=trace pnpm tauri:dev     # More verbose
  ```
- Rust logs appear in the terminal where you ran `pnpm tauri:dev`
- Frontend console is in the DevTools window (Ctrl+Shift+I / Cmd+Option+I in the Tauri window)

### Option B: Frontend Only (Browser, No Terminal)

For UI development without Rust compilation:

```bash
pnpm dev
```

Opens http://127.0.0.1:5173 in your default browser. Hot reload is enabled for React components.

**Limitations:**
- No PTY (terminal is stubbed)
- No filesystem access (file tree is read-only stub)
- No LLM streaming (chat echoes locally)
- No agent runtime
- Useful for: styling, layout, UI logic, state management testing

**Why this mode?**
- Faster feedback loop (no Rust recompilation)
- Separates frontend and backend concerns
- Good for designers and frontend-focused developers

### Option C: Building for Distribution

To create an optimized, signed app bundle for macOS/Windows/Linux:

```bash
pnpm tauri:build
```

Artifacts appear in `apps/desktop/src-tauri/target/release/bundle/`:
- **macOS:** `.dmg` (disk image) and `.app` (signed if you have a dev certificate)
- **Windows:** `.msi` (installer) and `.exe` (standalone)
- **Linux:** `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL), `.AppImage` (universal)

**Sign & notarize (macOS/Windows):**
- macOS: See [Tauri docs on codesigning](https://tauri.app/v1/guides/distribution/sign-macos/)
- Windows: Set `WINDOWS_SIGN_*` env vars; see [Tauri docs](https://tauri.app/v1/guides/distribution/sign-windows/)

---

## Configuration

### API Keys & LLM Providers

Launch the app and open **Settings** (`Ctrl+,` / `Cmd+,`):

1. **Provider** dropdown — choose OpenAI, Anthropic (recommended: Claude 3.5 Sonnet), or Ollama
2. **API Key** field — paste your key; it's encrypted and stored in your OS credential vault (Keychain on macOS, Credential Manager on Windows, sync-secret-service on Linux)
3. **Model** field (optional) — override the default model per provider
4. **Base URL** field (optional) — for self-hosted endpoints (e.g., local Ollama at `http://127.0.0.1:11434/v1`)

**Supported Providers:**
- **OpenAI:** Get a key at https://platform.openai.com/api-keys; default model `gpt-4o-mini`
- **Anthropic:** Get a key at https://console.anthropic.com; default model `claude-sonnet-4-6`
- **Ollama:** Run locally (`ollama serve`); default model `llama3.2:1b`

Keys are **never saved to disk in plaintext**—they live in your OS credential vault only.

### Default Shell

In **Settings > Terminal**, choose your preferred shell:
- **Windows:** cmd, PowerShell, pwsh, bash (Git Bash), Nu, WSL bash
- **macOS/Linux:** bash, zsh, fish, Nu, sh

Or enter a custom path (e.g., `/opt/homebrew/bin/fish`).

### Workspace Root

The file tree starts at your system default (home directory). Click the folder icon in the file tree header to choose a different root. Your choice persists across sessions.

---

## Data & Configuration Locations

### Data Directory

ARC stores sessions, chat history, and the search index in a per-platform data directory:

- **macOS:** `~/Library/Application Support/dev.arc.terminal/`
- **Windows:** `%APPDATA%\dev.arc.terminal\` (e.g., `C:\Users\<You>\AppData\Roaming\dev.arc.terminal\`)
- **Linux:** `~/.local/share/dev.arc.terminal/`

Inside:
```
arc.db                      # SQLite database (sessions, tabs, chat, memory, git logs)
index/<workspace-hash>/     # tantivy search index (rebuilt per workspace root)
```

**Backup:** Copy the data directory to safely preserve your sessions and chat history.

### Settings

Frontend settings (provider choice, model, system prompt, keybindings) are persisted to:
- **Browser localStorage** if running `pnpm dev` (cleared on browser cache clear)
- **OS credential vault** for API keys

In the Tauri app, settings are **not** a plain text file; they're managed via the Settings dialog only.

---

## Troubleshooting

### "Rust toolchain not found"
**Error:** `error: could not compile 'arc-desktop'` or `rustup: command not found`

**Fix:** Install Rust from [rustup.rs](https://rustup.rs) and run:
```bash
rustup update stable
rustup component add rustfmt clippy
```

### "WebView2 is missing" (Windows)
**Error:** `failed to create webview instance` or "WebView2 not found"

**Fix:** Download and install WebView2 from https://developer.microsoft.com/en-us/microsoft-edge/webview2/ (or reinstall if already present).

### "GTK/WebKit not found" (Linux)
**Error:** `error: 'glib.h' file not found` or `WebKit2GTK not found`

**Fix:** Install dev libraries:
```bash
# Debian/Ubuntu
sudo apt-get install libgtk-3-dev libwebkit2gtk-4.1-dev

# Fedora/RHEL
sudo dnf install gtk3-devel webkit2gtk4-devel

# Arch
sudo pacman -S gtk3 webkit2gtk
```

### "pnpm version mismatch"
**Error:** `this project uses pnpm X.Y.Z, but you have X.Y.Z installed`

**Fix:**
```bash
pnpm env use --global 9.15.9   # or latest 9.x
```

Or use `corepack` (bundled with Node 16.13+):
```bash
corepack enable pnpm
corepack use pnpm@9.15.9
```

### "workspace resolution failed" (Rust)
**Error:** `error: failed to resolve: use of undeclared type or crate`

**Fix:**
```bash
cargo clean
cargo check --workspace
```

### "Terminal says 'command not found'" inside ARC
**Note:** The PTY inherits your shell PATH. If a command doesn't exist, it's missing from your system, not ARC.

**Fix:** Verify the command exists in your default shell outside ARC:
```bash
which <command>     # macOS/Linux
where <command>     # Windows (PowerShell)
```

If it exists but ARC can't find it, restart ARC to refresh the inherited environment.

### Chat is not connecting to LLM
**Error:** "Network error" or "API key invalid"

**Steps:**
1. Open Settings (`Ctrl+,` / `Cmd+,`) and verify:
   - Provider is set correctly
   - API key is pasted (not empty)
   - Model name matches provider (e.g., `claude-sonnet-4-6` for Anthropic)
2. Check your internet connection
3. Verify your API key is active on the provider's dashboard
4. If using a custom Base URL (Ollama, etc.), test connectivity:
   ```bash
   curl -X POST http://localhost:11434/api/generate \
     -H 'Content-Type: application/json' \
     -d '{"model":"llama3.2:1b","prompt":"test","stream":false}'
   ```

### Logs are too verbose or not verbose enough
**Control Rust logging:**
```bash
RUST_LOG=arc=debug pnpm tauri:dev       # Less verbose
RUST_LOG=arc=trace pnpm tauri:dev       # Most verbose
RUST_LOG=arc=warn pnpm tauri:dev        # Only warnings/errors
```

**Frontend logs:** Open DevTools (Ctrl+Shift+I / Cmd+Option+I) and check Console tab.

---

## Next Steps

- **First run?** Open Settings and set up your AI provider (OpenAI/Anthropic/Ollama)
- **Get started with the terminal:** Type commands as you would in any shell
- **Use the agent:** Type `/agent <goal>` in the chat to spawn a coding agent (e.g., `/agent fix the typo in main.rs`)
- **Customize keyboard shortcuts:** Settings > Keyboard Shortcuts
- **Learn the architecture:** Read [ARCHITECTURE.md](ARCHITECTURE.md)
- **Contribute:** See [DEVELOPMENT.md](DEVELOPMENT.md)

For more help, see [README.md](README.md) or the other docs.
