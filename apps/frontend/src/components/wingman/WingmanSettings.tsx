import { useEffect, useState } from 'react';
import { CircleCheck, CircleAlert, Loader2 } from 'lucide-react';
import { secretSet } from '../../lib/tauri';
import { useSettings } from '../../state/settings';
import { useWingman, WINGMAN_TOKEN_KEY } from '../../state/wingman';

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
      }
    }
    await connect(trimmed, token.trim() || null);
    // Never keep the secret in component state longer than the call needs.
    setToken('');
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-border-subtle bg-bg-base/40 px-3 py-2.5">
        <label className="flex flex-col gap-1">
          <span className="font-display text-sm font-medium tracking-tight text-fg-base">
            Daemon address
          </span>
          <span className="font-display text-xs text-fg-muted">
            Run <code className="font-mono">wingman serve</code> and paste its address. Leave
            empty to turn the integration off.
          </span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply();
            }}
            placeholder="http://127.0.0.1:8787"
            spellCheck={false}
            className="mt-1 rounded-md border border-edge-1 bg-surface-1 px-2 py-1 font-mono text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:outline-none"
          />
        </label>

        <label className="mt-2 flex flex-col gap-1">
          <span className="font-display text-sm font-medium tracking-tight text-fg-base">
            API token
          </span>
          <span className="font-display text-xs text-fg-muted">
            Only needed when the daemon binds a non-loopback address. Stored in your OS
            credential vault, never in ARC&rsquo;s database.
          </span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void apply();
            }}
            placeholder={health?.auth_required ? 'required by this daemon' : 'not required'}
            autoComplete="off"
            spellCheck={false}
            className="mt-1 rounded-md border border-edge-1 bg-surface-1 px-2 py-1 font-mono text-xs text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:outline-none"
          />
        </label>

        <div className="mt-2.5 flex items-center justify-between gap-3">
          <StatusLine
            status={status}
            version={health?.version ?? null}
            projectCount={projects.length}
            error={lastError}
          />
          <button
            type="button"
            onClick={() => void apply()}
            className="shrink-0 rounded-md bg-accent-soft px-3 py-1 font-display text-xs font-medium text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20"
          >
            {url.trim() ? 'Connect' : 'Disconnect'}
          </button>
        </div>
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
      <p className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-fg-muted">
        <Loader2 size={11} strokeWidth={2} className="animate-spin" />
        connecting…
      </p>
    );
  }
  if (status === 'connected') {
    return (
      <p className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-status-ok">
        <CircleCheck size={11} strokeWidth={2} />
        <span className="truncate">
          wingman {version} · {projectCount} project{projectCount === 1 ? '' : 's'}
        </span>
      </p>
    );
  }
  if (status === 'error') {
    return (
      <p className="flex min-w-0 items-center gap-1.5 font-mono text-2xs text-status-err">
        <CircleAlert size={11} strokeWidth={2} />
        <span className="truncate" title={error ?? undefined}>
          {error ?? 'connection failed'}
        </span>
      </p>
    );
  }
  return <p className="font-mono text-2xs text-fg-subtle">not connected</p>;
}
