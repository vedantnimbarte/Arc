import { create } from 'zustand';
import {
  isTauri,
  sshFsConnect,
  sshFsDisconnect,
  type SshHost,
} from '../lib/tauri';
import { makeRemotePath, parseRemotePath } from '../lib/remote';
import { useFiles } from './files';
import { toast, toastError } from './toast';

/**
 * The remote-workspace connection: one saved SSH host whose filesystem is
 * mounted as the file-tree root.
 *
 * Only one at a time. Multiple simultaneous remote roots would need the file
 * tree to show several roots at once, which it doesn't do for local folders
 * either — switching is the same gesture as opening a different local folder.
 *
 * The connection is separate from any SSH *terminal* tab for the same host:
 * closing a terminal must not take the file tree down with it, and vice
 * versa. See rust/ssh/src/sftp.rs.
 */

export type RemoteStatus = 'idle' | 'connecting' | 'connected' | 'error';

interface RemoteWorkspaceState {
  status: RemoteStatus;
  /** Host whose filesystem is mounted, or null when idle. */
  host: SshHost | null;
  /** The `ssh://` root handed to the file tree. */
  root: string | null;
  error: string | null;
  /** Where the local tree pointed before, so closing can restore it. */
  previousLocalRoot: string | null;

  /** Connect and reroot the file tree. `path` defaults to the login dir. */
  open: (host: SshHost, path?: string) => Promise<void>;
  /** Disconnect and put the tree back on the previous local folder. */
  close: () => Promise<void>;
  /** Re-dial the current host, keeping the same root. */
  reconnect: () => Promise<void>;
}

export const useRemoteWorkspace = create<RemoteWorkspaceState>((set, get) => ({
  status: 'idle',
  host: null,
  root: null,
  error: null,
  previousLocalRoot: null,

  open: async (host, path) => {
    if (!isTauri) {
      toastError('Remote workspaces need the desktop app.');
      return;
    }
    // Remember where we were, but only if it's a real local folder — opening
    // a second remote host in a row must not record the first as the place to
    // return to.
    const current = useFiles.getState().root;
    const previousLocalRoot =
      current && !parseRemotePath(current) ? current : get().previousLocalRoot;

    set({ status: 'connecting', host, error: null, previousLocalRoot });
    try {
      const absolute = await sshFsConnect(host.id, path);
      const root = makeRemotePath(host.id, absolute);
      set({ status: 'connected', root, error: null });
      useFiles.getState().setRoot(root);
      toast(`Connected to ${host.name}`);
    } catch (err) {
      const message = String(err);
      set({ status: 'error', error: message });
      toastError(`Couldn't open ${host.name}: ${message}`);
    }
  },

  close: async () => {
    const { host, previousLocalRoot } = get();
    if (host && isTauri) {
      await sshFsDisconnect(host.id).catch(() => {});
    }
    set({ status: 'idle', host: null, root: null, error: null });
    // Fall back to the last local folder. If there wasn't one, leave the tree
    // where it is rather than guessing — an empty tree is worse than a stale
    // one, and the user can always open a folder.
    if (previousLocalRoot) useFiles.getState().setRoot(previousLocalRoot);
  },

  reconnect: async () => {
    const { host, root } = get();
    if (!host) return;
    const path = root ? parseRemotePath(root)?.path : undefined;
    await get().open(host, path);
  },
}));
