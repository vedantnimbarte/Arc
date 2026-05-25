import { useEffect, useState } from 'react';
import { ChevronLeft, Pencil, Power, Trash2, Zap } from 'lucide-react';
import { useSsh, type SshSessionState } from '../../state/ssh';
import { cn } from '../../lib/cn';
import { chunkFingerprint, statusDotClass, statusLabel, uptime } from './common';
import type { SshHost, SshKey } from '../../lib/tauri';
import { useWorkspace } from '../../state/workspace';

interface HostDetailProps {
  host: SshHost;
  identity: SshKey | null;
  onBack: () => void;
  onEdit: (host: SshHost) => void;
}

/** Slide-over detail view inside the SSH panel. Single source of truth for
 *  a host's connection params, identity, and the Connect / Edit / Remove
 *  actions. Status pill mirrors the live session state via `useSsh`. */
export function HostDetail({ host, identity, onBack, onEdit }: HostDetailProps) {
  const liveByHost = useSsh((s) => s.liveByHost);
  const sessions = useSsh((s) => s.sessions);
  const disconnect = useSsh((s) => s.disconnect);
  const deleteHost = useSsh((s) => s.hostDelete);

  const liveId = liveByHost[host.id];
  const live: SshSessionState | undefined = liveId ? sessions[liveId] : undefined;

  const openSshTab = useWorkspace((s) => s.openSshTab);

  // Tick once a second so the uptime label refreshes without re-renders
  // anywhere else.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (live?.status !== 'connected') return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [live?.status]);

  const handleConnect = async () => {
    if (!identity) return;
    // Defer the actual sshConnect() to Terminal.tsx (so cols/rows match the
    // mounted xterm). openSshTab creates the tab + focuses it; the SshTab
    // component then drives the connect.
    openSshTab(host);
  };

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-border-subtle bg-bg-chrome/40 px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <span className="font-mono text-[10px] uppercase tracking-widest2">Back</span>
        </button>
        <div className="font-display text-[12px] font-medium text-fg-base">{host.name}</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onEdit(host)}
            className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
            title="Edit host"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {/* Status pill */}
        <div className="mb-4 flex items-center gap-2 rounded-squircle border border-border-subtle bg-bg-subtle/40 px-2.5 py-1.5">
          <span
            className={cn(
              'inline-block h-2 w-2 shrink-0 rounded-full',
              statusDotClass(live?.status as never),
            )}
          />
          <span className="font-mono text-[10px] uppercase tracking-widest2 text-fg-base">
            {statusLabel(live?.status as never)}
          </span>
          {live?.status === 'connected' && (
            <span className="ml-auto font-mono text-[10px] text-fg-muted">
              uptime {uptime(live.connectedAt)}
            </span>
          )}
          {live?.status === 'error' && live.error && (
            <span className="ml-auto truncate font-mono text-[10px] text-status-err">
              {live.error}
            </span>
          )}
        </div>

        <Field label="Host">
          <span className="font-mono text-[13px] text-fg-base">
            {host.username}
            <span className="text-fg-subtle"> @ </span>
            {host.host}
            <span className="text-fg-subtle"> : </span>
            {host.port}
          </span>
        </Field>

        <Field label="Identity">
          {identity ? (
            <>
              <div className="font-mono text-[12px] text-fg-base">{identity.path}</div>
              <div className="mt-px font-mono text-[10px] text-fg-muted">
                {chunkFingerprint(identity.fingerprint)} · {identity.kind}
              </div>
            </>
          ) : (
            <div className="font-mono text-[11px] text-status-err">
              none — add one in the Keys tab
            </div>
          )}
        </Field>

        <Field label="Keepalive">
          <span className="font-mono text-[12px] text-fg-base">
            {host.keepalive_secs}
            <span className="ml-1 text-fg-subtle">s</span>
          </span>
        </Field>

        {host.startup_cmd && (
          <Field label="Startup">
            <pre className="rounded-squircle border border-border-subtle bg-bg-subtle/60 px-2 py-1.5 font-mono text-[11px] text-fg-base">
              {host.startup_cmd}
            </pre>
          </Field>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-chrome/30 px-3 py-2.5">
        {live?.status === 'connected' || live?.status === 'connecting' ? (
          <button
            type="button"
            onClick={() => liveId && disconnect(liveId)}
            className="flex items-center gap-1.5 rounded-squircle border border-status-err/40 px-3 py-1.5 font-display text-[11.5px] text-status-err transition hover:bg-status-err/10"
          >
            <Power className="h-3.5 w-3.5" />
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={!identity}
            className={cn(
              'flex items-center gap-1.5 rounded-squircle px-3 py-1.5 font-display text-[11.5px] transition',
              identity
                ? 'bg-accent/90 text-bg-base hover:bg-accent'
                : 'cursor-not-allowed border border-border-subtle text-fg-subtle',
            )}
          >
            <Zap className="h-3.5 w-3.5" />
            Connect
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => {
            if (confirm(`Remove host "${host.name}"? This only deletes the saved entry.`)) {
              void deleteHost(host.id);
            }
          }}
          className="flex items-center gap-1.5 rounded-squircle border border-border-subtle px-2.5 py-1.5 font-display text-[11.5px] text-fg-muted transition hover:bg-bg-hover hover:text-status-err"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
        {label}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
