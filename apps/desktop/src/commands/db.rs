//! Tauri command surface for the database client tab — saved connections
//! plus the live pools that back them.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!
//!   invoke("db_conn_list")                            -> DbConnection[]
//!   invoke("db_conn_upsert",   { input })             -> DbConnection
//!   invoke("db_conn_delete",   { id })                -> ()
//!   invoke("db_password_set",  { id, password })      -> ()
//!   invoke("db_ssh_passphrase_set", { id, passphrase }) -> ()
//!   invoke("db_connect",       { id })                -> Backend
//!   invoke("db_disconnect",    { id })                -> ()
//!   invoke("db_is_connected",  { id })                -> bool
//!   invoke("db_query",         { id, sql, queryId })  -> QueryResult
//!   invoke("db_cancel",        { queryId })           -> ()
//!   invoke("db_begin" | "db_commit" | "db_rollback", { id }) -> ()
//!   invoke("db_in_transaction", { id })               -> bool
//!   invoke("db_apply",         { id, statements })    -> u64 rows affected
//!   invoke("db_tables",        { id })                -> string[]
//!   invoke("db_row_counts",    { id })                -> RowCount[]
//!   invoke("db_exact_count",   { id, table })         -> i64
//!   invoke("db_preview",       { id, table, limit })  -> QueryResult
//!   invoke("db_table_schema",  { id, table })         -> TableSchema
//!   invoke("db_export",        { id, sql, format, path, exportId }) -> u64
//!   invoke("db_csv_preview",   { path, limit })       -> CsvPreview
//!   invoke("db_import_csv",    { id, path, spec, jobId }) -> u64
//!   invoke("db_job_cancel",    { jobId })             -> ()  (export or import)
//!   invoke("db_history_list",  { id })                -> DbQueryHistoryEntry[]
//!   invoke("db_history_delete", { historyId })        -> ()
//!   invoke("db_history_clear", { id })                -> ()
//!   invoke("db_saved_list",    { id })                -> DbSavedQuery[]
//!   invoke("db_saved_upsert",  { input })             -> DbSavedQuery
//!   invoke("db_saved_delete",  { savedId })           -> ()
//!
//! Emitted events:
//!   "db://export/<exportId>" -> u64 rows written so far
//!   "db://import/<jobId>"    -> u64 rows inserted so far
//!
//! Passwords live in the OS credential vault, never in the database or in the
//! stored URL — see `migrations/0015_db_and_merge_tabs.sql`. They are put back
//! into the URL only in `db_connect`, in memory, on the way to sqlx. The SSH
//! key passphrase of a tunnelled connection sits next to it, under account
//! `<id>:ssh`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use arc_db::{
    Backend, CsvPreview, DbManager, ExportFormat, ImportSpec, QueryResult, RowCount, TableSchema,
};
use arc_session_manager::{
    db, DbConnection, DbConnectionInput, DbQueryHistoryEntry, DbSavedQuery, DbSavedQueryInput,
    SessionStore,
};
use dashmap::DashMap;
use keyring::Entry;
use tauri::{AppHandle, Emitter, State};

use super::ssh::{host_key_bridge, SshState};

/// Keyring service for database passwords. Distinct from the SSH and user
/// secret services so a vault audit can tell them apart.
const KEYRING_SERVICE: &str = "dev.arc.terminal.db";

#[derive(Default)]
pub struct DbState {
    pub manager: DbManager,
    /// Cancel flags of running exports and imports, keyed by the frontend's
    /// job id.
    jobs: DashMap<String, Arc<AtomicBool>>,
    /// SSH tunnels of connected, tunnelled connections. Dropping one closes
    /// its SSH session.
    tunnels: DashMap<String, arc_ssh::Tunnel>,
}

