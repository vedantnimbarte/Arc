import { useCallback, useEffect, useState } from 'react';
import { BookmarkPlus, Pause, Play, Plus, X } from 'lucide-react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import {
  onSshForwards,
  sshForwardAdd,
  sshForwardList,
  sshForwardRemove,
  sshForwardSetActive,
  type SshForwardInfo,
  type SshForwardSpec,
  type SshHost,
  type SshId,
} from '../../lib/tauri';
import { cn } from '../../lib/cn';
import { askConfirm } from '../../state/confirm';
import { useSsh } from '../../state/ssh';
import { Select } from '../Select';
import { formatForward, parseForward, relTime, sameForward, withForward } from './common';

/** Kind picker + `8080:localhost:80` (or `1080` for SOCKS) field. Used by the host editor (saved
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
            {
              value: 'dynamic',
              label: '-D',
              hint: 'SOCKS5 proxy on this machine; every connection goes out from the server.',
            },
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
          placeholder={kind === 'dynamic' ? '1080' : '8080:localhost:80'}
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

/** One row in a forward list: the spec, an optional live status, and actions.
 *  `saved` marks a live forward as saved on the host (true) or session-only
 *  (false); leave it out where the distinction means nothing. */
export function ForwardRow({
  spec,
  info,
  saved,
  onToggle,
  onSave,
  onRemove,
}: {
  spec: SshForwardSpec;
  info?: SshForwardInfo;
  saved?: boolean;
  onToggle?: () => void;
  onSave?: () => void;
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
        <div className="flex items-baseline gap-1.5">
          <span className="truncate font-mono text-xs text-fg-base">{formatForward(spec)}</span>
          {saved !== undefined && (
            <span
              title={saved ? 'Saved on the host: starts on every connect' : 'This session only'}
              className="shrink-0 font-mono text-2xs uppercase tracking-widest2 text-fg-subtle"
            >
              {saved ? 'saved' : 'session'}
            </span>
          )}
        </div>
        {info && info.total_conns > 0 && (
          <div className="font-mono text-2xs text-fg-muted">
            {info.active_conns} open · {info.total_conns} total
          </div>
        )}
        {info?.error && (
          <div className="truncate font-mono text-2xs text-status-err" title={info.error}>
            {info.error}
          </div>
        )}
        {info?.last_error && (
          <div
            className="truncate font-mono text-2xs text-status-err/80"
            title={`${new Date(info.last_error.at).toLocaleString()}: ${info.last_error.msg}`}
          >
            {relTime(info.last_error.at)}: {info.last_error.msg}
          </div>
        )}
      </div>
      {onSave && (
        <button
          type="button"
          onClick={onSave}
          title="Save to host"
          className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
        >
          <BookmarkPlus className="h-3 w-3" />
        </button>
      )}
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

/** Forwards on a live session. Changes here last for the session unless a
 *  forward is saved to the host. The list is pushed from the backend
 *  (`ssh://forward/<id>`) whenever a forward or a connection through one
 *  changes, and returned by each action. */
export function LiveForwards({ sessionId, host }: { sessionId: SshId; host: SshHost }) {
  const [list, setList] = useState<SshForwardInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const upsert = useSsh((s) => s.hostUpsert);

  const run = useCallback(async (op: Promise<SshForwardInfo[]>) => {
    try {
      setList(await op);
      setErr(null);
    } catch (caught) {
      setErr(String(caught));
    }
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let gone = false;
    void (async () => {
      // Subscribe before the first fetch so a change in between isn't lost.
      const fn = await onSshForwards(sessionId, setList).catch(() => undefined);
      if (gone) {
        fn?.();
        return;
      }
      unlisten = fn;
      await run(sshForwardList(sessionId));
    })();
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [sessionId, run]);

  const saveForwards = async (forwards: SshForwardSpec[]) => {
    try {
      await upsert({
        id: host.id,
        workspace_id: host.workspace_id,
        name: host.name,
        host: host.host,
        port: host.port,
        username: host.username,
        identity_id: host.identity_id,
        keepalive_secs: host.keepalive_secs,
        startup_cmd: host.startup_cmd,
        jump_host_id: host.jump_host_id,
        forwards,
        remote_workspace_forwards: host.remote_workspace_forwards,
      });
      setErr(null);
    } catch (caught) {
      setErr(String(caught));
    }
  };

  const remove = async (f: SshForwardInfo) => {
    if (host.forwards.some((s) => sameForward(s, f))) {
      const alsoHost = await askConfirm({
        title: `Also remove ${formatForward(f)} from ${host.name}?`,
        body: 'It stops on this session either way. Removing it from the host too means it no longer starts on connect.',
        confirmLabel: 'remove from host too',
        destructive: true,
      });
      if (alsoHost) await saveForwards(host.forwards.filter((s) => !sameForward(s, f)));
    }
    await run(sshForwardRemove(sessionId, f.id));
  };

  return (
    <div>
      {list.map((f) => {
        const saved = host.forwards.some((s) => sameForward(s, f));
        return (
          <ForwardRow
            key={f.id}
            spec={f}
            info={f}
            saved={saved}
            onToggle={() => void run(sshForwardSetActive(sessionId, f.id, f.state !== 'active'))}
            onSave={saved ? undefined : () => void saveForwards(withForward(host.forwards, f))}
            onRemove={() => void remove(f)}
          />
        );
      })}
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
