import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  Eye,
  EyeOff,
  FolderSearch,
  Home,
  RefreshCw,
  Search,
  TerminalSquare,
  AlertCircle,
  X,
} from 'lucide-react';
import {
  fsDefaultRoot,
  fsParent,
  fsPickFolder,
  fsReadDir,
  fsWatchStart,
  fsWatchStop,
  isTauri,
  ptyWrite,
  type FsEntry,
} from '../lib/tauri';
import { fileIcon, folderIcon, MOCHA } from '../lib/fileIcons';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { cn } from '../lib/cn';

interface NodeState {
  loading: boolean;
  error?: string;
  children?: FsEntry[];
  expanded: boolean;
}

export function FileTree() {
  const { root, setRoot, showHidden, toggleHidden } = useFiles();
  const addTab = useWorkspace((s) => s.addTab);
  const openFile = useWorkspace((s) => s.openFile);

  /** Write a snippet into the active terminal — used for click-to-paste path. */
  const pasteIntoActiveTerminal = useCallback(async (snippet: string) => {
    const { tabs, activeTabId } = useWorkspace.getState();
    const active = tabs.find((t) => t.id === activeTabId);
    if (!active?.ptyId) return;
    try {
      await ptyWrite(active.ptyId, snippet);
    } catch {
      /* terminal may be closing */
    }
  }, []);

  /** Map keyed by absolute path → load + expand state. */
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  /** Ref mirrors `nodes` so the watcher callback can read the latest set
   *  of expanded paths without listing nodes in its dep array (which would
   *  tear down the watcher on every load). */
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  /** Top-level error (e.g., resolving the default root). */
  const [rootError, setRootError] = useState<string | null>(null);
  /** Inline filename filter — slides in over the top of the tree when the
   *  search button in the header is clicked. */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Resolve a starting root on first mount (or after explicit reset).
  useEffect(() => {
    if (root) return;
    if (!isTauri) {
      setRoot('/');
      return;
    }
    void fsDefaultRoot()
      .then((r) => setRoot(r))
      .catch((e) => setRootError(String(e)));
  }, [root, setRoot]);

  /** Load children for a given path; cached after the first hit. */
  const ensureLoaded = useCallback(
    async (path: string, force = false) => {
      setNodes((prev) => {
        const cur = prev[path];
        if (!force && cur?.children) return prev;
        return {
          ...prev,
          [path]: { ...(cur ?? { expanded: true }), loading: true, error: undefined },
        };
      });
      try {
        const entries = isTauri ? await fsReadDir(path) : [];
        setNodes((prev) => ({
          ...prev,
          [path]: {
            expanded: prev[path]?.expanded ?? true,
            loading: false,
            children: entries,
          },
        }));
      } catch (err) {
        setNodes((prev) => ({
          ...prev,
          [path]: {
            expanded: prev[path]?.expanded ?? true,
            loading: false,
            error: String(err),
          },
        }));
      }
    },
    [],
  );

  // Initial load of root.
  useEffect(() => {
    if (!root) return;
    void ensureLoaded(root);
  }, [root, ensureLoaded]);

  // Subscribe to filesystem changes under root. Rust debounces to ~150ms;
  // we add a small JS-side coalesce so a burst lands as a single refresh
  // pass over the currently-expanded folders.
  useEffect(() => {
    if (!isTauri || !root) return;
    let active = true;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    let watchId: string | null = null;

    const refreshExpanded = () => {
      pending = null;
      if (!active) return;
      const paths = Object.entries(nodesRef.current)
        .filter(([, st]) => st.expanded && st.children)
        .map(([p]) => p);
      for (const p of paths) {
        void ensureLoaded(p, true);
      }
    };

    const onChange = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(refreshExpanded, 120);
    };

    void fsWatchStart(root, onChange)
      .then((res) => {
        if (!active) {
          // Effect already cleaned up; close the watcher we just opened.
          res.unlisten();
          void fsWatchStop(res.watchId);
          return;
        }
        watchId = res.watchId;
        unlisten = res.unlisten;
      })
      .catch(() => {
        /* Watcher unavailable; tree still works via manual refresh. */
      });

    return () => {
      active = false;
      if (pending) clearTimeout(pending);
      unlisten?.();
      if (watchId) void fsWatchStop(watchId);
    };
  }, [root, ensureLoaded]);

  const toggle = useCallback(
    (path: string) => {
      // Read current state via nodesRef (always up-to-date after commit)
      // to decide whether to kick off a load. We don't read from a closure-
      // captured `nodes` (which would require adding it to the dep array and
      // recreating toggle on every state change) and we don't set a side-effect
      // variable inside the setNodes updater (React 18 doesn't guarantee the
      // updater runs synchronously before the if-check in concurrent/transition
      // mode, which would leave the loading indicator stuck forever).
      const cur = nodesRef.current[path];
      const willExpand = !(cur?.expanded ?? false);
      setNodes((prev) => {
        const prevCur = prev[path];
        const expanded = !(prevCur?.expanded ?? false);
        return {
          ...prev,
          [path]: {
            ...(prevCur ?? {}),
            expanded,
            loading: expanded && !prevCur?.children ? true : (prevCur?.loading ?? false),
            error: undefined,
          },
        };
      });
      if (willExpand && !cur?.children) void ensureLoaded(path);
    },
    [ensureLoaded],
  );

  const goUp = useCallback(async () => {
    if (!root) return;
    try {
      const parent = await fsParent(root);
      if (parent) setRoot(parent);
    } catch {
      /* top of volume — ignore */
    }
  }, [root, setRoot]);

  const goHome = useCallback(async () => {
    try {
      const home = await fsDefaultRoot();
      setRoot(home);
    } catch (e) {
      setRootError(String(e));
    }
  }, [setRoot]);

  /** Open the native folder picker. Falls through silently if cancelled. */
  const pickFolder = useCallback(async () => {
    if (!isTauri) return;
    try {
      const picked = await fsPickFolder(root);
      if (picked) setRoot(picked);
    } catch (e) {
      setRootError(String(e));
    }
  }, [root, setRoot]);

  const refresh = useCallback(() => {
    if (root) void ensureLoaded(root, true);
  }, [root, ensureLoaded]);

  const openInTerminal = useCallback(() => {
    if (!root) return;
    addTab({
      id: `term-${Date.now()}`,
      title: basename(root) || 'shell',
      kind: 'terminal',
    });
    // The terminal component reads the latest root from the store on spawn.
  }, [root, addTab]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      const next = !open;
      if (next) {
        // Defer focus to the next paint so the input is mounted.
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else {
        setSearchQuery('');
      }
      return next;
    });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  const query = searchQuery.trim().toLowerCase();

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header — Finder-style toolbar. Navigation on the left, view +
          search controls on the right. The window title used to live in
          this row but has been moved out so the header reads as pure
          chrome. */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-hairline px-2.5">
        <button
          onClick={goUp}
          disabled={!root}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Parent folder"
          title="Up"
        >
          <ArrowUp size={12} strokeWidth={2.1} />
        </button>
        <button
          onClick={() => void goHome()}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base"
          aria-label="Home"
          title="Home"
        >
          <Home size={12} strokeWidth={2.1} />
        </button>
        <button
          onClick={() => void pickFolder()}
          disabled={!isTauri}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Choose folder"
          title="Choose folder…"
        >
          <FolderSearch size={12} strokeWidth={2.1} />
        </button>

        {/* Flexible spacer so the right cluster anchors to the edge. */}
        <div className="flex-1" />

        <button
          onClick={toggleSearch}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base',
            searchOpen ? 'bg-white/[0.08] text-fg-base' : 'text-fg-muted',
          )}
          aria-label="Filter files"
          aria-pressed={searchOpen}
          title="Filter visible files"
        >
          <Search size={12} strokeWidth={2.1} />
        </button>
        <button
          onClick={toggleHidden}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-md transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base',
            showHidden ? 'text-accent' : 'text-fg-muted',
          )}
          aria-label="Toggle hidden files"
          title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
        >
          {showHidden ? <Eye size={12} strokeWidth={2.1} /> : <EyeOff size={12} strokeWidth={2.1} />}
        </button>
        <button
          onClick={refresh}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={11} strokeWidth={2.1} />
        </button>
        <button
          onClick={openInTerminal}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base"
          aria-label="Open in new terminal"
          title="Open in new terminal"
        >
          <TerminalSquare size={11} strokeWidth={2.1} />
        </button>
      </div>

      {/* Search bar — animates in via grid-rows trick (max-height transitions
          require a hardcoded height; grid-rows 0fr → 1fr lets the inner
          content drive the size). Auto-focused on open, Esc closes. */}
      <div
        className={cn(
          'grid shrink-0 overflow-hidden border-b border-border-hairline transition-[grid-template-rows,opacity] duration-200 ease-apple',
          searchOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
        aria-hidden={!searchOpen}
      >
        <div className="min-h-0">
          <div className="flex items-center gap-1.5 px-2.5 py-2">
            <div className="flex flex-1 items-center gap-1.5 rounded-md border border-white/[0.05] bg-black/[0.22] px-2 py-1 focus-within:border-accent/40 focus-within:shadow-focus">
              <Search size={11} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
              <input
                ref={searchInputRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    closeSearch();
                  }
                }}
                placeholder="Filter files"
                className="selectable min-w-0 flex-1 bg-transparent font-display text-[12px] tracking-tight text-fg-base placeholder:text-fg-subtle focus:outline-none"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-fg-subtle transition-colors hover:bg-white/[0.10] hover:text-fg-base"
                  aria-label="Clear filter"
                >
                  <X size={9} strokeWidth={2.4} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tree */}
      <div className="selectable flex-1 overflow-auto px-1.5 py-2">
        {rootError && <ErrorRow message={rootError} />}
        {!isTauri && (
          <div className="px-2 py-1.5 font-display text-[10.5px] leading-relaxed text-fg-subtle">
            <span className="text-status-warn">web preview</span> · file
            tree is empty. Launch via <span className="font-mono">pnpm tauri:dev</span>.
          </div>
        )}
        {root && (
          <TreeChildren
            parentPath={root}
            depth={0}
            nodes={nodes}
            showHidden={showHidden}
            query={query}
            onToggle={toggle}
            onPaste={pasteIntoActiveTerminal}
            onOpenFile={openFile}
          />
        )}
      </div>
    </div>
  );
}

