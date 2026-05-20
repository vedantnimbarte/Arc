# ARC — AI-Native Terminal & Agent Runtime

[![License](https://img.shields.io/badge/license-TBD-blue)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/anthropics/arc)

**ARC** is a desktop terminal and AI agent runtime built with Tauri (Rust) and React (TypeScript). It combines a real PTY-backed terminal, an embedded code editor, multi-agent orchestration, and local + cloud AI providers behind one unified interface.

## What is ARC?

- **Real Terminal** — xterm.js frontend backed by portable-pty, supporting multiple shells (bash, zsh, PowerShell, cmd, Nu, WSL)
- **Code Editor** — CodeMirror 6 with syntax highlighting, file open/save, inline previews
- **AI Chat** — OpenAI, Anthropic, or local Ollama models with agent personas (Chat Assistant, Task Planner, Code Explainer, etc.)
- **Coding Agent** — Run `/agent <goal>` to spawn an autonomous agent that reads files, searches codebases, edits code, and runs shell commands—all gated by user approval
- **MCP Integration** — Connect Model Context Protocol (MCP) servers to give your agent access to third-party tools
- **Persistent Memory** — Workspace-scoped notes with full-text and vector search, powered by SQLite and tantivy
- **Git Introspection** — View branch info, diff, logs, and blame without leaving the terminal

## Feature Status

| Feature | Status | Notes |
|---------|--------|-------|
| PTY Terminal | ✅ Real | Multi-tab, shell picker, custom shell support |
| Code Editor | ✅ Real | CodeMirror 6, syntax highlighting, git-aware |
| AI Chat | ✅ Real | OpenAI, Anthropic, Ollama streaming |
| Coding Agent | ✅ V2 | Tool-using agent with approval gating, MCP tools |
| File Tree | ✅ Real | Watch for changes, search by content (BM25) |
| Session Persistence | ✅ V1 | SQLite-backed workspaces, tabs, chat history |
| Git Integration | ✅ V1 | status, log, diff, blame via git CLI |
| Command History | ✅ V1 | Fuzzy search, structured blocks with OSC 133 |
| Memory / Notes | ✅ V1 | Keyword FTS + vector embeddings (OpenAI/Ollama) |
| MCP Client | ✅ V2 | stdio + HTTP/SSE transports |
| Settings | ✅ Real | Provider keys (Keychain/Credential Manager), models, shell |
| Keyboard Shortcuts | ✅ Real | Customizable via Settings |
| Docker / Server | 🟡 Planned | Reserved for Phase 2 |
| Plugin System | 🟡 Planned | Phase 4 |

## Quick Start

### Desktop App (Tauri)

```bash
# Prerequisites: Node 20+, pnpm 9.x, Rust 1.80+
# See INSTALLATION.md for full setup

git clone https://github.com/anthropics/arc.git
cd arc

pnpm install                 # Install JS dependencies
pnpm tauri:dev               # Boot the app (Vite + Rust shell)
```

The Tauri window opens at `1280x820` with the terminal, editor, and file tree ready to use.

### Frontend Only (Browser, No Terminal)

To develop the UI in isolation without Rust dependencies:

```bash
pnpm dev                     # Open http://127.0.0.1:5173
```

**Limitations:** PTY, filesystem, and LLM features are stubbed (chat echoes locally).

## Documentation

### Getting Started
| Document | Audience | Content |
|----------|----------|---------|
| **[INSTALLATION.md](INSTALLATION.md)** | End-users, DevOps | Setup for all platforms, prerequisites, API key config, troubleshooting |
| **[FEATURES.md](FEATURES.md)** | All users | How-to guides for Terminal, Editor, Chat, Agent, Search, Memory |

### For Developers
| Document | Audience | Content |
|----------|----------|---------|
| **[DEVELOPMENT.md](DEVELOPMENT.md)** | Contributors | Local dev, code conventions, guides for adding Tauri commands, components, Rust crates |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Contributors | System layers, IPC contract, all 57 commands, Zustand stores, SQLite schema, data flows |
| **[API_REFERENCE.md](API_REFERENCE.md)** | Developers | Complete API docs for all Tauri commands with signatures, examples, errors |

### For Advanced Users & Integrators
| Document | Audience | Content |
|----------|----------|---------|
| **[AGENTS.md](AGENTS.md)** | Advanced users | How agents work, built-in tools, approval gating, custom agents, MCP integration |
| **[MCP_INTEGRATION.md](MCP_INTEGRATION.md)** | Integrators | Building MCP servers, connecting to ARC, examples (web search, databases) |
| **[SECURITY.md](SECURITY.md)** | Security-conscious users | Credential vault, data encryption, agent security, API key best practices |

### Reference & Deep Dives
| Document | Audience | Content |
|----------|----------|---------|
| **[FAQ_AND_TROUBLESHOOTING.md](FAQ_AND_TROUBLESHOOTING.md)** | All users | Common questions, performance tips, debugging, error solutions |
| **[GLOSSARY.md](GLOSSARY.md)** | All users | Definitions of technical terms (MCP, agent, tool, approval, workspace, etc.) |
| **[CLAUDE.md](CLAUDE.md)** | Claude Code users | Orientation when editing this repo |
| **[docs/architecture.md](docs/architecture.md)** | Deep dive | Layered design, IPC pipelines, PTY flow, state management |
| **[docs/decisions.md](docs/decisions.md)** | History | Why Tauri, Zustand, crate split, etc. (ADRs) |

### Rust Crates (Reference)
- **[rust/pty/README.md](rust/pty/README.md)** — PTY process spawning
- **[rust/ai-runtime/README.md](rust/ai-runtime/README.md)** — LLM streaming (OpenAI, Anthropic, Ollama)
- **[rust/filesystem/README.md](rust/filesystem/README.md)** — File ops, watching, BM25 search
- **[rust/git/README.md](rust/git/README.md)** — Git status, log, diff, blame
- **[rust/session-manager/README.md](rust/session-manager/README.md)** — SQLite persistence (sessions, chat, memory)
- **[rust/agent-runtime/README.md](rust/agent-runtime/README.md)** — Agentic loop with approval gating

## Tech Stack

**Frontend:** React 18 + Vite + TypeScript, Zustand (state), CodeMirror 6 (editor), xterm.js (terminal), Tailwind CSS (styling)

**Desktop Shell:** Tauri 2 (app shell), IPC via invoke/listen

**Backend:** Rust 1.80+ with:
- `arc-pty` — PTY process management (portable-pty)
- `arc-ai-runtime` — Streaming LLM providers (reqwest + eventsource)
- `arc-session-manager` — SQLite persistence (sqlx)
- `arc-agent-runtime` — Agentic loop with tool-using
- `arc-filesystem` — File watching, indexing, search (notify, tantivy)
- `arc-git` — Git introspection (child process, porcelain output)

**Database:** SQLite 3 (bundled), tantivy 0.22 (BM25 full-text search)

**Credentials:** OS credential vault (Keychain on macOS, Credential Manager on Windows)

## Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| **macOS** | ✅ Tested | 12+ (x86_64 + Apple Silicon) |
| **Windows** | ✅ Tested | 10+ (WebView2 required) |
| **Linux** | ✅ Tested | gtk3 (WebKit2GTK) required |

## Contributing

We welcome contributions! Start with [DEVELOPMENT.md](DEVELOPMENT.md) to learn our code conventions and how to add features. Before submitting a PR:

```bash
pnpm typecheck               # Type-check all TypeScript
cargo check --workspace      # Check all Rust crates
pnpm lint && pnpm format     # Lint and format code
```

See [docs/decisions.md](docs/decisions.md) for the architectural principles behind this project.

## License

TBD — see [LICENSE](LICENSE) (placeholder).

## Questions?

- **Setup issues?** Check [INSTALLATION.md](INSTALLATION.md#troubleshooting) for common fixes
- **How does it work?** Start with [ARCHITECTURE.md](ARCHITECTURE.md)
- **Adding a feature?** See [DEVELOPMENT.md](DEVELOPMENT.md)
- **Working with Claude Code?** Read [CLAUDE.md](CLAUDE.md)