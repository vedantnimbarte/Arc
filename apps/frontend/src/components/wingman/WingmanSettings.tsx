import { useEffect, useState } from 'react';
import { CircleCheck, CircleAlert, Loader2 } from 'lucide-react';
import { secretSet } from '../../lib/tauri';
import { useSettings } from '../../state/settings';
import { useWingman, WINGMAN_TOKEN_KEY } from '../../state/wingman';
import { toastError } from '../../state/toast';
import { friendlyError } from '../../lib/friendlyError';
import { Button, Input } from '../ui';

/**
 * Settings block for the Wingman daemon connection.
 *
 * The address persists in normal settings; the bearer token goes to the OS
 * credential vault instead, because settings are plain rows in SQLite. Most
 * setups need no token at all — a loopback `wingman serve` runs with
 * `auth = none`.
 */
export function WingmanSettings() {
  const savedUrl = useSettings((s) => s.wingmanUrl);
  const setWingmanUrl = useSettings((s) => s.setWingmanUrl);

  const status = useWingman((s) => s.status);
  const health = useWingman((s) => s.health);
  const lastError = useWingman((s) => s.lastError);
  const projects = useWingman((s) => s.projects);
  const connect = useWingman((s) => s.connect);
  const disconnect = useWingman((s) => s.disconnect);

  const [url, setUrl] = useState(savedUrl);
  const [token, setToken] = useState('');

  // Track external edits (the settings window is a separate window and
  // rehydrates on broadcast).
  useEffect(() => setUrl(savedUrl), [savedUrl]);

  const apply = async () => {
    const trimmed = url.trim();
    setWingmanUrl(trimmed);
    if (!trimmed) {
      await disconnect();
      return;
    }
    if (token.trim()) {
      try {
        await secretSet(WINGMAN_TOKEN_KEY, token.trim());
      } catch (e) {
        console.error('[wingman] storing token failed:', e);
        toastError(`Couldn't save the Wingman token. ${friendlyError(e).message}`);
      }
    }
    await connect(trimmed, token.trim() || null);
    // Never keep the secret in component state longer than the call needs.
    setToken('');
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="font-display text-sm font-medium tracking-tight text-fg-base">
          Daemon address
        </span>
        <span className="font-display text-xs text-fg-muted">
          Run <code className="font-mono">wingman serve</code> and paste its address. Leave
          empty to turn the integration off.
        </span>
        <Input
          mono
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void apply();
          }}
          placeholder="http://127.0.0.1:8787"
          className="mt-1"
        />
      </label>

      <label className="mt-1 flex flex-col gap-1">
        <span className="font-display text-sm font-medium tracking-tight text-fg-base">
          API token
        </span>
        <span className="font-display text-xs text-fg-muted">
          Only needed when the daemon binds a non-loopback address. Stored in your OS
          credential vault, never in Arc&rsquo;s database.
        </span>
        <Input
          mono
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void apply();
          }}
          placeholder={health?.auth_required ? 'Required by this daemon' : 'Not required'}
          className="mt-1"
        />
      </label>

      <div className="mt-2.5 flex items-center justify-between gap-3">
        <StatusLine
          status={status}
          version={health?.version ?? null}
          projectCount={projects.length}
          error={lastError}
        />
        <Button variant={url.trim() ? 'primary' : 'secondary'} size="sm" onClick={() => void apply()}>
          {url.trim() ? 'Connect' : 'Disconnect'}
        </Button>
      </div>
    </div>
  );
}

function StatusLine({
  status,
  version,
  projectCount,
  error,
}: {
  status: string;
  version: string | null;
  projectCount: number;
  error: string | null;
}) {
  if (status === 'connecting') {
    return (
      <p className="flex min-w-0 items-center gap-1.5 font-display text-xs text-fg-muted">
        <Loader2 size={11} strokeWidth={2} className="animate-spin" />
        Connecting…
      </p>
    );
  }
  if (status === 'connected') {
    return (
      <p className="flex min-w-0 items-center gap-1.5 font-display text-xs text-status-ok">
        <CircleCheck size={11} strokeWidth={2} />
        <span className="truncate">
          Wingman {version} · {projectCount} project{projectCount === 1 ? '' : 's'}
        </span>
      </p>
    );
  }
  if (status === 'error') {
    return (
      <p className="flex min-w-0 items-center gap-1.5 font-display text-xs text-status-err">
        <CircleAlert size={11} strokeWidth={2} />
        <span className="truncate" title={error ?? undefined}>
          {error ? `Couldn't connect. ${friendlyError(error).message}` : "Couldn't connect"}
        </span>
      </p>
    );
  }
  return <p className="font-display text-xs text-fg-subtle">Not connected</p>;
}
