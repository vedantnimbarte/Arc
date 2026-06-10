//! Ollama `/api/chat` — JSONL streaming (one JSON object per line).
//!
//! Default endpoint is `http://localhost:11434`. No auth.

use async_trait::async_trait;
use futures_util::stream::{self, BoxStream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{ChatRequest, Chunk, ModelInfo, Provider, ProviderError, Role};

const DEFAULT_BASE: &str = "http://localhost:11434";

pub struct OllamaProvider {
    base_url: String,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(base_url: Option<String>) -> Self {
        Self {
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE.to_string()),
            client: reqwest::Client::new(),
        }
    }
}

#[derive(Serialize)]
struct OllamaMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct OllamaChunk {
    #[serde(default)]
    message: Option<OllamaResponseMessage>,
    #[serde(default)]
    done: bool,
}

#[derive(Deserialize)]
struct OllamaResponseMessage {
    #[serde(default)]
    content: String,
}

fn role_str(r: &Role) -> &'static str {
    match r {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

#[async_trait]
impl Provider for OllamaProvider {
    fn id(&self) -> &'static str {
        "ollama"
    }

    async fn stream(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, Result<Chunk, ProviderError>>, ProviderError> {
        let mut messages: Vec<OllamaMessage<'_>> = Vec::with_capacity(req.messages.len() + 1);
        if let Some(sys) = req.system.as_deref() {
            messages.push(OllamaMessage {
                role: "system",
                content: sys,
            });
        }
        for m in &req.messages {
            messages.push(OllamaMessage {
                role: role_str(&m.role),
                content: &m.content,
            });
        }

        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
        });
        if let Some(t) = req.temperature {
            body["options"] = json!({ "temperature": t });
        }

        let resp = self
            .client
            .post(format!("{}/api/chat", self.base_url))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Status { status, body });
        }

        Ok(jsonl_chunks(resp.bytes_stream().boxed()).boxed())
    }
}

/// Read newline-delimited JSON from a byte stream, parsing each line as an
/// [`OllamaChunk`]. The unfold keeps a leftover buffer so chunks split across
/// network packets are reassembled.
fn jsonl_chunks(
    stream: BoxStream<'static, Result<bytes::Bytes, reqwest::Error>>,
) -> BoxStream<'static, Result<Chunk, ProviderError>> {
    stream::unfold(
        (stream, Vec::<u8>::new(), false),
        |(mut s, mut buf, mut finished)| async move {
            loop {
                // Drain any whole line already in the buffer.
                if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let raw: Vec<u8> = buf.drain(..=pos).collect();
                    let trimmed = trim_line(&raw);
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_slice::<OllamaChunk>(trimmed) {
                        Ok(c) => {
                            let text = c.message.map(|m| m.content).unwrap_or_default();
                            if text.is_empty() && !c.done {
                                continue;
                            }
                            return Some((
                                Ok(Chunk {
                                    text,
                                    done: c.done,
                                    ..Default::default()
                                }),
                                (s, buf, finished),
                            ));
                        }
                        Err(e) => {
                            tracing::warn!(error = ?e, "ollama: malformed line");
                            continue;
                        }
                    }
                }
                if finished {
                    return None;
                }
                match s.next().await {
                    Some(Ok(bytes)) => buf.extend_from_slice(&bytes),
                    Some(Err(e)) => {
                        return Some((Err(ProviderError::Http(e)), (s, buf, true)));
                    }
                    None => {
                        finished = true;
                        if buf.is_empty() {
                            return None;
                        }
                        // Push a synthetic newline so the next loop drains the
                        // remainder as a final line.
                        buf.push(b'\n');
                    }
                }
            }
        },
    )
    .boxed()
}

#[derive(Deserialize)]
struct OllamaTagsEnvelope {
    #[serde(default)]
    models: Vec<OllamaTagRow>,
}

#[derive(Deserialize)]
struct OllamaTagRow {
    name: String,
}

pub async fn list_models(base_url: Option<String>) -> Result<Vec<ModelInfo>, ProviderError> {
    let base = base_url.unwrap_or_else(|| DEFAULT_BASE.to_string());
    let url = format!("{}/api/tags", base.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderError::Status { status, body });
    }
    let env: OllamaTagsEnvelope = resp.json().await.map_err(ProviderError::Http)?;
    Ok(env
        .models
        .into_iter()
        .map(|m| ModelInfo {
            id: m.name,
            label: None,
            context_window: None,
            kind: None,
        })
        .collect())
}

fn trim_line(raw: &[u8]) -> &[u8] {
    let end = raw.len().saturating_sub(1); // strip trailing \n
    let mut slice = &raw[..end];
    if slice.last() == Some(&b'\r') {
        slice = &slice[..slice.len() - 1];
    }
    slice
}
