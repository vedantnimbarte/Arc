//! Minimal Debug Adapter Protocol client.
//!
//! [`DapManager`] spawns debug adapters the user already has installed
//! (debugpy, lldb-dap, dlv, …) and drives them over the same Content-Length
//! framing `arc-lsp` uses — DAP just swaps JSON-RPC for its own
//! `seq`/`request_seq` envelope. Most adapters speak it on stdio; `dlv dap`
//! only listens on TCP, so [`Transport::Tcp`] spawns the adapter on a free port
//! and connects to it instead.
//!
//! [`DapManager::start`] owns the one ordering DAP is strict about:
//! `initialize` → `launch`/`attach` → wait for the `initialized` event →
//! `setBreakpoints` per file → `configurationDone`. Everything after that
//! (stepping, stack, variables, evaluate) is a plain request, so it goes
//! through [`DapManager::request`] rather than a method per command.
//!
//! Like `arc-lsp`, the crate is Tauri-agnostic: adapter events are sent down
//! the channel passed to [`DapManager::new`] and the desktop layer re-emits
//! them.

use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader,
};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

/// Errors cross the boundary as `String`, same as `arc-lsp`.
pub type DapResult<T> = Result<T, String>;

/// An adapter→client event, tagged with the session it came from. Besides the
/// adapter's own events, two are synthesised here: `output` for lines the
/// adapter process prints outside the protocol (stderr), and `adapterExited`
/// when its connection closes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DapEvent {
    pub session_id: String,
    pub event: String,
    pub body: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    Stdio,
    /// The adapter listens on a port: `${port}` in its args is replaced with a
    /// free local port, and ARC connects there once it's up.
    Tcp,
}

/// Breakpoints for one source file, as DAP `SourceBreakpoint`s (`line`, plus
/// optional `condition` / `hitCondition` / `logMessage`). Options the adapter
/// doesn't advertise support for are dropped before they're sent.
#[derive(Debug, Clone, Deserialize)]
pub struct SourceBreakpoints {
    pub path: String,
    pub breakpoints: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub transport: Transport,
    /// `"launch"` or `"attach"`.
    pub request: String,
    /// The launch.json configuration, passed through as the request arguments.
    pub config: Value,
    pub breakpoints: Vec<SourceBreakpoints>,
}

type Writer = Box<dyn AsyncWrite + Send + Unpin>;
type Reader = Box<dyn AsyncRead + Send + Unpin>;

/// One running adapter.
struct Session {
    child: Mutex<Child>,
    /// Shared with the reader task so it can answer reverse requests.
    writer: Arc<Mutex<Writer>>,
    /// Request `seq` → oneshot for the matching response.
    pending: Arc<DashMap<i64, oneshot::Sender<Value>>>,
    seq: Arc<AtomicI64>,
    /// Protocol reader plus the stderr/stdout forwarders.
    tasks: Vec<JoinHandle<()>>,
}

impl Session {
    /// Issue a request and await its response `body` (or surface its error).
    async fn request(&self, command: &str, arguments: Value) -> DapResult<Value> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);
        let msg =
            json!({ "seq": seq, "type": "request", "command": command, "arguments": arguments });
        let (tx, rx) = oneshot::channel();
        self.pending.insert(seq, tx);
        if let Err(e) = write_framed(&mut *self.writer.lock().await, &msg).await {
            self.pending.remove(&seq);
            return Err(e);
        }
        let resp = rx
            .await
            .map_err(|_| "debug adapter exited before responding".to_string())?;
        if resp.get("success").and_then(Value::as_bool) != Some(true) {
            // `message` is often a short code; the readable reason, when there
            // is one, lives in `body.error.format`.
            let reason = resp
                .pointer("/body/error/format")
                .or_else(|| resp.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("request failed");
            return Err(format!("{command}: {reason}"));
        }
        Ok(resp.get("body").cloned().unwrap_or(Value::Null))
    }
}

/// Manages running debug sessions, keyed by a caller-chosen id.
pub struct DapManager {
    sessions: DashMap<String, Arc<Session>>,
    events: mpsc::UnboundedSender<DapEvent>,
}

impl DapManager {
    pub fn new(events: mpsc::UnboundedSender<DapEvent>) -> Self {
        Self {
            sessions: DashMap::new(),
            events,
        }
    }

