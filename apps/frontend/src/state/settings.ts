import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  isTauri,
  secretsGetApiKey,
  secretsSetApiKey,
  type LlmProvider,
} from '../lib/tauri';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface Settings {
  activeProvider: LlmProvider;
  providers: Record<LlmProvider, ProviderConfig>;
  systemPrompt: string;
  /** True once hydrateSecrets() has finished — useful for the chat panel
   *  to know it shouldn't prompt "no API key" while keys are still loading. */
  secretsHydrated: boolean;
  setActiveProvider: (id: LlmProvider) => void;
  updateProvider: (id: LlmProvider, patch: Partial<ProviderConfig>) => void;
  setSystemPrompt: (s: string) => void;
  /** Load API keys from the OS credential vault. If the store still has a
   *  non-empty apiKey from the pre-keyring days, migrate it across and then
   *  let `partialize` strip it from localStorage on the next persist. */
  hydrateSecrets: () => Promise<void>;
}

// API keys live in the OS credential vault (Keychain / Credential Manager /
// libsecret). Only model / baseUrl / systemPrompt / activeProvider land in
// localStorage — see the `partialize` below.
const KEY_SAVE_DEBOUNCE_MS = 300;
const keySaveTimers: Partial<Record<LlmProvider, ReturnType<typeof setTimeout>>> = {};

export const useSettings = create<Settings>()(
  persist(
    (set, get) => ({
      activeProvider: 'openai',
      providers: {
        openai: { model: 'gpt-4o-mini', apiKey: '' },
        anthropic: { model: 'claude-sonnet-4-6', apiKey: '' },
        ollama: { model: 'llama3.2:1b', baseUrl: 'http://localhost:11434' },
      },
      systemPrompt:
        'You are ARC, a helpful AI assistant embedded in a terminal. Keep answers tight, prefer code over prose, and assume the user is a developer.',
      secretsHydrated: false,
      setActiveProvider: (id) => set({ activeProvider: id }),
      updateProvider: (id, patch) => {
        set((s) => ({
          providers: { ...s.providers, [id]: { ...s.providers[id], ...patch } },
        }));
        // Debounce keyring writes so a burst of keystrokes collapses to one.
        if (patch.apiKey !== undefined && isTauri) {
          const existing = keySaveTimers[id];
          if (existing) clearTimeout(existing);
          const key = patch.apiKey ?? '';
          keySaveTimers[id] = setTimeout(() => {
            void secretsSetApiKey(id, key).catch((err) =>
              console.error('[settings] keyring write failed:', err),
            );
          }, KEY_SAVE_DEBOUNCE_MS);
        }
      },
      setSystemPrompt: (s) => set({ systemPrompt: s }),
      hydrateSecrets: async () => {
        if (!isTauri) {
          set({ secretsHydrated: true });
          return;
        }
        const providers = get().providers;
        const ids: LlmProvider[] = ['openai', 'anthropic', 'ollama'];

        // One-shot migration: anything sitting in `providers.X.apiKey` came
        // from the legacy localStorage blob. Push it to keyring; the
        // partialize stripper takes care of removing it from LS on the
        // next persist write (which the final set() below triggers).
        for (const id of ids) {
          const legacy = providers[id]?.apiKey;
          if (legacy && legacy.length > 0) {
            try {
              await secretsSetApiKey(id, legacy);
            } catch (err) {
              console.error(`[settings] migrate ${id} → keyring failed:`, err);
            }
          }
        }

        // Now load each provider's key from keyring (which we just wrote
        // for legacy users, and which holds the user's saved key for
        // everyone else).
        const next: Record<LlmProvider, ProviderConfig> = { ...providers };
        for (const id of ids) {
          try {
            const stored = await secretsGetApiKey(id);
            next[id] = { ...providers[id], apiKey: stored ?? '' };
          } catch (err) {
            console.error(`[settings] keyring read ${id} failed:`, err);
            next[id] = { ...providers[id], apiKey: '' };
          }
        }
        set({ providers: next, secretsHydrated: true });
      },
    }),
    {
      name: 'arc-settings',
      version: 2,
      // Strip apiKey before writing to localStorage — keyring owns it now.
      partialize: (state) =>
        ({
          activeProvider: state.activeProvider,
          providers: Object.fromEntries(
            Object.entries(state.providers).map(([id, cfg]) => [
              id,
              { model: cfg.model, baseUrl: cfg.baseUrl },
            ]),
          ),
          systemPrompt: state.systemPrompt,
        }) as Partial<Settings>,
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
