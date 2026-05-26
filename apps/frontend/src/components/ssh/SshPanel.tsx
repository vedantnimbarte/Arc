import { useEffect, useMemo, useState } from 'react';
import {
  ChevronRight,
  Key,
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

/** SSH secondary sidebar — fills the right-side layout slot provided by App.tsx.
 *  No fixed positioning; the material surface + border are owned by the outer aside. */
export function SshPanel() {
  const hosts = useSsh((s) => s.hosts);
  const keys = useSsh((s) => s.keys);
  const sessions = useSsh((s) => s.sessions);
  const tab = useSsh((s) => s.panelTab);
  const setTab = useSsh((s) => s.setPanelTab);
  const detailHostId = useSsh((s) => s.detailHostId);
  const openDetail = useSsh((s) => s.openHostDetail);
  const hydrate = useSsh((s) => s.hydrate);
  const hydrated = useSsh((s) => s.hydrated);
  const setPanelOpen = useSsh((s) => s.setPanelOpen);

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

  const keyById = useMemo(() => {
    const m = new Map<string, SshKey>();
    for (const k of keys) m.set(k.id, k);
    return m;
  }, [keys]);

  const liveByHost = useSsh((s) => s.liveByHost);

  const detail = detailHostId
    ? hosts.find((h) => h.id === detailHostId) ?? null
    : null;

  return (
    <div role="region" aria-label="SSH" className="flex h-full flex-col overflow-hidden">
      <SectionHeader
        tab={tab}
        onTabChange={setTab}
        onClose={() => setPanelOpen(false)}
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
          <div className="px-4 py-3">
            <div className="flex items-center gap-2.5 rounded-squircle border border-border-subtle bg-bg-subtle px-3 py-2">
              <SearchIcon size={13} className="shrink-0 text-fg-subtle" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'hosts' ? 'search hosts…' : 'search keys…'}
                className="flex-1 bg-transparent font-mono text-[12px] text-fg-base placeholder:text-fg-subtle focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="text-fg-subtle transition-colors hover:text-fg-muted"
                >
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-4">
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

          <SectionFooter hostCount={hosts.length} keyCount={keys.length} />
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

// ─── Section header ───────────────────────────────────────────────────────────

interface SectionHeaderProps {
  tab: 'hosts' | 'keys';
  onTabChange: (t: 'hosts' | 'keys') => void;
  onClose: () => void;
  onPrimary: () => void;
  onSecondary?: () => void;
}

function SectionHeader({
  tab,
  onTabChange,
  onClose,
  onPrimary,
  onSecondary,
}: SectionHeaderProps) {
  return (
    <div className="flex flex-col border-b border-border-hairline">
      {/* Title row */}
      <div className="flex h-11 items-center justify-between px-4">
        <div className="flex items-center gap-2.5">
          <Server size={14} strokeWidth={1.5} className="text-accent" />
          <span className="select-none font-mono text-[10.5px] uppercase tracking-widest2 text-fg-muted">
            SSH
          </span>
        </div>
        <div className="flex items-center gap-0.5">
          {onSecondary && (
            <IconButton onClick={onSecondary} title="Import key">
              <ArrowDownToLine size={13} />
            </IconButton>
          )}
          <IconButton
            onClick={onPrimary}
            title={tab === 'hosts' ? 'New host' : 'Generate keypair'}
          >
            {tab === 'hosts' ? <Plus size={13} /> : <Sparkles size={13} />}
          </IconButton>
          <IconButton onClick={onClose} title="Close (⌘⇧S)">
            <X size={13} />
          </IconButton>
        </div>
      </div>

      {/* Tab strip with underline active indicator */}
      <div className="flex px-4">
        <TabPill active={tab === 'hosts'} onClick={() => onTabChange('hosts')}>
          Hosts
        </TabPill>
        <TabPill active={tab === 'keys'} onClick={() => onTabChange('keys')}>
          Keys
        </TabPill>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-6 w-6 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-hover hover:text-fg-base"
    >
      {children}
    </button>
  );
}

function TabPill({
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
        'relative mr-5 pb-2 pt-1.5 font-mono text-[10.5px] uppercase tracking-widest2 transition-colors',
        active ? 'text-fg-base' : 'text-fg-subtle hover:text-fg-muted',
      )}
    >
      {children}
      {active && (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 right-0 h-px rounded-full bg-accent"
        />
      )}
    </button>
  );
}

