import { AlertTriangle } from 'lucide-react';

interface SshErrorCardProps {
  hostName: string;
  message: string;
  onRetry: () => void;
  onClose: () => void;
}

/** Error surface shown inside an SSH tab when the handshake fails or the
 *  channel closes abnormally. Distinct from `<SshConnectingOverlay>` —
 *  this stays mounted until the user retries or closes the tab. */
export function SshErrorCard({ hostName, message, onRetry, onClose }: SshErrorCardProps) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-base/95 backdrop-blur-sm animate-fade-in">
      <div className="flex max-w-[420px] flex-col items-center gap-3 rounded-window border border-status-err/30 bg-bg-panel/80 px-6 py-5 shadow-sheet">
        <AlertTriangle className="h-6 w-6 text-status-err" strokeWidth={1.4} />
        <div className="font-display text-[14px] text-fg-base">{hostName}</div>
        <div className="font-mono text-[10px] uppercase tracking-widest2 text-status-err">
          connection failed
        </div>
        <pre className="max-h-[140px] overflow-auto whitespace-pre-wrap rounded-squircle bg-bg-subtle/60 px-3 py-2 font-mono text-[11px] text-fg-base">
          {message}
        </pre>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-squircle bg-accent/90 px-3 py-1.5 font-display text-[11.5px] text-bg-base transition hover:bg-accent"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-squircle border border-border-subtle px-3 py-1.5 font-display text-[11.5px] text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
          >
            Close tab
          </button>
        </div>
      </div>
    </div>
  );
}