    /// Spawn the adapter, run the configuration handshake (sending
    /// `params.breakpoints` in the window DAP reserves for it), and return
    /// `{ capabilities, breakpoints: [{ path, breakpoints }] }` — the latter
    /// being the adapter's verdict on each line. Events (including an early
    /// `stopped`) start flowing before this returns, so subscribe first.
    pub async fn start(&self, id: &str, params: StartParams) -> DapResult<Value> {
        if self.sessions.contains_key(id) {
            let _ = self.stop(id).await;
        }
        let (session, init_rx) = self.spawn(id, &params).await?;
        // Registered before the handshake so a Stop pressed mid-start works.
        self.sessions.insert(id.to_string(), Arc::clone(&session));
        match handshake(&session, init_rx, &params).await {
            Ok(v) => Ok(v),
            Err(e) => {
                let _ = self.stop(id).await;
                Err(e)
            }
        }
    }

    async fn spawn(
        &self,
        id: &str,
        p: &StartParams,
    ) -> DapResult<(Arc<Session>, oneshot::Receiver<()>)> {
        let port = match p.transport {
            Transport::Stdio => None,
            Transport::Tcp => Some(free_port()?),
        };
        let args: Vec<String> = match port {
            Some(port) => p
                .args
                .iter()
                .map(|a| a.replace("${port}", &port.to_string()))
                .collect(),
            None => p.args.clone(),
        };

        let mut cmd = Command::new(&p.command);
        cmd.args(&args)
            .stdin(if port.is_some() {
                Stdio::null()
            } else {
                Stdio::piped()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = p.cwd.as_deref().filter(|c| !c.is_empty()) {
            cmd.current_dir(cwd);
        }
        // Same reason as the language servers: no console window per adapter.
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("`{}` was not found on PATH", p.command)
            } else {
                format!("spawn `{}`: {e}", p.command)
            }
        })?;
        if let Some(pid) = child.id() {
            arc_pty::assign_to_job(pid);
        }

        let mut tasks = Vec::new();
        if let Some(stderr) = child.stderr.take() {
            tasks.push(forward_output(stderr, self.events.clone(), id.to_string()));
        }
        let (reader, writer): (Reader, Writer) = match port {
            None => {
                let stdout = child.stdout.take().ok_or("debug adapter has no stdout")?;
                let stdin = child.stdin.take().ok_or("debug adapter has no stdin")?;
                (Box::new(stdout), Box::new(stdin))
            }
            Some(port) => {
                // On TCP, stdout is just the adapter's own chatter.
                if let Some(stdout) = child.stdout.take() {
                    tasks.push(forward_output(stdout, self.events.clone(), id.to_string()));
                }
                let (r, w) = connect_tcp(&mut child, port).await?.into_split();
                (Box::new(r), Box::new(w))
            }
        };

        let writer = Arc::new(Mutex::new(writer));
        let pending: Arc<DashMap<i64, oneshot::Sender<Value>>> = Arc::new(DashMap::new());
        let seq = Arc::new(AtomicI64::new(1));
        let (init_tx, init_rx) = oneshot::channel();
        tasks.push(spawn_reader(
            reader,
            Arc::clone(&pending),
            Arc::clone(&writer),
            Arc::clone(&seq),
            self.events.clone(),
            id.to_string(),
            init_tx,
        ));

        let session = Arc::new(Session {
            child: Mutex::new(child),
            writer,
            pending,
            seq,
            tasks,
        });
        Ok((session, init_rx))
    }

    /// Send any DAP request (`continue`, `next`, `stackTrace`, `variables`,
    /// `evaluate`, `setBreakpoints`, …) and return its response body.
    pub async fn request(&self, id: &str, command: &str, arguments: Value) -> DapResult<Value> {
        let session = self
            .sessions
            .get(id)
            .map(|s| Arc::clone(&s))
            .ok_or_else(|| format!("no debug session `{id}`"))?;
        session.request(command, arguments).await
    }

    /// End a session: a best-effort `disconnect` (terminating the debuggee),
    /// then kill the adapter. The disconnect is time-boxed — a wedged adapter
    /// must not make Stop hang.
    pub async fn stop(&self, id: &str) -> DapResult<()> {
        let Some((_, session)) = self.sessions.remove(id) else {
            return Ok(());
        };
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            session.request("disconnect", json!({ "terminateDebuggee": true })),
        )
        .await;
        for task in &session.tasks {
            task.abort();
        }
        let _ = session.child.lock().await.kill().await;
        Ok(())
    }

    /// Kill every adapter on app shutdown. No disconnect handshake — see
    /// `LspManager::stop_all` for why.
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        for id in &ids {
            if let Some((_, session)) = self.sessions.remove(id) {
                for task in &session.tasks {
                    task.abort();
                }
                let _ = session.child.lock().await.start_kill();
            }
        }
        if !ids.is_empty() {
            tracing::info!(count = ids.len(), "killed all debug adapters on shutdown");
        }
    }
}

