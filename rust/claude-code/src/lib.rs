//! Client for the [Claude Code] CLI, driven headless.
//!
//! Claude Code has no daemon to connect to — unlike `wingman serve`, which ARC
//! talks to over HTTP/SSE. What it has instead is a documented non-interactive
//! mode: `claude -p --output-format stream-json` prints one JSON object per
//! line for the life of a turn. So ARC spawns the user's own `claude` binary,
//! one child process per turn, and reads that stream. There is nothing to
//! install, configure or authenticate — the CLI already holds the user's login.
//!
//! Conversation continuity is the CLI's job too: every turn reports a
//! `session_id`, and passing it back as `--resume` continues the same history.
//! ARC therefore keeps no transcript of its own on the Rust side.
//!
//! [`translate`](Translator::push) converts the CLI's wire vocabulary into the
//! same event names ARC's Wingman panel already renders (`text_delta`,
//! `tool_start`, `tool_result`, …), so the two agent panels share one reducer
//! shape rather than growing two.
//!
//! Wire notes, confirmed against a live CLI (2.1.x):
//!   * Every line is one JSON object with a `type`. Unknown types are ignored —
//!     the CLI adds them (hook lifecycle, prompt suggestions) and an older ARC
//!     must not break on a newer CLI.
//!   * `system`/`init` carries `session_id`, `model`, `tools`, `permissionMode`.
//!   * `assistant` wraps a full Anthropic message; its `content` holds `text`,
//!     `thinking` and `tool_use` blocks.
//!   * `user` carries `tool_result` blocks, keyed by `tool_use_id`.
//!   * `stream_event` (only with `--include-partial-messages`) carries raw SSE
//!     deltas — this is what makes text appear as it is written.
//!   * `result` is the single terminal line: `total_cost_usd`, `usage`,
//!     `is_error`, and the final answer text.
//!
//! [Claude Code]: https://code.claude.com/docs/en/headless

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::{mpsc, oneshot};

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

/// How to run one turn. Everything optional is "let the CLI decide", which is
/// the right default for a tool the user has already configured themselves.
#[derive(Debug, Clone, Default)]
pub struct TurnOptions {
    /// Absolute path the child runs in. This is what scopes Claude's file
    /// access, so it is the one field with no sensible default.
    pub cwd: String,
    pub prompt: String,
    /// Session to continue, from a previous turn's `session_id`.
    pub resume: Option<String>,
    /// Alias (`opus`, `sonnet`, `haiku`) or a full model id.
    pub model: Option<String>,
    /// One of the CLI's `--permission-mode` values.
    pub permission_mode: Option<String>,
    /// Hard spend ceiling for the turn, in USD.
    pub max_budget_usd: Option<f64>,
    /// Resolved `claude` binary. Discovered by [`binary`] when absent.
    pub binary: Option<String>,
}

/// Locate the user's Claude Code binary, or `None` when it isn't installed.
///
/// Reuses the launcher's PATH probe rather than repeating the per-platform
/// candidate list — the AI CLI menu and this integration must agree on what
/// counts as "Claude Code is installed", or one will offer what the other
/// can't run.
pub fn binary() -> Option<String> {
    arc_pty::discover_ai_clis()
        .into_iter()
        .find(|c| c.id == "claude-cli")
        .map(|c| c.path)
}

/// Folds the CLI's stream into ARC events.
///
/// Stateful for one reason: with `--include-partial-messages` the same text
/// arrives twice — once as deltas, then again in the completed `assistant`
/// message. Emitting both would double every answer. So text blocks on
/// `assistant` messages are dropped once any delta has been seen, and kept
/// otherwise, which also makes the integration degrade cleanly on a CLI build
/// that doesn't emit partials at all.
#[derive(Default)]
pub struct Translator {
    saw_delta: bool,
}

