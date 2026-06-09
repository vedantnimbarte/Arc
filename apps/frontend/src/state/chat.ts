import { create } from 'zustand';
import {
  isTauri,
  sessionChatAppend,
  sessionChatClear,
  sessionChatMessagesLoad,
  sessionChatSessionCreate,
  sessionChatSessionDelete,
  sessionChatSessionUpdate,
  sessionChatSessionsList,
  type ChatRole as WireChatRole,
  type PersistedChatMessage,
} from '../lib/tauri';
import { DEFAULT_AGENTS } from './agents';

export type ChatRole = WireChatRole;

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** True once the row exists in SQLite. Streaming assistant messages flip
   *  to true after `finalize(id)` runs. Skipped entirely in web-only mode. */
  persisted?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  /** Agent persona id; matches the UI agent registry. */
  agentId: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

/** Running token totals for a chat session, fed by the cost meter (Tier 1.6).
 *  In-memory only — a fresh count per launch is acceptable for an estimate. */
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** Number of assistant turns that reported usage — lets the UI distinguish
   *  "0 tokens" from "no usage data yet" (e.g. local models). */
  turns: number;
}

/** A snippet selected from the editor/terminal — or a whole file attached
 *  via the composer's + / @ / `/file` affordances — that the user has
 *  staged to send with their next message. Ephemeral: lives only in
 *  memory and is consumed on send. */
export interface ChatContext {
  id: string;
  source: 'terminal' | 'editor' | 'file';
  label: string;
  text: string;
  /** Absolute path for `source: 'file'`. Used to dedupe attachments and
   *  render the path under the chip. */
  path?: string;
}

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  isStreaming: boolean;
  /** Mirror of the active session's messages so consumers can subscribe to
   *  a stable slot without recomputing on every render. */
  messages: ChatMessage[];
  /** True after the first successful hydrate (or failure that fell back to
   *  in-memory mode). UI uses this to avoid the "no API key" prompt while
   *  keys + sessions are still loading. */
  hydrated: boolean;
  /** Snippets staged for the next send (from "Ask ARC AI" on a selection).
   *  Cleared on successful send; the user can also dismiss individually. */
  pendingContexts: ChatContext[];
  /** Per-session running token usage, keyed by session id. */
  usage: Record<string, ChatUsage>;

  // ─── Sessions ─────────────────────────────────────────────────────────
  newSession: (agentId: string) => Promise<string>;
  setActiveSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  setSessionAgent: (id: string, agentId: string) => Promise<void>;

  // ─── Messages (operate on active session) ─────────────────────────────
  append: (msg: Omit<ChatMessage, 'id' | 'ts' | 'persisted'>) => string;
  appendChunk: (id: string, chunk: string) => void;
  /** Persist a message that was appended with empty content (i.e. a
   *  streaming assistant turn). Idempotent — safe to call after a stream
   *  ends, an error, or a cancel. */
  finalize: (id: string) => Promise<void>;
  /** Clear messages of the active session (keeps the session row). */
  clear: () => Promise<void>;
  setStreaming: (s: boolean) => void;
  /** Add a completed turn's token counts to the active session's running
   *  total. Counts are per-turn totals (not deltas), so callers pass the
   *  final figures once a stream ends. */
  recordUsage: (inputTokens: number, outputTokens: number) => void;

  // ─── Pending contexts (Ask ARC AI) ────────────────────────────────────
  addPendingContext: (c: Omit<ChatContext, 'id'> & { id?: string }) => string;
  removePendingContext: (id: string) => void;
  clearPendingContexts: () => void;

  // ─── Lifecycle ────────────────────────────────────────────────────────
  hydrate: () => Promise<void>;
}

const DEFAULT_AGENT_ID = DEFAULT_AGENTS[0]!.id;
const NEW_SESSION_TITLE = 'New Chat';
const AUTO_TITLE_LEN = 56;
const LEGACY_LS_KEY = 'arc-chat';

function autoTitleFor(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= AUTO_TITLE_LEN) return oneLine || NEW_SESSION_TITLE;
  return oneLine.slice(0, AUTO_TITLE_LEN).trimEnd() + '…';
}

function makeLocalSession(agentId: string): ChatSession {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: NEW_SESSION_TITLE,
    agentId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

function persistedToMessage(m: PersistedChatMessage): ChatMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    ts: m.created_at,
    persisted: true,
  };
}

