import { useEffect, useRef } from 'react';
import { Activity, ArrowDownToLine, ChevronUp, X } from 'lucide-react';
import { useSsh } from '../../state/ssh';
import { cn } from '../../lib/cn';

interface SshSessionLogDrawerProps {
  sessionId: string;
  hostName: string;
  onClose: () => void;
}

/** Collapsible drawer rendered at the bottom of an SSH tab. Streams the
 *  same `SshLogEvent`s the connecting overlay consumed, but in chronological
 *  list form. Read-only — there's no input here; user keystrokes still go
 *  to the xterm above. */
export function SshSessionLogDrawer({
  sessionId,
  hostName,
  onClose,
}: SshSessionLogDrawerProps) {
  const session = useSsh((s) => s.sessions[sessionId]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Stick to the bottom unless the user has scrolled up.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [session?.log.length]);

  return (
    <div
      className={cn(
        'flex h-[180px] flex-col border-t border-border-subtle bg-bg-panel/85',
        'backdrop-blur-md animate-fade-in',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-chrome/40 px-3 py-1.5">
        <Activity className="h-3 w-3 text-accent" strokeWidth={1.6} />
        <div className="font-mono text-[10px] uppercase tracking-widest2 text-fg-muted">
          session log
        </div>
        <div className="font-mono text-[10.5px] text-fg-subtle">·</div>
        <div className="truncate font-display text-[11px] text-fg-base">{hostName}</div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const el = containerRef.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
            title="Scroll to bottom"
          >
            <ArrowDownToLine className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
            title="Close drawer"
          >
            <ChevronUp className="h-3 w-3" />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed"
      >
        {(!session || session.log.length === 0) && (
          <div className="text-fg-subtle">no events yet…</div>
        )}
        {session?.log.map((e, i) => (
          <LogRow key={i} at={e.at} level={e.level} msg={e.msg} />
        ))}
      </div>
    </div>
  );
}

function LogRow({ at, level, msg }: { at: number; level: string; msg: string }) {
  const isError = level === 'error';
  return (
    <div
      className={cn(
        'flex items-baseline gap-3 py-px',
        isError && 'border-l-2 border-status-err/60 pl-2',
      )}
    >
      <span className="shrink-0 text-fg-subtle">{tsToHms(at)}</span>
      <span
        className={cn(
          'w-[60px] shrink-0 truncate uppercase tracking-widest2',
          isError ? 'text-status-err' : 'text-fg-muted',
        )}
      >
        {level}
      </span>
      <span className="break-all text-fg-base">{msg}</span>
    </div>
  );
}

function tsToHms(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const millis = String(d.getMilliseconds()).padStart(3, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${millis}`;
}

interface LogToggleProps {
  open: boolean;
  onToggle: () => void;
}

/** Tiny icon button consumed by the SshTab header to open/close the drawer. */
export function LogDrawerToggle({ open, onToggle }: LogToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'flex items-center gap-1 rounded-md px-1.5 py-1 transition',
        open
          ? 'bg-bg-hover text-fg-base'
          : 'text-fg-muted hover:bg-bg-hover hover:text-fg-base',
      )}
      title={open ? 'Hide session log' : 'Show session log'}
    >
      <Activity className="h-3 w-3" />
      <span className="font-mono text-[9px] uppercase tracking-widest2">Log</span>
    </button>
  );
}

interface SshSessionLogPanelProps {
  onClose: () => void;
}

/** Standalone log surface — same content as the inline drawer, opened via
 *  ⌘⇧L. Floats over the workspace like the SshPanel. Picks the most
 *  recently active SSH session automatically. */
export function SshSessionLogPanel({ onClose }: SshSessionLogPanelProps) {
  const sessions = useSsh((s) => s.sessions);
  const hosts = useSsh((s) => s.hosts);

  // Newest session first.
  const sessionList = Object.values(sessions).sort(
    (a, b) => (b.connectedAt ?? 0) - (a.connectedAt ?? 0),
  );
  const active = sessionList[0];
  const host = active ? hosts.find((h) => h.id === active.hostId) : undefined;

  return (
    <div
      className={cn(
        'fixed right-4 top-12 bottom-4 z-40 flex w-[420px] flex-col',
        'overflow-hidden rounded-window border border-border-subtle',
        'bg-bg-panel/85 backdrop-blur-xl backdrop-saturate-180',
        'shadow-sheet animate-popover-in',
      )}
    >
      <div className="flex items-center justify-between border-b border-border-subtle bg-bg-chrome/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <Activity className="h-3.5 w-3.5 text-accent" />
          <span className="font-display text-[12px] text-fg-base">Session log</span>
          {host && (
            <>
              <span className="font-mono text-[10px] text-fg-subtle">·</span>
              <span className="font-mono text-[11px] text-fg-muted">{host.name}</span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[10.5px] leading-relaxed">
        {!active && (
          <div className="px-2 py-8 text-center text-fg-subtle">
            no live SSH session.
          </div>
        )}
        {active?.log.map((e, i) => (
          <LogRow key={i} at={e.at} level={e.level} msg={e.msg} />
        ))}
      </div>
    </div>
  );
}
