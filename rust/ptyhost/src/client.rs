//! ARC's side of the session host: starts it on demand and multiplexes every
//! persistent terminal over one connection.
//!
//! [`HostClient::spawn`] and [`HostClient::attach`] hand back the same pair of
//! receivers an in-process [`arc_pty::SpawnResult`] carries, so the Tauri layer
//! drains both kinds of terminal with the same code.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use arc_pty::SpawnOptions;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, WriteHalf};
use tokio::sync::{mpsc, oneshot};

use crate::ipc;
use crate::proto::{encode, read_frame, Event, Request, MAX_WRITE_CHUNK, NOT_FOUND, PROTOCOL_VERSION};

const DATA_CHANNEL_CAP: usize = 256;

/// Output and exit of one attached session — the host-side twin of
/// [`arc_pty::SpawnResult`]'s receivers.
pub struct Attached {
    pub data_rx: mpsc::Receiver<Vec<u8>>,
    pub exit_rx: oneshot::Receiver<Option<i32>>,
}

pub struct HostClient {
    /// The bundled `arc-ptyhost` binary; `None` means never launch one.
    exe: Option<PathBuf>,
    /// `None` resolves the per-user default at connect time.
    endpoint: Option<String>,
    conn: tokio::sync::Mutex<Option<Arc<Conn>>>,
}

type Reply = (Option<String>, Vec<String>);

struct Sink {
    data: mpsc::Sender<Vec<u8>>,
    exit: oneshot::Sender<Option<i32>>,
}

struct Conn {
    tx: mpsc::Sender<Vec<u8>>,
    seq: AtomicU64,
    closed: AtomicBool,
    pending: parking_lot::Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    sinks: parking_lot::Mutex<HashMap<String, Sink>>,
}

impl HostClient {
    pub fn new(exe: Option<PathBuf>, endpoint: Option<String>) -> Self {
        Self { exe, endpoint, conn: tokio::sync::Mutex::new(None) }
    }

    fn endpoint(&self) -> io::Result<String> {
        match &self.endpoint {
            Some(e) => Ok(e.clone()),
            None => ipc::default_endpoint(),
        }
    }

    /// The live connection, connecting (and with `launch`, starting the host)
    /// as needed. `Ok(None)`: no host is running and `launch` was false.
    async fn conn(&self, launch: bool) -> Result<Option<Arc<Conn>>> {
        let mut slot = self.conn.lock().await;
        if let Some(conn) = slot.as_ref().filter(|c| !c.closed.load(Ordering::SeqCst)) {
            return Ok(Some(conn.clone()));
        }
        *slot = None;
        let endpoint = self.endpoint()?;
        let stream = match ipc::connect(&endpoint).await {
            Ok(stream) => stream,
            // Only "nobody listening" is a reason to start one. Anything else —
            // notably a pipe owned by another user — must not be papered over.
            Err(e) if is_absent(&e) => {
                if !launch {
                    return Ok(None);
                }
                let exe = self.exe.as_deref().context("persistent terminals are unavailable")?;
                start_host(exe, &endpoint)?;
                connect_with_retry(&endpoint).await?
            }
            Err(e) => return Err(e).context("connect to arc-ptyhost"),
        };
        let conn = Conn::open(stream).await?;
        *slot = Some(conn.clone());
        Ok(Some(conn))
    }

    /// Start a session under `id` and attach this connection to it.
    pub async fn spawn(&self, id: &str, opts: SpawnOptions) -> Result<Attached> {
        let mut retried = false;
        loop {
            let conn = self.conn(true).await?.context("arc-ptyhost did not start")?;
            let (attached, sink) = sink();
            conn.sinks.lock().insert(id.to_string(), sink);
            let result = conn
                .request(|seq| Request::Spawn {
                    seq,
                    id: id.to_string(),
                    shell: opts.shell.clone(),
                    args: opts.args.clone().unwrap_or_default(),
                    cwd: opts.cwd.clone(),
                    env: opts.env.clone().unwrap_or_default(),
                    cols: opts.cols,
                    rows: opts.rows,
                })
                .await;
            match result {
                Ok(_) => return Ok(attached),
                Err(err) => {
                    conn.sinks.lock().remove(id);
                    // The host can idle out between our connect and the spawn
                    // reaching it; one fresh start covers that.
                    if conn.closed.load(Ordering::SeqCst) && !retried {
                        retried = true;
                        continue;
                    }
                    return Err(err);
                }
            }
        }
    }

    /// Reattach to a running session. `Ok(None)` when there is no host or no
    /// such session — the caller starts a fresh shell instead. Never launches
    /// a host.
    pub async fn attach(&self, id: &str, cols: u16, rows: u16) -> Result<Option<Attached>> {
        let Some(conn) = self.conn(false).await? else { return Ok(None) };
        let (attached, sink) = sink();
        conn.sinks.lock().insert(id.to_string(), sink);
        let result =
            conn.request(|seq| Request::Attach { seq, id: id.to_string(), cols, rows }).await;
        match result {
            Ok(_) => Ok(Some(attached)),
            Err(err) => {
                conn.sinks.lock().remove(id);
                if err.to_string() == NOT_FOUND { Ok(None) } else { Err(err) }
            }
        }
    }

