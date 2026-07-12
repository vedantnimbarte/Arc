import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TerminalSquare,
  FileCode2,
  MonitorPlay,
  Send,
  Bot,
  FolderOpen,
  ServerIcon,
  Command as CommandIcon,
  Sparkles,
  Pencil,
  type LucideIcon,
} from 'lucide-react';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { fileIcon } from '../lib/fileIcons';
import { fsPickFiles, fsPickFolder, isTauri, ptyListAiClis, type AiCliInfo } from '../lib/tauri';
import { groupColorDef, rgba, type TabGroupColorId } from '../lib/tabGroups';
import { cn } from '../lib/cn';
import { WorkspaceEditPanel, DEFAULT_WORKSPACE_COLOR } from './WorkspaceEditPanel';

/** Two-letter monogram from a workspace name ("Workspace 1" → "W1"). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * Shown when the active workspace has no tabs. A launcher: primary tool cards
 * (terminal / editor / preview / API client), a row of detected AI CLIs, a few
 * utility links, and recent files to jump back into. Styled with the same
 * liquid-glass tiles as the workspace rail.
 */

interface Props {
  /** Opens the ⌘K command palette — owned by App, threaded down. */
  onOpenCommandPalette?: () => void;
}

type CoreTool = {
  title: string;
  hint: string;
  icon: LucideIcon;
  color: TabGroupColorId;
  kbd?: string;
  run: () => void;
};

