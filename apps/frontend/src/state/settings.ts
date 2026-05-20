import { create } from 'zustand';
import {
  isTauri,
  secretsGetApiKey,
  secretsSetApiKey,
  sessionSettingsLoad,
  sessionSettingsSave,
  type LlmProvider,
  type PersistedSettings,
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
  /** Path to the shell binary new terminals should spawn. `null` means
   *  "let the Rust side pick the OS default" (COMSPEC on Windows,
   *  `$SHELL` elsewhere — same as the historical behavior). Applies to
   *  newly-opened tabs only; in-flight PTYs aren't restarted. */
  defaultShell: string | null;
  /** True once hydrateSecrets() has finished — useful for the chat panel
   *  to know it shouldn't prompt "no API key" while keys are still loading. */
  secretsHydrated: boolean;
  setActiveProvider: (id: LlmProvider) => void;
  updateProvider: (id: LlmProvider, patch: Partial<ProviderConfig>) => void;
  setSystemPrompt: (s: string) => void;
  setDefaultShell: (shell: string | null) => void;
  /** Load non-secret settings from SQLite (with one-shot localStorage
   *  migration for users upgrading from the legacy persist store). */
  hydrateSettings: () => Promise<void>;
  /** Load API keys from the OS credential vault. If the store still has a
   *  non-empty apiKey from the pre-keyring days, migrate it across. */
  hydrateSecrets: () => Promise<void>;
}

// API keys live in the OS credential vault (Keychain / Credential Manager /
// libsecret). Only model / baseUrl / systemPrompt / activeProvider land in
// SQLite — see sessionSettingsSave / sessionSettingsLoad.
const KEY_SAVE_DEBOUNCE_MS = 300;
const keySaveTimers: Partial<Record<LlmProvider, ReturnType<typeof setTimeout>>> = {};

const DEFAULTS = {
  activeProvider: 'openai' as LlmProvider,
  providers: {
    openai: { model: 'gpt-4o-mini', apiKey: '' },
    anthropic: { model: 'claude-sonnet-4-6', apiKey: '' },
    ollama: { model: 'llama3.2:1b', baseUrl: 'http://localhost:11434' },
  },
  systemPrompt:
    'You are ARC, a helpful AI assistant embedded in a terminal. Keep answers tight, prefer code over prose, and assume the user is a developer.',
  defaultShell: null as string | null,
};

export const useSettings = create<Settings>()((set, get) => ({
  ...DEFAULTS,
  secretsHydrated: false,

  setActiveProvider: (id) => set({ activeProvider: id }),

  updateProvider: (id, patch) => {
    set((s) => ({
      providers: { ...s.providers, [id]: { ...s.providers[id], ...patch } },
    }));
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
  setDefaultShell: (shell) => set({ defaultShell: shell }),

  hydrateSettings: async () => {
    if (!isTauri) return;

    // Try SQLite first.
    try {
      const stored = await sessionSettingsLoad();
      if (stored) {
        set((s) => ({
          activeProvider: stored.activeProvider ?? s.activeProvider,
          systemPrompt: stored.systemPrompt ?? s.systemPrompt,
          defaultShell: stored.defaultShell ?? s.defaultShell,
          providers: mergeProviders(s.providers, stored.providers),
        }));
        return;
      }
    } catch (err) {
      console.error('[settings] SQLite load failed:', err);
    }

    // One-shot migration: if SQLite had nothing, check the old localStorage key.
    try {
      const raw = localStorage.getItem('arc-settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { state?: Partial<PersistedSettings> };
        const legacy = parsed.state ?? {};
        set((s) => ({
          activeProvider: legacy.activeProvider ?? s.activeProvider,
          systemPrompt: legacy.systemPrompt ?? s.systemPrompt,
          defaultShell: legacy.defaultShell ?? s.defaultShell,
          providers: mergeProviders(s.providers, legacy.providers),
        }));
        // Persist to SQLite and remove legacy key.
        const next = useSettings.getState();
        await sessionSettingsSave(toPersistedSettings(next)).catch((err) =>
          console.error('[settings] SQLite migration save failed:', err),
        );
        localStorage.removeItem('arc-settings');
      }
    } catch (err) {
      console.error('[settings] localStorage migration failed:', err);
    }
  },

  hydrateSecrets: async () => {
    if (!isTauri) {
      set({ secretsHydrated: true });
      return;
    }
    const providers = get().providers;
    const ids: LlmProvider[] = ['openai', 'anthropic', 'ollama'];

    // One-shot migration: anything sitting in `providers.X.apiKey` came
    // from the legacy localStorage blob. Push it to keyring.
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

    // Load each provider's key from keyring.
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
}));

// ─── helpers ───────────────────────────────────────────────────────────────

function mergeProviders(
  base: Record<LlmProvider, ProviderConfig>,
  patch?: Partial<Record<LlmProvider, { model?: string; baseUrl?: string }>>,
): Record<LlmProvider, ProviderConfig> {
  if (!patch) return base;
  return Object.fromEntries(
    Object.entries(base).map(([id, cfg]) => {
      const p = patch[id as LlmProvider];
      return [id, { ...cfg, ...(p ? { model: p.model ?? cfg.model, baseUrl: p.baseUrl } : {}) }];
    }),
  ) as Record<LlmProvider, ProviderConfig>;
}

function toPersistedSettings(s: Settings): PersistedSettings {
  return {
    activeProvider: s.activeProvider,
    providers: Object.fromEntries(
      Object.entries(s.providers).map(([id, cfg]) => [
        id,
        { model: cfg.model, baseUrl: cfg.baseUrl },
      ]),
    ) as Record<LlmProvider, { model: string; baseUrl?: string }>,
    systemPrompt: s.systemPrompt,
    defaultShell: s.defaultShell,
  };
}

// Debounce-write non-secret settings to SQLite whenever they change.
let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined;
useSettings.subscribe((state) => {
  if (!isTauri) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    void sessionSettingsSave(toPersistedSettings(state)).catch((err) =>
      console.error('[settings] SQLite save failed:', err),
    );
  }, 500);
});

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
