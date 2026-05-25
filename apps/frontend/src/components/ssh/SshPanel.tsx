import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Plus,
  Search as SearchIcon,
  Server,
  Sparkles,
  ArrowDownToLine,
  X,
} from 'lucide-react';
import { useSsh } from '../../state/ssh';
import { cn } from '../../lib/cn';
import { chunkFingerprint, relTime, statusDotClass } from './common';
import { HostDetail } from './HostDetail';
import { GenerateKeyDialog } from './GenerateKeyDialog';
import { ImportKeyDialog } from './ImportKeyDialog';
import { HostEditDialog } from './HostEditDialog';
import type { SshHost, SshKey } from '../../lib/tauri';

interface SshPanelProps {
  onClose: () => void;
}

/** Main SSH side panel. Two-tab segmented (HOSTS / KEYS) over a slide-out
 *  detail view. Mirrors the visual language of ChatPanel — same backdrop
 *  blur surface, same hairline gradients — with denser, monospace meta. */
export function SshPanel({ onClose }: SshPanelProps) {
  const hosts = useSsh((s) => s.hosts);
  const keys = useSsh((s) => s.keys);
  const sessions = useSsh((s) => s.sessions);
  const tab = useSsh((s) => s.panelTab);
  const setTab = useSsh((s) => s.setPanelTab);
  const detailHostId = useSsh((s) => s.detailHostId);
  const openDetail = useSsh((s) => s.openHostDetail);
  const hydrate = useSsh((s) => s.hydrate);
  const hydrated = useSsh((s) => s.hydrated);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const [query, setQuery] = useState('');
  const [hostEditOpen, setHostEditOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<SshHost | null>(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const filteredHosts = useMemo(() => {
    if (!query) return hosts;
    const q = query.toLowerCase();
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.host.toLowerCase().includes(q) ||
        h.username.toLowerCase().includes(q),
    );
  }, [hosts, query]);

  const filteredKeys = useMemo(() => {
    if (!query) return keys;
    const q = query.toLowerCase();
    return keys.filter(
      (k) =>
        k.name.toLowerCase().includes(q) ||
        k.fingerprint.toLowerCase().includes(q),
    );
  }, [keys, query]);

  // Map identity_id → key for the meta line in HostRow.
  const keyById = useMemo(() => {
    const m = new Map<string, SshKey>();
    for (const k of keys) m.set(k.id, k);
    return m;
  }, [keys]);

  // Map hostId → live session (for the LIVE tag).
  const liveByHost = useSsh((s) => s.liveByHost);

  const detail = detailHostId
    ? hosts.find((h) => h.id === detailHostId) ?? null
    : null;

  return (
    <div
      role="region"
      aria-label="SSH"
      className={cn(
        'fixed right-4 top-12 bottom-4 z-40 flex w-[380px] flex-col',
        'overflow-hidden rounded-window border border-border-subtle',
        'bg-bg-panel/85 backdrop-blur-xl backdrop-saturate-180',
        'shadow-sheet animate-popover-in',
      )}
    >
      <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.10] to-transparent" />

      <PanelHeader
        tab={tab}
        onTabChange={setTab}
        onClose={onClose}
        onPrimary={() => {
          if (tab === 'hosts') {
            setEditingHost(null);
            setHostEditOpen(true);
          } else {
            setGenerateOpen(true);
          }
        }}
        onSecondary={tab === 'keys' ? () => setImportOpen(true) : undefined}
      />

      {detail ? (
        <HostDetail
          host={detail}
          identity={detail.identity_id ? keyById.get(detail.identity_id) ?? null : null}
          onBack={() => openDetail(null)}
          onEdit={(h) => {
            setEditingHost(h);
            setHostEditOpen(true);
          }}
        />
      ) : (
        <>
          <div className="flex items-center gap-2 px-3.5 pt-2">
            <div className="flex flex-1 items-center gap-2 rounded-squircle border border-border-subtle bg-bg-subtle px-2.5 py-1.5">
              <SearchIcon className="h-3.5 w-3.5 text-fg-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'hosts' ? 'search hosts' : 'search keys'}
                className="flex-1 bg-transparent font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2">
            {tab === 'hosts' ? (
              <HostList
                hosts={filteredHosts}
                keyById={keyById}
                sessions={sessions}
                liveByHost={liveByHost}
                hydrated={hydrated}
                onOpen={(id) => openDetail(id)}
              />
            ) : (
              <KeyList
                keys={filteredKeys}
                hosts={hosts}
                hydrated={hydrated}
                onGenerate={() => setGenerateOpen(true)}
                onImport={() => setImportOpen(true)}
              />
            )}
          </div>

          <PanelFooter hostCount={hosts.length} keyCount={keys.length} />
        </>
      )}

      {hostEditOpen && (
        <HostEditDialog
          existing={editingHost}
          onClose={() => {
            setHostEditOpen(false);
            setEditingHost(null);
          }}
        />
      )}
      {generateOpen && <GenerateKeyDialog onClose={() => setGenerateOpen(false)} />}
      {importOpen && <ImportKeyDialog onClose={() => setImportOpen(false)} />}
    </div>
  );
}

