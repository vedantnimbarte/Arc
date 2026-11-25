import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  acpConversationClose,
  acpPermissionRespond,
  acpProviders,
  acpSessionLoad,
  acpTurnCancel,
  acpTurnStart,
  isTauri,
  type AcpProvider,
} from '../lib/tauri';
import {
  claudeWindow,
  sessionSlice,
  takeConversation,
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

/** How a session reaches one ACP agent. */
export function acpTransport(provider: string): SessionTransport {
  return {
    ready: () => useAcpAgents.getState().providers.some((p) => p.id === provider),
    start: (o) => acpTurnStart({ provider, cwd: o.cwd, content: o.content, resume: o.resume }),
    respond: ({ topic, requestId, allow }) => acpPermissionRespond({ topic, requestId, allow }),
    cancel: acpTurnCancel,
    close: (id) => void acpConversationClose(id).catch(() => {}),
    load: (cwd, id) => acpSessionLoad(provider, cwd, id),
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
      ),
    );
    sessions.set(provider, store);
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
