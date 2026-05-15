// Provider abstraction. A "provider" wraps any chat-completion endpoint:
// OpenAI, Anthropic, Google, OpenRouter, Ollama, LM Studio, vLLM.
//
// Implementations live in packages/ai-runtime. This file is the contract.

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
