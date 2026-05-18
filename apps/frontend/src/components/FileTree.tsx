import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  Eye,
  EyeOff,
  FolderSearch,
  Home,
  RefreshCw,
  TerminalSquare,
  AlertCircle,
} from 'lucide-react';
import {
  fsDefaultRoot,
  fsParent,
  fsPickFolder,
  fsReadDir,
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
  /** Top-level error (e.g., resolving the default root). */
  const [rootError, setRootError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [pathDraft, setPathDraft] = useState('');

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

  const toggle = useCallback(
    (path: string) => {
      setNodes((prev) => {
        const cur = prev[path];
        const expanded = !(cur?.expanded ?? false);
        return { ...prev, [path]: { ...(cur ?? { loading: false }), expanded } };
      });
      // Lazy-load on first expand.
      const cur = nodes[path];
      if (!cur?.children) void ensureLoaded(path);
    },
    [nodes, ensureLoaded],
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

  const submitPath = useCallback(() => {
    const next = pathDraft.trim();
    if (next) setRoot(next);
    setEditing(false);
  }, [pathDraft, setRoot]);

  const rootLabel = useMemo(() => (root ? basename(root) || root : '—'), [root]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header — Finder-style. The clickable title becomes a path input
          on click so the user can paste/type any directory. */}
      <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border-hairline px-3">
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

        <div className="ml-0.5 min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={submitPath}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPath();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full rounded-md border border-accent/40 bg-bg-base/70 px-1.5 py-0.5 font-mono text-[11px] text-fg-base outline-none shadow-focus"
            />
          ) : (
            <button
              onClick={() => {
                setPathDraft(root ?? '');
                setEditing(true);
              }}
              className="block w-full truncate rounded-md px-1.5 py-0.5 text-left font-display text-[12.5px] font-semibold tracking-tight text-fg-base hover:bg-white/[0.04]"
              title={root ?? ''}
            >
              {rootLabel}
            </button>
          )}
        </div>

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
  onToggle,
  onPaste,
  onOpenFile,
}: {
  parentPath: string;
  depth: number;
  nodes: Record<string, NodeState>;
  showHidden: boolean;
  onToggle: (path: string) => void;
  onPaste: (snippet: string) => void | Promise<void>;
  onOpenFile: (path: string) => string;
}) {
  const state = nodes[parentPath];

  if (state?.loading && !state.children) {
    return depth === 0 ? <LoadingRow /> : null;
  }
  if (state?.error) {
    return <ErrorRow message={state.error} indent={depth} />;
  }
  if (!state?.children) return null;

  const visible = state.children.filter((e) => showHidden || !e.hidden);

  if (visible.length === 0) {
    return depth === 0 ? (
      <div className="px-2 py-1.5 font-display text-[10.5px] italic leading-relaxed text-fg-subtle">
        empty folder
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
          onToggle={onToggle}
          onPaste={onPaste}
          onOpenFile={onOpenFile}
        />
      ))}
    </ul>
  );
}

function TreeNode({
  entry,
  depth,
  nodes,
  showHidden,
  onToggle,
  onPaste,
  onOpenFile,
}: {
  entry: FsEntry;
  depth: number;
  nodes: Record<string, NodeState>;
  showHidden: boolean;
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
          onToggle={onToggle}
          onPaste={onPaste}
          onOpenFile={onOpenFile}
        />
      )}
    </li>
  );
}

function LoadingRow() {
  return (
    <div className="flex items-center gap-2 px-3 py-2 font-display text-[11px] text-fg-subtle">
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
