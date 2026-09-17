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
//! Host keys are verified against `~/.ssh/known_hosts` — the standard file, so
//! trust is shared with the user's own `ssh` rather than kept in a private
//! store that could disagree with it. A *changed* key aborts the connection
//! outright with no override; an *unknown* one is put to the user as a
//! [`HostKeyPrompt`] and only written down once they accept.
//!
//! A host can be reached through one jump host (ProxyJump): [`dial`] logs in
//! to the jump host, opens a `direct-tcpip` channel to the target and runs the
//! target's handshake over that channel. Shell sessions and SFTP both dial
//! through it, so both get jump hosts. Live shell sessions also carry port
//! forwards — see [`forward`].
//!
//! V1 caveats:
//!   * Authentication is publickey-only.
//!   * Certificate host keys are refused rather than verified — there is no
//!     way to pin a CA yet, and accepting one unchecked would bypass all of
//!     the above.

use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use getrandom::SysRng;
use rand_core::UnwrapErr;
use russh::client::{self, Handle, Msg};
use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
use russh::keys::{known_hosts, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, oneshot, Mutex};
use uuid::Uuid;

pub mod exec;
pub mod forward;
pub mod sftp;

pub use exec::{remote_command, shell_join, shell_quote, ExecEvent, ExecOutput};
pub use forward::{check_jump, ForwardKind, ForwardSpec};
pub use sftp::{
    parse_remote_uri, posix_join, posix_parent, remote_uri, RemoteDirEntry, RemoteFsOpts,
    SftpManager, MAX_REMOTE_FILE_BYTES,
};

const DATA_CHANNEL_CAP: usize = 256;
const LOG_CHANNEL_CAP: usize = 64;
pub(crate) const HANDSHAKE_TIMEOUT_SECS: u64 = 25;
/// How long an unknown-host-key prompt waits for a human before giving up and
/// refusing. Generous, because reading a fingerprint off another screen is
/// slow, but finite so an unanswered prompt cannot pin a socket forever.
pub(crate) const HOST_KEY_PROMPT_TIMEOUT_SECS: u64 = 120;

/// Connection request handed to [`SshManager::connect`]. Sensitive material
/// (the private-key passphrase) is resolved by the caller before this hits
/// the manager — the keyring lookup lives in the command layer.
#[derive(Debug, Clone, Deserialize)]
pub struct SshConnectOpts {
    pub target: SshEndpoint,
    /// Log in here first and reach `target` through it (ProxyJump).
    #[serde(default)]
    pub jump: Option<SshEndpoint>,
    /// Terminal grid the remote PTY should be allocated with.
    pub cols: u16,
    pub rows: u16,
    /// Optional command to run after the shell starts (single line).
    pub startup_cmd: Option<String>,
    /// Keepalive interval (seconds). 0 disables.
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u32,
    /// Started once the shell is up. A forward that fails (port in use) is
    /// logged and listed as failed; it doesn't fail the session.
    #[serde(default)]
    pub forwards: Vec<ForwardSpec>,
}

/// Where to connect and who to log in as. The target and its jump host are
/// both one of these.
#[derive(Debug, Clone, Deserialize)]
pub struct SshEndpoint {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Path to an OpenSSH-format private key on disk.
    pub identity_path: String,
    /// Optional passphrase for the identity. Already-resolved cleartext —
    /// the caller is responsible for sourcing this from the OS keyring.
    pub passphrase: Option<String>,
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
    /// `ready`, `data`, `forward`, `error`, `closed`.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardState {
    Active,
    Stopped,
    Failed,
}

/// A forward on a live session and how it is doing.
#[derive(Debug, Clone, Serialize)]
pub struct ForwardInfo {
    pub id: String,
    #[serde(flatten)]
    pub spec: ForwardSpec,
    pub state: ForwardState,
    /// Why it failed, e.g. the port is already in use.
    pub error: Option<String>,
}

