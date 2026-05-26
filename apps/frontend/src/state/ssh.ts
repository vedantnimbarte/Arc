import { create } from 'zustand';
import {
  isTauri,
  onSshExit,
  onSshLog,
  sshConnect,
  sshClose,
  sshHostDelete,
  sshHostList,
  sshHostUpsert,
  sshKeyDelete,
  sshKeyGenerate,
  sshKeyImport,
  sshKeyList,
  sshSessionLogs,
  type SshHost,
  type SshHostInput,
  type SshId,
  type SshKey,
  type SshKeyWithPublic,
  type SshLogEvent,
  type SshSessionLogRow,
  type SshGenerateKeyOpts,
  type SshImportKeyOpts,
} from '../lib/tauri';

export type SshStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'closed';

export const SSH_PANEL_MIN = 260;
export const SSH_PANEL_MAX = 520;
export const SSH_PANEL_DEFAULT = 300;

/** Ordered list of handshake steps used by `<SshConnectingOverlay>` for its
 *  6-dot progress. Each `level` string emitted by the Rust side maps to
 *  exactly one of these. Anything else is rendered without filling a dot. */
export const HANDSHAKE_STEPS = ['resolve', 'tcp', 'kex', 'auth', 'channel', 'ready'] as const;
export type HandshakeStep = (typeof HANDSHAKE_STEPS)[number];

export interface SshSessionState {
  id: SshId;
  hostId: string;
  status: SshStatus;
  /** Index into HANDSHAKE_STEPS — how many dots are filled. */
  progress: number;
  /** Last error message, if any. */
  error: string | null;
  log: SshLogEvent[];
  /** Wall-clock ms when status flipped to `connected`. Drives uptime in
   *  the host-detail status pill. */
  connectedAt: number | null;
}

interface SshUiState {
  /** Panel open/close — wired to ⌘⇧S. */
  panelOpen: boolean;
  /** Which segmented tab the panel is showing. */
  panelTab: 'hosts' | 'keys';
  /** If non-null, panel shows the host-detail view for this host. */
  detailHostId: string | null;
  /** Standalone log surface (⌘⇧L). */
  logPanelOpen: boolean;
  /** Width of the SSH sidebar panel in px (clamped to SSH_PANEL_MIN/MAX). */
  panelWidth: number;
}

interface SshStateShape extends SshUiState {
  hosts: SshHost[];
  keys: SshKey[];
  sessions: Record<SshId, SshSessionState>;
  /** Map host id → most-recent live session id (for the panel "LIVE" badge). */
  liveByHost: Record<string, SshId>;
  hydrated: boolean;

  // ─── UI ──────────────────────────────────────────────────────────────
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setPanelTab: (tab: 'hosts' | 'keys') => void;
  openHostDetail: (hostId: string | null) => void;
  setLogPanelOpen: (open: boolean) => void;
  setPanelWidth: (w: number) => void;

  // ─── Hosts ───────────────────────────────────────────────────────────
  hostUpsert: (input: SshHostInput) => Promise<SshHost>;
  hostDelete: (id: string) => Promise<void>;

  // ─── Keys ────────────────────────────────────────────────────────────
  keyGenerate: (opts: SshGenerateKeyOpts) => Promise<SshKeyWithPublic>;
  keyImport: (opts: SshImportKeyOpts) => Promise<SshKey>;
  keyDelete: (id: string, deleteFiles?: boolean) => Promise<void>;

  // ─── Sessions ────────────────────────────────────────────────────────
  /** Open a session for `hostId`. The returned session id is also used as
   *  the SSH tab's identifier. */
  connect: (hostId: string, cols: number, rows: number) => Promise<SshId>;
  disconnect: (sessionId: SshId) => Promise<void>;
  loadHostLogs: (hostId: string) => Promise<SshSessionLogRow[]>;

  // ─── Lifecycle ───────────────────────────────────────────────────────
  hydrate: () => Promise<void>;
}

const MAX_LOG_LINES = 500;

function stepIndex(level: string): number {
  const i = (HANDSHAKE_STEPS as readonly string[]).indexOf(level);
  return i;
}

