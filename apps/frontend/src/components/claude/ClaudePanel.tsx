import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileDiff,
  Plus,
  ShieldAlert,
  ShieldQuestion,
  Sparkles,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClaudeCode, type ClaudeChatItem } from '../../state/claudeCode';
import { useFiles } from '../../state/files';
import { useSettings } from '../../state/settings';

/**
 * Claude Code chat, backed by the user's own `claude` CLI.
 *
 * Renders the CLI's typed event stream rather than terminal output: assistant
 * text as it is written, foldable reasoning, one row per tool call with its
 * result. That is the whole reason this exists next to the AI CLI launcher —
 * the launcher gives you Claude's TUI in a tab, this gives you its work as
 * reviewable UI.
 *
 * "Not installed" is a normal state, not an error: ARC does not require Claude
 * Code, so it renders a quiet hint.
 */
export function ClaudePanel() {
  const status = useClaudeCode((s) => s.status);
  const chat = useClaudeCode((s) => s.chat);
  const streaming = useClaudeCode((s) => s.streaming);
  const usage = useClaudeCode((s) => s.usage);
  const costUsd = useClaudeCode((s) => s.costUsd);
  const denials = useClaudeCode((s) => s.denials);
  const editedFiles = useClaudeCode((s) => s.editedFiles);
  const pending = useClaudeCode((s) => s.pending);
  const send = useClaudeCode((s) => s.send);
  const cancel = useClaudeCode((s) => s.cancel);
  const newChat = useClaudeCode((s) => s.newChat);
  const detect = useClaudeCode((s) => s.detect);

  const root = useFiles((s) => s.root);
  const mode = useSettings((s) => s.claudePermissionMode);

  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Probe once on mount. The CLI can be installed while ARC is running, and a
  // PATH lookup is cheap enough not to need caching across panel opens.
  useEffect(() => {
    if (status === 'checking') void detect();
  }, [status, detect]);

  // Follow the tail while a turn streams — but only when already near the
  // bottom, so scrolling up to read an earlier tool result isn't yanked away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [chat, pending]);

  if (status === 'checking') {
    return (
      <p className="px-3 py-3 font-mono text-2xs text-fg-subtle">looking for the CLI…</p>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <Sparkles size={18} strokeWidth={1.6} className="text-fg-subtle" />
        <p className="font-display text-xs text-fg-muted">Claude Code isn&rsquo;t installed</p>
        <p className="font-display text-2xs leading-relaxed text-fg-subtle">
          Install the <code className="font-mono">claude</code> CLI and sign in, then reopen
          this panel. ARC uses your existing login — there is nothing to configure.
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
        <span
          className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle"
          title={root ? `Claude runs in ${root}` : 'No folder open'}
        >
          {root ? basename(root) : 'no folder open'}
        </span>
        {/* The permission mode decides whether Claude can write to the repo
            without asking, so it stays on screen rather than only in Settings. */}
        <span
          className={cn(
            'shrink-0 rounded px-1 py-0.5 font-mono text-2xs',
            mode === 'bypassPermissions' || mode === 'dontAsk'
              ? 'bg-status-warn/15 text-status-warn'
              : 'text-fg-subtle',
          )}
          title={`Permission mode: ${mode}. Change it in Settings → Claude Code.`}
        >
          {mode}
        </span>
        <button
          type="button"
          onClick={newChat}
          disabled={streaming}
          title="New conversation"
          aria-label="New conversation"
          className="shrink-0 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
        >
          <Plus size={12} strokeWidth={2.2} />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {chat.length === 0 && !pending ? (
          <p className="px-1 py-6 text-center font-display text-2xs text-fg-subtle">
            Ask Claude about this repo. It reads and edits files in the open folder; every
            edit shows up below for review.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {chat.map((item, i) => (
              <ChatRow key={i} item={item} />
            ))}
            {streaming && !pending && (
              <div className="px-1 font-mono text-2xs text-fg-subtle">
                <span className="animate-pulse-soft">working…</span>
              </div>
            )}
          </div>
        )}
        {pending && <PermissionPrompt />}
      </div>

      {/* A denial is silent otherwise: the turn just ends without the work
          done, which reads as Claude declining rather than ARC's mode. */}
      {denials.length > 0 && (
        <div className="flex shrink-0 items-start gap-1.5 border-t border-border-hairline bg-status-warn/10 px-2 py-1.5 font-mono text-2xs text-status-warn">
          <ShieldAlert size={11} strokeWidth={2} className="mt-px shrink-0" />
          <span className="min-w-0 break-words">
            blocked by <span className="font-medium">{mode}</span>: {denials.join(', ')}
          </span>
        </div>
      )}

      <EditedFiles />

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
            placeholder={
              pending
                ? 'Waiting on your approval above…'
                : streaming
                  ? 'Claude is working…'
                  : 'Ask Claude Code…'
            }
            aria-label="Message Claude Code"
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 font-display text-xs text-fg-base placeholder:text-fg-subtle focus:outline-none disabled:opacity-60"
          />
          {streaming ? (
            <button
              type="button"
              onClick={() => void cancel()}
              aria-label="Stop this turn"
              title="Stop"
              className="mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted transition-all hover:text-status-err active:scale-95"
            >
              <Square size={10} strokeWidth={2.6} />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim()}
              aria-label="Send to Claude Code"
              title="Send (Enter)"
              className={cn(
                'mb-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-all active:scale-95',
                text.trim()
                  ? 'bg-accent-soft text-fg-base ring-1 ring-accent/45'
                  : 'bg-surface-1 text-fg-subtle',
              )}
            >
              <ArrowUp size={12} strokeWidth={2.3} />
            </button>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 px-1 font-mono text-2xs tabular-nums text-fg-subtle">
          {/* What this conversation has cost, straight from the CLI's own
              per-turn accounting. */}
          <span title="Total spend on this conversation">
            {costUsd > 0 ? `$${costUsd.toFixed(4)}` : ''}
          </span>
          {usage && (
            <span className="flex gap-2">
              <span title="Input tokens">in {usage.input.toLocaleString()}</span>
              <span title="Output tokens">out {usage.output.toLocaleString()}</span>
              {usage.cacheRead > 0 && (
                <span title="Tokens served from cache">
                  cached {usage.cacheRead.toLocaleString()}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The approve/deny prompt for one tool call.
 *
 * This is the half of the permission story that a preset mode can't do: the
 * CLI blocks on a `can_use_tool` control request, and until it gets an answer
 * nothing else happens in the turn. So the prompt is deliberately loud, sits
 * where the next message would appear, and shows the actual command or path
 * rather than just the tool name — "allow Bash?" is not a decision anyone can
 * make, and `rm -rf build` is.
 *
 * There is no third "always allow" option on purpose: persisting a rule is the
 * CLI's own settings file to own, and a per-session allowlist ARC invented
 * would silently diverge from what `claude` does in a terminal.
 */
function PermissionPrompt() {
  const pending = useClaudeCode((s) => s.pending);
  const respond = useClaudeCode((s) => s.respond);
  if (!pending) return null;

  return (
    <div
      role="group"
      aria-label="Permission request"
      className="mt-2 rounded-md border border-status-warn/40 bg-status-warn/10 px-2 py-2"
    >
      <div className="flex items-start gap-1.5">
        <ShieldQuestion size={12} strokeWidth={2} className="mt-px shrink-0 text-status-warn" />
        <div className="min-w-0 flex-1">
          <p className="font-display text-xs text-fg-base">
            Allow <span className="font-medium">{pending.title || pending.tool}</span>?
          </p>
          {pending.description && (
            <p className="mt-0.5 font-display text-2xs leading-relaxed text-fg-muted">
              {pending.description}
            </p>
          )}
          {pending.summary && (
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-edge-1 bg-scrim-1 px-2 py-1 font-mono text-2xs leading-relaxed text-fg-muted">
              {pending.summary}
            </pre>
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          onClick={() => void respond(false)}
          className="flex items-center gap-1 rounded border border-edge-1 px-2 py-1 font-display text-2xs text-fg-muted transition-colors hover:border-status-err/50 hover:text-status-err"
        >
          <X size={10} strokeWidth={2.4} />
          Deny
        </button>
        <button
          type="button"
          // Autofocused so Enter answers the prompt: the composer is disabled
          // while blocked, so this is the only thing the key could mean.
          autoFocus
          onClick={() => void respond(true)}
          className="flex items-center gap-1 rounded bg-accent-soft px-2 py-1 font-display text-2xs text-fg-base ring-1 ring-accent/45 transition-transform active:scale-95"
        >
          <Check size={10} strokeWidth={2.4} />
          Allow
        </button>
      </div>
    </div>
  );
}

/**
 * Review strip for the files Claude wrote.
 *
 * Claude Code edits the working tree in place, so there is no worktree to
 * diff and nothing to snapshot — the change is already sitting in git. All
 * this needs to do is remember which paths the turn touched and hand each one
 * to ARC's own diff viewer, which then shows it against HEAD exactly as Source
 * Control would.
 */
function EditedFiles() {
  const files = useClaudeCode((s) => s.editedFiles);
  const open = useClaudeCode((s) => s.openEditedFile);
  const [collapsed, setCollapsed] = useState(false);

  if (files.length === 0) return null;

  return (
    <div className="shrink-0 border-t border-border-hairline">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1 px-2 py-1 font-mono text-2xs text-fg-subtle transition-colors hover:bg-surface-1 hover:text-fg-base"
      >
        {collapsed ? (
          <ChevronRight size={10} strokeWidth={2.2} />
        ) : (
          <ChevronDown size={10} strokeWidth={2.2} />
        )}
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} edited
        </span>
      </button>
      {!collapsed && (
        <ul className="max-h-40 overflow-y-auto pb-1">
          {files.map((f) => (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => open(f.path)}
                title={`Open diff for ${f.path}`}
                className="flex w-full items-center gap-1.5 px-3 py-0.5 text-left transition-colors hover:bg-surface-1"
              >
                <FileDiff size={10} strokeWidth={2} className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">
                  {basename(f.path)}
                </span>
                <span className="shrink-0 font-mono text-2xs text-fg-subtle">
                  {f.edits > 1 ? `${f.tool}×${f.edits}` : f.tool}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Last path segment, on either separator — paths come from the CLI, which
 *  reports them in the host OS's form. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function ChatRow({ item }: { item: ClaudeChatItem }) {
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

    case 'decision':
      return (
        <div
          className={cn(
            'flex items-start gap-1.5 px-1 font-mono text-2xs',
            item.allowed ? 'text-fg-subtle' : 'text-status-err',
          )}
          title={item.summary}
        >
          {item.allowed ? (
            <Check size={11} strokeWidth={2} className="mt-px shrink-0" />
          ) : (
            <X size={11} strokeWidth={2} className="mt-px shrink-0" />
          )}
          <span className="min-w-0 truncate">
            {item.allowed ? 'allowed' : 'denied'} {item.tool}
            {item.summary ? ` · ${item.summary}` : ''}
          </span>
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
