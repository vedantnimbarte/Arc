//! Tauri command surface for [`arc_ssh::SshManager`] and the persisted
//! SSH host / key catalogue in [`arc_session_manager::ssh`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("ssh_connect",       { opts: SshConnectOpts })             -> id
//!   invoke("ssh_write",         { id, data })                         -> ()
//!   invoke("ssh_resize",        { id, cols, rows })                   -> ()
//!   invoke("ssh_close",         { id })                               -> ()
//!   invoke("ssh_host_list",     { workspaceId? })                     -> Vec<SshHost>
//!   invoke("ssh_host_upsert",   { input: SshHostInput })              -> SshHost
//!   invoke("ssh_host_delete",   { id })                               -> ()
//!   invoke("ssh_key_list",      {})                                   -> Vec<SshKey>
//!   invoke("ssh_key_generate",  { opts: GenerateKeyOpts })            -> SshKeyWithPublic
//!   invoke("ssh_key_import",    { opts: ImportKeyOpts })              -> SshKey
//!   invoke("ssh_key_delete",    { id, deleteFiles? })                 -> ()
//!   invoke("ssh_session_logs",  { hostId, limit? })                   -> Vec<SshSessionLogEntry>
//!
//! Emitted events:
//!   "ssh://data/<id>"  -> { id, bytes: number[] }
//!   "ssh://log/<id>"   -> { id, entry: SshLogEvent }
//!   "ssh://exit/<id>"  -> { id, code: number | null }

use std::path::PathBuf;
use std::sync::Arc;

use arc_session_manager::{ssh as ssh_db, SessionStore, SshHost, SshHostInput, SshKey, SshSessionLogEntry};
use arc_ssh::{generate_key, load_key_metadata, GeneratedKey, SshConnectOpts, SshLogEvent, SshManager};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// OS-credential-vault service name for SSH passphrases. Distinct from the
/// `dev.arc.terminal` service used by API keys so we can list/delete the
/// two scopes independently.
const SSH_KEYRING_SERVICE: &str = "dev.arc.terminal.ssh";

#[derive(Default)]
pub struct SshState {
    pub manager: Arc<SshManager>,
}

// ---------- connection ----------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectInvoke {
    pub host_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize, Clone)]
struct SshDataEvent {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Serialize, Clone)]
struct SshLogEventOut {
    id: String,
    entry: SshLogEvent,
}

#[derive(Debug, Serialize, Clone)]
struct SshExitEvent {
    id: String,
    code: Option<i32>,
}

