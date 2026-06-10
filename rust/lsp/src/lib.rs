//! Minimal Language Server Protocol client.
//!
//! [`LspManager`] spawns language-server processes and drives them over
//! Content-Length framed JSON-RPC on stdio — the same framing the MCP stdio
//! transport uses. It performs the `initialize` / `initialized` handshake,
//! relays `textDocument/did{Open,Change,Close}` notifications, and exposes
//! request helpers for `hover`, `completion`, and `definition`. Server→client
//! notifications (notably `textDocument/publishDiagnostics`) are forwarded to
//! the host through the channel passed to [`LspManager::new`].
//!
//! The crate is intentionally Tauri-agnostic: it knows nothing about events or
//! windows. The desktop command layer owns the channel and re-emits each
//! [`LspEvent`] on a Tauri topic.

use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

/// Errors cross the boundary as `String` — the desktop command layer maps to
/// the same shape, and the language-server failure modes (spawn failed, server
/// crashed, malformed response) don't carry structured data worth modeling.
pub type LspResult<T> = Result<T, String>;

/// A server→client notification, tagged with the session it came from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LspEvent {
    pub session_id: String,
    pub method: String,
    pub params: Value,
}

/// One running language server.
struct Session {
    child: Mutex<Child>,
    /// Shared with the reader task so it can reply to server→client requests.
    stdin: Arc<Mutex<ChildStdin>>,
    /// Request id → oneshot for the matching response.
    pending: Arc<DashMap<i64, oneshot::Sender<Value>>>,
    next_id: AtomicI64,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl Session {
    async fn send_frame(&self, msg: &Value) -> LspResult<()> {
        let mut stdin = self.stdin.lock().await;
        write_framed(&mut stdin, msg).await
    }

    /// Issue a request and await its response `result` (or surface its error).
    async fn request(&self, method: &str, params: Value) -> LspResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id, tx);
        if let Err(e) = self.send_frame(&msg).await {
            self.pending.remove(&id);
            return Err(e);
        }
        let resp = rx
            .await
            .map_err(|_| "lsp server closed before response".to_string())?;
        if let Some(e) = resp.get("error") {
            return Err(format!("lsp error: {e}"));
        }
        Ok(resp.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn notify(&self, method: &str, params: Value) -> LspResult<()> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        self.send_frame(&msg).await
    }
}

/// Manages the set of running language servers, keyed by a caller-chosen
/// session id (ARC uses the CodeMirror language id, e.g. `"typescript"`).
pub struct LspManager {
    sessions: DashMap<String, Arc<Session>>,
    events: mpsc::UnboundedSender<LspEvent>,
}

impl LspManager {
    pub fn new(events: mpsc::UnboundedSender<LspEvent>) -> Self {
        Self {
            sessions: DashMap::new(),
            events,
        }
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.sessions.contains_key(id)
    }

    /// Spawn `command args…`, run the initialize handshake rooted at
    /// `root_uri`, and register the session under `id`. Returns the server's
    /// advertised capabilities. Restarts the server if one is already running
    /// under the same id.
    pub async fn start(
        &self,
        id: &str,
        command: &str,
        args: &[String],
        root_uri: Option<&str>,
    ) -> LspResult<Value> {
        if self.sessions.contains_key(id) {
            let _ = self.stop(id).await;
        }

        let mut child = Command::new(command)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn `{command}`: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "language server has no stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "language server has no stdout".to_string())?;

        let stdin = Arc::new(Mutex::new(stdin));
        let pending: Arc<DashMap<i64, oneshot::Sender<Value>>> = Arc::new(DashMap::new());
        let reader = spawn_reader(
            stdout,
            Arc::clone(&pending),
            Arc::clone(&stdin),
            self.events.clone(),
            id.to_string(),
        );

        let session = Arc::new(Session {
            child: Mutex::new(child),
            stdin,
            pending,
            next_id: AtomicI64::new(1),
            reader: Mutex::new(Some(reader)),
        });

        let init = session
            .request("initialize", initialize_params(root_uri))
            .await?;
        session.notify("initialized", json!({})).await?;

        let caps = init.get("capabilities").cloned().unwrap_or(json!({}));
        self.sessions.insert(id.to_string(), session);
        Ok(caps)
    }

    fn session(&self, id: &str) -> LspResult<Arc<Session>> {
        self.sessions
            .get(id)
            .map(|s| Arc::clone(&s))
            .ok_or_else(|| format!("no lsp session `{id}`"))
    }

