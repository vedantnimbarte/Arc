//! The session host process.
//!
//! Owns PTYs through the same [`PtyManager`] ARC uses in-process, so shell
//! resolution, cwd fallback, env filtering and OSC 7 injection are identical.
//! Its shells are enrolled in *this* process's kill-on-close job, so they die
//! with the host rather than with ARC.
//!
//! One connection per ARC process; each session is attached to at most one
//! connection. A connection going away (ARC quit or crashed) only detaches —
//! the session keeps running and keeps recording output into its ring buffer.

use std::collections::HashMap;
use std::io;
use std::sync::Arc;
use std::time::{Duration, Instant};

use arc_pty::{PtyManager, SpawnOptions};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::ipc;
use crate::proto::{encode, read_frame, Event, Request, NOT_FOUND, PROTOCOL_VERSION};
use crate::ring::RingBuffer;

/// How long the host lingers with no sessions before exiting.
pub const IDLE_EXIT: Duration = Duration::from_secs(60);
const RING_CAP: usize = 256 * 1024;
const MAX_SESSIONS: usize = 256;
const OUT_CHANNEL_CAP: usize = 256;

struct Session {
    pty_id: String,
    /// Recording and forwarding happen under one lock, so an attach sees a
    /// replay and a live stream that neither overlap nor leave a gap.
    state: tokio::sync::Mutex<SessionState>,
}

struct SessionState {
    ring: RingBuffer,
    attached: Option<Attachment>,
}

struct Attachment {
    conn: u64,
    tx: mpsc::Sender<Vec<u8>>,
}

struct Host {
    ptys: PtyManager,
    sessions: parking_lot::Mutex<HashMap<String, Arc<Session>>>,
}

/// Entry point of the `arc-ptyhost` binary. `--endpoint <name>` overrides the
/// per-user default (tests use it to run a private host).
pub fn main() {
    let args: Vec<String> = std::env::args().collect();
    let endpoint = match args.iter().position(|a| a == "--endpoint") {
        Some(i) => args.get(i + 1).cloned().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "--endpoint needs a value")
        }),
        None => ipc::default_endpoint(),
    };
    let result = endpoint.and_then(|endpoint| {
        tokio::runtime::Runtime::new()?.block_on(serve(&endpoint, IDLE_EXIT))
    });
    if let Err(err) = result {
        eprintln!("arc-ptyhost: {err}");
        std::process::exit(1);
    }
}

/// Serve `endpoint` until idle for `idle_exit` or told to shut down. Both end
/// the process. Fails straight away if another host owns the endpoint.
pub async fn serve(endpoint: &str, idle_exit: Duration) -> io::Result<()> {
    let mut listener = ipc::Listener::bind(endpoint)?;
    let host = Arc::new(Host { ptys: PtyManager::new(), sessions: Default::default() });
    tokio::spawn(idle_watch(host.clone(), idle_exit));
    let mut next_conn = 0u64;
    loop {
        let stream = listener.accept().await?;
        next_conn += 1;
        tokio::spawn(handle_conn(host.clone(), next_conn, stream));
    }
}

/// Exit once there have been no sessions for `idle_exit`. The decision is made
/// holding the sessions lock, so a spawn can't slip in between check and exit.
async fn idle_watch(host: Arc<Host>, idle_exit: Duration) {
    let mut idle_since = Some(Instant::now());
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    loop {
        tick.tick().await;
        let sessions = host.sessions.lock();
        if !sessions.is_empty() {
            idle_since = None;
            continue;
        }
        let since = *idle_since.get_or_insert_with(Instant::now);
        if since.elapsed() >= idle_exit {
            tracing::info!("no sessions; arc-ptyhost exiting");
            std::process::exit(0);
        }
    }
}

