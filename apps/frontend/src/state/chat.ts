import { create } from 'zustand';
import {
  isTauri,
  sessionChatAppend,
  sessionChatClear,
  sessionChatLoad,
  type ChatRole,
} from '../lib/tauri';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  ts: number;
  /** True once this message has been persisted to SQLite. Streaming
   *  assistant messages flip to true only after the stream completes
   *  and `finalize(id)` is called. */
  persisted?: boolean;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  /** SQLite conversation id; null until hydrate() runs (or web-only mode). */
  conversationId: string | null;
  hydrated: boolean;
  append: (msg: Omit<ChatMessage, 'id' | 'ts' | 'persisted'>) => string;
  appendChunk: (id: string, chunk: string) => void;
  /** Write the current content of `id` to SQLite. Idempotent: a second
   *  call on the same id is a no-op. Call once after a user message is
   *  queued, and once after the matching assistant stream finishes. */
  finalize: (id: string) => Promise<void>;
  setStreaming: (s: boolean) => void;
  /** Clear in-memory state and wipe the SQLite conversation if hydrated. */
  clear: () => Promise<void>;
  /** Load conversation + history from SQLite. Idempotent. */
  hydrate: () => Promise<void>;
}

const WELCOME: ChatMessage = {
  id: 'welcome',
  role: 'system',
  content:
    'Pick a provider in Settings (⌘,). OpenAI and Anthropic need an API key; Ollama runs locally.',
  ts: Date.now(),
};

export const useChat = create<ChatState>((set, get) => ({
  messages: [WELCOME],
  isStreaming: false,
  conversationId: null,
  hydrated: false,
  append: (msg) => {
    const id = crypto.randomUUID();
    set((s) => ({
      messages: [...s.messages, { ...msg, id, ts: Date.now() }],
    }));
    return id;
  },
  appendChunk: (id, chunk) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m,
      ),
    })),
  finalize: async (id) => {
    const { conversationId, messages } = get();
    if (!conversationId || !isTauri) return;
    const msg = messages.find((m) => m.id === id);
    if (!msg || msg.persisted) return;
    // The welcome system row never gets written.
    if (id === WELCOME.id) return;
    try {
      await sessionChatAppend(conversationId, msg.role, msg.content);
      set((s) => ({
        messages: s.messages.map((m) => (m.id === id ? { ...m, persisted: true } : m)),
      }));
    } catch (err) {
      console.error('[chat] finalize failed:', err);
    }
  },
  setStreaming: (isStreaming) => set({ isStreaming }),
  clear: async () => {
    const { conversationId } = get();
    if (conversationId && isTauri) {
      try {
        await sessionChatClear(conversationId);
      } catch (err) {
        console.error('[chat] clear failed:', err);
      }
    }
    set({ messages: [{ ...WELCOME, ts: Date.now() }] });
  },
  hydrate: async () => {
    if (get().hydrated) return;

    if (!isTauri) {
      set({ hydrated: true });
      return;
    }

    try {
      // Workspace-scoped conversations are a Phase 2b concern; for V0 every
      // window shares one orphan conversation.
      const loaded = await sessionChatLoad(null);
      const messages: ChatMessage[] =
        loaded.messages.length === 0
          ? [WELCOME]
          : loaded.messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              ts: m.created_at,
              persisted: true,
            }));
      set({
        messages,
        conversationId: loaded.conversation.id,
        hydrated: true,
      });
    } catch (err) {
      console.error('[chat] hydrate failed; running in-memory only:', err);
      set({ hydrated: true });
    }
  },
}));
