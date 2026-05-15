//! OpenAI chat completions — SSE streaming via `data: {...}` events.

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ChatRequest, Chunk, Provider, ProviderError, Role};

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
}

#[derive(Serialize)]
struct OpenAiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OpenAiStreamChunk {
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    delta: OpenAiDelta,
    #[serde(default)]
    finish_reason: Option<String>,
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
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        });

        let resp = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
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
                        }));
                    }
                    match serde_json::from_str::<OpenAiStreamChunk>(&data) {
                        Ok(chunk) => {
                            let text = chunk
                                .choices
                                .first()
                                .and_then(|c| c.delta.content.clone())
                                .unwrap_or_default();
                            let done = chunk
                                .choices
                                .first()
                                .and_then(|c| c.finish_reason.as_deref())
                                .is_some();
                            if text.is_empty() && !done {
                                None
                            } else {
                                Some(Ok(Chunk { text, done }))
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