async fn handle_conn<S>(host: Arc<Host>, conn: u64, stream: S)
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(OUT_CHANNEL_CAP);
    tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if wr.write_all(&frame).await.is_err() {
                break;
            }
        }
    });

    // Handshake. A peer of another protocol version may only ask us to shut
    // down — that is how a newer ARC retires an older host.
    let compatible = match read_frame::<_, Request>(&mut rd).await {
        Ok(Some((Request::Hello { version }, _))) => {
            send(&tx, &Event::Hello { version: PROTOCOL_VERSION }, &[]).await;
            version == PROTOCOL_VERSION
        }
        _ => return,
    };

    loop {
        let (req, payload) = match read_frame::<_, Request>(&mut rd).await {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(err) => {
                tracing::warn!(%err, "dropping connection after a bad frame");
                break;
            }
        };
        if !compatible && req != Request::Shutdown {
            break;
        }
        if let Err(why) = req.validate() {
            tracing::warn!(why, "rejected request");
            if let Some(seq) = req.seq() {
                reply(&tx, seq, Err(why.to_string())).await;
            }
            continue;
        }
        match req {
            Request::Hello { .. } => {}
            Request::Spawn { seq, id, shell, args, cwd, env, cols, rows } => {
                let opts = SpawnOptions {
                    shell,
                    cwd,
                    cols,
                    rows,
                    env: (!env.is_empty()).then_some(env),
                    args: (!args.is_empty()).then_some(args),
                };
                let result = host.spawn(id, opts, conn, &tx);
                reply(&tx, seq, result).await;
            }
            Request::Attach { seq, id, cols, rows } => {
                let result = host.attach(&id, cols, rows, conn, &tx).await;
                reply(&tx, seq, result).await;
            }
            Request::Detach { seq, id } => {
                if let Some(session) = host.get(&id) {
                    let mut st = session.state.lock().await;
                    if st.attached.as_ref().is_some_and(|a| a.conn == conn) {
                        st.attached = None;
                    }
                }
                reply(&tx, seq, Ok(())).await;
            }
            Request::Kill { seq, id } => {
                // Removed now so `list` and a respawn under the same id see it
                // gone; `pump` reports the exit and reaps the PTY.
                let removed = host.sessions.lock().remove(&id);
                if let Some(session) = removed {
                    let _ = tokio::task::block_in_place(|| host.ptys.kill(&session.pty_id));
                }
                reply(&tx, seq, Ok(())).await;
            }
            Request::List { seq } => {
                let mut ids: Vec<String> = host.sessions.lock().keys().cloned().collect();
                ids.sort();
                let ev = Event::Reply { seq, error: None, ids };
                send(&tx, &ev, &[]).await;
            }
            // Writes and resizes can block on a child that isn't draining its
            // input; `block_in_place` keeps them in order without stalling the
            // runtime's other connections.
            Request::Write { id } => {
                if let Some(session) = host.get(&id) {
                    let _ = tokio::task::block_in_place(|| host.ptys.write(&session.pty_id, &payload));
                }
            }
            Request::Resize { id, cols, rows } => {
                if let Some(session) = host.get(&id) {
                    let _ = tokio::task::block_in_place(|| {
                        host.ptys.resize(&session.pty_id, cols, rows)
                    });
                }
            }
            Request::Shutdown => {
                tracing::info!("shutdown requested; ending all sessions");
                host.ptys.kill_all();
                std::process::exit(0);
            }
        }
    }

    // ARC went away: detach, don't kill.
    let sessions: Vec<Arc<Session>> = host.sessions.lock().values().cloned().collect();
    for session in sessions {
        let mut st = session.state.lock().await;
        if st.attached.as_ref().is_some_and(|a| a.conn == conn) {
            st.attached = None;
        }
    }
}

