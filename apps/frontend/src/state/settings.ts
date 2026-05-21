import { create } from 'zustand';
import {
  isTauri,
  secretsGetApiKey,
  secretsSetApiKey,
  sessionSettingsLoad,
  sessionSettingsSave,
  settingsBroadcastChanged,
  type LlmProvider,
  type PersistedSettings,
} from '../lib/tauri';
import {
  applyTheme,
  DEFAULT_APPEARANCE,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  onSystemAppearanceChange,
  resolveTheme,
  type Appearance,
} from '../themes';

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
  /** User's appearance preference. `'system'` follows the OS color scheme. */
  appearance: Appearance;
  /** Mono font id from `FONT_OPTIONS`. */
  fontId: string;
  /** Terminal / editor font size in px. */
  fontSize: number;
  /** True once hydrateSecrets() has finished — useful for the chat panel
   *  to know it shouldn't prompt "no API key" while keys are still loading. */
  secretsHydrated: boolean;
  /** True once hydrateSettings() has applied stored values. Subsequent
   *  hydrate calls (e.g. StrictMode double-mount) are no-ops; without this
   *  guard, a slow SQLite read could overwrite a user pick made during
   *  the await window. */
  settingsHydrated: boolean;
  setActiveProvider: (id: LlmProvider) => void;
  updateProvider: (id: LlmProvider, patch: Partial<ProviderConfig>) => void;
  setSystemPrompt: (s: string) => void;
  setDefaultShell: (shell: string | null) => void;
  setAppearance: (a: Appearance) => void;
  setFontId: (id: string) => void;
  setFontSize: (size: number) => void;
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
  appearance: DEFAULT_APPEARANCE,
  fontId: DEFAULT_FONT_ID,
  fontSize: DEFAULT_FONT_SIZE,
};

const clampFontSize = (n: number): number =>
  Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(n)));

const isAppearance = (v: unknown): v is Appearance =>
  v === 'dark' || v === 'light' || v === 'system';