struct ForwardEntry {
    info: ForwardInfo,
    /// Local forwards only: the accept loop. Aborting it drops the listener
    /// and, through its JoinSet, every connection it is still piping.
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for ForwardEntry {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Server port -> local `host:port` for the session's active `-R` forwards.
/// Shared with the [`ClientHandler`], which is where the server's
/// `forwarded-tcpip` channels arrive.
pub(crate) type RemoteForwards = Arc<DashMap<u32, (String, u16)>>;

/// Remote forwards bind the server's loopback, never all interfaces.
const REMOTE_BIND_ADDR: &str = "localhost";

/// The forwards on one live session. Dropped with the session entry, which
/// aborts every local listener.
struct SessionForwards {
    handle: Arc<Handle<ClientHandler>>,
    remote: RemoteForwards,
    list: Mutex<Vec<ForwardEntry>>,
}

impl SessionForwards {
    async fn start(&self, entry: &mut ForwardEntry) {
        if entry.info.state == ForwardState::Active {
            return;
        }
        match open_forward(&self.handle, &self.remote, &entry.info.spec).await {
            Ok(task) => {
                entry.task = task;
                entry.info.state = ForwardState::Active;
                entry.info.error = None;
            }
            Err(err) => {
                entry.info.state = ForwardState::Failed;
                entry.info.error = Some(format!("{err:#}"));
            }
        }
    }

    async fn stop(&self, entry: &mut ForwardEntry) {
        if let Some(task) = entry.task.take() {
            task.abort();
        }
        let spec = &entry.info.spec;
        if spec.kind == ForwardKind::Remote && entry.info.state == ForwardState::Active {
            self.remote.remove(&(spec.bind_port as u32));
            let _ = self
                .handle
                .cancel_tcpip_forward(REMOTE_BIND_ADDR, spec.bind_port as u32)
                .await;
        }
        entry.info.state = ForwardState::Stopped;
        entry.info.error = None;
    }

    async fn add(&self, spec: ForwardSpec) -> ForwardInfo {
        let mut entry = ForwardEntry {
            info: ForwardInfo {
                id: Uuid::new_v4().to_string(),
                spec,
                state: ForwardState::Stopped,
                error: None,
            },
            task: None,
        };
        self.start(&mut entry).await;
        let info = entry.info.clone();
        self.list.lock().await.push(entry);
        info
    }

    async fn snapshot(&self) -> Vec<ForwardInfo> {
        self.list.lock().await.iter().map(|e| e.info.clone()).collect()
    }
}

/// Open one forward. Returns the accept-loop task for a local forward.
async fn open_forward(
    handle: &Arc<Handle<ClientHandler>>,
    remote: &RemoteForwards,
    spec: &ForwardSpec,
) -> Result<Option<tokio::task::JoinHandle<()>>> {
    spec.validate()?;
    match spec.kind {
        ForwardKind::Local => {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", spec.bind_port))
                .await
                .with_context(|| format!("listen on 127.0.0.1:{}", spec.bind_port))?;
            let handle = handle.clone();
            let dest_host = spec.dest_host.clone();
            let dest_port = spec.dest_port;
            Ok(Some(tokio::spawn(async move {
                let mut conns = tokio::task::JoinSet::new();
                loop {
                    let (mut sock, peer) = match listener.accept().await {
                        Ok(v) => v,
                        Err(err) => {
                            // e.g. out of file descriptors; back off rather
                            // than spin, and keep listening.
                            tracing::warn!(?err, "forward accept");
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                            continue;
                        }
                    };
                    while conns.try_join_next().is_some() {}
                    let handle = handle.clone();
                    let dest_host = dest_host.clone();
                    conns.spawn(async move {
                        match handle
                            .channel_open_direct_tcpip(
                                dest_host.as_str(),
                                dest_port as u32,
                                peer.ip().to_string(),
                                peer.port() as u32,
                            )
                            .await
                        {
                            Ok(channel) => {
                                let mut stream = channel.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                            }
                            Err(err) => {
                                tracing::debug!(?err, %dest_host, dest_port, "direct-tcpip refused");
                            }
                        }
                    });
                }
            })))
        }
        ForwardKind::Remote => {
            let port = spec.bind_port as u32;
            if remote.contains_key(&port) {
                return Err(anyhow!("server port {port} is already forwarded"));
            }
            // Registered before the request so a connection that lands the
            // moment the server starts listening already has somewhere to go.
            remote.insert(port, (spec.dest_host.clone(), spec.dest_port));
            if let Err(err) = handle.tcpip_forward(REMOTE_BIND_ADDR, port).await {
                remote.remove(&port);
                return Err(anyhow!("server refused to listen on port {port}: {err}"));
            }
            Ok(None)
        }
    }
}

fn describe_forward(spec: &ForwardSpec) -> String {
    match spec.kind {
        ForwardKind::Local => format!(
            "-L 127.0.0.1:{} -> {}:{}",
            spec.bind_port, spec.dest_host, spec.dest_port
        ),
        ForwardKind::Remote => format!(
            "-R server:{} -> {}:{}",
            spec.bind_port, spec.dest_host, spec.dest_port
        ),
    }
}

/// A logged-in transport, plus the jump-host connection it rides on. The jump
/// connection must outlive the target's, since every target byte flows
/// through one of its channels.
pub(crate) struct Dialed {
    pub(crate) handle: Handle<ClientHandler>,
    pub(crate) jump: Option<Handle<ClientHandler>>,
    pub(crate) remote_forwards: RemoteForwards,
}

/// Connect and authenticate to `target`, through `jump` if given. Shared by
/// shell sessions and SFTP so both verify host keys and reach jump hosts the
/// same way.
pub(crate) async fn dial(
    target: &SshEndpoint,
    jump: Option<&SshEndpoint>,
    keepalive_secs: u32,
    asker: Option<HostKeyAsker>,
    log_tx: Option<&mpsc::Sender<SshLogEvent>>,
) -> Result<Dialed> {
    // SSH client config — generous handshake timeout, conservative
    // keepalive.  russh uses its own ed25519/curve25519 defaults; we
    // only override the bits we care about.
    let mut config = client::Config::default();
    config.inactivity_timeout = None;
    config.keepalive_interval = if keepalive_secs > 0 {
        Some(std::time::Duration::from_secs(keepalive_secs as u64))
    } else {
        None
    };
    let config = Arc::new(config);

    let say = |level: &'static str, msg: String| async move {
        if let Some(tx) = log_tx {
            log(tx, level, &msg).await;
        }
    };

    let jump_handle = match jump {
        Some(j) => {
            say("tcp", format!("jump host {}@{}:{}", j.username, j.host, j.port)).await;
            let tcp = tcp_connect(j).await?;
            let handle = login(config.clone(), tcp, j, asker.clone(), log_tx, Default::default())
                .await
                .context("jump host")?;
            say("tcp", format!("tunnel to {}:{}", target.host, target.port)).await;
            Some(handle)
        }
        None => None,
    };

    // The target's handler answers its `forwarded-tcpip` opens, so it shares
    // this map with the session that fills it.
    let remote_forwards = RemoteForwards::default();
    let handle = match &jump_handle {
        Some(j) => {
            let channel = j
                .channel_open_direct_tcpip(target.host.as_str(), target.port as u32, "127.0.0.1", 0)
                .await
                .with_context(|| {
                    format!("jump host couldn't reach {}:{}", target.host, target.port)
                })?;
            login(config, channel.into_stream(), target, asker, log_tx, remote_forwards.clone())
                .await?
        }
        None => {
            let tcp = tcp_connect(target).await?;
            login(config, tcp, target, asker, log_tx, remote_forwards.clone()).await?
        }
    };
    Ok(Dialed {
        handle,
        jump: jump_handle,
        remote_forwards,
    })
}

async fn tcp_connect(ep: &SshEndpoint) -> Result<tokio::net::TcpStream> {
    tokio::time::timeout(
        std::time::Duration::from_secs(HANDSHAKE_TIMEOUT_SECS),
        tokio::net::TcpStream::connect((ep.host.as_str(), ep.port)),
    )
    .await
    .map_err(|_| anyhow!("connect timeout after {HANDSHAKE_TIMEOUT_SECS}s"))?
    .with_context(|| format!("connect {}:{}", ep.host, ep.port))
}

/// SSH handshake + publickey auth for one endpoint over any byte stream — a
/// TCP socket, or a channel through the jump host.
async fn login<S>(
    config: Arc<client::Config>,
    stream: S,
    ep: &SshEndpoint,
    asker: Option<HostKeyAsker>,
    log_tx: Option<&mpsc::Sender<SshLogEvent>>,
    remote_forwards: RemoteForwards,
) -> Result<Handle<ClientHandler>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    // Load identity first so a wrong passphrase fails before any network
    // round-trip (the caller already resolved it from the OS keychain).
    let key_pair = load_key(Path::new(&ep.identity_path), ep.passphrase.as_deref())
        .context("load identity")?;
    if let Some(tx) = log_tx {
        log(tx, "auth", &format!("identity {} loaded", ep.identity_path)).await;
        log(tx, "tcp", "connected").await;
    }

