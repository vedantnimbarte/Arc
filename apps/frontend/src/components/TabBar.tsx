import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Plus,
  X,
  Terminal as TerminalIcon,
  FileCode,
  FolderOpen,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Bot,
  GitBranch,
  Monitor,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';
import { PaneTabStrip } from './PaneTabStrip';
import {
  fsPickFolder,
  fsWriteFile,
  gitStatus,
  gitWindowOpen,
  ptyListAiClis,
  type AiCliInfo,
} from '../lib/tauri';

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface Props {
  onOpenSettings: () => void;
  onOpenSearch: () => void;
}

export function TabBar({
  onOpenSettings,
  onOpenSearch,
}: Props) {
  const { tabs, activeTabId, setActive, closeTab, openFile, launchAiCli, newTerminal, openPreview, tabDirty } =
    useWorkspace();
  // Topbar carries the workspace's tab strip when there are no splits.
  // With splits, each pane keeps its own header so users can see what's
  // open in panes that don't hold focus.
  const layout = useWorkspace((s) => s.layout);
  const topbarLeafId = layout.kind === 'leaf' ? layout.id : null;
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

  const launchCli = (cli: AiCliInfo) => {
    void launchAiCli(cli);
    setMenuOpen(false);
  };

  const requestClose = (id: string, title: string) => {
    // Workspace invariant: at least one tab is always open. The store also
    // guards this, but we no-op early so the dirty-confirm prompt doesn't
    // fire pointlessly.
    if (tabs.length <= 1) return;
    if (tabDirty[id]) {
      const ok = window.confirm(`"${title}" has unsaved changes. Discard them?`);
      if (!ok) return;
    }
    closeTab(id);
  };

  return (
    <>
    <div
      data-tauri-drag-region
      className="material-toolbar relative flex h-11 shrink-0 items-center gap-2 pl-3"
    >
      {/* Sidebar toggle — left rail, mirrors macOS toolbar control */}
      <button
        onClick={toggleSidebar}
        className="group flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-white/[0.08] hover:text-fg-base active:bg-white/[0.12]"
        aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        aria-pressed={!sidebarCollapsed}
        title={sidebarCollapsed ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen size={14} strokeWidth={1.9} />
        ) : (
          <PanelLeftClose size={14} strokeWidth={1.9} />
        )}
      </button>

      {/* Tab strip — browser-style pills aligned to the left rail. Subtle
          vertical separator hairline before the row gives the topbar two
          distinct zones (chrome controls / tabs). */}
      <div className="ml-0.5 h-5 w-px bg-white/[0.06]" aria-hidden />

      {/* Tab strip (single-leaf workspaces only — split layouts keep their
          own per-pane strips) sits inline before the + button so the whole
          chrome lives on one row. */}
      <div className="flex min-w-0 flex-1 items-center pl-1">
        {topbarLeafId && (
          <PaneTabStrip paneId={topbarLeafId} variant="topbar" />
        )}
        <button
          ref={plusRef}
          onClick={() => setMenuOpen((o) => !o)}
          className="group ml-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px] text-fg-subtle transition-all duration-200 ease-apple hover:bg-white/[0.06] hover:text-fg-base active:bg-white/[0.10]"
          aria-label="New tab"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="New tab"
        >
          <Plus
            size={13}
            strokeWidth={2}
            className="transition-transform duration-200 ease-apple group-active:scale-90"
          />
        </button>
      </div>

      {/* Right cluster — search affordance, AI toggle, settings. The search
          pill mirrors the Arc/Chrome address-bar shape so it reads as the
          single entry point for "find anything in this workspace". */}
      <button
        onClick={onOpenSearch}
        className={cn(
          'group flex h-[26px] w-[160px] shrink-0 items-center gap-1.5 rounded-[7px] px-2',
          'border border-white/[0.04] bg-black/[0.18] text-fg-subtle',
          'transition-all duration-150 ease-apple',
          'hover:border-white/[0.08] hover:bg-black/[0.28] hover:text-fg-muted',
          'focus-within:border-accent/40 focus-within:bg-black/[0.32] focus-within:shadow-focus',
        )}
        aria-label="Search files"
        title="Search files (⌘P)"
      >
        <Search size={11} strokeWidth={2.1} className="shrink-0" />
        <span className="flex-1 truncate text-left font-display text-[11.5px] tracking-tight">
          Search
        </span>
        <kbd className="hidden font-mono text-[9.5px] tracking-tight text-fg-subtle/70 group-hover:inline">
          ⌘P
        </kbd>
      </button>

      <div className="ml-0.5 flex items-center gap-0.5 pr-2">
        {isGitRepo && (
          <button
            onClick={() => void gitWindowOpen()}
            className="group flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-white/[0.08] hover:text-fg-base active:bg-white/[0.12]"
            aria-label="Open Git history"
            title="Git history"
          >
            <GitBranch size={13} strokeWidth={1.9} />
          </button>
        )}
        <button
          onClick={onOpenSettings}
          className="group flex h-7 w-7 items-center justify-center rounded-md text-fg-muted transition-all duration-200 ease-apple hover:bg-white/[0.08] hover:text-fg-base active:bg-white/[0.12]"
          aria-label="Open settings"
          title="Settings (⌘,)"
        >
          <SettingsIcon
            size={13}
            strokeWidth={1.9}
            className="transition-transform duration-500 ease-apple group-hover:rotate-45"
          />
        </button>
      </div>

      {isTauri && <WindowControls />}
    </div>
    {menuOpen && menuPos && typeof document !== 'undefined' &&
      createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', top: menuPos.top, left: menuPos.left }}
          className="material-sheet z-50 w-52 animate-popover-in overflow-hidden rounded-md shadow-sheet ring-1 ring-white/10"
        >
          <button
            role="menuitem"
            onClick={handleNewTerminal}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
          >
            <TerminalIcon size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">Terminal</span>
            <kbd className="font-mono text-[9.5px] text-fg-subtle">⌘T</kbd>
          </button>
          <button
            role="menuitem"
            onClick={newEditor}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
          >
            <FileCode size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">Editor (new file)</span>
          </button>
          <button
            role="menuitem"
            onClick={handleNewPreview}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
          >
            <Monitor size={12} strokeWidth={2} className="text-fg-subtle" />
            <span className="flex-1">Preview</span>
          </button>
          {aiClis.length > 0 && (
            <>
              <div className="my-1 border-t border-white/[0.05]" />
              <div className="px-3 pb-1 pt-1.5 font-display text-[9.5px] uppercase tracking-wider text-fg-subtle/80">
                AI Agents
              </div>
              {aiClis.map((cli) => (
                <button
                  key={cli.id}
                  role="menuitem"
                  onClick={() => launchCli(cli)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left font-display text-[12px] text-fg-base/90 transition-colors hover:bg-white/[0.06]"
                  title={cli.path}
                >
                  <Bot size={12} strokeWidth={2} className="text-fg-subtle" />
                  <span className="flex-1 truncate">{cli.label}</span>
                </button>
              ))}
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
    <div className="ml-1.5 flex h-full items-center gap-px border-l border-white/[0.05] px-1.5">
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
          'hover:bg-white/[0.08] hover:text-fg-base/80',
          'active:scale-95 active:bg-white/[0.13]',
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        className="material-sheet mt-[18vh] flex w-[520px] max-w-[92vw] animate-sheet-in flex-col overflow-hidden rounded-window shadow-sheet ring-1 ring-white/10"
      >
        <div className="flex items-center gap-2 border-b border-border-hairline px-4 py-3">
          <FileCode size={13} strokeWidth={2} className="text-fg-subtle" />
          <span className="font-display text-[12.5px] font-medium tracking-tight text-fg-base">
            New file
          </span>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4">
          <label className="flex flex-col gap-1">
            <span className="font-display text-[10.5px] uppercase tracking-wider text-fg-subtle">
              Directory
            </span>
            <div className="flex gap-1.5">
              <input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="C:\\path\\to\\folder"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-white/[0.06] bg-black/[0.25] px-2.5 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-black/[0.32] focus:shadow-focus focus:outline-none"
              />
              <button
                type="button"
                onClick={pickDir}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 font-display text-[11.5px] text-fg-muted transition-colors hover:bg-white/[0.08] hover:text-fg-base"
                title="Pick a folder"
              >
                <FolderOpen size={11} strokeWidth={2} />
                Browse
              </button>
            </div>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-display text-[10.5px] uppercase tracking-wider text-fg-subtle">
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
              className="rounded-md border border-white/[0.06] bg-black/[0.25] px-2.5 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:bg-black/[0.32] focus:shadow-focus focus:outline-none"
            />
          </label>

          {error && (
            <div className="rounded-md border border-red-500/30 bg-red-500/[0.08] px-2.5 py-1.5 font-display text-[11.5px] text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-hairline bg-black/[0.15] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 font-display text-[11.5px] text-fg-muted transition-colors hover:bg-white/[0.06] hover:text-fg-base"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md bg-accent/90 px-3 py-1.5 font-display text-[11.5px] font-medium text-bg-base transition-colors hover:bg-accent disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create & open'}
          </button>
        </div>
      </div>
    </div>
  );
}
