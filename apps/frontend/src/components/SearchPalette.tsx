import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, File, Search } from 'lucide-react';
import { fsSearch, isTauri, type SearchHit } from '../lib/tauri';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * ⌘P-style file content search. Walks the current workspace root,
 * substring-matches the query against text files, opens the picked
 * result as an editor tab.
 *
 * V0: substring + filename-boost scoring. No persistent index.
 */
export function SearchPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const root = useFiles((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);

  // Debounce searches; the walk is fast but firing one per keystroke on
  // a slow disk is wasteful.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (!q || !root || !isTauri) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(() => {
      void fsSearch(root, q, 50)
        .then((r) => {
          if (!cancelled) {
            setRows(r);
            setSelected(0);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setRows([]);
            setLoading(false);
          }
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, query, root]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setSelected(0);
      setRows([]);
    }
  }, [open]);

  const pick = useCallback(
    (hit: SearchHit) => {
      openFile(hit.path);
      onClose();
    },
    [openFile, onClose],
  );

  const visible = useMemo(() => rows.slice(0, 50), [rows]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = visible[selected];
      if (hit) pick(hit);
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
        className="material-sheet mt-[14vh] flex w-[680px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <Search size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="search files in workspace…"
            className="flex-1 bg-transparent font-display text-[13px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" />
          )}
          <kbd className="font-mono text-[10px] text-fg-subtle">esc</kbd>
        </div>

        <div className="max-h-[480px] overflow-y-auto py-1">
          {!query.trim() && (
            <div className="px-4 py-6 text-center font-display text-[11.5px] italic text-fg-subtle">
              type to search files in {root ?? 'the workspace'}
            </div>
          )}
          {query.trim() && !loading && visible.length === 0 && (
            <div className="px-4 py-6 text-center font-display text-[11.5px] italic text-fg-subtle">
              no matches for “{query}”
            </div>
          )}
          {visible.map((hit, idx) => (
            <button
              key={`${hit.path}:${hit.line}`}
              onMouseEnter={() => setSelected(idx)}
              onClick={() => pick(hit)}
              className={cn(
                'flex w-full items-start gap-2.5 px-3.5 py-1.5 text-left transition-colors',
                idx === selected
                  ? 'bg-accent-soft ring-1 ring-inset ring-border-strong'
                  : 'hover:bg-white/[0.045]',
              )}
            >
              <File size={11} strokeWidth={1.8} className="mt-1 shrink-0 text-fg-subtle" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="truncate font-display text-[12.5px] font-medium text-fg-base/90">
                    {hit.name}
                  </span>
                  <span className="truncate font-mono text-[10px] text-fg-subtle">
                    {trimPath(hit.path, root)}:{hit.line}
                  </span>
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-fg-muted">
                  {hit.snippet || '…'}
                </div>
              </div>
              {idx === selected && (
                <CornerDownLeft size={11} strokeWidth={2.1} className="mt-1.5 shrink-0 text-fg-muted" />
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border-hairline px-3.5 py-1.5 font-display text-[10px] text-fg-subtle">
          <span>
            <kbd className="font-mono">↑↓</kbd> select · <kbd className="font-mono">return</kbd> open · <kbd className="font-mono">esc</kbd> close
          </span>
          <span className="tabular-nums">{visible.length} hits</span>
        </div>
      </div>
    </div>
  );
}

/** Shorten an absolute path by stripping the workspace root prefix. */
function trimPath(p: string, root: string | null): string {
  if (!root) return p;
  if (p.startsWith(root)) {
    return p.slice(root.length).replace(/^[\\/]+/, '');
  }
  return p;
}