export const useChat = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isStreaming: false,
  messages: [],
  hydrated: false,
  pendingContexts: [],
  usage: {},

  // ─── Sessions ─────────────────────────────────────────────────────────

  newSession: async (agentId) => {
    if (!isTauri) {
      const s = makeLocalSession(agentId);
      set((st) => ({
        sessions: [s, ...st.sessions],
        activeSessionId: s.id,
        messages: [],
      }));
      return s.id;
    }
    const row = await sessionChatSessionCreate(null, agentId, null);
    const fresh: ChatSession = {
      id: row.id,
      title: row.title ?? NEW_SESSION_TITLE,
      agentId: row.agent_id ?? agentId,
      messages: [],
      createdAt: row.created_at,
      updatedAt: row.last_message_at,
    };
    set((st) => ({
      sessions: [fresh, ...st.sessions],
      activeSessionId: fresh.id,
      messages: [],
    }));
    return fresh.id;
  },

  setActiveSession: async (id) => {
    const target = get().sessions.find((s) => s.id === id);
    if (!target) return;
    // Use the cached message list immediately for snappy switch, then refresh
    // from SQLite in the background to pick up writes from elsewhere.
    set({ activeSessionId: id, messages: target.messages });
    if (!isTauri) return;
    try {
      const rows = await sessionChatMessagesLoad(id);
      const fresh = rows.map(persistedToMessage);
      set((st) => {
        // Stale-result guard: the user may have switched again while we
        // were loading. Only apply if `id` is still active.
        if (st.activeSessionId !== id) return st;
        const sessions = st.sessions.map((s) =>
          s.id === id ? { ...s, messages: fresh } : s,
        );
        return { sessions, messages: fresh };
      });
    } catch (err) {
      console.error('[chat] message load failed:', err);
    }
  },

  deleteSession: async (id) => {
    if (isTauri) {
      try {
        await sessionChatSessionDelete(id);
      } catch (err) {
        console.error('[chat] delete failed:', err);
      }
    }
    set((state) => {
      const remaining = state.sessions.filter((s) => s.id !== id);
      const wasActive = state.activeSessionId === id;
      // Invariant: there is always at least one session.
      if (remaining.length === 0) {
        const fresh = makeLocalSession(DEFAULT_AGENT_ID);
        if (isTauri) {
          // Persist the replacement session lazily; if the create fails the
          // user can still type into the in-memory one.
          void sessionChatSessionCreate(null, fresh.agentId, null)
            .then((row) => {
              set((st) => ({
                sessions: st.sessions.map((s) =>
                  s.id === fresh.id ? { ...s, id: row.id } : s,
                ),
                activeSessionId:
                  st.activeSessionId === fresh.id ? row.id : st.activeSessionId,
              }));
            })
            .catch((err) => console.error('[chat] replace session failed:', err));
        }
        return {
          sessions: [fresh],
          activeSessionId: fresh.id,
          messages: fresh.messages,
        };
      }
      if (wasActive) {
        const next = remaining[0]!;
        return {
          sessions: remaining,
          activeSessionId: next.id,
          messages: next.messages,
        };
      }
      return { sessions: remaining };
    });
  },

  renameSession: async (id, title) => {
    const trimmed = title.trim() || NEW_SESSION_TITLE;
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title: trimmed, updatedAt: Date.now() } : s,
      ),
    }));
    if (!isTauri) return;
    try {
      await sessionChatSessionUpdate(id, { title: trimmed });
    } catch (err) {
      console.error('[chat] rename failed:', err);
    }
  },

  setSessionAgent: async (id, agentId) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, agentId, updatedAt: Date.now() } : s,
      ),
    }));
    if (!isTauri) return;
    try {
      await sessionChatSessionUpdate(id, { agentId });
    } catch (err) {
      console.error('[chat] set agent failed:', err);
    }
  },

  // ─── Messages ─────────────────────────────────────────────────────────

  append: (msg) => {
    const id = crypto.randomUUID();
    const ts = Date.now();
    const newMsg: ChatMessage = { ...msg, id, ts };

    set((state) => {
      // Lazy session bootstrap — only happens in web-only mode where the
      // user may type before any session exists. In Tauri, hydrate() always
      // leaves us with at least one session.
      let activeId = state.activeSessionId;
      let sessions = state.sessions;
      if (!activeId) {
        const fresh = makeLocalSession(DEFAULT_AGENT_ID);
        activeId = fresh.id;
        sessions = [fresh, ...sessions];
      }
      const nextMessages = [
        ...(sessions.find((s) => s.id === activeId)?.messages ?? []),
        newMsg,
      ];
      sessions = sessions.map((s) => {
        if (s.id !== activeId) return s;
        return {
          ...s,
          messages: nextMessages,
          updatedAt: ts,
          title:
            s.title === NEW_SESSION_TITLE && msg.role === 'user' && msg.content
              ? autoTitleFor(msg.content)
              : s.title,
        };
      });
      return { sessions, activeSessionId: activeId, messages: nextMessages };
    });

    // Persist non-empty user/system/assistant messages immediately. An
    // empty assistant message is a streaming placeholder — finalize() will
    // persist it when the stream ends. The auto-title rename is fire-and-
    // forget; even if it lands out of order the worst case is a stale title.
    if (isTauri && msg.content) {
      const activeId = get().activeSessionId;
      if (activeId) {
        void sessionChatAppend(activeId, msg.role, msg.content)
          .then(() => {
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === id ? { ...m, persisted: true } : m,
              ),
              sessions: state.sessions.map((s) =>
                s.id !== activeId
                  ? s
                  : {
                      ...s,
                      messages: s.messages.map((m) =>
                        m.id === id ? { ...m, persisted: true } : m,
                      ),
                    },
              ),
            }));
          })
          .catch((err) => console.error('[chat] append persist failed:', err));
      }
      // If the user message triggered an auto-title, push it to SQLite too.
      if (msg.role === 'user' && msg.content && activeId) {
        const session = get().sessions.find((s) => s.id === activeId);
        if (session && session.title !== NEW_SESSION_TITLE) {
          void sessionChatSessionUpdate(activeId, { title: session.title }).catch(
            (err) => console.error('[chat] auto-title failed:', err),
          );
        }
      }
    }
    return id;
  },

  appendChunk: (id, chunk) =>
    set((state) => {
      if (!state.activeSessionId) return state;
      const nextMessages = state.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m,
      );
      const sessions = state.sessions.map((s) =>
        s.id === state.activeSessionId
          ? { ...s, messages: nextMessages, updatedAt: Date.now() }
          : s,
      );
      return { sessions, messages: nextMessages };
    }),

  finalize: async (id) => {
    if (!isTauri) return;
    const { activeSessionId, messages } = get();
    if (!activeSessionId) return;
    const msg = messages.find((m) => m.id === id);
    if (!msg || msg.persisted || !msg.content) return;
    try {
      await sessionChatAppend(activeSessionId, msg.role, msg.content);
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === id ? { ...m, persisted: true } : m,
        ),
        sessions: state.sessions.map((s) =>
          s.id !== activeSessionId
            ? s
            : {
                ...s,
                messages: s.messages.map((m) =>
                  m.id === id ? { ...m, persisted: true } : m,
                ),
              },
        ),
      }));
    } catch (err) {
      console.error('[chat] finalize failed:', err);
    }
  },

  clear: async () => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    set((state) => {
      const sessions = state.sessions.map((s) =>
        s.id === activeSessionId
          ? { ...s, messages: [], title: NEW_SESSION_TITLE, updatedAt: Date.now() }
          : s,
      );
      // Drop the running token total alongside the cleared transcript.
      const { [activeSessionId]: _dropped, ...usage } = state.usage;
      return { sessions, messages: [], usage };
    });
    if (!isTauri) return;
    try {
      await sessionChatClear(activeSessionId);
      await sessionChatSessionUpdate(activeSessionId, { title: NEW_SESSION_TITLE });
    } catch (err) {
      console.error('[chat] clear failed:', err);
    }
  },

  setStreaming: (isStreaming) => set({ isStreaming }),

  recordUsage: (inputTokens, outputTokens) =>
    set((state) => {
      const id = state.activeSessionId;
      if (!id) return state;
      if (inputTokens <= 0 && outputTokens <= 0) return state;
      const prev = state.usage[id] ?? { inputTokens: 0, outputTokens: 0, turns: 0 };
      return {
        usage: {
          ...state.usage,
          [id]: {
            inputTokens: prev.inputTokens + inputTokens,
            outputTokens: prev.outputTokens + outputTokens,
            turns: prev.turns + 1,
          },
        },
      };
    }),

  // ─── Pending contexts ────────────────────────────────────────────────

  addPendingContext: (c) => {
    const id = c.id ?? crypto.randomUUID();
    set((state) => ({
      pendingContexts: [...state.pendingContexts, { ...c, id }],
    }));
    return id;
  },

  removePendingContext: (id) =>
    set((state) => ({
      pendingContexts: state.pendingContexts.filter((c) => c.id !== id),
    })),

  clearPendingContexts: () => set({ pendingContexts: [] }),

  // ─── Lifecycle ────────────────────────────────────────────────────────

  hydrate: async () => {
    if (get().hydrated) return;

    // Web-only mode: spin up an empty default session and call it done.
    if (!isTauri) {
      const fresh = makeLocalSession(DEFAULT_AGENT_ID);
      set({
        sessions: [fresh],
        activeSessionId: fresh.id,
        messages: [],
        hydrated: true,
      });
      return;
    }

    try {
      let conversations = await sessionChatSessionsList(null);

      // One-shot migration from the legacy localStorage-backed store.
      // We import everything found there, then drop the LS entry so a
      // subsequent launch goes straight through the SQLite path.
      if (conversations.length === 0) {
        const imported = await tryImportLegacy();
        if (imported > 0) {
          conversations = await sessionChatSessionsList(null);
        }
      }

      // Cold start with no history at all — create a default session so
      // the user always has somewhere to type.
      if (conversations.length === 0) {
        const row = await sessionChatSessionCreate(null, DEFAULT_AGENT_ID, null);
        conversations = [row];
      }

      // Load messages only for the most-recent (active) session. Older
      // sessions get their messages on first switch via setActiveSession.
      const sorted = [...conversations].sort(
        (a, b) => b.last_message_at - a.last_message_at,
      );
      const activeRow = sorted[0]!;
      const activeMessages = (await sessionChatMessagesLoad(activeRow.id)).map(
        persistedToMessage,
      );

      const sessions: ChatSession[] = sorted.map((row) => ({
        id: row.id,
        title: row.title ?? NEW_SESSION_TITLE,
        agentId: row.agent_id ?? DEFAULT_AGENT_ID,
        messages: row.id === activeRow.id ? activeMessages : [],
        createdAt: row.created_at,
        updatedAt: row.last_message_at,
      }));

      set({
        sessions,
        activeSessionId: activeRow.id,
        messages: activeMessages,
        hydrated: true,
      });
    } catch (err) {
      console.error('[chat] hydrate failed; running in-memory only:', err);
      const fresh = makeLocalSession(DEFAULT_AGENT_ID);
      set({
        sessions: [fresh],
        activeSessionId: fresh.id,
        messages: [],
        hydrated: true,
      });
    }
  },
}));

