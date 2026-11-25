//! Tauri command surface for ACP agents (Gemini CLI, OpenCode, Qwen, …).
//!
//! Mirrors `claude_code.rs` so the frontend drives both with the same session
//! store: a turn starts with a topic, streams `{ kind, payload }` on it, and
//! ends with `done` or `error`. The difference is underneath — an ACP agent is
//! one long-lived process per conversation (see `arc-acp`), so this module
//! keeps a table of live conversations and routes each one's events to the
//! topic of its current turn.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("acp_providers")                               -> Provider[]
//!   invoke("acp_turn_start", { provider, cwd, content, resume }) -> topic
//!   invoke("acp_turn_cancel", { topic })                  -> ()
//!   invoke("acp_permission_respond", { topic, requestId, allow }) -> ()
//!   invoke("acp_conversation_close", { conversation })    -> ()
//!
//! The `session_id` in a conversation's `init` event is ARC's key for it, not
//! the agent's: passing it back as `resume` continues the same live process.

use arc_acp::{providers, run_session, Command, Decision, Provider, SessionOptions};
use dashmap::DashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;

struct Conversation {
    cmds: mpsc::UnboundedSender<Command>,
    /// Topic of the turn in flight; events go wherever this points.
    topic: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct AcpState {
    convs: DashMap<String, Conversation>,
    next: AtomicU64,
}

impl AcpState {
    fn by_topic(&self, topic: &str) -> Option<mpsc::UnboundedSender<Command>> {
        self.convs
            .iter()
            .find(|c| *c.topic.lock().unwrap() == topic)
            .map(|c| c.cmds.clone())
    }
}

/// The ACP-capable agents installed on PATH.
#[tauri::command]
pub async fn acp_providers() -> Result<Vec<Provider>, String> {
    tokio::task::spawn_blocking(providers)
        .await
        .map_err(|e| e.to_string())
}

/// Start a turn. Without `resume`, spawns the agent for a new conversation.
#[tauri::command]
pub async fn acp_turn_start(
    app: AppHandle,
    state: State<'_, AcpState>,
    provider: String,
    cwd: String,
    content: Vec<serde_json::Value>,
    resume: Option<String>,
) -> Result<String, String> {
    if cwd.trim().is_empty() {
        return Err("no workspace folder is open".into());
    }
    if content.is_empty() {
        return Err("empty message".into());
    }
    let topic = format!("acp://turn/{}", state.next.fetch_add(1, Ordering::Relaxed));

    if let Some(key) = resume.filter(|k| !k.is_empty()) {
        let conv = state.convs.get(&key).ok_or(
            "This conversation's agent has exited, so it can't continue. Start a new chat.",
        )?;
        *conv.topic.lock().unwrap() = topic.clone();
        conv.cmds
            .send(Command::Prompt(content))
            .map_err(|_| "the agent has exited")?;
        return Ok(topic);
    }

    let p = tokio::task::spawn_blocking(providers)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == provider)
        .ok_or_else(|| format!("{provider} is not installed"))?;

    let key = format!("acp-{}", state.next.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = mpsc::unbounded_channel();
    let current = Arc::new(Mutex::new(topic.clone()));
    tx.send(Command::Prompt(content)).ok();
    state.convs.insert(
        key.clone(),
        Conversation {
            cmds: tx,
            topic: current.clone(),
        },
    );

    let opts = SessionOptions {
        binary: p.path,
        args: p.args,
        cwd,
    };
    tauri::async_runtime::spawn(async move {
        let emit = {
            let (app, current, key) = (app.clone(), current.clone(), key.clone());
            move |mut ev: arc_acp::Event| {
                // `init` and every `result` carry the agent's own session id;
                // the panel resumes with whatever it last saw, so all of them
                // must name ARC's key instead.
                if ev.payload.get("session_id").is_some() {
                    ev.payload["session_id"] = key.clone().into();
                }
                let topic = current.lock().unwrap().clone();
                let _ = app.emit(
                    &topic,
                    serde_json::json!({ "kind": ev.kind, "payload": ev.payload }),
                );
            }
        };
        if let Err(e) = run_session(opts, rx, emit).await {
            tracing::warn!("acp conversation failed to start: {e:#}");
            let topic = current.lock().unwrap().clone();
            let _ = app.emit(
                &topic,
                serde_json::json!({ "kind": "error", "payload": { "message": format!("{e:#}") } }),
            );
        }
        if let Some(state) = app.try_state::<AcpState>() {
            state.convs.remove(&key);
        }
    });

    Ok(topic)
}

/// Answer a `permission_request`. Unknown topics are a no-op.
#[tauri::command]
pub async fn acp_permission_respond(
    state: State<'_, AcpState>,
    topic: String,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    if let Some(tx) = state.by_topic(&topic) {
        let _ = tx.send(Command::Decide(Decision { request_id, allow }));
    }
    Ok(())
}

/// Stop the running turn. The conversation stays alive for the next one.
#[tauri::command]
pub async fn acp_turn_cancel(state: State<'_, AcpState>, topic: String) -> Result<(), String> {
    if let Some(tx) = state.by_topic(&topic) {
        let _ = tx.send(Command::Cancel);
    }
    Ok(())
}

/// End a conversation and kill its agent. Unknown keys are a no-op.
#[tauri::command]
pub async fn acp_conversation_close(
    state: State<'_, AcpState>,
    conversation: String,
) -> Result<(), String> {
    // Dropping the sender closes the command channel, which kills the child.
    state.convs.remove(&conversation);
    Ok(())
}
