import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Sparkles, Trash2, Square } from 'lucide-react';
import { useChat } from '../state/chat';
import { useSettings, PROVIDER_LABELS } from '../state/settings';
import { agentRun, isTauri, llmStream, type LlmMessage } from '../lib/tauri';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';

export function ChatPanel() {
  const { messages, isStreaming, append, appendChunk, setStreaming, clear, hydrate, finalize } =
    useChat();
  const { activeProvider, providers, systemPrompt } = useSettings();
  const cfg = providers[activeProvider];

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<null | (() => Promise<void>)>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || isStreaming) return;

    // `/agent <goal>` — drop into the coding-agent runtime. Anthropic-only
    // (the tool API we're built on); plain chat still flows through any
    // configured provider via the path below.
    if (text.startsWith('/agent ') || text === '/agent') {
      await runAgent(text.replace(/^\/agent\s*/, '').trim());
      return;
    }

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
        content: `No API key set for ${PROVIDER_LABELS[activeProvider]}. Open settings (⌘,) to add one.`,
      });
      return;
    }

    setInput('');
    const userId = append({ role: 'user', content: text });
    void finalize(userId);
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
        // Persist whatever the assistant actually produced (including any
        // trailing error note) so reopens show what happened.
        void finalize(assistantId);
      },
    );
  }

  async function runAgent(goal: string) {
    if (!goal) {
      append({
        role: 'system',
        content: 'Usage: `/agent <goal>` — e.g. `/agent find the LLM provider files and explain what they do`.',
      });
      return;
    }
    if (!isTauri) {
      append({
        role: 'system',
        content: 'The agent runs in the Tauri shell only. Launch via `pnpm tauri:dev`.',
      });
      return;
    }
    const anthropic = providers.anthropic;
    if (!anthropic.apiKey) {
      append({
        role: 'system',
        content:
          'The V0 agent uses Anthropic. Open Settings (⌘,) and add an Anthropic API key, then retry.',
      });
      return;
    }

    setInput('');
    const userId = append({ role: 'user', content: `/agent ${goal}` });
    void finalize(userId);
    const assistantId = append({ role: 'assistant', content: '' });
    setStreaming(true);

    const root = useFiles.getState().root;
    const runId = crypto.randomUUID();

    await agentRun(
      {
        id: runId,
        goal,
        api_key: anthropic.apiKey,
        model: anthropic.model,
        workspace_root: root,
        workspace_id: null,
      },
      (ev) => {
        if (ev.kind === 'text') {
          appendChunk(assistantId, ev.text);
        } else if (ev.kind === 'tool_start') {
          appendChunk(assistantId, `\n\n→ \`${ev.name}\`\n`);
        } else if (ev.kind === 'tool_result') {
          const status = ev.ok ? '✓' : '✗';
          const snippet =
            ev.output.length > 280 ? ev.output.slice(0, 280) + '…' : ev.output;
          appendChunk(assistantId, `${status} ${snippet}\n\n`);
        } else if (ev.kind === 'done') {
          setStreaming(false);
          void finalize(assistantId);
        } else if (ev.kind === 'error') {
          appendChunk(assistantId, `\n\n⚠ ${ev.message}`);
          setStreaming(false);
          void finalize(assistantId);
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
    <div className="flex h-full flex-col">
      {/* Inspector header — sits flush with the toolbar above, no extra
          chrome. Sparkles icon in a soft-blue squircle. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-hairline px-3.5">
        <div className="flex items-center gap-2">
          <div className="flex h-[22px] w-[22px] items-center justify-center rounded-md bg-accent-soft text-accent ring-1 ring-accent/25">
            <Sparkles size={11} strokeWidth={2.4} />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-display text-[12.5px] font-semibold tracking-tight text-fg-base">
              Assistant
            </span>
            <span className="font-mono text-[10px] text-fg-subtle">
              {PROVIDER_LABELS[activeProvider]} · {cfg.model}
            </span>
          </div>
        </div>
        <button
          onClick={clear}
          className="rounded-md p-1.5 text-fg-subtle transition-all duration-150 ease-apple hover:bg-white/[0.08] hover:text-fg-base"
          title="Clear conversation"
          aria-label="Clear conversation"
        >
          <Trash2 size={12} strokeWidth={2.1} />
        </button>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="selectable flex-1 space-y-3 overflow-y-auto px-3.5 py-4"
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft ring-1 ring-accent/25">
              <Sparkles size={20} strokeWidth={1.8} className="text-accent" />
            </div>
            <p className="font-display text-[13px] font-medium tracking-tight text-fg-base">
              How can I help?
            </p>
            <p className="mt-1 font-display text-[11.5px] leading-relaxed text-fg-muted">
              Ask anything about your shell, code, or task.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          const delay = `${Math.min(i * 28, 220)}ms`;
          if (m.role === 'system') {
            return (
              <div
                key={m.id}
                className="animate-fade-in px-2 text-center font-display text-[11px] italic leading-relaxed tracking-tight text-fg-subtle"
                style={{ animationDelay: delay }}
              >
                {m.content}
              </div>
            );
          }
          if (m.role === 'user') {
            // Polished-platinum bubble — the user's voice as a brushed
            // metal chip on graphite. Dark text inside reads like a
            // pressed inscription on a milled nameplate.
            return (
              <div
                key={m.id}
                className="flex animate-fade-in justify-end"
                style={{ animationDelay: delay }}
              >
                <div className="surface-silver max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-[6px] px-3 py-1.5 font-display text-[13px] leading-relaxed">
                  {m.content}
                </div>
              </div>
            );
          }
          // Assistant — neutral grey bubble like the "they sent" iMessage.
          return (
            <div
              key={m.id}
              className="flex animate-fade-in justify-start"
              style={{ animationDelay: delay }}
            >
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-[6px] bg-bg-subtle/85 px-3 py-1.5 font-display text-[13px] leading-relaxed text-fg-base ring-1 ring-white/[0.04]">
                {m.content ? (
                  m.content
                ) : isStreaming ? (
                  <span className="inline-flex gap-1 text-fg-muted">
                    <span className="h-1.5 w-1.5 animate-shimmer-cursor rounded-full bg-fg-muted/70" />
                    <span
                      className="h-1.5 w-1.5 animate-shimmer-cursor rounded-full bg-fg-muted/70"
                      style={{ animationDelay: '0.15s' }}
                    />
                    <span
                      className="h-1.5 w-1.5 animate-shimmer-cursor rounded-full bg-fg-muted/70"
                      style={{ animationDelay: '0.3s' }}
                    />
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Composer — Messages.app style: rounded pill, send button as a
          blue circle that becomes visible only when there's content. */}
      <div className="shrink-0 px-3 pb-3 pt-1">
        <div
          className={cn(
            'group flex items-end gap-2 rounded-[20px] border border-border-subtle bg-bg-base/55 px-3 py-2 backdrop-blur-md',
            'transition-all duration-150 ease-apple',
            'focus-within:border-accent/45 focus-within:bg-bg-base/75 focus-within:shadow-focus',
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
                : 'iMessage'
            }
            rows={1}
            disabled={isStreaming}
            className="selectable max-h-32 min-h-[22px] flex-1 resize-none bg-transparent font-display text-[13px] leading-relaxed text-fg-base placeholder:text-fg-subtle focus:outline-none disabled:opacity-60"
          />
          {isStreaming ? (
            <button
              onClick={() => void stop()}
              className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-status-err/15 text-status-err transition-all duration-150 hover:bg-status-err hover:text-white"
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
                'flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full transition-all duration-150 ease-apple',
                'enabled:surface-silver enabled:shadow-glow-sm',
                'enabled:active:scale-[0.94]',
                'disabled:bg-white/[0.08] disabled:text-fg-subtle',
              )}
              aria-label="Send"
            >
              <ArrowUp size={13} strokeWidth={2.6} />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between px-1.5 font-display text-[10px] text-fg-subtle">
          <span className="tracking-tight">
            <kbd className="font-mono">return</kbd> to send · <kbd className="font-mono">⇧↵</kbd> for newline
          </span>
          {isStreaming && (
            <span className="flex items-center gap-1.5 text-accent">
              <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent shadow-glow-sm" />
              streaming
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
