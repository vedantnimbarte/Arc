//! Client for a [`wingman serve`] daemon.
//!
//! Wingman is a terminal coding agent with an HTTP/SSE API: a persistent
//! multi-project board over pilot runs, pilot control, and agent sessions whose
//! turns stream typed events. ARC talks to it over that API rather than
//! shelling out, so it can render agent work as UI instead of as terminal text.
//!
//! The dependency is deliberately one-way and optional: ARC never requires a
//! daemon, and every call fails soft. [`Client::health`] is the probe the UI
//! uses to decide whether to show any of this at all.
//!
//! Wire notes, confirmed against a live 0.2.0 daemon:
//!   * Errors are `{"error": "..."}` with a non-2xx status.
//!   * Streams are `text/event-stream`, framed `event: <name>\ndata: <json>\n\n`.
//!     Wingman guarantees the JSON payload contains no bare newline, so no
//!     multi-line `data:` reassembly is needed.
//!   * Auth is `Authorization: Bearer <token>`, omitted entirely for the
//!     common loopback-without-auth setup.
//!
//! [`wingman serve`]: https://github.com/vedantnimbarte/Wingman

use anyhow::{anyhow, Context, Result};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

// ─── Wire types ────────────────────────────────────────────────────────────
//
// Only what ARC actually renders is typed. Anything ARC merely forwards to the
// UI stays a `Value` — the daemon owns those shapes and typing them here would
// just be a second place to update when Wingman adds a field.

/// `GET /v1/health`. The one unauthenticated route, so it doubles as both
/// "is a daemon there" and "will it want a token".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub ok: bool,
    pub version: String,
    #[serde(default)]
    pub uptime_secs: u64,
    /// When true, every other route needs a bearer token.
    #[serde(default)]
    pub auth_required: bool,
}

/// One entry of the daemon's project allowlist. Nothing outside this list is
/// reachable, so ARC uses it to populate the project picker rather than
/// offering the user's whole filesystem.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub root: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub indexd_running: bool,
    #[serde(default)]
    pub index_age_secs: Option<u64>,
}

/// A pilot run as listed by `GET /v1/projects/{p}/pilot/runs`.
///
/// `RunSummary` carries no cost or timestamps by design — read a single run for
/// `totals`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunSummary {
    pub run_id: String,
    pub goal: String,
    pub status: String,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub total: u32,
    /// Terminal runs will never change again, so the UI can stop streaming.
    #[serde(default)]
    pub terminal: bool,
}

/// One planner task inside a run. Ephemeral — projected live from the run's
/// `state.json`, not stored by the board.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubRow {
    pub task_id: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub usd: f64,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default)]
    pub writes: u32,
    #[serde(default)]
    pub elapsed_secs: Option<u64>,
    #[serde(default)]
    pub current_tool: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    /// Present once the task has a worktree — this is what ARC's diff-review
    /// queue opens.
    #[serde(default)]
    pub worktree: Option<String>,
    /// Transcript id, so ARC can jump from a task to what its agent actually did.
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub blocked_by: Vec<String>,
}

/// Roll-up across a card's tasks. Counts are per-status; `status` is the
/// card-level verdict the board derives from them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RollUp {
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub total: u32,
    #[serde(default)]
    pub done: u32,
    #[serde(default)]
    pub failed: u32,
    #[serde(default)]
    pub blocked: u32,
    #[serde(default)]
    pub in_progress: u32,
    #[serde(default)]
    pub not_started: u32,
    #[serde(default)]
    pub review: u32,
    #[serde(default)]
    pub usd: f64,
    #[serde(default)]
    pub subrows: Vec<SubRow>,
}

/// A board badge. Typed `{kind, text}` rather than a formatted string
/// specifically so a renderer can tell a progress badge from a user's label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Badge {
    pub kind: String,
    pub text: String,
}

