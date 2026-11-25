import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  acpConversationClose,
  acpSetConfig,
  type AcpConfigOption,
  acpPermissionRespond,
  acpProviders,
  acpSessionLoad,
  acpTurnCancel,
  acpTurnStart,
  isTauri,
  AI_CLIS,
  type AcpProvider,
  type AiCliId,
  type ClaudePermissionMode,
} from '../lib/tauri';
import { registerChat } from './agentSessions';
import {
  claudeWindow,
  sessionSlice,
  takeConversation,
  useClaudeCode,
  type ClaudeSession,
  type SessionTransport,
} from './claudeCode';
import { useFiles } from './files';
import { useSettings } from './settings';
import { useWorkspace } from './workspace';

/**
 * Agents ARC drives over the Agent Client Protocol (see rust/acp).
 *
 * Each installed agent gets one chat session in the Agents panel and any
 * number of windows, all built from the same `sessionSlice` as Claude Code's —
 * same transcript rows, permission prompt and edited-file review — with an
 * ACP transport underneath.
 */
interface AcpState {
  status: 'checking' | 'ready';
  providers: AcpProvider[];
  /** Probe PATH for ACP-capable agents. Safe to call repeatedly. */
  detect: () => Promise<void>;
}

export const useAcpAgents = create<AcpState>((set) => ({
  status: 'checking',
  providers: [],
  detect: async () => {
    if (!isTauri) {
      set({ status: 'ready', providers: [] });
      return;
    }
    try {
      set({ status: 'ready', providers: await acpProviders() });
    } catch {
      set({ status: 'ready', providers: [] });
    }
  },
}));

/**
 * What the user picked for each agent's options (model, mode, …), applied to
 * every new conversation with that agent, plus the options it last offered so
 * the pickers can show before a conversation exists. Persisted: choosing a
 * model once should stick.
 */
interface AcpPrefs {
  choices: Record<string, Record<string, string>>;
  known: Record<string, AcpConfigOption[]>;
  choose: (provider: string, id: string, value: string) => void;
  remember: (provider: string, options: AcpConfigOption[]) => void;
}

export const useAcpPrefs = create<AcpPrefs>()(
  persist(
    (set) => ({
      choices: {},
      known: {},
      choose: (provider, id, value) =>
        set((s) => ({
          choices: { ...s.choices, [provider]: { ...s.choices[provider], [id]: value } },
        })),
      remember: (provider, options) => set((s) => ({ known: { ...s.known, [provider]: options } })),
    }),
    { name: 'arc-acp-prefs', partialize: (s) => ({ choices: s.choices, known: s.known }) },
  ),
);

/** How a session reaches one ACP agent. */
export function acpTransport(provider: string): SessionTransport {
  return {
    ready: () => useAcpAgents.getState().providers.some((p) => p.id === provider),
    start: (o) =>
      acpTurnStart({
        provider,
        cwd: o.cwd,
        content: o.content,
        resume: o.resume,
        config: useAcpPrefs.getState().choices[provider],
        mcpUrl: o.mcpUrl,
        topic: o.topic,
      }),
    respond: ({ topic, requestId, allow }) => acpPermissionRespond({ topic, requestId, allow }),
    cancel: acpTurnCancel,
    close: (id) => void acpConversationClose(id).catch(() => {}),
    load: (cwd, id, mcpUrl) => acpSessionLoad(provider, cwd, id, mcpUrl),
  };
}

const sessions = new Map<string, UseBoundStore<StoreApi<ClaudeSession>>>();

/** The sidebar chat session for one ACP agent, created on first use. It works
 *  in the file tree's folder, like the Claude Code panel. */
export function acpSession(provider: string): UseBoundStore<StoreApi<ClaudeSession>> {
  let store = sessions.get(provider);
  if (!store) {
    store = create<ClaudeSession>()((set, get, api) =>
      sessionSlice(
        set,
        get,
        api,
        () => ({ cwd: useFiles.getState().root, model: '', permissionMode: '' }),
        acpTransport(provider),
        `panel:${provider}`,
      ),
    );
    sessions.set(provider, store);
    registerChat(
      `panel:${provider}`,
      agentLabel(provider),
      { kind: 'panel', provider },
      store,
      () => useFiles.getState().root,
    );
  }
  return store;
}

/**
 * Move a sidebar conversation into its own window, live: the window takes the
 * transcript and the session id (for an ACP agent, its running process), and
 * the sidebar starts fresh. A sidebar with no conversation yet opens an empty
 * window. `provider` is unset for Claude Code.
 */
