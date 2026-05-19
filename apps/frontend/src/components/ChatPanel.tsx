import { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Trash2,
  Square,
  X,
  ChevronDown,
  FileText,
  FolderTree,
  Search as SearchIcon,
  Pencil,
  Terminal as TerminalIcon,
  Wrench,
  Check,
  History,
  MessageSquarePlus,
} from 'lucide-react';
import { useChat } from '../state/chat';
import { useSettings, PROVIDER_LABELS } from '../state/settings';
import {
  AGENT_ICONS,
  AGENT_TINTS,
  getAgentById,
  type Agent,
} from '../state/agents';
import {
  agentDecide,
  agentRun,
  isTauri,
  llmStream,
  mcpCallTool,
  mcpConnect,
  mcpDisconnect,
  mcpListTools,
  type LlmMessage,
} from '../lib/tauri';
import { useFiles } from '../state/files';
import { cn } from '../lib/cn';
import { SessionsView } from './chat/SessionsView';
import { AgentsView } from './chat/AgentsView';

/** One-shot intent fired from a global keyboard shortcut. App.tsx owns the
 *  state; ChatPanel consumes via `onIntentConsumed`. `at` lets repeat
 *  presses of the same shortcut re-fire. */
export type ChatIntent =
  | { type: 'new-session'; at: number }
  | { type: 'toggle-agents'; at: number }
  | { type: 'toggle-sessions'; at: number };

interface ChatPanelProps {
  onClose?: () => void;
  intent?: ChatIntent | null;
  onIntentConsumed?: () => void;
}

type View = 'chat' | 'sessions' | 'agents';

interface PendingApproval {
  approvalId: string;
  toolUseId: string;
  name: string;
  input: unknown;
  status: 'pending' | 'approved' | 'denied';
}

