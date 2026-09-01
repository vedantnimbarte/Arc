import { useEffect, useMemo } from 'react';
import {
  Container as ContainerIcon,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
} from 'lucide-react';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import { useDocker } from '../state/docker';
import { composeCommand, groupByProject, logsCommand, type Container } from '../lib/docker';
import { askConfirm } from '../state/confirm';
import { isTauri } from '../lib/tauri';
import { cn } from '../lib/cn';

/**
 * Containers panel: what Docker is running, and the four things you actually
 * do to a container from a UI — start, stop, restart, remove.
 *
 * Logs and `compose up` open a terminal tab rather than rendering in the
 * panel. Both are long-lived streams, and ARC already has a very good surface
 * for a long-lived stream of text.
 */
export function DockerPanel() {
  const root = useFiles((s) => s.root);
  const addTab = useWorkspace((s) => s.addTab);
  const { status, containers, composeFile, loading, error, busy, refresh, detectCompose, act } =
    useDocker();

  useEffect(() => {
    void detectCompose(root);
  }, [root, detectCompose]);

  useEffect(() => {
    void refresh();
    // Re-listing on every root change is wrong (containers are daemon-wide,
    // not per-workspace), so this runs once on mount and on demand after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(() => groupByProject(containers), [containers]);

  /** Run a shell line in a fresh terminal tab.
   *
   *  Not `workspace.runTask`, which resets the file tree to home first — a
   *  new terminal spawns in whatever the tree root is, and `docker compose`
   *  has to run in the directory holding the compose file. */
  const runInTerminal = (command: string, title: string) => {
    addTab({
      id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title,
      kind: 'terminal',
      runCommand: command,
    });
  };

  const remove = async (c: Container) => {
    const ok = await askConfirm({
      title: `Remove ${c.name || c.id}?`,
      body: c.running
        ? 'The container is running — it will be killed and deleted. Anything not in a volume is lost.'
        : 'Deletes the container. Anything not in a volume is lost.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    await act(c.id, 'rm');
  };

  if (!isTauri) {
    return <Empty>The containers panel needs the desktop app.</Empty>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 px-3 py-2">
        <span className="flex-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
          Containers
        </span>
        {status === 'ready' && containers.length > 0 && (
          <span className="font-mono text-2xs text-fg-subtle">
            {containers.filter((c) => c.running).length}/{containers.length} up
          </span>
        )}
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title="Refresh"
          aria-label="Refresh containers"
          className="flex h-5 w-5 items-center justify-center rounded text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin-slow' : ''} />
        </button>
      </div>

      {/* Compose bar — only when this repo actually has a compose file. */}
      {composeFile && status === 'ready' && (
        <div className="flex shrink-0 items-center gap-1 px-3 pb-2">
          <span
            className="mr-1 truncate font-mono text-2xs text-fg-subtle"
            title={composeFile}
          >
            {composeFile}
          </span>
          {(['up', 'down', 'build'] as const).map((verb) => (
            <button
              key={verb}
              type="button"
              onClick={() => runInTerminal(composeCommand(verb), `compose ${verb}`)}
              title={`Run ${composeCommand(verb)} in a terminal tab`}
              className="rounded-full border border-border-hairline px-2 py-0.5 font-mono text-2xs text-fg-muted transition hover:bg-surface-1 hover:text-fg-base"
            >
              {verb}
            </button>
          ))}
        </div>
      )}

      {error && status === 'ready' && (
        <div className="mx-3 mb-2 rounded border border-red-500/25 bg-red-500/[0.06] px-2 py-1.5 font-mono text-2xs text-red-300">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === 'missing' && (
          <Empty>
            Docker isn&apos;t on your PATH. Install Docker Desktop or the CLI and press refresh.
          </Empty>
        )}
        {status === 'daemon-down' && (
          <Empty>
            Docker is installed but not responding — the daemon is probably stopped.
            {error && <span className="mt-2 block font-mono not-italic">{error}</span>}
          </Empty>
        )}
        {status === 'ready' && containers.length === 0 && !loading && (
          <Empty>No containers.</Empty>
        )}

        {groups.map(([project, list]) => (
          <div key={project || '(loose)'}>
            {project && (
              <div className="px-3 pb-0.5 pt-2 font-mono text-2xs uppercase tracking-wider text-fg-subtle/70">
                {project}
              </div>
            )}
            {list.map((c) => (
              <div
                key={c.id || c.name}
                className={cn(
                  'group flex items-center gap-2 border-b border-border-hairline/60 px-3 py-1.5 last:border-b-0 hover:bg-surface-1',
                  busy[c.id] && 'opacity-50',
                )}
              >
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    c.running ? 'bg-status-ok' : 'bg-fg-subtle/40',
                  )}
                  aria-label={c.running ? 'running' : 'stopped'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-xs text-fg-base/90" title={c.name}>
                    {c.service || c.name || c.id}
                  </span>
                  <span className="block truncate font-mono text-2xs text-fg-subtle" title={c.image}>
                    {c.status || c.image}
                    {c.ports && ` · ${c.ports}`}
                  </span>
                </span>

                <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  {c.running ? (
                    <IconButton
                      label={`Stop ${c.name}`}
                      onClick={() => void act(c.id, 'stop')}
                      Icon={Square}
                    />
                  ) : (
                    <IconButton
                      label={`Start ${c.name}`}
                      onClick={() => void act(c.id, 'start')}
                      Icon={Play}
                    />
                  )}
                  <IconButton
                    label={`Restart ${c.name}`}
                    onClick={() => void act(c.id, 'restart')}
                    Icon={RotateCw}
                  />
                  <IconButton
                    label={`Logs for ${c.name}`}
                    onClick={() =>
                      runInTerminal(logsCommand(c.id), `logs: ${c.service || c.name || c.id}`)
                    }
                    Icon={ScrollText}
                  />
                  <IconButton
                    label={`Remove ${c.name}`}
                    onClick={() => void remove(c)}
                    Icon={Trash2}
                    danger
                  />
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  Icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  Icon: typeof ContainerIcon;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'rounded p-1 text-fg-muted transition hover:bg-surface-2',
        danger ? 'hover:text-red-300' : 'hover:text-fg-base',
      )}
    >
      <Icon size={11} strokeWidth={2} />
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-6 text-center font-display text-xs italic leading-relaxed text-fg-subtle">
      {children}
    </div>
  );
}
