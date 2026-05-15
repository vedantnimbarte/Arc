# Architecture

> This is the design doc, not the spec. The spec (product requirements) is the README-style document the project was bootstrapped from. This file explains **how** the code is laid out and **why**.

## Layers

```
 ┌──────────────────────────────────────────────────────────────┐
 │ Frontend (React + Vite, apps/frontend)                       │
 │  ├─ Terminal (xterm.js)        ├─ Editor (CodeMirror 6, TBD) │
 │  ├─ ChatPanel (stub provider)  ├─ TabBar / StatusBar         │
 │  └─ Zustand stores (workspace, chat)                         │
 └──────────────────────────────────────────────────────────────┘
                      │   invoke / listen (Tauri IPC)
                      ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ Tauri shell (Rust, apps/desktop)                             │
 │  Command surface: pty_spawn / pty_write / pty_resize /       │
 │                   pty_kill                                   │
 │  Event surface:   pty://data/<id>, pty://exit/<id>           │
 └──────────────────────────────────────────────────────────────┘
                      │
                      ▼
 ┌──────────────────────────────────────────────────────────────┐
 │ Rust crates (rust/*)                                         │
 │  arc-pty           ✅ portable-pty wrapper                   │
 │  arc-session-mgr   ⛔ persistence (SQLite)                   │
 │  arc-agent-runtime ⛔ planner/executor/memory                │
 │  arc-filesystem    ⛔ index + watcher (notify + tantivy)     │
 │  arc-git           ⛔ git operations                          │
 └──────────────────────────────────────────────────────────────┘
```

## Frontend ↔ Rust IPC contract

We use Tauri's `invoke` (command call) and `listen` (event subscription). Binary data crosses as JSON arrays of bytes — fine for MVP, swap to channels or base64 if profiling shows it matters.

| Direction | Channel                  | Payload                                       |
| --------- | ------------------------ | --------------------------------------------- |
| TS → Rust | `invoke("pty_spawn",…)`  | `{ opts: { shell, cwd, cols, rows } } → id`   |
| TS → Rust | `invoke("pty_write",…)`  | `{ id, data: string }`                        |
| TS → Rust | `invoke("pty_resize",…)` | `{ id, cols, rows }`                          |
| TS → Rust | `invoke("pty_kill",…)`   | `{ id }`                                      |
| Rust → TS | `pty://data/<id>` event  | `{ id, bytes: number[] }` — raw shell output  |
| Rust → TS | `pty://exit/<id>` event  | `{ id, code: number \| null }`                |

All commands return `Result<T, String>` from Rust — errors are stringified at the boundary so the frontend gets a human-readable message without leaking Rust types.

**Typed wrapper**: `apps/frontend/src/lib/tauri.ts` is the only file allowed to call `invoke` / `listen` directly. Everything else imports the typed helpers from there.

## PTY pipeline

```
        ┌────────────────────┐
TS:     │ xterm.onData(data) │ ──── invoke("pty_write") ──┐
        └────────────────────┘                            │
                                                          ▼
                                              ┌─────────────────────┐
                                              │ PtyManager.write    │
                                              │  → writer.write_all │
                                              └─────────────────────┘
                                                          │
                                                          ▼
                                                ┌──────────────────┐
                                                │ shell stdin (PTY)│
                                                └──────────────────┘

                                                ┌──────────────────┐
                                                │ shell stdout (PTY)│
                                                └──────────────────┘
                                                          │
                              reader thread (blocking) ───┘
                                          │
                                          ▼
                              tokio::mpsc::Receiver<Vec<u8>>
                                          │
                              tauri::Emitter::emit("pty://data/<id>")
                                          │
                                          ▼
                              TS: listen("pty://data/<id>") → term.write
```

Reader I/O is blocking (portable-pty is synchronous), so it runs on a dedicated OS thread per session. The Tokio runtime is only used for the mpsc and for Tauri's event emission task.

## State management

Zustand was chosen over Redux Toolkit for two reasons:

1. Less boilerplate per slice — slices are just functions returning the initial shape.
2. Equally easy to subscribe selectively (avoids over-rendering).

One store per concern. Cross-store reads happen at the component level, never inside a store action.

## Theming

Tailwind in dark-first mode, with semantic tokens (`bg-base`, `bg-panel`, `fg-muted`, `accent`). The terminal's xterm theme mirrors these tokens so the terminal blends with the UI chrome.

## Crate split

Each Rust crate owns **one** problem:

- `arc-pty` — terminal I/O. Nothing else.
- `arc-session-manager` — persistence. When wired, owns the SQLite handle.
- `arc-agent-runtime` — planner + executor + memory. The biggest crate-to-be.
- `arc-filesystem` — watching, indexing, search. Will pull in `notify` + `tantivy`.
- `arc-git` — diff/blame/log. Will pull in `gix` (or `git2` if we need libgit2 features).

The desktop crate (`arc-desktop`) is a *thin composition layer* — it owns Tauri config, the command surface, and wiring, but no domain logic. Every meaningful feature should live in a `/rust` crate so it's testable without Tauri and reusable from a CLI or test binary.

## What this scaffold deliberately doesn't include

- **No sqlite/sqlx yet.** Will land with the session manager.
- **No reqwest in ai-runtime.** Real providers will add it; the stub doesn't need HTTP.
- **No notify/tantivy.** Filesystem indexing is Phase 2.
- **No plugin runtime.** Phase 4.
- **No CI.** Add GitHub Actions when the first agent lands.

## Next steps (engineering)

In priority order:

1. **Persistence** (arc-session-manager): SQLite schema from the spec §11, restore tabs on launch.
2. **Real AI providers**: OpenAI + Anthropic + Ollama in packages/ai-runtime, with the stub kept as a fallback.
3. **Command blocks**: parse xterm output into structured "command + output" blocks (Warp's signature feature). Needs shell integration via OSC 133.
4. **Editor**: CodeMirror tab kind with file open/save commands.
5. **Agent runtime v0**: a single coding agent that can read/write files and run shell commands, gated behind explicit user approval.
