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
    <aside className="material-sidebar flex h-full w-[240px] shrink-0 flex-col border-r border-border-hairline">
      <div className="flex items-center gap-1.5 border-b border-border-hairline px-3 py-2 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
        <Users size={11} strokeWidth={2.1} />
        <span>Authors</span>
        <span className="ml-auto tabular-nums normal-case tracking-normal text-fg-subtle/70">
          {authors.length}
        </span>
      </div>

      <div className="flex items-center gap-1.5 border-b border-border-hairline px-2.5 py-1.5">
        <Search size={10} strokeWidth={2.2} className="text-fg-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter authors…"
          className="flex-1 bg-transparent font-display text-[11.5px] text-fg-base placeholder:text-fg-subtle/70 focus:outline-none"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {selected.size > 0 && (
        <button
          onClick={onClear}
          className="border-b border-border-hairline px-3 py-1.5 text-left font-display text-[10.5px] text-fg-subtle transition-colors hover:bg-white/[0.04] hover:text-fg-base"
        >
          Clear filter ({selected.size} selected)
        </button>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1">
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
                'group flex items-center gap-2 px-3 py-1.5 text-left transition-colors',
                isSel
                  ? 'bg-accent/[0.14] text-fg-base'
                  : 'text-fg-muted hover:bg-white/[0.05] hover:text-fg-base',
              )}
              title={`${a.name} <${a.email}>`}
            >
              <Avatar name={a.name} email={a.email} selected={isSel} />
              <span className="min-w-0 flex-1 truncate font-display text-[12px]">{a.name || a.email}</span>
              <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-fg-subtle">
                {a.commits}
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-border-hairline px-3 py-1.5 font-display text-[10px] tabular-nums text-fg-subtle">
        {total} {total === 1 ? 'commit' : 'commits'} total
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
        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-display text-[9px] font-semibold text-black/80 ring-1 ring-white/10',
        selected && 'ring-2 ring-accent/60',
      )}
      style={{ background: color }}
      aria-hidden
    >
      {initials}
    </span>
  );
}
