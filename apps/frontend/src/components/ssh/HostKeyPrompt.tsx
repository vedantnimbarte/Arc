import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ShieldQuestion } from 'lucide-react';
import {
  onSshHostKeyPrompt,
  sshHostKeyRespond,
  type SshHostKeyPrompt as Prompt,
} from '../../lib/tauri';
import { cn } from '../../lib/cn';

/**
 * Asked once per host ARC has never connected to.
 *
 * A handshake is parked on every one of these, so it must always produce an
 * answer — Escape, the backdrop, and the close path all refuse rather than
 * dismiss, because silently doing nothing would leave the connection hanging
 * and, worse, teach people that the prompt is noise.
 *
 * A host key that *changed* never gets here. That case is refused in Rust with
 * no override, on purpose: an override button is exactly what someone being
 * intercepted would click.
 */
export function HostKeyPrompt() {
  // Two connections can race (a terminal and a remote workspace on the same
  // host), so prompts queue rather than clobbering each other.
  const [queue, setQueue] = useState<Prompt[]>([]);
  const [copied, setCopied] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let un: (() => void) | undefined;
    void onSshHostKeyPrompt((p) => setQueue((q) => [...q, p])).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);

  const current = queue[0];

  const answer = (accept: boolean) => {
    if (!current) return;
    void sshHostKeyRespond(current.promptId, accept).catch(() => {
      /* the connection gave up already; dropping the prompt is the right end */
    });
    setCopied(false);
    setQueue((q) => q.slice(1));
  };

  // Focus lands on Cancel, not on the accept button: the safe answer should be
  // the one a reflexive Enter produces.
  useEffect(() => {
    if (current) cancelRef.current?.focus();
  }, [current?.promptId]);

  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        answer(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current?.promptId]);

  if (!current) return null;

  const where =
    current.port === 22 ? current.host : `${current.host}:${current.port}`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-scrim-2 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hostkey-title"
      onClick={() => answer(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="material-sheet mt-[12vh] w-[520px] max-w-[94vw] animate-sheet-in rounded-window p-5 shadow-sheet ring-1 ring-edge-2"
      >
        <span
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-status-warn/[0.12] text-status-warn ring-1 ring-status-warn/25"
          aria-hidden
        >
          <ShieldQuestion size={18} strokeWidth={1.9} />
        </span>

        <h2
          id="hostkey-title"
          className="font-display text-base font-semibold tracking-tight text-fg-base"
        >
          First connection to <span className="font-mono font-normal">{where}</span>
        </h2>
        <p className="mt-2 font-display text-xs leading-relaxed text-fg-muted">
          ARC has no record of this server. Check the fingerprint below against what
          the server's administrator published. If it doesn't match, something is
          intercepting the connection — cancel.
        </p>

        {/* The one thing worth reading. Selectable, monospaced, and given room,
            because the whole prompt is worthless if this is hard to compare. */}
        <div className="mt-4 rounded-xl bg-surface-1 p-3 ring-1 ring-inset ring-edge-2">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-sm leading-relaxed text-fg-base">
              {current.fingerprint}
            </code>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(current.fingerprint).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                });
              }}
              aria-label="Copy fingerprint"
              title="Copy fingerprint"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-subtle transition-all duration-200 ease-apple hover:bg-surface-2 hover:text-fg-base active:scale-90 focus-visible:outline-none focus-visible:shadow-focus"
            >
              {copied ? (
                <Check size={13} strokeWidth={2.2} className="text-status-ok" />
              ) : (
                <Copy size={13} strokeWidth={2} />
              )}
            </button>
          </div>
          <p className="mt-1.5 font-mono text-2xs text-fg-subtle">{current.algorithm}</p>
        </div>

        <p className="mt-3 font-display text-2xs leading-relaxed text-fg-subtle">
          Connecting adds this key to <span className="font-mono">~/.ssh/known_hosts</span>,
          so your terminal will trust it too, and ARC will refuse the connection if it
          ever changes.
        </p>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={() => answer(false)}
            className="h-8 rounded-lg bg-surface-2 px-3.5 font-display text-xs font-medium text-fg-base ring-1 ring-inset ring-edge-2 transition-all duration-200 ease-apple hover:bg-surface-3 active:scale-[0.98] focus-visible:outline-none focus-visible:shadow-focus"
          >
            Cancel
          </button>
          <button
            onClick={() => answer(true)}
            className="h-8 rounded-lg px-3.5 font-display text-xs font-medium text-fg-muted transition-colors hover:bg-surface-1 hover:text-fg-base focus-visible:outline-none focus-visible:shadow-focus"
          >
            Connect once verified
          </button>
        </div>

        {queue.length > 1 && (
          <p className="mt-3 text-right font-mono text-2xs text-fg-subtle">
            {queue.length - 1} more waiting
          </p>
        )}
      </div>
    </div>
  );
}