    /// Stop routing a session's output here; it keeps running.
    pub async fn detach(&self, id: &str) -> Result<()> {
        let Some(conn) = self.conn(false).await? else { return Ok(()) };
        conn.sinks.lock().remove(id);
        conn.request(|seq| Request::Detach { seq, id: id.to_string() }).await.map(drop)
    }

    pub async fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let conn = self.conn(false).await?.context("arc-ptyhost is not running")?;
        for chunk in data.chunks(MAX_WRITE_CHUNK) {
            conn.send(&Request::Write { id: id.to_string() }, chunk).await?;
        }
        Ok(())
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let conn = self.conn(false).await?.context("arc-ptyhost is not running")?;
        conn.send(&Request::Resize { id: id.to_string(), cols, rows }, &[]).await
    }

    pub async fn kill(&self, id: &str) -> Result<()> {
        let Some(conn) = self.conn(false).await? else { return Ok(()) };
        conn.request(|seq| Request::Kill { seq, id: id.to_string() }).await.map(drop)
    }

    /// Ids of the running sessions; empty when no host is running.
    pub async fn list(&self) -> Result<Vec<String>> {
        let Some(conn) = self.conn(false).await? else { return Ok(Vec::new()) };
        conn.request(|seq| Request::List { seq }).await
    }

    /// End every session and stop the host — whatever version it is, which is
    /// the way out of a protocol mismatch. No-op when none is running.
    pub async fn shutdown(&self) -> Result<()> {
        self.conn.lock().await.take();
        let stream = match ipc::connect(&self.endpoint()?).await {
            Ok(stream) => stream,
            Err(e) if is_absent(&e) => return Ok(()),
            Err(e) => return Err(e).context("connect to arc-ptyhost"),
        };
        let (mut rd, mut wr) = tokio::io::split(stream);
        wr.write_all(&encode(&Request::Hello { version: PROTOCOL_VERSION }, &[])?).await?;
        wr.write_all(&encode(&Request::Shutdown, &[])?).await?;
        // Wait for the host to hang up, so an immediate `list` doesn't find it.
        let _ = tokio::time::timeout(Duration::from_secs(5), async {
            while let Ok(Some(_)) = read_frame::<_, Event>(&mut rd).await {}
        })
        .await;
        Ok(())
    }
}

fn sink() -> (Attached, Sink) {
    let (data, data_rx) = mpsc::channel(DATA_CHANNEL_CAP);
    let (exit, exit_rx) = oneshot::channel();
    (Attached { data_rx, exit_rx }, Sink { data, exit })
}

fn is_absent(e: &io::Error) -> bool {
    matches!(e.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused)
}

async fn connect_with_retry(endpoint: &str) -> Result<ipc::Stream> {
    let mut last = None;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        match ipc::connect(endpoint).await {
            Ok(stream) => return Ok(stream),
            Err(e) if is_absent(&e) => last = Some(e),
            Err(e) => return Err(e).context("connect to arc-ptyhost"),
        }
    }
    Err(anyhow!("arc-ptyhost did not start listening: {last:?}"))
}

impl Conn {
    async fn open<S>(stream: S) -> Result<Arc<Conn>>
    where
        S: AsyncRead + AsyncWrite + Send + 'static,
    {
        let (mut rd, wr) = tokio::io::split(stream);
        let (tx, rx) = mpsc::channel::<Vec<u8>>(DATA_CHANNEL_CAP);
        tokio::spawn(write_loop(wr, rx));
        tx.send(encode(&Request::Hello { version: PROTOCOL_VERSION }, &[])?)
            .await
            .map_err(|_| anyhow!("arc-ptyhost connection closed"))?;
        let hello = tokio::time::timeout(Duration::from_secs(5), read_frame::<_, Event>(&mut rd))
            .await
            .context("arc-ptyhost handshake timed out")??;
        match hello {
            Some((Event::Hello { version }, _)) if version == PROTOCOL_VERSION => {}
            Some((Event::Hello { version }, _)) => bail!(
                "background terminals are held by a different ARC version (protocol {version}, \
                 this ARC speaks {PROTOCOL_VERSION}); end them in Settings → Terminal"
            ),
            _ => bail!("arc-ptyhost handshake failed"),
        }
        let conn = Arc::new(Conn {
            tx,
            seq: AtomicU64::new(1),
            closed: AtomicBool::new(false),
            pending: Default::default(),
            sinks: Default::default(),
        });
        tokio::spawn(read_loop(conn.clone(), rd));
        Ok(conn)
    }

