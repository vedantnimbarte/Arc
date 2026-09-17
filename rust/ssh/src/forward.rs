//! Port forwarding (`-L` / `-R` / `-D`) and the ProxyJump rules, kept apart
//! from the session plumbing so the parts that decide what is *allowed* can be
//! tested without a server.
//!
//! * **Local** (`-L`): ARC listens on `127.0.0.1:<bind_port>` and pipes each
//!   accepted socket through a `direct-tcpip` channel to `dest_host:dest_port`
//!   as seen from the server.
//! * **Remote** (`-R`): the server listens on its loopback `<bind_port>` and
//!   hands each connection back as a `forwarded-tcpip` channel, which ARC pipes
//!   to `dest_host:dest_port` as seen from this machine.
//! * **Dynamic** (`-D`): ARC listens on `127.0.0.1:<bind_port>` and speaks just
//!   enough SOCKS5 to learn where each connection wants to go, then opens a
//!   `direct-tcpip` channel there. The server makes every connection; a SOCKS
//!   client never gets a socket opened from this machine.
//!
//! Loopback only, every way. Binding a forward on every interface turns a
//! laptop (or the server) into an open relay for whoever shares the network,
//! and nobody reaches for that by accident in a GUI.
//!
//! Every change to a forward — started, stopped, failed, a connection opened,
//! closed or refused — pokes the session's [`watch`] channel, so whoever shows
//! the list can re-read it instead of polling.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use dashmap::DashMap;
use russh::client::{self, Handle, Msg};
use russh::Channel;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{watch, Mutex};
use uuid::Uuid;

use crate::ClientHandler;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

/// One forward, as saved on a host and as requested on a live session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForwardSpec {
    pub kind: ForwardKind,
    /// Local and dynamic: the port ARC listens on. Remote: the port the server
    /// listens on.
    pub bind_port: u16,
    /// Unused by dynamic forwards, where each SOCKS client names its own.
    #[serde(default)]
    pub dest_host: String,
    #[serde(default)]
    pub dest_port: u16,
}

impl ForwardSpec {
    /// Checked at the trust boundary (saving a host, adding a live forward)
    /// so a bad spec fails with a sentence instead of a socket error later.
    ///
    /// Port 0 is refused on the bind side: "any free port" would work, but the
    /// user would then have to go and find out which one, and a saved forward
    /// that moves every connect is not what anyone saves.
    pub fn validate(&self) -> Result<()> {
        if self.bind_port == 0 {
            return Err(anyhow!("listen port must be 1-65535"));
        }
        if self.kind == ForwardKind::Dynamic {
            return Ok(());
        }
        if self.dest_port == 0 {
            return Err(anyhow!("destination port must be 1-65535"));
        }
        let host = self.dest_host.trim();
        if host.is_empty() {
            return Err(anyhow!("destination host is required"));
        }
        if host.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(anyhow!("destination host can't contain spaces"));
        }
        Ok(())
    }
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
    /// Why it failed to start, e.g. the port is already in use.
    pub error: Option<String>,
    /// Connections being piped right now.
    pub active_conns: u32,
    /// Connections accepted since the forward was added.
    pub total_conns: u64,
    /// The latest connection that failed after the forward started: the
    /// destination refused, or a SOCKS client asked for something unsupported.
    pub last_error: Option<ConnError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnError {
    /// Unix-epoch milliseconds.
    pub at: i64,
    pub msg: String,
}

/// Connection counters for one forward, shared with the tasks piping its
/// connections.
struct Tracker {
    active: AtomicU32,
    total: AtomicU64,
    last_error: parking_lot::Mutex<Option<ConnError>>,
    changed: watch::Sender<()>,
}

impl Tracker {
    /// Count a connection in. It is counted out when the guard drops, however
    /// the connection ends.
    fn open(self: &Arc<Self>) -> ConnGuard {
        self.active.fetch_add(1, Ordering::Relaxed);
        self.total.fetch_add(1, Ordering::Relaxed);
        self.changed.send_replace(());
        ConnGuard(self.clone())
    }

    fn fail(&self, msg: String) {
        tracing::debug!(%msg, "forward connection failed");
        *self.last_error.lock() = Some(ConnError {
            at: chrono::Utc::now().timestamp_millis(),
            msg,
        });
        self.changed.send_replace(());
    }
}

struct ConnGuard(Arc<Tracker>);

impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
        self.0.changed.send_replace(());
    }
}

