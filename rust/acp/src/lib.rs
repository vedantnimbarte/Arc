//! Client for coding agents that speak the [Agent Client Protocol] (ACP).
//!
//! ACP is JSON-RPC 2.0 over the agent's stdio, one message per line. Gemini
//! CLI, OpenCode, Qwen Code, Kimi, Copilot, Cursor Agent and Factory Droid all
//! ship it natively, so one client gives every one of them the same chat panel
//! Claude Code has — instead of a terminal tab with a TUI in it.
//!
//! Unlike Claude Code (one child per turn, history resumed by id), an ACP agent
//! is a long-lived process that holds the conversation in memory. So the unit
//! here is a *conversation*: [`run_session`] spawns the agent once, then takes
//! [`Command`]s — prompts, cancels, permission answers — until its command
//! channel closes, which kills the child.
//!
//! [`Translator`] converts `session/update` notifications into the event names
//! ARC's agent panels already render (`text_delta`, `tool_start`,
//! `tool_result`, …; see `rust/claude-code`), so the frontend reuses one
//! reducer for every agent.
//!
//! Wire notes, checked against a live `opencode acp` (1.18):
//!   * A tool call arrives as `tool_call` with an empty `rawInput`, and the
//!     real input lands on a later `tool_call_update`. Its `title` also changes
//!     as it runs (`bash` → `echo done`), so tool rows are upserted by id.
//!   * Edited files show up as `locations` on `kind: "edit"` calls, not always
//!     as `diff` content.
//!   * `usage_update.cost.amount` is the session's running total, not a delta.
//!
//! [Agent Client Protocol]: https://agentclientprotocol.com

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

/// One event handed to the frontend, in ARC's own vocabulary.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub kind: String,
    pub payload: Value,
}

impl Event {
    fn new(kind: &str, payload: Value) -> Self {
        Self {
            kind: kind.to_string(),
            payload,
        }
    }
}

/// Agents known to speak ACP, by the `discover_ai_clis` id of their binary,
/// with the arguments that put them in ACP mode. Taken from the ACP registry
/// (cdn.agentclientprotocol.com/registry). Adding an agent is one row here
/// plus a row in `discover_ai_clis` if its binary isn't probed yet.
///
/// Codex, Pi and Amp are absent on purpose: they speak ACP only through a
/// separate adapter package, not the binary `discover_ai_clis` finds.
const PROVIDERS: &[(&str, &[&str])] = &[
    ("opencode-cli", &["acp"]),
    ("gemini-cli", &["--acp"]),
    ("qwen-code-cli", &["--acp"]),
    ("kimi-code-cli", &["acp"]),
    ("copilot-cli", &["--acp"]),
    ("cursor-agent-cli", &["acp"]),
    ("droid-cli", &["exec", "--output-format", "acp-daemon"]),
];

/// An installed agent ARC can drive over ACP.
#[derive(Debug, Clone, Serialize)]
pub struct Provider {
    /// Same id as the AI CLI launcher's (`gemini-cli`, …).
    pub id: String,
    pub label: String,
    pub path: String,
    pub args: Vec<String>,
}

/// The ACP-capable agents on PATH. Reuses the launcher's probe so the two
/// agree on what "installed" means.
pub fn providers() -> Vec<Provider> {
    let found = arc_pty::discover_ai_clis();
    PROVIDERS
        .iter()
        .filter_map(|(id, args)| {
            found.iter().find(|c| c.id == *id).map(|c| Provider {
                id: c.id.clone(),
                label: c.label.clone(),
                path: c.path.clone(),
                args: args.iter().map(|a| a.to_string()).collect(),
            })
        })
        .collect()
}

/// What a conversation is told to do next.
#[derive(Debug)]
pub enum Command {
    /// One user turn, as Anthropic-style content blocks (what the panel's
    /// composer already builds); converted to ACP blocks on the way out.
    Prompt(Vec<Value>),
    /// Stop the running turn. The agent answers its pending prompt with
    /// `stopReason: "cancelled"`, which ends the turn normally.
    Cancel,
    Decide(Decision),
}

