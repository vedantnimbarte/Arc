import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Plus,
  ShieldCheck,
  ShieldX,
  Wrench,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useWingman, type ChatItem } from '../../state/wingman';

/**
 * Agent chat, backed by a `wingman serve` session.
 *
 * Renders the typed event stream rather than terminal output: assistant text,
 * foldable reasoning, one row per tool call with its result, and the
 * verification gate's verdict. Token usage sits in the footer because
 * Wingman's whole pitch is that you can see what a turn costs.
 *
 * Disconnected is the common case — ARC does not require Wingman — so this
 * renders a quiet hint, never an error.
 */
export function WingmanPanel() {
  const status = useWingman((s) => s.status);
  const projects = useWingman((s) => s.projects);
  const activeProject = useWingman((s) => s.activeProject);
  const setActiveProject = useWingman((s) => s.setActiveProject);
  const chat = useWingman((s) => s.chat);
  const streaming = useWingman((s) => s.streaming);
  const usage = useWingman((s) => s.usage);
  const send = useWingman((s) => s.send);
  const newChat = useWingman((s) => s.newChat);

  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the tail while a turn streams. Only when already near the bottom, so
  // scrolling up to read an earlier tool result isn't yanked away mid-turn.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [chat]);

  if (status !== 'connected') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Bot size={18} strokeWidth={1.6} className="text-fg-subtle" />
        <p className="font-display text-xs text-fg-muted">Wingman isn&rsquo;t connected</p>
        <p className="font-display text-2xs leading-relaxed text-fg-subtle">
          Run <code className="font-mono">wingman serve</code>, then set the daemon address in
          Settings → Wingman.
        </p>
      </div>
    );
  }

  const submit = () => {
    const t = text.trim();
    if (!t || streaming) return;
    setText('');
    void send(t);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-hairline px-2 py-1.5">
        <select
          value={activeProject ?? ''}
          onChange={(e) => setActiveProject(e.target.value)}
          aria-label="Wingman project"
          className="min-w-0 flex-1 rounded border border-edge-1 bg-surface-1 px-1.5 py-0.5 font-mono text-2xs text-fg-base focus:outline-none"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
              {p.branch ? ` · ${p.branch}` : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={newChat}
          title="New conversation"
          aria-label="New conversation"
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <Plus size={12} strokeWidth={2.2} />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {chat.length === 0 ? (
          <p className="px-1 py-6 text-center font-display text-2xs text-fg-subtle">
            Ask about this repo. Wingman resolves symbols through the language server rather
            than grepping.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {chat.map((item, i) => (
              <ChatRow key={i} item={item} />
            ))}
            {streaming && (
              <div className="px-1 font-mono text-2xs text-fg-subtle">
                <span className="animate-pulse-soft">working…</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border-hairline px-2 py-2">
        <div className="flex items-end gap-1 rounded-md border border-edge-1 bg-surface-1 px-1.5 py-1 focus-within:border-accent/40">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            spellCheck={false}
            disabled={streaming}
            placeholder={streaming ? 'Wingman is working…' : 'Ask Wingman…'}
            aria-label="Message Wingman"
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 font-display text-xs text-fg-base placeholder:text-fg-subtle focus:outline-none disabled:opacity-60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={streaming || !text.trim()}
            aria-label="Send to Wingman"
            title="Send (Enter)"
            className={cn(
              'mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all active:scale-95',
              text.trim() && !streaming
                ? 'bg-accent-soft text-fg-base ring-1 ring-accent/45'
                : 'bg-surface-1 text-fg-subtle',
            )}
          >
            <ArrowUp size={12} strokeWidth={2.3} />
          </button>
        </div>
        {usage && (
          <div className="mt-1 flex justify-end gap-2 px-1 font-mono text-2xs tabular-nums text-fg-subtle">
            <span title="Input tokens">in {usage.input.toLocaleString()}</span>
            <span title="Output tokens">out {usage.output.toLocaleString()}</span>
            {usage.cacheRead > 0 && (
              <span title="Tokens served from cache">cached {usage.cacheRead.toLocaleString()}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChatRow({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="rounded-md bg-surface-2 px-2 py-1.5 font-display text-xs text-fg-base">
          {item.text}
        </div>
      );

    case 'assistant':
      return (
        <div className="whitespace-pre-wrap px-1 font-display text-xs leading-relaxed text-fg-base">
          {item.text}
        </div>
      );

    case 'thinking':
      return <Foldable label="reasoning" body={item.text} />;

    case 'tool':
      return (
        <Foldable
          label={item.name}
          icon={<Wrench size={10} strokeWidth={2} />}
          tone={item.isError ? 'error' : 'normal'}
          body={[
            JSON.stringify(item.input, null, 2),
            item.output ? `\n─────\n${item.output}` : '',
          ].join('')}
        />
      );

    case 'verification':
      return (
        <div
          className={cn(
            'flex items-start gap-1.5 rounded-md px-2 py-1.5 font-mono text-2xs',
            item.passed ? 'text-status-ok' : 'text-status-err',
          )}
        >
          {item.passed ? (
            <ShieldCheck size={11} strokeWidth={2} className="mt-px shrink-0" />
          ) : (
            <ShieldX size={11} strokeWidth={2} className="mt-px shrink-0" />
          )}
          <span className="min-w-0 break-words">{item.summary || (item.passed ? 'verified' : 'verification failed')}</span>
        </div>
      );

    case 'error':
      return (
        <div className="flex items-start gap-1.5 rounded-md bg-status-err/10 px-2 py-1.5 font-mono text-2xs text-status-err">
          <CircleAlert size={11} strokeWidth={2} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">{item.message}</span>
        </div>
      );
  }
}

/** Collapsed-by-default disclosure for the noisy rows — reasoning and tool
 *  payloads. Both are useful on demand and overwhelming by default. */
function Foldable({
  label,
  body,
  icon,
  tone = 'normal',
}: {
  label: string;
  body: string;
  icon?: React.ReactNode;
  tone?: 'normal' | 'error';
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-1 rounded px-1 py-0.5 font-mono text-2xs transition-colors hover:bg-surface-1',
          tone === 'error' ? 'text-status-err' : 'text-fg-subtle',
        )}
      >
        {open ? (
          <ChevronDown size={10} strokeWidth={2.2} />
        ) : (
          <ChevronRight size={10} strokeWidth={2.2} />
        )}
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded border border-edge-1 bg-scrim-1 px-2 py-1.5 font-mono text-2xs leading-relaxed text-fg-muted">
          {body}
        </pre>
      )}
    </div>
  );
}
