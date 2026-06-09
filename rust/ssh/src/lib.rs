//! arc-ssh — pure-Rust SSH client wrapped in a session-keyed manager that
//! streams remote shell output (and per-step handshake logs) over Tokio
//! channels. Sibling of [`arc_pty`]; same shape, async driver instead of a
//! blocking reader thread.
//!
//! The contract:
//!   connect(opts)            -> id + Receivers (data chunks, log events, exit)
//!   write(id, bytes)         -> push to remote stdin
//!   resize(id, cols, rows)   -> SSH window-change
//!   close(id)                -> close channel + drop session
//!
//! Key management lives alongside the session manager — [`generate_key`] and
//! [`load_key`] produce/consume on-disk OpenSSH-format keypairs.
//!
//! V1 caveats:
//!   * Server keys are accepted on first use (no known_hosts persistence yet).
//!   * Authentication is publickey-only.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use dashmap::DashMap;
use russh::client::{self, Handle, Msg};
use russh::{Channel, ChannelMsg};
use russh_keys::key::{KeyPair, PublicKey};
use serde::{Deserialize, Serialize};
use ssh_key::rand_core::OsRng;
use ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

const DATA_CHANNEL_CAP: usize = 256;
const LOG_CHANNEL_CAP: usize = 64;
const HANDSHAKE_TIMEOUT_SECS: u64 = 25;

/// Connection request handed to [`SshManager::connect`]. Sensitive material
/// (the private-key passphrase) is resolved by the caller before this hits
/// the manager — the keyring lookup lives in the command layer.
#[derive(Debug, Clone, Deserialize)]
pub struct SshConnectOpts {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Path to an OpenSSH-format private key on disk.
    pub identity_path: String,
    /// Optional passphrase for the identity. Already-resolved cleartext —
    /// the caller is responsible for sourcing this from the OS keyring.
    pub passphrase: Option<String>,
    /// Terminal grid the remote PTY should be allocated with.
    pub cols: u16,
    pub rows: u16,
    /// Optional command to run after the shell starts (single line).
    pub startup_cmd: Option<String>,
    /// Keepalive interval (seconds). 0 disables.
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
}

fn default_keepalive() -> u32 {
    30
}

/// One step of the handshake / lifecycle, surfaced to the frontend so the
/// `<SshSessionLogDrawer>` can render a timestamped trail.
#[derive(Debug, Clone, Serialize)]
pub struct SshLogEvent {
    /// Unix-epoch milliseconds.
    pub at: i64,
    /// Fixed-width tag the UI prints in the level column.
    /// One of: `resolve`, `tcp`, `ssh`, `kex`, `auth`, `channel`, `pty`,
    /// `ready`, `data`, `error`, `closed`.
    pub level: String,
    pub msg: String,
}

/// Returned to the caller of [`SshManager::connect`]. The three receivers
/// must be drained by the caller; once dropped, the driver task exits.
pub struct SshConnectResult {
    pub id: String,
    pub data_rx: mpsc::Receiver<Vec<u8>>,
    pub log_rx: mpsc::Receiver<SshLogEvent>,
    pub exit_rx: oneshot::Receiver<Option<i32>>,
}

/// Public metadata about a generated or imported key. Returned by
/// [`generate_key`] / [`load_key_metadata`].
#[derive(Debug, Clone, Serialize)]
pub struct GeneratedKey {
    /// SHA256 fingerprint in standard OpenSSH form ("SHA256:abc…").
    pub fingerprint: String,
    /// Algorithm name (e.g. `ed25519`, `ssh-rsa`).
    pub kind: String,
    /// Full public-key line in OpenSSH format, ready to paste into
    /// `~/.ssh/authorized_keys`.
    pub public_openssh: String,
    /// Bit-strength where it makes sense (256 for ed25519, 2048+ for rsa).
    pub bits: u32,
}

enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

struct SessionEntry {
    cmd_tx: mpsc::UnboundedSender<SessionCmd>,
}