export const useSettings = create<Settings>()((set, get) => ({
  ...DEFAULTS,
  secretsHydrated: false,
  settingsHydrated: false,

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

  setAppearance: (a) => {
    set({ appearance: a });
    applyTheme(resolveTheme(a));
    // Persist + broadcast immediately so a racing hydrate (StrictMode
    // double-mount, slow SQLite) can't overwrite the user's pick during
    // the debounce window.
    if (isTauri) {
      const snapshot = toPersistedSettings(get());
      void sessionSettingsSave(snapshot)
        .then(() => settingsBroadcastChanged().catch(() => {}))
        .catch((err) => console.error('[settings] appearance save failed:', err));
    }
  },
  setFontId: (id) => set({ fontId: id }),
  setFontSize: (size) => set({ fontSize: clampFontSize(size) }),

  hydrateSettings: async () => {
    // Idempotent: StrictMode in dev runs this useEffect twice; we also
    // don't want a slow SQLite read to clobber a user pick made during
    // the await window.
    if (get().settingsHydrated) return;
    set({ settingsHydrated: true });

    // Always apply whatever appearance is currently in the store so the
    // pre-hydration paint matches user preference once we've read SQLite.
    applyTheme(resolveTheme(get().appearance));
    if (!isTauri) return;

    // Try SQLite first.
    try {
      const stored = await sessionSettingsLoad();
      if (stored) {
        // Suppress the debounced save — applying stored values shouldn't
        // immediately write them back (and broadcast).
        suppressSave = true;
        set((s) => ({
          activeProvider: stored.activeProvider ?? s.activeProvider,
          systemPrompt: stored.systemPrompt ?? s.systemPrompt,
          defaultShell: stored.defaultShell ?? s.defaultShell,
          providers: mergeProviders(s.providers, stored.providers),
          appearance: isAppearance(stored.appearance) ? stored.appearance : s.appearance,
          fontId: stored.fontId ?? s.fontId,
          fontSize:
            typeof stored.fontSize === 'number'
              ? clampFontSize(stored.fontSize)
              : s.fontSize,
        }));
        applyTheme(resolveTheme(get().appearance));
        queueMicrotask(() => {
          suppressSave = false;
        });
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
        suppressSave = true;
        set((s) => ({
          activeProvider: legacy.activeProvider ?? s.activeProvider,
          systemPrompt: legacy.systemPrompt ?? s.systemPrompt,
          defaultShell: legacy.defaultShell ?? s.defaultShell,
          providers: mergeProviders(s.providers, legacy.providers),
          appearance: isAppearance(legacy.appearance) ? legacy.appearance : s.appearance,
          fontId: legacy.fontId ?? s.fontId,
          fontSize:
            typeof legacy.fontSize === 'number'
              ? clampFontSize(legacy.fontSize)
              : s.fontSize,
        }));
        applyTheme(resolveTheme(get().appearance));
        queueMicrotask(() => {
          suppressSave = false;
        });
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
    appearance: s.appearance,
    fontId: s.fontId,
    fontSize: s.fontSize,
  };
}

// Suppress save during programmatic hydrate-from-broadcast — otherwise
// applying values from a sibling window would echo back via the
// subscriber and ping-pong. Set true around the set() call, cleared next
// microtask.
let suppressSave = false;

// Debounce-write non-secret settings to SQLite whenever they change.
let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined;
useSettings.subscribe((state) => {
  if (!isTauri || suppressSave) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    void sessionSettingsSave(toPersistedSettings(state))
      .then(() => settingsBroadcastChanged().catch(() => {}))
      .catch((err) => console.error('[settings] SQLite save failed:', err));
  }, 500);
});

/** Re-pull settings from SQLite without writing back. Called when the
 *  other window broadcasts a change. */
export async function rehydrateSettingsFromBroadcast(): Promise<void> {
  if (!isTauri) return;
  try {
    const stored = await sessionSettingsLoad();
    if (!stored) return;
    const current = useSettings.getState();
    // No-op when the broadcast just echoes the source window's own save —
    // applying identical values triggers React re-renders and (worse) can
    // race with a debounced save that's still in-flight.
    const sameAppearance =
      (isAppearance(stored.appearance) ? stored.appearance : current.appearance) ===
      current.appearance;
    const sameFont =
      (stored.fontId ?? current.fontId) === current.fontId &&
      (typeof stored.fontSize === 'number'
        ? clampFontSize(stored.fontSize)
        : current.fontSize) === current.fontSize;
    const sameShell = (stored.defaultShell ?? current.defaultShell) === current.defaultShell;
    const sameProvider =
      (stored.activeProvider ?? current.activeProvider) === current.activeProvider;
    if (sameAppearance && sameFont && sameShell && sameProvider) return;

    suppressSave = true;
    useSettings.setState((s) => ({
      activeProvider: stored.activeProvider ?? s.activeProvider,
      systemPrompt: stored.systemPrompt ?? s.systemPrompt,
      defaultShell: stored.defaultShell ?? s.defaultShell,
      providers: mergeProviders(s.providers, stored.providers),
      appearance: isAppearance(stored.appearance) ? stored.appearance : s.appearance,
      fontId: stored.fontId ?? s.fontId,
      fontSize:
        typeof stored.fontSize === 'number'
          ? clampFontSize(stored.fontSize)
          : s.fontSize,
    }));
    applyTheme(resolveTheme(useSettings.getState().appearance));
    queueMicrotask(() => {
      suppressSave = false;
    });
  } catch (err) {
    console.error('[settings] rehydrate broadcast failed:', err);
  }
}

// Re-paint when the OS color scheme changes — only matters when the user
// picked `'system'`. Module-level subscription, never torn down.
if (typeof window !== 'undefined') {
  onSystemAppearanceChange(() => {
    if (useSettings.getState().appearance === 'system') {
      applyTheme(resolveTheme('system'));
    }
  });
}

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
