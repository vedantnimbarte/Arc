import { create, type StoreApi } from 'zustand';
import { notifyEvent } from '../lib/notifyEvent';
import type { ClaudeSession } from './claudeCode';
import { useFiles, type AgentPanelTab } from './files';
import { useWorkspace } from './workspace';

/**
 * Every chat-surface conversation in ARC — the Agents panel's per-agent chats
 * and every agent window — as one live list, for the Sessions view, the status
 * bar's "N waiting" and the next-waiting shortcut.
 *
 * Each surface keeps its own store (see `sessionSlice`); this only watches them
 * and keeps a small snapshot per surface, so the list re-renders on status
 * changes rather than on every streamed token. Watching is also where a chat
 * agent that needs the user raises a notification, the same way an agent
 * terminal does.
 */

/** What a session wants from the user, in list order. */
export type SessionStatus = 'waiting' | 'working' | 'done';

/** Where a chat lives: the Agents panel (one per agent) or a window tab. */
export type ChatSurface = { kind: 'panel'; provider?: string } | { kind: 'window'; tabId: string };

export interface ChatSnapshot {
  key: string;
  agent: string;
  surface: ChatSurface;
  /** Null while the surface holds no conversation — it isn't listed then. */
  status: SessionStatus | null;
  /** Blocked on a permission prompt — the only chat state that counts toward
   *  the status bar's "N waiting". */
  pending: boolean;
  /** What it's asking for, while `pending`. */
  detail: string;
  /** The conversation's first prompt, as its name. */
  title: string;
  cwd: string | null;
  costUsd: number;
  /** When `status` last changed, ms since the epoch. */
  at: number;
}

export const useChatSessions = create<{ snaps: Record<string, ChatSnapshot> }>(() => ({
  snaps: {},
}));

const stores = new Map<string, StoreApi<ClaudeSession>>();
const unsubscribes = new Map<string, () => void>();

/** The store behind a listed chat, for row actions. */
export function chatStore(key: string): StoreApi<ClaudeSession> | undefined {
  return stores.get(key);
}

export function statusOf(s: ClaudeSession): SessionStatus | null {
  if (s.pending) return 'waiting';
  if (s.streaming) return 'working';
  return s.chat.length > 0 ? 'done' : null;
}

function titleOf(s: ClaudeSession): string {
  const first = s.chat.find((c) => c.kind === 'user');
  const text = first && first.kind === 'user' ? first.text.trim().split('\n')[0]! : '';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** Notification target for a surface: its tab, or the Sessions view. */
function targetOf(surface: ChatSurface) {
  return surface.kind === 'window'
    ? ({ kind: 'tab', tabId: surface.tabId } as const)
    : ({ kind: 'sidebar', view: 'sessions' } as const);
}

/**
 * Watch one chat surface. Called once when its store is created; the returned
 * function (also `unregisterChat(key)`) stops watching.
 */
export function registerChat(
  key: string,
  agent: string,
  surface: ChatSurface,
  store: StoreApi<ClaudeSession>,
  cwd: () => string | null,
): () => void {
  unregisterChat(key);
  stores.set(key, store);

  const snapshot = (s: ClaudeSession, prev?: ChatSnapshot): ChatSnapshot => {
    const status = statusOf(s);
    return {
      key,
      agent,
      surface,
      status,
      pending: !!s.pending,
      detail: s.pending ? `Allow ${s.pending.title || s.pending.tool}?` : '',
      title: titleOf(s),
      cwd: cwd(),
      costUsd: s.costUsd,
      at: prev && prev.status === status ? prev.at : Date.now(),
    };
  };

  const put = (next: ChatSnapshot) =>
    useChatSessions.setState((st) => ({ snaps: { ...st.snaps, [key]: next } }));
  put(snapshot(store.getState()));

  const unsubscribe = store.subscribe((s, prev) => {
    // Streamed tokens change the store constantly; only these fields matter.
    const before = useChatSessions.getState().snaps[key];
    const next = snapshot(s, before);
    if (
      !before ||
      before.status !== next.status ||
      before.pending !== next.pending ||
      before.detail !== next.detail ||
      before.title !== next.title ||
      before.costUsd !== next.costUsd ||
      before.cwd !== next.cwd
    ) {
      put(next);
    }

    // The two moments a chat agent needs the user, mirroring what an agent
    // terminal reports when it rings the bell or goes quiet.
    if (s.pending && !prev.pending) {
      notifyEvent({
        source: 'agent',
        title: `${agent} is waiting on you`,
        body: `Allow ${s.pending.title || s.pending.tool}? ${s.pending.summary}`.trim(),
        target: targetOf(surface),
      });
    } else if (prev.streaming && !s.streaming) {
      const last = s.chat[s.chat.length - 1];
      notifyEvent({
        source: 'agent',
        title: last?.kind === 'error' ? `${agent} stopped with an error` : `${agent} finished`,
        body: last?.kind === 'error' ? last.message : next.title || undefined,
        target: targetOf(surface),
      });
    }
  });
  unsubscribes.set(key, unsubscribe);
  return () => unregisterChat(key);
}

export function unregisterChat(key: string): void {
  unsubscribes.get(key)?.();
  unsubscribes.delete(key);
  stores.delete(key);
  if (useChatSessions.getState().snaps[key]) {
    useChatSessions.setState((st) => {
      const snaps = { ...st.snaps };
      delete snaps[key];
      return { snaps };
    });
  }
}

/** Bring a chat's surface into view: its window tab, or its agent's tab in the
 *  Agents panel. */
export function focusChat(surface: ChatSurface): void {
  if (surface.kind === 'window') {
    useWorkspace.getState().setActive(surface.tabId);
    return;
  }
  const files = useFiles.getState();
  files.setAgentPanelTab((surface.provider ?? 'claude') as AgentPanelTab);
  files.showSidebarView('agents');
}

/** Everything waiting on the user, oldest first: agent terminals that stopped,
 *  and chats blocked on a permission. */
export function waitingQueue(
  agentWaiting: Readonly<Record<string, { at: number }>>,
  snaps: Readonly<Record<string, ChatSnapshot>>,
): (
  { kind: 'tab'; tabId: string; at: number } | { kind: 'chat'; snap: ChatSnapshot; at: number }
)[] {
  return [
    ...Object.entries(agentWaiting).map(([tabId, w]) => ({
      kind: 'tab' as const,
      tabId,
      at: w.at,
    })),
    ...Object.values(snaps)
      .filter((s) => s.pending)
      .map((snap) => ({ kind: 'chat' as const, snap, at: snap.at })),
  ].sort((a, b) => a.at - b.at);
}
