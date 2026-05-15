import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Trash2, Square } from 'lucide-react';
import { useChat } from '../state/chat';
import { useSettings, PROVIDER_LABELS } from '../state/settings';
import { isTauri, llmStream, type LlmMessage } from '../lib/tauri';
import { cn } from '../lib/cn';

export function ChatPanel() {
  const { messages, isStreaming, append, appendChunk, setStreaming, clear } = useChat();
  const { activeProvider, providers, systemPrompt } = useSettings();
  const cfg = providers[activeProvider];

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<null | (() => Promise<void>)>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || isStreaming) return;

    // Outside Tauri the LLM IPC isn't available — fall back to the local stub
    // so the UI is still testable in the browser.
    if (!isTauri) {
      setInput('');
      append({ role: 'user', content: text });
      const id = append({ role: 'assistant', content: '' });
      setStreaming(true);
      const reply = `(stub · run via pnpm tauri:dev for real ${PROVIDER_LABELS[activeProvider]} calls)`;
      for (const word of reply.split(' ')) {
        await new Promise((r) => setTimeout(r, 30));
        appendChunk(id, word + ' ');
      }
      setStreaming(false);
      return;
    }

    if ((activeProvider === 'openai' || activeProvider === 'anthropic') && !cfg.apiKey) {
      append({
        role: 'system',
        content: `No API key set for ${PROVIDER_LABELS[activeProvider]}. Open settings (⚙) to add one.`,
      });
      return;
    }

    setInput('');
    append({ role: 'user', content: text });
    const assistantId = append({ role: 'assistant', content: '' });
    setStreaming(true);

    const wire: LlmMessage[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    wire.push({ role: 'user', content: text });

    const reqId = crypto.randomUUID();
    cancelRef.current = await llmStream(
      {
        id: reqId,
        provider: activeProvider,
        model: cfg.model,
        messages: wire,
        system: systemPrompt,
        api_key: cfg.apiKey || undefined,
        base_url: cfg.baseUrl || undefined,
      },
      (chunk) => {
        if (chunk.text) appendChunk(assistantId, chunk.text);
      },
      (ev) => {
        setStreaming(false);
        cancelRef.current = null;
        if (ev.error) {
          appendChunk(assistantId, `\n\n⚠ ${ev.error}`);
        }
      },
    );
  }

  async function stop() {
    if (cancelRef.current) {
      await cancelRef.current();
      cancelRef.current = null;
      setStreaming(false);
    }
  }

  return (
    <div className="glass flex h-full flex-col">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle px-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-accent-soft text-accent ring-1 ring-accent/20">
            <Sparkles size={11} strokeWidth={2.4} />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="font-display text-[13px] font-semibold tracking-tight text-fg-base">
              Chat
            </span>
            <span className="font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
              {PROVIDER_LABELS[activeProvider]} · {cfg.model}
            </span>
          </div>
        </div>
        <button
          onClick={clear}
          className="rounded-md p-1.5 text-fg-subtle transition-all duration-200 hover:bg-bg-hover/60 hover:text-fg-muted"
          title="Clear chat"
          aria-label="Clear chat"
        >
          <Trash2 size={12} strokeWidth={2.2} />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="selectable flex-1 space-y-3.5 overflow-y-auto px-4 py-5"
      >
        {messages.map((m, i) => {
          const delay = `${Math.min(i * 28, 220)}ms`;
          if (m.role === 'system') {
            return (
              <div
                key={m.id}
                className="animate-fade-in px-2 text-center font-display text-[11px] italic leading-relaxed tracking-wide text-fg-subtle"
                style={{ animationDelay: delay }}
              >
                {m.content}
              </div>
            );
          }
          if (m.role === 'user') {
            return (
              <div
                key={m.id}
                className="flex animate-fade-in justify-end"
                style={{ animationDelay: delay }}
              >
                <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-accent-muted/85 to-accent/70 px-3.5 py-2 font-display text-[13px] leading-relaxed text-bg-base shadow-glow-sm">
                  {m.content}
                </div>
              </div>
            );
          }
          return (
            <div
              key={m.id}
              className="flex animate-fade-in justify-start"
              style={{ animationDelay: delay }}
            >
              <div className="max-w-[88%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-border-subtle bg-bg-subtle/55 px-3.5 py-2 font-display text-[13px] leading-relaxed text-fg-base">
                {m.content ? (
                  m.content
                ) : isStreaming ? (
                  <span className="inline-flex gap-0.5 text-fg-muted">
                    <span className="animate-shimmer-cursor">·</span>
                    <span
                      className="animate-shimmer-cursor"
                      style={{ animationDelay: '0.15s' }}
                    >
                      ·
                    </span>
                    <span
                      className="animate-shimmer-cursor"
                      style={{ animationDelay: '0.3s' }}
                    >
                      ·
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Input */}
      <div className="shrink-0 px-3 pb-3">
        <div
          className={cn(
            'group flex items-end gap-2 rounded-2xl border border-border-subtle bg-bg-base/55 px-3 py-2',
            'transition-all duration-200 ease-out-soft',
            'focus-within:border-accent/40 focus-within:bg-bg-base/75 focus-within:shadow-glow-sm',
          )}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              isStreaming
                ? `streaming from ${PROVIDER_LABELS[activeProvider]}…`
                : 'ask anything'
            }
            rows={1}
            disabled={isStreaming}
            className="selectable max-h-32 min-h-[24px] flex-1 resize-none bg-transparent font-display text-[13px] leading-relaxed text-fg-base placeholder:text-fg-subtle focus:outline-none disabled:opacity-60"
          />
          {isStreaming ? (
            <button
              onClick={() => void stop()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-status-err/15 text-status-err transition-all duration-200 hover:bg-status-err hover:text-bg-base"
              aria-label="Stop"
              title="Stop streaming"
            >
              <Square size={10} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all duration-200 ease-out-soft',
                'enabled:bg-accent-soft enabled:text-accent',
                'enabled:hover:bg-accent enabled:hover:text-bg-base enabled:hover:shadow-glow',
                'disabled:text-fg-subtle disabled:opacity-50',
              )}
              aria-label="Send"
            >
              <Send size={12} strokeWidth={2.4} />
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between px-1 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
          <span>⏎ send · ⇧⏎ newline</span>
          {isStreaming && (
            <span className="flex items-center gap-1.5 text-accent/80">
              <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent shadow-glow-sm" />
              streaming
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
