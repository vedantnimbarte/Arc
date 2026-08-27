import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Search,
  SquareTerminal,
} from 'lucide-react';
import {
  isTauri,
  ptyWrite,
  sessionCommandsRecent,
  type CommandRecord,
} from '../lib/tauri';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Warp-style "command blocks" panel. Lists recent commands with their exit
 * status and captured output, each as a block; clicking a block expands its
 * output and any block can be pasted into the active terminal. Data comes from
 * `command_history` (OSC 133 shell integration).
 */
export function CommandBlocks({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CommandRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !isTauri) {
      if (!open) setRows([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void sessionCommandsRecent(80, query.trim() || null)
        .then((r) => !cancelled && setRows(r))
        .catch(() => !cancelled && setRows([]));
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setExpanded(new Set());
    }
  }, [open]);

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const pasteInto = useCallback(async (cmd: string) => {
    const { tabs, activeTabId } = useWorkspace.getState();
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active?.ptyId) return;
    try {
      await ptyWrite(active.ptyId, cmd);
    } catch {
      /* terminal closing */
    }
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[10vh] flex max-h-[80vh] w-[720px] max-w-[94vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <SquareTerminal size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            placeholder="filter command blocks…"
            className="flex-1 bg-transparent font-display text-base text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="font-mono text-2xs text-fg-subtle">esc</kbd>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {rows.length === 0 && (
            <div className="flex items-center justify-center gap-1.5 px-4 py-8 font-display text-xs italic text-fg-subtle">
              {isTauri ? (
                <>
                  <Search size={11} strokeWidth={2} />
                  no commands {query ? `match “${query}”` : 'yet'}
                </>
              ) : (
                'history is empty in web preview'
              )}
            </div>
          )}
          {rows.map((row) => {
            const failed = row.exit_code != null && row.exit_code !== 0;
            const ok = row.exit_code === 0;
            const isOpen = expanded.has(row.id);
            const hasOutput = Boolean(row.output_excerpt);
            return (
              <div
                key={row.id}
                className={cn(
                  'mb-1.5 overflow-hidden rounded-lg border bg-bg-base/40',
                  failed ? 'border-status-err/30' : 'border-border-subtle',
                )}
              >
                <div className="flex items-center gap-2 px-2.5 py-1.5">
                  <button
                    onClick={() => (hasOutput ? toggle(row.id) : undefined)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title={hasOutput ? 'Toggle output' : undefined}
                  >
                    {hasOutput ? (
                      isOpen ? (
                        <ChevronDown size={12} className="shrink-0 text-fg-subtle" />
                      ) : (
                        <ChevronRight size={12} className="shrink-0 text-fg-subtle" />
                      )
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <StatusBadge ok={ok} failed={failed} code={row.exit_code} />
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-base/90">
                      {row.command}
                    </span>
                  </button>
                  <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                    {formatAge(row.started_at)}
                  </span>
                  <button
                    onClick={() => void pasteInto(row.command)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border-subtle px-1.5 py-0.5 font-display text-2xs text-fg-muted transition-colors hover:border-border-strong hover:text-fg-base"
                    title="Paste into the active terminal"
                  >
                    <CornerDownLeft size={10} strokeWidth={2.2} />
                    Paste
                  </button>
                </div>

                {isOpen && hasOutput && (
                  <div className="border-t border-border-hairline px-2.5 py-2">
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg-muted">
                      {row.output_excerpt}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between border-t border-border-hairline px-3.5 py-1.5 font-display text-2xs text-fg-subtle">
          <span>
            <kbd className="font-mono">esc</kbd> close · click a block to expand output
          </span>
          <span className="tabular-nums">{rows.length} blocks</span>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ ok, failed, code }: { ok: boolean; failed: boolean; code: number | null }) {
  if (ok)
    return (
      <span className="shrink-0 rounded px-1 font-mono text-2xs text-status-ok" title="exit 0">
        ✓
      </span>
    );
  if (failed)
    return (
      <span
        className="shrink-0 rounded bg-status-err/15 px-1 font-mono text-2xs text-status-err"
        title={`exit ${code}`}
      >
        {code}
      </span>
    );
  return (
    <span className="shrink-0 rounded px-1 font-mono text-2xs text-fg-subtle" title="no exit code (no shell integration)">
      ·
    </span>
  );
}

/** "5s", "12m", "3h", "2d" — short relative time markers. */
function formatAge(unixMs: number): string {
  const delta = Math.max(0, Date.now() - unixMs);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