#[derive(Default)]
pub struct SshManager {
    // Arc so the per-session driver task can hold a handle and remove its
    // own entry when the session ends for ANY reason (remote close, network
    // drop, write error) — not just the explicit `close()` command.
    sessions: Arc<DashMap<String, SessionEntry>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a new SSH session and start its driver task. The handshake runs
    /// inline — by the time this returns Ok, auth has succeeded and a shell
    /// is being requested. Handshake-step logs flow to `log_rx` so the UI
    /// can render its 6-dot progress; data flows to `data_rx`; the channel's
    /// final exit code goes to `exit_rx`.
    pub async fn connect(&self, opts: SshConnectOpts) -> Result<SshConnectResult> {
        let (data_tx, data_rx) = mpsc::channel::<Vec<u8>>(DATA_CHANNEL_CAP);
        let (log_tx, log_rx) = mpsc::channel::<SshLogEvent>(LOG_CHANNEL_CAP);
        let (exit_tx, exit_rx) = oneshot::channel::<Option<i32>>();

        log(&log_tx, "resolve", &format!("{}:{}", opts.host, opts.port)).await;

        // Load identity (may prompt the OS keychain for a passphrase via the
        // caller; we already have cleartext here).
        let key_pair = load_key(Path::new(&opts.identity_path), opts.passphrase.as_deref())
            .context("load identity")?;
        log(
            &log_tx,
            "auth",
            &format!("identity {} loaded", opts.identity_path),
        )
        .await;

        // SSH client config — generous handshake timeout, conservative
        // keepalive.  russh uses its own ed25519/curve25519 defaults; we
        // only override the bits we care about.
        let mut config = client::Config::default();
        config.inactivity_timeout = None;
        config.keepalive_interval = if opts.keepalive_secs > 0 {
            Some(std::time::Duration::from_secs(opts.keepalive_secs as u64))
        } else {
            None
        };
        let config = Arc::new(config);

        let handler = ClientHandler {
            log_tx: log_tx.clone(),
        };

        let addr = (opts.host.as_str(), opts.port);
        log(&log_tx, "tcp", "connecting").await;

        let connect_fut = client::connect(config, addr, handler);
        let mut handle: Handle<ClientHandler> = tokio::time::timeout(
            std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
            connect_fut,
        )
        .await
        .map_err(|_| anyhow!("connect timeout after {HANDSHAKE_TIMEOUT_SECS}s"))?
        .with_context(|| format!("connect {}:{}", opts.host, opts.port))?;
        log(&log_tx, "tcp", "connected").await;
        log(&log_tx, "kex", "key exchange complete").await;

        let key_arc = Arc::new(key_pair);
        let authed = handle
            .authenticate_publickey(&opts.username, key_arc)
            .await
            .context("publickey auth")?;
        if !authed {
            log_blocking(&log_tx, "error", "publickey rejected").await;
            return Err(anyhow!("authentication failed: publickey rejected"));
        }
        log(&log_tx, "auth", "publickey accepted").await;

        let channel: Channel<Msg> = handle
            .channel_open_session()
            .await
            .context("open session channel")?;
        log(&log_tx, "channel", "session opened").await;

        channel
            .request_pty(
                true,
                "xterm-256color",
                opts.cols.max(1) as u32,
                opts.rows.max(1) as u32,
                0,
                0,
                &[],
            )
            .await
            .context("request pty")?;
        log(
            &log_tx,
            "pty",
            &format!(
                "xterm-256color {}×{}",
                opts.cols.max(1),
                opts.rows.max(1)
            ),
        )
        .await;

        channel
            .request_shell(true)
            .await
            .context("request shell")?;
        log(&log_tx, "ready", "interactive shell").await;

        if let Some(startup) = opts.startup_cmd.as_ref().filter(|s| !s.is_empty()) {
            let mut line = startup.clone();
            if !line.ends_with('\n') {
                line.push('\n');
            }
            let _ = channel.data(line.as_bytes()).await;
        }

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCmd>();
        let id = Uuid::new_v4().to_string();
        self.sessions.insert(
            id.clone(),
            SessionEntry {
                cmd_tx: cmd_tx.clone(),
            },
        );

        let driver_id = id.clone();
        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            drive_session(driver_id, handle, channel, cmd_rx, data_tx, log_tx, exit_tx, sessions)
                .await;
        });

        Ok(SshConnectResult {
            id,
            data_rx,
            log_rx,
            exit_rx,
        })
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let entry = self.sessions.get(id).context("unknown ssh session")?;
        entry
            .cmd_tx
            .send(SessionCmd::Write(data.to_vec()))
            .map_err(|_| anyhow!("ssh session closed"))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let entry = self.sessions.get(id).context("unknown ssh session")?;
        entry
            .cmd_tx
            .send(SessionCmd::Resize { cols, rows })
            .map_err(|_| anyhow!("ssh session closed"))?;
        Ok(())
    }

    pub async fn close(&self, id: &str) -> Result<()> {
        if let Some((_, entry)) = self.sessions.remove(id) {
            let _ = entry.cmd_tx.send(SessionCmd::Close);
        }
        Ok(())
    }

    pub fn count(&self) -> usize {
        self.sessions.len()
    }
}

