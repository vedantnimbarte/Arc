import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Loader2,
  Replace,
  Search as SearchIcon,
  X,
} from 'lucide-react';
import {
  fsReplaceApply,
  fsReplaceFind,
  fsSearch,
  isTauri,
  type ReplaceMatch,
  type SearchHit,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { useSettings } from '../state/settings';
import { useWorkspace } from '../state/workspace';
import { askConfirm } from '../state/confirm';
import { toast, toastError } from '../state/toast';
import { fileIcon } from '../lib/fileIcons';
import { cn } from '../lib/cn';
import { isRemotePath } from '../lib/remote';

const SEARCH_LIMIT = 200;
const DEBOUNCE_MS = 180;

/** The subset both search and replace results share, so one renderer covers
 *  both modes. */
interface Row {
  path: string;
  line: number;
  snippet: string;
}

const toRows = (hits: Array<SearchHit | ReplaceMatch>): Row[] =>
  hits.map((h) => ({ path: h.path, line: h.line, snippet: h.snippet }));

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
  const ignoreDirs = useSettings((s) => s.searchIgnoreDirs);

  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // ─── replace mode ──────────────────────────────────────────────────────
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [applying, setApplying] = useState(false);
  /** Files the user opted out of before applying. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A file excluded from one result set means nothing to the next one.
  useEffect(() => setExcluded(new Set()), [query, caseSensitive, replaceOpen]);

  useEffect(() => {
    const q = query.trim();
    // Search indexes the local disk; a remote workspace has nothing here to
    // walk. The empty-state below says so rather than spinning forever.
    if (!q || !root || !isTauri || isRemotePath(root)) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const handle = window.setTimeout(() => {
      // Replace mode searches literally, not through the BM25 index. The
      // list has to be exactly what a replace would rewrite — showing
      // relevance-ranked, token-matched hits and then replacing literally
      // would mean acting on a set the user never saw.
      const search = replaceOpen
        ? fsReplaceFind(root, q, caseSensitive, SEARCH_LIMIT, ignoreDirs)
        : fsSearch(root, q, SEARCH_LIMIT, ignoreDirs);
      search
        .then((r) => setRows(toRows(r)))
        .catch(() => setRows([]))
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, root, ignoreDirs, replaceOpen, caseSensitive]);

  const groups = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const hit of rows) {
      const list = m.get(hit.path);
      if (list) list.push(hit);
      else m.set(hit.path, [hit]);
    }
    return [...m.entries()];
  }, [rows]);

  const targetFiles = useMemo(
    () => groups.map(([path]) => path).filter((p) => !excluded.has(p)),
    [groups, excluded],
  );

  const applyReplace = async () => {
    const q = query.trim();
    if (!root || !q || targetFiles.length === 0) return;
    // Bulk rewrite with no undo inside ARC — the confirm names the exact
    // blast radius, and the toast points at the only real undo there is.
    const ok = await askConfirm({
      title: `Replace ${rows.length} occurrence${rows.length === 1 ? '' : 's'}?`,
      body: `“${q}” becomes “${replacement}” across ${targetFiles.length} file${
        targetFiles.length === 1 ? '' : 's'
      }. This writes to disk and cannot be undone from ARC — review it with git afterwards.`,
      confirmLabel: 'replace all',
      destructive: true,
    });
    if (!ok) return;
    setApplying(true);
    try {
      const summary = await fsReplaceApply(root, targetFiles, q, replacement, caseSensitive);
      toast(
        `Replaced ${summary.replacements} occurrence${
          summary.replacements === 1 ? '' : 's'
        } in ${summary.files_changed} file${summary.files_changed === 1 ? '' : 's'}`,
      );
      // Re-run the search so the list reflects what's on disk now.
      const next = await fsReplaceFind(root, q, caseSensitive, SEARCH_LIMIT, ignoreDirs);
      setRows(toRows(next));
    } catch (err) {
      toastError(`Replace failed: ${err}`);
    } finally {
      setApplying(false);
    }
  };

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
      <div className="shrink-0 border-b border-border-hairline px-2.5 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setReplaceOpen((v) => !v)}
            title={replaceOpen ? 'Hide replace' : 'Show replace'}
            aria-label={replaceOpen ? 'Hide replace' : 'Show replace'}
            aria-expanded={replaceOpen}
            className={cn(
              'shrink-0 rounded p-1 transition-colors',
              replaceOpen
                ? 'bg-surface-2 text-fg-base'
                : 'text-fg-subtle hover:bg-surface-1 hover:text-fg-muted',
            )}
          >
            {replaceOpen ? (
              <ChevronDown size={11} strokeWidth={2.2} />
            ) : (
              <ChevronRight size={11} strokeWidth={2.2} />
            )}
          </button>
          <div className="flex flex-1 items-center gap-1.5 rounded-md border border-edge-1 bg-scrim-1 px-2 py-1 focus-within:border-accent/40 focus-within:shadow-focus">
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
              placeholder={replaceOpen ? 'Find (exact text)' : 'Search in files'}
              className="selectable min-w-0 flex-1 bg-transparent font-display text-sm tracking-tight text-fg-base placeholder:text-fg-subtle focus:outline-none"
            />
            {replaceOpen && (
              <button
                type="button"
                onClick={() => setCaseSensitive((v) => !v)}
                title="Match case"
                aria-label="Match case"
                aria-pressed={caseSensitive}
                className={cn(
                  'shrink-0 rounded p-0.5 transition-colors',
                  caseSensitive
                    ? 'bg-surface-3 text-fg-base'
                    : 'text-fg-subtle hover:text-fg-muted',
                )}
              >
                <CaseSensitive size={11} strokeWidth={2.1} />
              </button>
            )}
            {query && (
              <button
                onClick={() => setQuery('')}
                className="flex h-4 w-4 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg-base"
                aria-label="Clear search"
              >
                <X size={9} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>

        {replaceOpen && (
          <div className="mt-1.5 flex items-center gap-1.5 pl-[26px]">
            <div className="flex flex-1 items-center gap-1.5 rounded-md border border-edge-1 bg-scrim-1 px-2 py-1 focus-within:border-accent/40 focus-within:shadow-focus">
              <Replace size={11} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder="Replace with"
                aria-label="Replace with"
                className="selectable min-w-0 flex-1 bg-transparent font-display text-sm tracking-tight text-fg-base placeholder:text-fg-subtle focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => void applyReplace()}
              disabled={applying || loading || targetFiles.length === 0 || !q}
              title={
                targetFiles.length === 0
                  ? 'Nothing to replace'
                  : `Replace in ${targetFiles.length} file(s)`
              }
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-border-subtle px-2 py-1 font-display text-2xs text-fg-base transition-colors hover:border-border-strong hover:bg-surface-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {applying && <Loader2 size={10} strokeWidth={2.2} className="animate-spin" />}
              Replace all
            </button>
          </div>
        )}
      </div>

      {/* Result count */}
      {q && (
        <div className="shrink-0 border-b border-border-hairline px-3 py-1.5 font-mono text-2xs uppercase tracking-widest2 text-fg-subtle">
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
          <p className="px-3 py-2 font-display text-2xs leading-relaxed text-fg-subtle">
            <span className="text-status-warn">web preview</span> — search needs the
            desktop app.
          </p>
        )}
        {isTauri && isRemotePath(root) && (
          <p className="px-3 py-2 font-display text-xs leading-relaxed text-fg-subtle">
            <span className="text-status-warn">remote workspace</span> — content search
            runs against the local index, which doesn&rsquo;t cover remote files. Use{' '}
            <code className="font-mono text-2xs">grep</code> in an SSH tab.
          </p>
        )}
        {isTauri && !isRemotePath(root) && !q && (
          <p className="px-3 py-2 font-display text-xs leading-relaxed text-fg-subtle">
            Type to search file contents across the workspace.
          </p>
        )}
        {groups.map(([path, hits]) => {
          const isCollapsed = collapsed.has(path);
          const isExcluded = excluded.has(path);
          const { Icon, color } = fileIcon(basename(path));
          const dir = relDir(path, root);
          return (
            <div key={path} className={cn('mb-0.5', isExcluded && 'opacity-40')}>
              <div className="group flex w-full items-center gap-1 rounded-md pr-1 transition-colors hover:bg-surface-1">
                <button
                  type="button"
                  onClick={() => toggleGroup(path)}
                  className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-left"
                  title={path}
                >
                  {isCollapsed ? (
                    <ChevronRight size={11} strokeWidth={2.2} className="shrink-0 text-fg-subtle" />
                  ) : (
                    <ChevronDown size={11} strokeWidth={2.2} className="shrink-0 text-fg-subtle" />
                  )}
                  <Icon size={12} strokeWidth={1.7} style={{ color }} className="shrink-0" />
                  <span
                    className={cn(
                      'truncate font-display text-sm font-medium tracking-tight text-fg-base/90',
                      isExcluded && 'line-through',
                    )}
                  >
                    {basename(path)}
                  </span>
                  {dir && (
                    <span className="truncate font-display text-2xs text-fg-subtle/85">{dir}</span>
                  )}
                  <span className="ml-auto shrink-0 rounded-full bg-surface-1 px-1.5 font-mono text-2xs tabular-nums text-fg-muted">
                    {hits.length}
                  </span>
                </button>
                {/* Opting a file out of the replace. Only meaningful in
                    replace mode — in search mode there is nothing to opt out
                    of, so the control isn't there to confuse. */}
                {replaceOpen && (
                  <button
                    type="button"
                    onClick={() =>
                      setExcluded((prev) => {
                        const next = new Set(prev);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    title={isExcluded ? 'Include in replace' : 'Exclude from replace'}
                    aria-label={isExcluded ? 'Include in replace' : 'Exclude from replace'}
                    aria-pressed={isExcluded}
                    className="shrink-0 rounded p-0.5 text-fg-subtle opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg-base group-hover:opacity-100 aria-pressed:opacity-100"
                  >
                    <X size={10} strokeWidth={2.4} />
                  </button>
                )}
              </div>
              {!isCollapsed &&
                hits.map((hit, i) => (
                  <button
                    key={`${hit.line}-${i}`}
                    type="button"
                    onClick={() => openFile(hit.path, undefined, { line: hit.line })}
                    className="group flex w-full items-baseline gap-2 rounded-md py-[3px] pl-7 pr-2 text-left transition-colors hover:bg-surface-1"
                    title={`${path}:${hit.line}`}
                  >
                    <span className="w-8 shrink-0 text-right font-mono text-2xs tabular-nums text-fg-subtle/70">
                      {hit.line}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted group-hover:text-fg-base/90">
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