/// The user's answer to one `permission_request` event.
#[derive(Debug, Clone)]
pub struct Decision {
    pub request_id: String,
    pub allow: bool,
}

/// How to start the agent.
#[derive(Debug, Clone)]
pub struct SessionOptions {
    pub binary: String,
    pub args: Vec<String>,
    /// Absolute path; ACP requires it, and it scopes the agent's file access.
    pub cwd: String,
}

/// File-changing tool kinds, whose `locations` are the files they wrote.
const WRITE_KINDS: &[&str] = &["edit", "delete", "move"];

#[derive(Default)]
struct Tool {
    title: String,
    input: Value,
    paths: HashSet<String>,
    done: bool,
}

/// Folds ACP `session/update`s and prompt results into ARC events.
#[derive(Default)]
pub struct Translator {
    tools: HashMap<String, Tool>,
    /// Latest running total from `usage_update`, in USD.
    cost: Option<f64>,
    /// How much of `cost` earlier turns already reported, since the panel
    /// sums per-turn costs.
    billed: f64,
}

impl Translator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Convert one `session/update` payload (`params.update`).
    pub fn update(&mut self, u: &Value) -> Vec<Event> {
        match u["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => chunk("text_delta", u),
            "agent_thought_chunk" => chunk("thinking_delta", u),
            "tool_call" | "tool_call_update" => self.tool(u),
            "usage_update" => {
                let usd = u["cost"]["currency"]
                    .as_str()
                    .map_or(true, |c| c.eq_ignore_ascii_case("USD"));
                if let (true, Some(a)) = (usd, u["cost"]["amount"].as_f64()) {
                    self.cost = Some(a);
                }
                vec![]
            }
            // Plans, mode and command lists have no UI yet.
            _ => vec![],
        }
    }

    fn tool(&mut self, u: &Value) -> Vec<Event> {
        let Some(id) = u["toolCallId"].as_str() else {
            return vec![];
        };
        let is_new = u["sessionUpdate"] == "tool_call";
        let status = u["status"].as_str().unwrap_or("");
        let finished = matches!(status, "completed" | "failed");
        let t = self.tools.entry(id.to_string()).or_default();
        if t.done {
            return vec![];
        }

        let mut changed = false;
        if let Some(title) = u["title"].as_str().filter(|s| !s.is_empty()) {
            // A finished call's title is often just the file name, which says
            // less than the verb it ran under — keep the earlier one.
            if t.title != title && (!finished || t.title.is_empty()) {
                t.title = title.to_string();
                changed = true;
            }
        }
        if let Some(input) = u.get("rawInput").filter(|v| !is_empty(v)) {
            if t.input != *input {
                t.input = input.clone();
                changed = true;
            }
        }

        let mut paths = Vec::new();
        let writes = WRITE_KINDS.contains(&u["kind"].as_str().unwrap_or(""));
        let located = u["locations"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|_| writes)
            .filter_map(|l| l["path"].as_str());
        let diffed = u["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["type"] == "diff")
            .filter_map(|c| c["path"].as_str());
        for p in located.chain(diffed) {
            if t.paths.insert(p.to_string()) {
                paths.push(p.to_string());
            }
        }

        let mut out = Vec::new();
        if is_new || changed || !paths.is_empty() {
            let name = if t.title.is_empty() {
                u["kind"].as_str().unwrap_or("tool").to_string()
            } else {
                t.title.clone()
            };
            out.push(Event::new(
                "tool_start",
                json!({ "id": id, "name": name, "input": t.input, "paths": paths }),
            ));
        }
        if finished {
            t.done = true;
            out.push(Event::new(
                "tool_result",
                json!({ "id": id, "output": tool_output(u), "is_error": status == "failed" }),
            ));
        }
        out
    }

    /// Events for a finished `session/prompt`: usage, then the turn's `result`.
    pub fn finish(&mut self, session_id: &str, result: &Value) -> Vec<Event> {
        let mut out = Vec::new();
        if let Some(u) = result.get("usage").filter(|u| u.is_object()) {
            out.push(Event::new(
                "usage",
                json!({ "usage": {
                    "input_tokens": u["inputTokens"],
                    "output_tokens": u["outputTokens"],
                    "cache_read_input_tokens": u["cachedReadTokens"],
                    "cache_creation_input_tokens": u["cachedWriteTokens"],
                }}),
            ));
        }
        let cost = self.cost.map(|c| {
            let turn = (c - self.billed).max(0.0);
            self.billed = c;
            turn
        });
        let stop = result["stopReason"].as_str().unwrap_or("end_turn");
        let text = match stop {
            "refusal" => Some("The agent refused to continue."),
            "max_tokens" => Some("Stopped: the agent hit its output token limit."),
            "max_turn_requests" => Some("Stopped: the agent hit its per-turn request limit."),
            _ => None,
        };
        out.push(Event::new(
            "result",
            json!({
                "session_id": session_id,
                "cost_usd": cost,
                "is_error": text.is_some(),
                "text": text,
                "stop_reason": stop,
            }),
        ));
        out
    }
}