interface PanelHeaderProps {
  tab: 'hosts' | 'keys';
  onTabChange: (t: 'hosts' | 'keys') => void;
  onClose: () => void;
  onPrimary: () => void;
  onSecondary?: () => void;
}

function PanelHeader({
  tab,
  onTabChange,
  onClose,
  onPrimary,
  onSecondary,
}: PanelHeaderProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle bg-bg-chrome/40 px-3.5 pt-3 pb-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Server className="h-3.5 w-3.5 text-accent" strokeWidth={1.6} />
          <span className="font-display text-[13px] font-medium tracking-wide text-fg-base">
            SSH
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onSecondary && (
            <button
              type="button"
              onClick={onSecondary}
              className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
              title="Import key"
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onPrimary}
            className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
            title={tab === 'hosts' ? 'Add host' : 'Generate keypair'}
          >
            {tab === 'hosts' ? (
              <Plus className="h-3.5 w-3.5" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-fg-muted transition hover:bg-bg-hover hover:text-fg-base"
            title="Close (⌘⇧S)"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest2">
        <SegmentedTab active={tab === 'hosts'} onClick={() => onTabChange('hosts')}>
          Hosts
        </SegmentedTab>
        <span className="text-fg-subtle">·</span>
        <SegmentedTab active={tab === 'keys'} onClick={() => onTabChange('keys')}>
          Keys
        </SegmentedTab>
      </div>
    </div>
  );
}

function SegmentedTab({
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
        'transition-colors',
        active ? 'text-fg-base' : 'text-fg-muted hover:text-fg-base',
      )}
    >
      {children}
    </button>
  );
}

function PanelFooter({
  hostCount,
  keyCount,
}: {
  hostCount: number;
  keyCount: number;
}) {
  return (
    <div className="border-t border-border-subtle bg-bg-chrome/30 px-3.5 py-1.5">
      <div className="font-mono text-[10px] uppercase tracking-widest2 text-fg-subtle">
        {hostCount} host{hostCount === 1 ? '' : 's'} · {keyCount} key
        {keyCount === 1 ? '' : 's'}
      </div>
    </div>
  );
}

interface HostListProps {
  hosts: SshHost[];
  keyById: Map<string, SshKey>;
  sessions: Record<string, { hostId: string; status: string }>;
  liveByHost: Record<string, string>;
  hydrated: boolean;
  onOpen: (id: string) => void;
}