/// See the spawn site in [`DapManager::spawn`].
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

async fn handshake(
    s: &Arc<Session>,
    mut init_rx: oneshot::Receiver<()>,
    p: &StartParams,
) -> DapResult<Value> {
    let adapter_id = p
        .config
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("arc");
    let caps = s.request("initialize", initialize_args(adapter_id)).await?;

    // debugpy only sends `initialized` after it has seen `launch`, and only
    // answers `launch` after `configurationDone` — so the launch request runs
    // in the background while we wait for `initialized`.
    let mut launch = tokio::spawn({
        let s = Arc::clone(s);
        let (request, config) = (p.request.clone(), p.config.clone());
        async move { s.request(&request, config).await }
    });
    let closed = |_| "debug adapter exited before `initialized`".to_string();
    let wait = async {
        let launched = tokio::select! {
            r = &mut launch => Some(r.map_err(|e| e.to_string())??),
            r = &mut init_rx => { r.map_err(closed)?; None }
        };
        if launched.is_some() {
            (&mut init_rx).await.map_err(closed)?;
        }
        Ok::<_, String>(launched)
    };
    let launched = tokio::time::timeout(Duration::from_secs(30), wait)
        .await
        .map_err(|_| "timed out waiting for the adapter's `initialized` event".to_string())??;

    let mut breakpoints = Vec::new();
    for bp in &p.breakpoints {
        // One file's breakpoints failing shouldn't sink the whole session.
        let body = s
            .request(
                "setBreakpoints",
                set_breakpoints_args(&bp.path, &bp.breakpoints, &caps),
            )
            .await
            .unwrap_or(Value::Null);
        breakpoints.push(json!({ "path": bp.path, "breakpoints": body.get("breakpoints") }));
    }
    if caps
        .get("supportsConfigurationDoneRequest")
        .and_then(Value::as_bool)
        == Some(true)
    {
        s.request("configurationDone", json!({})).await?;
    }
    if launched.is_none() {
        launch.await.map_err(|e| e.to_string())??;
    }
    Ok(json!({ "capabilities": caps, "breakpoints": breakpoints }))
}

fn initialize_args(adapter_id: &str) -> Value {
    json!({
        "clientID": "arc",
        "clientName": "ARC",
        "adapterID": adapter_id,
        "locale": "en-US",
        "pathFormat": "path",
        "linesStartAt1": true,
        "columnsStartAt1": true,
        "supportsVariableType": true,
        "supportsRunInTerminalRequest": false,
    })
}

/// `SourceBreakpoint` options and the capability that allows sending each.
/// The frontend gates its own mid-session `setBreakpoints` the same way
/// (`breakpointsPayload` in state/debug.ts); only here are the capabilities
/// not known to it yet.
const BREAKPOINT_OPTIONS: [(&str, &str); 3] = [
    ("condition", "supportsConditionalBreakpoints"),
    ("hitCondition", "supportsHitConditionalBreakpoints"),
    ("logMessage", "supportsLogPoints"),
];

fn set_breakpoints_args(path: &str, breakpoints: &[Value], caps: &Value) -> Value {
    let bps: Vec<Value> = breakpoints
        .iter()
        .cloned()
        .map(|mut bp| {
            if let Some(bp) = bp.as_object_mut() {
                for (option, cap) in BREAKPOINT_OPTIONS {
                    if caps.get(cap).and_then(Value::as_bool) != Some(true) {
                        bp.remove(option);
                    }
                }
            }
            bp
        })
        .collect();
    json!({ "source": { "path": path }, "breakpoints": bps })
}

/// ponytail: bind-then-drop leaves a tiny window for another process to take
/// the port before the adapter does. Parse the adapter's "listening at" line
/// instead if that ever actually happens.
fn free_port() -> DapResult<u16> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("pick a port: {e}"))
}