// ─── Host list ────────────────────────────────────────────────────────────────

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
      <div className="py-10 text-center font-mono text-[11px] text-fg-subtle">
        loading…
      </div>
    );
  }
  if (hosts.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
        <Server size={22} strokeWidth={1.3} className="text-fg-subtle" />
        <div className="font-display text-[13px] font-medium text-fg-base">
          No hosts yet
        </div>
        <div className="max-w-[200px] font-mono text-[11px] leading-relaxed text-fg-subtle">
          Add one with the{' '}
          <kbd className="rounded bg-bg-hover px-1.5 py-px font-mono text-[10px]">
            +
          </kbd>{' '}
          above. ARC stores connection params; auth lives in your keys list.
        </div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-px pt-1">
      {hosts.map((h) => {
        const liveId = liveByHost[h.id];
        const liveStatus = liveId ? sessions[liveId]?.status : undefined;
        const identity = h.identity_id ? keyById.get(h.identity_id) : null;
        return (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onOpen(h.id)}
              className="group flex w-full items-center gap-3 rounded-squircle px-3 py-3 text-left transition-colors hover:bg-bg-hover"
            >
              <span
                className={cn(
                  'mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full',
                  statusDotClass(liveStatus as never),
                )}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-display text-[13px] text-fg-base">
                    {h.name}
                  </span>
                  {liveStatus === 'connected' && (
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest2 text-status-ok">
                      Live
                    </span>
                  )}
                  {liveStatus === 'connecting' && (
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest2 text-accent">
                      Dialing
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-fg-muted">
                  {h.username}@{h.host}:{h.port}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-fg-subtle">
                  {identity ? identity.kind : 'password'}
                  {' · '}
                  {h.last_used_at ? relTime(h.last_used_at) : 'never used'}
                </div>
              </div>
              <ChevronRight
                size={13}
                className="shrink-0 text-fg-subtle opacity-0 transition group-hover:opacity-100"
              />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Key list ─────────────────────────────────────────────────────────────────

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
      <div className="py-10 text-center font-mono text-[11px] text-fg-subtle">
        loading…
      </div>
    );
  }
  if (keys.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
        <Key size={22} strokeWidth={1.3} className="text-fg-subtle" />
        <div className="font-display text-[13px] font-medium text-fg-base">
          No keys yet
        </div>
        <div className="max-w-[200px] font-mono text-[11px] leading-relaxed text-fg-subtle">
          Generate a fresh ed25519 keypair or import an existing one from{' '}
          <code className="font-mono">~/.ssh</code>.
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={onGenerate}
            className="rounded-squircle bg-accent/90 px-4 py-1.5 font-display text-[11px] font-medium text-bg-base transition hover:bg-accent"
          >
            Generate
          </button>
          <button
            type="button"
            onClick={onImport}
            className="rounded-squircle border border-border-subtle px-4 py-1.5 font-display text-[11px] font-medium text-fg-base transition hover:bg-bg-hover"
          >
            Import
          </button>
        </div>
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-2 pt-1">
      {keys.map((k) => {
        const uses = useCounts.get(k.id) ?? 0;
        return (
          <li
            key={k.id}
            className="rounded-squircle border border-border-subtle bg-bg-subtle/40 px-4 py-3"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-mono text-[12px] leading-tight text-fg-base">
                {k.name}
              </span>
              <span className="mt-px shrink-0 font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
                {k.kind}
              </span>
            </div>
            <div
              title={k.fingerprint}
              className="mt-2 break-all font-mono text-[10px] leading-relaxed text-fg-muted"
            >
              {chunkFingerprint(k.fingerprint)}
            </div>
            <div className="mt-2.5 flex items-center justify-between">
              <span className="font-mono text-[10px] text-fg-subtle">
                {uses === 0 ? 'unused' : `${uses} host${uses === 1 ? '' : 's'}`}
                {k.has_passphrase ? ' · secured' : ''}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Remove "${k.name}" from ARC? The file on disk stays.`)) {
                    void deleteKey(k.id, false);
                  }
                }}
                className="rounded px-1.5 py-px font-mono text-[10px] text-fg-subtle transition-colors hover:bg-bg-hover hover:text-status-err"
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

// ─── Footer ───────────────────────────────────────────────────────────────────

function SectionFooter({
  hostCount,
  keyCount,
}: {
  hostCount: number;
  keyCount: number;
}) {
  return (
    <footer className="border-t border-border-hairline bg-bg-chrome/30 px-4 py-2.5">
      <span className="font-mono text-[10px] uppercase tracking-widest2 text-fg-subtle">
        {hostCount} host{hostCount !== 1 ? 's' : ''} · {keyCount} key
        {keyCount !== 1 ? 's' : ''}
      </span>
    </footer>
  );
}
