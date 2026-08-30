# ARC — Terminal, Editor & Developer Workspace

<div align="center">
  <img src="apps/desktop/icons/icon.png" alt="ARC Logo" width="128" height="128" />
</div>

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/vedantnimbarte/Arc)

**ARC** is a desktop developer workspace built with Tauri (Rust) and React (TypeScript). It
unifies a real PTY-backed terminal, an embedded code editor, a git-aware file tree, source
control, SSH, and a REST API client into a single, cohesive interface.

It also speaks to [Wingman](https://github.com/vedantnimbarte/Wingman), a terminal coding
agent, over its HTTP/SSE API — giving ARC an agent panel, a pilot board, and a review queue
for agent-authored changes. That integration is entirely optional; ARC ships and runs without
it.

## Features

- **Real PTY Terminal** — xterm.js frontend backed by portable-pty, supporting bash, zsh,
  PowerShell, cmd, Nu, WSL, and custom shells. Clickable file paths, smart-paste warnings,
  long-command notifications, and per-tab command history (OSC 133).
- **Code Editor** — CodeMirror 6 with syntax highlighting, multi-cursor, optional Vim mode,
  optional LSP (diagnostics/hover/completion), and real-time file watching.
- **File Tree & Search** — Browse, open, and manage files with git status decorations, plus
  BM25 full-text search backed by a tantivy index.
- **Git Integration** — Branch status, diffs, logs, blame, staging/commit, worktrees,
  interactive rebase, cherry-pick, and GitHub pull requests, all from the UI.
- **SSH Client** — Pure-Rust SSH (russh) with saved hosts, key generation/import, and
  per-session logs.
- **API Client** — A built-in Postman-style REST client (collections, environments, history).
- **Tabs & Workspaces** — Split panes, tab groups, and session state persisted to SQLite.
- **Wingman Agents** *(optional)* — Connect a `wingman serve` daemon to get an agent panel
  with streamed turns (text, reasoning, tool calls, verification results, token cost), the
  pilot board of agent runs, and a review queue that opens each finished task's git worktree
  in ARC's own diff viewer.
- **In-App Updates** — ARC checks for a new release on launch, offers it in a corner
  card, and installs it in place. Every download is minisign-verified against the key
  baked into the build before it runs. Turn the check off in **Settings → About**.
- **⌘K Command Bar** — Describe a command in plain English and get it typed onto the
  shell prompt for review; nothing runs until you press Enter. Needs an Anthropic API key
  (**Settings → Terminal**), stored in your OS credential vault.
- **AI CLI Launcher** — Optionally launch external coding CLIs (Claude Code, Codex, OpenCode,
  Wingman) in a terminal tab when installed on your PATH.

## Quick Start

```bash
# Prerequisites: Node 20+, pnpm 9.x, Rust 1.80+

git clone https://github.com/vedantnimbarte/Arc.git
cd arc

pnpm install                 # Install JS dependencies
pnpm tauri:dev               # Boot the app (Vite + Rust shell)
```

### Frontend only (browser, no terminal)

```bash
pnpm dev                     # Open http://127.0.0.1:5173
```

PTY and filesystem features are stubbed in the browser-only build.

### Connecting Wingman (optional)

```bash
wingman serve                # defaults to 127.0.0.1:8787, no token on loopback
```

Then set that address in **Settings → Wingman**. The agent panel appears in the sidebar and
the pilot board opens from the command palette. A token is only needed when the daemon binds
a non-loopback address; ARC stores it in your OS credential vault, not in its database.

## Tech Stack

**Frontend:** React 18 + Vite + TypeScript · Zustand state · CodeMirror 6 · xterm.js ·
Tailwind CSS · Vitest.

**Desktop shell:** Tauri 2, IPC via typed `invoke`/`listen` wrappers in `lib/tauri.ts`.

**Backend (Rust 1.80+):**
- `arc-pty` — PTY spawn/resize/kill (portable-pty, tokio)
- `arc-filesystem` — file ops, watching, BM25 search/indexing (notify, tantivy)
- `arc-git` / `arc-git-host` — git introspection and GitHub PRs
- `arc-session-manager` — SQLite persistence (sqlx): workspaces, tabs, command history
- `arc-ssh` — pure-Rust SSH client (russh)
- `arc-lsp` — language-server client (stdio JSON-RPC)
- `arc-http-client` / `arc-project-config` — REST client engine + `.arc/config.toml` loader
- `arc-wingman` — client for a `wingman serve` daemon (board, pilot runs, streaming turns)

**Storage:** SQLite (bundled) at `<data_dir>/arc/arc.db`; tantivy index at `<data_dir>/arc/index/`.

**Credentials:** OS credential vault (Keychain / Credential Manager / secret-service) via the
`keyring` crate — used for SSH passphrases and GitHub tokens.

### Workspace structure

```
apps/frontend/        React UI (Vite, TypeScript)
apps/desktop/         Tauri shell (Rust, IPC commands)
packages/             Shared TS packages (types, editor/terminal/ui tokens)
rust/                 Cargo workspace (pty, filesystem, git, ssh, lsp, ...)
```

### Cutting a release

```bash
git tag v0.2.0 && git push origin v0.2.0
```

That builds installers for all three platforms into a **draft** GitHub Release. The
updater manifest lives at `releases/latest/download/latest.json`, and `/latest/` skips
drafts — nobody is offered the update until you publish the release.

Signing the update artifacts needs two repo secrets, generated once with
`pnpm --filter @arc/desktop exec tauri signer generate`:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the generated private key file |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password (empty string if you set none) |

The matching public key is committed in `apps/desktop/tauri.conf.json`. Lose the private
key and existing installs can never be updated again — back it up.

## Platform Support

| Platform | Notes |
|----------|-------|
| **macOS** | 12+ (x86_64 + Apple Silicon) |
| **Windows** | 10+ (WebView2 required) |
| **Linux** | gtk3 / WebKit2GTK required |

## Before submitting a PR

```bash
pnpm typecheck               # Type-check all TypeScript
cargo check --workspace      # Check all Rust crates
pnpm test                    # Run the Vitest suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

ARC is licensed under the [MIT License](LICENSE).
