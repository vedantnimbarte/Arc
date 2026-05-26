import { useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Layers,
  RotateCw,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { useBlocks, type CommandBlock } from '../state/blocks';
import { useWorkspace } from '../state/workspace';
import { useChat } from '../state/chat';
import { ptyWrite } from '../lib/tauri';
import { cn } from '../lib/cn';

interface Props {
  sessionKey: string;
}

/**
 * Per-terminal command-block drawer. Floats over the bottom of the active
 * pane; the xterm canvas keeps owning its own scrollback. Blocks come from
 * OSC 133 capture in `Terminal.tsx` — shells without shell integration won't
 * produce any (the drawer just shows a hint in that case).
 */
export function BlocksDrawer({ sessionKey }: Props) {
  const blocks = useBlocks((s) => s.bySession[sessionKey]);
  const open = useBlocks((s) => s.drawerOpen[sessionKey] ?? false);
  const toggleDrawer = useBlocks((s) => s.toggleDrawer);

  // Reverse for display — newest at the top — without mutating the store
  // (the store stays oldest-first so consumers can replay in real time).
  const ordered = blocks ? [...blocks].slice().reverse() : [];
  const count = ordered.length;
  const running = ordered.filter((b) => b.finishedAt === null).length;
  const failed = ordered.filter((b) => b.exitCode !== null && b.exitCode !== 0).length;

  return (
    <>
      {/* Toggle chip — top-right of the pane. Renders even when there are
          no blocks yet so the UX stays consistent across shells. */}
      <button
        onClick={() => toggleDrawer(sessionKey)}
        title={open ? 'Hide blocks' : `Show command blocks (${count})`}
        className={cn(
          'absolute right-3 top-2 z-10 flex items-center gap-1.5 rounded-md px-2 py-1 font-display text-[10.5px] font-medium tracking-tight backdrop-blur-md transition-all',
          open
            ? 'bg-accent-soft text-fg-base ring-1 ring-accent/45'
            : 'bg-bg-base/70 text-fg-muted ring-1 ring-border-subtle hover:text-fg-base',
        )}
      >
        <Layers size={11} strokeWidth={2.1} />
        <span className="tabular-nums">{count}</span>
        {running > 0 && (
          <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-glow-sm" title={`${running} running`} />
        )}
        {failed > 0 && (
          <span className="font-mono text-[10px] text-red-400" title={`${failed} failed`}>
            {failed}!
          </span>
        )}
      </button>

      {open && (
        <div className="absolute inset-x-2 bottom-2 z-10 max-h-[55%] overflow-hidden rounded-lg bg-bg-base/85 shadow-sheet ring-1 ring-border-subtle backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-border-hairline px-3 py-1.5">
            <div className="flex items-center gap-1.5 font-display text-[11px] font-semibold tracking-tight text-fg-base">
              <Layers size={11} strokeWidth={2.1} className="text-fg-muted" />
              Command blocks
              <span className="font-mono text-[10px] font-normal text-fg-subtle">
                · {count} total
              </span>
            </div>
            <button
              onClick={() => toggleDrawer(sessionKey)}
              className="rounded p-1 text-fg-subtle transition-colors hover:bg-white/[0.05] hover:text-fg-base"
              aria-label="Close blocks drawer"
            >
              <X size={11} strokeWidth={2.2} />
            </button>
          </div>

          <div className="max-h-[calc(55vh-32px)] overflow-y-auto py-1">
            {count === 0 && (
              <div className="px-3 py-6 text-center font-display text-[11px] italic text-fg-subtle">
                no blocks captured yet — your shell may not emit OSC 133.
                <br />
                bash/zsh/fish/pwsh with shell-integration installed will work.
              </div>
            )}
            {ordered.map((b) => (
              <BlockRow key={b.id} block={b} sessionKey={sessionKey} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function BlockRow({ block, sessionKey }: { block: CommandBlock; sessionKey: string }) {
  const toggleCollapsed = useBlocks((s) => s.toggleCollapsed);
  const [copied, setCopied] = useState(false);

  const running = block.finishedAt === null;
  const failed = !running && block.exitCode !== null && block.exitCode !== 0;

  const duration = block.finishedAt !== null
    ? formatDuration(block.finishedAt - block.startedAt)
    : `${formatDuration(Date.now() - block.startedAt)}…`;

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(block.outputExcerpt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — silently swallow */
    }
  };

  const rerun = async () => {
    const tab = useWorkspace.getState().tabs.find((t) => t.id === sessionKey);
    if (!tab?.ptyId || !block.command) return;
    try {
      // Write the command followed by Enter. The user will see it appear
      // at the active prompt and run.
      await ptyWrite(tab.ptyId, `${block.command}\r`);
    } catch {
      /* terminal might be closing */
    }
  };

  const askArc = () => {
    // Stage the block as chat context — the Ask ARC flow consumes
    // pendingContext snapshots from `useSelection` already.
    useChat.getState().addPendingContext({
      source: 'terminal',
      label: block.command.length > 0 ? block.command : `block ${block.id}`,
      text:
        `Command: ${block.command || '(unknown)'}\n` +
        `Exit code: ${block.exitCode ?? 'n/a'}\n` +
        `Duration: ${duration}\n\n` +
        `--- output (last ${block.outputExcerpt.length} bytes) ---\n` +
        block.outputExcerpt,
    });
    // Trigger the chat panel via the global event — App.tsx already
    // listens for ⌘⇧A's `ask-arc-ai` path. Mirror that behavior here:
    // we don't have a selection, but adding pendingContext + opening
    // chat is enough.
    window.dispatchEvent(new CustomEvent('arc:open-chat'));
  };

  return (
    <div className="border-b border-border-hairline/60 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <StatusDot running={running} failed={failed} />
        <button
          onClick={() => toggleCollapsed(sessionKey, block.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {block.collapsed ? (
            <ChevronDown size={10} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
          ) : (
            <ChevronUp size={10} strokeWidth={2.1} className="shrink-0 text-fg-subtle" />
          )}
          <span className="truncate font-mono text-[11.5px] text-fg-base/90">
            {block.command || <span className="italic text-fg-subtle">(no command captured)</span>}
          </span>
        </button>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-subtle">
          {duration}
        </span>
        {block.exitCode !== null && block.exitCode !== 0 && (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-red-400">
            {block.exitCode}
          </span>
        )}
        <div className="flex shrink-0 gap-0.5">
          <IconButton
            label="Copy output"
            onClick={copyOutput}
            disabled={block.outputExcerpt.length === 0}
            icon={copied ? Check : Copy}
          />
          <IconButton
            label="Rerun"
            onClick={rerun}
            disabled={!block.command}
            icon={RotateCw}
          />
          <IconButton label="Ask ARC" onClick={askArc} icon={Sparkles} />
        </div>
      </div>
      {!block.collapsed && block.outputExcerpt.length > 0 && (
        <pre className="mx-3 mb-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-black/30 px-2 py-1 font-mono text-[10.5px] leading-snug text-fg-muted">
          {stripAnsi(block.outputExcerpt)}
        </pre>
      )}
    </div>
  );
}

function StatusDot({ running, failed }: { running: boolean; failed: boolean }) {
  if (running) {
    return (
      <span className="h-2 w-2 shrink-0 animate-pulse-soft rounded-full bg-accent shadow-glow-sm" />
    );
  }
  if (failed) {
    return <XCircle size={10} strokeWidth={2.4} className="shrink-0 text-red-400" />;
  }
  return <span className="h-2 w-2 shrink-0 rounded-full bg-green-400/70" />;
}

function IconButton({
  label,
  onClick,
  disabled,
  icon: Icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  icon: typeof Copy;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded p-1 text-fg-subtle transition-colors enabled:hover:bg-white/[0.06] enabled:hover:text-fg-base disabled:opacity-35"
    >
      <Icon size={11} strokeWidth={2.1} />
    </button>
  );
}

/** "1.2s", "350ms", "2m 14s" — compact, monospace-friendly. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Strip ANSI escape sequences for the inline output preview. xterm renders
 *  the real thing; the drawer just wants readable text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}