    // The handshake budget has to cover a human reading a fingerprint when
    // a prompt is possible, because `check_server_key` runs inside this
    // future. Without the extra allowance the connection would time out
    // underneath anyone who paused to actually check the key — training
    // them to click through it next time.
    let budget = if asker.is_some() {
        HANDSHAKE_TIMEOUT_SECS + HOST_KEY_PROMPT_TIMEOUT_SECS
    } else {
        HANDSHAKE_TIMEOUT_SECS
    };
    let handler = ClientHandler {
        log_tx: log_tx.cloned(),
        host: ep.host.clone(),
        port: ep.port,
        asker,
        remote_forwards,
    };
    let mut handle: Handle<ClientHandler> = tokio::time::timeout(
        std::time::Duration::from_secs(budget),
        client::connect_stream(config, stream, handler),
    )
    .await
    .map_err(|_| anyhow!("connect timeout after {budget}s"))?
    .with_context(|| format!("connect {}:{}", ep.host, ep.port))?;
    if let Some(tx) = log_tx {
        log(tx, "kex", "key exchange complete").await;
    }

    // russh now wants the key paired with the signature hash. SHA-512 is
    // not a preference here — passing `None` makes russh sign RSA with
    // SHA-1 (`ssh-rsa`), which OpenSSH 8.8+ refuses by default, so an RSA
    // identity would simply stop working. russh ignores the hash for
    // Ed25519, so this is correct for every key type ARC can generate.
    let authed = handle
        .authenticate_publickey(
            &ep.username,
            PrivateKeyWithHashAlg::new(Arc::new(key_pair), Some(HashAlg::Sha512)),
        )
        .await
        .context("publickey auth")?;
    // No longer a bool: partial success is representable now. Anything
    // that isn't outright success is a failure for a publickey-only
    // client, since there is no second method to fall through to.
    if !authed.success() {
        if let Some(tx) = log_tx {
            log_blocking(tx, "error", "publickey rejected").await;
        }
        return Err(anyhow!("authentication failed: publickey rejected"));
    }
    if let Some(tx) = log_tx {
        log(tx, "auth", &format!("publickey accepted for {}", ep.host)).await;
    }
    Ok(handle)
}

