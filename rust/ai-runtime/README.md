# arc-ai-runtime — LLM Provider Integration

Streaming chat API abstraction for OpenAI, Anthropic, and Ollama.

## What It Does

- **Provider abstraction:** Single interface for OpenAI, Anthropic, Ollama
- **Streaming:** Token-by-token streaming via server-sent events
- **Embeddings:** Vector embeddings for semantic search
- **Message formatting:** Converts internal message format to provider-specific format

## Key Types

- `Provider` — Trait for implementing LLM providers
- `ChatRequest` — Chat completion request (model, messages, system prompt)
- `ChatChunk` — Streamed token from the provider
- `Embedding` — Vector representation of text

## Supported Providers

| Provider | Model | Endpoint | Notes |
|----------|-------|----------|-------|
| OpenAI | gpt-4o-mini | api.openai.com | Requires API key |
| Anthropic | claude-sonnet-4-6 | api.anthropic.com | Recommended |
| Ollama | llama3.2:1b | localhost:11434 | Local, no key needed |

## Key Functions

```rust
pub trait Provider {
    async fn stream_chat(&self, req: ChatRequest) -> Result<mpsc::Receiver<ChatChunk>>;
    async fn embed(&self, text: &str) -> Result<Vec<f32>>;
}
```

## Configuration

```rust
let provider = AnthropicProvider::new(
    api_key: "sk-ant-...",
    model: "claude-sonnet-4-6".to_string(),
);

let chunks = provider.stream_chat(ChatRequest {
    messages: vec![ChatMessage { role: "user", content: "Hello" }],
    ..Default::default()
}).await?;
```

## Performance Notes

- Streaming uses `eventsource-stream` for efficient SSE parsing
- Tokens are yielded in real-time (no buffering)
- Embedding calls are synchronous and may block briefly

## See Also

- `packages/provider-sdk/` — TypeScript type contract
- `apps/desktop/src/commands/llm.rs` — Tauri command layer
- `apps/frontend/src/components/ChatPanel.tsx` — Chat UI