impl Host {
    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(id).cloned()
    }

    fn spawn(
        self: &Arc<Self>,
        id: String,
        opts: SpawnOptions,
        conn: u64,
        tx: &mpsc::Sender<Vec<u8>>,
    ) -> Result<(), String> {
        let mut sessions = self.sessions.lock();
        if sessions.contains_key(&id) {
            return Err("session already exists".into());
        }
        if sessions.len() >= MAX_SESSIONS {
            return Err("too many sessions".into());
        }
        let result = self.ptys.spawn(opts).map_err(|e| format!("{e:#}"))?;
        let session = Arc::new(Session {
            pty_id: result.id,
            state: tokio::sync::Mutex::new(SessionState {
                ring: RingBuffer::new(RING_CAP),
                attached: Some(Attachment { conn, tx: tx.clone() }),
            }),
        });
        sessions.insert(id.clone(), session.clone());
        tokio::spawn(pump(self.clone(), id, session, result.data_rx, result.exit_rx));
        Ok(())
    }

    async fn attach(
        self: &Arc<Self>,
        id: &str,
        cols: u16,
        rows: u16,
        conn: u64,
        tx: &mpsc::Sender<Vec<u8>>,
    ) -> Result<(), String> {
        let session = self.get(id).ok_or_else(|| NOT_FOUND.to_string())?;
        {
            let mut st = session.state.lock().await;
            let replay = st.ring.replay();
            let frame = encode(&Event::Output { id: id.to_string() }, &replay)
                .map_err(|e| e.to_string())?;
            tx.send(frame).await.map_err(|_| "connection closed".to_string())?;
            st.attached = Some(Attachment { conn, tx: tx.clone() });
        }
        // The replay restores the recent stream, not necessarily the screen: a
        // full-screen TUI's last full paint may be long gone. Nudge the size
        // away and back so the program gets SIGWINCH (ConPTY: a buffer-size
        // event plus its own repaint) and redraws itself. The pause matters —
        // programs that compare against the previous size would otherwise see
        // no change and skip the redraw.
        let host = self.clone();
        let pty_id = session.pty_id.clone();
        tokio::spawn(async move {
            let (c, r) = if cols > 2 { (cols - 1, rows) } else { (cols, rows.saturating_add(1)) };
            let _ = tokio::task::spawn_blocking({
                let host = host.clone();
                let pty_id = pty_id.clone();
                move || host.ptys.resize(&pty_id, c, r)
            })
            .await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = tokio::task::spawn_blocking(move || host.ptys.resize(&pty_id, cols, rows)).await;
        });
        Ok(())
    }
}

/// Record a session's output and forward it to whoever is attached; on exit,
/// report the code and drop the session.
async fn pump(
    host: Arc<Host>,
    id: String,
    session: Arc<Session>,
    mut data_rx: mpsc::Receiver<Vec<u8>>,
    mut exit_rx: oneshot::Receiver<Option<i32>>,
) {
    let forward = |bytes: Vec<u8>| {
        let session = session.clone();
        let id = id.clone();
        async move {
            let mut st = session.state.lock().await;
            st.ring.push(&bytes);
            if let Some(a) = &st.attached {
                let Ok(frame) = encode(&Event::Output { id }, &bytes) else { return };
                if a.tx.send(frame).await.is_err() {
                    st.attached = None;
                }
            }
        }
    };

    // ConPTY's reader only reaches EOF once the pseudoconsole is closed, so
    // wait on the exit and the output together rather than output first.
    let code = loop {
        tokio::select! {
            Some(bytes) = data_rx.recv() => forward(bytes).await,
            code = &mut exit_rx => break code.unwrap_or(None),
        }
    };
    {
        let mut sessions = host.sessions.lock();
        if sessions.get(&id).is_some_and(|s| Arc::ptr_eq(s, &session)) {
            sessions.remove(&id);
        }
    }
    // Drops the master (ClosePseudoConsole on Windows) so the reader drains.
    let _ = host.ptys.kill(&session.pty_id);
    let _ = tokio::time::timeout(Duration::from_secs(1), async {
        while let Some(bytes) = data_rx.recv().await {
            forward(bytes).await;
        }
    })
    .await;
    let st = session.state.lock().await;
    if let Some(a) = &st.attached {
        send(&a.tx, &Event::Exit { id: id.clone(), code }, &[]).await;
    }
}

async fn send(tx: &mpsc::Sender<Vec<u8>>, ev: &Event, payload: &[u8]) {
    if let Ok(frame) = encode(ev, payload) {
        let _ = tx.send(frame).await;
    }
}

async fn reply(tx: &mpsc::Sender<Vec<u8>>, seq: u64, result: Result<(), String>) {
    send(tx, &Event::Reply { seq, error: result.err(), ids: Vec::new() }, &[]).await;
}