impl Translator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Convert one decoded line. Returns zero or more events.
    pub fn push(&mut self, line: &Value) -> Vec<Event> {
        match line.get("type").and_then(Value::as_str).unwrap_or("") {
            "system" if line.get("subtype").and_then(Value::as_str) == Some("init") => {
                vec![Event::new(
                    "init",
                    json!({
                        "session_id": line.get("session_id"),
                        "model": line.get("model"),
                        "tools": line.get("tools"),
                        "permission_mode": line.get("permissionMode"),
                        "cwd": line.get("cwd"),
                    }),
                )]
            }

            "stream_event" => {
                let ev = line.get("event").unwrap_or(&Value::Null);
                if ev.get("type").and_then(Value::as_str) != Some("content_block_delta") {
                    return vec![];
                }
                let delta = ev.get("delta").unwrap_or(&Value::Null);
                let (kind, field) = match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => ("text_delta", "text"),
                    Some("thinking_delta") => ("thinking_delta", "thinking"),
                    // `input_json_delta` is a tool call being typed out. The
                    // completed block arrives on the assistant message, which
                    // is both easier to render and already parsed.
                    _ => return vec![],
                };
                let text = delta.get(field).and_then(Value::as_str).unwrap_or("");
                if text.is_empty() {
                    return vec![];
                }
                self.saw_delta = true;
                vec![Event::new(kind, json!({ "text": text }))]
            }

            "assistant" => {
                let blocks = line
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let mut out = Vec::new();

                // An API-level failure (expired login, rate limit) arrives as a
                // synthetic assistant message rather than a non-zero exit, so
                // it has to be caught here or the panel shows the refusal as if
                // Claude had said it.
                if line.get("is_api_error_message").and_then(Value::as_bool) == Some(true) {
                    let text = blocks
                        .iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("");
                    return vec![Event::new(
                        "error",
                        json!({ "message": if text.is_empty() { "the CLI reported an API error".into() } else { text } }),
                    )];
                }

                for b in blocks {
                    match b.get("type").and_then(Value::as_str) {
                        Some("text") if !self.saw_delta => out.push(Event::new(
                            "text_delta",
                            json!({ "text": b.get("text").and_then(Value::as_str).unwrap_or("") }),
                        )),
                        Some("thinking") if !self.saw_delta => out.push(Event::new(
                            "thinking_delta",
                            json!({ "text": b.get("thinking").and_then(Value::as_str).unwrap_or("") }),
                        )),
                        Some("tool_use") => out.push(Event::new(
                            "tool_start",
                            json!({
                                "id": b.get("id"),
                                "name": b.get("name"),
                                "input": b.get("input"),
                            }),
                        )),
                        _ => {}
                    }
                }

                if let Some(usage) = line.pointer("/message/usage") {
                    out.push(Event::new("usage", json!({ "usage": usage })));
                }
                out
            }

            // Tool results come back as a synthetic user turn.
            "user" => line
                .pointer("/message/content")
                .and_then(Value::as_array)
                .map(|blocks| {
                    blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                        .map(|b| {
                            Event::new(
                                "tool_result",
                                json!({
                                    "id": b.get("tool_use_id"),
                                    "output": stringify_content(b.get("content")),
                                    "is_error": b.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                                }),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),

            "result" => {
                let mut out = Vec::new();
                if let Some(usage) = line.get("usage") {
                    out.push(Event::new("usage", json!({ "usage": usage })));
                }
                // A turn that errored still reports cost and denials, so the
                // result row is emitted either way and carries the flag.
                out.push(Event::new(
                    "result",
                    json!({
                        "session_id": line.get("session_id"),
                        "cost_usd": line.get("total_cost_usd"),
                        "is_error": line.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                        "text": line.get("result"),
                        "num_turns": line.get("num_turns"),
                        "duration_ms": line.get("duration_ms"),
                        "permission_denials": line.get("permission_denials"),
                    }),
                ));
                out
            }

            // The CLI asks permission over the same stream. Surfaced as an
            // event so the panel can render an approve/deny prompt; the reply
            // goes back on stdin (see `Decision`). Anything the CLI asks that
            // ARC has no UI for is refused by the caller rather than ignored —
            // an unanswered control request stalls the turn forever.
            "control_request" => {
                let req = line.get("request").unwrap_or(&Value::Null);
                let id = line
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    return vec![];
                }
                match req.get("subtype").and_then(Value::as_str) {
                    Some("can_use_tool") => vec![Event::new(
                        "permission_request",
                        json!({
                            "request_id": id,
                            "tool_name": req.get("tool_name"),
                            "input": req.get("input"),
                            "tool_use_id": req.get("tool_use_id"),
                            // Present only for MCP tools that ship a display
                            // block; the panel falls back to the tool name.
                            "title": req.get("title"),
                            "display_name": req.get("display_name"),
                            "description": req.get("description"),
                            "suggestions": req.get("permission_suggestions"),
                        }),
                    )],
                    other => vec![Event::new(
                        "control_unsupported",
                        json!({ "request_id": id, "subtype": other.unwrap_or("") }),
                    )],
                }
            }

            _ => vec![],
        }
    }
}

/// The user's answer to one `can_use_tool` request.
#[derive(Debug, Clone)]
pub struct Decision {
    pub request_id: String,
    pub allow: bool,
    /// Shown to Claude on a denial, so it can adapt rather than just retry.
    pub message: Option<String>,
}

/// Build the `control_response` line for a decision.
///
/// `input` is the tool input the CLI proposed. An allow echoes it back
/// unchanged — the protocol treats `updatedInput` as the input to actually run,
/// and ARC never rewrites it. (The CLI does fall back to the original when it
/// is missing, but relying on that would make a future edit-the-command feature
/// silently do nothing.)
fn decision_line(d: &Decision, input: Option<Value>) -> String {
    let response = if d.allow {
        json!({ "behavior": "allow", "updatedInput": input.unwrap_or(json!({})) })
    } else {
        json!({
            "behavior": "deny",
            "message": d.message.clone().unwrap_or_else(|| "denied by the user in ARC".into()),
        })
    };
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": d.request_id, "response": response },
    })
    .to_string()
}