function TreeChildren({
  parentPath,
  depth,
  nodes,
  showHidden,
  query,
  onToggle,
  onPaste,
  onOpenFile,
}: {
  parentPath: string;
  depth: number;
  nodes: Record<string, NodeState>;
  showHidden: boolean;
  query: string;
  onToggle: (path: string) => void;
  onPaste: (snippet: string) => void | Promise<void>;
  onOpenFile: (path: string) => string;
}) {
  const state = nodes[parentPath];

  // Loading affordance — render at every depth so an expanded subfolder
  // doesn't visually "vanish" during the fsReadDir gap on slow disks /
  // AV-scanned trees. (Previously only depth 0 showed a row, which made
  // nested loads look like the folder was empty.)
  if (state?.loading && !state.children) {
    return <LoadingRow indent={depth} />;
  }
  if (state?.error) {
    return <ErrorRow message={state.error} indent={depth} />;
  }
  if (!state?.children) {
    // State exists (we set expanded=true) but the load hasn't started
    // yet — surface a faint placeholder so something is always visible.
    if (state?.expanded) return <LoadingRow indent={depth} />;
    return null;
  }

  const visible = state.children.filter((e) => {
    if (!showHidden && e.hidden) return false;
    if (!query) return true;
    if (e.name.toLowerCase().includes(query)) return true;
    // Keep ancestors visible when a descendant matches, but only across the
    // already-loaded slice of the tree — unloaded folders aren't searched.
    if (e.kind === 'dir' && hasDescendantMatch(e.path, nodes, query, showHidden)) {
      return true;
    }
    return false;
  });

  if (visible.length === 0) {
    return depth === 0 ? (
      <div className="px-2 py-1.5 font-display text-[10.5px] italic leading-relaxed text-fg-subtle">
        {query ? 'no matches' : 'empty folder'}
      </div>
    ) : null;
  }

  return (
    <ul role="group">
      {visible.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={depth}
          nodes={nodes}
          showHidden={showHidden}
          query={query}
          onToggle={onToggle}
          onPaste={onPaste}
          onOpenFile={onOpenFile}
        />
      ))}
    </ul>
  );
}