// ─── Legacy migration ──────────────────────────────────────────────────────

interface LegacySession {
  id: string;
  title: string;
  agentId: string;
  messages: { id: string; role: ChatRole; content: string; ts: number }[];
  createdAt: number;
  updatedAt: number;
}

/** If the previous (localStorage-backed) store has data, copy it into SQLite
 *  and remove the entry. Returns the number of sessions imported. */
async function tryImportLegacy(): Promise<number> {
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as {
      state?: { sessions?: LegacySession[]; activeSessionId?: string };
    };
    const legacy = parsed?.state?.sessions ?? [];
    if (legacy.length === 0) {
      localStorage.removeItem(LEGACY_LS_KEY);
      return 0;
    }
    // Migrate oldest first so the newest stays on top after the inserts.
    const sorted = [...legacy].sort((a, b) => a.createdAt - b.createdAt);
    for (const s of sorted) {
      const row = await sessionChatSessionCreate(
        null,
        s.agentId || DEFAULT_AGENT_ID,
        s.title === NEW_SESSION_TITLE ? null : s.title,
      );
      for (const m of s.messages) {
        if (!m.content) continue;
        try {
          await sessionChatAppend(row.id, m.role, m.content);
        } catch (err) {
          console.error('[chat] legacy message migrate skipped:', err);
        }
      }
    }
    localStorage.removeItem(LEGACY_LS_KEY);
    return sorted.length;
  } catch (err) {
    console.error('[chat] legacy migration failed:', err);
    return 0;
  }
}
