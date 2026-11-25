import { create } from 'zustand';
import {
  gitRoot,
  isTauri,
  onOrchestratorCall,
  orchestratorReply,
  orchestratorUrl,
  type ClaudePermissionMode,
  type OrchestratorCall,
} from '../lib/tauri';
import { createRaceWorktrees } from '../lib/agentRace';
import { agentLabel, availableAgents, launchAgentWindow } from './acpAgents';
import { chatStore, useChatSessions } from './agentSessions';
import { setMcpUrlProvider, type ClaudeSession, type ClaudeWindowSession } from './claudeCode';
import { askConfirm } from './confirm';
import { useSettings } from './settings';

/**
 * Agents starting agents, through Arc's MCP server (see
 * apps/desktop/src/commands/orchestrator.rs).
 *
 * Every chat conversation is handed an MCP endpoint keyed by its caller key.
 * When its agent calls a tool, the server forwards the call here. A helper is
 * an ordinary agent window, opened behind the current tab, so everything it
 * does stays visible and lands in the Sessions view.
 *
 * Guardrails: the user approves the first helper in each conversation; helpers
 * nest at most `MAX_DEPTH` deep (the deepest get no endpoint at all), at most
 * `MAX_RUNNING` run at once, and a Claude helper never gets a looser
 * permission mode than a Claude parent.
 */

export const MAX_DEPTH = 2;
export const MAX_RUNNING = 4;
const WAIT_DEFAULT_S = 120;
const WAIT_MAX_S = 600;

export interface Helper {
  /** Its window's tab id — also the id agents use for it. */
  id: string;
  /** Caller key of the conversation that started it. */
  parent: string;
  /** `claude` or an ACP agent's CLI id. */
  agent: string;
  label: string;
  depth: number;
  worktree: string | null;
}

export const useOrchestrator = create<{ helpers: Record<string, Helper> }>(() => ({
  helpers: {},
}));

const keyOf = (helperId: string) => `window:${helperId}`;

function helperOf(caller: string): Helper | undefined {
  return caller.startsWith('window:')
    ? useOrchestrator.getState().helpers[caller.slice('window:'.length)]
    : undefined;
}

export function depthOf(caller: string): number {
  return helperOf(caller)?.depth ?? 0;
}

/** Conversations (caller + session id) the user has allowed to start helpers. */
const approved = new Set<string>();
const endpoints = new Map<string, Promise<string | null>>();

/** The MCP endpoint for a conversation, or null when it may not start agents. */
export function mcpUrlFor(caller: string): Promise<string | null> {
  if (!isTauri || depthOf(caller) >= MAX_DEPTH) return Promise.resolve(null);
  let url = endpoints.get(caller);
  if (!url) {
    url = orchestratorUrl(caller, crypto.randomUUID()).catch(() => null);
    endpoints.set(caller, url);
  }
  return url;
}

const PERMISSIVENESS: ClaudePermissionMode[] = [
  'plan',
  'manual',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
];

/** A Claude helper's mode: the user's default, but never looser than a Claude
 *  parent's. */
export function childMode(
  fallback: ClaudePermissionMode,
  parent: ClaudePermissionMode | undefined,
): ClaudePermissionMode {
  if (!parent) return fallback;
  return PERMISSIVENESS.indexOf(parent) < PERMISSIVENESS.indexOf(fallback) ? parent : fallback;
}