fn str_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// anyhow's Display drops the source chain, and for a SQL error the source
/// *is* the message the user needs ("column x does not exist"). sqlx repeats
/// the database's message in its own Display, so a cause already contained in
/// the one before it is left out.
fn chain_err(e: anyhow::Error) -> String {
    let mut parts: Vec<String> = Vec::new();
    for cause in e.chain() {
        let msg = cause.to_string();
        if !parts.last().is_some_and(|prev| prev.contains(&msg)) {
            parts.push(msg);
        }
    }
    parts.join(": ")
}

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, account).map_err(str_err)
}

fn secret(account: &str) -> Option<String> {
    entry(account).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

/// Store `value` under `account`, or clear the entry when it's empty.
fn set_secret(account: &str, value: &str) -> Result<(), String> {
    let e = entry(account)?;
    if value.is_empty() {
        return match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(str_err(err)),
        };
    }
    e.set_password(value).map_err(str_err)
}

fn ssh_account(id: &str) -> String {
    format!("{id}:ssh")
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

/// A URL cut around its authority: `scheme`, `userinfo` (without the `@`),
/// `host:port`, and everything after.
struct UrlParts<'a> {
    scheme: &'a str,
    userinfo: Option<&'a str>,
    hostport: &'a str,
    tail: &'a str,
}

fn url_parts(url: &str) -> Option<UrlParts<'_>> {
    let (scheme, rest) = url.split_once("://")?;
    // The authority ends at the first '/', '?' or '#'.
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    // `rsplit_once` so a username containing an encoded '@' still splits at
    // the real userinfo/host boundary.
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, authority),
    };
    Some(UrlParts {
        scheme,
        userinfo,
        hostport,
        tail,
    })
}

/// Splice `password` into `url`'s authority.
///
/// `url` is stored password-free, so the authority is either `user@host…` or
/// bare `host…`; both get a `:<password>` in the right place. A URL we can't
/// make sense of is returned untouched — sqlx will produce a better error
/// message about it than we can.
fn with_password(url: &str, password: &str) -> String {
    let Some(p) = url_parts(url) else {
        return url.to_string();
    };
    let encoded = encode_userinfo(password);
    let userinfo = p.userinfo.unwrap_or("");
    format!("{}://{userinfo}:{encoded}@{}{}", p.scheme, p.hostport, p.tail)
}

/// The database host and port a tunnelled URL names, as seen from the SSH
/// server. The port defaults per backend.
fn url_host_port(url: &str, backend: Backend) -> Result<(String, u16), String> {
    let default = match backend {
        Backend::Postgres => 5432,
        Backend::Mysql => 3306,
        Backend::Sqlite => return Err("SSH tunnels apply to Postgres and MySQL only".into()),
    };
    let p = url_parts(url).ok_or("the connection URL has no host")?;
    let port = |s: &str| s.parse::<u16>().map_err(|_| format!("bad port in URL: {s}"));
    let (host, port) = if let Some(v6) = p.hostport.strip_prefix('[') {
        let (h, rest) = v6.split_once(']').ok_or("bad IPv6 host in URL")?;
        (h, rest.strip_prefix(':').map(port).transpose()?.unwrap_or(default))
    } else {
        match p.hostport.rsplit_once(':') {
            Some((h, ps)) => (h, port(ps)?),
            None => (p.hostport, default),
        }
    };
    if host.is_empty() {
        return Err("an SSH tunnel needs a host in the connection URL".into());
    }
    Ok((host.to_string(), port))
}