enum SessionCmd {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

struct SessionEntry {
    cmd_tx: mpsc::UnboundedSender<SessionCmd>,
    forwards: Arc<SessionForwards>,
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
    ///
    /// `asker` receives a [`HostKeyPrompt`] if the server presents a key that
    /// isn't in `~/.ssh/known_hosts`. Pass `None` only where no one can
    /// answer — an unknown key is then refused rather than trusted.
    pub async fn connect(
        &self,
        opts: SshConnectOpts,
        asker: Option<HostKeyAsker>,
    ) -> Result<SshConnectResult> {
        let (data_tx, data_rx) = mpsc::channel::<Vec<u8>>(DATA_CHANNEL_CAP);
        let (log_tx, log_rx) = mpsc::channel::<SshLogEvent>(LOG_CHANNEL_CAP);
        let (exit_tx, exit_rx) = oneshot::channel::<Option<i32>>();

        log(
            &log_tx,
            "resolve",
            &format!("{}:{}", opts.target.host, opts.target.port),
        )
        .await;

        let Dialed {
            handle,
            jump,
            remote_forwards,
        } = dial(
            &opts.target,
            opts.jump.as_ref(),
            opts.keepalive_secs,
            asker,
            Some(&log_tx),
        )
        .await?;

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

        // Shared so local forwards can open channels while the driver task
        // owns the shell.
        let handle = Arc::new(handle);
        let forwards = Arc::new(SessionForwards {
            handle: handle.clone(),
            remote: remote_forwards,
            list: Mutex::new(Vec::new()),
        });
        for spec in opts.forwards {
            let desc = describe_forward(&spec);
            let info = forwards.add(spec).await;
            let msg = match &info.error {
                None => format!("{desc} active"),
                Some(err) => format!("{desc} failed: {err}"),
            };
            // Not "error": that level marks the whole session failed, and a
            // busy port shouldn't take the shell down with it.
            log(&log_tx, "forward", &msg).await;
        }

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCmd>();
        let id = Uuid::new_v4().to_string();
        self.sessions.insert(
            id.clone(),
            SessionEntry {
                cmd_tx: cmd_tx.clone(),
                forwards,
            },
        );

        let driver_id = id.clone();
        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            drive_session(
                driver_id, handle, jump, channel, cmd_rx, data_tx, log_tx, exit_tx, sessions,
            )
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

    fn forwards(&self, id: &str) -> Result<Arc<SessionForwards>> {
        self.sessions
            .get(id)
            .map(|e| e.forwards.clone())
            .context("unknown ssh session")
    }

    pub async fn forward_list(&self, id: &str) -> Result<Vec<ForwardInfo>> {
        Ok(self.forwards(id)?.snapshot().await)
    }

    /// Add a forward to a live session and start it. A forward that can't
    /// start is still added, as failed, so the user sees why.
    pub async fn forward_add(&self, id: &str, spec: ForwardSpec) -> Result<Vec<ForwardInfo>> {
        spec.validate()?;
        let forwards = self.forwards(id)?;
        forwards.add(spec).await;
        Ok(forwards.snapshot().await)
    }

    pub async fn forward_set_active(
        &self,
        id: &str,
        forward_id: &str,
        active: bool,
    ) -> Result<Vec<ForwardInfo>> {
        let forwards = self.forwards(id)?;
        {
            let mut list = forwards.list.lock().await;
            let entry = list
                .iter_mut()
                .find(|e| e.info.id == forward_id)
                .context("unknown forward")?;
            if active {
                forwards.start(entry).await;
            } else {
                forwards.stop(entry).await;
            }
        }
        Ok(forwards.snapshot().await)
    }

    pub async fn forward_remove(&self, id: &str, forward_id: &str) -> Result<Vec<ForwardInfo>> {
        let forwards = self.forwards(id)?;
        {
            let mut list = forwards.list.lock().await;
            if let Some(pos) = list.iter().position(|e| e.info.id == forward_id) {
                let mut entry = list.remove(pos);
                forwards.stop(&mut entry).await;
            }
        }
        Ok(forwards.snapshot().await)
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_session(
    id: String,
    handle: Arc<Handle<ClientHandler>>,
    jump: Option<Handle<ClientHandler>>,
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
    if let Some(jump) = jump {
        let _ = jump
            .disconnect(russh::Disconnect::ByApplication, "bye", "")
            .await;
    }
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

/// A host key ARC has never seen, handed out for a human to accept or refuse.
///
/// This is the OpenSSH "authenticity of host … can't be established" moment.
/// The connection is parked on `reply` until someone answers, so whoever
/// receives this must always send exactly one answer — dropping the sender
/// counts as a refusal, which is the safe way to fail.
#[derive(Debug)]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    /// `SHA256:…`, the form OpenSSH prints and users actually compare.
    pub fingerprint: String,
    /// e.g. `ssh-ed25519`.
    pub algorithm: String,
    pub reply: oneshot::Sender<bool>,
}

/// Where unknown-host-key questions go. `None` means nobody is listening, and
/// an unknown key is refused rather than silently trusted.
pub type HostKeyAsker = mpsc::Sender<HostKeyPrompt>;

/// Verifies the server's key against `~/.ssh/known_hosts` before the session
/// is allowed to proceed.
///
/// The standard file on purpose: a host trusted from a terminal works in ARC
/// straight away, and one ARC learns works in the terminal. A private store
/// would make ARC disagree with `ssh` about the same machine, which is the
/// worst possible time to be confusing.
#[derive(Clone)]
pub(crate) struct ClientHandler {
    /// `None` for connections with no UI attached (the SFTP transport), where
    /// there is no handshake progress list to feed.
    log_tx: Option<mpsc::Sender<SshLogEvent>>,
    /// Needed to look the key up: known_hosts is keyed by host and port.
    host: String,
    port: u16,
    /// `None` when there is no one to ask, e.g. a headless reconnect.
    asker: Option<HostKeyAsker>,
    /// Where the server's `forwarded-tcpip` channels get piped to.
    remote_forwards: RemoteForwards,
}

impl ClientHandler {
    async fn say(&self, level: &str, msg: &str) {
        if let Some(tx) = &self.log_tx {
            log(tx, level, msg).await;
        }
    }
}

// No `#[async_trait]`: russh 0.5x moved `Handler` to native async-in-trait,
// and the attribute's rewritten lifetimes no longer match the declaration.
impl client::Handler for ClientHandler {
    type Error = russh::Error;

    /// A connection to one of our `-R` forwards. Returning without accepting
    /// drops `reply`, which rejects — the answer for a port we never asked
    /// for. The local connect runs in its own task: this callback sits on the
    /// session's event loop, and a slow local service mustn't stall the shell.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some((host, port)) = self.remote_forwards.get(&connected_port).map(|d| d.clone())
        else {
            return Ok(());
        };
        reply.accept().await;
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                Ok(mut sock) => {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                }
                Err(err) => {
                    tracing::debug!(?err, %host, port, "remote forward: local connect");
                    let _ = channel.close().await;
                }
            }
        });
        Ok(())
    }

