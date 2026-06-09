//! Tauri command surface for MCP clients.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("mcp_connect",      { id, command, args })         -> ()      // stdio
//!   invoke("mcp_connect_http", { id, url, headers? })          -> ()      // http / sse
//!   invoke("mcp_list_tools",   { id })                         -> Vec<McpTool>
//!   invoke("mcp_call_tool",    { id, name, args })             -> String
//!   invoke("mcp_disconnect",   { id })                         -> ()
//!
//! Transports:
//!   * **stdio** — JSON-RPC 2.0 with LSP-style `Content-Length` framing
//!     over a child process's stdin/stdout. A background reader task owns
//!     stdout and demuxes responses (by `id`) from server-initiated
//!     notifications (no `id`).
//!   * **http** — POST request + (optional) `text/event-stream` response,
//!     per the MCP 2025-03-26 "Streamable HTTP" transport. Servers that
//!     reply with `application/json` are also supported (we use the
//!     response's `Content-Type` to decide).
//!
//! Both transports speak the same `Transport` trait. Notifications
//! observed on either transport are emitted as Tauri events on
//! `mcp://notification/<server_id>` with payload
//! `{ server_id, method, params }`. The frontend subscribes via
//! `onMcpNotification(id, ...)` (see `apps/frontend/src/lib/tauri.ts`).

use std::sync::Arc;

use async_trait::async_trait;
use dashmap::DashMap;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

#[derive(Default, Clone)]
pub struct McpState {
    servers: Arc<DashMap<String, Arc<McpServer>>>,
}

struct McpServer {
    transport: Arc<dyn Transport>,
    next_id: Mutex<i64>,
}

/// Forwards server-initiated JSON-RPC notifications as Tauri events. Each
/// connected server gets its own `Notifier` keyed by the server id the
/// caller passed to `mcp_connect` / `mcp_connect_http`.
#[derive(Clone)]
struct Notifier {
    app: AppHandle,
    server_id: String,
}

impl Notifier {
    fn topic(&self) -> String {
        format!("mcp://notification/{}", self.server_id)
    }

    /// Emit a `notifications/*` JSON-RPC message to the frontend. Silently
    /// drops messages without a `method` field — the JSON-RPC spec marks
    /// notifications as a message with `method` but no `id`.
    fn dispatch(&self, msg: &Value) {
        let method = match msg.get("method").and_then(|m| m.as_str()) {
            Some(m) => m,
            None => return,
        };
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let payload = json!({
            "server_id": &self.server_id,
            "method": method,
            "params": params,
        });
        if let Err(e) = self.app.emit(&self.topic(), payload) {
            tracing::warn!(server_id = %self.server_id, error = %e, "emit mcp notification");
        }
    }
}

#[async_trait]
trait Transport: Send + Sync {
    async fn request(&self, msg: Value) -> Result<Value, String>;
    async fn notify(&self, msg: Value) -> Result<(), String>;
    async fn shutdown(&self) -> Result<(), String>;

    /// Best-effort, synchronous force-kill for the app shutdown handler,
    /// which runs outside an async context (so it can't `.await shutdown()`).
    /// No-op for transports with no child process (HTTP).
    fn kill_now(&self) {}
}

// ─── Stdio transport ─────────────────────────────────────────────────────

struct StdioTransport {
    // Held for liveness; explicit kill on disconnect.
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    /// Request id → oneshot for the matching response. The background
    /// reader task pops entries here as responses arrive.
    pending: Arc<DashMap<i64, oneshot::Sender<Value>>>,
    reader: Mutex<Option<JoinHandle<()>>>,
}

