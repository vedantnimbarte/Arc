import { Cloud, RotateCw, X } from 'lucide-react';
import { useRemoteWorkspace } from '../state/remoteWorkspace';
import { remoteDisplayPath } from '../lib/remote';
import { cn } from '../lib/cn';

/**
 * Strip above the file tree while a remote workspace is mounted.
 *
 * It exists because "which machine am I editing?" must never be a guess: the
 * tree, tabs, and editor look identical either way, and saving to the wrong
 * host is not a recoverable mistake. It also carries the only two actions
 * that matter when a connection drops — retry, and get me back to local.
 */
export function RemoteWorkspaceBar() {
  const status = useRemoteWorkspace((s) => s.status);
  const host = useRemoteWorkspace((s) => s.host);
  const root = useRemoteWorkspace((s) => s.root);
  const error = useRemoteWorkspace((s) => s.error);
  const close = useRemoteWorkspace((s) => s.close);
  const reconnect = useRemoteWorkspace((s) => s.reconnect);

  if (status === 'idle' || !host) return null;

  const failed = status === 'error';

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1.5 border-b border-border-hairline px-2.5 py-1.5',
        failed ? 'bg-status-err/10' : 'bg-accent/[0.08]',
      )}
    >
      <Cloud
        size={11}
        strokeWidth={2.1}
        className={cn(
          'shrink-0',
          failed ? 'text-status-err' : 'text-accent',
          status === 'connecting' && 'animate-pulse-soft',
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-display text-2xs font-medium tracking-tight text-fg-base">
          {host.name}
          <span className="ml-1 font-normal text-fg-subtle">
            {status === 'connecting' ? 'connecting…' : failed ? 'disconnected' : 'remote'}
          </span>
        </div>
        <div className="truncate font-mono text-2xs text-fg-subtle" title={error ?? root ?? ''}>
          {failed ? error : root ? remoteDisplayPath(root) : ''}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void reconnect()}
        disabled={status === 'connecting'}
        title="Reconnect"
        aria-label="Reconnect to remote host"
        className="shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
      >
        <RotateCw size={11} strokeWidth={2.1} />
      </button>
      <button
        type="button"
        onClick={() => void close()}
        title="Close remote workspace"
        aria-label="Close remote workspace"
        className="shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
      >
        <X size={11} strokeWidth={2.2} />
      </button>
    </div>
  );
}
