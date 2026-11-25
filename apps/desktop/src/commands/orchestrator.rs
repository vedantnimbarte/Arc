//! Arc's MCP server: lets a chat agent start and talk to other agents.
//!
//! Each agent conversation Arc runs (Claude Code, ACP agents) is handed this
//! server's URL — `http://127.0.0.1:<port>/mcp/<token>` — as an MCP server
//! named `arc`. The token is minted per conversation by the frontend and says
//! which conversation is calling, so the frontend can apply its approval and
//! caps per caller.
//!
//! This side only speaks MCP (streamable HTTP, plain JSON responses) and
//! forwards each `tools/call` to the frontend as an `orchestrator://call`
//! event; the frontend does the work — open a window, send a prompt, wait for
//! the reply — and answers with `orchestrator_reply`. Agents are Arc windows,
//! so everything a helper does stays visible and reviewable.
//!
//! Loopback only, and an unknown token is a 404, so other local processes
//! can't drive agents without a token Arc handed out.
//!
//! Frontend contract:
//!   invoke("orchestrator_url", { caller, token }) -> url
//!   invoke("orchestrator_reply", { id, ok, text }) -> ()
//!   listen("orchestrator://call") <- { id, caller, tool, args }

use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, OnceCell};

#[derive(Default)]
pub struct OrchestratorState {
    port: OnceCell<u16>,
    /// Token → the conversation it was minted for.
    callers: DashMap<String, String>,
    /// Tool calls the frontend hasn't answered yet.
    pending: DashMap<u64, oneshot::Sender<(bool, String)>>,
    next: AtomicU64,
}

/// The longest a tool call may run. `wait_for_agent` caps its own wait below
/// this, so only a frontend that never answers hits it.
const CALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_BODY: usize = 1 << 20;

/// The MCP endpoint for one conversation. Starts the server on first use.
#[tauri::command]
pub async fn orchestrator_url(
    app: AppHandle,
    state: State<'_, OrchestratorState>,
    caller: String,
    token: String,
) -> Result<String, String> {
    if token.len() < 16 {
        return Err("token too short".into());
    }
    let port = state
        .port
        .get_or_try_init(|| async {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| format!("orchestrator: can't listen: {e}"))?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            tauri::async_runtime::spawn(serve(listener, app.clone()));
            Ok::<u16, String>(port)
        })
        .await?;
    state.callers.insert(token.clone(), caller);
    Ok(format!("http://127.0.0.1:{port}/mcp/{token}"))
}

/// The frontend's answer to one `orchestrator://call`.
#[tauri::command]
pub async fn orchestrator_reply(
    state: State<'_, OrchestratorState>,
    id: u64,
    ok: bool,
    text: String,
) -> Result<(), String> {
    if let Some((_, tx)) = state.pending.remove(&id) {
        let _ = tx.send((ok, text));
    }
    Ok(())
}

async fn serve(listener: TcpListener, app: AppHandle) {
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            continue;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle(stream, app).await {
                tracing::debug!("orchestrator: connection ended: {e}");
            }
        });
    }
}

/// One HTTP/1.1 request, answered and closed. MCP clients send a
/// `Content-Length` JSON body, which is all this reads.
async fn handle(mut stream: TcpStream, app: AppHandle) -> std::io::Result<()> {
    let Some((method, path, body)) = read_request(&mut stream).await? else {
        return respond(&mut stream, 400, None).await;
    };
    let caller = path.strip_prefix("/mcp/").and_then(|token| {
        use tauri::Manager;
        app.state::<OrchestratorState>()
            .callers
            .get(token)
            .map(|c| c.clone())
    });
    let Some(caller) = caller else {
        return respond(&mut stream, 404, None).await;
    };
    // No server-initiated stream (GET) and no sessions to end (DELETE).
    if method != "POST" {
        return respond(&mut stream, 405, None).await;
    }
    let Ok(msg) = serde_json::from_slice::<Value>(&body) else {
        let err = json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "parse error" } });
        return respond(&mut stream, 400, Some(err)).await;
    };
    match rpc(&app, &caller, &msg).await {
        Some(reply) => respond(&mut stream, 200, Some(reply)).await,
        // A notification or response from the client: nothing to say back.
        None => respond(&mut stream, 202, None).await,
    }
}

async fn read_request(
    stream: &mut TcpStream,
) -> std::io::Result<Option<(String, String, Vec<u8>)>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            return Ok(None);
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 16 * 1024 {
            return Ok(None);
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let method = first.next().unwrap_or("").to_string();
    let path = first.next().unwrap_or("").to_string();
    let len = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    if len > MAX_BODY {
        return Ok(None);
    }
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(len);
    Ok(Some((method, path, body)))
}