impl StdioTransport {
    fn spawn(
        child: Child,
        stdin: ChildStdin,
        stdout: ChildStdout,
        notifier: Notifier,
    ) -> Arc<Self> {
        let pending: Arc<DashMap<i64, oneshot::Sender<Value>>> = Arc::new(DashMap::new());
        let pending_for_task = Arc::clone(&pending);
        let handle = tokio::spawn(async move {
            let mut stdout = BufReader::new(stdout);
            loop {
                let frame = match read_frame(&mut stdout).await {
                    Ok(f) => f,
                    Err(e) => {
                        tracing::debug!(error = %e, "mcp stdio reader exiting");
                        break;
                    }
                };
                let v: Value = match serde_json::from_slice(&frame) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(error = %e, "decoding mcp frame");
                        continue;
                    }
                };
                if let Some(id) = v.get("id").and_then(|x| x.as_i64()) {
                    if let Some((_, tx)) = pending_for_task.remove(&id) {
                        let _ = tx.send(v);
                        continue;
                    }
                    // Response to a request we no longer care about (e.g.
                    // the caller dropped). Fall through — nothing to do.
                    continue;
                }
                // No `id` → notification. Forward to the UI.
                notifier.dispatch(&v);
            }
            // Wake any in-flight callers so they see the closed transport
            // instead of waiting forever.
            pending_for_task.clear();
        });
        Arc::new(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            pending,
            reader: Mutex::new(Some(handle)),
        })
    }

    async fn send_frame(&self, msg: &Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().await;
        write_framed(&mut *stdin, msg).await
    }
}

#[async_trait]
impl Transport for StdioTransport {
    async fn request(&self, msg: Value) -> Result<Value, String> {
        let id = msg
            .get("id")
            .and_then(|x| x.as_i64())
            .ok_or("request missing numeric id")?;
        let (tx, rx) = oneshot::channel();
        self.pending.insert(id, tx);

        if let Err(e) = self.send_frame(&msg).await {
            self.pending.remove(&id);
            return Err(e);
        }

        let resp = rx
            .await
            .map_err(|_| "mcp transport closed before response".to_string())?;
        if let Some(e) = resp.get("error") {
            return Err(format!("mcp error: {e}"));
        }
        Ok(resp)
    }

    async fn notify(&self, msg: Value) -> Result<(), String> {
        self.send_frame(&msg).await
    }

    async fn shutdown(&self) -> Result<(), String> {
        if let Some(handle) = self.reader.lock().await.take() {
            handle.abort();
        }
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        Ok(())
    }

    fn kill_now(&self) {
        // try_lock rather than block: at shutdown there's no contention, and
        // start_kill only signals the OS (no await needed) — enough to reap
        // the child since Tauri's process::exit skips kill_on_drop.
        if let Ok(mut child) = self.child.try_lock() {
            let _ = child.start_kill();
        }
    }
}