/// Refuse a control request ARC has no handler for. Sent so the CLI gets an
/// answer — silence would stall the turn indefinitely.
fn unsupported_line(request_id: &str, subtype: &str) -> String {
    json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": request_id,
            "error": format!("ARC does not handle control request {subtype:?}"),
        },
    })
    .to_string()
}

/// One user turn, as the CLI's `--input-format stream-json` expects it.
fn user_message_line(prompt: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": prompt }] },
    })
    .to_string()
}

/// A `tool_result`'s `content` is a string on some tools and a block array on
/// others. The panel renders one text body either way.
fn stringify_content(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| match b.get("text").and_then(Value::as_str) {
                Some(t) => t.to_string(),
                None => b.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// Run one turn to completion, calling `on_event` for each event.
///
/// stdin stays open for the life of the turn, because it is a two-way channel:
/// the prompt goes out on it, and so does every permission answer. That is also
/// why the prompt is a `stream-json` user message rather than a command-line
/// argument — `--input-format stream-json` is what enables the control channel
/// the CLI asks for permission on.
///
/// Resolves when the child exits. Sending on `cancel` kills it — the panel's
/// stop button, and the only way out of a permission prompt nobody answers.
/// A non-zero exit with nothing on the stream is surfaced through the returned
/// error so the caller can end the turn with something to show.
pub async fn run_turn<F>(
    opts: TurnOptions,
    mut cancel: oneshot::Receiver<()>,
    mut decisions: mpsc::UnboundedReceiver<Decision>,
    mut on_event: F,
) -> Result<()>
where
    F: FnMut(Event) + Send + 'static,
{
    let bin = opts
        .binary
        .clone()
        .or_else(binary)
        .context("claude: the Claude Code CLI is not on PATH")?;

    let mut cmd = Command::new(&bin);
    cmd.current_dir(&opts.cwd)
        .arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        // `--verbose` is required by the CLI for stream-json output.
        .arg("--verbose")
        // Without this, an answer lands in one lump when the turn finishes.
        .arg("--include-partial-messages")
        // Opens the control channel: permission requests come out on stdout as
        // `control_request`, and answers go back in on stdin.
        .arg("--input-format")
        .arg("stream-json");

    if let Some(id) = opts.resume.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--resume").arg(id);
    }
    if let Some(m) = opts.model.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--model").arg(m);
    }
    if let Some(p) = opts.permission_mode.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--permission-mode").arg(p);
    }
    if let Some(b) = opts.max_budget_usd.filter(|b| *b > 0.0) {
        cmd.arg("--max-budget-usd").arg(b.to_string());
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Otherwise every turn flashes a console window on Windows.
    #[cfg(windows)]
    {
        // `creation_flags` is inherent on tokio's Command — no trait import.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("claude: failed to spawn {bin}"))?;

    // One writer task owns stdin. Everything that needs to say something to the
    // child sends a line here; dropping the sender closes the pipe, which is
    // what tells the CLI the conversation is over.
    let mut stdin = child.stdin.take().context("claude: no stdin")?;
    let (to_child, mut child_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(line) = child_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    let mut to_child = Some(to_child);
    fn send(tx: &Option<mpsc::UnboundedSender<String>>, line: String) {
        if let Some(tx) = tx {
            let _ = tx.send(line);
        }
    }
    send(&to_child, user_message_line(&opts.prompt));

    let stdout = child.stdout.take().context("claude: no stdout")?;
    let stderr = child.stderr.take().context("claude: no stderr")?;

    // Drain stderr concurrently. It is normally empty, but a child that dies
    // early says why there and nowhere else — and an undrained pipe can block
    // the child once it fills.
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if buf.len() < 4096 {
                buf.push_str(&l);
                buf.push('\n');
            }
        }
        buf
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut tr = Translator::new();
    let mut saw_any = false;
    // Tool input per outstanding permission request, so an approval can echo
    // back exactly what the CLI proposed to run.
    let mut pending: HashMap<String, Value> = HashMap::new();

    loop {
        tokio::select! {
            _ = &mut cancel => {
                let _ = child.kill().await;
                on_event(Event::new("error", json!({ "message": "turn cancelled" })));
                return Ok(());
            }

            Some(d) = decisions.recv() => {
                let input = pending.remove(&d.request_id);
                send(&to_child, decision_line(&d, input));
            }

            line = lines.next_line() => {
                match line {
                    Ok(Some(l)) => {
                        let l = l.trim();
                        if l.is_empty() { continue; }
                        match serde_json::from_str::<Value>(l) {
                            Ok(v) => {
                                saw_any = true;
                                for ev in tr.push(&v) {
                                    match ev.kind.as_str() {
                                        // Remember the proposed input before the
                                        // event leaves for the UI — the answer
                                        // comes back with only the request id.
                                        "permission_request" => {
                                            if let Some(id) =
                                                ev.payload.get("request_id").and_then(Value::as_str)
                                            {
                                                pending.insert(
                                                    id.to_string(),
                                                    ev.payload
                                                        .get("input")
                                                        .cloned()
                                                        .unwrap_or(Value::Null),
                                                );
                                            }
                                            on_event(ev);
                                        }
                                        // Answered here rather than in the UI:
                                        // there is nothing for a user to decide,
                                        // and the turn stalls without a reply.
                                        "control_unsupported" => {
                                            let id = ev
                                                .payload
                                                .get("request_id")
                                                .and_then(Value::as_str)
                                                .unwrap_or("");
                                            let subtype = ev
                                                .payload
                                                .get("subtype")
                                                .and_then(Value::as_str)
                                                .unwrap_or("");
                                            tracing::debug!(
                                                "claude: refusing control request {subtype:?}"
                                            );
                                            send(&to_child, unsupported_line(id, subtype));
                                        }
                                        // The turn is over. Closing stdin is what
                                        // lets the child exit — it would otherwise
                                        // wait for another user message.
                                        "result" => {
                                            on_event(ev);
                                            to_child = None;
                                        }
                                        _ => on_event(ev),
                                    }
                                }
                            }
                            // Not fatal: anything the CLI prints outside the
                            // protocol (a warning, an update notice) would
                            // otherwise abort a turn that is running fine.
                            Err(e) => tracing::debug!("claude: unparsed line ({e}): {l}"),
                        }
                    }
                    Ok(None) => break,
                    Err(e) => return Err(e).context("claude: reading stream"),
                }
            }
        }
    }

    let status = child.wait().await.context("claude: waiting for exit")?;
    let stderr = stderr_task.await.unwrap_or_default();

    if !status.success() && !saw_any {
        let detail = stderr.trim();
        anyhow::bail!(
            "claude exited {}{}",
            status.code().unwrap_or(-1),
            if detail.is_empty() {
                String::new()
            } else {
                format!("\n{detail}")
            }
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(tr: &mut Translator, raw: &str) -> Vec<Event> {
        tr.push(&serde_json::from_str(raw).expect("test fixture is valid JSON"))
    }

    /// Lines below are trimmed copies of a real `claude -p --output-format
    /// stream-json --include-partial-messages` run.
    #[test]
    fn init_carries_the_session_to_resume() {
        let mut tr = Translator::new();
        let out = feed(
            &mut tr,
            r#"{"type":"system","subtype":"init","session_id":"abc","model":"claude-opus-5","tools":["Read"],"permissionMode":"acceptEdits","cwd":"/repo"}"#,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "init");
        assert_eq!(out[0].payload["session_id"], "abc");
    }

    #[test]
    fn hook_noise_is_ignored() {
        let mut tr = Translator::new();
        assert!(feed(
            &mut tr,
            r#"{"type":"system","subtype":"hook_response","output":"x"}"#
        )
        .is_empty());
    }

    #[test]
    fn deltas_stream_and_suppress_the_completed_copy() {
        // The whole reason `Translator` holds state: with partial messages on,
        // the same sentence arrives as deltas and then again in full.
        let mut tr = Translator::new();
        let d = feed(
            &mut tr,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}}"#,
        );
        assert_eq!(d[0].kind, "text_delta");
        assert_eq!(d[0].payload["text"], "Hi");

        let a = feed(
            &mut tr,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}"#,
        );
        assert!(a.is_empty(), "completed text must not be emitted twice");
    }

    #[test]
    fn assistant_text_survives_a_cli_without_partials() {
        let mut tr = Translator::new();
        let a = feed(
            &mut tr,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi"}]}}"#,
        );
        assert_eq!(a[0].kind, "text_delta");
        assert_eq!(a[0].payload["text"], "Hi");
    }

    #[test]
    fn tool_calls_survive_delta_suppression() {
        let mut tr = Translator::new();
        tr.saw_delta = true;
        let out = feed(
            &mut tr,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"dup"},{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"a.rs"}}]}}"#,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "tool_start");
        assert_eq!(out[0].payload["id"], "t1");
        assert_eq!(out[0].payload["input"]["file_path"], "a.rs");
    }

    #[test]
    fn tool_results_flatten_both_content_shapes() {
        let mut tr = Translator::new();
        let s = feed(
            &mut tr,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#,
        );
        assert_eq!(s[0].payload["output"], "ok");
        assert_eq!(s[0].payload["is_error"], false);

        let blocks = feed(
            &mut tr,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","is_error":true,"content":[{"type":"text","text":"boom"}]}]}}"#,
        );
        assert_eq!(blocks[0].payload["output"], "boom");
        assert_eq!(blocks[0].payload["is_error"], true);
    }

    #[test]
    fn api_errors_become_errors_not_answers() {
        let mut tr = Translator::new();
        let out = feed(
            &mut tr,
            r#"{"type":"assistant","is_api_error_message":true,"message":{"content":[{"type":"text","text":"Not logged in"}]}}"#,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "error");
        assert_eq!(out[0].payload["message"], "Not logged in");
    }

    #[test]
    fn permission_requests_surface_with_their_input() {
        let mut tr = Translator::new();
        let out = feed(
            &mut tr,
            r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t9","input":{"command":"rm -rf build"}}}"#,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "permission_request");
        assert_eq!(out[0].payload["request_id"], "req-1");
        assert_eq!(out[0].payload["tool_name"], "Bash");
        assert_eq!(out[0].payload["input"]["command"], "rm -rf build");
    }

    #[test]
    fn other_control_requests_are_flagged_for_refusal() {
        // Not ignored: an unanswered control request stalls the turn forever,
        // so the run loop has to know to send an error back.
        let mut tr = Translator::new();
        let out = feed(
            &mut tr,
            r#"{"type":"control_request","request_id":"req-2","request":{"subtype":"elicitation"}}"#,
        );
        assert_eq!(out[0].kind, "control_unsupported");
        assert_eq!(out[0].payload["request_id"], "req-2");
    }

    #[test]
    fn a_control_request_without_an_id_is_unanswerable() {
        let mut tr = Translator::new();
        assert!(feed(
            &mut tr,
            r#"{"type":"control_request","request":{"subtype":"can_use_tool"}}"#
        )
        .is_empty());
    }

    /// Envelope verified against a live CLI: an `initialize` request answered
    /// with exactly this shape round-trips.
    #[test]
    fn an_approval_echoes_the_proposed_input_back() {
        let d = Decision {
            request_id: "req-1".into(),
            allow: true,
            message: None,
        };
        let v: Value =
            serde_json::from_str(&decision_line(&d, Some(json!({ "command": "ls" })))).unwrap();
        assert_eq!(v["type"], "control_response");
        assert_eq!(v["response"]["subtype"], "success");
        assert_eq!(v["response"]["request_id"], "req-1");
        assert_eq!(v["response"]["response"]["behavior"], "allow");
        assert_eq!(v["response"]["response"]["updatedInput"]["command"], "ls");
    }

    #[test]
    fn a_denial_carries_a_reason_claude_can_act_on() {
        let d = Decision {
            request_id: "req-1".into(),
            allow: false,
            message: Some("not on main".into()),
        };
        let v: Value = serde_json::from_str(&decision_line(&d, None)).unwrap();
        assert_eq!(v["response"]["response"]["behavior"], "deny");
        assert_eq!(v["response"]["response"]["message"], "not on main");

        // A denial with no reason still has to say something.
        let bare = Decision {
            request_id: "req-2".into(),
            allow: false,
            message: None,
        };
        let v: Value = serde_json::from_str(&decision_line(&bare, None)).unwrap();
        assert!(v["response"]["response"]["message"]
            .as_str()
            .is_some_and(|m| !m.is_empty()));
    }

    #[test]
    fn the_prompt_goes_out_as_a_stream_json_user_message() {
        let v: Value = serde_json::from_str(&user_message_line("say hi")).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "say hi");
    }

    #[test]
    fn result_reports_cost_and_the_session_id() {
        let mut tr = Translator::new();
        let out = feed(
            &mut tr,
            r#"{"type":"result","subtype":"success","is_error":false,"session_id":"abc","total_cost_usd":0.04,"num_turns":2,"duration_ms":900,"usage":{"input_tokens":10,"output_tokens":5},"result":"done"}"#,
        );
        assert_eq!(out[0].kind, "usage");
        assert_eq!(out[1].kind, "result");
        assert_eq!(out[1].payload["cost_usd"], 0.04);
        assert_eq!(out[1].payload["session_id"], "abc");
    }
}