/// Poll until the adapter accepts a connection, giving up if it exits first.
async fn connect_tcp(child: &mut Child, port: u16) -> DapResult<TcpStream> {
    for _ in 0..100 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("debug adapter exited ({status}) before listening"));
        }
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)).await {
            return Ok(stream);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(format!("debug adapter never listened on port {port}"))
}

/// Relay an adapter's non-protocol output as `output` events so a crash
/// (e.g. `No module named debugpy`) is visible in the debug console.
fn forward_output(
    pipe: impl AsyncRead + Send + Unpin + 'static,
    events: mpsc::UnboundedSender<DapEvent>,
    session_id: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(pipe).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = events.send(DapEvent {
                session_id: session_id.clone(),
                event: "output".into(),
                body: json!({ "category": "stderr", "output": format!("{line}\n") }),
            });
        }
    })
}

/// Demux loop: responses resolve pending requests, events are forwarded (and
/// `initialized` also fires the handshake's oneshot), and reverse requests
/// are refused.
fn spawn_reader(
    reader: Reader,
    pending: Arc<DashMap<i64, oneshot::Sender<Value>>>,
    writer: Arc<Mutex<Writer>>,
    seq: Arc<AtomicI64>,
    events: mpsc::UnboundedSender<DapEvent>,
    session_id: String,
    init_tx: oneshot::Sender<()>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(reader);
        let mut init_tx = Some(init_tx);
        loop {
            let frame = match read_frame(&mut reader).await {
                Ok(f) => f,
                Err(e) => {
                    tracing::debug!(error = %e, session = %session_id, "dap reader exiting");
                    break;
                }
            };
            let v: Value = match serde_json::from_slice(&frame) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "decoding dap frame");
                    continue;
                }
            };
            match v.get("type").and_then(Value::as_str) {
                Some("response") => {
                    if let Some(rs) = v.get("request_seq").and_then(Value::as_i64) {
                        if let Some((_, tx)) = pending.remove(&rs) {
                            let _ = tx.send(v);
                        }
                    }
                }
                Some("event") => {
                    let event = v
                        .get("event")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if event == "initialized" {
                        if let Some(tx) = init_tx.take() {
                            let _ = tx.send(());
                        }
                    }
                    let _ = events.send(DapEvent {
                        session_id: session_id.clone(),
                        event,
                        body: v.get("body").cloned().unwrap_or(Value::Null),
                    });
                }
                Some("request") => {
                    // `runInTerminal` / `startDebugging`. ARC implements
                    // neither; a failed response lets the adapter fall back or
                    // report it, instead of waiting forever.
                    let command = v.get("command").and_then(Value::as_str).unwrap_or("");
                    let reply = json!({
                        "seq": seq.fetch_add(1, Ordering::Relaxed),
                        "type": "response",
                        "request_seq": v.get("seq"),
                        "success": false,
                        "command": command,
                        "message": format!("`{command}` is not supported by ARC"),
                    });
                    let _ = write_framed(&mut *writer.lock().await, &reply).await;
                }
                _ => {}
            }
        }
        // Wake in-flight callers so they observe the closed transport.
        pending.clear();
        let _ = events.send(DapEvent {
            session_id,
            event: "adapterExited".into(),
            body: Value::Null,
        });
    })
}

