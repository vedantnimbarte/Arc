//! Tauri command surface for [`arc_ai_runtime`].
//!
//! Frontend contract (see apps/frontend/src/lib/tauri.ts):
//!   invoke("llm_stream", { req })   -> ()  (returns immediately, chunks via events)
//!   invoke("llm_cancel", { id })    -> ()
//!
//! Emitted events:
//!   "llm://chunk/<id>" -> { text: string, done: boolean }
//!   "llm://done/<id>"  -> { ok?: true, cancelled?: true, error?: string }

use std::sync::Arc;

use arc_ai_runtime::{ChatRequest, Message, Role};
use dashmap::DashMap;
use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Notify;

#[derive(Default, Clone)]
pub struct LlmState {
    pub cancels: Arc<DashMap<String, Arc<Notify>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum WireRole {
    System,
    User,
    Assistant,
}

impl From<WireRole> for Role {
    fn from(r: WireRole) -> Self {
        match r {
            WireRole::System => Role::System,
            WireRole::User => Role::User,
            WireRole::Assistant => Role::Assistant,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct WireMessage {
    role: WireRole,
    content: String,
}

#[derive(Debug, Deserialize)]
pub struct LlmStreamReq {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub messages: Vec<WireMessage>,
    #[serde(default)]
    pub system: Option<String>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

#[tauri::command]
pub async fn llm_stream(
    app: AppHandle,
    state: State<'_, LlmState>,
    req: LlmStreamReq,
) -> Result<(), String> {
    let provider =
        arc_ai_runtime::provider(&req.provider, req.api_key, req.base_url).map_err(|e| e.to_string())?;

    let chat_req = ChatRequest {
        model: req.model,
        messages: req
            .messages
            .into_iter()
            .map(|m| Message {
                role: m.role.into(),
                content: m.content,
            })
            .collect(),
        temperature: req.temperature,
        max_tokens: req.max_tokens,
        system: req.system,
    };

    let mut stream = provider.stream(chat_req).await.map_err(|e| e.to_string())?;

    let cancel = Arc::new(Notify::new());
    state.cancels.insert(req.id.clone(), cancel.clone());

    let cancels = state.cancels.clone();
    let request_id = req.id.clone();
    let chunk_topic = format!("llm://chunk/{}", request_id);
    let done_topic = format!("llm://done/{}", request_id);

    tokio::spawn(async move {
        let mut finished = false;
        loop {
            tokio::select! {
                _ = cancel.notified() => {
                    let _ = app.emit(&done_topic, serde_json::json!({ "cancelled": true }));
                    break;
                }
                next = stream.next() => {
                    match next {
                        Some(Ok(chunk)) => {
                            let is_done = chunk.done;
                            let _ = app.emit(&chunk_topic, &chunk);
                            if is_done {
                                let _ = app.emit(&done_topic, serde_json::json!({ "ok": true }));
                                finished = true;
                                break;
                            }
                        }
                        Some(Err(e)) => {
                            let _ = app.emit(&done_topic, serde_json::json!({ "error": e.to_string() }));
                            break;
                        }
                        None => {
                            let _ = app.emit(&done_topic, serde_json::json!({ "ok": true }));
                            finished = true;
                            break;
                        }
                    }
                }
            }
        }
        cancels.remove(&request_id);
        let _ = finished;
    });

    Ok(())
}

#[tauri::command]
pub async fn llm_cancel(state: State<'_, LlmState>, id: String) -> Result<(), String> {
    if let Some((_, notify)) = state.cancels.remove(&id) {
        notify.notify_waiters();
    }
    Ok(())
}