fn chunk(kind: &str, u: &Value) -> Vec<Event> {
    match u["content"]["text"].as_str() {
        Some(t) if !t.is_empty() && u["content"]["type"] == "text" => {
            vec![Event::new(kind, json!({ "text": t }))]
        }
        _ => vec![],
    }
}

fn is_empty(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Object(o) => o.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::String(s) => s.is_empty(),
        _ => false,
    }
}

/// One text body for a finished tool call: its text content, else its raw
/// output.
fn tool_output(u: &Value) -> String {
    let parts: Vec<String> = u["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| match c["type"].as_str()? {
            "content" => c["content"]["text"].as_str().map(str::to_string),
            "diff" => c["path"].as_str().map(|p| format!("edited {p}")),
            _ => None,
        })
        .collect();
    if !parts.is_empty() {
        return parts.join("\n");
    }
    match &u["rawOutput"] {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        o => o["output"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| o.to_string()),
    }
}

/// The `permission_request` event for an agent's `session/request_permission`.
pub fn permission_event(request_id: &str, params: &Value) -> Event {
    let tc = &params["toolCall"];
    let input = &tc["rawInput"];
    let summary = ["command", "filePath", "file_path", "path", "url", "query"]
        .iter()
        .find_map(|k| input[*k].as_str())
        .or_else(|| tc["locations"][0]["path"].as_str())
        .unwrap_or("");
    Event::new(
        "permission_request",
        json!({
            "request_id": request_id,
            "tool_name": tc["title"],
            "input": input,
            "title": tc["title"],
            "summary": summary,
        }),
    )
}

