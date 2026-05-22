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
import {
  PROVIDER_PRESETS,
  getPreset,
  presetOrDefault,
  type ProviderPreset,
} from './providers';

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}

export interface Settings {
  /** Id of the provider preset currently selected for the next chat turn.
   *  Multiple presets can be `enabled`; this one is the one actively in use. */
  activePresetId: string;
  /** Model id paired with `activePresetId`. Stored separately so a session
   *  can lock to a specific model independently of the preset's default. */
  currentModel: string;
  /** Preset ids the user has explicitly enabled — these are the ones that
   *  appear in the model dropdown. A preset auto-enables when its key is
   *  set, and can be disabled by hand from the Providers pane. */
  enabledPresetIds: string[];
  /** Per-preset configuration keyed by preset id (not by backend kind). */
  providers: Record<string, ProviderConfig>;
  systemPrompt: string;
  /** Path to the shell binary new terminals should spawn. `null` means
   *  "let the Rust side pick the OS default" (COMSPEC on Windows,
   *  `$SHELL` elsewhere). Applies to newly-opened tabs only; in-flight
   *  PTYs aren't restarted. */
  defaultShell: string | null;
  /** User's appearance preference. `'system'` follows the OS color scheme. */
  appearance: Appearance;
  /** Mono font id from `FONT_OPTIONS`. */
  fontId: string;
  /** Terminal / editor font size in px. */
  fontSize: number;
  /** True once hydrateSecrets() has finished. */
  secretsHydrated: boolean;
  /** True once hydrateSettings() has applied stored values. */
  settingsHydrated: boolean;
  setActivePresetId: (id: string) => void;
  /** Switch both the preset and the model in one step. Used by the model
   *  picker so the two never drift apart. */
  setCurrentModel: (presetId: string, model: string) => void;
  /** Toggle whether a preset appears in the model picker. */
  setPresetEnabled: (id: string, enabled: boolean) => void;
  updateProvider: (id: string, patch: Partial<ProviderConfig>) => void;
  setSystemPrompt: (s: string) => void;
  setDefaultShell: (shell: string | null) => void;
  setAppearance: (a: Appearance) => void;
  setFontId: (id: string) => void;
  setFontSize: (size: number) => void;
  hydrateSettings: () => Promise<void>;
  hydrateSecrets: () => Promise<void>;
}

const KEY_SAVE_DEBOUNCE_MS = 300;
const keySaveTimers: Record<string, ReturnType<typeof setTimeout>> = {};

/** Defaults: every preset gets a row in `providers` so the UI doesn't have
 *  to deal with undefined entries. apiKey is empty until hydrateSecrets
 *  pulls from the keychain; model defaults to the first known model (or
 *  empty for free-form-only presets). */
function defaultProviderConfigs(): Record<string, ProviderConfig> {
  return Object.fromEntries(
    PROVIDER_PRESETS.map((p) => [
      p.id,
      {
        apiKey: p.needsApiKey ? '' : undefined,
        baseUrl: p.defaultBaseUrl,
        model: p.defaultModels[0] ?? '',
      },
    ]),
  );
}

