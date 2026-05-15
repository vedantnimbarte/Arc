import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LlmProvider } from '../lib/tauri';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface Settings {
  activeProvider: LlmProvider;
  providers: Record<LlmProvider, ProviderConfig>;
  systemPrompt: string;
  setActiveProvider: (id: LlmProvider) => void;
  updateProvider: (id: LlmProvider, patch: Partial<ProviderConfig>) => void;
  setSystemPrompt: (s: string) => void;
}

// NOTE on storage: API keys live in localStorage today. That's fine for an
// MVP single-user desktop app, but we'll promote them into the OS credential
// vault (keyring crate, Rust side) before any public release. See ADR-009
// when written.
export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      activeProvider: 'openai',
      providers: {
        openai: { model: 'gpt-4o-mini', apiKey: '' },
        anthropic: { model: 'claude-sonnet-4-6', apiKey: '' },
        ollama: { model: 'llama3.2:1b', baseUrl: 'http://localhost:11434' },
      },
      systemPrompt:
        'You are ARC, a helpful AI assistant embedded in a terminal. Keep answers tight, prefer code over prose, and assume the user is a developer.',
      setActiveProvider: (id) => set({ activeProvider: id }),
      updateProvider: (id, patch) =>
        set((s) => ({
          providers: { ...s.providers, [id]: { ...s.providers[id], ...patch } },
        })),
      setSystemPrompt: (s) => set({ systemPrompt: s }),
    }),
    {
      name: 'arc-settings',
      version: 1,
    },
  ),
);

export const PROVIDER_LABELS: Record<LlmProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
};

export const PROVIDER_MODELS: Record<LlmProvider, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ],
  ollama: [], // free text
};
