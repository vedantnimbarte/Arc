// AI runtime: registers providers, routes requests, manages fallback.
//
// Phase 1: stub provider that echoes back the prompt token by token (used by
// the frontend chat panel).
// Phase 2: real OpenAI / Anthropic / Ollama providers.

import type { Provider, ChatRequest, ChatChunk } from '@arc/provider-sdk';

class StubProvider implements Provider {
  info = {
    id: 'stub',
    label: 'Stub (echo)',
    models: ['stub-1'],
    capabilities: { streaming: true, toolCalls: false, vision: false },
  };

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const last = req.messages[req.messages.length - 1]?.content ?? '';
    const reply = `(stub) you said: "${last}".`;
    for (const word of reply.split(' ')) {
      await new Promise((r) => setTimeout(r, 25));
      yield { delta: word + ' ' };
    }
    yield { delta: '', finishReason: 'stop' };
  }
}

const providers = new Map<string, Provider>();
providers.set('stub', new StubProvider());

export function registerProvider(p: Provider): void {
  providers.set(p.info.id, p);
}

export function getProvider(id: string): Provider | undefined {
  return providers.get(id);
}

export function listProviders(): Provider[] {
  return [...providers.values()];
}