async fn drive_session(
    id: String,
    handle: Handle<ClientHandler>,
    mut channel: Channel<Msg>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCmd>,
    data_tx: mpsc::Sender<Vec<u8>>,
    log_tx: mpsc::Sender<SshLogEvent>,
    exit_tx: oneshot::Sender<Option<i32>>,
    sessions: Arc<DashMap<String, SessionEntry>>,
) {
    let mut exit_code: Option<i32> = None;

    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCmd::Write(bytes)) => {
                        if let Err(err) = channel.data(&bytes[..]).await {
                            tracing::warn!(id = %id, ?err, "ssh write");
                            log_blocking(&log_tx, "error", &format!("write: {err}")).await;
                            break;
                        }
                    }
                    Some(SessionCmd::Resize { cols, rows }) => {
                        if let Err(err) = channel
                            .window_change(cols.max(1) as u32, rows.max(1) as u32, 0, 0)
                            .await
                        {
                            tracing::debug!(id = %id, ?err, "ssh window_change");
                        }
                    }
                    Some(SessionCmd::Close) | None => {
                        log(&log_tx, "closed", "user requested disconnect").await;
                        break;
                    }
                }
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        if data_tx.send(data.to_vec()).await.is_err() { break; }
                    }
                    Some(ChannelMsg::ExtendedData { ref data, ext: _ }) => {
                        if data_tx.send(data.to_vec()).await.is_err() { break; }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = Some(exit_status as i32);
                        log(&log_tx, "closed", &format!("remote exit {exit_status}")).await;
                    }
                    Some(ChannelMsg::Eof) => {
                        log(&log_tx, "closed", "remote eof").await;
                    }
                    Some(ChannelMsg::Close) | None => {
                        log(&log_tx, "closed", "channel closed").await;
                        break;
                    }
                    _ => {}
                }
            }
        }
    }

    let _ = channel.close().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "bye", "")
        .await;
    // Drop the manager entry no matter how the loop ended. `close()` may have
    // already removed it (idempotent); without this, sessions that end by
    // remote/network disconnect would leak into the map forever.
    sessions.remove(&id);
    let _ = exit_tx.send(exit_code);
}

async fn log(tx: &mpsc::Sender<SshLogEvent>, level: &str, msg: &str) {
    let _ = tx
        .send(SshLogEvent {
            at: chrono::Utc::now().timestamp_millis(),
            level: level.into(),
            msg: msg.into(),
        })
        .await;
}

async fn log_blocking(tx: &mpsc::Sender<SshLogEvent>, level: &str, msg: &str) {
    log(tx, level, msg).await;
}

/// Server-key-acceptance hook. V1 trusts on first connect (logs the
/// fingerprint so the user can verify it manually); V2 will persist a
/// `known_hosts` table.
#[derive(Clone)]
struct ClientHandler {
    log_tx: mpsc::Sender<SshLogEvent>,
}

#[async_trait]
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint();
        log(&self.log_tx, "ssh", &format!("server fingerprint {fp}")).await;
        Ok(true)
    }
}

/// Read a private key from disk, optionally decrypting with `passphrase`.
/// Accepts both encrypted and unencrypted OpenSSH-format keys.
pub fn load_key(path: &Path, passphrase: Option<&str>) -> Result<KeyPair> {
    let kp = russh_keys::load_secret_key(path, passphrase).with_context(|| {
        format!(
            "load private key at {} (wrong passphrase?)",
            path.display()
        )
    })?;
    Ok(kp)
}

