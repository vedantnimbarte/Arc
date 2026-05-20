//! arc-ai-runtime — streaming chat completions across multiple providers.
//!
//! Each provider implements [`Provider`] and yields [`Chunk`]s through an
//! async stream. The desktop crate fans those chunks out to Tauri events.
//!
//! See `docs/architecture.md` for the IPC contract.

pub mod embed;
pub mod providers;

pub use embed::{embed, EmbedProvider, EmbedResult};

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};

pub use providers::{
    anthropic::AnthropicProvider, local_cli::LocalCliProvider, ollama::OllamaProvider,
    openai::OpenAiProvider,
};

/// Standardised role across providers. Map provider-specific role names at
/// the boundary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f32>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub system: Option<String>,
}

/// One delta from the provider. `text` is the incremental content; `done`
/// indicates the final chunk.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Chunk {
    pub text: String,
    pub done: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("provider returned status {status}: {body}")]
    Status { status: u16, body: String },
    #[error("malformed stream: {0}")]
    Stream(String),
    #[error("missing api key")]
    MissingKey,
    #[error("{0}")]
    Other(String),
}

/// Async, streaming chat completion contract.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Stable id used for routing (`"openai"`, `"anthropic"`, `"ollama"`).
    fn id(&self) -> &'static str;

    async fn stream(
        &self,
        req: ChatRequest,
    ) -> Result<BoxStream<'static, Result<Chunk, ProviderError>>, ProviderError>;
}

/// Build a provider by id with the given API key and (for Ollama) base URL.
pub fn provider(
    id: &str,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Box<dyn Provider>, ProviderError> {
    match id {
        "openai" => Ok(Box::new(OpenAiProvider::new(
            api_key.ok_or(ProviderError::MissingKey)?,
            base_url,
        ))),
        "anthropic" => Ok(Box::new(AnthropicProvider::new(
            api_key.ok_or(ProviderError::MissingKey)?,
            base_url,
        ))),
        "ollama" => Ok(Box::new(OllamaProvider::new(base_url))),
        // `base_url` doubles as the optional explicit binary path for local
        // CLI providers — the settings UI surfaces it as "Custom binary path".
        "claude-cli" | "codex-cli" | "opencode-cli" => {
            Ok(Box::new(LocalCliProvider::new(id, base_url)?))
        }
        other => Err(ProviderError::Other(format!("unknown provider: {other}"))),
    }
}