const DEFAULTS = {
  activePresetId: 'openai',
  currentModel: PROVIDER_PRESETS[0]?.defaultModels[0] ?? '',
  // No keys set yet → no providers enabled. Once the user pastes a key the
  // preset auto-enables (see updateProvider). Local presets that don't need
  // a key are enabled out of the box.
  enabledPresetIds: PROVIDER_PRESETS.filter((p) => !p.needsApiKey).map((p) => p.id),
  providers: defaultProviderConfigs(),
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

  setActivePresetId: (id) => {
    const preset = getPreset(id);
    if (!preset) return;
    set((s) => {
      // Snap the current model to one that belongs to this preset so the
      // picker never shows a foreign model paired with the new provider.
      const cfg = s.providers[id];
      const model = cfg?.model || preset.defaultModels[0] || s.currentModel;
      return { activePresetId: id, currentModel: model };
    });
  },

  setCurrentModel: (presetId, model) => {
    if (!getPreset(presetId)) return;
    set((s) => {
      // Mirror the choice onto the per-preset config so the user's last
      // pick sticks across switches and gets persisted to SQLite.
      const cfg = s.providers[presetId] ?? { model: '' };
      return {
        activePresetId: presetId,
        currentModel: model,
        providers: { ...s.providers, [presetId]: { ...cfg, model } },
      };
    });
  },

  setPresetEnabled: (id, enabled) => {
    if (!getPreset(id)) return;
    set((s) => {
      const current = new Set(s.enabledPresetIds);
      if (enabled) current.add(id);
      else current.delete(id);
      // Order presets by their canonical registry position so the picker
      // groups stay stable regardless of toggle order.
      const ordered = PROVIDER_PRESETS.filter((p) => current.has(p.id)).map((p) => p.id);
      // If we just disabled the current preset, snap to the next enabled one.
      let nextActive = s.activePresetId;
      let nextModel = s.currentModel;
      if (!current.has(s.activePresetId)) {
        const fallback = ordered[0];
        if (fallback) {
          const preset = getPreset(fallback)!;
          const cfg = s.providers[fallback];
          nextActive = fallback;
          nextModel = cfg?.model || preset.defaultModels[0] || '';
        }
      }
      return {
        enabledPresetIds: ordered,
        activePresetId: nextActive,
        currentModel: nextModel,
      };
    });
  },

  updateProvider: (id, patch) => {
    if (!getPreset(id)) return;
    set((s) => {
      const cfg = { ...(s.providers[id] ?? { model: '' }), ...patch };
      // Auto-enable a preset the moment a key gets set, so the user doesn't
      // have to find a separate toggle. Clearing the key does NOT
      // auto-disable — they may want to keep the entry for later.
      const enabled = new Set(s.enabledPresetIds);
      if (patch.apiKey && patch.apiKey.length > 0) enabled.add(id);
      const ordered = PROVIDER_PRESETS.filter((p) => enabled.has(p.id)).map((p) => p.id);
      // Mirror a model change into `currentModel` if it's the active preset.
      const currentModel =
        id === s.activePresetId && patch.model !== undefined ? patch.model : s.currentModel;
      return {
        providers: { ...s.providers, [id]: cfg },
        enabledPresetIds: ordered,
        currentModel,
      };
    });
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
    if (get().settingsHydrated) return;
    set({ settingsHydrated: true });

    applyTheme(resolveTheme(get().appearance));
    if (!isTauri) return;

    try {
      const stored = await sessionSettingsLoad();
      if (stored) {
        suppressSave = true;
        set((s) => applyStored(s, stored));
        applyTheme(resolveTheme(get().appearance));
        queueMicrotask(() => {
          suppressSave = false;
        });
        return;
      }
    } catch (err) {
      console.error('[settings] SQLite load failed:', err);
    }

    // One-shot migration: legacy localStorage from the pre-keyring days.
    try {
      const raw = localStorage.getItem('arc-settings');
      if (raw) {
        const parsed = JSON.parse(raw) as { state?: Partial<PersistedSettings> };
        const legacy = parsed.state ?? {};
        suppressSave = true;
        set((s) => applyStored(s, legacy));
        applyTheme(resolveTheme(get().appearance));
        queueMicrotask(() => {
          suppressSave = false;
        });
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
    const providers = { ...get().providers };

    // One-shot migration: legacy providers stored their apiKey inline
    // (pre-keychain era). Push anything still sitting in memory.
    for (const id of Object.keys(providers)) {
      const legacy = providers[id]?.apiKey;
      if (legacy && legacy.length > 0) {
        try {
          await secretsSetApiKey(id, legacy);
        } catch (err) {
          console.error(`[settings] migrate ${id} → keyring failed:`, err);
        }
      }
    }

    // Pull every preset's key from the keychain. Presets that don't take a
    // key still get a row in the map so the UI lookup stays uniform.
    for (const preset of PROVIDER_PRESETS) {
      if (!preset.needsApiKey) {
        providers[preset.id] = {
          ...(providers[preset.id] ?? { model: preset.defaultModels[0] ?? '' }),
          apiKey: undefined,
        };
        continue;
      }
      try {
        const stored = await secretsGetApiKey(preset.id);
        providers[preset.id] = {
          ...(providers[preset.id] ?? { model: preset.defaultModels[0] ?? '' }),
          apiKey: stored ?? '',
        };
      } catch (err) {
        console.error(`[settings] keyring read ${preset.id} failed:`, err);
        providers[preset.id] = {
          ...(providers[preset.id] ?? { model: preset.defaultModels[0] ?? '' }),
          apiKey: '',
        };
      }
    }
    // Auto-enable any preset that has a stored key — keeps the picker honest
    // after a fresh install where the user has only pasted some keys but
    // never visited the Providers pane.
    const current = new Set(get().enabledPresetIds);
    for (const preset of PROVIDER_PRESETS) {
      if (preset.needsApiKey && providers[preset.id]?.apiKey) {
        current.add(preset.id);
      } else if (!preset.needsApiKey) {
        current.add(preset.id);
      }
    }
    const enabledPresetIds = PROVIDER_PRESETS.filter((p) => current.has(p.id)).map(
      (p) => p.id,
    );
    set({ providers, enabledPresetIds, secretsHydrated: true });
  },
}));

