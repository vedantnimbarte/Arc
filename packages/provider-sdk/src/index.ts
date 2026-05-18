// Provider abstraction. A "provider" wraps any chat-completion endpoint:
// OpenAI, Anthropic, Google, OpenRouter, Ollama, LM Studio, vLLM.
//
// Active implementations are Rust-side in `rust/ai-runtime`. This TS contract
// is kept for any future in-browser fallback or shared typing.

export interface ProviderInfo {
  id: string;
  label: string;
  /** Models supported by this provider, e.g. ["gpt-4o", "gpt-4o-mini"]. */
  models: string[];
  capabilities: {
    streaming: boolean;
    toolCalls: boolean;
    vision: boolean;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** Cancel an in-flight stream. */
  signal?: AbortSignal;
}

export interface ChatChunk {
  delta: string;
  finishReason?: 'stop' | 'length' | 'tool_calls' | null;
}

export interface Provider {
  info: ProviderInfo;
  /** Streaming completion. Yields incremental text chunks. */
  stream(req: ChatRequest): AsyncIterable<ChatChunk>;
}
