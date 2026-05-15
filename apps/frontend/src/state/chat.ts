import { create } from 'zustand';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number;
}

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  append: (msg: Omit<ChatMessage, 'id' | 'ts'>) => string;
  appendChunk: (id: string, chunk: string) => void;
  setStreaming: (s: boolean) => void;
  clear: () => void;
}

export const useChat = create<ChatState>((set) => ({
  messages: [
    {
      id: 'welcome',
      role: 'system',
      content:
        'ARC chat is wired to a stub provider. Hook up OpenAI / Anthropic / Ollama in packages/ai-runtime.',
      ts: Date.now(),
    },
  ],
  isStreaming: false,
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
  setStreaming: (isStreaming) => set({ isStreaming }),
  clear: () => set({ messages: [] }),
}));