/** What a helper said in its latest turn: every answer after the last prompt. */
export function lastReply(s: ClaudeSession): string {
  const at = s.chat.map((c) => c.kind).lastIndexOf('user');
  return s.chat
    .slice(at + 1)
    .flatMap((c) =>
      c.kind === 'assistant' ? [c.text] : c.kind === 'error' ? [`[error] ${c.message}`] : [],
    )
    .join('\n\n')
    .trim();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function ownHelper(caller: string, id: string): Helper {
  const h = useOrchestrator.getState().helpers[id];
  if (!h || h.parent !== caller) throw new Error(`No helper "${id}" started by this conversation.`);
  if (!chatStore(keyOf(id))) throw new Error(`Helper "${id}" was closed.`);
  return h;
}

function statusLine(h: Helper): string {
  const snap = useChatSessions.getState().snaps[keyOf(h.id)];
  const status = snap?.pending ? `waiting for the user (${snap.detail})` : (snap?.status ?? 'idle');
  return `${h.id} — ${h.label}: ${status}${h.worktree ? ` (worktree ${h.worktree})` : ''}`;
}

async function listAgents(caller: string): Promise<string> {
  const agents = await availableAgents();
  const mine = Object.values(useOrchestrator.getState().helpers).filter((h) => h.parent === caller);
  return [
    'Agents you can start (start_agent `agent`):',
    ...agents.map(([id, label]) => `- ${id}: ${label}`),
    '',
    mine.length ? 'Your helpers:' : 'You have no helpers yet.',
    ...mine.map((h) => `- ${statusLine(h)}`),
  ].join('\n');
}

async function startAgent(caller: string, args: Record<string, unknown>): Promise<string> {
  const agent = str(args.agent) === 'claude-cli' ? 'claude' : str(args.agent);
  const prompt = str(args.prompt);
  if (!prompt) throw new Error('start_agent needs a prompt.');
  const agents = await availableAgents();
  if (!agents.some(([id]) => id === agent)) {
    throw new Error(`Unknown agent "${agent}". Available: ${agents.map(([id]) => id).join(', ')}.`);
  }

  const depth = depthOf(caller) + 1;
  if (depth > MAX_DEPTH) throw new Error('Helpers this deep may not start more agents.');
  const running = Object.values(useOrchestrator.getState().helpers).filter((h) => {
    const s = useChatSessions.getState().snaps[keyOf(h.id)]?.status;
    return s === 'working' || s === 'waiting';
  }).length;
  if (running >= MAX_RUNNING) {
    throw new Error(`${MAX_RUNNING} helpers are already running; wait for one to finish.`);
  }

  const parent = useChatSessions.getState().snaps[caller];
  const cwd = parent?.cwd;
  if (!cwd) throw new Error("This conversation has no folder, so a helper can't start.");
  const label = agentLabel(agent);
  const title = str(args.title) || prompt.split('\n')[0]!.slice(0, 40);

  // Once per conversation: the first helper asks, later ones go ahead.
  const conversation = `${caller}|${chatStore(caller)?.getState().sessionId ?? ''}`;
  if (!approved.has(conversation)) {
    const ok = await askConfirm({
      title: `${parent.agent} wants to start ${label}`,
      body: `“${prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt}”\n\nAllowing lets this conversation start helper agents (up to ${MAX_RUNNING} at once) until it ends.`,
      confirmLabel: 'Allow helpers',
    });
    if (!ok) throw new Error('The user declined to start a helper agent.');
    approved.add(conversation);
  }

  // Its own checkout by default, so parallel helpers can't collide.
  const wantTree =
    args.worktree === undefined ? !!(await gitRoot(cwd).catch(() => null)) : args.worktree === true;
  const worktree = wantTree ? (await createRaceWorktrees(cwd, title, 1, label))[0]!.path : null;
  const where = worktree ?? cwd;

  const parentMode = (chatStore(caller)?.getState() as Partial<ClaudeWindowSession> | undefined)
    ?.permissionMode;
  const tabId = await launchAgentWindow({
    agent,
    cwd: where,
    title,
    prompt,
    permissionMode: childMode(useSettings.getState().claudePermissionMode, parentMode),
    // Registered before its first turn, so its own MCP endpoint knows its depth.
    onOpen: (id) =>
      useOrchestrator.setState((s) => ({
        helpers: { ...s.helpers, [id]: { id, parent: caller, agent, label, depth, worktree } },
      })),
  });
  return JSON.stringify({
    id: tabId,
    agent,
    worktree,
    note: 'Started. Use wait_for_agent for its reply.',
  });
}

async function waitForAgent(caller: string, args: Record<string, unknown>): Promise<string> {
  const h = ownHelper(caller, str(args.id));
  const store = chatStore(keyOf(h.id))!;
  const seconds = Math.min(
    Math.max(Number(args.timeout_seconds ?? WAIT_DEFAULT_S) || 0, 0),
    WAIT_MAX_S,
  );
  const settled = (s: ClaudeSession) => !s.streaming || !!s.pending;
  if (!settled(store.getState()) && seconds > 0) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, seconds * 1000);
      const unsubscribe = store.subscribe((s) => settled(s) && done());
      function done() {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  }
  const s = store.getState();
  return JSON.stringify({
    id: h.id,
    status: s.pending ? 'waiting_for_user' : s.streaming ? 'working' : 'done',
    ...(s.pending
      ? {
          waiting_for: `the user to answer “Allow ${s.pending.title || s.pending.tool}?” in its window`,
        }
      : {}),
    reply: s.streaming ? undefined : lastReply(s),
    edited_files: s.editedFiles.map((f) => f.path),
    worktree: h.worktree,
  });
}

async function sendMessage(caller: string, args: Record<string, unknown>): Promise<string> {
  const h = ownHelper(caller, str(args.id));
  const message = str(args.message);
  if (!message) throw new Error('send_message needs a message.');
  const store = chatStore(keyOf(h.id))!;
  if (store.getState().streaming)
    throw new Error('That helper is still working; wait_for_agent first.');
  await store.getState().send(message);
  return 'Sent. Use wait_for_agent for its reply.';
}

async function stopAgent(caller: string, args: Record<string, unknown>): Promise<string> {
  const h = ownHelper(caller, str(args.id));
  await chatStore(keyOf(h.id))!.getState().cancel();
  return 'Stopped.';
}

/** Run one tool call; the text is the tool's result, a throw its error. */
export async function runTool(
  caller: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (tool) {
    case 'list_agents':
      return listAgents(caller);
    case 'start_agent':
      return startAgent(caller, args);
    case 'wait_for_agent':
      return waitForAgent(caller, args);
    case 'send_message':
      return sendMessage(caller, args);
    case 'stop_agent':
      return stopAgent(caller, args);
    default:
      throw new Error(`Unknown tool ${tool}`);
  }
}

async function handle(call: OrchestratorCall): Promise<void> {
  try {
    const text = await runTool(call.caller, call.tool, call.args ?? {});
    await orchestratorReply(call.id, true, text);
  } catch (e) {
    await orchestratorReply(call.id, false, e instanceof Error ? e.message : String(e));
  }
}

let started = false;

/** Wire the server to this module. Called once at startup. */
export function initOrchestrator(): void {
  if (!isTauri || started) return;
  started = true;
  setMcpUrlProvider(mcpUrlFor);
  void onOrchestratorCall((call) => void handle(call));
}