export function expandToWindow(
  store: StoreApi<ClaudeSession>,
  agent: { provider?: string; title: string },
): void {
  const cwd = useFiles.getState().root;
  const taken = takeConversation(store);
  // The id goes in the tab's saved state too, so a restart reopens it.
  const tabId = useWorkspace.getState().openClaudeCode(cwd, {
    provider: agent.provider,
    title: agent.title,
    sessionId: taken?.sessionId,
  });
  if (!taken) return;
  // Seeded before the window mounts, so it doesn't reload what it already has.
  const s = useSettings.getState();
  claudeWindow(
    tabId,
    {
      provider: agent.provider,
      cwd,
      model: s.claudeModel,
      permissionMode: s.claudePermissionMode,
      sidebarHidden: false,
    },
    agent.provider ? acpTransport(agent.provider) : undefined,
  ).setState(taken);
}

/** The choices one option offers, with groups flattened. */
export function flatChoices(
  o: AcpConfigOption,
): { value: string; name: string; description?: string | null }[] {
  return o.options.flatMap((c) => {
    if (c.options) return flatChoices({ ...o, options: c.options });
    return c.value === undefined
      ? []
      : [{ value: c.value, name: c.name, description: c.description }];
  });
}

/**
 * Pick a value for one of an agent's options. Remembered for new
 * conversations; applied to the live one, if any, and the store takes the
 * agent's answer (changing the model can add or drop options). The store
 * shows the new value at once and snaps back if the agent refuses it.
 */
export async function chooseConfig(
  store: StoreApi<ClaudeSession>,
  provider: string,
  id: string,
  value: string,
): Promise<void> {
  useAcpPrefs.getState().choose(provider, id, value);
  const { config, sessionId } = store.getState();
  if (!config || !sessionId) return;
  const before = config;
  store.setState({ config: config.map((o) => (o.id === id ? { ...o, currentValue: value } : o)) });
  try {
    const next = await acpSetConfig(sessionId, id, value);
    if (Array.isArray(next)) store.setState({ config: next });
  } catch {
    // The conversation's agent is gone, or refused: show what it really has.
    if (store.getState().sessionId === sessionId) store.setState({ config: before });
  }
}

/** An agent's display name: `claude` or an ACP agent's CLI id. */
export function agentLabel(agent: string): string {
  if (agent === 'claude') return 'Claude Code';
  return (
    AI_CLIS[agent as AiCliId] ??
    // An agent the built-in table doesn't know (the e2e suite's test agent):
    // the backend names it.
    useAcpAgents.getState().providers.find((p) => p.id === agent)?.label ??
    agent
  );
}

/** Every chat agent installed right now, as `[id, label]`: Claude Code and the
 *  ACP agents. Probes for them first if nothing has yet. */
export async function availableAgents(): Promise<[string, string][]> {
  const acp = useAcpAgents.getState();
  if (acp.status === 'checking') await acp.detect();
  if (useClaudeCode.getState().status === 'checking') await useClaudeCode.getState().detect();
  return [
    ...(useClaudeCode.getState().status === 'ready'
      ? [['claude', 'Claude Code'] as [string, string]]
      : []),
    ...useAcpAgents.getState().providers.map((p) => [p.id, p.label] as [string, string]),
  ];
}

/**
 * Open an agent window behind whatever the user is looking at and start it on
 * `prompt` — a helper another agent started, or a scheduled run. `onOpen` runs
 * with the new tab id before the first turn starts, for bookkeeping that has
 * to exist by then. Resolves with the tab id once the turn has started.
 */
export async function launchAgentWindow(opts: {
  agent: string;
  cwd: string;
  title: string;
  prompt: string;
  permissionMode?: ClaudePermissionMode;
  onOpen?: (tabId: string) => void;
}): Promise<string> {
  const ws = useWorkspace.getState();
  const before = ws.activeTabId;
  const provider = opts.agent === 'claude' ? undefined : opts.agent;
  const tabId = ws.openClaudeCode(opts.cwd, {
    provider,
    title: `${agentLabel(opts.agent)}: ${opts.title}`,
  });
  if (before) ws.setActive(before);
  opts.onOpen?.(tabId);

  const s = useSettings.getState();
  const store = claudeWindow(
    tabId,
    {
      provider,
      cwd: opts.cwd,
      model: s.claudeModel,
      permissionMode: opts.permissionMode ?? s.claudePermissionMode,
      sidebarHidden: true,
    },
    provider ? acpTransport(provider) : undefined,
  );
  await store.getState().send(opts.prompt);
  return tabId;
}