    // SECURITY: this accepts every host key it is offered. That predates the
    // russh upgrade — see the "V1 caveats" note at the top of this file — and
    // it means a session can be MITM'd by anything that can answer on the
    // host:port. russh ships `russh::keys::known_hosts` for the real fix; it
    // needs a first-use prompt and a mismatch path in the UI, which is its own
    // piece of work rather than something to smuggle into a version bump.
    /// Three outcomes, and the middle one is the whole point:
    ///
    ///   * known and matching — proceed silently, like every other SSH client
    ///   * known and **different** — refuse, no prompt, no override. This is
    ///     what an interception looks like, and offering a button here would
    ///     defeat the check for exactly the users least able to judge it.
    ///     Recovering means editing known_hosts by hand, deliberately.
    ///   * unknown — ask, and remember the answer
    ///
    /// Returning `Ok(false)` aborts the handshake; `Err` is reserved for the
    /// check itself failing.
    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Certificate-authority host keys are a different trust model — the
        // CA vouches, so known_hosts has nothing to say. ARC has no way to
        // pin a CA yet, and silently accepting one would be a hole straight
        // through everything below.
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key,
            PublicKeyOrCertificate::Certificate(_) => {
                self.say(
                    "error",
                    "server offered a certificate host key, which ARC can't verify yet",
                )
                .await;
                return Ok(false);
            }
        };

        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let alg = key.algorithm().as_str().to_string();

        match known_hosts::check_known_hosts(&self.host, self.port, key) {
            Ok(true) => {
                self.say("ssh", &format!("host key {fp} matches known_hosts")).await;
                Ok(true)
            }
            Err(russh::keys::Error::KeyChanged { line }) => {
                self.say(
                    "error",
                    &format!(
                        "HOST KEY CHANGED for {}:{} — known_hosts line {} expects a different \
                         key, server offered {fp}. Refusing to connect. If this host was \
                         genuinely rebuilt, remove that line yourself.",
                        self.host, self.port, line,
                    ),
                )
                .await;
                Ok(false)
            }
            Err(e) => {
                // Could not read known_hosts at all. Failing open here would
                // silently disable verification for anyone with an unreadable
                // or missing-permission ~/.ssh, which is precisely backwards.
                self.say("error", &format!("cannot verify host key: {e}")).await;
                Ok(false)
            }
            Ok(false) => {
                let Some(asker) = self.asker.clone() else {
                    self.say(
                        "error",
                        &format!(
                            "unknown host key {fp} for {}:{} and nothing available to ask. \
                             Connect this host in a terminal tab first.",
                            self.host, self.port,
                        ),
                    )
                    .await;
                    return Ok(false);
                };

                self.say("ssh", &format!("unknown host key {fp} — waiting for you"))
                    .await;

                let (reply, answer) = oneshot::channel();
                let prompt = HostKeyPrompt {
                    host: self.host.clone(),
                    port: self.port,
                    fingerprint: fp.clone(),
                    algorithm: alg,
                    reply,
                };
                if asker.send(prompt).await.is_err() {
                    self.say("error", "nothing answered the host key prompt").await;
                    return Ok(false);
                }

                // Bounded: a prompt nobody ever answers must not pin an open
                // socket and a driver task forever. A dropped sender lands
                // here too, and both mean "not trusted".
                let accepted = match tokio::time::timeout(
                    std::time::Duration::from_secs(HOST_KEY_PROMPT_TIMEOUT_SECS),
                    answer,
                )
                .await
                {
                    Ok(Ok(v)) => v,
                    _ => false,
                };

                if !accepted {
                    self.say("error", "host key rejected").await;
                    return Ok(false);
                }

                // Only written once the human said yes, so a refused key is
                // never remembered as trusted.
                if let Err(e) = known_hosts::learn_known_hosts(&self.host, self.port, key) {
                    // The user accepted, so let the session continue — but say
                    // clearly that it will ask again, rather than leaving them
                    // wondering why.
                    self.say(
                        "error",
                        &format!("accepted, but couldn't write known_hosts ({e}) — will ask again"),
                    )
                    .await;
                } else {
                    self.say("ssh", &format!("host key {fp} added to known_hosts")).await;
                }
                Ok(true)
            }
        }
    }
}

