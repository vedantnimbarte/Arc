import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Search as SearchIcon, X } from 'lucide-react';
import { fsSearch, isTauri, type SearchHit } from '../lib/tauri';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { fileIcon } from '../lib/fileIcons';
import { cn } from '../lib/cn';

const SEARCH_LIMIT = 200;
const DEBOUNCE_MS = 180;

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Repo-relative directory of a path, for the dim line under the filename. */
function relDir(path: string, root: string | null): string {
  let p = path;
  if (root && p.startsWith(root)) p = p.slice(root.length);
  p = p.replace(/^[\\/]+/, '');
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx > 0 ? p.slice(0, idx) : '';
}

/** Split a snippet around the (case-insensitive) query so the match can be
 *  emphasized without dangerously injecting HTML. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    const hit = lower.indexOf(q, i);
    if (hit < 0) {
      out.push(text.slice(i));
      break;
    }
    if (hit > i) out.push(text.slice(i, hit));
    out.push(
      <mark key={key++} className="rounded-sm bg-accent/25 px-px text-accent-bright">
        {text.slice(hit, hit + q.length)}
      </mark>,
    );
    i = hit + q.length;
  }
  return out;
}

/**
 * Docked full-text search. Reuses the tantivy-backed `fs_search` the ⌘P
 * palette uses, but lives in the sidebar with results grouped + collapsible
 * per file. Clicking a hit opens the file scrolled to that line.
 */
export function SearchView() {
  const root = useFiles((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);

  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q || !root || !isTauri) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = window.setTimeout(() => {
      fsSearch(root, q, SEARCH_LIMIT)
        .then((r) => setRows(r))
        .catch(() => setRows([]))
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, root]);

  const groups = useMemo(() => {
    const m = new Map<string, SearchHit[]>();
    for (const hit of rows) {
      const list = m.get(hit.path);
      if (list) list.push(hit);
      else m.set(hit.path, [hit]);
    }
    return [...m.entries()];
  }, [rows]);

  const toggleGroup = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const q = query.trim();

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header / input */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-hairline px-2.5">
        <div className="flex flex-1 items-center gap-1.5 rounded-md border border-white/[0.05] bg-black/[0.22] px-2 py-1 focus-within:border-accent/40 focus-within:shadow-focus">
          <SearchIcon size={11} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setQuery('');
              }
            }}
            placeholder="Search in files"
            className="selectable min-w-0 flex-1 bg-transparent font-display text-[12px] tracking-tight text-fg-base placeholder:text-fg-subtle focus:outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="flex h-4 w-4 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-white/[0.10] hover:text-fg-base"
              aria-label="Clear search"
            >
              <X size={9} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>

      {/* Result count */}
      {q && (
        <div className="shrink-0 border-b border-border-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest2 text-fg-subtle">
          {loading
            ? 'searching…'
            : rows.length === 0
              ? 'no results'
              : `${rows.length} result${rows.length === 1 ? '' : 's'} · ${groups.length} file${groups.length === 1 ? '' : 's'}`}
        </div>
      )}

      {/* Results */}
      <div className="selectable flex-1 overflow-auto py-1">
        {!isTauri && (
          <p className="px-3 py-2 font-display text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-status-warn">web preview</span> — search needs the
            desktop app.
          </p>
        )}
        {isTauri && !q && (
          <p className="px-3 py-2 font-display text-[11px] leading-relaxed text-fg-subtle">
            Type to search file contents across the workspace.
          </p>
        )}
        {groups.map(([path, hits]) => {
          const isCollapsed = collapsed.has(path);
          const { Icon, color } = fileIcon(basename(path));
          const dir = relDir(path, root);
          return (
            <div key={path} className="mb-0.5">
              <button
                type="button"
                onClick={() => toggleGroup(path)}
                className="group flex w-full items-center gap-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-white/[0.04]"
                title={path}
              >
                {isCollapsed ? (
                  <ChevronRight size={11} strokeWidth={2.2} className="shrink-0 text-fg-subtle" />
                ) : (
                  <ChevronDown size={11} strokeWidth={2.2} className="shrink-0 text-fg-subtle" />
                )}
                <Icon size={12} strokeWidth={1.7} style={{ color }} className="shrink-0" />
                <span className="truncate font-display text-[12px] font-medium tracking-tight text-fg-base/90">
                  {basename(path)}
                </span>
                {dir && (
                  <span className="truncate font-display text-[10px] text-fg-subtle/85">{dir}</span>
                )}
                <span className="ml-auto shrink-0 rounded-full bg-white/[0.05] px-1.5 font-mono text-[9.5px] tabular-nums text-fg-muted">
                  {hits.length}
                </span>
              </button>
              {!isCollapsed &&
                hits.map((hit, i) => (
                  <button
                    key={`${hit.line}-${i}`}
                    type="button"
                    onClick={() => openFile(hit.path, undefined, { line: hit.line })}
                    className="group flex w-full items-baseline gap-2 rounded-md py-[3px] pl-7 pr-2 text-left transition-colors hover:bg-white/[0.045]"
                    title={`${path}:${hit.line}`}
                  >
                    <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-fg-subtle/70">
                      {hit.line}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted group-hover:text-fg-base/90">
                      {highlight(hit.snippet, q)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
