import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, File, FilePlus, FolderPlus, Search } from 'lucide-react';
import { fsListFiles, fsWriteFile, fsCreateDir, isTauri, type FileItem } from '../lib/tauri';
import { useFiles } from '../state/files';
import { useSettings } from '../state/settings';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * ⌘P-style file quick-open. Matches the query against file names (and their
 * relative paths) under the workspace root — not file contents — and opens the
 * picked file as an editor tab. Honors the search-ignore-dirs setting.
 */
export function SearchPalette({ open, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<FileItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const root = useFiles((s) => s.root);
  const openFile = useWorkspace((s) => s.openFile);
  const ignoreDirs = useSettings((s) => s.searchIgnoreDirs);

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
      void fsListFiles(root, q, 50, ignoreDirs)
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
  }, [open, query, root, ignoreDirs]);

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
    (hit: FileItem) => {
      openFile(hit.path);
      onClose();
    },
    [openFile, onClose],
  );

  const visible = useMemo(() => rows.slice(0, 50), [rows]);

  // The query doubles as the name/relative path for creation (VSCode-style).
  const name = query.trim();
  const creatable = !!name && !!root && isTauri;

  const createFile = useCallback(async () => {
    if (!name || !root) return;
    const sep = root.includes('\\') ? '\\' : '/';
    const full = `${root}${sep}${name}`;
    try {
      // Nested names (e.g. "src/foo.ts") need their parent dirs; create_dir_all
      // makes any missing ancestors.
      const cut = Math.max(full.lastIndexOf('/'), full.lastIndexOf('\\'));
      const parent = full.slice(0, cut);
      if (parent && parent !== root) await fsCreateDir(parent);
      await fsWriteFile(full, '');
      openFile(full);
    } catch (e) {
      console.error('[SearchPalette] create file failed:', e);
    }
    onClose();
  }, [name, root, openFile, onClose]);

  const createFolder = useCallback(async () => {
    if (!name || !root) return;
    const sep = root.includes('\\') ? '\\' : '/';
    try {
      await fsCreateDir(`${root}${sep}${name}`);
    } catch (e) {
      console.error('[SearchPalette] create folder failed:', e);
    }
    onClose();
  }, [name, root, onClose]);

  // Create rows sit after the file hits; keyboard selection spans both.
  const createBase = visible.length;
  const total = creatable ? visible.length + 2 : visible.length;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selected < visible.length) {
        const hit = visible[selected];
        if (hit) pick(hit);
      } else if (creatable && selected === createBase) {
        void createFile();
      } else if (creatable) {
        void createFolder();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, total - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[14vh] flex w-[680px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-3.5 py-2.5">
          <Search size={13} strokeWidth={2.1} className="text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="search files by name…"
            className="flex-1 bg-transparent font-display text-base text-fg-base placeholder:text-fg-subtle focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" />
          )}
          <kbd className="font-mono text-2xs text-fg-subtle">esc</kbd>
        </div>

        <div className="max-h-[480px] overflow-y-auto py-1">
          {!query.trim() && (
            <div className="px-4 py-6 text-center font-display text-xs italic text-fg-subtle">
              type to search files in {root ?? 'the workspace'}
            </div>
          )}
          {query.trim() && !loading && visible.length === 0 && !creatable && (
            <div className="px-4 py-6 text-center font-display text-xs italic text-fg-subtle">
              no matches for “{query}”
            </div>
          )}
          {visible.map((hit, idx) => (
            <button
              key={hit.path}
              onMouseEnter={() => setSelected(idx)}
              onClick={() => pick(hit)}
              className={cn(
                'flex w-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-colors',
                idx === selected
                  ? 'bg-accent-soft ring-1 ring-inset ring-border-strong'
                  : 'hover:bg-surface-1',
              )}
            >
              <File size={11} strokeWidth={1.8} className="shrink-0 text-fg-subtle" />
              <span className="shrink-0 truncate font-display text-sm font-medium text-fg-base/90">
                {hit.name}
              </span>
              <span className="truncate font-mono text-2xs text-fg-subtle">
                {parentDir(hit.rel)}
              </span>
              {idx === selected && (
                <CornerDownLeft size={11} strokeWidth={2.1} className="ml-auto shrink-0 text-fg-muted" />
              )}
            </button>
          ))}

          {creatable && (
            <div className={visible.length ? 'mt-1 border-t border-border-hairline pt-1' : ''}>
              {(
                [
                  { idx: createBase, Icon: FilePlus, verb: 'Create file', run: createFile },
                  { idx: createBase + 1, Icon: FolderPlus, verb: 'Create folder', run: createFolder },
                ] as const
              ).map(({ idx, Icon, verb, run }) => (
                <button
                  key={verb}
                  onMouseEnter={() => setSelected(idx)}
                  onClick={() => void run()}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors',
                    idx === selected
                      ? 'bg-accent-soft ring-1 ring-inset ring-border-strong'
                      : 'hover:bg-surface-1',
                  )}
                >
                  <Icon size={12} strokeWidth={1.8} className="shrink-0 text-fg-subtle" />
                  <span className="shrink-0 font-display text-sm font-medium text-fg-base/90">
                    {verb}
                  </span>
                  <span className="truncate font-mono text-xs text-fg-muted">{name}</span>
                  {idx === selected && (
                    <CornerDownLeft size={11} strokeWidth={2.1} className="ml-auto shrink-0 text-fg-muted" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border-hairline px-3.5 py-1.5 font-display text-2xs text-fg-subtle">
          <span>
            <kbd className="font-mono">↑↓</kbd> select · <kbd className="font-mono">return</kbd> open · <kbd className="font-mono">esc</kbd> close
          </span>
          <span className="tabular-nums">{visible.length} files</span>
        </div>
      </div>
    </div>
  );
}

/** The containing folder of a relative path ("src/a/b.ts" -> "src/a"),
 *  or "" for a file at the workspace root. */
function parentDir(rel: string): string {
  const cut = rel.lastIndexOf('/');
  return cut === -1 ? '' : rel.slice(0, cut);
}