/// The OS entropy source, adapted to the infallible RNG trait.
///
/// ssh-key 0.7 split fallible RNGs (`TryCryptoRng`) from infallible ones
/// (`CryptoRng`), and key generation wants the latter. `UnwrapErr` bridges
/// them by panicking if the OS generator fails — which is not a condition
/// worth threading a `Result` for, since there is no sensible way to finish
/// generating a key without entropy.
fn os_rng() -> UnwrapErr<SysRng> {
    UnwrapErr(SysRng)
}

/// Read a private key from disk, optionally decrypting with `passphrase`.
/// Accepts both encrypted and unencrypted OpenSSH-format keys.
pub fn load_key(path: &Path, passphrase: Option<&str>) -> Result<PrivateKey> {
    let kp = russh::keys::load_secret_key(path, passphrase).with_context(|| {
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
        Algorithm::Ed25519 => PrivateKey::random(&mut os_rng(), Algorithm::Ed25519)
            .map_err(|e| anyhow!("ed25519 generate: {e}"))?,
        Algorithm::Rsa { .. } => {
            // ssh-key's `random` for RSA picks 3072; for stronger keys use
            // its `from_components` path. 3072 bits is acceptable for V1.
            PrivateKey::random(&mut os_rng(), Algorithm::Rsa { hash: None })
                .map_err(|e| anyhow!("rsa generate: {e}"))?
        }
        _ => unreachable!(),
    };

    priv_key.set_comment(comment);

    // Encrypt before writing, if a passphrase was supplied.
    let to_write = if let Some(pp) = passphrase.filter(|p| !p.is_empty()) {
        priv_key
            .encrypt(&mut os_rng(), pp.as_bytes())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("arc-ssh-{name}-{stamp}"))
    }

    /// Generate, then read back, and check it is the same key.
    ///
    /// This exercises `os_rng()` — the one piece of the russh 0.63 upgrade
    /// with no other coverage. `OsRng` moved out of rand_core into getrandom
    /// between versions, and a wrong RNG here does not fail to compile: it
    /// panics at generation, or worse, produces a key that doesn't round-trip.
    #[test]
    fn generated_key_loads_back_identically() {
        let path = tmp("ed25519");
        let made = generate_key(&path, "ed25519", "arc-test", None).expect("generate");

        assert!(made.fingerprint.starts_with("SHA256:"), "{}", made.fingerprint);
        assert_eq!(made.kind, "ssh-ed25519");
        assert_eq!(made.bits, 256);
        assert!(path.with_extension("pub").exists() || path.exists());

        let loaded = load_key(&path, None).expect("load back");
        assert_eq!(
            loaded.public_key().fingerprint(HashAlg::Sha256).to_string(),
            made.fingerprint,
            "the key read back is not the key written",
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("pub"));
    }

    /// The encrypted path runs the RNG a second time, for the KDF salt, and
    /// is the one that breaks if a passphrase is mishandled — an unopenable
    /// private key is unrecoverable, not merely inconvenient.
    #[test]
    fn encrypted_key_needs_its_passphrase() {
        let path = tmp("enc");
        let made = generate_key(&path, "ed25519", "arc-test", Some("hunter2")).expect("generate");

        assert!(
            load_key(&path, None).is_err(),
            "an encrypted key must not load without its passphrase",
        );
        assert!(load_key(&path, Some("wrong")).is_err(), "wrong passphrase must fail");

        let loaded = load_key(&path, Some("hunter2")).expect("correct passphrase");
        assert_eq!(
            loaded.public_key().fingerprint(HashAlg::Sha256).to_string(),
            made.fingerprint,
        );

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("pub"));
    }

    #[test]
    fn refuses_to_overwrite_an_existing_key() {
        let path = tmp("dup");
        generate_key(&path, "ed25519", "first", None).expect("generate");
        assert!(
            generate_key(&path, "ed25519", "second", None).is_err(),
            "silently replacing a private key would destroy the only copy",
        );
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("pub"));
    }
    /// The contract `check_server_key` is built on, verified against russh
    /// rather than assumed from reading it.
    ///
    /// The three outcomes must stay distinguishable: unknown and changed both
    /// mean "do not proceed silently", but they are *different* — one asks the
    /// user, the other must never ask. If `KeyChanged` ever collapsed into
    /// `Ok(false)`, a changed key would quietly become a prompt, and a prompt
    /// is something people click through.
    #[test]
    fn known_hosts_tells_unknown_from_changed() {
        use russh::keys::known_hosts::{check_known_hosts_path, learn_known_hosts_path};

        let dir = tmp("kh");
        std::fs::create_dir_all(&dir).expect("tempdir");
        let file = dir.join("known_hosts");

        let key_a = generate_key(&dir.join("a"), "ed25519", "a", None).expect("key a");
        let key_b = generate_key(&dir.join("b"), "ed25519", "b", None).expect("key b");
        assert_ne!(key_a.fingerprint, key_b.fingerprint, "two distinct keys");

        // Comments are cleared deliberately. `ssh_key::PublicKey` derives
        // PartialEq over every field, comment included, and known_hosts lines
        // round-trip without one — so a key carrying a comment compares
        // unequal to its own recorded form and reads as CHANGED. Host keys off
        // the wire never have a comment (the protocol has no such field), so
        // clearing it here is what makes this test model reality rather than
        // an artefact of generate_key writing one.
        let strip = |p: &std::path::Path| {
            let mut k = load_key(p, None).unwrap().public_key().clone();
            k.set_comment("");
            k
        };
        let pub_a = strip(&dir.join("a"));
        let pub_b = strip(&dir.join("b"));

        // 1. Nothing recorded yet -> unknown, which is what triggers a prompt.
        assert_eq!(
            check_known_hosts_path("example.test", 22, &pub_a, &file).ok(),
            Some(false),
            "an unrecorded host must read as unknown, not as trusted",
        );

        // 2. After learning it -> trusted, silently.
        learn_known_hosts_path("example.test", 22, &pub_a, &file).expect("learn");
        assert_eq!(
            check_known_hosts_path("example.test", 22, &pub_a, &file).ok(),
            Some(true),
            "the key we just recorded must verify",
        );

        // 3. Same host, different key -> KeyChanged. This is the attack shape,
        //    and the one case that must never become a question.
        assert!(
            matches!(
                check_known_hosts_path("example.test", 22, &pub_b, &file),
                Err(russh::keys::Error::KeyChanged { .. }),
            ),
            "a different key for a known host must be KeyChanged, not Ok(false)",
        );

        // 4. Port is part of the identity: same key, different port is a
        //    different entry, so it must not inherit trust.
        assert_eq!(
            check_known_hosts_path("example.test", 2222, &pub_a, &file).ok(),
            Some(false),
            "trust must not leak across ports",
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
