// Floating picker for switching between (provider, model) pairs across every
// enabled provider. Used by the status bar and the chat composer — the
// trigger lives in those callers, this owns the panel and its lifecycle.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Cpu,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  X,
} from 'lucide-react';
import { cn } from '../lib/cn';
import {
  PROVIDER_PRESETS,
  getPreset,
  type ProviderPreset,
} from '../state/providers';
import { ProviderIcon } from './ProviderIcon';
import { useSettings } from '../state/settings';
import {
  collectEnabledModels,
  resolveModelsFor,
  useModels,
  type FlatModelRow,
} from '../state/models';
import { settingsWindowOpen } from '../lib/tauri';

interface Props {
  open: boolean;
  /** Element whose bounding box anchors the panel. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Where the panel grows from. `'up'` for the status bar, `'down'` for
   *  the chat composer. */
  placement?: 'up' | 'down';
  /** Horizontal alignment relative to the anchor. */
  align?: 'start' | 'end';
  onClose: () => void;
}

export function ModelPicker({
  open,
  anchorRef,
  placement = 'up',
  align = 'start',
  onClose,
}: Props) {
  const enabledIds = useSettings((s) => s.enabledPresetIds);
  const providers = useSettings((s) => s.providers);
  const activePresetId = useSettings((s) => s.activePresetId);
  const currentModel = useSettings((s) => s.currentModel);
  const setCurrentModel = useSettings((s) => s.setCurrentModel);
  const entries = useModels((s) => s.entries);
  const fetchModels = useModels((s) => s.fetch);

  /** Only enabled presets with credentials in place — drives every list
   *  inside the picker so models without callable backends stay hidden. */
  const usableIds = useMemo(
    () =>
      enabledIds.filter((id) => {
        const preset = getPreset(id);
        if (!preset) return false;
        if (!preset.needsApiKey) return true;
        return Boolean(providers[id]?.apiKey);
      }),
    [enabledIds, providers],
  );

  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [focusIdx, setFocusIdx] = useState(0);

  // Fetch on open for every usable preset that has no fresh cache yet.
  useEffect(() => {
    if (!open) return;
    usableIds.forEach((id) => void fetchModels(id).catch(() => {}));
  }, [open, usableIds, fetchModels]);

  // Position the panel relative to its anchor.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const PANEL_W = 360;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const leftRaw = align === 'end' ? r.right - PANEL_W : r.left;
      const left = Math.max(8, Math.min(vw - PANEL_W - 8, leftRaw));
      if (placement === 'up') {
        setPos({ bottom: vh - r.top + 6, left });
      } else {
        setPos({ top: r.bottom + 6, left });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, placement, align]);

  // Focus the search box on open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFocusIdx(0);
    const id = window.setTimeout(() => inputRef.current?.focus(), 16);
    return () => window.clearTimeout(id);
  }, [open]);

  // Close on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  const rows = useMemo(
    () => collectEnabledModels(usableIds, entries, providers),
    [usableIds, entries, providers],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.model.id.toLowerCase().includes(q) ||
        r.model.label?.toLowerCase().includes(q) ||
        r.presetLabel.toLowerCase().includes(q) ||
        r.presetId.toLowerCase().includes(q),
    );
  }, [rows, query]);

  // Group filtered rows by preset, preserving canonical order.
  const grouped = useMemo(() => {
    const map = new Map<string, FlatModelRow[]>();
    for (const r of filtered) {
      const list = map.get(r.presetId) ?? [];
      list.push(r);
      map.set(r.presetId, list);
    }
    return PROVIDER_PRESETS.filter((p) => map.has(p.id)).map((p) => ({
      preset: p,
      rows: map.get(p.id)!,
    }));
  }, [filtered]);

  // Clamp focus when the filter shrinks the list.
  useEffect(() => {
    if (focusIdx >= filtered.length) setFocusIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, focusIdx]);

  const pick = useCallback(
    (r: FlatModelRow) => {
      setCurrentModel(r.presetId, r.model.id);
      onClose();
    },
    [setCurrentModel, onClose],
  );

  const refreshAll = () => {
    usableIds.forEach((id) => void fetchModels(id, { force: true }).catch(() => {}));
  };

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = filtered[focusIdx];
      if (row) pick(row);
    }
  };

  if (!open || !pos || typeof document === 'undefined') return null;

  const openSettings = () => {
    void settingsWindowOpen().catch(() => {});
    onClose();
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Model picker"
      style={{ position: 'fixed', ...pos, width: 360 }}
      className="material-sheet z-50 flex max-h-[480px] flex-col overflow-hidden rounded-lg shadow-sheet ring-1 ring-white/10 animate-popover-in"
    >
      {/* Search */}
      <div className="flex items-center gap-2 border-b border-border-hairline bg-bg-base/60 px-3 py-2">
        <Search size={11} strokeWidth={2.2} className="text-fg-subtle" />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onListKey}
          placeholder="filter models…"
          className="flex-1 bg-transparent font-display text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
          autoComplete="off"
          spellCheck={false}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="rounded p-0.5 text-fg-subtle hover:bg-white/[0.08] hover:text-fg-base"
            aria-label="Clear filter"
          >
            <X size={10} strokeWidth={2.2} />
          </button>
        )}
        <button
          onClick={refreshAll}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.08] hover:text-fg-base"
          title="Refresh model lists"
          aria-label="Refresh"
        >
          <RefreshCw size={10} strokeWidth={2.2} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto py-1">
        {usableIds.length === 0 && (
          <EmptyState
            line1={
              enabledIds.length === 0
                ? 'No providers enabled.'
                : 'No usable providers.'
            }
            line2={
              enabledIds.length === 0
                ? 'Add an API key from Settings → Providers.'
                : 'Every enabled provider is missing an API key.'
            }
            onOpenSettings={openSettings}
          />
        )}
        {usableIds.length > 0 && filtered.length === 0 && (
          <div className="px-4 pb-3 pt-4 font-display text-[11.5px] italic text-fg-subtle">
            no models match "{query}"
          </div>
        )}
        {grouped.map(({ preset, rows: groupRows }) => (
          <Group
            key={preset.id}
            preset={preset}
            rows={groupRows}
            allRows={filtered}
            focusIdx={focusIdx}
            activePresetId={activePresetId}
            currentModel={currentModel}
            onPick={pick}
            onFocus={setFocusIdx}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-border-hairline bg-bg-base/40 px-3 py-1.5 font-display text-[10px] text-fg-subtle">
        <span>
          {rows.length} {rows.length === 1 ? 'model' : 'models'}
          <span className="px-1 text-fg-subtle">·</span>
          {usableIds.length} of {enabledIds.length} ready
        </span>
        <button
          onClick={openSettings}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-subtle transition-colors hover:bg-white/[0.06] hover:text-fg-muted"
        >
          <SettingsIcon size={9} strokeWidth={2.2} />
          manage providers
        </button>
      </div>
    </div>,
    document.body,
  );
}

function Group({
  preset,
  rows,
  allRows,
  focusIdx,
  activePresetId,
  currentModel,
  onPick,
  onFocus,
}: {
  preset: ProviderPreset;
  rows: FlatModelRow[];
  allRows: FlatModelRow[];
  focusIdx: number;
  activePresetId: string;
  currentModel: string;
  onPick: (r: FlatModelRow) => void;
  onFocus: (i: number) => void;
}) {
  const entries = useModels((s) => s.entries);
  const fetchModels = useModels((s) => s.fetch);
  const entry = entries[preset.id];
  const loading = entry?.status === 'loading';
  const errored = entry?.status === 'error' && rows.length === 0;

  return (
    <section className="px-1.5 pb-1">
      <div className="flex items-center justify-between px-2 pb-0.5 pt-1.5">
        <div className="flex items-center gap-1.5">
          <ProviderIcon preset={preset} size={16} monogramSize={9.5} className="rounded-sm" />
          <span className="font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
            {preset.label}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {loading && (
            <RefreshCw
              size={9}
              strokeWidth={2.2}
              className="animate-spin text-fg-subtle"
              aria-label="loading"
            />
          )}
          {errored && (
            <span className="font-display text-[9.5px] text-status-warn">offline</span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              void fetchModels(preset.id, { force: true }).catch(() => {});
            }}
            className="rounded p-0.5 text-fg-subtle hover:bg-white/[0.06] hover:text-fg-muted"
            title="Refresh this provider"
            aria-label="Refresh"
          >
            <RefreshCw size={9} strokeWidth={2.2} />
          </button>
        </div>
      </div>
      <div role="listbox" className="flex flex-col">
        {rows.map((r) => {
          const globalIdx = allRows.indexOf(r);
          const isFocus = globalIdx === focusIdx;
          const isCurrent =
            r.presetId === activePresetId && r.model.id === currentModel;
          return (
            <button
              key={`${r.presetId}::${r.model.id}`}
              role="option"
              aria-selected={isCurrent}
              onMouseEnter={() => onFocus(globalIdx)}
              onClick={() => onPick(r)}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-fg-base/90 transition-colors',
                isFocus ? 'bg-white/[0.06]' : 'hover:bg-white/[0.045]',
              )}
            >
              <span className="flex-1 truncate">{r.model.label ?? r.model.id}</span>
              {r.model.label && r.model.label !== r.model.id && (
                <span className="truncate font-mono text-[10px] text-fg-subtle">
                  {r.model.id}
                </span>
              )}
              {isCurrent && (
                <Check size={10} strokeWidth={2.4} className="shrink-0 text-accent-bright" />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function EmptyState({
  line1,
  line2,
  onOpenSettings,
}: {
  line1: string;
  line2: string;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-4">
      <div className="flex items-center gap-1.5 font-display text-[11.5px] text-fg-base">
        <Cpu size={11} strokeWidth={2.1} className="text-fg-subtle" />
        {line1}
      </div>
      <p className="font-display text-[10.5px] leading-relaxed text-fg-subtle">{line2}</p>
      <button
        onClick={onOpenSettings}
        className="inline-flex items-center gap-1 rounded-md border border-border-subtle bg-bg-base/40 px-2 py-1 font-display text-[11px] text-fg-base transition-colors hover:border-border-strong hover:bg-bg-base/60"
      >
        <SettingsIcon size={10} strokeWidth={2.1} />
        Open Settings
      </button>
    </div>
  );
}

// ─── Compact trigger for re-use by callers ────────────────────────────────

/** Render a label like "OpenAI · gpt-4o-mini" for the currently selected
 *  (preset, model) pair. Used by the picker trigger buttons. */
export function useCurrentModelLabel(): {
  presetLabel: string;
  modelLabel: string;
  preset: ProviderPreset;
} {
  const presetId = useSettings((s) => s.activePresetId);
  const model = useSettings((s) => s.currentModel);
  const preset = getPreset(presetId) ?? PROVIDER_PRESETS[0]!;
  const entries = useModels((s) => s.entries);
  const info = resolveModelsFor(presetId, entries[presetId]).find((m) => m.id === model);
  return {
    presetLabel: preset.label,
    modelLabel: (info?.label ?? model) || preset.defaultModels[0] || 'no model',
    preset,
  };
}