/** Does any loaded descendant of `path` match the (already lowercased)
 *  query? Bounded by what's currently expanded in the tree. */
function hasDescendantMatch(
  path: string,
  nodes: Record<string, NodeState>,
  query: string,
  showHidden: boolean,
): boolean {
  const state = nodes[path];
  if (!state?.children) return false;
  for (const child of state.children) {
    if (!showHidden && child.hidden) continue;
    if (child.name.toLowerCase().includes(query)) return true;
    if (child.kind === 'dir' && hasDescendantMatch(child.path, nodes, query, showHidden)) {
      return true;
    }
  }
  return false;
}

function TreeNode({
  entry,
  depth,
  nodes,
  showHidden,
  query,
  onToggle,
  onPaste,
  onOpenFile,
}: {
  entry: FsEntry;
  depth: number;
  nodes: Record<string, NodeState>;
  showHidden: boolean;
  query: string;
  onToggle: (path: string) => void;
  onPaste: (snippet: string) => void | Promise<void>;
  onOpenFile: (path: string) => string;
}) {
  const isDir = entry.kind === 'dir';
  const state = nodes[entry.path];
  const expanded = !!state?.expanded;

  const { Icon, color } = isDir
    ? folderIcon(entry.name, expanded)
    : fileIcon(entry.name);

  const indent = depth * 14;

  // Click semantics:
  //   dir click          → expand/collapse
  //   dir double-click   → `cd` the active terminal into it
  //   file click         → open in the editor pane
  //   file alt/opt-click → paste the path into the active terminal
  const handleClick = (e: React.MouseEvent) => {
    if (isDir) {
      onToggle(entry.path);
      return;
    }
    if (e.altKey) {
      void onPaste(shellQuote(entry.path) + ' ');
      return;
    }
    onOpenFile(entry.path);
  };

  const handleDoubleClick = () => {
    if (isDir) {
      void onPaste(`cd ${shellQuote(entry.path)}\r`);
    }
  };

  const tooltip = isDir
    ? `${entry.path} · click to expand · double-click to cd`
    : `${entry.path} · click to open · ⌥/alt+click to paste path`;

  return (
    <li>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        className={cn(
          'group relative flex h-[26px] w-full items-center gap-1.5 rounded-md pr-2 font-display text-[12.5px] tracking-tight transition-colors duration-100',
          'hover:bg-white/[0.045]',
          entry.hidden && 'opacity-65',
        )}
        style={{ paddingLeft: indent + 6 }}
        aria-expanded={isDir ? expanded : undefined}
        title={tooltip}
      >
        {/* Indent guides */}
        {Array.from({ length: depth }).map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute top-0 h-full w-px bg-white/[0.05]"
            style={{ left: i * 14 + 11 }}
          />
        ))}

        {/* Chevron — invisible for files, keeps row alignment tight */}
        <span className="flex h-3 w-3 shrink-0 items-center justify-center text-fg-subtle">
          {isDir && (
            <ChevronRight
              size={10}
              strokeWidth={2.5}
              className={cn(
                'transition-transform duration-150 ease-apple',
                expanded && 'rotate-90',
              )}
            />
          )}
        </span>

        <Icon
          size={13}
          strokeWidth={1.7}
          style={{ color }}
          className="shrink-0"
        />
        <span
          className={cn(
            'truncate',
            isDir ? 'font-medium text-fg-base/90' : 'text-fg-base/85',
          )}
        >
          {entry.name}
        </span>

        {/* Symlink tag */}
        {entry.kind === 'symlink' && (
          <span
            className="ml-auto font-mono text-[9px] uppercase tracking-widest2"
            style={{ color: MOCHA.overlay1 }}
          >
            ↪
          </span>
        )}
      </button>

      {isDir && expanded && (
        <TreeChildren
          parentPath={entry.path}
          depth={depth + 1}
          nodes={nodes}
          showHidden={showHidden}
          query={query}
          onToggle={onToggle}
          onPaste={onPaste}
          onOpenFile={onOpenFile}
        />
      )}
    </li>
  );
}

