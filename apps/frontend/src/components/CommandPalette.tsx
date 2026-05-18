import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, History, Search } from 'lucide-react';
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
 * Ctrl+R command-history palette. Modeled on bash's reverse-i-search but
 * surfaced as a centered floating panel (closer to VS Code's command
 * palette UX). Selecting a row writes it into the active terminal — no
 * auto-execute, so the user can edit before pressing Enter themselves.
 */
export function CommandPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<CommandRecord[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refetch on open + on every keystroke. The query is debounced lightly
  // so a fast typer doesn't slam SQLite.
  useEffect(() => {
    if (!open) return;
    if (!isTauri) {
      setRows([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void sessionCommandsRecent(60, query.trim() || null)
        .then((r) => {
          if (!cancelled) {
            setRows(r);
            setSelected(0);
          }
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query]);

  // Focus the input when the palette opens.
  useEffect(() => {
    if (open) {
      // requestAnimationFrame so the input is mounted before focusing.
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setSelected(0);
    }
  }, [open]);

  const pickInto = useCallback(
    async (cmd: string) => {
      const { tabs, activeTabId } = useWorkspace.getState();
      const active = tabs.find((t) => t.id === activeTabId);
      onClose();
      if (!active?.ptyId) return;
      try {
        await ptyWrite(active.ptyId, cmd);
      } catch {
        /* terminal closing */
      }
    },
    [onClose],
  );

  const visible = useMemo(() => rows.slice(0, 60), [rows]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = visible[selected];
      if (pick) void pickInto(pick.command);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, visible.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[14vh] flex w-[640px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <History size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="search command history…"
            className="flex-1 bg-transparent font-display text-[13px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="font-mono text-[10px] text-fg-subtle">esc</kbd>
        </div>

        <div className="max-h-[420px] overflow-y-auto py-1">
          {visible.length === 0 && (
            <div className="flex items-center justify-center gap-1.5 px-4 py-6 font-display text-[11.5px] italic text-fg-subtle">
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
          {visible.map((row, idx) => (
            <button
              key={row.id}
              onMouseEnter={() => setSelected(idx)}
              onClick={() => void pickInto(row.command)}
              className={cn(
                'flex w-full items-start gap-2.5 px-3.5 py-1.5 text-left transition-colors',
                idx === selected
                  ? 'bg-accent-soft ring-1 ring-inset ring-border-strong'
                  : 'hover:bg-white/[0.045]',
              )}
            >
              <span className="mt-0.5 w-[42px] shrink-0 truncate font-mono text-[10px] text-fg-subtle">
                {formatAge(row.started_at)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-base/90">
                {row.command}
              </span>
              {idx === selected && (
                <CornerDownLeft size={11} strokeWidth={2.1} className="mt-1 shrink-0 text-fg-muted" />
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border-hairline px-3.5 py-1.5 font-display text-[10px] text-fg-subtle">
          <span>
            <kbd className="font-mono">↑↓</kbd> select · <kbd className="font-mono">return</kbd> paste · <kbd className="font-mono">esc</kbd> close
          </span>
          <span className="tabular-nums">{visible.length} commands</span>
        </div>
      </div>
    </div>
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
  const d = Math.floor(h / 24);
  return `${d}d`;
}