struct ForwardEntry {
    id: String,
    spec: ForwardSpec,
    state: ForwardState,
    error: Option<String>,
    tracker: Arc<Tracker>,
    /// Local and dynamic forwards only: the accept loop. Aborting it drops the
    /// listener and, through its JoinSet, every connection it is still piping.
    task: Option<tokio::task::JoinHandle<()>>,
}

impl ForwardEntry {
    fn info(&self) -> ForwardInfo {
        ForwardInfo {
            id: self.id.clone(),
            spec: self.spec.clone(),
            state: self.state,
            error: self.error.clone(),
            active_conns: self.tracker.active.load(Ordering::Relaxed),
            total_conns: self.tracker.total.load(Ordering::Relaxed),
            last_error: self.tracker.last_error.lock().clone(),
        }
    }
}

impl Drop for ForwardEntry {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

/// Where one `-R` forward's connections go.
#[derive(Clone)]
pub(crate) struct RemoteTarget {
    host: String,
    port: u16,
    tracker: Arc<Tracker>,
}

/// Server port -> local target for the connection's active `-R` forwards.
/// Shared with the [`ClientHandler`], which is where the server's
/// `forwarded-tcpip` channels arrive.
pub(crate) type RemoteForwards = Arc<DashMap<u32, RemoteTarget>>;

/// Remote forwards bind the server's loopback, never all interfaces.
const REMOTE_BIND_ADDR: &str = "localhost";

/// The forwards on one connection. Dropped with it, which aborts every local
/// listener.
pub(crate) struct SessionForwards {
    handle: Arc<Handle<ClientHandler>>,
    remote: RemoteForwards,
    list: Mutex<Vec<ForwardEntry>>,
    changed: watch::Sender<()>,
}

impl SessionForwards {
    pub(crate) fn new(handle: Arc<Handle<ClientHandler>>, remote: RemoteForwards) -> Self {
        Self {
            handle,
            remote,
            list: Mutex::new(Vec::new()),
            changed: watch::Sender::new(()),
        }
    }

    /// Wakes on every change to any forward here. Ends once the connection
    /// and every task piping one of its forwards are gone.
    pub(crate) fn subscribe(&self) -> watch::Receiver<()> {
        self.changed.subscribe()
    }

    async fn start(&self, entry: &mut ForwardEntry) {
        if entry.state == ForwardState::Active {
            return;
        }
        match open_forward(&self.handle, &self.remote, &entry.spec, &entry.tracker).await {
            Ok(task) => {
                entry.task = task;
                entry.state = ForwardState::Active;
                entry.error = None;
            }
            Err(err) => {
                entry.state = ForwardState::Failed;
                entry.error = Some(format!("{err:#}"));
            }
        }
        self.changed.send_replace(());
    }

    async fn stop(&self, entry: &mut ForwardEntry) {
        if let Some(task) = entry.task.take() {
            task.abort();
        }
        let spec = &entry.spec;
        if spec.kind == ForwardKind::Remote && entry.state == ForwardState::Active {
            self.remote.remove(&(spec.bind_port as u32));
            let _ = self
                .handle
                .cancel_tcpip_forward(REMOTE_BIND_ADDR, spec.bind_port as u32)
                .await;
        }
        entry.state = ForwardState::Stopped;
        entry.error = None;
        self.changed.send_replace(());
    }

    /// Add a forward and start it. One that can't start is still added, as
    /// failed, so the user sees why.
    pub(crate) async fn add(&self, spec: ForwardSpec) -> ForwardInfo {
        let mut entry = ForwardEntry {
            id: Uuid::new_v4().to_string(),
            spec,
            state: ForwardState::Stopped,
            error: None,
            tracker: Arc::new(Tracker {
                active: AtomicU32::new(0),
                total: AtomicU64::new(0),
                last_error: parking_lot::Mutex::new(None),
                changed: self.changed.clone(),
            }),
            task: None,
        };
        self.start(&mut entry).await;
        let info = entry.info();
        self.list.lock().await.push(entry);
        info
    }

    pub(crate) async fn set_active(&self, forward_id: &str, active: bool) -> Result<()> {
        let mut list = self.list.lock().await;
        let entry = list
            .iter_mut()
            .find(|e| e.id == forward_id)
            .context("unknown forward")?;
        if active {
            self.start(entry).await;
        } else {
            self.stop(entry).await;
        }
        Ok(())
    }