/// `url` pointed at `127.0.0.1:<port>` — the local end of its tunnel.
fn via_tunnel(url: &str, port: u16) -> String {
    let Some(p) = url_parts(url) else {
        return url.to_string();
    };
    let userinfo = p.userinfo.map(|u| format!("{u}@")).unwrap_or_default();
    format!("{}://{userinfo}127.0.0.1:{port}{}", p.scheme, p.tail)
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
    let backend = Backend::from_url(&input.url).map_err(str_err)?;
    if let Some(ssh) = &input.ssh {
        url_host_port(&input.url, backend)?;
        if ssh.host.trim().is_empty() || ssh.user.trim().is_empty() {
            return Err("SSH host and user are required".into());
        }
        if ssh.key_path.trim().is_empty() {
            return Err("pick the SSH private key".into());
        }
    }
    db::upsert(store.pool(), input).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_conn_delete(
    store: State<'_, SessionStore>,
    state: State<'_, DbState>,
    id: String,
) -> Result<(), String> {
    state.manager.disconnect(&id).await;
    state.tunnels.remove(&id);
    // Best-effort vault cleanup — a stale entry is harmless but tidy is nicer.
    let _ = set_secret(&id, "");
    let _ = set_secret(&ssh_account(&id), "");
    db::delete(store.pool(), &id).await.map_err(str_err)
}

/// Store (or clear, when `password` is empty) the vault entry for `id`.
#[tauri::command]
pub fn db_password_set(id: String, password: String) -> Result<(), String> {
    set_secret(&id, &password)
}

/// Store (or clear) the passphrase of a tunnelled connection's SSH key.
#[tauri::command]
pub fn db_ssh_passphrase_set(id: String, passphrase: String) -> Result<(), String> {
    set_secret(&ssh_account(&id), &passphrase)
}

// ─── Live connections ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn db_connect(
    app: AppHandle,
    store: State<'_, SessionStore>,
    state: State<'_, DbState>,
    ssh_state: State<'_, SshState>,
    id: String,
) -> Result<Backend, String> {
    let conn = db::get(store.pool(), &id)
        .await
        .map_err(str_err)?
        .ok_or_else(|| "no such connection".to_string())?;
    let backend = Backend::from_url(&conn.url).map_err(str_err)?;

    // Reconnecting replaces the old tunnel along with the old pool.
    state.tunnels.remove(&id);
    let mut url = conn.url.clone();
    let mut tunnel = None;
    if let Some(ssh) = &conn.ssh {
        let (db_host, db_port) = url_host_port(&conn.url, backend)?;
        let endpoint = arc_ssh::SshEndpoint {
            host: ssh.host.clone(),
            port: ssh.port,
            username: ssh.user.clone(),
            identity_path: ssh.key_path.clone(),
            passphrase: secret(&ssh_account(&id)),
        };
        let asker = host_key_bridge(app.clone(), &ssh_state);
        let t = arc_ssh::Tunnel::open(&endpoint, None, &db_host, db_port, Some(asker))
            .await
            .map_err(|e| format!("SSH tunnel: {e:#}"))?;
        url = via_tunnel(&url, t.local_port);
        tunnel = Some(t);
    }
    if let Some(pw) = secret(&id) {
        url = with_password(&url, &pw);
    }
    let backend = state.manager.connect(&id, &url).await.map_err(str_err)?;
    if let Some(t) = tunnel {
        state.tunnels.insert(id.clone(), t);
    }
    // Ordering, not correctness — a failed touch shouldn't fail the connect.
    let _ = db::touch(store.pool(), &id).await;
    Ok(backend)
}

