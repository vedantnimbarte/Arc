// In-memory model catalog cache, keyed by preset id.
//
// Fetching is on-demand: the picker / Providers pane call `fetch(presetId)`
// and subscribe to the resulting `ModelCacheEntry`. A successful fetch
// stays valid for `STALE_AFTER_MS` before the next call refreshes it
// (a manual refresh button bypasses the freshness check).

import { create } from 'zustand';
import { llmListModels, type ModelInfo } from '../lib/tauri';
import { PROVIDER_PRESETS, getPreset } from './providers';
import { useSettings } from './settings';

const STALE_AFTER_MS = 5 * 60 * 1000; // 5 min

export interface ModelCacheEntry {
  status: 'idle' | 'loading' | 'ok' | 'error';
  models: ModelInfo[];
  fetchedAt?: number;
  error?: string;
}

interface ModelCacheState {
  entries: Record<string, ModelCacheEntry>;
  fetch: (presetId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Reset a single preset's entry — used on key/base-URL change. */
  invalidate: (presetId: string) => void;
  /** Best-effort warm-up: fetch every enabled preset's catalog in parallel.
   *  Called once after settings + secrets are hydrated. */
  warmUpEnabled: () => Promise<void>;
}

export const useModels = create<ModelCacheState>((set, get) => ({
  entries: {},

  fetch: async (presetId, opts) => {
    const preset = getPreset(presetId);
    if (!preset) return;
    const current = get().entries[presetId];

    // Skip if a request is already in flight, or if a fresh result exists.
    if (current?.status === 'loading') return;
    const fresh =
      current?.status === 'ok' &&
      current.fetchedAt !== undefined &&
      Date.now() - current.fetchedAt < STALE_AFTER_MS;
    if (fresh && !opts?.force) return;

    const settings = useSettings.getState();
    const cfg = settings.providers[presetId];
    const apiKey = cfg?.apiKey;
    const baseUrl = cfg?.baseUrl ?? preset.defaultBaseUrl;

    if (preset.needsApiKey && !apiKey) {
      set((s) => ({
        entries: {
          ...s.entries,
          [presetId]: {
            status: 'error',
            models: current?.models ?? [],
            error: 'no api key',
          },
        },
      }));
      return;
    }

    set((s) => ({
      entries: {
        ...s.entries,
        [presetId]: {
          status: 'loading',
          models: current?.models ?? [],
        },
      },
    }));

    try {
      const models = await llmListModels(preset.kind, apiKey, baseUrl || undefined);
      set((s) => ({
        entries: {
          ...s.entries,
          [presetId]: {
            status: 'ok',
            models,
            fetchedAt: Date.now(),
          },
        },
      }));
    } catch (err) {
      set((s) => ({
        entries: {
          ...s.entries,
          [presetId]: {
            status: 'error',
            models: current?.models ?? [],
            error: String(err),
          },
        },
      }));
    }
  },

  invalidate: (presetId) => {
    set((s) => {
      if (!s.entries[presetId]) return s;
      const next = { ...s.entries };
      delete next[presetId];
      return { entries: next };
    });
  },

  warmUpEnabled: async () => {
    const settings = useSettings.getState();
    const usable = settings.enabledPresetIds.filter((id) => {
      const preset = getPreset(id);
      if (!preset) return false;
      if (!preset.needsApiKey) return true;
      return Boolean(settings.providers[id]?.apiKey);
    });
    await Promise.allSettled(
      usable.map((id) => get().fetch(id).catch(() => {})),
    );
  },
}));

/** Resolved model list for a preset — combines the live catalog with the
 *  preset's hard-coded `defaultModels` as a fallback. */
export function resolveModelsFor(
  presetId: string,
  entry: ModelCacheEntry | undefined,
): ModelInfo[] {
  const preset = getPreset(presetId);
  if (!preset) return [];
  if (entry?.status === 'ok' && entry.models.length > 0) return entry.models;
  // Fall back to defaults so empty caches still produce a useful picker.
  return preset.defaultModels.map((id) => ({ id }));
}

/** Flattened (provider, model) tuples for the global picker, restricted to
 *  enabled presets. Sorted by provider order in PROVIDER_PRESETS, then by
 *  model id within each provider. */
export interface FlatModelRow {
  presetId: string;
  presetLabel: string;
  model: ModelInfo;
}

/** Filter to presets that are enabled AND have credentials in place — for
 *  cloud presets that means an API key, for local ones it's free. The
 *  picker uses this so it never lists a model that can't actually be
 *  called. */
export function collectEnabledModels(
  enabledIds: ReadonlyArray<string>,
  entries: Record<string, ModelCacheEntry>,
  providers: Record<string, { apiKey?: string }>,
): FlatModelRow[] {
  const rows: FlatModelRow[] = [];
  for (const preset of PROVIDER_PRESETS) {
    if (!enabledIds.includes(preset.id)) continue;
    if (preset.needsApiKey && !providers[preset.id]?.apiKey) continue;
    const models = resolveModelsFor(preset.id, entries[preset.id]);
    for (const m of models) {
      rows.push({ presetId: preset.id, presetLabel: preset.label, model: m });
    }
  }
  return rows;
}