export function ChatPanel({ onClose, intent, onIntentConsumed }: ChatPanelProps = {}) {
  const messages = useChat((s) => s.messages);
  const isStreaming = useChat((s) => s.isStreaming);
  const append = useChat((s) => s.append);
  const appendChunk = useChat((s) => s.appendChunk);
  const finalize = useChat((s) => s.finalize);
  const setStreaming = useChat((s) => s.setStreaming);
  const clear = useChat((s) => s.clear);
  const newSession = useChat((s) => s.newSession);
  const activeSession = useChat((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId) ?? null,
  );

  const { activeProvider, providers, systemPrompt } = useSettings();
  const cfg = providers[activeProvider];

  // Resolve the agent persona for the current session. Falls back to the
  // first built-in agent if the stored agentId is unknown (e.g. a custom
  // agent was deleted while a session referenced it).
  const activeAgent: Agent = getAgentById(activeSession?.agentId);

  // Per-agent system prompt overrides the global one from Settings. Empty
  // strings fall back to the settings default so the user can wipe an
  // agent's prompt without breaking chat.
  const effectiveSystemPrompt = activeAgent.systemPrompt.trim() || systemPrompt;

  const [view, setView] = useState<View>('chat');
  const [input, setInput] = useState('');
  // Pending tool-approval prompts. The agent runtime parks until each
  // entry is resolved via `agentDecide`. We mirror them as a tray over
  // the composer so the user can act without scrolling.
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const approvalsRef = useRef<PendingApproval[]>([]);
  useEffect(() => {
    approvalsRef.current = approvals;
  }, [approvals]);
  // On unmount (popover closed mid-run), explicitly deny any pending
  // approvals so the Rust runtime doesn't hang on a never-resolved oneshot.
  useEffect(() => {
    return () => {
      for (const a of approvalsRef.current) {
        if (a.status === 'pending') void agentDecide(a.approvalId, false);
      }
    };
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<null | (() => Promise<void>)>(null);

  useEffect(() => {
    if (view !== 'chat') return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, view]);

  // React to global-shortcut intents from App.tsx. `intent.at` re-fires the
  // effect even when the same intent type comes in twice.
  useEffect(() => {
    if (!intent) return;
    if (intent.type === 'new-session') {
      newSession(activeAgent.id);
      setView('chat');
    } else if (intent.type === 'toggle-agents') {
      setView((v) => (v === 'agents' ? 'chat' : 'agents'));
    } else if (intent.type === 'toggle-sessions') {
      setView((v) => (v === 'sessions' ? 'chat' : 'sessions'));
    }
    onIntentConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent]);

  async function send() {
    const text = input.trim();
    if (!text || isStreaming) return;

    // `/agent <goal>` — drop into the coding-agent runtime. Anthropic-only.
    if (text.startsWith('/agent ') || text === '/agent') {
      await runAgent(text.replace(/^\/agent\s*/, '').trim());
      return;
    }

    // `/mcp <subcommand>` — exercise the stdio MCP client.
    if (text.startsWith('/mcp')) {
      await runMcp(text);
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
        system: effectiveSystemPrompt,
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
        // Stream is over — write the accumulated content to SQLite.
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
    append({ role: 'user', content: `/agent ${goal}` });
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
        // Persona overlay — the runtime composes this on top of its
        // built-in coding-agent prompt.
        system_prompt: activeAgent.systemPrompt || null,
      },
      (ev) => {
        if (ev.kind === 'text') {
          appendChunk(assistantId, ev.text);
        } else if (ev.kind === 'tool_start') {
          appendChunk(assistantId, `\n\n→ \`${ev.name}\`\n`);
        } else if (ev.kind === 'approval_request') {
          setApprovals((curr) => [
            ...curr,
            {
              approvalId: ev.approval_id,
              toolUseId: ev.tool_use_id,
              name: ev.name,
              input: ev.input,
              status: 'pending',
            },
          ]);
        } else if (ev.kind === 'tool_result') {
          const status = ev.ok ? '✓' : '✗';
          const snippet =
            ev.output.length > 280 ? ev.output.slice(0, 280) + '…' : ev.output;
          appendChunk(assistantId, `${status} ${snippet}\n\n`);
          // The runtime has produced a result for this tool — the approval
          // prompt (if any) is now stale, retire it.
          setApprovals((curr) => curr.filter((a) => a.toolUseId !== ev.id));
        } else if (ev.kind === 'done') {
          setStreaming(false);
          setApprovals([]);
          void finalize(assistantId);
        } else if (ev.kind === 'error') {
          appendChunk(assistantId, `\n\n⚠ ${ev.message}`);
          setStreaming(false);
          setApprovals([]);
          void finalize(assistantId);
        }
      },
    );
  }

  async function runMcp(raw: string) {
    setInput('');
    append({ role: 'user', content: raw });
    if (!isTauri) {
      append({ role: 'system', content: 'MCP runs in the Tauri shell only. Launch via `pnpm tauri:dev`.' });
      return;
    }

    const tokens = raw.trim().split(/\s+/);
    const sub = tokens[1] ?? 'help';
    try {
      if (sub === 'connect') {
        const id = tokens[2];
        const command = tokens[3];
        const args = tokens.slice(4);
        if (!id || !command) {
          append({
            role: 'system',
            content: 'Usage: `/mcp connect <id> <command> [args...]`',
          });
          return;
        }
        await mcpConnect(id, command, args);
        append({ role: 'system', content: `connected MCP server \`${id}\` (${command})` });
      } else if (sub === 'list') {
        const id = tokens[2];
        if (!id) {
          append({ role: 'system', content: 'Usage: `/mcp list <id>`' });
          return;
        }
        const tools = await mcpListTools(id);
        if (tools.length === 0) {
          append({ role: 'system', content: `\`${id}\` exposes no tools.` });
        } else {
          const rows = tools
            .map((t) => `• \`${t.name}\` — ${t.description ?? '(no description)'}`)
            .join('\n');
          append({ role: 'system', content: `tools on \`${id}\`:\n${rows}` });
        }
      } else if (sub === 'call') {
        const id = tokens[2];
        const name = tokens[3];
        if (!id || !name) {
          append({
            role: 'system',
            content: 'Usage: `/mcp call <id> <tool> <json-args>` — json defaults to `{}`',
          });
          return;
        }
        const jsonBlob = raw.replace(/^\/mcp\s+call\s+\S+\s+\S+\s*/, '').trim() || '{}';
        let args: unknown;
        try {
          args = JSON.parse(jsonBlob);
        } catch (err) {
          append({ role: 'system', content: `bad JSON: ${String(err)}` });
          return;
        }
        const out = await mcpCallTool(id, name, args);
        append({ role: 'assistant', content: out || '(empty result)' });
      } else if (sub === 'disconnect') {
        const id = tokens[2];
        if (!id) {
          append({ role: 'system', content: 'Usage: `/mcp disconnect <id>`' });
          return;
        }
        await mcpDisconnect(id);
        append({ role: 'system', content: `disconnected MCP server \`${id}\`` });
      } else {
        append({
          role: 'system',
          content:
            'MCP commands:\n' +
            '• `/mcp connect <id> <command> [args...]` — spawn + initialize\n' +
            '• `/mcp list <id>` — list tools\n' +
            '• `/mcp call <id> <tool> <json>` — invoke a tool\n' +
            '• `/mcp disconnect <id>` — kill the server',
        });
      }
    } catch (err) {
      append({ role: 'system', content: `mcp error: ${String(err)}` });
    }
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
      <ChatHeader
        agent={activeAgent}
        view={view}
        isStreaming={isStreaming}
        onAgentClick={() =>
          setView((v) => (v === 'agents' ? 'chat' : 'agents'))
        }
        onSessionsClick={() =>
          setView((v) => (v === 'sessions' ? 'chat' : 'sessions'))
        }
        onNewSession={() => {
          newSession(activeAgent.id);
          setView('chat');
        }}
        onClear={() => {
          if (messages.length === 0) return;
          if (window.confirm('Clear this conversation?')) void clear();
        }}
        onClose={onClose}
      />

      {/* View deck — all three views stay mounted underneath each other so
          we can cross-fade between them without losing scroll position or
          form state. The inactive layers fade out, lift a hair, and stop
          taking pointer events; the active layer fades in. */}
      <div className="relative min-h-0 flex-1">
        <ViewLayer active={view === 'chat'}>
          <div
            ref={scrollRef}
            className="selectable flex-1 space-y-3 overflow-y-auto px-3.5 py-4"
          >
            {messages.length === 0 && <EmptyState agent={activeAgent} />}

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
              return (
                <div
                  key={m.id}
                  className="flex animate-fade-in flex-col gap-1.5"
                  style={{ animationDelay: delay }}
                >
                  <AssistantBlocks content={m.content} streaming={isStreaming} />
                </div>
              );
            })}
          </div>

          <ApprovalTray
            approvals={approvals}
            onDecide={(id, approve) => {
              setApprovals((curr) =>
                curr.map((a) =>
                  a.approvalId === id
                    ? { ...a, status: approve ? 'approved' : 'denied' }
                    : a,
                ),
              );
              void agentDecide(id, approve);
            }}
          />

          <Composer
            input={input}
            onChange={setInput}
            onSend={() => void send()}
            onStop={() => void stop()}
            isStreaming={isStreaming}
            providerLabel={PROVIDER_LABELS[activeProvider]}
            agentName={activeAgent.name}
          />
        </ViewLayer>

        <ViewLayer active={view === 'sessions'}>
          <SessionsView
            onBack={() => setView('chat')}
            onNewSession={() => {
              newSession(activeAgent.id);
              setView('chat');
            }}
          />
        </ViewLayer>

        <ViewLayer active={view === 'agents'}>
          <AgentsView
            onBack={() => setView('chat')}
            onPicked={() => setView('chat')}
          />
        </ViewLayer>
      </div>
    </div>
  );
}

