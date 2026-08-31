//! Tauri command surface for the database client tab — saved connections
//! plus the live pools that back them.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("db_conn_list")                            -> DbConnection[]
//!   invoke("db_conn_upsert",   { input })             -> DbConnection
//!   invoke("db_conn_delete",   { id })                -> ()
//!   invoke("db_password_set",  { id, password })      -> ()
//!   invoke("db_connect",       { id })                -> Backend
//!   invoke("db_disconnect",    { id })                -> ()
//!   invoke("db_is_connected",  { id })                -> bool
//!   invoke("db_query",         { id, sql })           -> QueryResult
//!   invoke("db_tables",        { id })                -> string[]
//!   invoke("db_preview",       { id, table, limit })  -> QueryResult
//!
//! Passwords live in the OS credential vault, never in the database or in the
//! stored URL — see `migrations/0015_db_and_merge_tabs.sql`. They are put back
//! into the URL only in `db_connect`, in memory, on the way to sqlx.

use arc_db::{Backend, DbManager, QueryResult};
use arc_session_manager::{db, DbConnection, DbConnectionInput, SessionStore};
use keyring::Entry;
use tauri::State;

/// Keyring service for database passwords. Distinct from the SSH and user
/// secret services so a vault audit can tell them apart.
const KEYRING_SERVICE: &str = "dev.arc.terminal.db";

#[derive(Default)]
pub struct DbState {
    pub manager: DbManager,
}

fn str_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn entry(id: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, id).map_err(str_err)
}

fn password_for(id: &str) -> Option<String> {
    entry(id).ok()?.get_password().ok()
}

/// Percent-encode a URL userinfo component. The password is user-typed and
/// routinely contains `@`, `:`, `/` or `#`, every one of which would otherwise
/// re-cut the URL somewhere else when sqlx parses it.
fn encode_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Splice `password` into `url`'s authority.
///
/// `url` is stored password-free, so the authority is either `user@host…` or
/// bare `host…`; both get a `:<password>` in the right place. A URL we can't
/// make sense of is returned untouched — sqlx will produce a better error
/// message about it than we can.
fn with_password(url: &str, password: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    // The authority ends at the first '/', '?' or '#'.
    let end = rest
        .find(['/', '?', '#'])
        .unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let encoded = encode_userinfo(password);
    // `rsplit_once` so a username containing an encoded '@' still splits at
    // the real userinfo/host boundary.
    let authority = match authority.rsplit_once('@') {
        Some((userinfo, host)) => format!("{userinfo}:{encoded}@{host}"),
        None => format!(":{encoded}@{authority}"),
    };
    format!("{scheme}://{authority}{tail}")
}

// ─── Saved connections ────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_conn_list(store: State<'_, SessionStore>) -> Result<Vec<DbConnection>, String> {
    db::list(store.pool()).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_conn_upsert(
    store: State<'_, SessionStore>,
    input: DbConnectionInput,
) -> Result<DbConnection, String> {
    // Reject a URL we can't classify here rather than at connect time, so the
    // user finds out while the form is still open.
    Backend::from_url(&input.url).map_err(str_err)?;
    db::upsert(store.pool(), input).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_conn_delete(
    store: State<'_, SessionStore>,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    state.manager.disconnect(&id).await;
    // Best-effort vault cleanup — a stale entry is harmless but tidy is nicer.
    if let Ok(e) = entry(&id) {
        let _ = e.delete_credential();
    }
    db::delete(store.pool(), &id).await.map_err(str_err)
}

/// Store (or clear, when `password` is empty) the vault entry for `id`.
#[tauri::command]
pub fn db_password_set(id: String, password: String) -> Result<(), String> {
    let e = entry(&id)?;
    if password.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(str_err(err)),
        };
    }
    e.set_password(&password).map_err(str_err)
}

// ─── Live connections ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_connect(
    store: State<'_, SessionStore>,
    state: State<'_, DbState>,
    id: String,
) -> Result<Backend, String> {
    let conn = db::get(store.pool(), &id)
        .await
        .map_err(str_err)?
        .ok_or_else(|| "no such connection".to_string())?;
    let url = match password_for(&id) {
        Some(pw) if !pw.is_empty() => with_password(&conn.url, &pw),
        _ => conn.url.clone(),
    };
    let backend = state.manager.connect(&id, &url).await.map_err(str_err)?;
    // Ordering, not correctness — a failed touch shouldn't fail the connect.
    let _ = db::touch(store.pool(), &id).await;
    Ok(backend)
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, id: String) -> Result<(), String> {
    state.manager.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn db_is_connected(state: State<'_, DbState>, id: String) -> Result<bool, String> {
    Ok(state.manager.is_connected(&id))
}

#[tauri::command]
pub async fn db_query(
    state: State<'_, DbState>,
    id: String,
    sql: String,
) -> Result<QueryResult, String> {
    state.manager.query(&id, &sql).await.map_err(|e| {
        // anyhow's Display drops the source chain, and for a SQL error the
        // source *is* the message the user needs ("column x does not exist").
        format!("{e:#}")
    })
}

#[tauri::command]
pub async fn db_tables(state: State<'_, DbState>, id: String) -> Result<Vec<String>, String> {
    state.manager.tables(&id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn db_preview(
    state: State<'_, DbState>,
    id: String,
    table: String,
    limit: Option<u32>,
) -> Result<QueryResult, String> {
    state
        .manager
        .preview(&id, &table, limit.unwrap_or(200))
        .await
        .map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_is_spliced_and_encoded() {
        assert_eq!(
            with_password("postgres://alice@db.example:5432/app", "p@ss/word"),
            "postgres://alice:p%40ss%2Fword@db.example:5432/app"
        );
        // No username: the password still lands in the userinfo slot.
        assert_eq!(
            with_password("mysql://localhost/app", "hunter2"),
            "mysql://:hunter2@localhost/app"
        );
        // Query strings live past the authority and must not be touched.
        assert_eq!(
            with_password("postgres://u@h/db?sslmode=require", "x"),
            "postgres://u:x@h/db?sslmode=require"
        );
        // Authority with no path at all.
        assert_eq!(with_password("postgres://u@h", "x"), "postgres://u:x@h");
        // Unparseable input is passed through rather than mangled.
        assert_eq!(with_password("nonsense", "x"), "nonsense");
    }
}
