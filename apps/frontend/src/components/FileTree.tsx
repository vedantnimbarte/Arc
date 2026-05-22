import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  FolderSearch,
  Search,
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
  fsWriteFile,
  fsRename,
  fsDelete,
  fsReveal,
  fsCreateDir,
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

interface ContextMenuState {
  entry: FsEntry;
  x: number;
  y: number;
}

interface CreatingState {
  parentPath: string;
  kind: 'file' | 'dir';
  value: string;
}

interface RenamingState {
  entry: FsEntry;
  value: string;
}

// Derive path separator from a path string.
function pathSep(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

// Cross-platform parent directory.
function parentDir(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx > 0 ? cleaned.slice(0, idx) : cleaned;
}

export function FileTree() {
  const { root, setRoot, showHidden } = useFiles();
  const addTab = useWorkspace((s) => s.addTab);
  const openFile = useWorkspace((s) => s.openFile);

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

  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  const [rootError, setRootError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Context menu + dialog state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FsEntry | null>(null);

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

  useEffect(() => {
    if (!root) return;
    void ensureLoaded(root);
  }, [root, ensureLoaded]);

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

  const pickFolder = useCallback(async () => {
    if (!isTauri) return;
    try {
      const picked = await fsPickFolder(root);
      if (picked) setRoot(picked);
    } catch (e) {
      setRootError(String(e));
    }
  }, [root, setRoot]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      const next = !open;
      if (next) {
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

  // ── Context menu handlers ────────────────────────────────────────────────

  const handleContextMenu = useCallback((entry: FsEntry, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ entry, x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const ctxOpenInTerminal = useCallback((path: string) => {
    addTab({
      id: `term-${Date.now()}`,
      title: basename(path) || 'shell',
      kind: 'terminal',
    });
    // cd into the target folder once the terminal is ready
    setTimeout(() => void pasteIntoActiveTerminal(`cd ${shellQuote(path)}\r`), 350);
  }, [addTab, pasteIntoActiveTerminal]);

  const ctxReveal = useCallback(async (path: string) => {
    if (!isTauri) return;
    try { await fsReveal(path); } catch { /* ignore */ }
  }, []);

  const ctxCopyPath = useCallback((path: string) => {
    void navigator.clipboard.writeText(path);
  }, []);

  const ctxCopyRelativePath = useCallback((path: string) => {
    if (!root) return;
    const sep = pathSep(root);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    const rel = path.startsWith(rootWithSep) ? path.slice(rootWithSep.length) : path;
    void navigator.clipboard.writeText(rel);
  }, [root]);

  const ctxAttachToAgent = useCallback((path: string) => {
    // Broadcast to ChatPanel; also copy path as fallback.
    window.dispatchEvent(new CustomEvent('arc:attach-file', { detail: { path } }));
    void navigator.clipboard.writeText(path);
  }, []);

  const ctxNewFile = useCallback((entry: FsEntry) => {
    const parentPath = entry.kind === 'dir' ? entry.path : parentDir(entry.path);
    setCreating({ parentPath, kind: 'file', value: '' });
  }, []);

  const ctxNewFolder = useCallback((entry: FsEntry) => {
    const parentPath = entry.kind === 'dir' ? entry.path : parentDir(entry.path);
    setCreating({ parentPath, kind: 'dir', value: '' });
  }, []);

  const ctxRename = useCallback((entry: FsEntry) => {
    setRenaming({ entry, value: entry.name });
  }, []);

  const ctxDelete = useCallback((entry: FsEntry) => {
    setDeleteTarget(entry);
  }, []);

  // ── Confirm/cancel for dialogs ───────────────────────────────────────────

  const confirmCreate = useCallback(async (name: string) => {
    if (!creating) return;
    const { parentPath, kind } = creating;
    const sep = pathSep(parentPath);
    const fullPath = `${parentPath}${sep}${name}`;
    try {
      if (kind === 'file') {
        await fsWriteFile(fullPath, '');
        openFile(fullPath);
      } else {
        await fsCreateDir(fullPath);
      }
    } catch (e) {
      console.error('[FileTree] create failed:', e);
    }
    setCreating(null);
  }, [creating, openFile]);

  const confirmRename = useCallback(async (newName: string) => {
    if (!renaming) return;
    try {
      await fsRename(renaming.entry.path, newName);
    } catch (e) {
      console.error('[FileTree] rename failed:', e);
    }
    setRenaming(null);
  }, [renaming]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await fsDelete(deleteTarget.path);
    } catch (e) {
      console.error('[FileTree] delete failed:', e);
    }
    setDeleteTarget(null);
  }, [deleteTarget]);

  const query = searchQuery.trim().toLowerCase();

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border-hairline px-2.5">
        <span
          className="min-w-0 flex-1 truncate font-display text-[12px] font-medium tracking-tight text-fg-base/90"
          title={root ?? ''}
        >
          {root ? basename(root) : '—'}
        </span>

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
          onClick={() => void pickFolder()}
          disabled={!isTauri}
          className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-white/[0.08] hover:text-fg-base disabled:opacity-40 disabled:hover:bg-transparent"
          aria-label="Choose folder"
          title="Choose folder…"
        >
          <FolderSearch size={12} strokeWidth={2.1} />
        </button>
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
      </div>

      {/* Search bar */}
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
            onContextMenu={handleContextMenu}
          />
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          entry={contextMenu.entry}
          x={contextMenu.x}
          y={contextMenu.y}
          root={root}
          onClose={closeContextMenu}
          onOpenInTerminal={() => { ctxOpenInTerminal(contextMenu.entry.path); }}
          onReveal={() => { void ctxReveal(contextMenu.entry.path); }}
          onNewFile={() => { ctxNewFile(contextMenu.entry); }}
          onNewFolder={() => { ctxNewFolder(contextMenu.entry); }}
          onCopyPath={() => { ctxCopyPath(contextMenu.entry.path); }}
          onCopyRelativePath={() => { ctxCopyRelativePath(contextMenu.entry.path); }}
          onAttachToAgent={() => { ctxAttachToAgent(contextMenu.entry.path); }}
          onRename={() => { ctxRename(contextMenu.entry); }}
          onDelete={() => { ctxDelete(contextMenu.entry); }}
          onOpenFile={() => { openFile(contextMenu.entry.path); }}
        />
      )}

      {/* New file / folder dialog */}
      {creating && (
        <InputDialog
          title={creating.kind === 'file' ? 'New File' : 'New Folder'}
          placeholder={creating.kind === 'file' ? 'filename.ts' : 'folder-name'}
          initialValue=""
          onConfirm={(v) => void confirmCreate(v)}
          onCancel={() => setCreating(null)}
        />
      )}

      {/* Rename dialog */}
      {renaming && (
        <InputDialog
          title={`Rename "${renaming.entry.name}"`}
          placeholder="new name"
          initialValue={renaming.value}
          onConfirm={(v) => void confirmRename(v)}
          onCancel={() => setRenaming(null)}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <DeleteDialog
          entry={deleteTarget}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ── ContextMenu ─────────────────────────────────────────────────────────────

function ContextMenu({
  entry,
  x,
  y,
  root,
  onClose,
  onOpenInTerminal,
  onReveal,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onCopyRelativePath,
  onAttachToAgent,
  onRename,
  onDelete,
  onOpenFile,
}: {
  entry: FsEntry;
  x: number;
  y: number;
  root: string | null;
  onClose: () => void;
  onOpenInTerminal: () => void;
  onReveal: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onCopyPath: () => void;
  onCopyRelativePath: () => void;
  onAttachToAgent: () => void;
  onRename: () => void;
  onDelete: () => void;
  onOpenFile: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Shift menu so it stays within the viewport.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: x + width > vw ? Math.max(0, vw - width - 8) : x,
      y: y + height > vh ? Math.max(0, vh - height - 8) : y,
    });
  }, [x, y]);

  // Close on outside click or Escape.
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onMouse, { capture: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouse, { capture: true });
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const isDir = entry.kind === 'dir';

  const revealLabel =
    typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
      ? 'Reveal in Finder'
      : 'Reveal in Explorer';

  const item = (label: string, action: () => void, danger = false) => (
    <button
      key={label}
      onClick={() => { action(); onClose(); }}
      className={cn(
        'flex w-full items-center rounded-md px-3 py-[5px] font-display text-[12.5px] tracking-tight transition-colors duration-100',
        danger
          ? 'text-red-400 hover:bg-red-500/[0.12]'
          : 'text-fg-base/90 hover:bg-white/[0.07] hover:text-fg-base',
      )}
    >
      {label}
    </button>
  );

  const sep = <div className="my-[3px] border-t border-white/[0.06]" />;

  void root; // root is available for future use (e.g. relative path display)

  return createPortal(
    <div
      ref={menuRef}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[9999] min-w-[196px] rounded-xl border border-white/[0.09] bg-[#1b1b1d] p-1.5 shadow-2xl shadow-black/70"
      role="menu"
      aria-label="File actions"
    >
      {isDir ? (
        <>
          {item('Open in Terminal', onOpenInTerminal)}
          {item(revealLabel, onReveal)}
          {sep}
          {item('New File', onNewFile)}
          {item('New Folder', onNewFolder)}
          {sep}
          {item('Copy Path', onCopyPath)}
          {item('Copy Relative Path', onCopyRelativePath)}
          {sep}
          {item('Attach to Agent', onAttachToAgent)}
          {sep}
          {item('Rename', onRename)}
          {item('Delete', onDelete, true)}
        </>
      ) : (
        <>
          {item('Open', onOpenFile)}
          {item(revealLabel, onReveal)}
          {sep}
          {item('New File', onNewFile)}
          {item('New Folder', onNewFolder)}
          {sep}
          {item('Copy Path', onCopyPath)}
          {item('Copy Relative Path', onCopyRelativePath)}
          {sep}
          {item('Attach to Agent', onAttachToAgent)}
          {sep}
          {item('Rename', onRename)}
          {item('Delete', onDelete, true)}
        </>
      )}
    </div>,
    document.body,
  );
}

// ── InputDialog ──────────────────────────────────────────────────────────────

function InputDialog({
  title,
  placeholder,
  initialValue,
  onConfirm,
  onCancel,
}: {
  title: string;
  placeholder: string;
  initialValue: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = initialValue.lastIndexOf('.');
    if (dot > 0) {
      el.setSelectionRange(0, dot);
    } else {
      el.select();
    }
  }, [initialValue]);

  const confirm = () => { if (value.trim()) onConfirm(value.trim()); };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-80 rounded-xl border border-white/[0.09] bg-[#1c1c1e] p-4 shadow-2xl shadow-black/70">
        <p className="mb-3 font-display text-[13px] font-medium text-fg-base">{title}</p>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); confirm(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          }}
          placeholder={placeholder}
          className="selectable w-full rounded-lg border border-white/[0.07] bg-black/30 px-3 py-1.5 font-display text-[12.5px] text-fg-base placeholder:text-fg-subtle focus:border-accent/50 focus:outline-none"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 font-display text-[11.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={!value.trim()}
            className="rounded-md bg-accent/90 px-3 py-1.5 font-display text-[11.5px] text-white transition-colors hover:bg-accent disabled:opacity-40"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── DeleteDialog ─────────────────────────────────────────────────────────────

function DeleteDialog({
  entry,
  onConfirm,
  onCancel,
}: {
  entry: FsEntry;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-80 rounded-xl border border-white/[0.09] bg-[#1c1c1e] p-4 shadow-2xl shadow-black/70">
        <p className="mb-1.5 font-display text-[13px] font-medium text-fg-base">
          Delete &ldquo;{entry.name}&rdquo;?
        </p>
        <p className="mb-4 font-display text-[11.5px] leading-relaxed text-fg-muted">
          {entry.kind === 'dir'
            ? 'This will permanently delete the folder and all its contents.'
            : 'This file will be permanently deleted.'}
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 font-display text-[11.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-red-500/80 px-3 py-1.5 font-display text-[11.5px] text-white transition-colors hover:bg-red-500"
          >
            Delete
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── TreeChildren ─────────────────────────────────────────────────────────────

function TreeChildren({
  parentPath,
  depth,
  nodes,
  showHidden,
  query,
  onToggle,
  onPaste,
  onOpenFile,
  onContextMenu,
}: {
  parentPath: string;
  depth: number;
  nodes: Record<string, NodeState>;
  showHidden: boolean;
  query: string;
  onToggle: (path: string) => void;
  onPaste: (snippet: string) => void | Promise<void>;
  onOpenFile: (path: string) => string;
  onContextMenu: (entry: FsEntry, e: React.MouseEvent) => void;
}) {
  const state = nodes[parentPath];

  if (state?.loading && !state.children) {
    return <LoadingRow indent={depth} />;
  }
  if (state?.error) {
    return <ErrorRow message={state.error} indent={depth} />;
  }
  if (!state?.children) {
    if (state?.expanded) return <LoadingRow indent={depth} />;
    return null;
  }

  const visible = state.children.filter((e) => {
    if (!showHidden && e.hidden) return false;
    if (!query) return true;
    if (e.name.toLowerCase().includes(query)) return true;
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
          onContextMenu={onContextMenu}
        />
      ))}
    </ul>
  );
}

// ── hasDescendantMatch ────────────────────────────────────────────────────────

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

// ── TreeNode ──────────────────────────────────────────────────────────────────

function TreeNode({
  entry,
  depth,
  nodes,
  showHidden,
  query,
  onToggle,
  onPaste,
  onOpenFile,
  onContextMenu,
}: {
  entry: FsEntry;
  depth: number;
  nodes: Record<string, NodeState>;
  showHidden: boolean;
  query: string;
  onToggle: (path: string) => void;
  onPaste: (snippet: string) => void | Promise<void>;
  onOpenFile: (path: string) => string;
  onContextMenu: (entry: FsEntry, e: React.MouseEvent) => void;
}) {
  const isDir = entry.kind === 'dir';
  const state = nodes[entry.path];
  const expanded = !!state?.expanded;

  const { Icon, color } = isDir
    ? folderIcon(entry.name, expanded)
    : fileIcon(entry.name);

  const indent = depth * 14;

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

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(entry, e);
  };

  const tooltip = isDir
    ? `${entry.path} · click to expand · double-click to cd`
    : `${entry.path} · click to open · ⌥/alt+click to paste path`;

  return (
    <li>
      <button
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
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

        {/* Chevron */}
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
          onContextMenu={onContextMenu}
        />
      )}
    </li>
  );
}

// ── Utility rows ──────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function shellQuote(p: string): string {
  if (/^[\w./\\:+-]+$/.test(p)) return p;
  return `"${p.replace(/(["\\])/g, '\\$1')}"`;
}