async fn respond(stream: &mut TcpStream, status: u16, body: Option<Value>) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Method Not Allowed",
    };
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if !body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
    }
    if status == 405 {
        head.push_str("Allow: POST\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

/// Answer one JSON-RPC message, or `None` for a notification.
async fn rpc(app: &AppHandle, caller: &str, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let method = msg["method"].as_str().unwrap_or("");
    let result = match method {
        "initialize" => {
            // Speak whichever version the client asked for, if it's one we know.
            let asked = msg["params"]["protocolVersion"].as_str().unwrap_or("");
            let version = ["2025-06-18", "2025-03-26", "2024-11-05"]
                .into_iter()
                .find(|v| *v == asked)
                .unwrap_or("2025-03-26");
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "arc", "title": "ARC", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => Ok(call_tool(app, caller, &msg["params"]).await),
        _ => Err(json!({ "code": -32601, "message": format!("unknown method {method}") })),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err(e) => json!({ "jsonrpc": "2.0", "id": id, "error": e }),
    })
}

/// Hand a tool call to the frontend and wait for its answer.
async fn call_tool(app: &AppHandle, caller: &str, params: &Value) -> Value {
    use tauri::Manager;
    let state = app.state::<OrchestratorState>();
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    state.pending.insert(id, tx);
    let _ = app.emit(
        "orchestrator://call",
        json!({ "id": id, "caller": caller, "tool": params["name"], "args": params["arguments"] }),
    );
    let (ok, text) = match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(answer)) => answer,
        _ => {
            state.pending.remove(&id);
            (false, "Arc didn't answer in time.".to_string())
        }
    };
    json!({ "content": [{ "type": "text", "text": text }], "isError": !ok })
}

const INSTRUCTIONS: &str = "Arc runs coding agents in windows the user can see. \
Use these tools to hand work to another agent: start one with a prompt, wait for its reply, \
send it follow-ups, stop it. Helpers work in their own git worktree by default, so parallel \
helpers can't edit the same files; pass worktree=false for read-only work such as asking for \
a second opinion. Patterns: hand off (plan here, start an implementer with the plan), \
advisor (start a helper with worktree=false to critique an approach), committee (start two \
helpers with different agents on the same question, then compare). The user approves the \
first helper in each conversation.";

fn tools() -> Value {
    json!([
        {
            "name": "list_agents",
            "description": "The agents Arc can start, and the helpers this conversation has started with their status.",
            "inputSchema": { "type": "object", "properties": {} },
        },
        {
            "name": "start_agent",
            "description": "Start a helper agent in a new Arc window and send it a prompt. Returns its id at once; use wait_for_agent for the reply.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "agent": { "type": "string", "description": "Which agent, by id from list_agents (e.g. \"claude\", \"opencode-cli\")." },
                    "prompt": { "type": "string", "description": "The task. The helper doesn't see this conversation, so include what it needs." },
                    "title": { "type": "string", "description": "Short name for its window." },
                    "worktree": { "type": "boolean", "description": "Work in its own git worktree (default true in a git repo). False shares this folder: use for read-only work." }
                },
                "required": ["agent", "prompt"],
            },
        },
        {
            "name": "wait_for_agent",
            "description": "Wait for a helper's current turn to finish and return its reply and the files it edited. Returns early if it's waiting on the user.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "timeout_seconds": { "type": "number", "description": "How long to wait (default 120, max 600). 0 just reports status." }
                },
                "required": ["id"],
            },
        },
        {
            "name": "send_message",
            "description": "Send a follow-up to a helper whose turn has finished.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" }, "message": { "type": "string" } },
                "required": ["id", "message"],
            },
        },
        {
            "name": "stop_agent",
            "description": "Stop a helper's running turn. Its window stays open.",
            "inputSchema": {
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"],
            },
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A request split across writes still parses, and the body is exactly
    /// `Content-Length` bytes.
    #[tokio::test]
    async fn reads_a_post_and_answers_with_json() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let client = tokio::spawn(async move {
            let mut s = TcpStream::connect(addr).await.unwrap();
            let body = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
            let head = format!(
                "POST /mcp/tok HTTP/1.1\r\nHost: x\r\ncontent-length: {}\r\n\r\n",
                body.len()
            );
            s.write_all(head.as_bytes()).await.unwrap();
            s.write_all(&body.as_bytes()[..10]).await.unwrap();
            s.write_all(&body.as_bytes()[10..]).await.unwrap();
            let mut out = String::new();
            s.read_to_string(&mut out).await.unwrap();
            out
        });
        let (mut server, _) = listener.accept().await.unwrap();
        let (method, path, body) = read_request(&mut server).await.unwrap().unwrap();
        assert_eq!((method.as_str(), path.as_str()), ("POST", "/mcp/tok"));
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["method"],
            "ping"
        );
        respond(&mut server, 200, Some(json!({ "ok": true })))
            .await
            .unwrap();

        let out = client.await.unwrap();
        assert!(out.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(out.contains("Content-Type: application/json"));
        assert!(out.ends_with(r#"{"ok":true}"#));
    }

    #[test]
    fn every_tool_has_a_name_and_an_object_schema() {
        for t in tools().as_array().unwrap() {
            assert!(t["name"].is_string());
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }
}
