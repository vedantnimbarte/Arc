import { useState } from 'react';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { useSsh } from '../../state/ssh';
import { cn } from '../../lib/cn';

interface GenerateKeyDialogProps {
  onClose: () => void;
}

/** Generate-keypair flow. Two phases:
 *    1. form (type, name, optional passphrase)
 *    2. result (public-key text + Copy button + Done)
 *  Stays inside the panel rather than spawning a new window — the
 *  generated key is short-lived state we don't want to dismount. */
export function GenerateKeyDialog({ onClose }: GenerateKeyDialogProps) {
  const generate = useSsh((s) => s.keyGenerate);

  const [algorithm, setAlgorithm] = useState<'ed25519' | 'rsa'>('ed25519');
  const [name, setName] = useState(`id_ed25519_arc-${stamp()}`);
  const [passphrase, setPassphrase] = useState('');
  const [showPp, setShowPp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ public: string; fingerprint: string; name: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const k = await generate({
        name: name.trim(),
        algorithm,
        passphrase: passphrase || undefined,
      });
      setDone({ public: k.public_openssh, fingerprint: k.fingerprint, name: k.name });
    } catch (caught) {
      setErr(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const copyPub = async () => {
    if (!done) return;
    try {
      await navigator.clipboard.writeText(done.public);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg-panel/95 backdrop-blur-md animate-fade-in">
      <div className="border-b border-border-subtle px-4 py-2.5">
        <div className="font-display text-[12px] text-fg-base">
          {done ? 'Key generated' : 'Generate keypair'}
        </div>
      </div>

      {done ? (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="rounded-squircle border border-status-ok/40 bg-status-ok/10 px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-widest2 text-status-ok">
              saved
            </div>
            <div className="mt-1 font-mono text-[11px] text-fg-base">~/.ssh/{done.name}</div>
            <div className="mt-1 font-mono text-[10px] text-fg-muted">{done.fingerprint}</div>
          </div>

          <div className="mt-4">
            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
              Public key — paste this into the remote host's authorized_keys
            </div>
            <pre className="max-h-[160px] overflow-auto rounded-squircle border border-border-subtle bg-bg-subtle/60 px-3 py-2 font-mono text-[10.5px] leading-snug text-fg-base">
              {done.public}
            </pre>
            <button
              type="button"
              onClick={copyPub}
              className={cn(
                'mt-2 flex items-center gap-1.5 rounded-squircle border px-3 py-1 font-display text-[11px] transition',
                copied
                  ? 'border-status-ok/40 bg-status-ok/10 text-status-ok'
                  : 'border-border-subtle text-fg-base hover:bg-bg-hover',
              )}
            >
              <Copy className="h-3.5 w-3.5" />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-3">
            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
              Type
            </div>
            <div className="inline-flex items-center gap-px rounded-squircle border border-border-subtle bg-bg-subtle/60 p-px">
              <TypeChip
                active={algorithm === 'ed25519'}
                onClick={() => {
                  setAlgorithm('ed25519');
                  setName(`id_ed25519_arc-${stamp()}`);
                }}
              >
                ed25519
              </TypeChip>
              <TypeChip
                active={algorithm === 'rsa'}
                onClick={() => {
                  setAlgorithm('rsa');
                  setName(`id_rsa_arc-${stamp()}`);
                }}
              >
                rsa
              </TypeChip>
            </div>
          </div>

          <div className="mb-3">
            <div className="mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
              Name
            </div>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 font-mono text-[12px] text-fg-base focus:border-accent focus:outline-none"
            />
            <div className="mt-1 font-mono text-[10px] text-fg-subtle">
              writes ~/.ssh/{name} and {name}.pub
            </div>
          </div>

          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
              <span>Passphrase</span>
              <span className="text-fg-subtle">optional</span>
            </div>
            <div className="flex items-center gap-1 rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 focus-within:border-accent">
              <input
                type={showPp ? 'text' : 'password'}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="leave blank for no passphrase"
                className="flex-1 bg-transparent font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setShowPp((v) => !v)}
                className="text-fg-muted hover:text-fg-base"
                aria-label={showPp ? 'Hide passphrase' : 'Show passphrase'}
              >
                {showPp ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <div className="mt-1 font-mono text-[10px] text-fg-subtle">
              stored in the OS keyring (dev.arc.terminal.ssh)
            </div>
          </div>

          {err && (
            <div className="rounded border border-status-err/40 bg-status-err/10 px-2 py-1.5 font-mono text-[11px] text-status-err">
              {err}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-bg-chrome/30 px-3 py-2.5">
        {done ? (
          <button
            type="button"
            onClick={onClose}
            className="rounded-squircle bg-accent/90 px-3 py-1.5 font-display text-[11.5px] text-bg-base transition hover:bg-accent"
          >
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="rounded-squircle px-3 py-1.5 font-display text-[11.5px] text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !name.trim()}
              className={cn(
                'rounded-squircle px-3 py-1.5 font-display text-[11.5px] transition',
                !busy && name.trim()
                  ? 'bg-accent/90 text-bg-base hover:bg-accent'
                  : 'cursor-not-allowed border border-border-subtle text-fg-subtle',
              )}
            >
              {busy ? 'Generating…' : 'Generate'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TypeChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-[8px] px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest2 transition',
        active ? 'bg-accent/90 text-bg-base' : 'text-fg-muted hover:text-fg-base',
      )}
    >
      {children}
    </button>
  );
}

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function pad(n: number): string {
  return String(n).padStart(2, '0');
}
