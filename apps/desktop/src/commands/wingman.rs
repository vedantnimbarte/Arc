//! Tauri command surface for the Wingman integration.
//!
//! ARC talks to a `wingman serve` daemon over HTTP/SSE (see `arc-wingman`).
//! The dependency is optional in both directions: with no daemon configured or
//! reachable, `wingman_health` fails fast and the frontend hides every Wingman
//! surface. Nothing else in ARC depends on this module.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("wingman_configure",   { baseUrl, token })       -> ()
//!   invoke("wingman_health")                                -> Health
//!   invoke("wingman_projects")                              -> Project[]
//!   invoke("wingman_board",       { project, archived })    -> Board
//!   invoke("wingman_turn_start",  { ... })                  -> streamId
//!
//! Streaming commands return immediately with a stream id and emit events on
//! `wingman://turn/<id>`; the run firehose emits on `wingman://events`.

use arc_wingman::{Board, Client, Health, PilotAction, Project, RunSummary, SessionInfo};
use parking_lot::RwLock;
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, State};

/// The configured endpoint, if any.
///
/// Held behind an `RwLock` rather than rebuilt per call so `reqwest`'s
/// connection pool survives between commands — SSE streams and the board's
/// polling would otherwise reconnect from scratch every time.
#[derive(Default)]
pub struct WingmanState {
    client: RwLock<Option<Client>>,
    /// Monotonic ids for turn streams, so two concurrent turns never share an
    /// event topic.
    next_stream: AtomicU64,
}

