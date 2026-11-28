import { Suspense, lazy, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TerminalSquare,
  FileCode2,
  MonitorPlay,
  Send,
  Database,
  Github,
  Bot,
  FolderOpen,
  ServerIcon,
  Command as CommandIcon,
  Sparkles,
  Pencil,
  ArrowUp,
  FlaskConical,
  BarChart3,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';
import { sendToAgent } from '../lib/sendToAgent';
import { runCommand } from '../state/commands';
import { useWorkspace } from '../state/workspace';
import { useFiles } from '../state/files';
import { useClaudeCode } from '../state/claudeCode';
import { fileIcon } from '../lib/fileIcons';
import { fsPickFiles, fsPickFolder, isTauri, ptyListAiClis, type AiCliInfo } from '../lib/tauri';
import { groupColorDef, rgba } from '../lib/tabGroups';
import { useVibe } from '../state/vibe';
import { formatBinding, getBinding } from '../state/shortcuts';
import { WorkspaceEditPanel, DEFAULT_WORKSPACE_COLOR } from './WorkspaceEditPanel';
import { AGENT_PANEL_H, AGENT_PANEL_W } from './agentPanelSize';

const AgentLauncher = lazy(() =>
  import('./AgentLauncher').then((m) => ({ default: m.AgentLauncher })),
);

/** Two-letter monogram from a workspace name ("Workspace 1" → "W1"). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * Shown when the active workspace has no tabs. With no folder open it asks
 * for one and nothing else. With a folder: an agent prompt, three starts
 * (terminal, file, Agent mode), recent files, and the other tools in one row.
 */

interface Props {
  /** Opens the ⌘K command palette — owned by App, threaded down. */
  onOpenCommandPalette?: () => void;
}

export function EmptyWorkspace({ onOpenCommandPalette }: Props) {
  const active = useWorkspace((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId));
  const newTerminal = useWorkspace((s) => s.newTerminal);
  const openPreview = useWorkspace((s) => s.openPreview);
  const openApiClient = useWorkspace((s) => s.openApiClient);
  const openDbClient = useWorkspace((s) => s.openDbClient);
  const openGitHub = useWorkspace((s) => s.openGitHub);
  const claudeReady = useClaudeCode((s) => s.status === 'ready');
  const openFile = useWorkspace((s) => s.openFile);
  const root = useFiles((s) => s.root);
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

  const connectSsh = () => useFiles.getState().showSidebarView('ssh');
  const openFolder = () => {
    void fsPickFolder(useFiles.getState().root).then((dir) => {
      if (dir) useFiles.getState().setRoot(dir);
    });
  };
  const openAgents = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // Anchor under the button, but keep the whole panel on screen — on a
    // short window a naive `r.bottom` pushes the Launch button below the fold.
    setAgentPos({
      x: Math.max(12, Math.min(r.left, window.innerWidth - AGENT_PANEL_W - 12)),
      y: Math.max(12, Math.min(r.bottom + 8, window.innerHeight - AGENT_PANEL_H - 12)),
    });
  };

  // Tools that aren't one of the three starts. Also under New in the title bar.
  const otherTools: { label: string; icon: LucideIcon; run: () => void }[] = [
    { label: 'Preview', icon: MonitorPlay, run: () => openPreview() },
    { label: 'API client', icon: Send, run: () => openApiClient() },
    { label: 'Database', icon: Database, run: () => openDbClient() },
    { label: 'GitHub', icon: Github, run: () => openGitHub() },
    { label: 'Connect over SSH', icon: ServerIcon, run: connectSsh },
  ];

  return (
    <div className="flex h-full w-full justify-center overflow-y-auto px-8 py-[12vh]">
      <div className="w-full max-w-xl animate-view-in">
        {active && (
          <button
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setEditPos({ x: r.left, y: r.bottom + 6 });
            }}
            title="Edit workspace"
            data-launcher-stay
            className="group -ml-1.5 mb-5 flex items-center gap-2 rounded-lg py-1 pl-1.5 pr-2.5 transition-colors hover:bg-surface-1"
          >
            <span
              className="flex h-6 w-6 items-center justify-center rounded-md font-display text-xs font-semibold text-fg-base"
              style={{
                backgroundColor: rgba(groupColorDef(active.color ?? DEFAULT_WORKSPACE_COLOR).hex, 0.18),
              }}
            >
              {active.icon ? <span className="text-base">{active.icon}</span> : initials(active.name)}
            </span>
            <span className="font-display text-sm text-fg-muted">{active.name}</span>
            <Pencil
              size={11}
              strokeWidth={1.9}
              className="text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>
        )}

        {!root ? (
          // No folder yet: one job. Agents, the terminal and git all work
          // inside a folder, so that's the first thing to choose.
          <>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-fg-base">
              Open a folder to start
            </h1>
            <p className="mt-2 max-w-md text-base leading-relaxed text-fg-muted">
              Arc opens its files, a terminal and git status there. Once it's open you can ask an
              agent to work on it.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <button
                onClick={openFolder}
                className="flex h-9 items-center gap-2 rounded-lg bg-accent px-4 font-display text-sm font-medium text-[#0d1a26] transition-colors hover:bg-accent-bright"
              >
                <FolderOpen size={15} strokeWidth={2} />
                Open folder…
              </button>
              <button
                onClick={() => openGitHub()}
                className="flex h-9 items-center gap-2 rounded-lg bg-bg-panel px-4 font-display text-sm font-medium text-fg-base transition-colors hover:bg-bg-hover"
              >
                <Github size={15} strokeWidth={1.9} />
                Clone from GitHub
              </button>
              <button
                onClick={connectSsh}
                className="flex h-9 items-center gap-2 rounded-lg px-3 font-display text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
              >
                <ServerIcon size={15} strokeWidth={1.9} />
                Open over SSH
              </button>
            </div>
            <p className="mt-10 max-w-md font-display text-sm leading-relaxed text-fg-subtle">
              Arc has two modes, switched at the top right.{' '}
              <span className="text-fg-muted">Agent</span>: describe a change and review what the
              agent writes. <span className="text-fg-muted">Editor</span>: files, panes and a
              terminal.
            </p>
          </>
        ) : (
          <>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-fg-base">
              What do you want to do in {basename(root)}?
            </h1>
            <p className="mt-2 text-base text-fg-muted">
              Describe a change for an agent, or start with a tool.
            </p>

            <BuildComposer agentReady={claudeReady} />

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Start
                icon={TerminalSquare}
                title="Terminal"
                kbd={formatBinding(getBinding('new-terminal'))}
                onClick={() => void newTerminal()}
              />
              <Start icon={FileCode2} title="Open a file" onClick={pickAndOpen} />
              {/* Agent mode needs Claude Code; without it, offer the agent
                  CLIs that can be launched instead. */}
              <Start
                icon={Sparkles}
                title={claudeReady ? 'Agent mode' : 'Start an agent'}
                onClick={(e) => (claudeReady ? useVibe.getState().enterVibe() : openAgents(e))}
              />
            </div>

            {recentFiles.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-1.5 font-display text-sm font-medium text-fg-muted">Recent files</h2>
                <div className="-mx-2 flex flex-col">
                  {recentFiles.map((path) => {
                    const name = path.split(/[\\/]/).pop() || path;
                    const { Icon, color } = fileIcon(name);
                    return (
                      <button
                        key={path}
                        onClick={() => openFile(path)}
                        title={path}
                        className="flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-sm text-fg-base/90 transition-colors hover:bg-surface-2 hover:text-fg-base"
                      >
                        <Icon size={14} strokeWidth={1.8} style={{ color }} className="shrink-0" />
                        <span className="truncate">{name}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="mt-8">
              <h2 className="mb-1.5 font-display text-sm font-medium text-fg-muted">Other tools</h2>
              <div className="-mx-2 flex flex-wrap gap-x-1 gap-y-0.5">
                {otherTools.map(({ label, icon: Icon, run }) => (
                  <button
                    key={label}
                    onClick={run}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
                  >
                    <Icon size={14} strokeWidth={1.9} />
                    {label}
                  </button>
                ))}
                <button
                  onClick={openAgents}
                  data-launcher-stay
                  className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
                >
                  <Bot size={14} strokeWidth={1.9} />
                  {aiClis.length > 0 ? `Agent CLIs (${aiClis.length} found)` : 'Agent CLIs'}
                </button>
                {onOpenCommandPalette && (
                  <button
                    onClick={onOpenCommandPalette}
                    className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
                  >
                    <CommandIcon size={14} strokeWidth={1.9} />
                    All commands
                  </button>
                )}
              </div>
            </section>
          </>
        )}
      </div>

      {agentPos &&
        createPortal(
          <div
            data-agent-popover
            data-launcher-stay
            style={{ position: 'fixed', top: agentPos.y, left: agentPos.x }}
            className="material-sheet z-50 max-h-[calc(100vh-24px)] animate-popover-in overflow-y-auto rounded-lg shadow-sheet ring-1 ring-edge-2"
          >
            <Suspense fallback={null}>
              <AgentLauncher detected={aiClis} onDone={() => setAgentPos(null)} />
            </Suspense>
          </div>,
          document.body,
        )}

      {active &&
        editPos &&
        createPortal(
          <div
            data-edit-popover
            style={{ position: 'fixed', top: editPos.y, left: editPos.x }}
            className="material-sheet z-50 w-[248px] animate-popover-in rounded-md p-3 shadow-sheet ring-1 ring-edge-2"
          >
            <WorkspaceEditPanel workspaceId={active.id} onDone={() => setEditPos(null)} />
          </div>,
          document.body,
        )}
    </div>
  );
}

const QUICK_ACTIONS: { label: string; icon: LucideIcon; command: string }[] = [
  { label: 'Run tests & fix', icon: FlaskConical, command: 'ai.run-tests-fix' },
  { label: 'Usage', icon: BarChart3, command: 'view.usage-dashboard' },
  { label: 'Project memory', icon: BookOpen, command: 'view.project-memory' },
];

/** The empty workspace's first question is what to build, not which tool to
 *  open: Enter hands the prompt to whichever agent `sendToAgent` picks. */
function BuildComposer({ agentReady }: { agentReady: boolean }) {
  const [prompt, setPrompt] = useState('');
  const send = () => {
    const text = prompt.trim();
    if (!text) return;
    sendToAgent(text, 'Prompt');
    setPrompt('');
  };
  return (
    <section className="mt-6">
      <div className="rounded-xl bg-bg-panel/60 p-3 ring-1 ring-inset ring-edge-1 transition-colors focus-within:ring-accent/40">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Describe what you want to build or change"
          aria-label="Prompt for your agent"
          className="w-full resize-none bg-transparent text-sm text-fg-base placeholder:text-fg-subtle focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-fg-subtle">
            {agentReady
              ? 'Enter sends it to a running agent, or to Claude Code'
              : 'No agent found. Install Claude Code or start an agent CLI; until then, Enter copies the prompt.'}
          </span>
          <div className="flex-1" />
          <button
            onClick={send}
            disabled={!prompt.trim()}
            aria-label="Send prompt"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-[#0d1a26] transition-opacity disabled:opacity-30"
          >
            <ArrowUp size={14} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      <div className="-ml-2 mt-2 flex flex-wrap gap-1">
        {QUICK_ACTIONS.map(({ label, icon: Icon, command }) => (
          <button
            key={command}
            onClick={() => void runCommand(command)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <Icon size={12} strokeWidth={2} />
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}

function Start({
  icon: Icon,
  title,
  kbd,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  kbd?: string;
  onClick: (e: React.MouseEvent<HTMLElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      data-launcher-stay
      className="flex h-11 items-center gap-2.5 rounded-lg bg-bg-panel/60 px-3 text-left font-display text-sm font-medium text-fg-base transition-colors hover:bg-bg-panel"
    >
      <Icon size={16} strokeWidth={1.8} className="shrink-0 text-fg-muted" />
      <span className="flex-1 truncate">{title}</span>
      {kbd && <kbd className="text-2xs font-normal text-fg-subtle">{kbd}</kbd>}
    </button>
  );
}

/** Last path segment, forward or back slashes. */
function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