// ─── helpers ───────────────────────────────────────────────────────────────

/** Merge a stored settings blob into the current store state. Handles both
 *  the current preset-keyed shape and the legacy `activeProvider` / 3-key
 *  shape from before the preset refactor. */
function applyStored(
  current: Settings,
  stored: Partial<PersistedSettings>,
): Partial<Settings> {
  // Pick activePresetId from either field, falling back to the legacy
  // LlmProvider kind if it happens to match a preset id (it does for
  // openai / anthropic / ollama).
  const candidate =
    (stored as { activePresetId?: string }).activePresetId ??
    stored.activeProvider ??
    current.activePresetId;
  const activePresetId = getPreset(candidate ?? '') ? candidate! : current.activePresetId;

  // Merge per-preset configs. Keep every preset present in the store; only
  // override entries that match a known preset id.
  const nextProviders: Record<string, ProviderConfig> = { ...current.providers };
  const incoming = stored.providers as
    | Record<string, { model?: string; baseUrl?: string }>
    | undefined;
  if (incoming) {
    for (const [id, cfg] of Object.entries(incoming)) {
      const preset = getPreset(id);
      if (!preset) continue;
      const base = nextProviders[id] ?? { model: preset.defaultModels[0] ?? '' };
      nextProviders[id] = {
        ...base,
        model: cfg.model ?? base.model,
        baseUrl: cfg.baseUrl ?? base.baseUrl ?? preset.defaultBaseUrl,
      };
    }
  }

  // Enabled-preset list. If absent (older blob), seed with anything that
  // already has a non-empty model in `providers` — the same heuristic the
  // legacy single-active store implied.
  const storedEnabled = (stored as { enabledPresetIds?: string[] }).enabledPresetIds;
  const enabledIds = storedEnabled
    ? storedEnabled.filter((id) => getPreset(id))
    : PROVIDER_PRESETS.filter(
        (p) => !p.needsApiKey || Boolean(nextProviders[p.id]?.model),
      ).map((p) => p.id);
  // Preserve registry order so the picker doesn't reshuffle on every save.
  const orderedEnabled = PROVIDER_PRESETS.filter((p) =>
    enabledIds.includes(p.id),
  ).map((p) => p.id);

  // currentModel: fall back to whichever model is configured on the active
  // preset, then the preset's first default.
  const activePreset = getPreset(activePresetId)!;
  const activeCfg = nextProviders[activePresetId];
  const storedModel = (stored as { currentModel?: string }).currentModel;
  const currentModel =
    storedModel ||
    activeCfg?.model ||
    activePreset.defaultModels[0] ||
    current.currentModel;

  return {
    activePresetId,
    currentModel,
    enabledPresetIds: orderedEnabled,
    systemPrompt: stored.systemPrompt ?? current.systemPrompt,
    defaultShell: stored.defaultShell ?? current.defaultShell,
    providers: nextProviders,
    appearance: isAppearance(stored.appearance) ? stored.appearance : current.appearance,
    fontId: stored.fontId ?? current.fontId,
    fontSize:
      typeof stored.fontSize === 'number'
        ? clampFontSize(stored.fontSize)
        : current.fontSize,
  };
}