export function EmptyWorkspace({ onOpenCommandPalette }: Props) {
  const active = useWorkspace((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const openPreview = useWorkspace((s) => s.openPreview);
  const openApiClient = useWorkspace((s) => s.openApiClient);
  const openFile = useWorkspace((s) => s.openFile);
  const launchAiCli = useWorkspace((s) => s.launchAiCli);
  const recentFiles = useFiles((s) => s.recentFiles).slice(0, 5);

  const [aiClis, setAiClis] = useState<AiCliInfo[]>([]);
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    ptyListAiClis()
      .then((list) => !cancelled && setAiClis(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Workspace edit popover, anchored under the identity chip.
  const [editPos, setEditPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!editPos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-edit-popover]')) return;
      setEditPos(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setEditPos(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [editPos]);

  const pickAndOpen = () => {
    void fsPickFiles(useFiles.getState().root).then((paths) => {
      for (const p of paths) openFile(p);
    });
  };

  const tools: CoreTool[] = [
    {
      title: 'Terminal',
      hint: 'Open a shell',
      icon: TerminalSquare,
      color: 'slate',
      kbd: '⌘T',
      run: () => void newTerminal(),
    },
    { title: 'Editor', hint: 'Open a file', icon: FileCode2, color: 'blue', run: pickAndOpen },
    { title: 'Preview', hint: 'Render a URL', icon: MonitorPlay, color: 'green', run: () => openPreview() },
    { title: 'API Client', hint: 'Send a request', icon: Send, color: 'violet', run: () => openApiClient() },
  ];

  const connectSsh = () => useFiles.getState().showSidebarView('ssh');
  const openFolder = () => {
    void fsPickFolder(useFiles.getState().root).then((dir) => {
      if (dir) useFiles.getState().setRoot(dir);
    });
  };

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-2xl animate-view-in">
        <header className="mb-6 flex flex-col items-center text-center">
          {active && (
            <button
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setEditPos({ x: r.left + r.width / 2 - 124, y: r.bottom + 6 });
              }}
              title="Edit workspace"
              className="group mb-2.5 flex items-center gap-2 rounded-lg border border-border-hairline bg-white/[0.02] py-1.5 pl-1.5 pr-2.5 transition-colors hover:border-border-subtle hover:bg-white/[0.05]"
            >
              <span
                className="flex h-6 w-6 items-center justify-center rounded-md font-display text-[11px] font-semibold text-fg-base"
                style={{
                  backgroundColor: rgba(groupColorDef(active.color ?? DEFAULT_WORKSPACE_COLOR).hex, 0.18),
                }}
              >
                {active.icon ? <span className="text-[13px]">{active.icon}</span> : initials(active.name)}
              </span>
              <span className="font-display text-[12px] font-medium tracking-tight text-fg-base">
                {active.name}
              </span>
              <Pencil
                size={11}
                strokeWidth={1.9}
                className="text-fg-subtle transition-colors group-hover:text-fg-muted"
              />
            </button>
          )}
          <h1 className="font-display text-[19px] font-semibold tracking-tight text-fg-base">
            Pick a tool to get started
          </h1>
        </header>

        {/* Core tools — one glass card per tab type. */}
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {tools.map((t) => {
            const hex = groupColorDef(t.color).hex;
            return (
              <button
                key={t.title}
                onClick={t.run}
                className="group relative flex h-[112px] flex-col items-start justify-between rounded-xl border border-border-hairline bg-white/[0.02] p-3.5 text-left transition-colors hover:border-border-subtle hover:bg-white/[0.045]"
              >
                <t.icon size={20} strokeWidth={1.8} style={{ color: hex }} />
                {t.kbd && (
                  <kbd className="absolute right-3 top-3 rounded bg-white/[0.06] px-1 font-mono text-[9px] text-fg-subtle">
                    {t.kbd}
                  </kbd>
                )}
                <div>
                  <div className="font-display text-[13px] font-semibold tracking-tight text-fg-base">
                    {t.title}
                  </div>
                  <div className="text-[11px] text-fg-muted">{t.hint}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* AI agents — detected CLIs. */}
        <section className="mt-6">
          <SectionLabel icon={Sparkles}>AI Agents</SectionLabel>
          {aiClis.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {aiClis.map((cli) => (
                <button
                  key={cli.id}
                  onClick={() => void launchAiCli(cli)}
                  title={cli.path}
                  className="flex items-center gap-2 rounded-lg border border-border-hairline bg-white/[0.02] px-3 py-2 text-[12px] font-medium text-fg-base/90 transition-colors hover:border-border-subtle hover:bg-white/[0.05]"
                >
                  <Bot size={13} strokeWidth={1.9} className="text-accent-bright" />
                  <span className="truncate">{cli.label}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11.5px] text-fg-subtle">
              No AI CLIs found on your PATH. Install Claude Code, Codex, or OpenCode to launch one here.
            </p>
          )}
        </section>

        {/* Utilities + recent files. */}
        <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2">
          <section>
            <SectionLabel>Shortcuts</SectionLabel>
            <div className="flex flex-col gap-0.5">
              <UtilityRow icon={FolderOpen} label="Open folder…" onClick={openFolder} />
              <UtilityRow icon={ServerIcon} label="Connect SSH" onClick={connectSsh} />
              {onOpenCommandPalette && (
                <UtilityRow
                  icon={CommandIcon}
                  label="Command palette"
                  kbd="⌘K"
                  onClick={onOpenCommandPalette}
                />
              )}
            </div>
          </section>

          {recentFiles.length > 0 && (
            <section>
              <SectionLabel>Recent files</SectionLabel>
              <div className="flex flex-col gap-0.5">
                {recentFiles.map((path) => {
                  const name = path.split(/[\\/]/).pop() || path;
                  const { Icon, color } = fileIcon(name);
                  return (
                    <button
                      key={path}
                      onClick={() => openFile(path)}
                      title={path}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg-base/85 transition-colors hover:bg-white/[0.06] hover:text-fg-base"
                    >
                      <Icon size={13} strokeWidth={1.8} style={{ color }} className="shrink-0" />
                      <span className="truncate">{name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      {active &&
        editPos &&
        createPortal(
          <div
            data-edit-popover
            style={{ position: 'fixed', top: editPos.y, left: editPos.x }}
            className="material-sheet z-50 w-[248px] animate-popover-in rounded-md bg-bg-panel p-3 shadow-sheet ring-1 ring-white/10"
          >
            <WorkspaceEditPanel workspaceId={active.id} onDone={() => setEditPos(null)} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function SectionLabel({ icon: Icon, children }: { icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-fg-subtle/80">
      {Icon && <Icon size={11} strokeWidth={2.2} />}
      {children}
    </div>
  );
}

function UtilityRow({
  icon: Icon,
  label,
  kbd,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  kbd?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px]',
        'text-fg-base/85 transition-colors hover:bg-white/[0.06] hover:text-fg-base',
      )}
    >
      <Icon size={13} strokeWidth={1.9} className="text-fg-subtle group-hover:text-fg-muted" />
      <span className="flex-1">{label}</span>
      {kbd && <kbd className="font-mono text-[9.5px] text-fg-subtle">{kbd}</kbd>}
    </button>
  );
}
