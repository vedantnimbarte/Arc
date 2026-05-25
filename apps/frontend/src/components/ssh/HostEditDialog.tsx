import { useState } from 'react';
import { useSsh } from '../../state/ssh';
import { cn } from '../../lib/cn';
import type { SshHost } from '../../lib/tauri';

interface HostEditDialogProps {
  /** Existing host, or null when creating a new one. */
  existing: SshHost | null;
  onClose: () => void;
}

/** Modal-in-panel for adding or editing a host. Renders as an overlay over
 *  the panel content, not as a separate window — keeps the user close to
 *  the host list. */
export function HostEditDialog({ existing, onClose }: HostEditDialogProps) {
  const keys = useSsh((s) => s.keys);
  const upsert = useSsh((s) => s.hostUpsert);
  const setDetail = useSsh((s) => s.openHostDetail);

  const [name, setName] = useState(existing?.name ?? '');
  const [host, setHost] = useState(existing?.host ?? '');
  const [port, setPort] = useState(String(existing?.port ?? 22));
  const [username, setUsername] = useState(existing?.username ?? '');
  const [identityId, setIdentityId] = useState(existing?.identity_id ?? '');
  const [keepalive, setKeepalive] = useState(String(existing?.keepalive_secs ?? 30));
  const [startupCmd, setStartupCmd] = useState(existing?.startup_cmd ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const valid = name.trim() && host.trim() && username.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      const saved = await upsert({
        id: existing?.id,
        workspace_id: existing?.workspace_id ?? null,
        name: name.trim(),
        host: host.trim(),
        port: Math.max(1, parseInt(port, 10) || 22),
        username: username.trim(),
        identity_id: identityId || null,
        keepalive_secs: Math.max(0, parseInt(keepalive, 10) || 30),
        startup_cmd: startupCmd.trim() ? startupCmd : null,
      });
      setDetail(saved.id);
      onClose();
    } catch (caught) {
      setErr(String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-bg-panel/95 backdrop-blur-md animate-fade-in">
      <div className="border-b border-border-subtle px-4 py-2.5">
        <div className="font-display text-[12px] text-fg-base">
          {existing ? 'Edit host' : 'Add host'}
        </div>
      </div>
      <form onSubmit={submit} className="flex-1 overflow-y-auto px-4 py-3">
        <FormRow label="Name">
          <Input value={name} onChange={setName} placeholder="production-api" autoFocus />
        </FormRow>
        <div className="grid grid-cols-[1fr_72px] gap-2">
          <FormRow label="Host">
            <Input value={host} onChange={setHost} placeholder="10.0.4.21" />
          </FormRow>
          <FormRow label="Port">
            <Input value={port} onChange={setPort} placeholder="22" inputMode="numeric" />
          </FormRow>
        </div>
        <FormRow label="User">
          <Input value={username} onChange={setUsername} placeholder="ubuntu" />
        </FormRow>
        <FormRow label="Identity">
          <select
            value={identityId}
            onChange={(e) => setIdentityId(e.target.value)}
            className="w-full rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 font-mono text-[12px] text-fg-base focus:border-accent focus:outline-none"
          >
            <option value="">(none — connect will fail)</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} · {k.kind}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Keepalive (seconds)">
          <Input
            value={keepalive}
            onChange={setKeepalive}
            placeholder="30"
            inputMode="numeric"
          />
        </FormRow>
        <FormRow label="Startup command (optional)">
          <textarea
            value={startupCmd}
            onChange={(e) => setStartupCmd(e.target.value)}
            placeholder="cd /var/www && tail -f deploy.log"
            rows={2}
            className="w-full resize-none rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent focus:outline-none"
          />
        </FormRow>

        {err && (
          <div className="mt-2 rounded border border-status-err/40 bg-status-err/10 px-2 py-1.5 font-mono text-[11px] text-status-err">
            {err}
          </div>
        )}
      </form>
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
          disabled={!valid || busy}
          className={cn(
            'rounded-squircle px-3 py-1.5 font-display text-[11.5px] transition',
            valid && !busy
              ? 'bg-accent/90 text-bg-base hover:bg-accent'
              : 'cursor-not-allowed border border-border-subtle text-fg-subtle',
          )}
        >
          {existing ? 'Save' : 'Add'}
        </button>
      </div>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3 last:mb-0">
      <div className="mb-1 font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
        {label}
      </div>
      {children}
    </div>
  );
}

function Input(props: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  inputMode?: 'text' | 'numeric';
}) {
  return (
    <input
      autoFocus={props.autoFocus}
      inputMode={props.inputMode}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      placeholder={props.placeholder}
      className="w-full rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:border-accent focus:outline-none"
    />
  );
}
