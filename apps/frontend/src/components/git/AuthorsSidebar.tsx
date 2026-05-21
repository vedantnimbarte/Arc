import { useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { GitAuthorInfo } from '../../lib/tauri';

interface Props {
  authors: GitAuthorInfo[];
  /** Set of selected author "name <email>" keys (matches the chip key). */
  selected: Set<string>;
  /** Toggles an author in/out of the selection set. */
  onToggle: (author: GitAuthorInfo) => void;
  onClear: () => void;
  loading: boolean;
}

/** Stable key for selection — name+email together survives same-named authors. */
export function authorKey(a: { name: string; email: string }): string {
  return `${a.name}<${a.email}>`;
}

export function AuthorsSidebar({ authors, selected, onToggle, onClear, loading }: Props) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return authors;
    return authors.filter(
      (a) => a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q),
    );
  }, [authors, query]);

  const total = useMemo(
    () => authors.reduce((sum, a) => sum + a.commits, 0),
    [authors],
  );

  return (
    <aside className="material-sidebar flex h-full w-[252px] shrink-0 flex-col border-r border-border-subtle">
      <div className="flex items-center gap-1.5 px-4 pb-2 pt-3 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
        <Users size={11} strokeWidth={2.1} />
        <span>Authors</span>
        <span className="ml-auto rounded-full bg-white/[0.04] px-1.5 py-[1px] font-mono text-[9.5px] tabular-nums normal-case tracking-normal text-fg-muted">
          {authors.length}
        </span>
      </div>

      <div className="px-3 pb-2">
        <div className="group flex items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1.5 ring-1 ring-inset ring-white/[0.05] transition-all duration-200 focus-within:bg-white/[0.06] focus-within:ring-accent/30">
          <Search size={11} strokeWidth={2.2} className="text-fg-subtle transition-colors group-focus-within:text-accent-bright" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter authors…"
            className="flex-1 bg-transparent font-display text-[11.5px] text-fg-base placeholder:text-fg-subtle/70 focus:outline-none"
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-fg-subtle transition-colors hover:text-fg-base"
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="px-3 pb-2 animate-fade-in">
          <button
            onClick={onClear}
            className={cn(
              'flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left font-display text-[10.5px] transition-all duration-200',
              'bg-accent-soft text-fg-muted ring-1 ring-inset ring-accent/15',
              'hover:bg-accent/[0.12] hover:text-fg-base',
            )}
          >
            <span>Clear filter</span>
            <span className="font-mono tabular-nums text-fg-subtle">{selected.size}</span>
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pb-2">
        {loading && (
          <div className="px-3 py-4 font-display text-[11px] text-fg-subtle">loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="px-3 py-4 font-display text-[11px] text-fg-subtle">
            {authors.length === 0 ? 'no commits yet' : `no match for "${query}"`}
          </div>
        )}
        {filtered.map((a) => {
          const key = authorKey(a);
          const isSel = selected.has(key);
          return (
            <button
              key={key}
              onClick={() => onToggle(a)}
              className={cn(
                'group relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-all duration-150',
                isSel
                  ? 'bg-gradient-to-r from-accent/[0.16] to-accent/[0.06] text-fg-base ring-1 ring-inset ring-accent/20'
                  : 'text-fg-muted hover:bg-white/[0.045] hover:text-fg-base',
              )}
              title={`${a.name} <${a.email}>`}
            >
              <Avatar name={a.name} email={a.email} selected={isSel} />
              <span className="min-w-0 flex-1 truncate font-display text-[12px]">{a.name || a.email}</span>
              <span
                className={cn(
                  'shrink-0 rounded-full px-1.5 py-[1px] font-mono text-[9.5px] tabular-nums transition-colors',
                  isSel ? 'bg-white/[0.08] text-fg-base' : 'text-fg-subtle group-hover:bg-white/[0.04]',
                )}
              >
                {a.commits}
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-border-subtle px-4 py-2 font-display text-[10px] tabular-nums text-fg-subtle">
        <span className="text-fg-muted">{total}</span>{' '}
        <span className="opacity-70">{total === 1 ? 'commit' : 'commits'} total</span>
      </div>
    </aside>
  );
}

// Stable colour per author derived from name+email. Same logic used by
// the commit list dots so the two views stay visually linked.
const AVATAR_PALETTE = [
  '#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5',
  '#89dceb', '#74c7ec', '#89b4fa', '#cba6f7', '#f5c2e7',
];

export function colorForAuthor(name: string, email: string): string {
  const seed = `${name}|${email}`;
  let h = 5381;
  for (let i = 0; i < seed.length; i += 1) {
    h = ((h << 5) + h + seed.charCodeAt(i)) >>> 0;
  }
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

function Avatar({ name, email, selected }: { name: string; email: string; selected: boolean }) {
  const initials = (name || email).trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '·';
  const color = colorForAuthor(name, email);
  return (
    <span
      className={cn(
        'relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-display text-[9.5px] font-semibold text-black/85 transition-all duration-200',
        selected
          ? 'ring-2 ring-accent/50 ring-offset-1 ring-offset-bg-base shadow-glow-sm'
          : 'ring-1 ring-inset ring-black/20',
      )}
      style={{
        background: `linear-gradient(135deg, ${color} 0%, ${color}dd 100%)`,
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
