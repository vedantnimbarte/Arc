//! Anthropic Messages API — SSE streaming. We only forward
//! `content_block_delta` events with `text_delta` payloads.

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ChatRequest, Chunk, Provider, ProviderError, Role};

const DEFAULT_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
}

impl AnthropicProvider {
    pub fn new(api_key: String, base_url: Option<String>) -> Self {
        Self {
            api_key,
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE.to_string()),
            client: reqwest::Client::new(),
        }
    }
}

#[derive(Serialize)]
struct AnthropicMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum AnthropicEvent {
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { delta: AnthropicDelta },
    #[serde(rename = "message_stop")]
    MessageStop,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum AnthropicDelta {
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(other)]
    Other,
}

fn role_str(r: &Role) -> &'static str {
    match r {
        // Anthropic only accepts user/assistant in `messages`; `system` is a
        // separate top-level field. We coerce stray system messages → user
        // turns at the boundary.
        Role::System | Role::User => "user",
        Role::Assistant => "assistant",
    }
}

#[async_trait]
impl Provider for AnthropicProvider {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    async fn stream(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, Result<Chunk, ProviderError>>, ProviderError> {
        let messages: Vec<AnthropicMessage<'_>> = req
            .messages
            .iter()
            .map(|m| AnthropicMessage {
                role: role_str(&m.role),
                content: &m.content,
            })
            .collect();

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "max_tokens": req.max_tokens.unwrap_or(1024),
        });
        if let Some(sys) = req.system.as_deref() {
            body["system"] = json!(sys);
        }
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }

        let resp = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
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
                Ok(ev) => match serde_json::from_str::<AnthropicEvent>(&ev.data) {
                    Ok(AnthropicEvent::ContentBlockDelta {
                        delta: AnthropicDelta::Text { text },
                    }) => Some(Ok(Chunk { text, done: false })),
                    Ok(AnthropicEvent::MessageStop) => Some(Ok(Chunk {
                        text: String::new(),
                        done: true,
                    })),
                    Ok(_) => None,
                    Err(e) => {
                        tracing::warn!(error = ?e, data = %ev.data, "anthropic: malformed event");
                        None
                    }
                },
            }
        });

        Ok(stream.boxed())
    }
}