    pub(crate) async fn remove(&self, forward_id: &str) {
        let mut list = self.list.lock().await;
        if let Some(pos) = list.iter().position(|e| e.id == forward_id) {
            let mut entry = list.remove(pos);
            self.stop(&mut entry).await;
        }
    }

    pub(crate) async fn snapshot(&self) -> Vec<ForwardInfo> {
        self.list
            .lock()
            .await
            .iter()
            .map(ForwardEntry::info)
            .collect()
    }
}

/// Open one forward. Returns the accept-loop task for a local or dynamic
/// forward.
async fn open_forward(
    handle: &Arc<Handle<ClientHandler>>,
    remote: &RemoteForwards,
    spec: &ForwardSpec,
    tracker: &Arc<Tracker>,
) -> Result<Option<tokio::task::JoinHandle<()>>> {
    spec.validate()?;
    match spec.kind {
        ForwardKind::Local | ForwardKind::Dynamic => {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", spec.bind_port))
                .await
                .with_context(|| format!("listen on 127.0.0.1:{}", spec.bind_port))?;
            let handle = handle.clone();
            let spec = spec.clone();
            let tracker = tracker.clone();
            Ok(Some(tokio::spawn(async move {
                let mut conns = tokio::task::JoinSet::new();
                loop {
                    let (sock, peer) = match listener.accept().await {
                        Ok(v) => v,
                        Err(err) => {
                            // e.g. out of file descriptors; back off rather
                            // than spin, and keep listening.
                            tracing::warn!(?err, "forward accept");
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            continue;
                        }
                    };
                    while conns.try_join_next().is_some() {}
                    let handle = handle.clone();
                    let spec = spec.clone();
                    let tracker = tracker.clone();
                    conns.spawn(async move {
                        let _conn = tracker.open();
                        if let Err(err) = pipe_local(&handle, &spec, sock, peer).await {
                            tracker.fail(format!("{err:#}"));
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
            remote.insert(
                port,
                RemoteTarget {
                    host: spec.dest_host.clone(),
                    port: spec.dest_port,
                    tracker: tracker.clone(),
                },
            );
            if let Err(err) = handle.tcpip_forward(REMOTE_BIND_ADDR, port).await {
                remote.remove(&port);
                return Err(anyhow!("server refused to listen on port {port}: {err}"));
            }
            Ok(None)
        }
    }
}

/// One connection accepted by a local or dynamic forward: find out where it
/// goes, then pipe it through a `direct-tcpip` channel.
async fn pipe_local(
    handle: &Handle<ClientHandler>,
    spec: &ForwardSpec,
    mut sock: TcpStream,
    peer: SocketAddr,
) -> Result<()> {
    let socks = spec.kind == ForwardKind::Dynamic;
    let (host, port, early) = if socks {
        socks_accept(&mut sock).await?
    } else {
        (spec.dest_host.clone(), spec.dest_port, Vec::new())
    };
    let channel = match handle
        .channel_open_direct_tcpip(
            host.as_str(),
            port as u32,
            peer.ip().to_string(),
            peer.port() as u32,
        )
        .await
    {
        Ok(channel) => channel,
        Err(err) => {
            if socks {
                let rep = match &err {
                    russh::Error::ChannelOpenFailure(
                        russh::ChannelOpenFailure::AdministrativelyProhibited,
                    ) => REP_NOT_ALLOWED,
                    russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed) => {
                        REP_REFUSED
                    }
                    _ => REP_GENERAL_FAILURE,
                };
                let _ = sock.write_all(&socks_reply(rep)).await;
            }
            return Err(anyhow!("server couldn't reach {host}:{port}: {err}"));
        }
    };
    let mut stream = channel.into_stream();
    if socks {
        sock.write_all(&socks_reply(REP_SUCCEEDED)).await?;
        stream.write_all(&early).await?;
    }
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
    Ok(())
}

/// A connection to one of our `-R` forwards, from the [`ClientHandler`].
/// Returning without accepting drops `reply`, which rejects — the answer for a
/// port we never asked for. The local connect runs in its own task: this is
/// called on the session's event loop, and a slow local service mustn't stall
/// the shell.
pub(crate) async fn accept_forwarded(
    remote: &RemoteForwards,
    channel: Channel<Msg>,
    connected_port: u32,
    reply: client::ChannelOpenHandle,
) {
    let Some(target) = remote.get(&connected_port).map(|t| t.clone()) else {
        return;
    };
    reply.accept().await;
    tokio::spawn(async move {
        let _conn = target.tracker.open();
        match TcpStream::connect((target.host.as_str(), target.port)).await {
            Ok(mut sock) => {
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
            }
            Err(err) => {
                target
                    .tracker
                    .fail(format!("connect {}:{}: {err}", target.host, target.port));
                let _ = channel.close().await;
            }
        }
    });
}

pub(crate) fn describe_forward(spec: &ForwardSpec) -> String {
    match spec.kind {
        ForwardKind::Local => format!(
            "-L 127.0.0.1:{} -> {}:{}",
            spec.bind_port, spec.dest_host, spec.dest_port
        ),
        ForwardKind::Remote => format!(
            "-R server:{} -> {}:{}",
            spec.bind_port, spec.dest_host, spec.dest_port
        ),
        ForwardKind::Dynamic => format!("-D 127.0.0.1:{} (SOCKS5)", spec.bind_port),
    }
}

// ---------- SOCKS5 (RFC 1928), CONNECT only --------------------------------

const SOCKS_VERSION: u8 = 5;
const METHOD_NO_AUTH: u8 = 0x00;
const METHOD_NONE_ACCEPTABLE: u8 = 0xFF;
const CMD_CONNECT: u8 = 0x01;
const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;
pub const REP_SUCCEEDED: u8 = 0x00;
pub const REP_GENERAL_FAILURE: u8 = 0x01;
pub const REP_NOT_ALLOWED: u8 = 0x02;
pub const REP_REFUSED: u8 = 0x05;
pub const REP_COMMAND_NOT_SUPPORTED: u8 = 0x07;
pub const REP_ADDRESS_NOT_SUPPORTED: u8 = 0x08;

/// A client that hasn't finished its handshake by then is dropped, so an idle
/// socket can't hold a slot forever.
const SOCKS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// What one SOCKS5 message at the start of a buffer amounts to.
#[derive(Debug, PartialEq, Eq)]
pub enum Socks<T> {
    /// Not a whole message yet; read more.
    Need,
    /// Parsed, using this many bytes of the buffer.
    Done(T, usize),
    /// Write `reply` (possibly nothing) and close.
    Refuse { reply: Vec<u8>, why: &'static str },
}

fn refuse<T>(reply: Vec<u8>, why: &'static str) -> Socks<T> {
    Socks::Refuse { reply, why }
}

/// The greeting: version, then the auth methods the client offers. Only "no
/// authentication" is accepted — the listener is loopback-only, and the SSH
/// login is the credential that matters.
pub fn socks_greeting(buf: &[u8]) -> Socks<()> {
    let &[ver, count, ..] = buf else {
        return Socks::Need;
    };
    if ver != SOCKS_VERSION {
        return refuse(Vec::new(), "not a SOCKS5 client");
    }
    let end = 2 + count as usize;
    let Some(methods) = buf.get(2..end) else {
        return Socks::Need;
    };
    if methods.contains(&METHOD_NO_AUTH) {
        Socks::Done((), end)
    } else {
        refuse(
            vec![SOCKS_VERSION, METHOD_NONE_ACCEPTABLE],
            "SOCKS client requires authentication",
        )
    }
}

/// The request: `CONNECT` to an IPv4, IPv6 or domain address. BIND and UDP
/// ASSOCIATE would have the server accept connections or datagrams on the
/// client's behalf, which `direct-tcpip` can't do.
pub fn socks_request(buf: &[u8]) -> Socks<(String, u16)> {
    let &[ver, cmd, _reserved, atyp, ref rest @ ..] = buf else {
        return Socks::Need;
    };
    if ver != SOCKS_VERSION {
        return refuse(Vec::new(), "not a SOCKS5 request");
    }
    if cmd != CMD_CONNECT {
        return refuse(
            socks_reply(REP_COMMAND_NOT_SUPPORTED).to_vec(),
            "SOCKS command not supported (only CONNECT)",
        );
    }
    let (host, addr_len) = match atyp {
        ATYP_IPV4 => match rest.get(..4) {
            Some(b) => (Ipv4Addr::new(b[0], b[1], b[2], b[3]).to_string(), 4),
            None => return Socks::Need,
        },
        ATYP_IPV6 => match rest.get(..16).and_then(|b| <[u8; 16]>::try_from(b).ok()) {
            Some(b) => (Ipv6Addr::from(b).to_string(), 16),
            None => return Socks::Need,
        },
        ATYP_DOMAIN => {
            let Some(&len) = rest.first() else {
                return Socks::Need;
            };
            let Some(name) = rest.get(1..1 + len as usize) else {
                return Socks::Need;
            };
            match std::str::from_utf8(name) {
                Ok(name)
                    if !name.is_empty()
                        && !name.chars().any(|c| c.is_whitespace() || c.is_control()) =>
                {
                    (name.to_string(), 1 + len as usize)
                }
                _ => {
                    return refuse(
                        socks_reply(REP_GENERAL_FAILURE).to_vec(),
                        "SOCKS client sent an invalid domain name",
                    )
                }
            }
        }
        _ => {
            return refuse(
                socks_reply(REP_ADDRESS_NOT_SUPPORTED).to_vec(),
                "SOCKS address type not supported",
            )
        }
    };
    let Some(p) = rest.get(addr_len..addr_len + 2) else {
        return Socks::Need;
    };
    Socks::Done((host, u16::from_be_bytes([p[0], p[1]])), 4 + addr_len + 2)
}

/// A reply with an all-zero IPv4 bound address: ARC doesn't know which address
/// the server connected from, and clients don't use it for CONNECT.
pub fn socks_reply(rep: u8) -> [u8; 10] {
    [SOCKS_VERSION, rep, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]
}

/// Run the handshake up to the request. Returns the destination and any bytes
/// the client sent past the request. The success reply waits until the channel
/// is open, so a destination the server can't reach is reported as such.
async fn socks_accept(sock: &mut TcpStream) -> Result<(String, u16, Vec<u8>)> {
    tokio::time::timeout(SOCKS_HANDSHAKE_TIMEOUT, async {
        let mut buf = Vec::new();
        let ((), n) = socks_read(sock, &mut buf, socks_greeting).await?;
        buf.drain(..n);
        sock.write_all(&[SOCKS_VERSION, METHOD_NO_AUTH]).await?;
        let ((host, port), n) = socks_read(sock, &mut buf, socks_request).await?;
        buf.drain(..n);
        Ok((host, port, buf))
    })
    .await
    .map_err(|_| anyhow!("SOCKS handshake timed out"))?
}

async fn socks_read<T>(
    sock: &mut TcpStream,
    buf: &mut Vec<u8>,
    parse: fn(&[u8]) -> Socks<T>,
) -> Result<(T, usize)> {
    loop {
        match parse(buf) {
            Socks::Done(v, n) => return Ok((v, n)),
            Socks::Refuse { reply, why } => {
                let _ = sock.write_all(&reply).await;
                return Err(anyhow!(why));
            }
            Socks::Need => {
                // Every message is decided within 262 bytes, so this only
                // trips on a parser bug — but it must never grow unbounded.
                if buf.len() > 1024 {
                    return Err(anyhow!("SOCKS message too long"));
                }
                let mut chunk = [0u8; 512];
                let n = sock.read(&mut chunk).await?;
                if n == 0 {
                    return Err(anyhow!("SOCKS client closed during the handshake"));
                }
                buf.extend_from_slice(&chunk[..n]);
            }
        }
    }
}

/// Validate a host's jump setting before it is saved.
///
/// One level of ProxyJump only: the jump host must connect directly, and a
/// host other hosts already jump through can't take a jump of its own (that
/// would make them two levels deep). Those two rules also rule out every
/// cycle, but the self and two-host cases get their own message because
/// "cycle" is what the user actually did.
///
/// * `host_id` — the host being saved; `None` for a new one.
/// * `jump_of_jump` — the chosen jump host's own `jump_host_id`.
/// * `jumped_through` — whether any other host names `host_id` as its jump.
pub fn check_jump(
    host_id: Option<&str>,
    jump_id: &str,
    jump_of_jump: Option<&str>,
    jumped_through: bool,
) -> Result<()> {
    if host_id == Some(jump_id) {
        return Err(anyhow!("a host can't be its own jump host"));
    }
    if let Some(next) = jump_of_jump {
        if host_id == Some(next) {
            return Err(anyhow!("jump hosts would form a cycle"));
        }
        return Err(anyhow!(
            "the jump host uses a jump host itself; only one level is supported"
        ));
    }
    if jumped_through {
        return Err(anyhow!(
            "other hosts jump through this one, so it can't use a jump host itself"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(bind: u16, host: &str, dest: u16) -> ForwardSpec {
        ForwardSpec {
            kind: ForwardKind::Local,
            bind_port: bind,
            dest_host: host.into(),
            dest_port: dest,
        }
    }

    #[test]
    fn forward_spec_validation() {
        assert!(spec(8080, "localhost", 80).validate().is_ok());
        assert!(spec(0, "localhost", 80).validate().is_err());
        assert!(spec(8080, "localhost", 0).validate().is_err());
        assert!(spec(8080, "  ", 80).validate().is_err());
        assert!(spec(8080, "db host", 5432).validate().is_err());
    }

    #[test]
    fn dynamic_forward_needs_only_a_listen_port() {
        // Saved as `{kind, bind_port}`: the destination fields default.
        let d: ForwardSpec =
            serde_json::from_str(r#"{"kind":"dynamic","bind_port":1080}"#).unwrap();
        assert_eq!(d.kind, ForwardKind::Dynamic);
        assert!(d.validate().is_ok());
        let zero = ForwardSpec { bind_port: 0, ..d };
        assert!(zero.validate().is_err());
    }

    #[test]
    fn socks_greeting_needs_no_auth() {
        assert_eq!(socks_greeting(&[5]), Socks::Need);
        assert_eq!(socks_greeting(&[5, 2, 0]), Socks::Need);
        assert_eq!(socks_greeting(&[5, 2, 2, 0]), Socks::Done((), 4));
        // Username/password only -> "no acceptable methods".
        assert_eq!(
            socks_greeting(&[5, 1, 2]),
            Socks::Refuse {
                reply: vec![5, 0xFF],
                why: "SOCKS client requires authentication"
            }
        );
        // SOCKS4 is not spoken; close without a SOCKS5 reply.
        assert!(matches!(socks_greeting(&[4, 1]), Socks::Refuse { reply, .. } if reply.is_empty()));
    }

    #[test]
    fn socks_connect_domain() {
        let mut req = vec![5, 1, 0, 3, 11];
        req.extend_from_slice(b"example.com");
        req.extend_from_slice(&443u16.to_be_bytes());
        assert_eq!(socks_request(&req[..req.len() - 1]), Socks::Need);
        assert_eq!(
            socks_request(&req),
            Socks::Done(("example.com".to_string(), 443), req.len())
        );
        // Bytes past the request are the client's, not the parser's.
        req.extend_from_slice(b"GET /");
        assert_eq!(
            socks_request(&req),
            Socks::Done(("example.com".to_string(), 443), req.len() - 5)
        );
    }

    #[test]
    fn socks_connect_ipv4_and_ipv6() {
        let v4 = [5, 1, 0, 1, 10, 0, 0, 7, 0x1F, 0x90];
        assert_eq!(
            socks_request(&v4),
            Socks::Done(("10.0.0.7".to_string(), 8080), 10)
        );

        let mut v6 = vec![5, 1, 0, 4];
        v6.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        v6.extend_from_slice(&[0, 22]);
        assert_eq!(socks_request(&v6), Socks::Done(("::1".to_string(), 22), 22));
    }

    #[test]
    fn socks_refuses_bind_and_unknown_address_types() {
        let bind = [5, 2, 0, 1, 127, 0, 0, 1, 0, 80];
        match socks_request(&bind) {
            Socks::Refuse { reply, .. } => {
                assert_eq!(reply, socks_reply(REP_COMMAND_NOT_SUPPORTED));
                assert_eq!(reply[1], 0x07);
            }
            other => panic!("{other:?}"),
        }
        match socks_request(&[5, 1, 0, 9, 0, 0]) {
            Socks::Refuse { reply, .. } => assert_eq!(reply[1], 0x08),
            other => panic!("{other:?}"),
        }
        match socks_request(&[5, 1, 0, 3, 3, b'a', b' ', b'b', 0, 80]) {
            Socks::Refuse { reply, .. } => assert_eq!(reply[1], REP_GENERAL_FAILURE),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn jump_rules() {
        // New host through a direct host: fine.
        assert!(check_jump(None, "bastion", None, false).is_ok());
        assert!(check_jump(Some("app"), "bastion", None, false).is_ok());
        // Self.
        assert!(check_jump(Some("app"), "app", None, false).is_err());
        // Two-host cycle: app -> bastion while bastion -> app.
        let e = check_jump(Some("app"), "bastion", Some("app"), true).unwrap_err();
        assert!(e.to_string().contains("cycle"), "{e}");
        // Two levels.
        assert!(check_jump(Some("app"), "bastion", Some("edge"), false).is_err());
        // Something already jumps through this host.
        assert!(check_jump(Some("bastion"), "edge", None, true).is_err());
    }
}