/// A durable board card — a goal a human wrote. Outlives the runs that execute
/// it, and spans projects (the board is global, at `~/.wingman/board.db`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    #[serde(default)]
    pub short: Option<String>,
    pub project: String,
    #[serde(default)]
    pub project_name: Option<String>,
    /// The board's registry can name repos this daemon does not serve.
    /// Dispatching one is a 403, so the UI disables it instead of offering it.
    #[serde(default)]
    pub project_missing: bool,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Derived, never stored.
    pub column: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub badges: Vec<Badge>,
    #[serde(default)]
    pub rollup: Option<RollUp>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Board {
    #[serde(default)]
    pub cards: Vec<Card>,
}

/// A stored conversation. The transcript is a normal file in the project, so
/// sessions survive a daemon restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    #[serde(default)]
    pub first_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub turns: u32,
}

// ─── Client ────────────────────────────────────────────────────────────────

/// A handle on one `wingman serve` daemon.
///
/// Cheap to clone — the inner `reqwest::Client` pools connections, so the
/// Tauri layer keeps one of these per configured endpoint.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl Client {
    /// `base_url` is the daemon origin, e.g. `http://127.0.0.1:8787`. A
    /// trailing slash is tolerated.
    ///
    /// No global timeout is set: turn streams are long-lived by nature and
    /// `[serve].request_timeout_secs` already bounds them server-side. The
    /// short timeout that does matter is on [`Client::health`], which must
    /// fail fast so a missing daemon never stalls ARC's UI.
    pub fn new(base_url: impl Into<String>, token: Option<String>) -> Result<Self> {
        let base = base_url.into().trim_end_matches('/').to_string();
        if base.is_empty() {
            return Err(anyhow!("wingman: empty base url"));
        }
        Ok(Self {
            http: reqwest::Client::builder()
                .build()
                .context("building wingman http client")?,
            base,
            token,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.token {
            Some(t) if !t.is_empty() => rb.bearer_auth(t),
            _ => rb,
        }
    }

    /// Turn a response into JSON, mapping Wingman's `{"error": "..."}` body
    /// onto an error so callers see the daemon's own message rather than a
    /// bare status code.
    async fn json(resp: reqwest::Response) -> Result<Value> {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(parsed);
        }
        let msg = parsed
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                if body.is_empty() {
                    status.to_string()
                } else {
                    body.clone()
                }
            });
        Err(anyhow!("wingman {}: {}", status.as_u16(), msg))
    }

    async fn get(&self, path: &str) -> Result<Value> {
        let resp = self.auth(self.http.get(self.url(path))).send().await?;
        Self::json(resp).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let resp = self
            .auth(self.http.post(self.url(path)))
            .json(&body)
            .send()
            .await?;
        Self::json(resp).await
    }

    async fn delete(&self, path: &str) -> Result<Value> {
        let resp = self.auth(self.http.delete(self.url(path))).send().await?;
        Self::json(resp).await
    }

    // ─── Meta ──────────────────────────────────────────────────────────────

    /// Probe the daemon. Deliberately short-timeout and unauthenticated: this
    /// is what decides whether ARC shows the Wingman UI at all, so a daemon
    /// that is absent must be discovered in milliseconds, not seconds.
    pub async fn health(&self) -> Result<Health> {
        let resp = self
            .http
            .get(self.url("/v1/health"))
            .timeout(Duration::from_millis(1500))
            .send()
            .await?;
        let v = Self::json(resp).await?;
        Ok(serde_json::from_value(v)?)
    }

    pub async fn projects(&self) -> Result<Vec<Project>> {
        let v = self.get("/v1/projects").await?;
        Ok(serde_json::from_value(v["projects"].clone())?)
    }

    // ─── Board ─────────────────────────────────────────────────────────────

    pub async fn board(&self, project: Option<&str>, archived: bool) -> Result<Board> {
        let mut q = Vec::new();
        if let Some(p) = project {
            q.push(format!("project={p}"));
        }
        if archived {
            q.push("archived=true".into());
        }
        let path = if q.is_empty() {
            "/v1/board".to_string()
        } else {
            format!("/v1/board?{}", q.join("&"))
        };
        let v = self.get(&path).await?;
        Ok(serde_json::from_value(v)?)
    }

    pub async fn board_add_card(
        &self,
        project: &str,
        title: &str,
        goal: Option<&str>,
    ) -> Result<Value> {
        self.post(
            "/v1/board/cards",
            json!({ "project": project, "title": title, "goal": goal }),
        )
        .await
    }

    /// Start a pilot run for a card. `again` re-dispatches a card that already
    /// ran, linking a fresh run to the same card.
    pub async fn board_dispatch(&self, card: &str, again: bool) -> Result<Value> {
        self.post(
            &format!("/v1/board/cards/{card}/dispatch"),
            json!({ "again": again }),
        )
        .await
    }

    pub async fn board_archive(&self, card: &str, restore: bool) -> Result<Value> {
        self.post(
            &format!("/v1/board/cards/{card}/archive"),
            json!({ "restore": restore }),
        )
        .await
    }

    pub async fn board_delete_card(&self, card: &str) -> Result<Value> {
        self.delete(&format!("/v1/board/cards/{card}")).await
    }

    // ─── Pilot ─────────────────────────────────────────────────────────────

    pub async fn pilot_runs(&self, project: &str) -> Result<Vec<RunSummary>> {
        let v = self
            .get(&format!("/v1/projects/{project}/pilot/runs"))
            .await?;
        Ok(serde_json::from_value(v["runs"].clone())?)
    }

    pub async fn pilot_run(&self, project: &str, run: &str) -> Result<Value> {
        self.get(&format!("/v1/projects/{project}/pilot/runs/{run}"))
            .await
    }

    /// Pilot control. Each maps to one command appended to the run's
    /// `control.jsonl`; the orchestrator's watchdog applies it. Nothing here
    /// reaches into the run's process, so a control call can't wedge a run.
    pub async fn pilot_control(
        &self,
        project: &str,
        run: &str,
        action: PilotAction,
        task: Option<&str>,
    ) -> Result<Value> {
        let body = match task {
            Some(t) => json!({ "task": t }),
            None => json!({}),
        };
        self.post(
            &format!("/v1/projects/{project}/pilot/runs/{run}/{}", action.path()),
            body,
        )
        .await
    }

    // ─── Sessions ──────────────────────────────────────────────────────────

    pub async fn sessions(&self, project: &str) -> Result<Vec<SessionInfo>> {
        let v = self.get(&format!("/v1/projects/{project}/sessions")).await?;
        Ok(serde_json::from_value(v["sessions"].clone())?)
    }

    pub async fn session_transcript(&self, project: &str, id: &str) -> Result<Value> {
        self.get(&format!("/v1/projects/{project}/sessions/{id}"))
            .await
    }

    pub async fn create_session(
        &self,
        project: &str,
        model: Option<&str>,
        mode: Option<&str>,
    ) -> Result<String> {
        let v = self
            .post(
                &format!("/v1/projects/{project}/sessions"),
                json!({ "model": model, "mode": mode }),
            )
            .await?;
        v["session_id"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("wingman: session create returned no session_id"))
    }

    pub async fn delete_session(&self, project: &str, id: &str) -> Result<Value> {
        self.delete(&format!("/v1/projects/{project}/sessions/{id}"))
            .await
    }

    // ─── Read-only helpers behind ARC's inline actions ──────────────────────

    pub async fn diff(&self, project: &str, file: Option<&str>) -> Result<Value> {
        let path = match file {
            Some(f) => format!(
                "/v1/projects/{project}/diff?file={}",
                urlencode(f)
            ),
            None => format!("/v1/projects/{project}/diff"),
        };
        self.get(&path).await
    }

    pub async fn explain(&self, project: &str, base: Option<&str>, staged: bool) -> Result<Value> {
        let mut q = Vec::new();
        if let Some(b) = base {
            q.push(format!("base={}", urlencode(b)));
        }
        if staged {
            q.push("staged=true".into());
        }
        let path = if q.is_empty() {
            format!("/v1/projects/{project}/explain")
        } else {
            format!("/v1/projects/{project}/explain?{}", q.join("&"))
        };
        self.get(&path).await
    }

    pub async fn cost(&self, project: &str, compare: bool) -> Result<Value> {
        let path = if compare {
            format!("/v1/projects/{project}/cost?compare=true")
        } else {
            format!("/v1/projects/{project}/cost")
        };
        self.get(&path).await
    }

    // ─── Streaming ─────────────────────────────────────────────────────────

    /// Run a turn and hand each parsed SSE event to `on_event`.
    ///
    /// `session` continues an existing conversation (the daemon replays its
    /// history); `None` is a one-shot turn with no continuity. Returns once the
    /// stream ends — the caller is expected to spawn this.
    ///
    /// `on_event` receives `(event_name, payload)`. The name is the payload's
    /// own `type` for agent events, so matching on either works.
    pub async fn turn_stream<F>(
        &self,
        project: &str,
        session: Option<&str>,
        prompt: &str,
        model: Option<&str>,
        mode: Option<&str>,
        mut on_event: F,
    ) -> Result<()>
    where
        F: FnMut(String, Value) + Send,
    {
        let path = match session {
            Some(s) => format!("/v1/projects/{project}/sessions/{s}/turns"),
            None => format!("/v1/projects/{project}/turns"),
        };
        let resp = self
            .auth(self.http.post(self.url(&path)))
            .header("Accept", "text/event-stream")
            .json(&json!({ "prompt": prompt, "model": model, "mode": mode }))
            .send()
            .await?;

        // A refused turn (409 session busy, 429 queue full, 403 ceiling) comes
        // back as a normal JSON error, not a stream. Surface it as an error
        // rather than silently yielding zero events.
        if !resp.status().is_success() {
            return Err(Self::json(resp).await.unwrap_err());
        }

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            buf.push_str(&String::from_utf8_lossy(&chunk?));
            // Frames are separated by a blank line. Anything after the last
            // separator is a partial frame and stays buffered.
            while let Some(cut) = find_frame_end(&buf) {
                let (frame, rest) = buf.split_at(cut);
                let frame = frame.to_string();
                buf = rest.trim_start_matches(['\r', '\n']).to_string();
                if let Some((name, data)) = parse_frame(&frame) {
                    on_event(name, data);
                }
            }
        }
        Ok(())
    }

    /// SSE firehose of run transitions across every project — `run.started`,
    /// `run.awaiting_approval`, `run.finished`. This is the same detector the
    /// daemon's outbound push uses, so the stream and a webhook cannot
    /// disagree. ARC uses it to keep the board live without polling.
    pub async fn events_stream<F>(&self, mut on_event: F) -> Result<()>
    where
        F: FnMut(String, Value) + Send,
    {
        let resp = self
            .auth(self.http.get(self.url("/v1/events")))
            .header("Accept", "text/event-stream")
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(Self::json(resp).await.unwrap_err());
        }
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        while let Some(chunk) = stream.next().await {
            buf.push_str(&String::from_utf8_lossy(&chunk?));
            while let Some(cut) = find_frame_end(&buf) {
                let (frame, rest) = buf.split_at(cut);
                let frame = frame.to_string();
                buf = rest.trim_start_matches(['\r', '\n']).to_string();
                if let Some((name, data)) = parse_frame(&frame) {
                    on_event(name, data);
                }
            }
        }
        Ok(())
    }
}

