//! arc-session-manager — workspace, tab, and command-history persistence
//! backed by SQLite via sqlx.
//!
//! Each table has a sibling module that owns its repository functions:
//! [`workspaces`], [`tabs`], [`commands`].
//!
//! The store is cheaply cloneable (it's just a wrapped `SqlitePool`), so it
//! can be `.manage()`d in Tauri and handed to commands as `State<SessionStore>`.

use std::path::{Path, PathBuf};

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use thiserror::Error;

pub mod apiclient;
pub mod commands;
pub mod db;
pub mod settings;
pub mod ssh;
pub mod tabs;
pub mod workspaces;

pub use commands::CommandRecord;
pub use db::{DbConnection, DbConnectionInput, DbQueryHistoryEntry};
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

    /// Like `open_default`, but never fails the app launch on a bad database.
    /// If the file is corrupt or a migration can't apply (e.g. a half-written
    /// db from a killed launch, or a downgrade), quarantine it and start fresh
    /// rather than panic. Returns the path we moved aside, if any, so the
    /// caller can tell the user their local history was reset.
    pub async fn open_default_or_recover() -> Result<(Self, Option<PathBuf>)> {
        let mut dir = dirs::data_dir().ok_or(Error::NoDataDir)?;
        dir.push("arc");
        tokio::fs::create_dir_all(&dir).await?;
        let path = dir.join("arc.db");
        match Self::open_at(&path).await {
            Ok(store) => Ok((store, None)),
            Err(err) => {
                tracing::error!(?path, %err, "session store unusable; quarantining and recreating");
                let quarantine = dir.join("arc.db.corrupt");
                // Move the db and its WAL/SHM sidecars aside. Best-effort:
                // missing sidecars are fine, and a leftover quarantine from a
                // prior recovery is simply overwritten.
                let _ = tokio::fs::rename(&path, &quarantine).await;
                let _ = tokio::fs::rename(dir.join("arc.db-wal"), dir.join("arc.db-wal.corrupt")).await;
                let _ = tokio::fs::rename(dir.join("arc.db-shm"), dir.join("arc.db-shm.corrupt")).await;
                let store = Self::open_at(&path).await?;
                Ok((store, Some(quarantine)))
            }
        }
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
    async fn ssh_host_jump_and_forwards_roundtrip() {
        let store = fresh_store().await;
        let input = |name: &str, jump: Option<String>, forwards| SshHostInput {
            id: None,
            workspace_id: None,
            name: name.into(),
            host: format!("{name}.example"),
            port: 22,
            username: "u".into(),
            identity_id: None,
            keepalive_secs: 30,
            startup_cmd: None,
            jump_host_id: jump,
            forwards,
        };
        let bastion = ssh::host_upsert(store.pool(), input("bastion", None, vec![]))
            .await
            .expect("bastion");
        let fwd = serde_json::json!({"kind": "local", "bind_port": 8080, "dest_host": "localhost", "dest_port": 80});
        let app = ssh::host_upsert(
            store.pool(),
            input("app", Some(bastion.id.clone()), vec![fwd.clone()]),
        )
        .await
        .expect("app");

        let got = ssh::host_get(store.pool(), &app.id).await.unwrap().unwrap();
        assert_eq!(got.jump_host_id.as_deref(), Some(bastion.id.as_str()));
        assert_eq!(got.forwards, vec![fwd]);

        // Deleting the jump host leaves the dependent host connectable directly.
        ssh::host_delete(store.pool(), &bastion.id).await.unwrap();
        let got = ssh::host_get(store.pool(), &app.id).await.unwrap().unwrap();
        assert_eq!(got.jump_host_id, None);
    }

    #[tokio::test]
    async fn db_query_history_caps_and_deletes() {
        let store = fresh_store().await;
        let pool = store.pool();
        let conn = |name: &str| DbConnectionInput {
            id: None,
            name: name.into(),
            backend: "sqlite".into(),
            url: "sqlite::memory:".into(),
            has_password: false,
        };
        let a = db::upsert(pool, conn("a")).await.unwrap();
        let b = db::upsert(pool, conn("b")).await.unwrap();

        for i in 0..db::HISTORY_CAP + 5 {
            db::history_add(pool, &a.id, &format!("SELECT {i}"), 3, Some(1), None)
                .await
                .unwrap();
        }
        db::history_add(pool, &b.id, "SELEC oops", 1, None, Some("syntax error"))
            .await
            .unwrap();

        let list = db::history_list(pool, &a.id).await.unwrap();
        assert_eq!(list.len() as i64, db::HISTORY_CAP);
        // Newest first; the five oldest were pruned.
        assert_eq!(list[0].sql, format!("SELECT {}", db::HISTORY_CAP + 4));
        assert_eq!(list.last().unwrap().sql, "SELECT 5");

        let failed = db::history_list(pool, &b.id).await.unwrap();
        assert_eq!(failed.len(), 1, "the cap is per connection");
        assert_eq!(failed[0].error.as_deref(), Some("syntax error"));
        assert_eq!(failed[0].row_count, None);

        db::history_delete(pool, list[0].id).await.unwrap();
        assert_eq!(
            db::history_list(pool, &a.id).await.unwrap().len() as i64,
            db::HISTORY_CAP - 1
        );
        db::history_clear(pool, &a.id).await.unwrap();
        assert!(db::history_list(pool, &a.id).await.unwrap().is_empty());

        // Deleting a connection takes its history with it.
        db::delete(pool, &b.id).await.unwrap();
        assert!(db::history_list(pool, &b.id).await.unwrap().is_empty());
    }
}
