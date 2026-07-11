# arc-session-manager — SQLite Persistence

SQLite-backed persistence layer for workspaces, tabs, command history, settings, SSH hosts/keys,
and the API-client tool's collections.

## What It Does

- **Sessions & Workspaces:** Save/load workspace state
- **Tabs:** Persist open terminal, editor, and other tabs (+ pane layout)
- **Commands:** Log and search executed commands (with exit codes when OSC 133 is present)
- **Settings:** Persist the user-settings blob
- **SSH:** Saved hosts, keys, and per-session logs
- **API Client:** Collections, requests, environments, and history
- **Migrations:** Auto-run schema migrations on startup

## Key Types

- `SessionStore` — Main persistence interface (a cheaply-cloneable `SqlitePool` wrapper)
- `SessionState` — Tabs, active tab, session metadata
- `CommandRecord` — A logged command with timing and exit code

## Key Modules

Each table has a sibling module that owns its repository functions: `workspaces`, `tabs`,
`commands`, `settings`, `ssh`, `apiclient`.

## Configuration

Database auto-opens at:
- **macOS:** `~/Library/Application Support/arc/arc.db`
- **Windows:** `%APPDATA%\arc\arc.db`
- **Linux:** `~/.local/share/arc/arc.db`

## Migrations

Schema changes are applied automatically on startup via sqlx migrations in `migrations/`.
Migrations are immutable once shipped — add a new forward migration rather than editing an old
one, or existing databases fail checksum validation.

## See Also

- `apps/desktop/src/commands/session.rs` — Tauri command layer
- `apps/frontend/src/state/workspace.ts` — Frontend state sync