function LoadingRow({ indent = 0 }: { indent?: number }) {
  return (
    <div
      className="flex items-center gap-2 py-1.5 pr-3 font-display text-[11px] text-fg-subtle"
      style={{ paddingLeft: indent * 14 + 14 }}
    >
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" />
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.2s' }} />
      <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent" style={{ animationDelay: '0.4s' }} />
    </div>
  );
}

function ErrorRow({ message, indent = 0 }: { message: string; indent?: number }) {
  return (
    <div
      className="flex items-start gap-1.5 py-1.5 pr-2 font-display text-[10.5px] leading-relaxed text-status-err"
      style={{ paddingLeft: indent * 14 + 8 }}
    >
      <AlertCircle size={11} strokeWidth={2} className="mt-0.5 shrink-0" />
      <span className="truncate" title={message}>
        {message}
      </span>
    </div>
  );
}

function basename(p: string): string {
  // Cross-platform basename — Tauri returns native separators.
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * Cross-platform shell quoting. POSIX shells accept double-quoted paths
 * with backslash escaping; cmd.exe also accepts double quotes (it can't
 * escape literal `"` inside them, but our paths never contain one).
 * Skip quoting when the path is plain alphanumerics + safe punctuation.
 */
function shellQuote(p: string): string {
  if (/^[\w./\\:+-]+$/.test(p)) return p;
  return `"${p.replace(/(["\\])/g, '\\$1')}"`;
}
