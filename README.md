# ARC

AI-native terminal & agent runtime. See [docs/architecture.md](docs/architecture.md) for the high-level design and [CLAUDE.md](CLAUDE.md) for orientation when working in this repo with Claude Code.

## Quick start

```bash
pnpm install                 # install JS deps + link workspaces
pnpm tauri:dev               # run the Tauri desktop app (boots Vite + Rust shell)
```

Frontend only (browser, no PTY):d

```bash
pnpm dev
```

Type-check everything:

```bash
pnpm typecheck
cargo check --workspace
```

## Layout

```
apps/
  desktop/        Tauri shell (Rust). Depends on rust/* crates.
  frontend/       React + Vite UI. Loaded by Tauri at runtime.
packages/         Shared TS packages (UI, terminal, editor, agents, ...).
rust/             Rust crates (pty, ai-runtime, session-manager, agent-runtime, filesystem, git).
docs/             Architecture & decision records.
```

See [docs/architecture.md](docs/architecture.md) for what each piece does.

## Status

Phase 1 MVP scaffold. Working today: real PTY → xterm.js terminal tab. Stubbed: agents, AI providers, memory, editor, plugin system.
