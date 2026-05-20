# arc-session-manager — SQLite Persistence

SQLite-backed persistence layer for sessions, tabs, chat, commands, and memory.

## What It Does

- **Sessions & Workspaces:** Save/load workspace state
- **Tabs:** Persist open terminal and editor tabs
- **Chat:** Store conversations and messages
- **Commands:** Log and search executed commands
- **Memory:** Save notes with FTS5 and vector search
- **Migrations:** Auto-run schema migrations on startup

## Key Types

- `SessionStore` — Main persistence interface
- `WorkspaceState` — Tabs, active tab, session ID
- `ChatMessage` — Chat message with role and content
- `MemoryEntry` — Saved note with embeddings

## Database Schema

| Table | Purpose |
|-------|---------|
| `sessions` | Workspace metadata |
| `tabs` | Open terminal/editor tabs |
| `chat_conversations` | Chat sessions |
| `chat_messages` | Individual messages |
| `command_history` | Executed commands |
| `agent_runs` | Agent execution logs |
| `memory_entries` | User notes |
| `memory_fts` | Full-text index (FTS5 virtual table) |
| `embedding` | Vector embeddings for memory |

## Key Functions

```rust
pub async fn session_load(&self) -> Result<SessionState>;
pub async fn session_save_tabs(&self, tabs: Vec<Tab>) -> Result<()>;
pub async fn chat_append(&self, conv_id: &str, message: &str) -> Result<ChatMessage>;
pub async fn memory_save(&self, title: &str, content: &str) -> Result<MemoryEntry>;
pub async fn memory_search(&self, query: &str) -> Result<Vec<SearchHit>>;
```

## Configuration

Database auto-opens at:
- **macOS:** `~/Library/Application Support/dev.arc.terminal/arc.db`
- **Windows:** `%APPDATA%\dev.arc.terminal\arc.db`
- **Linux:** `~/.local/share/dev.arc.terminal/arc.db`

## Migrations

Schema changes are applied automatically on startup via sqlx migrations in `migrations/`.

## Performance Notes

- FTS5 index is queryable for memory search
- Vector search uses cosine similarity on embedding BLOBs
- Command history is queryable with pagination

## See Also

- `apps/desktop/src/commands/session.rs` — Tauri command layer
- `apps/frontend/src/state/workspace.ts` — Frontend state sync
- `apps/frontend/src/state/chat.ts` — Chat state hydration
