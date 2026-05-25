import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { HANDSHAKE_STEPS, useSsh } from '../../state/ssh';
import { cn } from '../../lib/cn';

interface SshConnectingOverlayProps {
  sessionId: string;
  hostName: string;
  hostLine: string;
  onCancel: () => void;
}

/** Connecting overlay shown over the xterm canvas before the channel goes
 *  `ready`. Renders a 6-dot progress that fills as each handshake step
 *  completes (`resolve → tcp → kex → auth → channel → ready`), the host
 *  identity for context, and the most-recent log line as a quiet ticker.
 *
 *  Crossfade out is handled by the parent: when status flips to
 *  `connected`, the parent simply unmounts this component. */
export function SshConnectingOverlay({
  sessionId,
  hostName,
  hostLine,
  onCancel,
}: SshConnectingOverlayProps) {
  const session = useSsh((s) => s.sessions[sessionId]);
  const lastLine = session?.log[session.log.length - 1];

  // Pulse the active dot — visual cue that something is moving even when
  // the current step is taking longer than expected.
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setPulse((p) => p + 1), 600);
    return () => window.clearInterval(id);
  }, []);

  const progress = session?.progress ?? 0;
  const stepLabel = HANDSHAKE_STEPS[Math.min(progress, HANDSHAKE_STEPS.length - 1)];

  return (
    <div
      className={cn(
        'absolute inset-0 z-10 flex flex-col items-center justify-center gap-6',
        'bg-bg-base/95 backdrop-blur-sm animate-fade-in',
      )}
    >
      {/* Progress dots row */}
      <div className="flex flex-col items-center gap-3">
        <div className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
          {progressTitle(progress)}
        </div>
        <div className="flex items-center gap-2.5">
          {HANDSHAKE_STEPS.map((step, i) => {
            const filled = i < progress;
            const active = i === progress;
            return (
              <span
                key={step}
                className={cn(
                  'inline-block h-2 w-2 rounded-full transition-colors duration-300',
                  filled
                    ? 'bg-accent'
                    : active
                      ? pulse % 2 === 0
                        ? 'bg-accent/70'
                        : 'bg-accent/30'
                      : 'border border-border-strong bg-transparent',
                )}
                title={step}
                aria-label={step}
              />
            );
          })}
        </div>
        <div className="font-mono text-[10px] uppercase tracking-widest2 text-fg-muted">
          {stepLabel}
        </div>
      </div>

      {/* Identity card */}
      <div className="flex flex-col items-center gap-1">
        <div className="font-display text-[15px] text-fg-base">{hostName}</div>
        <div className="font-mono text-[11px] text-fg-muted">{hostLine}</div>
      </div>

      {/* Last log line */}
      <div className="h-4 font-mono text-[10.5px] text-fg-subtle">
        {lastLine ? `${lastLine.level}  ${lastLine.msg}` : 'opening…'}
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="flex items-center gap-1.5 rounded-squircle border border-border-subtle px-3 py-1 font-display text-[11.5px] text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
      >
        <X className="h-3.5 w-3.5" />
        Cancel
      </button>
    </div>
  );
}

function progressTitle(p: number): string {
  if (p <= 1) return 'opening';
  if (p <= 3) return 'handshaking';
  if (p <= 5) return 'authorising';
  return 'ready';
}