impl WingmanState {
    fn client(&self) -> Result<Client, String> {
        self.client
            .read()
            .clone()
            .ok_or_else(|| "wingman: not configured".to_string())
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Point ARC at a daemon. Called on boot from persisted settings and again
/// whenever the user edits them. Passing an empty `baseUrl` disconnects.
#[tauri::command]
pub async fn wingman_configure(
    state: State<'_, WingmanState>,
    base_url: String,
    token: Option<String>,
) -> Result<(), String> {
    if base_url.trim().is_empty() {
        *state.client.write() = None;
        return Ok(());
    }
    let client = Client::new(base_url, token.filter(|t| !t.trim().is_empty())).map_err(err)?;
    *state.client.write() = Some(client);
    Ok(())
}

/// Probe the daemon. This is the gate for the whole feature, so it is the one
/// command the frontend is expected to call unconditionally and ignore on
/// failure.
#[tauri::command]
pub async fn wingman_health(state: State<'_, WingmanState>) -> Result<Health, String> {
    state.client()?.health().await.map_err(err)
}

#[tauri::command]
pub async fn wingman_projects(state: State<'_, WingmanState>) -> Result<Vec<Project>, String> {
    state.client()?.projects().await.map_err(err)
}

// ─── Board ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn wingman_board(
    state: State<'_, WingmanState>,
    project: Option<String>,
    archived: Option<bool>,
) -> Result<Board, String> {
    state
        .client()?
        .board(project.as_deref(), archived.unwrap_or(false))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn wingman_board_add_card(
    state: State<'_, WingmanState>,
    project: String,
    title: String,
    goal: Option<String>,
) -> Result<Value, String> {
    state
        .client()?
        .board_add_card(&project, &title, goal.as_deref())
        .await
        .map_err(err)
}

/// Start a pilot run for a card. The daemon spawns it detached and returns
/// immediately — progress arrives over `wingman://events` and the board.
#[tauri::command]
pub async fn wingman_board_dispatch(
    state: State<'_, WingmanState>,
    card: String,
    again: Option<bool>,
) -> Result<Value, String> {
    state
        .client()?
        .board_dispatch(&card, again.unwrap_or(false))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn wingman_board_archive(
    state: State<'_, WingmanState>,
    card: String,
    restore: Option<bool>,
) -> Result<Value, String> {
    state
        .client()?
        .board_archive(&card, restore.unwrap_or(false))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn wingman_board_delete_card(
    state: State<'_, WingmanState>,
    card: String,
) -> Result<Value, String> {
    state.client()?.board_delete_card(&card).await.map_err(err)
}

// ─── Pilot ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn wingman_pilot_runs(
    state: State<'_, WingmanState>,
    project: String,
) -> Result<Vec<RunSummary>, String> {
    state.client()?.pilot_runs(&project).await.map_err(err)
}

#[tauri::command]
pub async fn wingman_pilot_run(
    state: State<'_, WingmanState>,
    project: String,
    run: String,
) -> Result<Value, String> {
    state.client()?.pilot_run(&project, &run).await.map_err(err)
}

/// `action` is one of `approve` | `veto` | `abort` | `retry`. `task` narrows
/// abort/retry to a single planner task.
#[tauri::command]
pub async fn wingman_pilot_control(
    state: State<'_, WingmanState>,
    project: String,
    run: String,
    action: String,
    task: Option<String>,
) -> Result<Value, String> {
    let action = match action.as_str() {
        "approve" => PilotAction::Approve,
        "veto" => PilotAction::Veto,
        "abort" => PilotAction::Abort,
        "retry" => PilotAction::Retry,
        other => return Err(format!("wingman: unknown pilot action {other:?}")),
    };
    state
        .client()?
        .pilot_control(&project, &run, action, task.as_deref())
        .await
        .map_err(err)
}

// ─── Sessions ──────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn wingman_sessions(
    state: State<'_, WingmanState>,
    project: String,
) -> Result<Vec<SessionInfo>, String> {
    state.client()?.sessions(&project).await.map_err(err)
}

#[tauri::command]
pub async fn wingman_session_transcript(
    state: State<'_, WingmanState>,
    project: String,
    id: String,
) -> Result<Value, String> {
    state
        .client()?
        .session_transcript(&project, &id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn wingman_create_session(
    state: State<'_, WingmanState>,
    project: String,
    model: Option<String>,
    mode: Option<String>,
) -> Result<String, String> {
    state
        .client()?
        .create_session(&project, model.as_deref(), mode.as_deref())
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn wingman_delete_session(
    state: State<'_, WingmanState>,
    project: String,
    id: String,
) -> Result<Value, String> {
    state
        .client()?
        .delete_session(&project, &id)
        .await
        .map_err(err)
}

// ─── Read-only helpers behind the editor's inline actions ──────────────────

#[tauri::command]
pub async fn wingman_diff(
    state: State<'_, WingmanState>,
    project: String,
    file: Option<String>,
) -> Result<Value, String> {
    state
        .client()?
        .diff(&project, file.as_deref())
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn wingman_explain(
    state: State<'_, WingmanState>,
    project: String,
    base: Option<String>,
    staged: Option<bool>,
) -> Result<Value, String> {
    state
        .client()?
        .explain(&project, base.as_deref(), staged.unwrap_or(false))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn wingman_cost(
    state: State<'_, WingmanState>,
    project: String,
    compare: Option<bool>,
) -> Result<Value, String> {
    state
        .client()?
        .cost(&project, compare.unwrap_or(false))
        .await
        .map_err(err)
}

// ─── Streaming ─────────────────────────────────────────────────────────────

/// Start a turn and stream it.
///
/// Returns a stream id immediately; the turn runs on a spawned task and emits
/// `wingman://turn/<id>` with `{ kind, payload }` per event, then exactly one
/// terminal event — `kind: "done"` on a clean end, `kind: "error"` when the
/// request was refused or the connection dropped. The frontend keys its
/// listener off the returned id and tears down on either.
///
/// The terminal event matters: a turn can be refused with a 409 (this session
/// already has a turn in flight), 429 (queue full) or 403 (permission ceiling),
/// none of which produce any stream at all. Without a guaranteed last event the
/// UI would sit on a spinner forever.
#[tauri::command]
pub async fn wingman_turn_start(
    app: AppHandle,
    state: State<'_, WingmanState>,
    project: String,
    session: Option<String>,
    prompt: String,
    model: Option<String>,
    mode: Option<String>,
) -> Result<String, String> {
    let client = state.client()?;
    let id = state.next_stream.fetch_add(1, Ordering::Relaxed);
    let topic = format!("wingman://turn/{id}");

    let emit_topic = topic.clone();
    tauri::async_runtime::spawn(async move {
        let app2 = app.clone();
        let t2 = emit_topic.clone();
        let result = client
            .turn_stream(
                &project,
                session.as_deref(),
                &prompt,
                model.as_deref(),
                mode.as_deref(),
                move |kind, payload| {
                    let _ = app2.emit(
                        &t2,
                        serde_json::json!({ "kind": kind, "payload": payload }),
                    );
                },
            )
            .await;
        let terminal = match result {
            Ok(()) => serde_json::json!({ "kind": "done", "payload": {} }),
            Err(e) => {
                tracing::warn!("wingman turn stream ended: {e}");
                serde_json::json!({ "kind": "error", "payload": { "message": e.to_string() } })
            }
        };
        let _ = app.emit(&emit_topic, terminal);
    });

    Ok(topic)
}

/// Subscribe to the daemon's cross-project run firehose, emitting each
/// transition on `wingman://events`. Used to keep the board live without
/// polling. Safe to call more than once — a second subscription simply opens a
/// second stream, and the guard below stops the first from being duplicated on
/// every board mount.
#[tauri::command]
pub async fn wingman_events_subscribe(
    app: AppHandle,
    state: State<'_, WingmanState>,
) -> Result<(), String> {
    let client = state.client()?;
    tauri::async_runtime::spawn(async move {
        let app2 = app.clone();
        let result = client
            .events_stream(move |kind, payload| {
                let _ = app2.emit(
                    "wingman://events",
                    serde_json::json!({ "kind": kind, "payload": payload }),
                );
            })
            .await;
        if let Err(e) = result {
            tracing::warn!("wingman event stream ended: {e}");
            let _ = app.emit(
                "wingman://events",
                serde_json::json!({ "kind": "error", "payload": { "message": e.to_string() } }),
            );
        }
    });
    Ok(())
}
