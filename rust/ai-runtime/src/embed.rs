//! Text-embedding helper used by the memory subsystem.
//!
//! Anthropic doesn't ship an embeddings API (they recommend Voyage AI),
//! so we support OpenAI (`text-embedding-3-small` / `text-embedding-3-large`)
//! and Ollama (any model exposed by `/api/embeddings`, e.g.
//! `nomic-embed-text`). The shape stays minimal — one function that
//! returns a `Vec<f32>` and the model id so callers can dedupe by
//! `(model, dim)` when stored.

use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use crate::ProviderError;

#[derive(Debug, Clone)]
pub struct EmbedResult {
    pub model: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedProvider {
    OpenAi,
    Ollama,
}

impl EmbedProvider {
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "openai" => Some(Self::OpenAi),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }
}

/// Embed `text` using the named provider/model. `api_key` is required for
/// OpenAI; `base_url` overrides the default endpoint (useful for OpenAI-
/// compatible proxies or a non-default Ollama host).
pub async fn embed(
    provider: EmbedProvider,
    model: &str,
    text: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<EmbedResult, ProviderError> {
    let client = Client::new();
    match provider {
        EmbedProvider::OpenAi => embed_openai(&client, model, text, api_key, base_url).await,
        EmbedProvider::Ollama => embed_ollama(&client, model, text, base_url).await,
    }
}

async fn embed_openai(
    client: &Client,
    model: &str,
    text: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<EmbedResult, ProviderError> {
    let key = api_key.ok_or(ProviderError::MissingKey)?;
    let base = base_url.unwrap_or("https://api.openai.com");
    let url = format!("{}/v1/embeddings", base.trim_end_matches('/'));

    let body = json!({
        "input": text,
        "model": model,
    });

    let resp = client
        .post(&url)
        .bearer_auth(key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderError::Status { status, body });
    }
    #[derive(Deserialize)]
    struct R {
        data: Vec<RData>,
        #[serde(default)]
        model: Option<String>,
    }
    #[derive(Deserialize)]
    struct RData {
        embedding: Vec<f32>,
    }
    let parsed: R = resp.json().await?;
    let vector = parsed
        .data
        .into_iter()
        .next()
        .map(|d| d.embedding)
        .ok_or_else(|| ProviderError::Other("openai: empty data[]".into()))?;
    Ok(EmbedResult {
        model: parsed.model.unwrap_or_else(|| model.to_string()),
        vector,
    })
}

async fn embed_ollama(
    client: &Client,
    model: &str,
    text: &str,
    base_url: Option<&str>,
) -> Result<EmbedResult, ProviderError> {
    let base = base_url.unwrap_or("http://localhost:11434");
    let url = format!("{}/api/embeddings", base.trim_end_matches('/'));

    let body = json!({
        "model": model,
        "prompt": text,
    });
    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        return Err(ProviderError::Status { status, body });
    }
    #[derive(Deserialize)]
    struct R {
        embedding: Vec<f32>,
    }
    let parsed: R = resp.json().await?;
    Ok(EmbedResult {
        model: model.to_string(),
        vector: parsed.embedding,
    })
}