#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    store: State<'_, SessionStore>,
    payload: SshConnectInvoke,
) -> Result<String, String> {
    // Resolve the host record so we know which identity to load.
    let host = ssh_db::host_get(store.pool(), &payload.host_id)
        .await
        .map_err(|e| format!("host lookup: {e}"))?
        .ok_or_else(|| format!("unknown ssh host: {}", payload.host_id))?;

    let identity_id = host
        .identity_id
        .as_ref()
        .ok_or_else(|| "host has no identity configured".to_string())?;
    let identity = ssh_db::key_get(store.pool(), identity_id)
        .await
        .map_err(|e| format!("identity lookup: {e}"))?
        .ok_or_else(|| format!("unknown ssh key: {identity_id}"))?;

    let passphrase = if identity.has_passphrase {
        match Entry::new(SSH_KEYRING_SERVICE, &identity.id)
            .and_then(|e| e.get_password())
        {
            Ok(pp) => Some(pp),
            Err(keyring::Error::NoEntry) => None,
            Err(err) => return Err(format!("keyring: {err}")),
        }
    } else {
        None
    };

    let opts = SshConnectOpts {
        host: host.host.clone(),
        port: host.port as u16,
        username: host.username.clone(),
        identity_path: identity.path.clone(),
        passphrase,
        cols: payload.cols.max(1),
        rows: payload.rows.max(1),
        startup_cmd: host.startup_cmd.clone(),
        keepalive_secs: host.keepalive_secs.max(0) as u32,
    };

    let result = state
        .manager
        .connect(opts)
        .await
        .map_err(|e| format!("{e:#}"))?;

    let id = result.id.clone();
    let data_topic = format!("ssh://data/{id}");
    let log_topic = format!("ssh://log/{id}");
    let exit_topic = format!("ssh://exit/{id}");

    // Bump last_used on the host record (fire-and-forget; non-fatal).
    let _ = ssh_db::host_touch(store.pool(), &host.id).await;

    // Forward data → ssh://data/<id>
    {
        let app = app.clone();
        let mut rx = result.data_rx;
        let id_for_data = id.clone();
        tokio::spawn(async move {
            while let Some(bytes) = rx.recv().await {
                if app
                    .emit(
                        &data_topic,
                        SshDataEvent {
                            id: id_for_data.clone(),
                            bytes,
                        },
                    )
                    .is_err()
                {
                    break;
                }
            }
            tracing::debug!(id = %id_for_data, "ssh data stream closed");
        });
    }

    // Forward logs → ssh://log/<id>  + persist to ssh_session_logs
    {
        let app = app.clone();
        let mut rx = result.log_rx;
        let id_for_log = id.clone();
        let host_id_for_log = host.id.clone();
        let pool = store.pool().clone();
        tokio::spawn(async move {
            while let Some(entry) = rx.recv().await {
                let _ = ssh_db::log_append(
                    &pool,
                    &host_id_for_log,
                    &id_for_log,
                    entry.at,
                    &entry.level,
                    &entry.msg,
                )
                .await;
                if app
                    .emit(
                        &log_topic,
                        SshLogEventOut {
                            id: id_for_log.clone(),
                            entry,
                        },
                    )
                    .is_err()
                {
                    break;
                }
            }
        });
    }

    // Forward exit code once.
    {
        let app = app.clone();
        let rx = result.exit_rx;
        let id_for_exit = id.clone();
        tokio::spawn(async move {
            if let Ok(code) = rx.await {
                let _ = app.emit(
                    &exit_topic,
                    SshExitEvent {
                        id: id_for_exit.clone(),
                        code,
                    },
                );
            }
        });
    }

    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(
    state: State<'_, SshState>,
    id: String,
    data: String,
) -> Result<(), String> {
    state
        .manager
        .write(&id, data.as_bytes())
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state
        .manager
        .resize(&id, cols, rows)
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn ssh_close(state: State<'_, SshState>, id: String) -> Result<(), String> {
    state.manager.close(&id).await.map_err(|e| format!("{e:#}"))
}

// ---------- hosts ---------------------------------------------------------

#[tauri::command]
pub async fn ssh_host_list(
    store: State<'_, SessionStore>,
    workspace_id: Option<String>,
) -> Result<Vec<SshHost>, String> {
    ssh_db::host_list(store.pool(), workspace_id.as_deref())
        .await
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn ssh_host_upsert(
    store: State<'_, SessionStore>,
    input: SshHostInput,
) -> Result<SshHost, String> {
    ssh_db::host_upsert(store.pool(), input)
        .await
        .map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn ssh_host_delete(store: State<'_, SessionStore>, id: String) -> Result<(), String> {
    ssh_db::host_delete(store.pool(), &id)
        .await
        .map_err(|e| format!("{e}"))
}

// ---------- keys ----------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct GenerateKeyOpts {
    /// Human-friendly name and on-disk filename. The private key is written
    /// to `~/.ssh/<name>` and the public key to `~/.ssh/<name>.pub`.
    pub name: String,
    /// "ed25519" (recommended) or "rsa".
    pub algorithm: String,
    /// Embedded in the public-key line. Defaults to `<user>@<host>` when
    /// the frontend doesn't supply one.
    #[serde(default)]
    pub comment: Option<String>,
    /// Optional passphrase. Stored in the OS credential vault under
    /// `dev.arc.terminal.ssh`/<key id>.
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SshKeyWithPublic {
    #[serde(flatten)]
    pub key: SshKey,
    /// OpenSSH-format public-key line, ready to paste into
    /// `~/.ssh/authorized_keys` on the remote host.
    pub public_openssh: String,
}

#[tauri::command]
pub async fn ssh_key_list(store: State<'_, SessionStore>) -> Result<Vec<SshKey>, String> {
    ssh_db::key_list(store.pool()).await.map_err(|e| format!("{e}"))
}

#[tauri::command]
pub async fn ssh_key_generate(
    store: State<'_, SessionStore>,
    opts: GenerateKeyOpts,
) -> Result<SshKeyWithPublic, String> {
    let ssh_dir = arc_ssh::default_ssh_dir()
        .ok_or_else(|| "could not resolve ~/.ssh".to_string())?;
    if !ssh_dir.exists() {
        std::fs::create_dir_all(&ssh_dir).map_err(|e| format!("create {}: {e}", ssh_dir.display()))?;
    }
    let path: PathBuf = ssh_dir.join(&opts.name);
    let comment = opts
        .comment
        .clone()
        .unwrap_or_else(|| format!("arc-{}", hostname()));

    let pp_for_gen = opts.passphrase.as_deref().filter(|s| !s.is_empty());
    let generated: GeneratedKey = tokio::task::spawn_blocking({
        let path = path.clone();
        let algorithm = opts.algorithm.clone();
        let comment = comment.clone();
        let passphrase = pp_for_gen.map(|s| s.to_string());
        move || generate_key(&path, &algorithm, &comment, passphrase.as_deref())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
    .map_err(|e| format!("{e:#}"))?;

    let has_passphrase = opts
        .passphrase
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    let inserted = ssh_db::key_insert(
        store.pool(),
        &opts.name,
        &path.to_string_lossy(),
        &generated.kind,
        &generated.fingerprint,
        has_passphrase,
    )
    .await
    .map_err(|e| format!("{e}"))?;

    if let Some(pp) = opts.passphrase.as_ref().filter(|s| !s.is_empty()) {
        let entry = Entry::new(SSH_KEYRING_SERVICE, &inserted.id)
            .map_err(|e| format!("keyring entry: {e}"))?;
        entry.set_password(pp).map_err(|e| format!("keyring set: {e}"))?;
    }

    Ok(SshKeyWithPublic {
        key: inserted,
        public_openssh: generated.public_openssh,
    })
}

#[derive(Debug, Deserialize)]
pub struct ImportKeyOpts {
    /// Human-friendly name (defaults to the filename).
    pub name: String,
    /// Absolute path to an existing OpenSSH-format private key.
    pub path: String,
    /// Optional passphrase. If the key turns out to be encrypted but no
    /// passphrase was supplied the import fails with a clear error.
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[tauri::command]
pub async fn ssh_key_import(
    store: State<'_, SessionStore>,
    opts: ImportKeyOpts,
) -> Result<SshKey, String> {
    let path = PathBuf::from(&opts.path);
    let pp = opts.passphrase.clone();

    let meta: GeneratedKey = tokio::task::spawn_blocking(move || {
        load_key_metadata(&path, pp.as_deref())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
    .map_err(|e| format!("{e:#}"))?;

    let has_passphrase = opts
        .passphrase
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    let inserted = ssh_db::key_insert(
        store.pool(),
        &opts.name,
        &opts.path,
        &meta.kind,
        &meta.fingerprint,
        has_passphrase,
    )
    .await
    .map_err(|e| format!("{e}"))?;

    if let Some(pp) = opts.passphrase.as_ref().filter(|s| !s.is_empty()) {
        let entry = Entry::new(SSH_KEYRING_SERVICE, &inserted.id)
            .map_err(|e| format!("keyring entry: {e}"))?;
        entry.set_password(pp).map_err(|e| format!("keyring set: {e}"))?;
    }

    Ok(inserted)
}

#[tauri::command]
pub async fn ssh_key_delete(
    store: State<'_, SessionStore>,
    id: String,
    delete_files: Option<bool>,
) -> Result<(), String> {
    let key = ssh_db::key_get(store.pool(), &id)
        .await
        .map_err(|e| format!("{e}"))?;

    if let Some(k) = &key {
        if k.has_passphrase {
            if let Ok(entry) = Entry::new(SSH_KEYRING_SERVICE, &k.id) {
                let _ = entry.delete_credential();
            }
        }
        if delete_files.unwrap_or(false) {
            let priv_path = PathBuf::from(&k.path);
            let pub_path = priv_path.with_extension("pub");
            let _ = std::fs::remove_file(&priv_path);
            let _ = std::fs::remove_file(&pub_path);
        }
    }

    ssh_db::key_delete(store.pool(), &id)
        .await
        .map_err(|e| format!("{e}"))
}

// ---------- session logs --------------------------------------------------

#[tauri::command]
pub async fn ssh_session_logs(
    store: State<'_, SessionStore>,
    host_id: String,
    limit: Option<i64>,
) -> Result<Vec<SshSessionLogEntry>, String> {
    ssh_db::log_load_recent(store.pool(), &host_id, limit.unwrap_or(500))
        .await
        .map_err(|e| format!("{e}"))
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "arc".to_string())
}
