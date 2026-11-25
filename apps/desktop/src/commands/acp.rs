//! Tauri command surface for ACP agents (Gemini CLI, OpenCode, Qwen, …).
//!
//! Mirrors `claude_code.rs` so the frontend drives both with the same session
//! store: a turn starts with a topic, streams `{ kind, payload }` on it, and
//! ends with `done` or `error`. The difference is underneath — an ACP agent is
//! one long-lived process per conversation (see `arc-acp`), so this module
//! keeps a table of live conversations, keyed by the agent's session id, and
//! routes each one's events to the topic of its current turn.
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("acp_providers")                               -> Provider[]
//!   invoke("acp_turn_start", { provider, cwd, content, resume }) -> topic
//!   invoke("acp_turn_cancel", { topic })                  -> ()
//!   invoke("acp_permission_respond", { topic, requestId, allow }) -> ()
//!   invoke("acp_conversation_close", { conversation })    -> ()
//!   invoke("acp_sessions_list", { provider, cwd })        -> session[] | null
//!   invoke("acp_session_load", { provider, cwd, id })     -> { kind, payload }[]
//!
//! `resume` is the `session_id` from `init`; it continues the same live
//! process, or fails when that process is gone. `acp_session_load` reopens an
//! earlier session in a new process and returns its replayed history, after
//! which `resume` with that id continues it.

use arc_acp::{
    list_sessions, providers, run_session, Command, Decision, Event, Provider, SessionOptions,
};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, oneshot};

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

async fn find_provider(id: &str) -> Result<Provider, String> {
    tokio::task::spawn_blocking(providers)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("{id} is not installed"))
}

type Replay = oneshot::Sender<Result<Vec<Value>, String>>;

/// Start an agent process for one conversation, registered under `key` until
/// its `init` names the real session id. Its events go to the conversation's
/// current topic — except while `replay` is set (a load), when they are
/// collected and handed back on `loaded`.
fn spawn_conversation(
    app: AppHandle,
    state: &AcpState,
    key: String,
    opts: SessionOptions,
    topic: String,
    first: Option<Vec<Value>>,
    replay: Option<Replay>,
) {
    let (tx, rx) = mpsc::unbounded_channel();
    if let Some(content) = first {
        let _ = tx.send(Command::Prompt(content));
    }
    let current = Arc::new(Mutex::new(topic));
    state.convs.insert(
        key.clone(),
        Conversation {
            cmds: tx,
            topic: current.clone(),
        },
    );
    let key = Arc::new(Mutex::new(key));

    tauri::async_runtime::spawn(async move {
        let emit = {
            let (app, current, key) = (app.clone(), current.clone(), key.clone());
            let mut replay = replay;
            let mut buf = Vec::new();
            move |ev: Event| {
                if ev.kind == "init" {
                    rekey(
                        &app,
                        &key,
                        ev.payload["session_id"].as_str().unwrap_or_default(),
                    );
                }
                let msg = json!({ "kind": ev.kind, "payload": ev.payload });
                if let Some(tx) = replay.take() {
                    match ev.kind.as_str() {
                        "loaded" => drop(tx.send(Ok(std::mem::take(&mut buf)))),
                        "error" => {
                            let m = ev.payload["message"].as_str().unwrap_or("the agent failed");
                            drop(tx.send(Err(m.to_string())));
                        }
                        _ => {
                            buf.push(msg);
                            replay = Some(tx);
                        }
                    }
                    return;
                }
                let topic = current.lock().unwrap().clone();
                if !topic.is_empty() {
                    let _ = app.emit(&topic, msg);
                }
            }
        };
        if let Err(e) = run_session(opts, rx, emit).await {
            tracing::warn!("acp conversation failed to start: {e:#}");
            let topic = current.lock().unwrap().clone();
            if !topic.is_empty() {
                let _ = app.emit(
                    &topic,
                    json!({ "kind": "error", "payload": { "message": format!("{e:#}") } }),
                );
            }
        }
        if let Some(state) = app.try_state::<AcpState>() {
            state.convs.remove(&*key.lock().unwrap());
        }
    });
}

/// Move a conversation from its provisional key to the agent's session id, so
/// `resume`, history and reopened tabs all use the id the agent knows.
fn rekey(app: &AppHandle, key: &Mutex<String>, sid: &str) {
    let mut k = key.lock().unwrap();
    if sid.is_empty() || *k == sid {
        return;
    }
    if let Some(state) = app.try_state::<AcpState>() {
        if let Some((_, conv)) = state.convs.remove(&*k) {
            state.convs.insert(sid.to_string(), conv);
        }
    }
    *k = sid.to_string();
}

/// Start a turn. Without `resume`, spawns the agent for a new conversation.
#[tauri::command]
pub async fn acp_turn_start(
    app: AppHandle,
    state: State<'_, AcpState>,
    provider: String,
    cwd: String,
    content: Vec<Value>,
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

    let p = find_provider(&provider).await?;
    let key = format!("pending-{}", state.next.fetch_add(1, Ordering::Relaxed));
    let opts = SessionOptions {
        binary: p.path,
        args: p.args,
        cwd,
        load: None,
    };
    spawn_conversation(app, &state, key, opts, topic.clone(), Some(content), None);
    Ok(topic)
}

/// The agent's earlier sessions in `cwd`, or `null` when it can't list them.
#[tauri::command]
pub async fn acp_sessions_list(
    provider: String,
    cwd: String,
) -> Result<Option<Vec<Value>>, String> {
    let p = find_provider(&provider).await?;
    list_sessions(&p.path, &p.args, &cwd)
        .await
        .map_err(|e| format!("{e:#}"))
}

/// Reopen an earlier session in a fresh agent process and return its replayed
/// history. The conversation stays live under `id` for the next turn.
#[tauri::command]
pub async fn acp_session_load(
    app: AppHandle,
    state: State<'_, AcpState>,
    provider: String,
    cwd: String,
    id: String,
) -> Result<Vec<Value>, String> {
    if state.convs.contains_key(&id) {
        return Err("This conversation is already open in another window.".into());
    }
    let p = find_provider(&provider).await?;
    let (tx, rx) = oneshot::channel();
    let opts = SessionOptions {
        binary: p.path,
        args: p.args,
        cwd,
        load: Some(id.clone()),
    };
    spawn_conversation(app, &state, id.clone(), opts, String::new(), None, Some(tx));
    match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Err("the agent exited while reopening the session".into()),
        Err(_) => {
            state.convs.remove(&id);
            Err("the agent didn't reopen the session in time".into())
        }
    }
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