async fn write_framed<W: AsyncWrite + Unpin>(w: &mut W, msg: &Value) -> DapResult<()> {
    let body = serde_json::to_vec(msg).map_err(|e| format!("encode: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    w.write_all(header.as_bytes())
        .await
        .map_err(|e| format!("write: {e}"))?;
    w.write_all(&body)
        .await
        .map_err(|e| format!("write: {e}"))?;
    w.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Read one Content-Length-framed message.
async fn read_frame<R: AsyncBufRead + Unpin>(r: &mut R) -> DapResult<Vec<u8>> {
    let mut content_len: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = r
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err("debug adapter closed its connection".into());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_len = rest.trim().parse().ok();
        }
    }
    let len = content_len.ok_or("missing Content-Length header")?;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)
        .await
        .map_err(|e| format!("body: {e}"))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_concatenated_frames() {
        let data: &[u8] = b"Content-Length: 2\r\n\r\n{}Content-Length: 7\r\n\r\n{\"a\":1}";
        let mut r = BufReader::new(data);
        assert_eq!(read_frame(&mut r).await.unwrap(), b"{}");
        assert_eq!(read_frame(&mut r).await.unwrap(), b"{\"a\":1}");
        assert!(read_frame(&mut r).await.is_err());
    }

    #[tokio::test]
    async fn reads_frames_split_across_reads() {
        // Header and body both straddle chunk boundaries, and a tiny buffer
        // forces many partial reads on top of that.
        let a: &[u8] = b"Content-Len";
        let b: &[u8] = b"gth: 7\r\n\r\n{\"a\"";
        let c: &[u8] = b":1}Content-Length: 2\r\n";
        let d: &[u8] = b"\r\n[]";
        let mut r = BufReader::with_capacity(3, a.chain(b).chain(c).chain(d));
        assert_eq!(read_frame(&mut r).await.unwrap(), b"{\"a\":1}");
        assert_eq!(read_frame(&mut r).await.unwrap(), b"[]");
    }

    #[tokio::test]
    async fn write_then_read_roundtrips() {
        let mut out = Vec::new();
        write_framed(&mut out, &json!({ "seq": 1 })).await.unwrap();
        let mut r = BufReader::new(&out[..]);
        let frame = read_frame(&mut r).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&frame).unwrap(),
            json!({ "seq": 1 })
        );
    }

    #[test]
    fn breakpoint_options_need_capabilities() {
        let bps = [
            json!({ "line": 3, "condition": "i == 2", "hitCondition": "2", "logMessage": "i={i}" }),
        ];
        let args = set_breakpoints_args(
            "a.py",
            &bps,
            &json!({ "supportsConditionalBreakpoints": true, "supportsLogPoints": false }),
        );
        assert_eq!(
            args,
            json!({ "source": { "path": "a.py" }, "breakpoints": [{ "line": 3, "condition": "i == 2" }] })
        );
    }

    /// Real run against debugpy: `ARC_DAP_PYTHON=<python with debugpy>
    /// cargo test -p arc-dap -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn smoke_debugpy() {
        let python = std::env::var("ARC_DAP_PYTHON").unwrap_or_else(|_| "python".into());
        let dir = std::env::temp_dir().join("arc-dap-smoke");
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("hello.py");
        std::fs::write(
            &script,
            "x = 1\ny = x + 1\nfor i in range(5):\n    z = i * 2\nprint(y, z)\n",
        )
        .unwrap();
        let script = script.to_string_lossy().to_string();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let mgr = DapManager::new(tx);
        let started = mgr
            .start(
                "smoke",
                StartParams {
                    command: python,
                    args: vec!["-m".into(), "debugpy.adapter".into()],
                    cwd: None,
                    transport: Transport::Stdio,
                    request: "launch".into(),
                    config: json!({
                        "type": "python", "request": "launch", "program": script,
                        "console": "internalConsole", "justMyCode": true,
                    }),
                    breakpoints: vec![SourceBreakpoints {
                        path: script.clone(),
                        breakpoints: vec![
                            json!({ "line": 2 }),
                            json!({ "line": 4, "condition": "i == 3" }),
                        ],
                    }],
                },
            )
            .await
            .expect("start");
        println!("start: {started}");

        async fn next_stop(rx: &mut mpsc::UnboundedReceiver<DapEvent>) -> Value {
            tokio::time::timeout(Duration::from_secs(30), async {
                while let Some(ev) = rx.recv().await {
                    if ev.event == "stopped" {
                        return ev.body;
                    }
                }
                panic!("event channel closed");
            })
            .await
            .expect("stopped event")
        }
        let stopped = next_stop(&mut rx).await;
        let thread_id = stopped["threadId"].as_i64().expect("threadId");
        let stack = mgr
            .request("smoke", "stackTrace", json!({ "threadId": thread_id }))
            .await
            .expect("stackTrace");
        println!("stack: {stack}");
        assert_eq!(stack["stackFrames"][0]["line"], 2);

        // The conditional breakpoint on line 4 only fires once `i == 3`.
        mgr.request("smoke", "continue", json!({ "threadId": thread_id }))
            .await
            .expect("continue");
        next_stop(&mut rx).await;
        let stack = mgr
            .request("smoke", "stackTrace", json!({ "threadId": thread_id }))
            .await
            .expect("stackTrace");
        let frame = &stack["stackFrames"][0];
        assert_eq!(frame["line"], 4);
        let i = mgr
            .request(
                "smoke",
                "evaluate",
                json!({ "expression": "i", "frameId": frame["id"], "context": "watch" }),
            )
            .await
            .expect("evaluate");
        assert_eq!(i["result"], "3");
        mgr.stop("smoke").await.unwrap();
    }
}
