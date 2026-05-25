import { useState } from 'react';
import { Folder } from 'lucide-react';
import { useSsh } from '../../state/ssh';
import { cn } from '../../lib/cn';
import { fsPickFolder, isTauri } from '../../lib/tauri';

interface ImportKeyDialogProps {
  onClose: () => void;
}

/** Import an existing on-disk OpenSSH-format private key. ARC validates the
 *  file (decrypts with the passphrase if needed), records the fingerprint,
 *  and saves the passphrase to the OS keyring. The file itself stays where
 *  it is — we never copy or modify it. */
export function ImportKeyDialog({ onClose }: ImportKeyDialogProps) {
  const importKey = useSsh((s) => s.keyImport);

  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!path.trim() || !name.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await importKey({
        name: name.trim(),
        path: path.trim(),
        passphrase: passphrase || undefined,
      });
      onClose();
    } catch (caught) {
      setErr(String(caught));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    if (!isTauri) return;
    // We don't have a file-picker IPC; reuse the folder picker and let the
    // user paste the full path. The path field stays editable.
    const dir = await fsPickFolder(null);
    if (dir) setPath(dir);
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg-panel/95 backdrop-blur-md animate-fade-in">
      <div className="border-b border-border-subtle px-4 py-2.5">
        <div className="font-display text-[12px] text-fg-base">Import existing key</div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="mb-3">
          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
            Path to private key
          </div>
          <div className="flex items-center gap-1 rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 focus-within:border-accent">
            <input
              autoFocus
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                if (!name) {
                  const base = e.target.value.split(/[\\/]/).pop() ?? '';
                  setName(base);
                }
              }}
              placeholder="/Users/you/.ssh/id_ed25519"
              className="flex-1 bg-transparent font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
            />
            <button
              type="button"
              onClick={pick}
              className="text-fg-muted hover:text-fg-base"
              aria-label="Browse"
            >
              <Folder className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="mb-3">
          <div className="mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
            Name
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="id_ed25519"
            className="w-full rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 font-mono text-[12px] text-fg-base focus:border-accent focus:outline-none"
          />
        </div>

        <div className="mb-3">
          <div className="mb-1 flex items-center justify-between font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
            <span>Passphrase</span>
            <span className="text-fg-subtle">if encrypted</span>
          </div>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="leave blank if unencrypted"
            className="w-full rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent focus:outline-none"
          />
        </div>

        {err && (
          <div className="rounded border border-status-err/40 bg-status-err/10 px-2 py-1.5 font-mono text-[11px] text-status-err">
            {err}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-bg-chrome/30 px-3 py-2.5">
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
          disabled={busy || !path.trim() || !name.trim()}
          className={cn(
            'rounded-squircle px-3 py-1.5 font-display text-[11.5px] transition',
            !busy && path.trim() && name.trim()
              ? 'bg-accent/90 text-bg-base hover:bg-accent'
              : 'cursor-not-allowed border border-border-subtle text-fg-subtle',
          )}
        >
          {busy ? 'Importing…' : 'Import'}
        </button>
      </div>
    </div>
  );
}