async fn write_framed(stdin: &mut ChildStdin, msg: &Value) -> Result<(), String> {
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

/// Read one Content-Length-framed message from the server.
async fn read_frame(stdout: &mut BufReader<ChildStdout>) -> Result<Vec<u8>, String> {
    let mut content_len: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = stdout
            .read_line(&mut line)
            .await
            .map_err(|e| format!("stdout: {e}"))?;
        if n == 0 {
            return Err("mcp server closed stdout".into());
        }
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
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

// ─── HTTP transport (Streamable HTTP, 2025-03-26 spec) ────────────────────

struct HttpTransport {
    client: reqwest::Client,
    url: String,
    headers: HashMap<String, String>,
    /// MCP optionally maintains a session via the `Mcp-Session-Id` header.
    /// If the server returns one on initialize, we replay it.
    session_id: Mutex<Option<String>>,
    notifier: Notifier,
}

impl HttpTransport {
    fn new(url: String, headers: HashMap<String, String>, notifier: Notifier) -> Self {
        Self {
            client: reqwest::Client::builder()
                .user_agent("arc-terminal/0.0.1")
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            url,
            headers,
            session_id: Mutex::new(None),
            notifier,
        }
    }

    async fn build_request(&self, body: Vec<u8>) -> reqwest::RequestBuilder {
        let mut b = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream");
        for (k, v) in &self.headers {
            b = b.header(k, v);
        }
        if let Some(sid) = self.session_id.lock().await.as_ref() {
            b = b.header("Mcp-Session-Id", sid);
        }
        b.body(body)
    }
}

#[async_trait]
impl Transport for HttpTransport {
    async fn request(&self, msg: Value) -> Result<Value, String> {
        let target_id = msg.get("id").cloned();
        let body = serde_json::to_vec(&msg).map_err(|e| format!("encode: {e}"))?;
        let resp = self
            .build_request(body)
            .await
            .send()
            .await
            .map_err(|e| format!("http: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let txt = resp.text().await.unwrap_or_default();
            return Err(format!("http {status}: {txt}"));
        }
        // Persist the session id if the server assigns one.
        if let Some(sid) = resp
            .headers()
            .get("Mcp-Session-Id")
            .or_else(|| resp.headers().get("mcp-session-id"))
        {
            if let Ok(s) = sid.to_str() {
                *self.session_id.lock().await = Some(s.to_string());
            }
        }
        let ctype = resp
            .headers()
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("")
            .to_lowercase();

        if ctype.starts_with("text/event-stream") {
            // SSE: events arrive as `data: <json>\n\n`. Iterate until we
            // see the one with matching id; messages without an id (or
            // with a different id) are forwarded as notifications.
            let mut stream = resp.bytes_stream().eventsource();
            while let Some(ev) = stream.next().await {
                let event = ev.map_err(|e| format!("sse: {e}"))?;
                if event.data.is_empty() {
                    continue;
                }
                let v: Value = match serde_json::from_str(&event.data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if v.get("id") == target_id.as_ref() {
                    if let Some(e) = v.get("error") {
                        return Err(format!("mcp error: {e}"));
                    }
                    return Ok(v);
                }
                // Anything else on the stream that looks like a
                // notification (no id, or different id + a method) goes
                // out as one. Stray responses to unknown ids are dropped.
                if v.get("id").is_none() && v.get("method").is_some() {
                    self.notifier.dispatch(&v);
                }
            }
            return Err("sse closed before response arrived".into());
        }

        // application/json (or unspecified) → take the body as the response.
        let v: Value = resp
            .json()
            .await
            .map_err(|e| format!("decode json: {e}"))?;
        if let Some(e) = v.get("error") {
            return Err(format!("mcp error: {e}"));
        }
        // Reject a body whose id doesn't match our request rather than handing
        // an out-of-order / batched reply back as this call's result (it would
        // surface downstream as a confusing "bad shape" error or silently
        // wrong tool output).
        if v.get("id") != target_id.as_ref() {
            return Err(format!(
                "mcp protocol error: response id {:?} does not match request id {:?}",
                v.get("id"),
                target_id
            ));
        }
        Ok(v)
    }

    async fn notify(&self, msg: Value) -> Result<(), String> {
        let body = serde_json::to_vec(&msg).map_err(|e| format!("encode: {e}"))?;
        let resp = self
            .build_request(body)
            .await
            .send()
            .await
            .map_err(|e| format!("http: {e}"))?;
        // Notifications: drain the body (might be an empty SSE) but
        // don't expect a response. 4xx/5xx are still worth surfacing.
        if !resp.status().is_success() {
            let status = resp.status();
            let txt = resp.text().await.unwrap_or_default();
            return Err(format!("http {status}: {txt}"));
        }
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), String> {
        // Best-effort DELETE to the session URL if one was established.
        if let Some(sid) = self.session_id.lock().await.clone() {
            let _ = self
                .client
                .delete(&self.url)
                .header("Mcp-Session-Id", sid)
                .send()
                .await;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "inputSchema", default)]
    pub input_schema: Value,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

impl McpState {
    /// IDs of currently-connected servers. Used by the agent runtime to
    /// enumerate which tool sets to expose to the model.
    pub fn server_ids(&self) -> Vec<String> {
        self.servers.iter().map(|kv| kv.key().clone()).collect()
    }

    /// Force-kill every connected stdio child. Called from the app exit
    /// handler: Tauri exits via process::exit, which skips Drop, so the
    /// transports' kill_on_drop never fires and the child MCP server
    /// processes would otherwise be orphaned across runs.
    pub fn kill_all(&self) {
        for server in self.servers.iter() {
            server.value().transport.kill_now();
        }
    }

    pub async fn connect(
        &self,
        app: AppHandle,
        id: String,
        command: String,
        args: Vec<String>,
    ) -> Result<(), String> {
        if self.servers.contains_key(&id) {
            return Err(format!("server `{id}` already connected"));
        }

        let mut child = Command::new(&command)
            .args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("spawn `{command}`: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin pipe")?;
        let stdout = child.stdout.take().ok_or("no stdout pipe")?;

        let notifier = Notifier {
            app,
            server_id: id.clone(),
        };
        let transport: Arc<dyn Transport> = StdioTransport::spawn(child, stdin, stdout, notifier);
        let server = Arc::new(McpServer {
            transport,
            next_id: Mutex::new(1),
        });
        Self::handshake(&server).await?;
        self.servers.insert(id, server);
        Ok(())
    }

    pub async fn connect_http(
        &self,
        app: AppHandle,
        id: String,
        url: String,
        headers: Option<HashMap<String, String>>,
    ) -> Result<(), String> {
        if self.servers.contains_key(&id) {
            return Err(format!("server `{id}` already connected"));
        }
        let notifier = Notifier {
            app,
            server_id: id.clone(),
        };
        let transport: Arc<dyn Transport> = Arc::new(HttpTransport::new(
            url,
            headers.unwrap_or_default(),
            notifier,
        ));
        let server = Arc::new(McpServer {
            transport,
            next_id: Mutex::new(1),
        });
        Self::handshake(&server).await?;
        self.servers.insert(id, server);
        Ok(())
    }

    async fn handshake(server: &Arc<McpServer>) -> Result<(), String> {
        let init = json!({
            "jsonrpc": "2.0",
            "id": next_id(server).await,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "arc-terminal", "version": "0.0.1" }
            }
        });
        server.transport.request(init).await.map_err(err)?;

        let init_notif = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        server.transport.notify(init_notif).await.map_err(err)?;
        Ok(())
    }

    pub async fn list_tools(&self, id: &str) -> Result<Vec<McpTool>, String> {
        let server = self
            .servers
            .get(id)
            .map(|r| r.clone())
            .ok_or_else(|| format!("server `{id}` not connected"))?;
        let req = json!({
            "jsonrpc": "2.0",
            "id": next_id(&server).await,
            "method": "tools/list",
            "params": {}
        });
        let resp = server.transport.request(req).await.map_err(err)?;
        let tools = resp
            .get("result")
            .and_then(|r| r.get("tools"))
            .cloned()
            .unwrap_or(json!([]));
        serde_json::from_value::<Vec<McpTool>>(tools).map_err(|e| format!("bad tools[] shape: {e}"))
    }

    pub async fn call_tool(&self, id: &str, name: &str, args: Value) -> Result<String, String> {
        let server = self
            .servers
            .get(id)
            .map(|r| r.clone())
            .ok_or_else(|| format!("server `{id}` not connected"))?;
        let req = json!({
            "jsonrpc": "2.0",
            "id": next_id(&server).await,
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": args
            }
        });
        let resp = server.transport.request(req).await.map_err(err)?;
        let content = resp
            .get("result")
            .and_then(|r| r.get("content"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
        let mut out = String::new();
        for block in content {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                out.push_str(t);
            }
        }
        if out.is_empty() {
            if let Some(result) = resp.get("result") {
                return Ok(serde_json::to_string_pretty(result).unwrap_or_default());
            }
        }
        Ok(out)
    }

    pub async fn disconnect(&self, id: &str) -> Result<(), String> {
        if let Some((_, server)) = self.servers.remove(id) {
            let _ = server.transport.shutdown().await;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn mcp_connect(
    app: AppHandle,
    state: State<'_, McpState>,
    id: String,
    command: String,
    args: Vec<String>,
) -> Result<(), String> {
    state.connect(app, id, command, args).await
}

#[tauri::command]
pub async fn mcp_connect_http(
    app: AppHandle,
    state: State<'_, McpState>,
    id: String,
    url: String,
    headers: Option<HashMap<String, String>>,
) -> Result<(), String> {
    state.connect_http(app, id, url, headers).await
}

#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, McpState>, id: String) -> Result<Vec<McpTool>, String> {
    state.list_tools(&id).await
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, McpState>,
    id: String,
    name: String,
    args: Value,
) -> Result<String, String> {
    state.call_tool(&id, &name, args).await
}

#[tauri::command]
pub async fn mcp_disconnect(state: State<'_, McpState>, id: String) -> Result<(), String> {
    state.disconnect(&id).await
}

// ─── JSON-RPC framing helpers ────────────────────────────────────────────

async fn next_id(server: &McpServer) -> i64 {
    let mut g = server.next_id.lock().await;
    let id = *g;
    *g += 1;
    id
}
