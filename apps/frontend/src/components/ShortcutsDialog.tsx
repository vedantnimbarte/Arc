import { useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, RotateCcw, Search, X, AlertTriangle, Check } from 'lucide-react';
import {
  ACTION_META,
  ACTION_ORDER,
  DEFAULT_BINDINGS,
  REFERENCE_CATEGORIES,
  REFERENCE_SHORTCUTS,
  bindingFromEvent,
  findConflict,
  formatBinding,
  useShortcuts,
  type ActionCategory,
  type ActionId,
  type KeyBinding,
} from '../state/shortcuts';
import { cn } from '../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
}

const CATEGORIES: ActionCategory[] = ['Workspace', 'Terminal', 'Assistant', 'SSH', 'AI CLIs', 'Help'];

export function ShortcutsDialog({ open, onClose }: Props) {
  const overrides = useShortcuts((s) => s.overrides);
  const setBinding = useShortcuts((s) => s.setBinding);
  const resetBinding = useShortcuts((s) => s.resetBinding);
  const resetAll = useShortcuts((s) => s.resetAll);
  const clearBinding = useShortcuts((s) => s.clearBinding);

  const [query, setQuery] = useState('');
  const [capturing, setCapturing] = useState<ActionId | null>(null);

  // Esc closes (unless we're mid-capture — then Esc means "cancel capture").
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (capturing) {
          e.preventDefault();
          e.stopPropagation();
          setCapturing(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, capturing]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setCapturing(null);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ACTION_ORDER.filter((id) => {
      if (!q) return true;
      const m = ACTION_META[id];
      return (
        m.label.toLowerCase().includes(q) ||
        m.description.toLowerCase().includes(q) ||
        m.category.toLowerCase().includes(q) ||
        formatBinding(currentBinding(id, overrides)).toLowerCase().includes(q)
      );
    });
  }, [query, overrides]);

  const filteredRef = useMemo(() => {
    const q = query.trim().toLowerCase();
    return REFERENCE_SHORTCUTS.filter((s) => {
      if (!q) return true;
      return (
        s.label.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.keys.toLowerCase().includes(q)
      );
    });
  }, [query]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (capturing) setCapturing(null);
        else onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[8vh] flex h-[80vh] w-[720px] max-w-[94vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        {/* Header */}
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-hairline bg-bg-chrome/40 px-4 backdrop-blur-md">
          <div className="flex items-center gap-2">
            <Keyboard size={13} strokeWidth={2.1} className="text-accent-bright" />
            <span className="font-display text-[13px] font-semibold tracking-tight text-fg-base">
              Keyboard Shortcuts
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => resetAll()}
              className="flex items-center gap-1 rounded-md px-2 py-1 font-display text-[11px] text-fg-muted transition-all hover:bg-white/[0.08] hover:text-fg-base"
              title="Reset every shortcut to its default"
            >
              <RotateCcw size={10} strokeWidth={2.1} />
              Reset all
            </button>
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-fg-subtle transition-all duration-150 ease-apple hover:bg-white/[0.08] hover:text-fg-base"
              aria-label="Close"
              title="Close (esc)"
            >
              <X size={13} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <Search size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter by action or key…"
            className="flex-1 bg-transparent font-display text-[13px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="rounded p-1 text-fg-subtle hover:bg-white/[0.06] hover:text-fg-base"
              aria-label="Clear filter"
            >
              <X size={10} strokeWidth={2.2} />
            </button>
          )}
        </div>

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2">
          {CATEGORIES.map((cat) => {
            const rows = filtered.filter((id) => ACTION_META[id].category === cat);
            if (rows.length === 0) return null;
            return (
              <section key={cat} className="mb-3">
                <h3 className="px-1 pb-1 font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
                  {cat}
                </h3>
                <div className="space-y-0.5">
                  {rows.map((id) => (
                    <ShortcutRow
                      key={id}
                      id={id}
                      capturing={capturing === id}
                      onStartCapture={() => setCapturing(id)}
                      onCapture={(binding) => {
                        setBinding(id, binding);
                        setCapturing(null);
                      }}
                      onClearBinding={() => {
                        clearBinding(id);
                        setCapturing(null);
                      }}
                      onCancel={() => setCapturing(null)}
                      onReset={() => resetBinding(id)}
                      overrides={overrides}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {filteredRef.length > 0 && (
            <div className="mb-2 mt-1">
              <div className="mb-2 flex items-center gap-2 px-1">
                <div className="h-px flex-1 bg-border-hairline" />
                <span className="font-display text-[9.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
                  Built-in · not rebindable
                </span>
                <div className="h-px flex-1 bg-border-hairline" />
              </div>
              {REFERENCE_CATEGORIES.map((cat) => {
                const rows = filteredRef.filter((s) => s.category === cat);
                if (rows.length === 0) return null;
                return (
                  <section key={cat} className="mb-3">
                    <h3 className="px-1 pb-1 font-display text-[10.5px] font-semibold uppercase tracking-widest2 text-fg-subtle">
                      {cat}
                    </h3>
                    <div className="space-y-0.5">
                      {rows.map((s) => (
                        <div
                          key={`${cat}:${s.label}`}
                          className="flex items-center gap-3 rounded-md px-2 py-1.5"
                        >
                          <div className="min-w-0 flex-1">
                            <span className="font-display text-[12.5px] font-medium tracking-tight text-fg-base">
                              {s.label}
                            </span>
                            <p className="truncate font-display text-[11px] text-fg-subtle">
                              {s.description}
                            </p>
                          </div>
                          <span className="shrink-0 rounded-md border border-border-subtle bg-bg-base/40 px-2.5 py-1 font-mono text-[11px] text-fg-muted">
                            {s.keys}
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
          {filtered.length === 0 && filteredRef.length === 0 && (
            <div className="flex items-center justify-center gap-1.5 px-4 py-12 font-display text-[12px] italic text-fg-subtle">
              <Search size={11} strokeWidth={2} />
              no actions match "{query}"
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between border-t border-border-hairline px-3.5 py-2 font-display text-[10px] text-fg-subtle">
          <span>
            <kbd className="font-mono">click</kbd> a binding to rebind ·{' '}
            <kbd className="font-mono">esc</kbd> to cancel
          </span>
          <span className="tabular-nums">
            {ACTION_ORDER.length + REFERENCE_SHORTCUTS.length} shortcuts
          </span>
        </div>
      </div>
    </div>
  );
}

interface RowProps {
  id: ActionId;
  capturing: boolean;
  overrides: Partial<Record<ActionId, KeyBinding | null>>;
  onStartCapture: () => void;
  onCapture: (binding: KeyBinding) => void;
  onCancel: () => void;
  onClearBinding: () => void;
  onReset: () => void;
}

function ShortcutRow({
  id,
  capturing,
  overrides,
  onStartCapture,
  onCapture,
  onCancel,
  onReset,
  onClearBinding,
}: RowProps) {
  const meta = ACTION_META[id];
  const binding = currentBinding(id, overrides);
  const isCustom = overrides[id] !== undefined;
  const captureRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<KeyBinding | null>(null);
  const [conflict, setConflict] = useState<ActionId | null>(null);

  useEffect(() => {
    if (!capturing) {
      setPending(null);
      setConflict(null);
      return;
    }
    captureRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Swallow ALL keys while capturing — otherwise this very same dialog's
      // global hotkeys would fire as the user tries to bind them.
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      const next = bindingFromEvent(e);
      if (!next) return; // modifier-only press
      setPending(next);
      const conf = findConflict(next, id);
      setConflict(conf);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, id, onCancel]);

  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-md px-2 py-1.5 transition-colors',
        capturing ? 'bg-accent-soft ring-1 ring-inset ring-accent/40' : 'hover:bg-white/[0.035]',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-display text-[12.5px] font-medium tracking-tight text-fg-base">
            {meta.label}
          </span>
          {isCustom && (
            <span
              className="rounded bg-accent/20 px-1 py-0.5 font-mono text-[8.5px] tracking-tight text-accent-bright"
              title="Customized — click reset to restore the default"
            >
              custom
            </span>
          )}
        </div>
        <p className="truncate font-display text-[11px] text-fg-subtle">
          {meta.description}
        </p>
      </div>

      {capturing ? (
        <div className="flex items-center gap-2">
          {conflict && (
            <span
              className="flex items-center gap-1 font-display text-[10.5px] text-status-warn"
              title="This combo is already bound to another action"
            >
              <AlertTriangle size={10} strokeWidth={2.1} />
              conflicts with {ACTION_META[conflict].label}
            </span>
          )}
          <button
            ref={captureRef}
            className="rounded-md border border-accent/40 bg-bg-base/70 px-2.5 py-1 font-mono text-[11px] text-fg-base shadow-focus outline-none"
            tabIndex={-1}
          >
            {pending ? formatBinding(pending) : 'press a combo…'}
          </button>
          {pending && (
            <button
              onClick={() => onCapture(pending)}
              className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/20 text-accent-bright transition-colors hover:bg-accent/30"
              title="Save"
              aria-label="Save binding"
            >
              <Check size={11} strokeWidth={2.2} />
            </button>
          )}
          <button
            onClick={onClearBinding}
            className="rounded-md px-2 py-1 font-display text-[10.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
            title="Disable this action"
          >
            disable
          </button>
          <button
            onClick={onCancel}
            className="rounded-md px-2 py-1 font-display text-[10.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          >
            cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            onClick={onStartCapture}
            className={cn(
              'rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors',
              binding
                ? 'border-border-subtle bg-bg-base/40 text-fg-base hover:border-border-strong hover:bg-bg-base/60'
                : 'border-dashed border-border-subtle bg-bg-base/20 text-fg-subtle italic hover:border-border-strong',
            )}
            title="Click to rebind"
          >
            {formatBinding(binding)}
          </button>
          {isCustom && (
            <button
              onClick={onReset}
              className="rounded-md p-1 text-fg-subtle opacity-0 transition-all hover:bg-white/[0.06] hover:text-fg-base group-hover:opacity-100"
              title="Reset to default"
              aria-label="Reset to default"
            >
              <RotateCcw size={10} strokeWidth={2.1} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function currentBinding(
  id: ActionId,
  overrides: Partial<Record<ActionId, KeyBinding | null>>,
): KeyBinding | null {
  const ov = overrides[id];
  if (ov === undefined) return DEFAULT_BINDINGS[id];
  return ov;
}