#[tauri::command]
pub async fn db_disconnect(state: State<'_, DbState>, id: String) -> Result<(), String> {
    state.manager.disconnect(&id).await;
    state.tunnels.remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn db_is_connected(state: State<'_, DbState>, id: String) -> Result<bool, String> {
    Ok(state.manager.is_connected(&id))
}

/// Run `sql` and record it in the connection's query history, success or not.
/// `query_id` makes it cancellable with `db_cancel`.
#[tauri::command]
pub async fn db_query(
    store: State<'_, SessionStore>,
    state: State<'_, DbState>,
    id: String,
    sql: String,
    query_id: Option<String>,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    let res = state
        .manager
        .query(&id, &sql, query_id.as_deref())
        .await
        .map_err(chain_err);
    let rows = match &res {
        Ok(r) if r.columns.is_empty() => Ok(r.rows_affected as i64),
        Ok(r) => Ok(r.rows.len() as i64),
        Err(e) => Err(e.as_str()),
    };
    record(&store, &id, &sql, started, rows).await;
    res
}

/// Add one statement to the history. A convenience — failing to write it must
/// not fail the query.
async fn record(store: &SessionStore, id: &str, sql: &str, started: Instant, rows: Result<i64, &str>) {
    let duration = started.elapsed().as_millis() as i64;
    let (rows, error) = match rows {
        Ok(n) => (Some(n), None),
        Err(e) => (None, Some(e)),
    };
    if let Err(e) = db::history_add(store.pool(), id, sql, duration, rows, error).await {
        tracing::warn!(%e, "db query history write failed");
    }
}

#[tauri::command]
pub async fn db_cancel(state: State<'_, DbState>, query_id: String) -> Result<(), String> {
    state.manager.cancel(&query_id).await.map_err(chain_err)
}

#[tauri::command]
pub async fn db_begin(state: State<'_, DbState>, id: String) -> Result<(), String> {
    state.manager.begin(&id).await.map_err(chain_err)
}

#[tauri::command]
pub async fn db_commit(state: State<'_, DbState>, id: String) -> Result<(), String> {
    state.manager.commit(&id).await.map_err(chain_err)
}

#[tauri::command]
pub async fn db_rollback(state: State<'_, DbState>, id: String) -> Result<(), String> {
    state.manager.rollback(&id).await.map_err(chain_err)
}

#[tauri::command]
pub async fn db_in_transaction(state: State<'_, DbState>, id: String) -> Result<bool, String> {
    Ok(state.manager.in_transaction(&id))
}

/// Run `statements` all-or-nothing (the grid's staged edits). Recorded in
/// history as one entry.
#[tauri::command]
pub async fn db_apply(
    store: State<'_, SessionStore>,
    state: State<'_, DbState>,
    id: String,
    statements: Vec<String>,
) -> Result<u64, String> {
    let started = Instant::now();
    let res = state.manager.apply(&id, &statements).await.map_err(chain_err);
    let sql = statements.join(";\n");
    let rows = match &res {
        Ok(n) => Ok(*n as i64),
        Err(e) => Err(e.as_str()),
    };
    record(&store, &id, &sql, started, rows).await;
    res
}

/// Analytics view poll — off the query history and outside any transaction.
#[tauri::command]
pub async fn db_stats(state: State<'_, DbState>, id: String, sql: String) -> Result<QueryResult, String> {
    state.manager.stats(&id, &sql).await.map_err(chain_err)
}

#[tauri::command]
pub async fn db_tables(state: State<'_, DbState>, id: String) -> Result<Vec<String>, String> {
    state.manager.tables(&id).await.map_err(chain_err)
}

#[tauri::command]
pub async fn db_row_counts(state: State<'_, DbState>, id: String) -> Result<Vec<RowCount>, String> {
    state.manager.row_counts(&id).await.map_err(chain_err)
}

#[tauri::command]
pub async fn db_exact_count(
    state: State<'_, DbState>,
    id: String,
    table: String,
) -> Result<i64, String> {
    state.manager.exact_count(&id, &table).await.map_err(chain_err)
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
        .map_err(chain_err)
}

#[tauri::command]
pub async fn db_table_schema(
    state: State<'_, DbState>,
    id: String,
    table: String,
) -> Result<TableSchema, String> {
    state.manager.schema(&id, &table).await.map_err(chain_err)
}

/// Stream the full result of `sql` into `path`, past the grid's row cap.
/// Emits the running row count on `db://export/<export_id>`.
#[tauri::command]
pub async fn db_export(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    sql: String,
    format: ExportFormat,
    path: PathBuf,
    export_id: String,
) -> Result<u64, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.jobs.insert(export_id.clone(), cancel.clone());
    let topic = format!("db://export/{export_id}");
    let res = state
        .manager
        .export(&id, &sql, format, &path, &cancel, |n| {
            let _ = app.emit(&topic, n);
        })
        .await
        .map_err(chain_err);
    state.jobs.remove(&export_id);
    res
}

