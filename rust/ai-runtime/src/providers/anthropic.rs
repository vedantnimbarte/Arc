//! Anthropic Messages API — SSE streaming. We only forward
//! `content_block_delta` events with `text_delta` payloads.

use async_trait::async_trait;
use eventsource_stream::Eventsource;
use futures_util::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ChatRequest, Chunk, ModelInfo, Provider, ProviderError, Role};

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
    #[serde(rename = "message_start")]
    MessageStart { message: AnthropicStartMessage },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { delta: AnthropicDelta },
    #[serde(rename = "message_delta")]
    MessageDelta {
        #[serde(default)]
        usage: Option<AnthropicUsage>,
    },
    #[serde(rename = "message_stop")]
    MessageStop,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct AnthropicStartMessage {
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

/// Token usage. `message_start` carries `input_tokens` (and an initial
/// `output_tokens`); each `message_delta` carries the running `output_tokens`
/// total. Both are cumulative, not per-event deltas.
#[derive(Deserialize)]
struct AnthropicUsage {
    #[serde(default)]
    input_tokens: Option<u32>,
    #[serde(default)]
    output_tokens: Option<u32>,
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
                    }) => Some(Ok(Chunk {
                        text,
                        done: false,
                        ..Default::default()
                    })),
                    // Input token count (and a seed output count) arrive here.
                    Ok(AnthropicEvent::MessageStart { message }) => {
                        let u = message.usage?;
                        Some(Ok(Chunk {
                            text: String::new(),
                            done: false,
                            input_tokens: u.input_tokens,
                            output_tokens: u.output_tokens,
                        }))
                    }
                    // Running output total — the last one before message_stop
                    // is the final completion token count.
                    Ok(AnthropicEvent::MessageDelta { usage }) => {
                        let u = usage?;
                        Some(Ok(Chunk {
                            text: String::new(),
                            done: false,
                            output_tokens: u.output_tokens,
                            ..Default::default()
                        }))
                    }
                    Ok(AnthropicEvent::MessageStop) => Some(Ok(Chunk {
                        text: String::new(),
                        done: true,
                        ..Default::default()
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

#[derive(Deserialize)]
struct AnthropicModelsEnvelope {
    #[serde(default)]
    data: Vec<AnthropicModelRow>,
}

#[derive(Deserialize)]
struct AnthropicModelRow {
    id: String,
    #[serde(default)]
    display_name: Option<String>,
}

pub async fn list_models(
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<ModelInfo>, ProviderError> {
    let base = base_url.unwrap_or_else(|| DEFAULT_BASE.to_string());
    let url = format!("{}/v1/models?limit=1000", base.trim_end_matches('/'));
    let key = api_key.ok_or(ProviderError::MissingKey)?;
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("x-api-key", &key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderError::Status { status, body });
    }
    let env: AnthropicModelsEnvelope = resp.json().await.map_err(ProviderError::Http)?;
    Ok(env
        .data
        .into_iter()
        .map(|m| ModelInfo {
            label: m.display_name,
            id: m.id,
            context_window: None,
            kind: None,
        })
        .collect())
}
