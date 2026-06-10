//! arc-session-manager — workspace, tab, chat, command-history, agent-run,
//! and memory persistence backed by SQLite via sqlx.
//!
//! Each table has a sibling module that owns its repository functions:
//! [`workspaces`], [`tabs`], [`chat`], [`commands`], [`agent`], [`memory`].
//! `memory_entries` is paired with an FTS5 virtual table (`memory_fts`)
//! kept in sync by triggers, so `memory::search` runs through bm25.
//!
//! The store is cheaply cloneable (it's just a wrapped `SqlitePool`), so it
//! can be `.manage()`d in Tauri and handed to commands as `State<SessionStore>`.

use std::path::Path;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use thiserror::Error;

pub mod agent;
pub mod apiclient;
pub mod chat;
pub mod commands;
pub mod memory;
pub mod settings;
pub mod ssh;
pub mod tabs;
pub mod workspaces;

pub use agent::AgentRun;
pub use chat::{ChatConversation, ChatMessage, ChatRole};
pub use commands::CommandRecord;
pub use memory::{MemoryEntry, MemoryHit};
pub use ssh::{SshHost, SshHostInput, SshKey, SshSessionLogEntry};
// Re-export so downstream crates (e.g. apps/desktop) that hold a
// `&SessionStore` can name the pool type without taking a direct sqlx dep.
pub use sqlx::SqlitePool;
pub use tabs::{Session, SessionState, Tab, TabInput, TabKind};
pub use workspaces::Workspace;

#[derive(Debug, Error)]
pub enum Error {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration failed: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("could not resolve user data directory")]
    NoDataDir,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, Clone)]
pub struct SessionStore {
    pool: SqlitePool,
}

impl SessionStore {
    /// Open (or create) the ARC database in the platform user-data dir.
    ///   Linux:   ~/.local/share/arc/arc.db
    ///   macOS:   ~/Library/Application Support/arc/arc.db
    ///   Windows: %APPDATA%\arc\arc.db
    pub async fn open_default() -> Result<Self> {
        let mut dir = dirs::data_dir().ok_or(Error::NoDataDir)?;
        dir.push("arc");
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join("arc.db");
        tracing::info!(?path, "opening session store");
        Self::open_at(&path).await
    }

    pub async fn open_at(path: &Path) -> Result<Self> {
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await?;

        sqlx::migrate!("./migrations").run(&pool).await?;

        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

/// Current unix-epoch milliseconds. Used as the canonical timestamp across
/// every table so values round-trip cleanly to JS `Date.now()`.
pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fresh_store() -> SessionStore {
        let path = std::env::temp_dir().join(format!(
            "arc-test-{}.db",
            uuid::Uuid::new_v4()
        ));
        SessionStore::open_at(&path).await.expect("open store")
    }

    #[tokio::test]
    async fn migrations_run_cleanly() {
        let _store = fresh_store().await;
    }

    #[tokio::test]
    async fn workspaces_roundtrip() {
        let store = fresh_store().await;
        let ws = workspaces::upsert(store.pool(), "ARC", "/tmp/arc")
            .await
            .expect("upsert");
        assert_eq!(ws.name, "ARC");

        let list = workspaces::list(store.pool()).await.expect("list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, ws.id);
    }

    #[tokio::test]
    async fn tabs_replace_all_for_session() {
        let store = fresh_store().await;
        let state = tabs::current_or_create(store.pool())
            .await
            .expect("session");

        let inputs = vec![
            TabInput {
                id: "t1".into(),
                title: "shell".into(),
                kind: TabKind::Terminal,
                file_path: None,
                preview_url: None,
                apiclient_state_json: None,
            },
            TabInput {
                id: "t2".into(),
                title: "main.rs".into(),
                kind: TabKind::Editor,
                file_path: Some("/tmp/main.rs".into()),
                preview_url: None,
                apiclient_state_json: None,
            },
        ];
        tabs::save_tabs(store.pool(), &state.session.id, &inputs, Some("t2"), None)
            .await
            .expect("save");

        let again = tabs::current_or_create(store.pool())
            .await
            .expect("reload");
        assert_eq!(again.tabs.len(), 2);
        assert_eq!(again.session.active_tab_id.as_deref(), Some("t2"));
    }

    #[tokio::test]
    async fn chat_history_persists() {
        let store = fresh_store().await;
        let conv = chat::current_or_create(store.pool(), None)
            .await
            .expect("conv");
        chat::append(store.pool(), &conv.id, ChatRole::User, "hello")
            .await
            .expect("append");
        chat::append(store.pool(), &conv.id, ChatRole::Assistant, "hi there")
            .await
            .expect("append");

        let msgs = chat::list(store.pool(), &conv.id).await.expect("list");
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1].content, "hi there");
    }
}
