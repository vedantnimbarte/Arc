//! Tauri command surface for stdio-transport MCP clients.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("mcp_connect", { id, command, args })   -> ()
//!   invoke("mcp_list_tools", { id })               -> Vec<McpTool>
//!   invoke("mcp_call_tool", { id, name, args })    -> String
//!   invoke("mcp_disconnect", { id })               -> ()
//!
//! V0 scope:
//!   * stdio transport only.
//!   * Standard JSON-RPC 2.0 + Content-Length framing (LSP-style).
//!   * One in-flight request per server at a time (handshake mutex).
//!   * No notifications-back from server (we ignore them — V1 surfaces
//!     log/progress/resource-update events).
//!
//! Wiring to the agent runtime is also V1; for V0 the MCP layer is a
//! standalone capability the user exercises via `/mcp` chat commands.

use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

#[derive(Default, Clone)]
pub struct McpState {
    servers: Arc<DashMap<String, Arc<McpServer>>>,
}

struct McpServer {
    // Held for liveness; explicit kill on disconnect.
    child: Mutex<Child>,
    // Stdin + stdout share one mutex — only one request in flight at a time.
    io: Mutex<McpIo>,
    next_id: Mutex<i64>,
}

struct McpIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
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

#[tauri::command]
pub async fn mcp_connect(
    state: State<'_, McpState>,
    id: String,
    command: String,
    args: Vec<String>,
) -> Result<(), String> {
    if state.servers.contains_key(&id) {
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

    let server = Arc::new(McpServer {
        child: Mutex::new(child),
        io: Mutex::new(McpIo {
            stdin,
            stdout: BufReader::new(stdout),
        }),
        next_id: Mutex::new(1),
    });

    // Initialize handshake.
    let init = json!({
        "jsonrpc": "2.0",
        "id": next_id(&server).await,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "arc-terminal", "version": "0.0.1" }
        }
    });
    request(&server, init).await.map_err(err)?;

    // `initialized` notification (no id, no response expected).
    let init_notif = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    });
    notify(&server, init_notif).await.map_err(err)?;

    state.servers.insert(id, server);
    Ok(())
}

#[tauri::command]
pub async fn mcp_list_tools(state: State<'_, McpState>, id: String) -> Result<Vec<McpTool>, String> {
    let server = state
        .servers
        .get(&id)
        .map(|r| r.clone())
        .ok_or_else(|| format!("server `{id}` not connected"))?;
    let req = json!({
        "jsonrpc": "2.0",
        "id": next_id(&server).await,
        "method": "tools/list",
        "params": {}
    });
    let resp = request(&server, req).await.map_err(err)?;
    let tools = resp
        .get("result")
        .and_then(|r| r.get("tools"))
        .cloned()
        .unwrap_or(json!([]));
    serde_json::from_value::<Vec<McpTool>>(tools).map_err(|e| format!("bad tools[] shape: {e}"))
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, McpState>,
    id: String,
    name: String,
    args: Value,
) -> Result<String, String> {
    let server = state
        .servers
        .get(&id)
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
    let resp = request(&server, req).await.map_err(err)?;
    // MCP tools return `{ content: [{ type: "text", text: "..." }, ...] }`.
    // Concatenate the text blocks; for V0 we ignore other block types.
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
        // Tools that emit only structured/binary blocks: fall back to a
        // pretty-print of the whole result so the user sees something.
        if let Some(result) = resp.get("result") {
            return Ok(serde_json::to_string_pretty(result).unwrap_or_default());
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn mcp_disconnect(state: State<'_, McpState>, id: String) -> Result<(), String> {
    if let Some((_, server)) = state.servers.remove(&id) {
        let mut child = server.child.lock().await;
        let _ = child.kill().await;
    }
    Ok(())
}

// ─── JSON-RPC framing helpers ────────────────────────────────────────────

async fn next_id(server: &McpServer) -> i64 {
    let mut g = server.next_id.lock().await;
    let id = *g;
    *g += 1;
    id
}

/// Send a request and wait for the matching response. The frame format
/// follows the MCP spec, which uses LSP-style framing:
///   `Content-Length: <bytes>\r\n\r\n<json>`
async fn request(server: &McpServer, msg: Value) -> Result<Value, String> {
    let id = msg.get("id").cloned();
    let mut io = server.io.lock().await;

    let body = serde_json::to_vec(&msg).map_err(|e| format!("encode: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    io.stdin.write_all(header.as_bytes()).await.map_err(|e| format!("stdin: {e}"))?;
    io.stdin.write_all(&body).await.map_err(|e| format!("stdin: {e}"))?;
    io.stdin.flush().await.map_err(|e| format!("flush: {e}"))?;

    // Read responses until we see the one for our id, ignoring server-side
    // notifications along the way.
    loop {
        let frame = read_frame(&mut io.stdout).await?;
        let resp: Value = serde_json::from_slice(&frame).map_err(|e| format!("decode: {e}"))?;
        if resp.get("id") == id.as_ref() {
            if let Some(e) = resp.get("error") {
                return Err(format!("mcp error: {e}"));
            }
            return Ok(resp);
        }
        // Notification or unrelated response — drop and keep reading.
    }
}

/// Fire-and-forget notification (no id, no response).
async fn notify(server: &McpServer, msg: Value) -> Result<(), String> {
    let mut io = server.io.lock().await;
    let body = serde_json::to_vec(&msg).map_err(|e| format!("encode: {e}"))?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    io.stdin.write_all(header.as_bytes()).await.map_err(|e| format!("stdin: {e}"))?;
    io.stdin.write_all(&body).await.map_err(|e| format!("stdin: {e}"))?;
    io.stdin.flush().await.map_err(|e| format!("flush: {e}"))?;
    Ok(())
}

/// Read one Content-Length-framed message from the server.
async fn read_frame(stdout: &mut BufReader<ChildStdout>) -> Result<Vec<u8>, String> {
    // Headers (just Content-Length for MCP; consume until blank line).
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
        // Other headers (Content-Type) are ignored.
    }
    let len = content_len.ok_or("missing Content-Length header")?;
    let mut buf = vec![0u8; len];
    stdout
        .read_exact(&mut buf)
        .await
        .map_err(|e| format!("body: {e}"))?;
    Ok(buf)
}