function toPersistedSettings(s: Settings): PersistedSettings {
  return {
    activePresetId: s.activePresetId,
    currentModel: s.currentModel,
    enabledPresetIds: s.enabledPresetIds,
    // Mirror to the legacy field so an older binary opening the same DB
    // doesn't end up with an undefined provider. Cast through unknown
    // because not every preset id maps to a LlmProvider kind.
    activeProvider: (getPreset(s.activePresetId)?.kind ?? 'openai') as LlmProvider,
    providers: Object.fromEntries(
      Object.entries(s.providers).map(([id, cfg]) => [
        id,
        { model: cfg.model, baseUrl: cfg.baseUrl },
      ]),
    ),
    systemPrompt: s.systemPrompt,
    defaultShell: s.defaultShell,
    appearance: s.appearance,
    fontId: s.fontId,
    fontSize: s.fontSize,
  };
}

// Suppress save during programmatic hydrate. Set true around set(), cleared
// next microtask.
let suppressSave = false;

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
    const incomingPreset =
      (stored as { activePresetId?: string }).activePresetId ??
      stored.activeProvider ??
      current.activePresetId;
    const samePreset = incomingPreset === current.activePresetId;
    const sameAppearance =
      (isAppearance(stored.appearance) ? stored.appearance : current.appearance) ===
      current.appearance;
    const sameFont =
      (stored.fontId ?? current.fontId) === current.fontId &&
      (typeof stored.fontSize === 'number'
        ? clampFontSize(stored.fontSize)
        : current.fontSize) === current.fontSize;
    const sameShell = (stored.defaultShell ?? current.defaultShell) === current.defaultShell;
    if (samePreset && sameAppearance && sameFont && sameShell) return;

    suppressSave = true;
    useSettings.setState((s) => applyStored(s, stored));
    applyTheme(resolveTheme(useSettings.getState().appearance));
    queueMicrotask(() => {
      suppressSave = false;
    });
  } catch (err) {
    console.error('[settings] rehydrate broadcast failed:', err);
  }
}

// Re-paint when the OS color scheme changes — only matters when the user
// picked `'system'`.
if (typeof window !== 'undefined') {
  onSystemAppearanceChange(() => {
    if (useSettings.getState().appearance === 'system') {
      applyTheme(resolveTheme('system'));
    }
  });
}

// ─── derived selectors ─────────────────────────────────────────────────────

/** The preset the user has chosen for new chats. */
export function useActivePreset(): ProviderPreset {
  const id = useSettings((s) => s.activePresetId);
  return presetOrDefault(id);
}

/** Config row for the active preset. */
export function useActiveProviderConfig(): ProviderConfig {
  const id = useSettings((s) => s.activePresetId);
  const cfg = useSettings((s) => s.providers[id]);
  return cfg ?? { model: '' };
}

// Re-export for the (few) call-sites that still want a static map. The
// PROVIDER_LABELS / PROVIDER_MODELS exports are kept to avoid breaking
// callers; new code should pull from PROVIDER_PRESETS instead.
export const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
  PROVIDER_PRESETS.map((p) => [p.id, p.label]),
);
export const PROVIDER_MODELS: Record<string, string[]> = Object.fromEntries(
  PROVIDER_PRESETS.map((p) => [p.id, p.defaultModels]),
);
