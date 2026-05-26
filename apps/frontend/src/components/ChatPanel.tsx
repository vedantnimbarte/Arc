import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Trash2,
  Square,
  X,
  ChevronDown,
  FileCode2,
  FileText,
  FolderTree,
  Search as SearchIcon,
  Pencil,
  Terminal as TerminalIcon,
  Wrench,
  Check,
  History,
  MessageSquarePlus,
  Sparkles,
  Plug,
  List as ListIcon,
  Zap,
  PowerOff,
  BookmarkPlus,
  ListOrdered,
  Plus,
  Paperclip,
  AtSign,
  Eraser,
  type LucideIcon,
} from 'lucide-react';
import { useChat, type ChatContext } from '../state/chat';
import {
  useSettings,
  useActivePreset,
  useActiveProviderConfig,
} from '../state/settings';
import { ModelPicker, useCurrentModelLabel } from './ModelPicker';
import { ProviderIconBare } from './ProviderIcon';
import {
  AGENT_ICONS,
  AGENT_TINTS,
  getAgentById,
  type Agent,
} from '../state/agents';
import {
  agentDecide,
  agentRun,
  fsListFiles,
  fsPickFiles,
  fsReadFile,
  isTauri,
  llmStream,
  mcpCallTool,
  mcpConnect,
  mcpDisconnect,
  mcpListTools,
  memoryDelete,
  memoryList,
  memorySave,
  memorySearch,
  type FileItem,
  type LlmMessage,
  type MemoryEntry,
  type MemoryHit,
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
  const pendingContexts = useChat((s) => s.pendingContexts);
  const removePendingContext = useChat((s) => s.removePendingContext);
  const clearPendingContexts = useChat((s) => s.clearPendingContexts);
  const addPendingContext = useChat((s) => s.addPendingContext);
  const filesRoot = useFiles((s) => s.root);
  const activeSession = useChat((s) =>
    s.sessions.find((x) => x.id === s.activeSessionId) ?? null,
  );

  const providers = useSettings((s) => s.providers);
  const systemPrompt = useSettings((s) => s.systemPrompt);
  const activePreset = useActivePreset();
  const cfg = useActiveProviderConfig();

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

    // `/clear` — wipe the active conversation (skips confirmation since
    // typing the command is itself an explicit action).
    if (text === '/clear') {
      setInput('');
      await clear();
      return;
    }

    // `/file` — open the native multi-file picker; each pick becomes a chip.
    if (text === '/file' || text === '/files' || text === '/attach') {
      setInput('');
      await attachViaPicker();
      return;
    }

    // `/mention` — insert `@` so the file-mention popover opens.
    if (text === '/mention') {
      setInput('@');
      return;
    }

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

    // `/memory <subcommand>` — save / search / list / delete workspace notes.
    // We deliberately keep `pendingContexts` intact for slash commands so
    // a user mid-task can run a quick `/memory list` without losing their
    // staged selection.
    if (text === '/memory' || text.startsWith('/memory ')) {
      await runMemory(text);
      return;
    }

    // Compose the outbound text — any staged "Ask ARC AI" snippets become a
    // fenced prefix above what the user typed.
    const composed = composeUserMessage(text, pendingContexts);

    if (!isTauri) {
      setInput('');
      append({ role: 'user', content: composed });
      clearPendingContexts();
      const id = append({ role: 'assistant', content: '' });
      setStreaming(true);
      const reply = `(stub · run via pnpm tauri:dev for real ${activePreset.label} calls)`;
      for (const word of reply.split(' ')) {
        await new Promise((r) => setTimeout(r, 30));
        appendChunk(id, word + ' ');
      }
      setStreaming(false);
      return;
    }

    if (activePreset.needsApiKey && !cfg.apiKey) {
      append({
        role: 'system',
        content: `No API key set for ${activePreset.label}. Open settings (⌘,) to add one.`,
      });
      return;
    }

    setInput('');
    append({ role: 'user', content: composed });
    clearPendingContexts();
    const assistantId = append({ role: 'assistant', content: '' });
    setStreaming(true);

    const wire: LlmMessage[] = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    wire.push({ role: 'user', content: composed });

    const reqId = crypto.randomUUID();
    cancelRef.current = await llmStream(
      {
        id: reqId,
        provider: activePreset.kind,
        model: cfg.model,
        messages: wire,
        system: effectiveSystemPrompt,
        api_key: cfg.apiKey || undefined,
        base_url: cfg.baseUrl || activePreset.defaultBaseUrl || undefined,
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
    if (!anthropic?.apiKey) {
      append({
        role: 'system',
        content:
          'The V0 agent uses Anthropic. Open Settings (⌘,) and add an Anthropic API key, then retry.',
      });
      return;
    }

    setInput('');
    // Bake any staged context into the visible /agent message *and* the
    // goal we hand to the runtime — both surfaces benefit from it.
    const composedGoal = composeUserMessage(goal, pendingContexts);
    const displayGoal = composedGoal === goal ? `/agent ${goal}` : `/agent ${composedGoal}`;
    append({ role: 'user', content: displayGoal });
    clearPendingContexts();
    const assistantId = append({ role: 'assistant', content: '' });
    setStreaming(true);

    const root = useFiles.getState().root;
    const runId = crypto.randomUUID();

    await agentRun(
      {
        id: runId,
        goal: composedGoal,
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
            '• `/mcp disconnect <id>` — kill the server\n' +
            '\n' +
            'Connected MCP tools are exposed to `/agent` as ' +
            '`mcp__<id>__<tool>` and require approval per call.',
        });
      }
    } catch (err) {
      append({ role: 'system', content: `mcp error: ${String(err)}` });
    }
  }

  async function runMemory(raw: string) {
    setInput('');
    append({ role: 'user', content: raw });
    if (!isTauri) {
      append({
        role: 'system',
        content: 'Memory runs in the Tauri shell only. Launch via `pnpm tauri:dev`.',
      });
      return;
    }

    const trimmed = raw.trim();
    // First token after `/memory` is the subcommand; everything else is its arg.
    const match = trimmed.match(/^\/memory(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/);
    const sub = (match?.[1] ?? 'help').toLowerCase();
    const rest = match?.[2]?.trim() ?? '';

    try {
      if (sub === 'save' || sub === 'add' || sub === 'note') {
        if (!rest) {
          append({
            role: 'system',
            content:
              'Usage: `/memory save <content>` — `#tag` tokens are extracted as tags.',
          });
          return;
        }
        const { content, tags, title } = parseMemoryDraft(rest);
        const entry = await memorySave({
          content,
          tags: tags.length ? tags.join(', ') : null,
          title: title ?? null,
          source: 'chat',
        });
        append({
          role: 'system',
          content: `saved memory \`${entry.id.slice(0, 8)}\`${
            entry.tags ? ` (tags: ${entry.tags})` : ''
          }`,
        });
      } else if (sub === 'search' || sub === 'find' || sub === '?') {
        if (!rest) {
          append({ role: 'system', content: 'Usage: `/memory search <query>`' });
          return;
        }
        const hits = await memorySearch('__all__', rest, 10);
        append({ role: 'system', content: formatMemoryHits(rest, hits) });
      } else if (sub === 'list' || sub === 'ls') {
        const n = clampInt(rest, 10, 1, 50);
        const entries = await memoryList('__all__', n);
        append({ role: 'system', content: formatMemoryList(entries) });
      } else if (sub === 'delete' || sub === 'rm' || sub === 'del') {
        if (!rest) {
          append({
            role: 'system',
            content: 'Usage: `/memory delete <id-prefix>` (first 4+ chars of the id)',
          });
          return;
        }
        const removed = await resolveAndDelete(rest);
        if (removed) {
          append({ role: 'system', content: `deleted memory \`${removed}\`` });
        } else {
          append({
            role: 'system',
            content: `no memory found matching \`${rest}\`. Try \`/memory list\` first.`,
          });
        }
      } else {
        append({
          role: 'system',
          content:
            'Memory commands:\n' +
            '• `/memory save <content>` — `#tag` tokens become tags\n' +
            '• `/memory search <query>` — FTS5 keyword search (supports `foo*`, `"phrase"`)\n' +
            '• `/memory list [N]` — N most recently updated (default 10)\n' +
            '• `/memory delete <id-prefix>` — remove an entry\n' +
            '\nEntries persist in SQLite at the per-user data dir.',
        });
      }
    } catch (err) {
      append({ role: 'system', content: `memory error: ${String(err)}` });
    }
  }

  async function stop() {
    if (cancelRef.current) {
      await cancelRef.current();
      cancelRef.current = null;
      setStreaming(false);
    }
  }

  /** Read one file and stage it as a `source: 'file'` context chip. Skips
   *  silently if the same path is already attached. Surfaces read errors
   *  (binary / too-large / not-found) as a system message so the user can
   *  see why the chip didn't appear. */
  async function attachFileByPath(path: string): Promise<boolean> {
    if (!isTauri) return false;
    const already = useChat
      .getState()
      .pendingContexts.some((c) => c.source === 'file' && c.path === path);
    if (already) return true;
    try {
      const text = await fsReadFile(path);
      const name = path.split(/[\\/]/).pop() || path;
      addPendingContext({ source: 'file', label: name, text, path });
      return true;
    } catch (err) {
      append({
        role: 'system',
        content: `couldn't attach \`${path}\`: ${String(err)}`,
      });
      return false;
    }
  }

  /** Open the native multi-file picker. Each chosen file becomes a chip. */
  async function attachViaPicker() {
    if (!isTauri) {
      append({
        role: 'system',
        content: 'File attachments need the Tauri shell. Launch via `pnpm tauri:dev`.',
      });
      return;
    }
    let paths: string[] = [];
    try {
      paths = await fsPickFiles(filesRoot);
    } catch (err) {
      append({ role: 'system', content: `file picker error: ${String(err)}` });
      return;
    }
    for (const p of paths) {
      await attachFileByPath(p);
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
            providerLabel={activePreset.label}
            agentName={activeAgent.name}
            contexts={pendingContexts}
            onRemoveContext={removePendingContext}
            onAttachFiles={() => void attachViaPicker()}
            onAttachFileByPath={(p) => attachFileByPath(p)}
            onClearConversation={() => {
              if (messages.length === 0) return;
              void clear();
            }}
            workspaceRoot={filesRoot}
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

/** Build the final user-facing message from the raw textarea content and
 *  any pending contexts (selection snippets or attached files). Each
 *  context becomes a labeled fenced code block above the user's prose.
 *  Returns the raw text unchanged when there are no contexts. */
export function composeUserMessage(text: string, contexts: ChatContext[]): string {
  if (contexts.length === 0) return text;
  const blocks = contexts.map((c) => {
    const heading =
      c.source === 'file'
        ? `File ${c.path ?? c.label}:`
        : `Selected from ${c.label}:`;
    return `${heading}\n\`\`\`\n${c.text}\n\`\`\``;
  });
  return [...blocks, text].filter(Boolean).join('\n\n');
}

function Composer({
  input,
  onChange,
  onSend,
  onStop,
  isStreaming,
  providerLabel,
  agentName,
  contexts,
  onRemoveContext,
  onAttachFiles,
  onAttachFileByPath,
  onClearConversation,
  workspaceRoot,
}: {
  input: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  providerLabel: string;
  agentName: string;
  contexts: ChatContext[];
  onRemoveContext: (id: string) => void;
  onAttachFiles: () => void;
  onAttachFileByPath: (path: string) => Promise<boolean>;
  onClearConversation: () => void;
  workspaceRoot: string | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursorPos, setCursorPos] = useState(0);
  // Slash-command popover: derived from the input. We use a "dismissedAt"
  // value rather than a boolean so pressing Escape suppresses the popover
  // for the current input but re-arms naturally as the user keeps typing.
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  // Slash-command actions need to invoke parent handlers. Build the static
  // command list once, then resolve actions per-render through this map so
  // the SLASH_COMMANDS array can stay declarative.
  const commandActions: Partial<Record<string, () => void>> = {
    '/file': onAttachFiles,
    '/clear': () => {
      onChange('');
      onClearConversation();
    },
    '/mention': () => {
      onChange('@');
      // Defer focus so the cursor lands after the freshly inserted '@'.
      queueMicrotask(() => {
        textareaRef.current?.focus();
        const len = textareaRef.current?.value.length ?? 1;
        textareaRef.current?.setSelectionRange(len, len);
      });
    },
  };

  const visibleCommands = useMemo(() => {
    if (isStreaming || !input.startsWith('/')) return [];
    const q = input.toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.command.toLowerCase().startsWith(q));
  }, [input, isStreaming]);

  // ─── @ mention popover ───────────────────────────────────────────────
  // Detect a live `@partial` token immediately before the cursor. To open
  // the popover, `@` must either start the input or follow whitespace, and
  // the token may not contain whitespace itself.
  const mention = useMemo(() => detectMention(input, cursorPos), [input, cursorPos]);
  const [mentionItems, setMentionItems] = useState<FileItem[]>([]);
  const [mentionSelected, setMentionSelected] = useState(0);
  const [mentionDismissedAt, setMentionDismissedAt] = useState<string | null>(null);
  const mentionQuery = mention?.query ?? null;
  const mentionActive =
    !isStreaming &&
    mention !== null &&
    workspaceRoot !== null &&
    mentionDismissedAt !== mentionKey(mention);

  useEffect(() => {
    if (!mentionActive || workspaceRoot === null || mentionQuery === null) {
      setMentionItems([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void fsListFiles(workspaceRoot, mentionQuery, 8)
        .then((items) => {
          if (!cancelled) setMentionItems(items);
        })
        .catch((err) => {
          if (!cancelled) {
            console.error('[chat] mention list failed:', err);
            setMentionItems([]);
          }
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [mentionActive, mentionQuery, workspaceRoot]);

  useEffect(() => {
    setMentionSelected((s) => Math.min(s, Math.max(0, mentionItems.length - 1)));
  }, [mentionItems.length]);

  useEffect(() => {
    setMentionSelected(0);
  }, [mentionQuery]);

  const mentionPopoverOpen = mentionActive && mentionItems.length > 0;
  const popoverOpen =
    !mentionActive && visibleCommands.length > 0 && input !== dismissedAt;

  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, visibleCommands.length - 1)));
  }, [visibleCommands.length]);

  useEffect(() => {
    setSelected(0);
  }, [visibleCommands[0]?.command]);

  const pickCommand = (idx: number) => {
    const c = visibleCommands[idx];
    if (!c) return;
    const action = commandActions[c.command];
    if (action) {
      // Inline-action commands fire immediately and clear the input — they
      // don't take arguments so leaving `/clear ` typed would be confusing.
      onChange('');
      action();
      return;
    }
    onChange(c.command + ' ');
  };

  const pickMention = async (idx: number) => {
    const item = mentionItems[idx];
    if (!item || !mention) return;
    // Replace `@partial` with `@basename ` and stage the file as a context
    // chip. We preserve the rest of the input so the user can keep typing.
    const before = input.slice(0, mention.at);
    const after = input.slice(mention.at + 1 + mention.query.length);
    const replaced = `${before}@${item.name} ${after}`;
    onChange(replaced);
    // Restore the cursor after the inserted name + space.
    const nextPos = before.length + 1 + item.name.length + 1;
    queueMicrotask(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextPos, nextPos);
    });
    await onAttachFileByPath(item.path);
  };

  const syncCursor = () => {
    const el = textareaRef.current;
    if (el) setCursorPos(el.selectionStart ?? el.value.length);
  };

  return (
    <div className="shrink-0 px-3 pb-3 pt-1">
      <div className="relative">
        {mentionPopoverOpen ? (
          <MentionPopover
            items={mentionItems}
            selected={mentionSelected}
            onHover={setMentionSelected}
            onPick={(i) => void pickMention(i)}
          />
        ) : popoverOpen ? (
          <SlashCommandsPopover
            commands={visibleCommands}
            selected={selected}
            onHover={setSelected}
            onPick={pickCommand}
          />
        ) : null}
        {contexts.length > 0 && (
          <ContextChipStack contexts={contexts} onRemove={onRemoveContext} />
        )}
        <div
          className={cn(
            'group flex items-end gap-2 rounded-[20px] border border-border-subtle bg-bg-base/55 px-2 py-2 backdrop-blur-md',
            'transition-all duration-150 ease-apple',
            'focus-within:border-accent/45 focus-within:bg-bg-base/75 focus-within:shadow-focus',
          )}
        >
          <button
            type="button"
            onClick={onAttachFiles}
            disabled={isStreaming}
            title="Attach files"
            aria-label="Attach files"
            className={cn(
              'flex h-[26px] w-[26px] shrink-0 items-center justify-center self-end rounded-full',
              'border border-border-subtle bg-white/[0.04] text-fg-muted',
              'transition-all duration-150 ease-apple',
              'enabled:hover:border-accent/40 enabled:hover:bg-accent-soft enabled:hover:text-accent-bright',
              'enabled:active:scale-[0.94]',
              'disabled:opacity-50',
            )}
          >
            <Plus size={13} strokeWidth={2.4} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              onChange(e.target.value);
              setCursorPos(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={syncCursor}
            onClick={syncCursor}
            onKeyUp={syncCursor}
            onKeyDown={(e) => {
              if (mentionPopoverOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionSelected((s) => (s + 1) % mentionItems.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionSelected(
                    (s) => (s - 1 + mentionItems.length) % mentionItems.length,
                  );
                  return;
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault();
                  void pickMention(mentionSelected);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  if (mention) setMentionDismissedAt(mentionKey(mention));
                  return;
                }
              }
              if (popoverOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelected((s) => (s + 1) % visibleCommands.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelected(
                    (s) => (s - 1 + visibleCommands.length) % visibleCommands.length,
                  );
                  return;
                }
                if (e.key === 'Tab') {
                  e.preventDefault();
                  pickCommand(selected);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  pickCommand(selected);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setDismissedAt(input);
                  return;
                }
              }
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
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 px-1.5 font-display text-[10px] text-fg-subtle">
        <div className="flex min-w-0 items-center gap-2">
          <ModelTriggerPill placement="up" align="start" />
          <span className="hidden truncate tracking-tight sm:inline">
            <kbd className="font-mono">return</kbd> to send · <kbd className="font-mono">/</kbd> for commands · <kbd className="font-mono">@</kbd> for files
          </span>
        </div>
        {isStreaming && (
          <span className="flex shrink-0 items-center gap-1.5 text-accent">
            <span className="h-1 w-1 animate-pulse-soft rounded-full bg-accent shadow-glow-sm" />
            streaming
          </span>
        )}
      </div>
    </div>
  );
}

// ─── @ mention detection helpers ─────────────────────────────────────────

interface MentionContext {
  /** Index of the `@` character in the input string. */
  at: number;
  /** Substring between the `@` and the cursor (no whitespace). */
  query: string;
}

/** Look at the input + cursor position and return the live `@partial` token
 *  the user is typing, or null if the cursor isn't in one. The `@` must be
 *  at the start of the input or immediately follow whitespace. */
function detectMention(input: string, cursor: number): MentionContext | null {
  if (cursor === 0) return null;
  const before = input.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { at, query };
}

function mentionKey(m: MentionContext): string {
  return `${m.at}:${m.query}`;
}

// --- Context chip stack ----------------------------------------------------

/** Row of dismissible chips above the composer textarea — one per pending
 *  selection snippet captured by "Ask ARC AI". Each chip shows the source
 *  label and a two-line preview; the full text is included verbatim when
 *  the user sends. */
function ContextChipStack({
  contexts,
  onRemove,
}: {
  contexts: ChatContext[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {contexts.map((c) => {
        const Icon =
          c.source === 'terminal'
            ? TerminalIcon
            : c.source === 'file'
              ? FileText
              : FileCode2;
        // For file attachments, surface the path under the basename instead
        // of dumping the contents — files are typically long and the chip
        // would otherwise turn into an opaque block.
        const subtitle =
          c.source === 'file'
            ? prettyRelPath(c.path ?? c.label)
            : c.text
                .split('\n')
                .slice(0, 2)
                .join('\n')
                .replace(/\s+$/g, '') || '(empty selection)';
        const sizeBadge =
          c.source === 'file' ? `${formatBytes(c.text.length)}` : null;
        return (
          <div
            key={c.id}
            className={cn(
              'group flex max-w-[260px] animate-fade-in items-start gap-2',
              'rounded-xl border border-border-subtle bg-bg-base/55 px-2.5 py-1.5',
              'backdrop-blur-md transition-colors duration-150 ease-apple',
              'hover:border-accent/35',
            )}
          >
            <span
              className={cn(
                'mt-[2px] flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-md',
                c.source === 'file'
                  ? 'bg-accent-soft text-accent-bright'
                  : 'bg-white/[0.06] text-fg-muted',
              )}
            >
              <Icon size={10} strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate font-display text-[10.5px] font-semibold tracking-tight text-fg-base">
                  {c.label}
                </span>
                {sizeBadge && (
                  <span className="shrink-0 rounded bg-white/[0.05] px-1 font-mono text-[9px] tracking-tight text-fg-subtle">
                    {sizeBadge}
                  </span>
                )}
              </div>
              <p className="mt-0.5 line-clamp-2 break-all font-mono text-[10.5px] leading-snug text-fg-muted">
                {subtitle}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onRemove(c.id)}
              className={cn(
                'mt-[1px] flex h-[16px] w-[16px] shrink-0 items-center justify-center',
                'rounded-md text-fg-subtle opacity-0 transition-all duration-150',
                'hover:bg-status-err/15 hover:text-status-err',
                'group-hover:opacity-100 focus-visible:opacity-100',
              )}
              aria-label={`Remove ${c.label} context`}
              title="Remove context"
            >
              <X size={11} strokeWidth={2.4} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Shorten a long absolute path for chip display: keep the last 2-3
 *  segments so the user sees the meaningful suffix. */
function prettyRelPath(path: string): string {
  const norm = path.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 3) return norm;
  return '…/' + parts.slice(-3).join('/');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pill that opens the global ModelPicker. Lives in two places — the chat
 *  composer (placement='up') and the status bar (placement='up', align='end').
 *  Owns the open/close state for its associated picker. */
export function ModelTriggerPill({
  placement = 'up',
  align = 'start',
  compact,
}: {
  placement?: 'up' | 'down';
  align?: 'start' | 'end';
  compact?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { presetLabel, modelLabel, preset } = useCurrentModelLabel();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${presetLabel} · ${modelLabel} — click to switch`}
        className={cn(
          'group inline-flex max-w-[260px] items-center gap-1.5 rounded-full border transition-colors',
          compact
            ? 'h-[18px] px-1.5 text-[10px]'
            : 'h-[20px] px-1.5 text-[10.5px]',
          open
            ? 'border-accent/45 bg-accent-soft text-fg-base shadow-glow-sm'
            : 'border-border-subtle bg-bg-base/40 text-fg-muted hover:border-border-strong hover:text-fg-base',
        )}
      >
        <ProviderIconBare presetId={preset.id} size={11} />
        <span className="truncate font-mono">{modelLabel}</span>
        <ChevronDown
          size={9}
          strokeWidth={2.4}
          className={cn(
            'shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-180 text-fg-base',
          )}
        />
      </button>
      <ModelPicker
        open={open}
        anchorRef={triggerRef}
        placement={placement}
        align={align}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

// --- Slash commands popover -----------------------------------------------

type SlashCommandGroup = 'context' | 'agent' | 'mcp' | 'memory';

interface SlashCommand {
  command: string;
  args?: string;
  description: string;
  group: SlashCommandGroup;
  icon: LucideIcon;
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    command: '/file',
    description: 'Attach file(s) from your computer via a native picker',
    group: 'context',
    icon: Paperclip,
  },
  {
    command: '/mention',
    description: 'Open the @-picker for files in the current folder',
    group: 'context',
    icon: AtSign,
  },
  {
    command: '/clear',
    description: 'Clear the active conversation',
    group: 'context',
    icon: Eraser,
  },
  {
    command: '/agent',
    args: '<goal>',
    description: 'Hand a goal to the tool-using coding agent',
    group: 'agent',
    icon: Sparkles,
  },
  {
    command: '/mcp connect',
    args: '<id> <command> [args…]',
    description: 'Spawn and initialize an MCP server over stdio',
    group: 'mcp',
    icon: Plug,
  },
  {
    command: '/mcp list',
    args: '<id>',
    description: 'List the tools exposed by a connected server',
    group: 'mcp',
    icon: ListIcon,
  },
  {
    command: '/mcp call',
    args: '<id> <tool> <json>',
    description: 'Invoke a tool with a JSON argument blob',
    group: 'mcp',
    icon: Zap,
  },
  {
    command: '/mcp disconnect',
    args: '<id>',
    description: 'Tear down a running MCP server',
    group: 'mcp',
    icon: PowerOff,
  },
  {
    command: '/memory save',
    args: '<content>',
    description: 'Persist a note · `#tag` tokens become tags',
    group: 'memory',
    icon: BookmarkPlus,
  },
  {
    command: '/memory search',
    args: '<query>',
    description: 'FTS5 keyword search · supports `foo*`, `"phrase"`',
    group: 'memory',
    icon: SearchIcon,
  },
  {
    command: '/memory list',
    args: '[N]',
    description: 'Show the N most recently updated entries',
    group: 'memory',
    icon: ListOrdered,
  },
  {
    command: '/memory delete',
    args: '<id-prefix>',
    description: 'Remove an entry by its short id',
    group: 'memory',
    icon: Trash2,
  },
];

const GROUP_LABELS: Record<SlashCommandGroup, string> = {
  context: 'Context',
  agent: 'Agent',
  mcp: 'MCP',
  memory: 'Memory',
};

function SlashCommandsPopover({
  commands,
  selected,
  onHover,
  onPick,
}: {
  commands: SlashCommand[];
  selected: number;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
}) {
  // Group consecutive commands sharing the same `group`. We keep the
  // original flat index alongside each entry so keyboard nav and the
  // visible highlight stay in lockstep across group boundaries.
  const groups: { group: SlashCommandGroup; items: { cmd: SlashCommand; idx: number }[] }[] = [];
  commands.forEach((c, i) => {
    const last = groups[groups.length - 1];
    if (last && last.group === c.group) {
      last.items.push({ cmd: c, idx: i });
    } else {
      groups.push({ group: c.group, items: [{ cmd: c, idx: i }] });
    }
  });

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-slash-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className={cn(
        'absolute inset-x-0 bottom-full z-30 mb-2',
        'overflow-hidden rounded-[18px] border border-border-subtle',
        'bg-bg-panel/85 backdrop-blur-xl backdrop-saturate-180',
        'shadow-sheet',
        'animate-popover-in',
      )}
    >
      {/* Hairline silver gleam along the top edge — subliminal "polished" cue. */}
      <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.10] to-transparent" />

      <div ref={listRef} className="max-h-[296px] overflow-y-auto py-1">
        {groups.map((g, gi) => (
          <div key={g.group}>
            {gi > 0 && (
              <div className="mx-3 my-1 h-px bg-gradient-to-r from-transparent via-white/[0.05] to-transparent" />
            )}
            <div className="flex items-center gap-2 px-3.5 pb-1 pt-2">
              <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
                {GROUP_LABELS[g.group]}
              </span>
              <span className="h-px flex-1 bg-white/[0.03]" />
            </div>
            {g.items.map(({ cmd, idx }) => (
              <SlashRow
                key={cmd.command}
                cmd={cmd}
                idx={idx}
                selected={selected === idx}
                onHover={() => onHover(idx)}
                onPick={() => onPick(idx)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-white/[0.05] bg-black/[0.22] px-3 py-1.5 font-display text-[10px] text-fg-subtle">
        <span className="flex items-center gap-3">
          <KeyHint k="↑↓" label="navigate" />
          <KeyHint k="↵" label="select" />
          <KeyHint k="esc" label="dismiss" />
        </span>
        <span className="font-mono tracking-tight text-fg-subtle/70">
          {commands.length} {commands.length === 1 ? 'match' : 'matches'}
        </span>
      </div>
    </div>
  );
}

function SlashRow({
  cmd,
  idx,
  selected,
  onHover,
  onPick,
}: {
  cmd: SlashCommand;
  idx: number;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const Icon = cmd.icon;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-slash-idx={idx}
      onMouseEnter={onHover}
      // Use onMouseDown + preventDefault so the click doesn't steal focus
      // from the textarea (which would otherwise dismiss the popover before
      // the pick resolves).
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        'group relative flex w-full items-start gap-2.5 px-3 py-1.5 text-left',
        'transition-colors duration-100',
        selected ? 'bg-white/[0.05]' : 'hover:bg-white/[0.025]',
      )}
    >
      {selected && (
        <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-gradient-to-b from-accent-bright via-accent to-accent/30" />
      )}
      <span
        className={cn(
          'mt-[3px] flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md ring-1 transition-all duration-150 ease-apple',
          selected
            ? 'bg-white/[0.10] text-accent-bright ring-white/[0.12] shadow-glow-sm'
            : 'bg-white/[0.035] text-fg-muted ring-white/[0.04]',
        )}
      >
        <Icon size={11} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'font-mono text-[11.5px] font-semibold tracking-tight',
              selected ? 'text-fg-base' : 'text-fg-base/90',
            )}
          >
            {cmd.command}
          </span>
          {cmd.args && (
            <span
              className={cn(
                'truncate font-mono text-[10.5px] tracking-tight',
                selected ? 'text-fg-muted' : 'text-fg-subtle',
              )}
            >
              {cmd.args}
            </span>
          )}
        </div>
        <p
          className={cn(
            'mt-0.5 truncate font-display text-[10.5px] leading-snug',
            selected ? 'text-fg-muted' : 'text-fg-subtle',
          )}
        >
          {cmd.description}
        </p>
      </div>
      {selected && (
        <span
          className="self-center font-mono text-[9.5px] tracking-widest2 text-fg-subtle"
          aria-hidden
        >
          ↵
        </span>
      )}
    </button>
  );
}

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-[4px] border border-white/[0.08] bg-white/[0.04] px-1 font-mono text-[9px] leading-none text-fg-muted shadow-control">
        {k}
      </kbd>
      <span className="tracking-tight">{label}</span>
    </span>
  );
}

// ─── @ mention popover ────────────────────────────────────────────────────

function MentionPopover({
  items,
  selected,
  onHover,
  onPick,
}: {
  items: FileItem[];
  selected: number;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-mention-idx="${selected}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div
      role="listbox"
      aria-label="Attach file"
      className={cn(
        'absolute inset-x-0 bottom-full z-30 mb-2',
        'overflow-hidden rounded-[18px] border border-border-subtle',
        'bg-bg-panel/85 backdrop-blur-xl backdrop-saturate-180',
        'shadow-sheet',
        'animate-popover-in',
      )}
    >
      <div className="pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r from-transparent via-white/[0.10] to-transparent" />
      <div className="flex items-center gap-2 px-3.5 pb-1 pt-2">
        <AtSign size={10} strokeWidth={2.4} className="text-fg-subtle" />
        <span className="font-mono text-[9.5px] uppercase tracking-widest2 text-fg-subtle">
          Files
        </span>
        <span className="h-px flex-1 bg-white/[0.03]" />
      </div>
      <div ref={listRef} className="max-h-[264px] overflow-y-auto py-1">
        {items.map((item, i) => (
          <MentionRow
            key={item.path}
            item={item}
            idx={i}
            selected={selected === i}
            onHover={() => onHover(i)}
            onPick={() => onPick(i)}
          />
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-white/[0.05] bg-black/[0.22] px-3 py-1.5 font-display text-[10px] text-fg-subtle">
        <span className="flex items-center gap-3">
          <KeyHint k="↑↓" label="navigate" />
          <KeyHint k="↵" label="attach" />
          <KeyHint k="esc" label="dismiss" />
        </span>
        <span className="font-mono tracking-tight text-fg-subtle/70">
          {items.length} {items.length === 1 ? 'file' : 'files'}
        </span>
      </div>
    </div>
  );
}

function MentionRow({
  item,
  idx,
  selected,
  onHover,
  onPick,
}: {
  item: FileItem;
  idx: number;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-mention-idx={idx}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        'group relative flex w-full items-center gap-2.5 px-3 py-1.5 text-left',
        'transition-colors duration-100',
        selected ? 'bg-white/[0.05]' : 'hover:bg-white/[0.025]',
      )}
    >
      {selected && (
        <span className="pointer-events-none absolute inset-y-1.5 left-0 w-[2px] rounded-r-full bg-gradient-to-b from-accent-bright via-accent to-accent/30" />
      )}
      <span
        className={cn(
          'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md ring-1 transition-all duration-150 ease-apple',
          selected
            ? 'bg-white/[0.10] text-accent-bright ring-white/[0.12] shadow-glow-sm'
            : 'bg-white/[0.035] text-fg-muted ring-white/[0.04]',
        )}
      >
        <FileText size={11} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate font-mono text-[11.5px] font-semibold tracking-tight',
            selected ? 'text-fg-base' : 'text-fg-base/90',
          )}
        >
          {item.name}
        </div>
        <div
          className={cn(
            'truncate font-mono text-[10px] leading-snug',
            selected ? 'text-fg-muted' : 'text-fg-subtle',
          )}
        >
          {item.rel}
        </div>
      </div>
      {selected && (
        <span
          className="self-center font-mono text-[9.5px] tracking-widest2 text-fg-subtle"
          aria-hidden
        >
          ↵
        </span>
      )}
    </button>
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

// ─── /memory helpers ──────────────────────────────────────────────────────

/** Parse `/memory save` body. Pulls `#tag` tokens and `--title=foo` /
 *  `--title "foo bar"` flags out of the free-form content. The `#tag` markers
 *  stay in the saved content so the surrounding sentence remains readable. */
function parseMemoryDraft(raw: string): {
  content: string;
  tags: string[];
  title: string | null;
} {
  let working = raw;
  let title: string | null = null;

  // Title flag: --title=foo  | --title "foo bar"  | --title foo
  const titleEq = working.match(/(^|\s)--title=("([^"]*)"|(\S+))/);
  if (titleEq) {
    title = (titleEq[3] ?? titleEq[4] ?? '').trim() || null;
    working = (working.slice(0, titleEq.index!) + working.slice(titleEq.index! + titleEq[0].length)).trim();
  } else {
    const titleQ = working.match(/(^|\s)--title\s+("([^"]+)"|(\S+))/);
    if (titleQ) {
      title = (titleQ[3] ?? titleQ[4] ?? '').trim() || null;
      working = (working.slice(0, titleQ.index!) + working.slice(titleQ.index! + titleQ[0].length)).trim();
    }
  }

  const tags = Array.from(
    new Set(
      Array.from(working.matchAll(/(?:^|\s)#([A-Za-z0-9_\-]+)/g)).map((m) => m[1]!.toLowerCase()),
    ),
  );
  return { content: working.trim(), tags, title };
}

function clampInt(s: string, fallback: number, lo: number, hi: number): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function formatMemoryHits(query: string, hits: MemoryHit[]): string {
  if (hits.length === 0) return `no matches for \`${query}\`.`;
  const lines = hits.map((h, i) => {
    const idShort = h.entry.id.slice(0, 8);
    const title = h.entry.title ? `${h.entry.title} — ` : '';
    return `${i + 1}. \`${idShort}\` ${title}${h.snippet}`;
  });
  return `${hits.length} match${hits.length === 1 ? '' : 'es'} for \`${query}\`:\n${lines.join('\n')}`;
}

function formatMemoryList(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return 'no memories yet. Try `/memory save <content>`.';
  }
  const lines = entries.map((e, i) => {
    const idShort = e.id.slice(0, 8);
    const title = e.title ? `${e.title} — ` : '';
    const preview = e.content.replace(/\s+/g, ' ').slice(0, 80);
    const tagSuffix = e.tags ? `  [${e.tags}]` : '';
    return `${i + 1}. \`${idShort}\` ${title}${preview}${preview.length === 80 ? '…' : ''}${tagSuffix}`;
  });
  return `${entries.length} memor${entries.length === 1 ? 'y' : 'ies'}:\n${lines.join('\n')}`;
}

/** Find an entry whose id starts with `prefix` and delete it. Returns the
 *  short id on success, null when no match (ambiguous prefixes prefer the
 *  most recently updated to keep the UX forgiving). */
async function resolveAndDelete(prefix: string): Promise<string | null> {
  const needle = prefix.toLowerCase();
  const candidates = await memoryList('__all__', 200);
  const hit = candidates.find((e) => e.id.toLowerCase().startsWith(needle));
  if (!hit) return null;
  await memoryDelete(hit.id);
  return hit.id.slice(0, 8);
}