    pub async fn did_open(
        &self,
        id: &str,
        uri: &str,
        language_id: &str,
        version: i64,
        text: &str,
    ) -> LspResult<()> {
        self.session(id)?
            .notify(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": language_id,
                        "version": version,
                        "text": text,
                    }
                }),
            )
            .await
    }

    /// Full-text document sync. We send the whole buffer on every change — it's
    /// simpler than incremental sync and correct for any server.
    pub async fn did_change(
        &self,
        id: &str,
        uri: &str,
        version: i64,
        text: &str,
    ) -> LspResult<()> {
        self.session(id)?
            .notify(
                "textDocument/didChange",
                json!({
                    "textDocument": { "uri": uri, "version": version },
                    "contentChanges": [ { "text": text } ],
                }),
            )
            .await
    }

    pub async fn did_close(&self, id: &str, uri: &str) -> LspResult<()> {
        self.session(id)?
            .notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": uri } }),
            )
            .await
    }

    pub async fn hover(&self, id: &str, uri: &str, line: u32, character: u32) -> LspResult<Value> {
        self.session(id)?
            .request("textDocument/hover", position_params(uri, line, character))
            .await
    }

    pub async fn completion(
        &self,
        id: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> LspResult<Value> {
        self.session(id)?
            .request(
                "textDocument/completion",
                position_params(uri, line, character),
            )
            .await
    }

    pub async fn definition(
        &self,
        id: &str,
        uri: &str,
        line: u32,
        character: u32,
    ) -> LspResult<Value> {
        self.session(id)?
            .request(
                "textDocument/definition",
                position_params(uri, line, character),
            )
            .await
    }

    /// Shut a server down: best-effort `shutdown` request + `exit` notification,
    /// abort the reader, then kill the process.
    pub async fn stop(&self, id: &str) -> LspResult<()> {
        let Some((_, session)) = self.sessions.remove(id) else {
            return Ok(());
        };
        let _ = session.request("shutdown", Value::Null).await;
        let _ = session.notify("exit", Value::Null).await;
        if let Some(handle) = session.reader.lock().await.take() {
            handle.abort();
        }
        let mut child = session.child.lock().await;
        let _ = child.kill().await;
        Ok(())
    }
}

/// Demux loop: responses resolve pending requests, server→client requests get
/// a null reply (so servers that expect one don't stall), and notifications
/// are forwarded to the host.
fn spawn_reader(
    stdout: ChildStdout,
    pending: Arc<DashMap<i64, oneshot::Sender<Value>>>,
    stdin: Arc<Mutex<ChildStdin>>,
    events: mpsc::UnboundedSender<LspEvent>,
    session_id: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let frame = match read_frame(&mut reader).await {
                Ok(f) => f,
                Err(e) => {
                    tracing::debug!(error = %e, session = %session_id, "lsp reader exiting");
                    break;
                }
            };
            let v: Value = match serde_json::from_slice(&frame) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(error = %e, "decoding lsp frame");
                    continue;
                }
            };

            let is_request_or_notification = v.get("method").is_some();
            if is_request_or_notification {
                if let Some(req_id) = v.get("id").cloned() {
                    // Server→client request. We don't implement any of these
                    // (configuration, registerCapability, …); replying with a
                    // null result keeps the server moving rather than hanging.
                    let reply = json!({ "jsonrpc": "2.0", "id": req_id, "result": Value::Null });
                    let mut stdin = stdin.lock().await;
                    let _ = write_framed(&mut stdin, &reply).await;
                } else {
                    let method = v
                        .get("method")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    let params = v.get("params").cloned().unwrap_or(Value::Null);
                    let _ = events.send(LspEvent {
                        session_id: session_id.clone(),
                        method,
                        params,
                    });
                }
                continue;
            }

            // Otherwise it's a response to one of our requests.
            if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
                if let Some((_, tx)) = pending.remove(&id) {
                    let _ = tx.send(v);
                }
            }
        }
        // Wake any in-flight callers so they observe the closed transport.
        pending.clear();
    })
}

fn initialize_params(root_uri: Option<&str>) -> Value {
    json!({
        "processId": Value::Null,
        "clientInfo": { "name": "ARC", "version": "0.0.1" },
        "rootUri": root_uri,
        "capabilities": {
            "textDocument": {
                "synchronization": { "dynamicRegistration": false, "didSave": false },
                "hover": { "contentFormat": ["markdown", "plaintext"] },
                "completion": {
                    "completionItem": { "snippetSupport": false },
                    "contextSupport": true
                },
                "definition": { "dynamicRegistration": false },
                "publishDiagnostics": { "relatedInformation": false }
            },
            "workspace": { "configuration": false, "workspaceFolders": false }
        }
    })
}

fn position_params(uri: &str, line: u32, character: u32) -> Value {
    json!({
        "textDocument": { "uri": uri },
        "position": { "line": line, "character": character },
    })
}

async fn write_framed(stdin: &mut ChildStdin, msg: &Value) -> LspResult<()> {
    let body = serde_json::to_vec(msg).map_err(|e| format!("encode: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin
        .write_all(header.as_bytes())
        .await
        .map_err(|e| format!("stdin: {e}"))?;
    stdin
        .write_all(&body)
        .await
        .map_err(|e| format!("stdin: {e}"))?;
    stdin.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Read one Content-Length-framed message from the server's stdout.
async fn read_frame(stdout: &mut BufReader<ChildStdout>) -> LspResult<Vec<u8>> {
    let mut content_len: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = stdout
            .read_line(&mut line)
            .await
            .map_err(|e| format!("stdout: {e}"))?;
        if n == 0 {
            return Err("language server closed stdout".into());
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
    stdout
        .read_exact(&mut buf)
        .await
        .map_err(|e| format!("body: {e}"))?;
    Ok(buf)
}