#[tauri::command]
pub async fn db_csv_preview(path: PathBuf, limit: Option<usize>) -> Result<CsvPreview, String> {
    arc_db::csv_preview(&path, limit.unwrap_or(20))
        .await
        .map_err(chain_err)
}

/// Load a CSV file into a table, all or nothing. Emits the running row count
/// on `db://import/<job_id>`.
#[tauri::command]
pub async fn db_import_csv(
    app: AppHandle,
    state: State<'_, DbState>,
    id: String,
    path: PathBuf,
    spec: ImportSpec,
    job_id: String,
) -> Result<u64, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state.jobs.insert(job_id.clone(), cancel.clone());
    let topic = format!("db://import/{job_id}");
    let res = state
        .manager
        .import_csv(&id, &path, &spec, &cancel, |n| {
            let _ = app.emit(&topic, n);
        })
        .await
        .map_err(chain_err);
    state.jobs.remove(&job_id);
    res
}

/// Stop a running export or import.
#[tauri::command]
pub async fn db_job_cancel(state: State<'_, DbState>, job_id: String) -> Result<(), String> {
    if let Some(flag) = state.jobs.get(&job_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// ─── History and saved queries ────────────────────────────────────────────

#[tauri::command]
pub async fn db_history_list(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<Vec<DbQueryHistoryEntry>, String> {
    db::history_list(store.pool(), &id).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_history_delete(
    store: State<'_, SessionStore>,
    history_id: i64,
) -> Result<(), String> {
    db::history_delete(store.pool(), history_id).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_history_clear(store: State<'_, SessionStore>, id: String) -> Result<(), String> {
    db::history_clear(store.pool(), &id).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_saved_list(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<Vec<DbSavedQuery>, String> {
    db::saved_list(store.pool(), &id).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_saved_upsert(
    store: State<'_, SessionStore>,
    input: DbSavedQueryInput,
) -> Result<DbSavedQuery, String> {
    if input.name.trim().is_empty() {
        return Err("give the query a name".into());
    }
    db::saved_upsert(store.pool(), input).await.map_err(str_err)
}

#[tauri::command]
pub async fn db_saved_delete(store: State<'_, SessionStore>, saved_id: String) -> Result<(), String> {
    db::saved_delete(store.pool(), &saved_id).await.map_err(str_err)
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

    #[test]
    fn error_chain_drops_repeats() {
        let inner = anyhow::anyhow!("(code: 787) FOREIGN KEY constraint failed");
        let e = inner
            .context("error returned from database: (code: 787) FOREIGN KEY constraint failed")
            .context("statement 3 of 4");
        assert_eq!(
            chain_err(e),
            "statement 3 of 4: error returned from database: (code: 787) FOREIGN KEY constraint failed"
        );
    }

    #[test]
    fn tunnel_urls() {
        assert_eq!(
            url_host_port("postgres://app@10.0.0.5/app", Backend::Postgres).unwrap(),
            ("10.0.0.5".into(), 5432)
        );
        assert_eq!(
            url_host_port("mysql://root@db.internal:3307/x?ssl=1", Backend::Mysql).unwrap(),
            ("db.internal".into(), 3307)
        );
        assert_eq!(
            url_host_port("postgres://[fd00::5]:6432/app", Backend::Postgres).unwrap(),
            ("fd00::5".into(), 6432)
        );
        assert!(url_host_port("postgres:///app", Backend::Postgres).is_err());
        assert!(url_host_port("sqlite://a.db", Backend::Sqlite).is_err());
        assert!(url_host_port("postgres://h:notaport/app", Backend::Postgres).is_err());

        assert_eq!(
            via_tunnel("postgres://app@10.0.0.5:5432/app?sslmode=require", 51234),
            "postgres://app@127.0.0.1:51234/app?sslmode=require"
        );
        // The password goes in after the rewrite, into the same userinfo.
        assert_eq!(
            with_password(&via_tunnel("mysql://db.internal/x", 40000), "pw"),
            "mysql://:pw@127.0.0.1:40000/x"
        );
    }
}