    async fn send(&self, req: &Request, payload: &[u8]) -> Result<()> {
        self.tx
            .send(encode(req, payload)?)
            .await
            .map_err(|_| anyhow!("arc-ptyhost connection closed"))
    }

    async fn request(&self, build: impl FnOnce(u64) -> Request) -> Result<Vec<String>> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(seq, tx);
        // Closed before we registered: the reader already cleared `pending`.
        if self.closed.load(Ordering::SeqCst) {
            self.pending.lock().remove(&seq);
            bail!("arc-ptyhost connection closed");
        }
        self.send(&build(seq), &[]).await?;
        let (error, ids) = rx.await.map_err(|_| anyhow!("arc-ptyhost connection closed"))?;
        match error {
            Some(e) => Err(anyhow!(e)),
            None => Ok(ids),
        }
    }
}

async fn write_loop<S: AsyncWrite>(mut wr: WriteHalf<S>, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(frame) = rx.recv().await {
        if wr.write_all(&frame).await.is_err() {
            break;
        }
    }
}

async fn read_loop<R: AsyncRead + Unpin>(conn: Arc<Conn>, mut rd: R) {
    loop {
        let (ev, payload) = match read_frame::<_, Event>(&mut rd).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(%err, "bad frame from arc-ptyhost");
                break;
            }
        };
        match ev {
            Event::Output { id } => {
                let data = conn.sinks.lock().get(&id).map(|s| s.data.clone());
                if let Some(data) = data {
                    let _ = data.send(payload).await;
                }
            }
            Event::Exit { id, code } => {
                if let Some(sink) = conn.sinks.lock().remove(&id) {
                    let _ = sink.exit.send(code);
                }
            }
            Event::Reply { seq, error, ids } => {
                if let Some(tx) = conn.pending.lock().remove(&seq) {
                    let _ = tx.send((error, ids));
                }
            }
            Event::Hello { .. } => {}
        }
    }
    // Host gone: its shells went with it (they live in its kill-on-close job).
    conn.closed.store(true, Ordering::SeqCst);
    conn.pending.lock().clear();
    for (_, sink) in conn.sinks.lock().drain() {
        let _ = sink.exit.send(None);
    }
}

/// Launch `exe` fully detached from ARC: its own session / process group, no
/// console, outside any job ARC is in — so neither closing ARC nor ARC's
/// kill-on-close job (see `arc_pty::assign_to_job`, which the host is never
/// enrolled in) takes the shells down.
fn start_host(exe: &Path, endpoint: &str) -> Result<()> {
    let exe = stage(exe).unwrap_or_else(|err| {
        tracing::warn!(%err, "could not stage arc-ptyhost; running it in place");
        exe.to_path_buf()
    });
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("--endpoint")
        .arg(endpoint)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Some(dir) = exe.parent() {
        // Don't pin ARC's cwd (a project folder) for the host's lifetime.
        cmd.current_dir(dir);
    }

    #[cfg(windows)]
    let child = {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(child) => child,
            // Access denied when ARC itself runs inside a job that forbids
            // breakaway: ARC started from another ARC's terminal, or under
            // `cargo run` / `tauri dev`, whose job reaps children. The
            // host then lives only as long as that job — still better than
            // no persistent terminals.
            Err(err) => {
                tracing::warn!(%err, "breakaway from job refused; starting arc-ptyhost inside it");
                cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
                cmd.spawn().context("start arc-ptyhost")?
            }
        }
    };
    #[cfg(unix)]
    let child = {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        cmd.spawn().context("start arc-ptyhost")?
    };

    // Reap it when it eventually exits so it doesn't linger as a zombie.
    let mut child = child;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Run the host from a per-version copy in the user's local data dir rather
/// than from the install dir. A running executable is locked on Windows, and
/// the installer would fail to overwrite it during an update; on Linux an
/// AppImage's mount vanishes when ARC exits. macOS replaces the whole bundle
/// and doesn't lock, so it runs in place.
#[cfg(not(target_os = "macos"))]
fn stage(exe: &Path) -> io::Result<PathBuf> {
    let dir = dirs::data_local_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no local data dir"))?
        .join("arc")
        .join("ptyhost");
    std::fs::create_dir_all(&dir)?;
    let dest = dir.join(format!(
        "arc-ptyhost-{}{}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::EXE_SUFFIX
    ));
    let src = std::fs::read(exe)?;
    if std::fs::read(&dest).ok().as_deref() != Some(src.as_slice()) {
        let tmp = dest.with_extension("tmp");
        std::fs::copy(exe, &tmp)?;
        std::fs::rename(&tmp, &dest)?;
    }
    Ok(dest)
}

#[cfg(target_os = "macos")]
fn stage(exe: &Path) -> io::Result<PathBuf> {
    Ok(exe.to_path_buf())
}
