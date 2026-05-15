# CLAUDE.md — Orientation for Claude Code

You are working in **ARC**, an AI-native terminal & agent runtime. This file is your starting point. Read it first, then [docs/architecture.md](docs/architecture.md) for the deeper map.

## What ARC is

A Tauri (Rust) + React (TS) desktop app that aims to combine:

- A real PTY-backed terminal (xterm.js front, `portable-pty` back)
- An embedded code editor (CodeMirror 6)
- Multi-agent orchestration with background execution
- Local + cloud AI providers behind one interface

Phase 1 (current) ships a **real PTY terminal tab + stub AI chat panel** end-to-end. Everything else in the spec is scaffolded but stubbed.

## Repo layout

```
apps/
  desktop/     Tauri shell. Rust crate that registers `pty_*` commands and
               serves apps/frontend's build (or dev server) inside a window.
               Depends on the /rust/* crates.
  frontend/    React + Vite + TS app. Pure UI. Talks to Rust via Tauri
               `invoke` and `listen` (see src/lib/tauri.ts).

packages/      Pure-TS packages, linked via pnpm workspaces.
  shared/        Cross-package types.
  provider-sdk/  Provider interface (Provider, ChatRequest, ChatChunk).
  ai-runtime/    Provider registry + the stub provider. Real providers go here.
  terminal/      Reserved — placeholder until we extract terminal logic out of
                 apps/frontend.
  editor/        Reserved — same idea for the editor.
  agents/        Agent descriptors (TS side). Pairs with rust/agent-runtime.
  mcp/           Reserved — MCP client.
  ui/            Reserved — shared UI primitives.

rust/          Cargo workspace members consumed by apps/desktop.
  pty/             ✅ PtyManager — spawn/write/resize/kill, streams output via
                   tokio::sync::mpsc. The only crate doing real work today.
  session-manager/ stub — workspace + tab persistence.
  agent-runtime/   stub — agent execution.
  filesystem/      stub — indexing + watch.
  git/             stub — diff/blame/log.

docs/          Architecture + decisions.
```

## Running it

```bash
pnpm install           # installs JS deps for all workspaces
pnpm tauri:dev         # boots Tauri → spawns vite → opens the window
```

Frontend-only (no Rust, no PTY):

```bash
pnpm dev               # opens http://127.0.0.1:5173 with a disabled terminal
```

Type-check / sanity:

```bash
pnpm typecheck
cargo check --workspace
```

## Key conventions

- **Tauri command names**: `<area>_<verb>` snake_case. PTY commands are `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`.
- **Event topics**: `<area>://<verb>/<id>`, e.g. `pty://data/<uuid>`. The frontend's `lib/tauri.ts` exposes typed wrappers — use those, don't hand-roll `invoke`/`listen` in components.
- **State**: Zustand stores in `apps/frontend/src/state/*`. One store per concern (workspace, chat). Components don't reach across stores.
- **Styling**: Tailwind, dark-first. Theme tokens are in `apps/frontend/tailwind.config.ts` (`bg-base`, `fg-base`, `accent`, etc.). Don't hardcode hex colors in components.
- **Rust modules**: One feature per crate (`arc-pty`, `arc-agent-runtime`, ...). The desktop app *composes* them; it shouldn't grow business logic of its own.
- **Errors crossing the IPC boundary**: Map to `String` at the command layer. Internal Rust code uses `anyhow::Result`.

## What's stubbed vs. real

| Area              | Status     | Notes                                                                  |
| ----------------- | ---------- | ---------------------------------------------------------------------- |
| PTY → xterm.js    | ✅ real    | Default shell (COMSPEC on Win, SHELL elsewhere), resize, kill on close |
| Tabs / workspace  | ✅ real    | In-memory only; persistence is Phase 2                                 |
| AI chat           | 🟡 stub   | UI works, provider just echoes. Wire real ones in `packages/ai-runtime` |
| Editor            | ⛔ stub   | Tab kind exists; no CodeMirror integration yet                          |
| Agent runtime     | ⛔ stub   | Types only                                                              |
| Memory / search   | ⛔ stub   | SQLite + embeddings not started                                         |
| MCP, plugins      | ⛔ stub   | Placeholder packages                                                    |
| Bundling / icons  | 🟡 placeholder | Icons are auto-generated placeholders. Replace before shipping.    |

## Working in this repo

- Prefer editing existing files over creating new ones. New crates/packages should appear in `Cargo.toml` workspace members and `pnpm-workspace.yaml` first.
- When adding a new Tauri command, update both `apps/desktop/src/commands/<area>.rs` AND `apps/frontend/src/lib/tauri.ts` so the typed wrapper stays in sync.
- Run `pnpm typecheck && cargo check --workspace` before finishing a change.
- The default shell on Windows is `cmd.exe` via `COMSPEC`. If you want PowerShell, pass `shell: "powershell.exe"` to `pty_spawn`.

## Reading order for new contributors

1. This file
2. `docs/architecture.md` — component map + IPC contract
3. `docs/decisions.md` — why we chose Tauri/Zustand/etc., recorded as ADRs
4. `apps/frontend/src/components/Terminal.tsx` — see how the PTY round-trip works in 90 lines
5. `rust/pty/src/lib.rs` — the matching Rust side
