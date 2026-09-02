import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TerminalSquare,
  FileCode2,
  MonitorPlay,
  Send,
  Database,
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
import { formatBinding, getBinding } from '../state/shortcuts';
import { cn } from '../lib/cn';
import { WorkspaceEditPanel, DEFAULT_WORKSPACE_COLOR } from './WorkspaceEditPanel';
import { AgentLauncher, AGENT_PANEL_H, AGENT_PANEL_W } from './AgentLauncher';

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
  const openDbClient = useWorkspace((s) => s.openDbClient);
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

  // Agent launch panel, anchored under the button that opens it.
  const [agentPos, setAgentPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!agentPos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-agent-popover]')) return;
      setAgentPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Swallow it: the launcher overlay closes on Escape too, and dismissing
      // both at once would drop the user out of the launcher entirely.
      e.stopPropagation();
      setAgentPos(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [agentPos]);

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
      kbd: formatBinding(getBinding('new-terminal')),
      run: () => void newTerminal(),
    },
    { title: 'Editor', hint: 'Open a file', icon: FileCode2, color: 'blue', run: pickAndOpen },
    { title: 'Preview', hint: 'Render a URL', icon: MonitorPlay, color: 'green', run: () => openPreview() },
    { title: 'API Client', hint: 'Send a request', icon: Send, color: 'violet', run: () => openApiClient() },
    { title: 'Database', hint: 'Run a query', icon: Database, color: 'amber', run: () => openDbClient() },
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
              data-launcher-stay
              className="group mb-2.5 flex items-center gap-2 rounded-lg border border-border-hairline bg-surface-1 py-1.5 pl-1.5 pr-2.5 transition-colors hover:border-border-subtle hover:bg-surface-1"
            >
              <span
                className="flex h-6 w-6 items-center justify-center rounded-md font-display text-xs font-semibold text-fg-base"
                style={{
                  backgroundColor: rgba(groupColorDef(active.color ?? DEFAULT_WORKSPACE_COLOR).hex, 0.18),
                }}
              >
                {active.icon ? <span className="text-base">{active.icon}</span> : initials(active.name)}
              </span>
              <span className="font-display text-sm font-medium tracking-tight text-fg-base">
                {active.name}
              </span>
              <Pencil
                size={11}
                strokeWidth={1.9}
                className="text-fg-subtle transition-colors group-hover:text-fg-muted"
              />
            </button>
          )}
          <h1 className="font-display text-xl font-semibold tracking-tight text-fg-base">
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
                className="group relative flex h-[112px] flex-col items-start justify-between rounded-xl border border-border-hairline bg-surface-1 p-3.5 text-left transition-colors hover:border-border-subtle hover:bg-surface-1"
              >
                <t.icon size={20} strokeWidth={1.8} style={{ color: hex }} />
                {t.kbd && (
                  <kbd className="absolute right-3 top-3 rounded bg-surface-2 px-1 font-mono text-2xs text-fg-subtle">
                    {t.kbd}
                  </kbd>
                )}
                <div>
                  <div className="font-display text-base font-semibold tracking-tight text-fg-base">
                    {t.title}
                  </div>
                  <div className="text-xs text-fg-muted">{t.hint}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* AI agents — a chip per detected CLI for the one-click case, then the
            full panel for choosing a count or editing the command. With none
            detected the panel entry stands alone: an empty row should still
            offer the way forward rather than just reporting the absence. */}
        <section className="mt-6">
          <SectionLabel icon={Sparkles}>AI Agents</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {aiClis.map((cli) => (
              <button
                key={cli.id}
                onClick={() => void launchAiCli(cli)}
                title={cli.path}
                className="flex items-center gap-2 rounded-lg border border-border-hairline bg-surface-1 px-3 py-2 text-sm font-medium text-fg-base/90 transition-colors hover:border-border-subtle hover:bg-surface-1"
              >
                <Bot size={13} strokeWidth={1.9} className="text-accent-bright" />
                <span className="truncate">{cli.label}</span>
              </button>
            ))}
            <button
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                // Anchor under the button, but keep the whole panel on screen —
                // the launcher is often open on a short window, where a naive
                // `r.bottom` would push the command field and Launch button
                // below the fold with no way to scroll to them.
                setAgentPos({
                  x: Math.max(12, Math.min(r.left, window.innerWidth - AGENT_PANEL_W - 12)),
                  y: Math.max(12, Math.min(r.bottom + 8, window.innerHeight - AGENT_PANEL_H - 12)),
                });
              }}
              data-launcher-stay
              className="flex items-center gap-2 rounded-lg border border-dashed border-border-subtle px-3 py-2 text-sm font-medium text-fg-muted transition-colors hover:border-border-subtle hover:bg-surface-1 hover:text-fg-base"
            >
              <Sparkles size={13} strokeWidth={1.9} className="text-fg-subtle" />
              <span>{aiClis.length > 0 ? 'More agents…' : 'Browse agents…'}</span>
            </button>
          </div>
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
                  kbd={formatBinding(getBinding('open-command-palette'))}
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
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-base/85 transition-colors hover:bg-surface-2 hover:text-fg-base"
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

      {agentPos &&
        createPortal(
          <div
            data-agent-popover
            data-launcher-stay
            style={{ position: 'fixed', top: agentPos.y, left: agentPos.x }}
            className="material-sheet z-50 max-h-[calc(100vh-24px)] animate-popover-in overflow-y-auto rounded-lg bg-bg-panel shadow-sheet ring-1 ring-edge-2"
          >
            <AgentLauncher detected={aiClis} onDone={() => setAgentPos(null)} />
          </div>,
          document.body,
        )}

      {active &&
        editPos &&
        createPortal(
          <div
            data-edit-popover
            style={{ position: 'fixed', top: editPos.y, left: editPos.x }}
            className="material-sheet z-50 w-[248px] animate-popover-in rounded-md bg-bg-panel p-3 shadow-sheet ring-1 ring-edge-2"
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
    <div className="mb-2 flex items-center gap-1.5 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle/80">
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
        'group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
        'text-fg-base/85 transition-colors hover:bg-surface-2 hover:text-fg-base',
      )}
    >
      <Icon size={13} strokeWidth={1.9} className="text-fg-subtle group-hover:text-fg-muted" />
      <span className="flex-1">{label}</span>
      {kbd && <kbd className="font-mono text-2xs text-fg-subtle">{kbd}</kbd>}
    </button>
  );
}