// Single layer in the stacked view deck. Active layer is at rest (opacity-1,
// translate-y-0). Inactive layers fade out + lift one notch and stop taking
// pointer events. Using opacity + transform instead of display:none keeps
// the layout cheap and the transition GPU-accelerated.
function ViewLayer({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col',
        'transition-[opacity,transform] duration-200 ease-apple',
        'motion-reduce:transition-none',
        active
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-1.5 opacity-0',
      )}
      aria-hidden={!active}
      // `inert` prevents focus from landing inside hidden layers via Tab.
      // React's TS type omits the attribute prop; cast through any.
      {...({ inert: !active ? '' : undefined } as Record<string, string | undefined>)}
    >
      {children}
    </div>
  );
}

// --- Header ----------------------------------------------------------------

function ChatHeader({
  agent,
  view,
  isStreaming,
  onAgentClick,
  onSessionsClick,
  onNewSession,
  onClear,
  onClose,
}: {
  agent: Agent;
  view: View;
  isStreaming: boolean;
  onAgentClick: () => void;
  onSessionsClick: () => void;
  onNewSession: () => void;
  onClear: () => void;
  onClose?: () => void;
}) {
  const Icon = AGENT_ICONS[agent.iconKey];
  const tint = AGENT_TINTS[agent.tint];
  return (
    <div className="flex h-11 shrink-0 items-center justify-between border-b border-border-hairline/80 px-3">
      <button
        onClick={onAgentClick}
        className={cn(
          'group -mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1',
          'transition-colors duration-150 hover:bg-white/[0.05]',
          view === 'agents' && 'bg-white/[0.05]',
        )}
        aria-label="Switch agent"
        aria-expanded={view === 'agents'}
        title={`${agent.name} — ${agent.description}`}
      >
        <span
          className={cn(
            'flex h-[22px] w-[22px] items-center justify-center rounded-md ring-1',
            tint.chipBg,
            tint.chipFg,
            tint.chipRing,
          )}
        >
          <Icon size={11} strokeWidth={2.3} />
        </span>
        <span className="max-w-[140px] truncate font-display text-[12.5px] font-semibold tracking-tight text-fg-base">
          {agent.name}
        </span>
        <ChevronDown
          size={11}
          strokeWidth={2.2}
          className={cn(
            'text-fg-subtle transition-all duration-200 ease-apple',
            view === 'agents' && 'rotate-180 text-fg-muted',
          )}
        />
      </button>

      <div className="flex items-center gap-0.5">
        {isStreaming && (
          <div className="mr-1 flex items-center gap-1 font-mono text-[10px] tabular-nums text-fg-muted">
            <span className="relative flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-accent-bright/40" />
              <span className="absolute inset-[3px] rounded-full bg-accent-bright" />
            </span>
            <span>streaming</span>
          </div>
        )}
        <HeaderButton
          onClick={onSessionsClick}
          active={view === 'sessions'}
          label="Conversations"
        >
          <History size={12} strokeWidth={2.1} />
        </HeaderButton>
        <HeaderButton onClick={onNewSession} label="New chat">
          <MessageSquarePlus size={12} strokeWidth={2.1} />
        </HeaderButton>
        <HeaderButton onClick={onClear} label="Clear conversation">
          <Trash2 size={12} strokeWidth={2.1} />
        </HeaderButton>
        {onClose && (
          <HeaderButton onClick={onClose} label="Close">
            <X size={13} strokeWidth={2.2} />
          </HeaderButton>
        )}
      </div>
    </div>
  );
}

function HeaderButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-md p-1.5 transition-all duration-150 ease-apple',
        active
          ? 'bg-white/[0.08] text-fg-base'
          : 'text-fg-subtle hover:bg-white/[0.08] hover:text-fg-base',
      )}
      title={label}
      aria-label={label}
      aria-pressed={!!active}
    >
      {children}
    </button>
  );
}

// --- Empty state -----------------------------------------------------------

function EmptyState({ agent }: { agent: Agent }) {
  const Icon = AGENT_ICONS[agent.iconKey];
  const tint = AGENT_TINTS[agent.tint];
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div
        className={cn(
          'mb-3 flex h-14 w-14 items-center justify-center rounded-2xl ring-1',
          tint.chipBg,
          tint.chipFg,
          tint.chipRing,
        )}
      >
        <Icon size={22} strokeWidth={1.8} />
      </div>
      <p className="font-display text-[13.5px] font-semibold tracking-tight text-fg-base">
        {agent.name}
      </p>
      <p className="mt-1 max-w-[260px] font-display text-[11.5px] leading-relaxed text-fg-muted">
        {agent.description}
      </p>
    </div>
  );
}

// --- Approval tray ---------------------------------------------------------

// Renders the stack of pending tool-approval prompts above the composer.
// Resolved entries (approved / denied) linger briefly so the user gets
// confirmation feedback before the matching tool_result arrives and the
// tray controller drops them.
function ApprovalTray({
  approvals,
  onDecide,
}: {
  approvals: PendingApproval[];
  onDecide: (approvalId: string, approve: boolean) => void;
}) {
  if (approvals.length === 0) return null;
  return (
    <div className="shrink-0 space-y-1.5 border-t border-border-hairline/70 bg-black/[0.18] px-3 py-2">
      {approvals.map((a) => (
        <ApprovalCard key={a.approvalId} approval={a} onDecide={onDecide} />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: PendingApproval;
  onDecide: (approvalId: string, approve: boolean) => void;
}) {
  const meta = TOOL_META[approval.name] ?? { label: approval.name, icon: Wrench };
  const Icon = meta.icon;
  // Surface the one argument that matters most for the user's decision:
  // `path` for fs writes, `command` for shell, the longest string field
  // otherwise. JSON-stringified fallback so unknown tools still render.
  const summary = summarizeApprovalInput(approval.name, approval.input);
  const settled = approval.status !== 'pending';
  return (
    <div
      className={cn(
        'animate-fade-in overflow-hidden rounded-xl border backdrop-blur-md',
        approval.status === 'pending' &&
          'border-amber-400/30 bg-amber-400/[0.06]',
        approval.status === 'approved' &&
          'border-status-ok/30 bg-status-ok/[0.07]',
        approval.status === 'denied' &&
          'border-status-err/30 bg-status-err/[0.07]',
      )}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        <span
          className={cn(
            'mt-0.5 flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-md',
            approval.status === 'pending' && 'bg-amber-400/15 text-amber-200',
            approval.status === 'approved' && 'bg-status-ok/15 text-status-ok',
            approval.status === 'denied' && 'bg-status-err/15 text-status-err',
          )}
        >
          {approval.status === 'pending' ? (
            <Icon size={11} strokeWidth={2.2} />
          ) : approval.status === 'approved' ? (
            <Check size={12} strokeWidth={2.6} />
          ) : (
            <X size={12} strokeWidth={2.6} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-display text-[11.5px] font-semibold tracking-tight text-fg-base">
              {approval.status === 'pending'
                ? `Approve ${meta.label.toLowerCase()}?`
                : approval.status === 'approved'
                  ? `${meta.label} approved`
                  : `${meta.label} denied`}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-3 break-all font-mono text-[10.5px] leading-snug text-fg-muted">
            {summary}
          </p>
        </div>
        {!settled && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => onDecide(approval.approvalId, false)}
              className="rounded-md border border-white/[0.06] bg-black/[0.20] px-2 py-1 font-display text-[10.5px] font-medium tracking-tight text-fg-muted transition-colors duration-150 hover:border-status-err/40 hover:bg-status-err/10 hover:text-status-err"
            >
              Deny
            </button>
            <button
              onClick={() => onDecide(approval.approvalId, true)}
              className="rounded-md bg-status-ok px-2.5 py-1 font-display text-[10.5px] font-medium tracking-tight text-bg-base transition-all duration-150 hover:brightness-110 active:scale-[0.97]"
            >
              Approve
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Pull the most decision-relevant field out of a tool input for display
 *  in the approval card. Falls back to a JSON dump for unknown tools. */
function summarizeApprovalInput(name: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (name === 'fs_write_file' && typeof obj.path === 'string') {
      const bytes = typeof obj.content === 'string' ? obj.content.length : 0;
      return `${obj.path}${bytes ? `  (${bytes} bytes)` : ''}`;
    }
    if (name === 'shell' && typeof obj.command === 'string') {
      return obj.command;
    }
    // Pick the longest string-valued field — usually the meaningful one.
    let best = '';
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.length > best.length) best = v;
    }
    if (best) return best;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

// --- Composer --------------------------------------------------------------

function Composer({
  input,
  onChange,
  onSend,
  onStop,
  isStreaming,
  providerLabel,
  agentName,
}: {
  input: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  providerLabel: string;
  agentName: string;
}) {
  return (
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
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder={
            isStreaming ? `streaming from ${providerLabel}…` : `Ask ${agentName}…`
          }
          rows={1}
          disabled={isStreaming}
          className="selectable max-h-32 min-h-[22px] flex-1 resize-none bg-transparent font-display text-[13px] leading-relaxed text-fg-base placeholder:text-fg-subtle focus:outline-none disabled:opacity-60"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-status-err/15 text-status-err transition-all duration-150 hover:bg-status-err hover:text-white"
            aria-label="Stop"
            title="Stop streaming"
          >
            <Square size={10} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button
            onClick={onSend}
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
  );
}

// --- Assistant rendering ---------------------------------------------------

type Block =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; name: string; status: 'pending' | 'ok' | 'err'; output: string };

// Parse agent-emitted text into a sequence of text and tool blocks.
// The agent writes `\n\n→ \`name\`\n` to open a tool call and
// `✓ output\n\n` or `✗ output\n\n` to close it.
function parseAssistant(content: string): Block[] {
  const blocks: Block[] = [];
  const lines = content.split('\n');
  let buf: string[] = [];
  const flushText = () => {
    const t = buf.join('\n').trim();
    if (t) blocks.push({ kind: 'text', content: t });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const start = line.match(/^→\s+`([^`]+)`\s*$/);
    if (start) {
      flushText();
      const name = start[1] ?? '';
      const next = lines[i + 1] ?? '';
      const r = next.match(/^([✓✗])\s*(.*)$/);
      if (r) {
        let output = r[2] ?? '';
        let j = i + 2;
        while (j < lines.length && lines[j] !== '') {
          output += '\n' + (lines[j] ?? '');
          j++;
        }
        blocks.push({
          kind: 'tool',
          name,
          status: r[1] === '✓' ? 'ok' : 'err',
          output: output.trim(),
        });
        i = j;
      } else {
        blocks.push({ kind: 'tool', name, status: 'pending', output: '' });
      }
      continue;
    }
    buf.push(line);
  }
  flushText();
  return blocks;
}

function AssistantBlocks({ content, streaming }: { content: string; streaming: boolean }) {
  if (!content) {
    return streaming ? (
      <div className="self-start rounded-2xl rounded-bl-[6px] bg-bg-subtle/70 px-3 py-1.5 ring-1 ring-white/[0.04]">
        <span className="inline-flex gap-1 text-fg-muted">
          <span className="h-1.5 w-1.5 animate-shimmer-cursor rounded-full bg-fg-muted/70" />
          <span className="h-1.5 w-1.5 animate-shimmer-cursor rounded-full bg-fg-muted/70" style={{ animationDelay: '0.15s' }} />
          <span className="h-1.5 w-1.5 animate-shimmer-cursor rounded-full bg-fg-muted/70" style={{ animationDelay: '0.3s' }} />
        </span>
      </div>
    ) : null;
  }

  const blocks = parseAssistant(content);
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'text' ? (
          <div
            key={i}
            className="max-w-[92%] self-start whitespace-pre-wrap rounded-2xl rounded-bl-[6px] bg-bg-subtle/85 px-3 py-1.5 font-display text-[13px] leading-relaxed text-fg-base ring-1 ring-white/[0.04]"
          >
            {b.content}
          </div>
        ) : (
          <ToolCard key={i} name={b.name} status={b.status} output={b.output} />
        ),
      )}
    </>
  );
}

const TOOL_META: Record<string, { label: string; icon: typeof FileText }> = {
  fs_read_file: { label: 'Read', icon: FileText },
  fs_search: { label: 'Search', icon: SearchIcon },
  fs_list_dir: { label: 'List', icon: FolderTree },
  fs_write_file: { label: 'Edit', icon: Pencil },
  shell: { label: 'Run', icon: TerminalIcon },
};

function ToolCard({
  name,
  status,
  output,
}: {
  name: string;
  status: 'pending' | 'ok' | 'err';
  output: string;
}) {
  const [open, setOpen] = useState(false);
  const meta = TOOL_META[name] ?? { label: name, icon: Wrench };
  const Icon = meta.icon;

  const firstLine = output.split('\n').find((l) => l.trim()) ?? '';
  const restLines = output.split('\n').slice(1).join('\n').trim();
  const hasMore = restLines.length > 0 || firstLine.length > 64;

  return (
    <div
      className={cn(
        'group max-w-[92%] self-start overflow-hidden rounded-xl',
        'border border-white/[0.05] bg-black/[0.22] backdrop-blur-md',
        'transition-colors duration-150 hover:border-white/[0.09]',
      )}
    >
      <button
        type="button"
        onClick={() => hasMore && setOpen((o) => !o)}
        disabled={!hasMore}
        className={cn(
          'flex w-full items-center gap-2 px-2.5 py-1.5 text-left',
          hasMore && 'cursor-pointer hover:bg-white/[0.025]',
        )}
      >
        <span
          className={cn(
            'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md',
            status === 'pending' && 'bg-accent-soft text-accent-bright',
            status === 'ok' && 'bg-status-ok/15 text-status-ok',
            status === 'err' && 'bg-status-err/15 text-status-err',
          )}
        >
          {status === 'pending' ? (
            <Icon size={10} strokeWidth={2.2} />
          ) : status === 'ok' ? (
            <Check size={11} strokeWidth={2.6} />
          ) : (
            <X size={11} strokeWidth={2.6} />
          )}
        </span>
        <span className="font-display text-[11.5px] font-semibold tracking-tight text-fg-base">
          {meta.label}
        </span>
        {firstLine && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-fg-muted">
            {firstLine}
          </span>
        )}
        {hasMore && (
          <ChevronDown
            size={11}
            strokeWidth={2.2}
            className={cn(
              'shrink-0 text-fg-subtle transition-transform duration-200 ease-apple',
              open && 'rotate-180',
            )}
          />
        )}
      </button>
      {hasMore && open && (
        <pre className="selectable max-h-48 overflow-auto border-t border-white/[0.04] bg-black/[0.25] px-3 py-2 font-mono text-[10.5px] leading-relaxed text-fg-muted">
          {output}
        </pre>
      )}
    </div>
  );
}