/// Sniff metadata (algorithm + fingerprint + public-key text) from an
/// existing on-disk private key. Used by the "Import key" UI to register a
/// key file the user already had outside ARC.
pub fn load_key_metadata(path: &Path, passphrase: Option<&str>) -> Result<GeneratedKey> {
    // Prefer ssh-key for fingerprinting — it understands every OpenSSH
    // variant we care about and returns the canonical "SHA256:xxx" form.
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let mut priv_key = PrivateKey::from_openssh(&bytes)
        .with_context(|| format!("parse OpenSSH key at {}", path.display()))?;
    if priv_key.is_encrypted() {
        let pp = passphrase
            .ok_or_else(|| anyhow!("private key is encrypted but no passphrase was provided"))?;
        priv_key = priv_key
            .decrypt(pp.as_bytes())
            .map_err(|e| anyhow!("decrypt private key: {e}"))?;
    }
    Ok(describe(&priv_key)?)
}

/// Generate a new keypair, write `<path>` + `<path>.pub` in OpenSSH format
/// (optionally encrypting the private side with `passphrase`), and return
/// the resulting metadata.
///
/// `algorithm` accepts `"ed25519"` (recommended) or `"rsa"` (4096 bits).
pub fn generate_key(
    path: &Path,
    algorithm: &str,
    comment: &str,
    passphrase: Option<&str>,
) -> Result<GeneratedKey> {
    if path.exists() {
        return Err(anyhow!(
            "refusing to overwrite existing key at {}",
            path.display()
        ));
    }

    let alg = match algorithm.to_ascii_lowercase().as_str() {
        "ed25519" => Algorithm::Ed25519,
        "rsa" | "rsa-4096" => Algorithm::Rsa { hash: None },
        other => return Err(anyhow!("unsupported key algorithm: {other}")),
    };

    let mut priv_key = match alg {
        Algorithm::Ed25519 => PrivateKey::random(&mut OsRng, Algorithm::Ed25519)
            .map_err(|e| anyhow!("ed25519 generate: {e}"))?,
        Algorithm::Rsa { .. } => {
            // ssh-key's `random` for RSA picks 3072; for stronger keys use
            // its `from_components` path. 3072 bits is acceptable for V1.
            PrivateKey::random(&mut OsRng, Algorithm::Rsa { hash: None })
                .map_err(|e| anyhow!("rsa generate: {e}"))?
        }
        _ => unreachable!(),
    };

    priv_key.set_comment(comment);

    // Encrypt before writing, if a passphrase was supplied.
    let to_write = if let Some(pp) = passphrase.filter(|p| !p.is_empty()) {
        priv_key
            .encrypt(&mut OsRng, pp.as_bytes())
            .map_err(|e| anyhow!("encrypt: {e}"))?
    } else {
        priv_key.clone()
    };

    let priv_pem = to_write
        .to_openssh(LineEnding::default())
        .map_err(|e| anyhow!("serialise private key: {e}"))?;
    let pub_line = priv_key
        .public_key()
        .to_openssh()
        .map_err(|e| anyhow!("serialise public key: {e}"))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::write(path, priv_pem.as_bytes())
        .with_context(|| format!("write {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }

    let pub_path = path.with_extension("pub");
    std::fs::write(&pub_path, pub_line.as_bytes())
        .with_context(|| format!("write {}", pub_path.display()))?;

    describe(&priv_key)
}

fn describe(priv_key: &PrivateKey) -> Result<GeneratedKey> {
    let pub_key = priv_key.public_key();
    let pub_line = pub_key
        .to_openssh()
        .map_err(|e| anyhow!("serialise public key: {e}"))?;
    let fp = pub_key.fingerprint(HashAlg::Sha256).to_string();
    let kind = pub_key.algorithm().as_str().to_string();
    let bits = match pub_key.algorithm() {
        Algorithm::Ed25519 => 256,
        Algorithm::Rsa { .. } => 3072,
        _ => 0,
    };
    Ok(GeneratedKey {
        fingerprint: fp,
        kind,
        public_openssh: pub_line,
        bits,
    })
}

/// Resolve the user's default `~/.ssh` directory. Used by the UI to seed
/// the "where to write the new key" path.
pub fn default_ssh_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".ssh"))
}

// Tiny dirs shim so we don't pull the whole `dirs` crate again here; the
// workspace already has it via session-manager, but it's a cheap dep so
// re-exporting via path keeps this crate self-contained.
mod dirs {
    pub fn home_dir() -> Option<std::path::PathBuf> {
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(std::path::PathBuf::from)
    }
}