export const useSsh = create<SshStateShape>((set, get) => ({
  hosts: [],
  keys: [],
  sessions: {},
  liveByHost: {},
  hydrated: false,

  panelOpen: false,
  panelTab: 'hosts',
  detailHostId: null,
  logPanelOpen: false,
  panelWidth: SSH_PANEL_DEFAULT,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setPanelTab: (tab) => set({ panelTab: tab }),
  openHostDetail: (hostId) => set({ detailHostId: hostId }),
  setLogPanelOpen: (open) => set({ logPanelOpen: open }),
  setPanelWidth: (w) => set({ panelWidth: Math.min(Math.max(w, SSH_PANEL_MIN), SSH_PANEL_MAX) }),

  hostUpsert: async (input) => {
    if (!isTauri) {
      const fake: SshHost = {
        id: input.id ?? crypto.randomUUID(),
        workspace_id: input.workspace_id ?? null,
        name: input.name,
        host: input.host,
        port: input.port ?? 22,
        username: input.username,
        identity_id: input.identity_id ?? null,
        keepalive_secs: input.keepalive_secs ?? 30,
        startup_cmd: input.startup_cmd ?? null,
        created_at: Date.now(),
        last_used_at: null,
      };
      set((s) => ({ hosts: dedupe([...s.hosts, fake]) }));
      return fake;
    }
    const saved = await sshHostUpsert(input);
    set((s) => ({ hosts: dedupe(replaceOrAppend(s.hosts, saved)) }));
    return saved;
  },

  hostDelete: async (id) => {
    if (isTauri) await sshHostDelete(id);
    set((s) => ({
      hosts: s.hosts.filter((h) => h.id !== id),
      detailHostId: s.detailHostId === id ? null : s.detailHostId,
    }));
  },

  keyGenerate: async (opts) => {
    if (!isTauri) {
      throw new Error('Key generation requires the desktop app.');
    }
    const result = await sshKeyGenerate(opts);
    const { public_openssh: _ignore, ...key } = result;
    set((s) => ({ keys: dedupe([key as SshKey, ...s.keys]) }));
    return result;
  },

  keyImport: async (opts) => {
    if (!isTauri) {
      throw new Error('Key import requires the desktop app.');
    }
    const key = await sshKeyImport(opts);
    set((s) => ({ keys: dedupe([key, ...s.keys]) }));
    return key;
  },

  keyDelete: async (id, deleteFiles = false) => {
    if (isTauri) await sshKeyDelete(id, deleteFiles);
    set((s) => ({ keys: s.keys.filter((k) => k.id !== id) }));
  },

  connect: async (hostId, cols, rows) => {
    if (!isTauri) {
      throw new Error('SSH requires the desktop app.');
    }
    const sessionId = await sshConnect({ hostId, cols, rows });

    const initial: SshSessionState = {
      id: sessionId,
      hostId,
      status: 'connecting',
      progress: 0,
      error: null,
      log: [],
      connectedAt: null,
    };
    set((s) => ({
      sessions: { ...s.sessions, [sessionId]: initial },
    }));

    // Subscribe to log events. The store owns this subscription for the
    // session's lifetime; both `disconnect()` and the `ssh://exit` handler
    // unlisten when the session ends.
    const logUnsub = await onSshLog(sessionId, (entry) => {
      const cur = get().sessions[sessionId];
      if (!cur) return;

      const idx = stepIndex(entry.level);
      const isError = entry.level === 'error';
      const isClosed = entry.level === 'closed';

      const nextLog = [...cur.log, entry];
      if (nextLog.length > MAX_LOG_LINES) nextLog.splice(0, nextLog.length - MAX_LOG_LINES);

      const next: SshSessionState = {
        ...cur,
        log: nextLog,
        progress:
          idx >= 0 ? Math.max(cur.progress, idx + 1) : cur.progress,
        status: isError
          ? 'error'
          : isClosed
            ? 'closed'
            : entry.level === 'ready'
              ? 'connected'
              : cur.status,
        error: isError ? entry.msg : cur.error,
        connectedAt:
          cur.connectedAt === null && entry.level === 'ready'
            ? Date.now()
            : cur.connectedAt,
      };

      set((s) => ({
        sessions: { ...s.sessions, [sessionId]: next },
        liveByHost:
          next.status === 'connected'
            ? { ...s.liveByHost, [hostId]: sessionId }
            : s.liveByHost,
      }));
    });

    const exitUnsub = await onSshExit(sessionId, () => {
      const cur = get().sessions[sessionId];
      if (cur) {
        set((s) => ({
          sessions: {
            ...s.sessions,
            [sessionId]: { ...cur, status: 'closed' },
          },
          liveByHost: removeKey(s.liveByHost, hostId, sessionId),
        }));
      }
      void logUnsub();
      void exitUnsub();
    });

    return sessionId;
  },

  disconnect: async (sessionId) => {
    if (isTauri) {
      try {
        await sshClose(sessionId);
      } catch {
        /* best-effort */
      }
    }
    set((s) => {
      const cur = s.sessions[sessionId];
      if (!cur) return s;
      const nextSessions = { ...s.sessions };
      delete nextSessions[sessionId];
      return {
        sessions: nextSessions,
        liveByHost: removeKey(s.liveByHost, cur.hostId, sessionId),
      };
    });
  },

  loadHostLogs: async (hostId) => {
    if (!isTauri) return [];
    return sshSessionLogs(hostId);
  },

  hydrate: async () => {
    if (get().hydrated) return;
    if (!isTauri) {
      set({ hydrated: true });
      return;
    }
    try {
      const [hosts, keys] = await Promise.all([sshHostList(null), sshKeyList()]);
      set({ hosts, keys, hydrated: true });
    } catch (err) {
      console.warn('[ssh] hydrate failed', err);
      set({ hydrated: true });
    }
  },
}));

function dedupe<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function replaceOrAppend<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx < 0) return [item, ...list];
  const copy = list.slice();
  copy[idx] = item;
  return copy;
}

function removeKey(
  map: Record<string, string>,
  hostId: string,
  sessionId: string,
): Record<string, string> {
  if (map[hostId] !== sessionId) return map;
  const next = { ...map };
  delete next[hostId];
  return next;
}
