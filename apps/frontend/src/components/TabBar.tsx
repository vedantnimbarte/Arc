import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus,
  Terminal as TerminalIcon,
  FileCode,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Bot,
  GitBranch,
  Monitor,
  Send,
  Database,
  Keyboard,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { runCommand } from '../state/commands';
import { formatBinding, getBinding } from '../state/shortcuts';
import { cn } from '../lib/cn';
import {
  fsPickFolder,
  fsWriteFile,
  gitStatus,
  gitWindowOpen,
  ptyListAiClis,
  type AiCliInfo,
} from '../lib/tauri';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Last path segment of a cwd, forward or back slashes. */
function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function TabBar() {
  const {
    openFile,
    launchAiCli,
    launchWingman,
    newTerminal,
    openPreview,
    openApiClient,
    openDbClient,
  } = useWorkspace();
  const activeTab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);
  const sidebarCollapsed = useFiles((s) => s.collapsed);
  const toggleSidebar = useFiles((s) => s.toggleCollapsed);
  const root = useFiles((s) => s.root);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [newFileOpen, setNewFileOpen] = useState(false);
  // Installed AI CLIs (Claude Code / Codex / OpenCode). Refreshed on mount.
  // Empty in browser-only mode or when none are on PATH.
  const [aiClis, setAiClis] = useState<AiCliInfo[]>([]);
  // Whether the current workspace root is a git repo. Hides the toolbar
  // git icon when there's nothing to show. Same one-shot pattern as
  // StatusBar — re-fires whenever the workspace root changes.
  const [isGitRepo, setIsGitRepo] = useState(false);

  useEffect(() => {
    if (!isTauri || !root) {
      setIsGitRepo(false);
      return;
    }
    let cancelled = false;
    void gitStatus(root)
      .then((info) => {
        if (!cancelled) setIsGitRepo(info?.branch != null);
      })
      .catch(() => {
        if (!cancelled) setIsGitRepo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);
  const plusRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // One-shot detection. The list is cheap (PATH scan) but doesn't change
  // mid-session, so we cache it. Users who install a CLI mid-session can
  // hit the action again to re-detect (we re-run on every menu open below).
  useEffect(() => {
    if (!isTauri) return;
    ptyListAiClis().then(setAiClis).catch((err) => {
      console.error('[TabBar] list AI CLIs failed:', err);
    });
  }, []);

  // Anchor the (portaled) menu to the plus button using viewport coords.
  // The tab strip clips overflow, and the toolbar uses backdrop-filter which
  // would otherwise re-parent any fixed-positioned descendant — portaling
  // to document.body keeps the menu free of both constraints.
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const update = () => {
      const r = plusRef.current?.getBoundingClientRect();
      if (!r) return;
      setMenuPos({ top: r.bottom + 4, left: r.left });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [menuOpen]);

  // Close the popover on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t)) return;
      if (plusRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Re-detect when the +menu opens — picks up CLIs installed mid-session.
  useEffect(() => {
    if (!menuOpen || !isTauri) return;
    ptyListAiClis().then(setAiClis).catch(() => {});
  }, [menuOpen]);

  const handleNewTerminal = () => {
    void newTerminal();
    setMenuOpen(false);
  };

  const newEditor = () => {
    setMenuOpen(false);
    setNewFileOpen(true);
  };

  const handleNewPreview = () => {
    openPreview();
    setMenuOpen(false);
  };

  const handleNewApiClient = () => {
    openApiClient();
    setMenuOpen(false);
  };

  const handleNewDbClient = () => {
    openDbClient();
    setMenuOpen(false);
  };

  const launchCli = (cli: AiCliInfo) => {
    void launchAiCli(cli);
    setMenuOpen(false);
  };

  const launchWingmanMode = (mode: 'pilot' | 'headless') => {
    void launchWingman(mode);
    setMenuOpen(false);
  };
  const hasWingman = aiClis.some((c) => c.id === 'wingman-cli');

  return (
    <>
    <div
      data-tauri-drag-region="deep"
      className="material-toolbar relative flex h-9 shrink-0 items-center gap-2 pl-3"
    >
      {/* Focused pane's title, centered. Absolutely positioned + click-through
          so it never shifts the side clusters or eats the window-drag region. */}
      {activeTab && (
        <div className="pointer-events-none absolute inset-y-0 left-1/2 flex max-w-[44%] -translate-x-1/2 items-center gap-1.5 px-3">
          <span className="truncate font-display text-sm font-medium tracking-tight text-fg-base/85">
            {activeTab.title}
          </span>
          {activeTab.cwd && (
            <span className="shrink truncate font-display text-xs text-fg-subtle">
              · {basename(activeTab.cwd)}
            </span>
          )}
        </div>
      )}

      {/* Sidebar toggle — left rail, mirrors macOS toolbar control */}
      <button
        onClick={toggleSidebar}
        className="group flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-surface-2 hover:text-fg-base active:bg-surface-3"
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
        title={sidebarCollapsed ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
      >
        {sidebarCollapsed ? (
          <PanelRightOpen size={14} strokeWidth={1.9} />
        ) : (
          <PanelRightClose size={14} strokeWidth={1.9} />
        )}
      </button>

      {/* AI CLI launcher + keyboard shortcuts — relocated here from the old
          bottom status bar, sitting between the sidebar toggle and the +. */}
      <AiCliMenuButton clis={aiClis} onLaunch={(cli) => void launchAiCli(cli)} />
      <button
        onClick={() => void runCommand('shortcut.open-shortcuts')}
        className="group flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-surface-2 hover:text-fg-base active:bg-surface-3"
        aria-label="Keyboard shortcuts"
        title={`Keyboard shortcuts (${formatBinding(getBinding('open-shortcuts'))})`}
      >
        <Keyboard size={14} strokeWidth={1.9} />
      </button>

      {/* The workspace renders every tab as a grid cell (no tab strip); the +
          adds a new cell. The flex-1 keeps it left-aligned and preserves the
          window-drag region. Workspace switching lives in the left rail. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1">
        <button
          ref={plusRef}
          onClick={() => setMenuOpen((o) => !o)}
          className="group ml-0.5 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-[7px] text-fg-subtle transition-all duration-200 ease-apple hover:bg-surface-2 hover:text-fg-base active:bg-surface-3"
          aria-label="New cell"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="New cell"
        >
          <Plus
            size={13}
            strokeWidth={2}
            className="transition-transform duration-200 ease-apple group-active:scale-90"
          />
        </button>
      </div>

      {/* Right cluster — git history. SSH lives in the ⌘K palette / ⌘⇧S;
          settings lives in the workspace rail. */}
      <div className="ml-0.5 flex items-center gap-0.5 pr-2">
        {isGitRepo && (
          <button
            onClick={() => void gitWindowOpen()}
            className="group flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-surface-2 hover:text-fg-base active:bg-surface-3"
            aria-label="Open Git history"
            title="Git history"
          >
            <GitBranch size={13} strokeWidth={1.9} />
          </button>
        )}
      </div>

      {isTauri && <WindowControls />}
    </div>
    {menuOpen && menuPos && typeof document !== 'undefined' &&
      createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
          className="material-sheet z-50 w-52 animate-popover-in overflow-hidden rounded-md bg-bg-panel shadow-sheet ring-1 ring-edge-2"
        >
          <button
            role="menuitem"
            onClick={handleNewTerminal}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
          >
            <TerminalIcon size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">Terminal</span>
            <kbd className="font-mono text-2xs text-fg-subtle">⌘T</kbd>
          </button>
          <button
            role="menuitem"
            onClick={newEditor}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
          >
            <FileCode size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">Editor (new file)</span>
          </button>
          <button
            role="menuitem"
            onClick={handleNewPreview}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
          >
            <Monitor size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">Preview</span>
          </button>
          <button
            role="menuitem"
            onClick={handleNewApiClient}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
          >
            <Send size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">API Client</span>
          </button>
          <button
            role="menuitem"
            onClick={handleNewDbClient}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
          >
            <Database size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">Database</span>
          </button>
          {aiClis.length > 0 && (
            <>
              <div className="my-1 border-t border-edge-1" />
              <div className="px-3 pb-1 pt-1.5 font-display text-2xs uppercase tracking-wider text-fg-subtle/80">
                AI Agents
              </div>
              {aiClis.map((cli) => (
                <button
                  key={cli.id}
                  role="menuitem"
                  onClick={() => launchCli(cli)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
                  title={cli.path}
                >
                  <Bot size={12} strokeWidth={2} className="text-fg-subtle" />
                  <span className="flex-1 truncate">{cli.label}</span>
                </button>
              ))}
              {hasWingman && (
                <>
                  <button
                    role="menuitem"
                    onClick={() => launchWingmanMode('pilot')}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
                    title="Prompt for a goal, then run Wingman pilot mode"
                  >
                    <Bot size={12} strokeWidth={2} className="text-fg-subtle" />
                    <span className="flex-1 truncate">Wingman Pilot</span>
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => launchWingmanMode('headless')}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
                    title="Prompt for a message, then run a one-shot headless response"
                  >
                    <Bot size={12} strokeWidth={2} className="text-fg-subtle" />
                    <span className="flex-1 truncate">Wingman (headless)</span>
                  </button>
                </>
              )}
            </>
          )}
        </div>,
        document.body,
      )}
    <NewFileDialog
      open={newFileOpen}
      initialDirectory={root}
      onClose={() => setNewFileOpen(false)}
      onCreated={(path) => {
        setNewFileOpen(false);
        openFile(path);
      }}
    />
    </>
  );
}

/**
 * Toolbar AI CLI launcher — an icon that opens a downward dropdown of the
 * detected coding CLIs (Claude Code / Codex / OpenCode / …). Relocated from
 * the old bottom status bar. Portaled to body so the toolbar's backdrop-filter
 * doesn't trap the menu.
 */
function AiCliMenuButton({
  clis,
  onLaunch,
}: {
  clis: AiCliInfo[];
  onLaunch: (cli: AiCliInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({ top: r.bottom + 4, left: r.left });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        aria-label="Launch AI CLI"
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          clis.length > 0
            ? `Launch AI CLI (${clis.length} installed)`
            : 'Launch AI CLI (none detected on PATH)'
        }
        className={cn(
          'group flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-all duration-200 ease-apple',
          open
            ? 'bg-surface-3 text-fg-base'
            : clis.length === 0
              ? 'text-fg-subtle/60 hover:bg-surface-2 hover:text-fg-muted active:bg-surface-3'
              : 'text-fg-muted hover:bg-surface-2 hover:text-fg-base active:bg-surface-3',
        )}
      >
        <Bot size={14} strokeWidth={1.9} />
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ position: 'fixed', top: pos.top, left: pos.left }}
            className="material-sheet z-50 w-48 animate-popover-in overflow-hidden rounded-md shadow-sheet ring-1 ring-edge-2"
          >
            {clis.length === 0 ? (
              <div className="px-3 py-3 font-display text-xs leading-snug text-fg-muted">
                <div className="mb-1 font-medium text-fg-base">No AI CLIs found</div>
                <div className="text-fg-subtle">
                  Install <code className="font-mono">claude</code>,{' '}
                  <code className="font-mono">codex</code>, or{' '}
                  <code className="font-mono">opencode</code> on your{' '}
                  <code className="font-mono">PATH</code>.
                </div>
              </div>
            ) : (
              clis.map((cli) => (
                <button
                  key={cli.id}
                  role="menuitem"
                  onClick={() => {
                    onLaunch(cli);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-sm text-fg-base/90 transition-colors hover:bg-surface-2"
                  title={cli.path}
                >
                  <Bot size={12} strokeWidth={2} className="text-fg-subtle" />
                  <span className="flex-1 truncate">{cli.label}</span>
                </button>
              ))
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(() => {});
    let unlistenFn: (() => void) | null = null;
    win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    }).then((fn) => { unlistenFn = fn; }).catch(() => {});
    return () => { unlistenFn?.(); };
  }, []);

  const win = getCurrentWindow();

  return (
    <div className="ml-1.5 flex h-full items-center gap-px border-l border-edge-1 px-1.5">
      {/* --- Minimize --- */}
      <button
        onClick={() => void win.minimize()}
        className={cn(
          'group relative flex h-[28px] w-10 items-center justify-center rounded-md',
          'text-fg-subtle/50',
          'transition-all duration-200 ease-out',
          'hover:bg-amber-400/[0.13] hover:text-amber-300/90',
          'active:scale-95 active:bg-amber-400/[0.20]',
        )}
        aria-label="Minimize window"
        title="Minimize"
      >
        <span className="pointer-events-none transition-transform duration-200 ease-out group-hover:translate-y-[1.5px]">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
            <line x1="2" y1="5.5" x2="9" y2="5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
        </span>
      </button>

      {/* --- Maximize / Restore --- */}
      <button
        onClick={() => void win.toggleMaximize()}
        className={cn(
          'group relative flex h-[28px] w-10 items-center justify-center rounded-md',
          'text-fg-subtle/50',
          'transition-all duration-200 ease-out',
          'hover:bg-surface-2 hover:text-fg-base/80',
          'active:scale-95 active:bg-surface-3',
        )}
        aria-label={isMaximized ? 'Restore window' : 'Maximize window'}
        title={isMaximized ? 'Restore' : 'Maximize'}
      >
        <span className="pointer-events-none transition-transform duration-200 ease-out group-hover:scale-[1.18]">
          {isMaximized ? (
            /* Restore: two overlapping squares */
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
              <path
                d="M4 1.5H9.5V7H7.5"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
              />
              <rect x="1.5" y="4" width="6" height="6" rx="0.9" stroke="currentColor" strokeWidth="1.4"/>
            </svg>
          ) : (
            /* Maximize: single clean square */
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
              <rect x="1.5" y="1.5" width="8" height="8" rx="1.2" stroke="currentColor" strokeWidth="1.4"/>
            </svg>
          )}
        </span>
      </button>

      {/* --- Close --- */}
      <button
        onClick={() => void win.close()}
        className={cn(
          'group relative flex h-[28px] w-10 items-center justify-center rounded-md overflow-hidden',
          'text-fg-subtle/50',
          'transition-all duration-200 ease-out',
          'hover:bg-rose-500/75 hover:text-white',
          'active:scale-95 active:bg-rose-600/90',
        )}
        aria-label="Close window"
        title="Close"
      >
        {/* Radial glow that blooms from the centre on hover */}
        <span
          className="pointer-events-none absolute inset-0 rounded-md opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{ background: 'radial-gradient(ellipse 80% 60% at 50% 120%, rgba(244,63,94,0.35) 0%, transparent 70%)' }}
          aria-hidden
        />
        <span className="pointer-events-none relative transition-transform duration-300 ease-out group-hover:rotate-90">
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden>
            <line x1="2" y1="2" x2="9" y2="9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
            <line x1="9" y1="2" x2="2" y2="9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
        </span>
      </button>
    </div>
  );
}

interface NewFileDialogProps {
  open: boolean;
  initialDirectory: string | null;
  onClose: () => void;
  onCreated: (path: string) => void;
}

function NewFileDialog({ open, initialDirectory, onClose, onCreated }: NewFileDialogProps) {
  const [directory, setDirectory] = useState(initialDirectory ?? '');
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filenameRef = useRef<HTMLInputElement>(null);

  // Reset state whenever the dialog re-opens — we don't want a stale filename
  // from a previous attempt sitting in the field.
  useEffect(() => {
    if (!open) return;
    setDirectory(initialDirectory ?? '');
    setFilename('');
    setError(null);
    setBusy(false);
    // Focus the filename input first; directory is usually pre-filled with
    // the workspace root.
    const t = setTimeout(() => filenameRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, initialDirectory]);

  if (!open) return null;

  const pickDir = async () => {
    try {
      const next = await fsPickFolder(directory || null);
      if (next) setDirectory(next);
    } catch (err) {
      setError(String(err));
    }
  };

  const submit = async () => {
    setError(null);
    const dir = directory.trim().replace(/[\\/]+$/, '');
    const name = filename.trim();
    if (!dir) {
      setError('Pick a directory first.');
      return;
    }
    if (!name) {
      setError('Filename is required.');
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      setError('Filename cannot contain \\ / : * ? " < > |');
      return;
    }
    const sep = dir.includes('\\') ? '\\' : '/';
    const fullPath = `${dir}${sep}${name}`;
    setBusy(true);
    try {
      await fsWriteFile(fullPath, '');
      onCreated(fullPath);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        className="material-sheet mt-[18vh] flex w-[520px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-edge-2"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-4 py-3">
          <FileCode size={13} strokeWidth={2} className="text-fg-subtle" />
          <span className="font-display text-sm font-medium tracking-tight text-fg-base">
            New file
          </span>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          <label className="flex flex-col gap-1">
            <span className="font-display text-2xs uppercase tracking-wider text-fg-subtle">
              Directory
            </span>
            <div className="flex gap-1.5">
              <input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="C:\\path\\to\\folder"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-edge-1 bg-scrim-1 px-2.5 py-1.5 font-mono text-sm text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-scrim-2 focus:shadow-focus focus:outline-none"
              />
              <button
                type="button"
                onClick={pickDir}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-edge-1 bg-surface-1 px-2.5 py-1.5 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
                title="Pick a folder"
              >
                <FolderOpen size={11} strokeWidth={2} />
                Browse
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-display text-2xs uppercase tracking-wider text-fg-subtle">
              Filename
            </span>
            <input
              ref={filenameRef}
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="notes.md"
              spellCheck={false}
              autoComplete="off"
              className="rounded-md border border-edge-1 bg-scrim-1 px-2.5 py-1.5 font-mono text-sm text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-scrim-2 focus:shadow-focus focus:outline-none"
            />
          </label>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/[0.08] px-2.5 py-1.5 font-display text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-hairline bg-scrim-1 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 font-display text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md bg-accent/90 px-3 py-1.5 font-display text-xs font-medium text-bg-base transition-colors hover:bg-accent disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create & open'}
          </button>
        </div>
      </div>
    </div>
  );
}
