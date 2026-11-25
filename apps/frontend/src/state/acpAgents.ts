import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  acpConversationClose,
  acpPermissionRespond,
  acpProviders,
  acpTurnCancel,
  acpTurnStart,
  isTauri,
  type AcpProvider,
} from '../lib/tauri';
import { sessionSlice, type ClaudeSession } from './claudeCode';
import { useFiles } from './files';

/**
 * Agents ARC drives over the Agent Client Protocol (see rust/acp).
 *
 * Each installed agent gets one chat session in the Agents panel, built from
 * the same `sessionSlice` as Claude Code's — same transcript rows, permission
 * prompt and edited-file review — with an ACP transport underneath.
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
        {
          ready: () => useAcpAgents.getState().providers.some((p) => p.id === provider),
          start: (o) =>
            acpTurnStart({ provider, cwd: o.cwd, content: o.content, resume: o.resume }),
          respond: ({ topic, requestId, allow }) =>
            acpPermissionRespond({ topic, requestId, allow }),
          cancel: acpTurnCancel,
          close: (id) => void acpConversationClose(id).catch(() => {}),
        },
      ),
    );
    sessions.set(provider, store);
  }
  return store;
}
