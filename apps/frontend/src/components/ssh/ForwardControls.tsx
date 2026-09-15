import { useCallback, useEffect, useState } from 'react';
import { Pause, Play, Plus, X } from 'lucide-react';
import {
  sshForwardAdd,
  sshForwardList,
  sshForwardRemove,
  sshForwardSetActive,
  type SshForwardInfo,
  type SshForwardSpec,
  type SshId,
} from '../../lib/tauri';
import { cn } from '../../lib/cn';
import { Select } from '../Select';
import { formatForward, parseForward } from './common';

/** Kind picker + `8080:localhost:80` field. Used by the host editor (saved
 *  forwards) and the host detail view (forwards on the live session). */
export function ForwardInput({ onAdd }: { onAdd: (spec: SshForwardSpec) => Promise<void> | void }) {
  const [kind, setKind] = useState<SshForwardSpec['kind']>('local');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    const parsed = parseForward(kind, text);
    if (typeof parsed === 'string') {
      setErr(parsed);
      return;
    }
    try {
      await onAdd(parsed);
      setText('');
      setErr(null);
    } catch (caught) {
      setErr(String(caught));
    }
  };

  return (
    <div>
      <div className="grid grid-cols-[64px_1fr_auto] gap-1.5">
        <Select
          value={kind}
          onChange={setKind}
          ariaLabel="Forward direction"
          mono
          className="rounded-squircle"
          options={[
            { value: 'local', label: '-L', hint: 'Listen on this machine, reach through the server.' },
            { value: 'remote', label: '-R', hint: 'Listen on the server, reach back to this machine.' },
          ]}
        />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="8080:localhost:80"
          aria-label="Forward"
          className="w-full min-w-0 rounded-squircle border border-border-subtle bg-bg-subtle px-2 py-1.5 font-mono text-sm text-fg-base placeholder:text-fg-subtle focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void add()}
          title="Add forward"
          className="rounded-squircle border border-border-subtle px-2 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {err && <div className="mt-1 font-mono text-2xs text-status-err">{err}</div>}
    </div>
  );
}

/** One row in a forward list: the spec, an optional status, and actions. */
export function ForwardRow({
  spec,
  info,
  onToggle,
  onRemove,
}: {
  spec: SshForwardSpec;
  info?: SshForwardInfo;
  onToggle?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      {info && (
        <span
          title={info.error ?? info.state}
          className={cn(
            'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
            info.state === 'active'
              ? 'bg-status-ok'
              : info.state === 'failed'
                ? 'bg-status-err'
                : 'border border-border-strong bg-transparent',
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-fg-base">{formatForward(spec)}</div>
        {info?.error && (
          <div className="truncate font-mono text-2xs text-status-err" title={info.error}>
            {info.error}
          </div>
        )}
      </div>
      {info && onToggle && (
        <button
          type="button"
          onClick={onToggle}
          title={info.state === 'active' ? 'Stop' : 'Start'}
          className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
        >
          {info.state === 'active' ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-status-err"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

/** Forwards on a live session. Changes here last for the session only; saved
 *  forwards are edited on the host. State is fetched on mount and after each
 *  action — a forward's status only changes when it's started or stopped. */
export function LiveForwards({ sessionId }: { sessionId: SshId }) {
  const [list, setList] = useState<SshForwardInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const run = useCallback(async (op: Promise<SshForwardInfo[]>) => {
    try {
      setList(await op);
      setErr(null);
    } catch (caught) {
      setErr(String(caught));
    }
  }, []);

  useEffect(() => {
    void run(sshForwardList(sessionId));
  }, [sessionId, run]);

  return (
    <div>
      {list.map((f) => (
        <ForwardRow
          key={f.id}
          spec={f}
          info={f}
          onToggle={() => void run(sshForwardSetActive(sessionId, f.id, f.state !== 'active'))}
          onRemove={() => void run(sshForwardRemove(sessionId, f.id))}
        />
      ))}
      <div className="mt-1.5">
        <ForwardInput
          onAdd={async (spec) => {
            // Throws on validation errors so ForwardInput keeps the text.
            setList(await sshForwardAdd(sessionId, spec));
          }}
        />
      </div>
      {err && <div className="mt-1 font-mono text-2xs text-status-err">{err}</div>}
    </div>
  );
}