/// The four pilot control verbs, as their route segments.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PilotAction {
    Approve,
    Veto,
    Abort,
    Retry,
}

impl PilotAction {
    fn path(self) -> &'static str {
        match self {
            PilotAction::Approve => "approve",
            PilotAction::Veto => "veto",
            PilotAction::Abort => "abort",
            PilotAction::Retry => "retry",
        }
    }
}

// ─── SSE framing ───────────────────────────────────────────────────────────

/// Byte offset just past the first frame separator in `buf`, or `None` when no
/// complete frame is buffered yet.
///
/// Both separators are checked because the daemon writes `\n\n` but a proxy in
/// front of it may normalise to CRLF.
fn find_frame_end(buf: &str) -> Option<usize> {
    let lf = buf.find("\n\n").map(|i| i + 2);
    let crlf = buf.find("\r\n\r\n").map(|i| i + 4);
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Parse one SSE frame into `(event name, payload)`.
///
/// Returns `None` for keepalive comments and for frames whose data is not
/// JSON — a malformed frame should drop, never kill the stream. `data:` lines
/// are joined per the SSE spec even though Wingman never splits them, so a
/// proxy that re-wraps long lines can't corrupt a payload.
fn parse_frame(frame: &str) -> Option<(String, Value)> {
    let mut name = String::new();
    let mut data = String::new();
    for line in frame.lines() {
        if let Some(rest) = line.strip_prefix("event:") {
            name = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
        // `:` comments (the 15s keepalive) and unknown fields are ignored.
    }
    if data.is_empty() {
        return None;
    }
    let payload: Value = serde_json::from_str(&data).ok()?;
    // Agent events carry their own `type`; prefer it so callers can match one
    // field regardless of which stream the event arrived on.
    let resolved = payload
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or(name);
    Some((resolved, payload))
}

/// Minimal percent-encoding for query values. Only the characters that would
/// actually break a query string — pulling in a URL crate for this would be
/// the wrong trade for two call sites.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_normal_frame() {
        let (name, data) = parse_frame("event: text_delta\ndata: {\"type\":\"text_delta\",\"text\":\"hi\"}\n\n").unwrap();
        assert_eq!(name, "text_delta");
        assert_eq!(data["text"], "hi");
    }

    #[test]
    fn payload_type_wins_over_event_name() {
        // The daemon sets `event:` from the payload's own type, but if the two
        // ever disagree the payload is the authority.
        let (name, _) = parse_frame("event: message\ndata: {\"type\":\"tool_start\"}\n\n").unwrap();
        assert_eq!(name, "tool_start");
    }

    #[test]
    fn falls_back_to_event_name_without_a_type() {
        // The /v1/events firehose sends run.* events with no `type` field.
        let (name, data) =
            parse_frame("event: run.finished\ndata: {\"run_id\":\"r1\"}\n\n").unwrap();
        assert_eq!(name, "run.finished");
        assert_eq!(data["run_id"], "r1");
    }

    #[test]
    fn keepalives_and_junk_are_dropped_not_fatal() {
        assert!(parse_frame(":keepalive\n\n").is_none());
        assert!(parse_frame("event: x\ndata: not json\n\n").is_none());
        assert!(parse_frame("\n\n").is_none());
    }

    #[test]
    fn joins_split_data_lines() {
        let (_, data) = parse_frame("event: x\ndata: {\"a\":\ndata: 1}\n\n").unwrap();
        assert_eq!(data["a"], 1);
    }

    #[test]
    fn frame_boundaries_handle_lf_and_crlf() {
        assert_eq!(find_frame_end("a\n\nb"), Some(3));
        assert_eq!(find_frame_end("a\r\n\r\nb"), Some(5));
        assert_eq!(find_frame_end("no terminator yet"), None);
    }

    #[test]
    fn a_partial_frame_stays_buffered() {
        // The transport splits wherever it likes; a half-arrived frame must not
        // be parsed until its separator shows up.
        let mut buf = String::from("event: text_delta\ndata: {\"text\":\"par");
        assert!(find_frame_end(&buf).is_none());
        buf.push_str("tial\"}\n\n");
        let cut = find_frame_end(&buf).unwrap();
        let (frame, _) = buf.split_at(cut);
        assert_eq!(parse_frame(frame).unwrap().1["text"], "partial");
    }

    #[test]
    fn urlencode_escapes_path_separators_and_spaces() {
        assert_eq!(urlencode("src/a b.rs"), "src%2Fa%20b.rs");
        assert_eq!(urlencode("plain-name_1.rs"), "plain-name_1.rs");
    }

    #[test]
    fn rejects_an_empty_base_url() {
        assert!(Client::new("", None).is_err());
    }

    #[test]
    fn trims_a_trailing_slash_so_paths_do_not_double_up() {
        let c = Client::new("http://127.0.0.1:8787/", None).unwrap();
        assert_eq!(c.url("/v1/health"), "http://127.0.0.1:8787/v1/health");
    }
}