function HostList({
  hosts,
  keyById,
  sessions,
  liveByHost,
  hydrated,
  onOpen,
}: HostListProps) {
  if (!hydrated) {
    return (
      <div className="px-2 py-8 text-center font-mono text-[11px] text-fg-subtle">
        loading hosts…
      </div>
    );
  }
  if (hosts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 py-12 text-center">
        <Server className="h-5 w-5 text-fg-subtle" strokeWidth={1.4} />
        <div className="font-display text-[12px] text-fg-base">No hosts yet</div>
        <div className="max-w-[240px] font-mono text-[10.5px] text-fg-subtle">
          Add one with the <kbd className="rounded bg-bg-subtle px-1 py-px">+</kbd> in the
          header. ARC stores the connection params; identity lives in your SSH keys list.
        </div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-px">
      {hosts.map((h) => {
        const liveId = liveByHost[h.id];
        const liveStatus = liveId ? sessions[liveId]?.status : undefined;
        const identity = h.identity_id ? keyById.get(h.identity_id) : null;
        return (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onOpen(h.id)}
              className="group flex w-full items-center gap-3 rounded-squircle px-2 py-2 text-left transition hover:bg-bg-hover"
            >
              <span
                className={cn(
                  'mt-1 inline-block h-2 w-2 shrink-0 rounded-full',
                  statusDotClass(liveStatus as never),
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-display text-[13px] text-fg-base">
                    {h.name}
                  </span>
                  {liveStatus === 'connected' && (
                    <span className="font-mono text-[9px] uppercase tracking-widest2 text-status-ok">
                      Live
                    </span>
                  )}
                  {liveStatus === 'connecting' && (
                    <span className="font-mono text-[9px] uppercase tracking-widest2 text-accent">
                      Dialing
                    </span>
                  )}
                </div>
                <div className="mt-px truncate font-mono text-[10.5px] text-fg-muted">
                  {h.username}@{h.host}:{h.port}
                  {identity ? ` · ${identity.kind}` : ''}
                  {' · '}
                  {h.last_used_at ? relTime(h.last_used_at) : 'never'}
                </div>
              </div>
              <ChevronRight className="h-3.5 w-3.5 text-fg-subtle opacity-0 transition group-hover:opacity-100" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface KeyListProps {
  keys: SshKey[];
  hosts: SshHost[];
  hydrated: boolean;
  onGenerate: () => void;
  onImport: () => void;
}

function KeyList({ keys, hosts, hydrated, onGenerate, onImport }: KeyListProps) {
  const deleteKey = useSsh((s) => s.keyDelete);
  const useCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of hosts) {
      if (h.identity_id) m.set(h.identity_id, (m.get(h.identity_id) ?? 0) + 1);
    }
    return m;
  }, [hosts]);

  if (!hydrated) {
    return (
      <div className="px-2 py-8 text-center font-mono text-[11px] text-fg-subtle">
        loading keys…
      </div>
    );
  }
  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-2 py-12 text-center">
        <Sparkles className="h-5 w-5 text-fg-subtle" strokeWidth={1.4} />
        <div className="font-display text-[12px] text-fg-base">No keys yet</div>
        <div className="max-w-[260px] font-mono text-[10.5px] text-fg-subtle">
          Generate a fresh ed25519 keypair or import an existing one from
          <span className="font-mono"> ~/.ssh</span>.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onGenerate}
            className="rounded-squircle bg-accent/90 px-3 py-1 font-display text-[11px] text-bg-base transition hover:bg-accent"
          >
            Generate
          </button>
          <button
            type="button"
            onClick={onImport}
            className="rounded-squircle border border-border-subtle px-3 py-1 font-display text-[11px] text-fg-base transition hover:bg-bg-hover"
          >
            Import
          </button>
        </div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1">
      {keys.map((k) => {
        const uses = useCounts.get(k.id) ?? 0;
        return (
          <li
            key={k.id}
            className="rounded-squircle border border-border-subtle bg-bg-subtle/40 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[12px] text-fg-base">
                {k.name}
              </span>
              <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
                {k.kind}
              </span>
            </div>
            <div
              title={k.fingerprint}
              className="mt-1 truncate font-mono text-[10px] text-fg-muted"
            >
              {chunkFingerprint(k.fingerprint)}
            </div>
            <div className="mt-1 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest2 text-fg-subtle">
              <span>
                {uses === 0 ? 'unused' : `used by ${uses} host${uses === 1 ? '' : 's'}`}
                {k.has_passphrase ? ' · passphrase saved' : ''}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Remove key "${k.name}" from ARC? The file on disk stays.`)) {
                    void deleteKey(k.id, false);
                  }
                }}
                className="rounded px-1 text-[10px] tracking-normal text-fg-subtle hover:bg-bg-hover hover:text-status-err"
              >
                remove
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
