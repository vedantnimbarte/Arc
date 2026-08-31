//! Tauri command surface for the Claude Code integration.
//!
//! Where Wingman is a daemon ARC connects to, Claude Code is a binary ARC
//! spawns — one child process per turn, reading its `stream-json` output (see
//! `arc-claude-code`). There is nothing to configure and nothing to connect:
//! if `claude` is on PATH the panel works, and if it isn't the frontend hides
//! the surface. Nothing else in ARC depends on this module.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("claude_available")                          -> string | null
//!   invoke("claude_turn_start", { ... })                -> topic
//!   invoke("claude_turn_cancel", { topic })             -> ()
//!   invoke("claude_permission_respond", { ... })        -> ()
//!
//! `claude_turn_start` returns immediately with a topic and emits
//! `{ kind, payload }` on it per event, then exactly one terminal event —
//! `done` on a clean end, `error` when the child could not run at all.
//!
//! A turn can pause on a `permission_request` event and stay paused until
//! `claude_permission_respond` answers it, so the two commands are halves of
//! one conversation rather than independent calls.

use arc_claude_code::{run_turn, Decision, TurnOptions};
use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};

/// Per-turn back-channels, keyed by topic.
#[derive(Default)]
pub struct ClaudeState {
    /// Kill switch behind the panel's stop button.
    cancels: DashMap<String, oneshot::Sender<()>>,
    /// Where approve/deny answers go. Separate from `cancels` because a turn
    /// can take many decisions and exactly one cancellation.
    decisions: DashMap<String, mpsc::UnboundedSender<Decision>>,
    next_stream: AtomicU64,
}

impl ClaudeState {
    /// Drop both channels for a finished turn. Idempotent — a cancelled turn
    /// reaches this by two paths.
    fn forget(&self, topic: &str) {
        self.cancels.remove(topic);
        self.decisions.remove(topic);
    }
}

/// Resolve the Claude Code binary. `None` means "not installed" — the gate for
/// the whole feature, and the one command the frontend calls unconditionally.
#[tauri::command]
pub async fn claude_available() -> Result<Option<String>, String> {
    Ok(arc_claude_code::binary())
}

/// Start a turn and stream it.
///
/// `resume` continues a prior conversation by its `session_id`; omitting it
/// starts a fresh one. The child runs in `cwd`, which is what bounds Claude's
/// file access, so the frontend passes the workspace root rather than letting
/// the CLI infer one.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn claude_turn_start(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    cwd: String,
    prompt: String,
    resume: Option<String>,
    model: Option<String>,
    permission_mode: Option<String>,
    max_budget_usd: Option<f64>,
) -> Result<String, String> {
    if cwd.trim().is_empty() {
        return Err("claude: no workspace folder is open".into());
    }

    let id = state.next_stream.fetch_add(1, Ordering::Relaxed);
    let topic = format!("claude://turn/{id}");

    let (cancel_tx, cancel_rx) = oneshot::channel();
    let (decision_tx, decision_rx) = mpsc::unbounded_channel();
    state.cancels.insert(topic.clone(), cancel_tx);
    state.decisions.insert(topic.clone(), decision_tx);

    let opts = TurnOptions {
        cwd,
        prompt,
        resume,
        model,
        permission_mode,
        max_budget_usd,
        binary: None,
    };

    let emit_topic = topic.clone();
    tauri::async_runtime::spawn(async move {
        let app2 = app.clone();
        let t2 = emit_topic.clone();
        let result = run_turn(opts, cancel_rx, decision_rx, move |ev| {
            let _ = app2.emit(
                &t2,
                serde_json::json!({ "kind": ev.kind, "payload": ev.payload }),
            );
        })
        .await;

        // A guaranteed last event: a child that fails to spawn produces no
        // stream at all, and without this the composer would sit on a spinner.
        let terminal = match result {
            Ok(()) => serde_json::json!({ "kind": "done", "payload": {} }),
            Err(e) => {
                tracing::warn!("claude turn ended: {e:#}");
                serde_json::json!({ "kind": "error", "payload": { "message": format!("{e:#}") } })
            }
        };
        let _ = app.emit(&emit_topic, terminal);

        if let Some(state) = app.try_state::<ClaudeState>() {
            state.forget(&emit_topic);
        }
    });

    Ok(topic)
}

/// Answer a `permission_request`. `message` is shown to Claude on a denial so
/// it can adapt instead of retrying the same call.
///
/// Unknown topics are a no-op: the turn may have been cancelled between the
/// prompt appearing and the user answering it.
#[tauri::command]
pub async fn claude_permission_respond(
    state: State<'_, ClaudeState>,
    topic: String,
    request_id: String,
    allow: bool,
    message: Option<String>,
) -> Result<(), String> {
    if let Some(tx) = state.decisions.get(&topic) {
        let _ = tx.send(Decision {
            request_id,
            allow,
            message: message.filter(|m| !m.trim().is_empty()),
        });
    }
    Ok(())
}

/// Kill a running turn. Unknown topics are a no-op — the turn may have just
/// finished on its own. This is also the escape hatch from a permission prompt
/// the user would rather not answer either way.
#[tauri::command]
pub async fn claude_turn_cancel(
    state: State<'_, ClaudeState>,
    topic: String,
) -> Result<(), String> {
    if let Some((_, tx)) = state.cancels.remove(&topic) {
        let _ = tx.send(());
    }
    Ok(())
}