/// The `session/request_permission` result for a decision: the agent's own
/// allow/reject option, preferring the one-shot kinds. ARC never picks an
/// "always" option on the user's behalf unless the agent offers nothing else.
fn permission_outcome(options: &Value, allow: bool) -> Value {
    let kinds: &[&str] = if allow {
        &["allow_once", "allow_always"]
    } else {
        &["reject_once", "reject_always"]
    };
    let opts = options.as_array().cloned().unwrap_or_default();
    let picked = kinds.iter().find_map(|k| {
        opts.iter()
            .find(|o| o["kind"] == *k)
            .and_then(|o| o["optionId"].as_str())
    });
    match picked {
        Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// Anthropic-style content blocks (from the panel's composer) as ACP blocks.
/// Images are dropped when the agent doesn't accept them.
pub fn to_acp_content(blocks: &[Value], images: bool) -> Vec<Value> {
    blocks
        .iter()
        .filter_map(|b| match b["type"].as_str()? {
            "text" => Some(json!({ "type": "text", "text": b["text"] })),
            "image" if images => Some(json!({
                "type": "image",
                "mimeType": b["source"]["media_type"],
                "data": b["source"]["data"],
            })),
            _ => None,
        })
        .collect()
}

fn request(id: u64, method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

fn notification(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}

fn response(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn error_response(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn rpc_error(e: &Value) -> String {
    let msg = e["message"].as_str().unwrap_or("unknown error");
    // -32000 is ACP's "authentication required".
    if e["code"] == -32000 {
        format!("{msg} — sign in by running the agent once in a terminal, then try again.")
    } else {
        msg.to_string()
    }
}

const ID_INIT: u64 = 0;
const ID_NEW: u64 = 1;

/// Run one conversation until `cmds` closes or the agent exits.
///
/// Emits `init` once the agent has a session, then per turn the translated
/// stream, a `result`, and `done`. A turn that can't finish ends with `error`
/// instead. Returns `Err` only when the agent could not be started at all.
pub async fn run_session<F>(
    opts: SessionOptions,
    mut cmds: mpsc::UnboundedReceiver<Command>,
    mut on_event: F,
) -> Result<()>
where
    F: FnMut(Event) + Send + 'static,
{
    let mut cmd = tokio::process::Command::new(&opts.binary);
    cmd.args(&opts.args)
        .current_dir(&opts.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("acp: failed to spawn {}", opts.binary))?;

    // One writer task owns stdin; dropping `tx` closes it.
    let mut stdin = child.stdin.take().context("acp: no stdin")?;
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });
    let send = |line: String| {
        let _ = tx.send(line);
    };

    // A child that dies early says why on stderr and nowhere else.
    let stderr = child.stderr.take().context("acp: no stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if buf.len() > 4096 {
                buf.drain(..buf.len() - 2048);
            }
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    });
    let mut lines = BufReader::new(child.stdout.take().context("acp: no stdout")?).lines();

    send(request(
        ID_INIT,
        "initialize",
        json!({
            "protocolVersion": 1,
            // ARC offers no file or terminal access of its own (yet), so the
            // agent uses its built-in tools.
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "arc", "title": "ARC", "version": env!("CARGO_PKG_VERSION") },
        }),
    ));

    let mut next_id = ID_NEW + 1;
    let mut session: Option<String> = None;
    let mut images = false;
    // A prompt sent before the session exists waits here.
    let mut queued: Option<Vec<Value>> = None;
    let mut in_turn = false;
    let mut prompt_id: Option<u64> = None;
    // Open permission requests: our key → (agent's raw id, its options).
    let mut perms: HashMap<String, (Value, Value)> = HashMap::new();
    let mut tr = Translator::new();

    loop {
        tokio::select! {
            cmd = cmds.recv() => match cmd {
                None => {
                    let _ = child.kill().await;
                    return Ok(());
                }
                Some(Command::Prompt(content)) => {
                    if in_turn {
                        on_event(Event::new("error", json!({ "message": "a turn is already running" })));
                        continue;
                    }
                    in_turn = true;
                    match &session {
                        Some(sid) => {
                            let id = next_id;
                            next_id += 1;
                            prompt_id = Some(id);
                            send(request(id, "session/prompt", json!({
                                "sessionId": sid,
                                "prompt": to_acp_content(&content, images),
                            })));
                        }
                        None => queued = Some(content),
                    }
                }
                Some(Command::Cancel) => {
                    if !in_turn {
                        continue;
                    }
                    match (&session, prompt_id) {
                        (Some(sid), Some(_)) => {
                            send(notification("session/cancel", json!({ "sessionId": sid })));
                            // The spec requires open permission prompts to be
                            // answered `cancelled` before the turn can end.
                            for (_, (raw, _)) in perms.drain() {
                                send(response(&raw, json!({ "outcome": { "outcome": "cancelled" } })));
                            }
                        }
                        // Still starting up: nothing was sent, so just drop it.
                        _ => {
                            queued = None;
                            in_turn = false;
                            on_event(Event::new("done", json!({})));
                        }
                    }
                }
                Some(Command::Decide(d)) => {
                    if let Some((raw, options)) = perms.remove(&d.request_id) {
                        send(response(&raw, permission_outcome(&options, d.allow)));
                    }
                }
            },

            line = lines.next_line() => {
                let l = match line {
                    Ok(Some(l)) => l,
                    Ok(None) | Err(_) => break,
                };
                let l = l.trim();
                if l.is_empty() {
                    continue;
                }
                let msg: Value = match serde_json::from_str(l) {
                    Ok(v) => v,
                    // Not fatal: agents print warnings outside the protocol.
                    Err(e) => {
                        tracing::debug!("acp: unparsed line ({e}): {l}");
                        continue;
                    }
                };

                match (msg.get("method").and_then(Value::as_str), msg.get("id")) {
                    // A request from the agent.
                    (Some(method), Some(raw)) => {
                        if method == "session/request_permission" {
                            let key = raw.to_string();
                            perms.insert(key.clone(), (raw.clone(), msg["params"]["options"].clone()));
                            on_event(permission_event(&key, &msg["params"]));
                        } else {
                            // We advertised no fs/terminal capability, so
                            // anything else is unexpected; an answer keeps the
                            // agent from waiting forever.
                            send(error_response(raw, -32601, &format!("ARC does not handle {method}")));
                        }
                    }
                    (Some("session/update"), None) => {
                        for ev in tr.update(&msg["params"]["update"]) {
                            on_event(ev);
                        }
                    }
                    (Some(_), None) => {}
                    // A response to one of ours.
                    (None, Some(id)) => {
                        let id = id.as_u64();
                        let err = msg.get("error").filter(|e| !e.is_null());
                        if id == Some(ID_INIT) {
                            if let Some(e) = err {
                                on_event(Event::new("error", json!({ "message": rpc_error(e) })));
                                break;
                            }
                            images = msg["result"]["agentCapabilities"]["promptCapabilities"]["image"] == true;
                            send(request(ID_NEW, "session/new", json!({ "cwd": opts.cwd, "mcpServers": [] })));
                        } else if id == Some(ID_NEW) {
                            let sid = msg["result"]["sessionId"].as_str().map(str::to_string);
                            let Some(sid) = sid.filter(|_| err.is_none()) else {
                                let m = err.map(rpc_error).unwrap_or_else(|| "the agent did not start a session".into());
                                on_event(Event::new("error", json!({ "message": m })));
                                break;
                            };
                            on_event(Event::new("init", json!({ "session_id": sid })));
                            if let Some(content) = queued.take() {
                                let id = next_id;
                                next_id += 1;
                                prompt_id = Some(id);
                                send(request(id, "session/prompt", json!({
                                    "sessionId": sid,
                                    "prompt": to_acp_content(&content, images),
                                })));
                            }
                            session = Some(sid);
                        } else if id.is_some() && id == prompt_id {
                            in_turn = false;
                            prompt_id = None;
                            perms.clear();
                            match err {
                                Some(e) => on_event(Event::new("error", json!({ "message": rpc_error(e) }))),
                                None => {
                                    let sid = session.clone().unwrap_or_default();
                                    for ev in tr.finish(&sid, &msg["result"]) {
                                        on_event(ev);
                                    }
                                    on_event(Event::new("done", json!({})));
                                }
                            }
                        }
                    }
                    (None, None) => {}
                }
            }
        }
    }

    // The agent is gone (or failed to start a session).
    let _ = child.kill().await;
    let status = child.wait().await.ok();
    let stderr = stderr_task.await.unwrap_or_default();
    if in_turn {
        let code = status.and_then(|s| s.code()).unwrap_or(-1);
        let detail = stderr.trim();
        on_event(Event::new(
            "error",
            json!({ "message": if detail.is_empty() {
                format!("the agent exited ({code})")
            } else {
                format!("the agent exited ({code})\n{detail}")
            }}),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn up(tr: &mut Translator, raw: &str) -> Vec<Event> {
        let v: Value = serde_json::from_str(raw).expect("valid fixture");
        tr.update(&v)
    }

    #[test]
    fn message_and_thought_chunks_stream() {
        let mut tr = Translator::new();
        let a = up(
            &mut tr,
            r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hi"}}"#,
        );
        assert_eq!(a[0].kind, "text_delta");
        assert_eq!(a[0].payload["text"], "Hi");
        let t = up(
            &mut tr,
            r#"{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hm"}}"#,
        );
        assert_eq!(t[0].kind, "thinking_delta");
        assert!(up(
            &mut tr,
            r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"x"}}"#
        )
        .is_empty());
    }

    /// Trimmed from a live `opencode acp` write: empty input at first, path and
    /// input on the update, file name as the final title.
    #[test]
    fn a_write_upserts_its_row_and_reports_the_file_once() {
        let mut tr = Translator::new();
        let a = up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call","toolCallId":"t1","title":"write","kind":"edit","status":"pending","locations":[],"rawInput":{}}"#,
        );
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].kind, "tool_start");
        assert_eq!(a[0].payload["name"], "write");

        let b = up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"in_progress","kind":"edit","title":"write","locations":[{"path":"/r/b.txt"}],"rawInput":{"content":"bye","filePath":"/r/b.txt"}}"#,
        );
        assert_eq!(b[0].kind, "tool_start");
        assert_eq!(b[0].payload["input"]["filePath"], "/r/b.txt");
        assert_eq!(b[0].payload["paths"], json!(["/r/b.txt"]));

        let c = up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","title":"b.txt","content":[{"type":"content","content":{"type":"text","text":"Wrote file successfully."}}]}"#,
        );
        assert_eq!(
            c.len(),
            1,
            "a finished call's title must not rename the row"
        );
        assert_eq!(c[0].kind, "tool_result");
        assert_eq!(c[0].payload["output"], "Wrote file successfully.");
        assert_eq!(c[0].payload["is_error"], false);

        assert!(up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed"}"#
        )
        .is_empty());
    }

    #[test]
    fn a_command_takes_its_title_and_never_counts_as_an_edit() {
        let mut tr = Translator::new();
        up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call","toolCallId":"t2","title":"bash","kind":"execute","status":"pending","locations":[{"path":"/r"}],"rawInput":{"cwd":"/r"}}"#,
        );
        let b = up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t2","status":"in_progress","kind":"execute","title":"echo done","rawInput":{"command":"echo done","cwd":"/r"}}"#,
        );
        assert_eq!(b[0].payload["name"], "echo done");
        assert_eq!(b[0].payload["paths"], json!([]));
        let c = up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t2","status":"failed","rawOutput":{"output":"boom"}}"#,
        );
        assert_eq!(c[0].payload["output"], "boom");
        assert_eq!(c[0].payload["is_error"], true);
    }

    #[test]
    fn diff_content_marks_the_file_edited() {
        let mut tr = Translator::new();
        let a = up(
            &mut tr,
            r#"{"sessionUpdate":"tool_call","toolCallId":"t3","title":"Edit a.rs","kind":"other","status":"completed","content":[{"type":"diff","path":"/r/a.rs","oldText":"a","newText":"b"}]}"#,
        );
        assert_eq!(a[0].payload["paths"], json!(["/r/a.rs"]));
        assert_eq!(a[1].kind, "tool_result");
        assert_eq!(a[1].payload["output"], "edited /r/a.rs");
    }

    #[test]
    fn cost_is_reported_per_turn_from_the_running_total() {
        let mut tr = Translator::new();
        up(
            &mut tr,
            r#"{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":0.25,"currency":"USD"}}"#,
        );
        let r1 = tr.finish("s", &json!({ "stopReason": "end_turn" }));
        assert_eq!(r1[0].payload["cost_usd"], 0.25);
        up(
            &mut tr,
            r#"{"sessionUpdate":"usage_update","used":1,"size":2,"cost":{"amount":0.4,"currency":"USD"}}"#,
        );
        let r2 = tr.finish("s", &json!({ "stopReason": "end_turn" }));
        let turn = r2[0].payload["cost_usd"].as_f64().unwrap();
        assert!((turn - 0.15).abs() < 1e-9);
    }

    #[test]
    fn finish_maps_usage_and_flags_abnormal_stops() {
        let mut tr = Translator::new();
        let out = tr.finish(
            "s1",
            &json!({ "stopReason": "end_turn", "usage": { "inputTokens": 401, "outputTokens": 23, "cachedReadTokens": 12800 } }),
        );
        assert_eq!(out[0].kind, "usage");
        assert_eq!(out[0].payload["usage"]["input_tokens"], 401);
        assert_eq!(out[0].payload["usage"]["cache_read_input_tokens"], 12800);
        assert_eq!(out[1].kind, "result");
        assert_eq!(out[1].payload["is_error"], false);
        assert_eq!(out[1].payload["session_id"], "s1");
        assert!(out[1].payload["cost_usd"].is_null());

        let refused = tr.finish("s1", &json!({ "stopReason": "refusal" }));
        assert_eq!(refused[0].payload["is_error"], true);
        let cancelled = tr.finish("s1", &json!({ "stopReason": "cancelled" }));
        assert_eq!(cancelled[0].payload["is_error"], false);
    }

    #[test]
    fn permission_answers_pick_the_one_shot_option() {
        let opts = json!([
            { "optionId": "aa", "name": "Always", "kind": "allow_always" },
            { "optionId": "a1", "name": "Once", "kind": "allow_once" },
            { "optionId": "r1", "name": "No", "kind": "reject_once" },
        ]);
        assert_eq!(permission_outcome(&opts, true)["outcome"]["optionId"], "a1");
        assert_eq!(
            permission_outcome(&opts, false)["outcome"]["optionId"],
            "r1"
        );
        // No reject option at all: cancelling is the only safe "no".
        let allow_only = json!([{ "optionId": "a1", "kind": "allow_once" }]);
        assert_eq!(
            permission_outcome(&allow_only, false)["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn permission_event_summarizes_what_will_run() {
        let ev = permission_event(
            "7",
            &json!({ "toolCall": { "toolCallId": "t", "title": "bash", "rawInput": { "command": "rm -rf build" } }, "options": [] }),
        );
        assert_eq!(ev.kind, "permission_request");
        assert_eq!(ev.payload["request_id"], "7");
        assert_eq!(ev.payload["summary"], "rm -rf build");
    }

    #[test]
    fn content_blocks_convert_and_images_respect_the_capability() {
        let blocks = vec![
            json!({ "type": "text", "text": "look" }),
            json!({ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }),
        ];
        let with = to_acp_content(&blocks, true);
        assert_eq!(with[0], json!({ "type": "text", "text": "look" }));
        assert_eq!(with[1]["mimeType"], "image/png");
        assert_eq!(with[1]["data"], "AAAA");
        assert_eq!(to_acp_content(&blocks, false).len(), 1);
    }

    #[test]
    fn auth_errors_say_how_to_fix_them() {
        assert!(
            rpc_error(&json!({ "code": -32000, "message": "Authentication required" }))
                .contains("sign in")
        );
        assert_eq!(
            rpc_error(&json!({ "code": -32603, "message": "boom" })),
            "boom"
        );
    }

    /// Live round trip against a real agent: `cargo test -p arc-acp -- --ignored`.
    /// Needs `opencode` on PATH with a working default model.
    #[tokio::test]
    #[ignore]
    async fn live_opencode_turn() {
        let p = providers()
            .into_iter()
            .find(|p| p.id == "opencode-cli")
            .expect("opencode installed");
        let dir = std::env::temp_dir().join("arc-acp-live");
        let _ = std::fs::create_dir_all(&dir);
        let (tx, rx) = mpsc::unbounded_channel();
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<Event>();
        let task = tokio::spawn(run_session(
            SessionOptions {
                binary: p.path,
                args: p.args,
                cwd: dir.to_string_lossy().into(),
            },
            rx,
            move |e| {
                let _ = ev_tx.send(e);
            },
        ));
        tx.send(Command::Prompt(vec![
            json!({ "type": "text", "text": "Reply with just the word hi." }),
        ]))
        .unwrap();
        let mut kinds = Vec::new();
        while let Some(e) = tokio::time::timeout(std::time::Duration::from_secs(120), ev_rx.recv())
            .await
            .unwrap()
        {
            kinds.push(e.kind.clone());
            if e.kind == "done" || e.kind == "error" {
                assert_eq!(e.kind, "done", "turn failed: {:?}", e.payload);
                break;
            }
        }
        assert_eq!(kinds.first().map(String::as_str), Some("init"));
        assert!(kinds.iter().any(|k| k == "text_delta"));
        assert!(kinds.iter().any(|k| k == "result"));
        drop(tx);
        task.await.unwrap().unwrap();
    }
}
