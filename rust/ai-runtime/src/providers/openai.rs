//! OpenAI chat completions — SSE streaming via `data: {...}` events.

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ChatRequest, Chunk, ModelInfo, Provider, ProviderError, Role};

const DEFAULT_BASE: &str = "https://api.openai.com";

pub struct OpenAiProvider {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(api_key: String, base_url: Option<String>) -> Self {
        Self {
            api_key,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE.to_string()),
            client: reqwest::Client::new(),
        }
    }

    /// Resolve the chat-completions URL from a user-supplied base.
    ///
    /// Users hand us bases in three shapes:
    ///   `https://api.openai.com`                   → host only, append /v1/chat/completions
    ///   `https://api.openai.com/v1`                → has a path, append /chat/completions
    ///   `https://api.openai.com/v1/chat/completions` → already the endpoint, use as-is
    ///
    /// The path-aware case is what lets non-standard OpenAI-compatible
    /// endpoints work — notably Gemini's `/v1beta/openai/...` route.
    fn chat_endpoint(&self) -> String {
        let trimmed = self.base_url.trim_end_matches('/');
        if trimmed.ends_with("/chat/completions") {
            return trimmed.to_string();
        }
        // Anything after the host (i.e. with a path) gets `/chat/completions`
        // appended. A bare scheme://host[:port] gets the conventional
        // `/v1/chat/completions`.
        let has_path = match trimmed.find("://") {
            Some(i) => trimmed[i + 3..].contains('/'),
            None => trimmed.contains('/'),
        };
        if has_path {
            format!("{trimmed}/chat/completions")
        } else {
            format!("{trimmed}/v1/chat/completions")
        }
    }
}

#[derive(Serialize)]
struct OpenAiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OpenAiStreamChunk {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
    /// Present only on the trailing usage chunk (requires
    /// `stream_options.include_usage`). Its `choices` array is empty.
    #[serde(default)]
    usage: Option<OpenAiUsage>,
}

#[derive(Deserialize)]
struct OpenAiUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    delta: OpenAiDelta,
}

#[derive(Deserialize)]
struct OpenAiDelta {
    #[serde(default)]
    content: Option<String>,
}

fn role_str(r: &Role) -> &'static str {
    match r {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

#[async_trait]
impl Provider for OpenAiProvider {
    fn id(&self) -> &'static str {
        "openai"
    }

    async fn stream(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, Result<Chunk, ProviderError>>, ProviderError> {
        // Project ARC's Message into OpenAI's role/content schema, prepending
        // a system message if the request carried one.
        let mut messages: Vec<OpenAiMessage<'_>> = Vec::with_capacity(req.messages.len() + 1);
        if let Some(sys) = req.system.as_deref() {
            messages.push(OpenAiMessage {
                role: "system",
                content: sys,
            });
        }
        for m in &req.messages {
            messages.push(OpenAiMessage {
                role: role_str(&m.role),
                content: &m.content,
            });
        }

        let body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            // Ask for a trailing usage chunk so we can report token counts.
            // OpenAI-compatible servers that don't support this simply omit
            // the extra chunk; everything else still works.
            "stream_options": { "include_usage": true },
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        });

        let resp = self
            .client
            .post(self.chat_endpoint())
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Status { status, body });
        }

        let events = resp.bytes_stream().eventsource();

        let stream = events.filter_map(|item| async move {
            match item {
                Err(e) => Some(Err(ProviderError::Stream(e.to_string()))),
                Ok(ev) => {
                    let data = ev.data;
                    if data == "[DONE]" {
                        return Some(Ok(Chunk {
                            text: String::new(),
                            done: true,
                            ..Default::default()
                        }));
                    }
                    match serde_json::from_str::<OpenAiStreamChunk>(&data) {
                        Ok(chunk) => {
                            // The trailing usage chunk has empty `choices` and a
                            // populated `usage`. Forward it as a non-done chunk
                            // (done is driven by `[DONE]` / stream end) so the
                            // event loop doesn't break before it arrives.
                            if let Some(u) = chunk.usage {
                                return Some(Ok(Chunk {
                                    text: String::new(),
                                    done: false,
                                    input_tokens: u.prompt_tokens,
                                    output_tokens: u.completion_tokens,
                                }));
                            }
                            let text = chunk
                                .choices
                                .first()
                                .and_then(|c| c.delta.content.clone())
                                .unwrap_or_default();
                            // `finish_reason` no longer drives `done`: with
                            // include_usage the usage chunk arrives *after* it,
                            // and `[DONE]` (or stream end) is the real terminator.
                            if text.is_empty() {
                                None
                            } else {
                                Some(Ok(Chunk {
                                    text,
                                    done: false,
                                    ..Default::default()
                                }))
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = ?e, data, "openai: malformed chunk");
                            None
                        }
                    }
                }
            }
        });

        Ok(stream.boxed())
    }
}

#[derive(Deserialize)]
struct ModelsEnvelope {
    #[serde(default)]
    data: Vec<ModelRow>,
}

#[derive(Deserialize)]
struct ModelRow {
    id: String,
}

/// Compute the `/models` URL from a user-supplied base. Mirrors the path
/// awareness in `chat_endpoint`: a base with an existing path gets
/// `/models` appended; a bare host gets `/v1/models`.
fn models_endpoint(base: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        // User pasted the full chat endpoint — strip it and re-anchor.
        let head = trimmed.trim_end_matches("/chat/completions");
        return format!("{head}/models");
    }
    let has_path = match trimmed.find("://") {
        Some(i) => trimmed[i + 3..].contains('/'),
        None => trimmed.contains('/'),
    };
    if has_path {
        format!("{trimmed}/models")
    } else {
        format!("{trimmed}/v1/models")
    }
}

pub async fn list_models(
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<ModelInfo>, ProviderError> {
    let base = base_url.unwrap_or_else(|| DEFAULT_BASE.to_string());
    let url = models_endpoint(&base);
    let client = reqwest::Client::new();
    let mut req = client.get(&url);
    if let Some(k) = api_key {
        if !k.is_empty() {
            req = req.bearer_auth(k);
        }
    }
    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderError::Status { status, body });
    }
    let env: ModelsEnvelope = resp.json().await.map_err(ProviderError::Http)?;
    Ok(env
        .data
        .into_iter()
        .map(|m| ModelInfo {
            id: m.id,
            label: None,
            context_window: None,
            kind: None,
        })
        .collect())
}
