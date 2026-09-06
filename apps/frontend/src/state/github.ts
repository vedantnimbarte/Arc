import { create } from 'zustand';
import {
  gitHostPrListFor,
  gitHostRateRemaining,
  gitHostTokenDelete,
  gitHostTokenGet,
  gitHostViewer,
  isTauri,
  type GitHostPrListFilter,
  type GitHostPrSummary,
} from '../lib/tauri';

// GitHub tab state: who is signed in, which section the rail is on, and which
// repository the repo-scoped sections are pointed at.
//
// The token itself is never held here — it lives in the OS credential vault
// and the Rust side reads it per call. This store only tracks *whether* one
// exists (`signedIn`), so the view can choose between the sign-in screen and
// the workspace. Keeping the secret out of the renderer means a stray console
// log or an error boundary's state dump can't leak it.
//
// `PrPanel` reads pull requests from here too, so the sidebar and the tab
// can't drift apart or double-fetch the same list.

/** Rail sections, in rail order. */
export type GitHubSection =
  | 'repos'
  | 'issues'
  | 'pulls'
  | 'actions'
  | 'releases'
  | 'inbox';

export interface GitHubViewer {
  login: string;
  avatarUrl: string;
  name: string | null;
}

/** `owner/name`, the key every repo-scoped cache is filed under. */
export type RepoKey = string;

export function repoKey(owner: string, name: string): RepoKey {
  return `${owner}/${name}`;
}

/** Split a `owner/name` key. Returns null for anything malformed. */
export function splitRepoKey(key: RepoKey): { owner: string; name: string } | null {
  const slash = key.indexOf('/');
  if (slash <= 0 || slash === key.length - 1) return null;
  return { owner: key.slice(0, slash), name: key.slice(slash + 1) };
}

interface GitHubState {
  /** Undefined until the first keychain read resolves — the view shows a
   *  quiet loading state rather than flashing the sign-in screen at someone
   *  who is already signed in. */
  signedIn: boolean | undefined;
  viewer: GitHubViewer | null;
  section: GitHubSection;
  /** Repository the repo-scoped sections read. Null means none picked yet. */
  repo: RepoKey | null;
  /** Requests left in the current GitHub rate-limit window, when a response
   *  has reported it. Surfaced in the context bar only when it runs low. */
  rateRemaining: number | null;

  /** Pull request lists, keyed by `owner/name:filter`. Shared with the Source
   *  Control sidebar's PR sheet so the two can't drift or double-fetch. */
  prs: Record<string, GitHostPrSummary[]>;
  /** Fetch a PR list, serving the cache unless `force`. */
  loadPrs: (
    owner: string,
    name: string,
    filter: GitHostPrListFilter,
    force?: boolean,
  ) => Promise<GitHostPrSummary[]>;
  /** Drop every cached list for a repo, after a write changed one of them. */
  invalidatePrs: (owner: string, name: string) => void;

  /** Read the keychain and, if a token is there, confirm it still works. */
  checkAuth: () => Promise<void>;
  setSection: (section: GitHubSection) => void;
  setRepo: (repo: RepoKey | null) => void;
  /** Ask GitHub how much of the hour's budget is left. Cheap enough to call
   *  on a timer — `/rate_limit` is the one endpoint that doesn't spend any. */
  refreshRateLimit: () => Promise<void>;
  /** Drop the stored token and return to the sign-in screen. */
  signOut: () => Promise<void>;
}

export const useGitHub = create<GitHubState>((set, get) => ({
  signedIn: undefined,
  viewer: null,
  section: 'repos',
  repo: null,
  rateRemaining: null,
  prs: {},

  loadPrs: async (owner, name, filter, force) => {
    const key = `${owner}/${name}:${filter}`;
    const cached = get().prs[key];
    if (cached && !force) return cached;
    const list = await gitHostPrListFor(owner, name, filter);
    set((s) => ({ prs: { ...s.prs, [key]: list } }));
    return list;
  },

  invalidatePrs: (owner, name) => {
    const prefix = `${owner}/${name}:`;
    set((s) => ({
      prs: Object.fromEntries(Object.entries(s.prs).filter(([k]) => !k.startsWith(prefix))),
    }));
  },

  checkAuth: async () => {
    if (!isTauri) {
      set({ signedIn: false, viewer: null });
      return;
    }
    try {
      const token = await gitHostTokenGet('github');
      if (!token) {
        set({ signedIn: false, viewer: null });
        return;
      }
      // A stored token isn't the same as a working one — it can be revoked or
      // expired. `/user` is the cheapest way to find out, and it gives us the
      // login and avatar for the account bar at the same time.
      const v = await gitHostViewer();
      set({
        signedIn: true,
        viewer: { login: v.login, avatarUrl: v.avatar_url, name: v.name },
      });
    } catch {
      // A revoked token, a locked credential vault, and no token at all are
      // all the same thing from here: sign in again.
      set({ signedIn: false, viewer: null });
    }
  },

  setSection: (section) => set({ section }),
  setRepo: (repo) => set({ repo }),
  refreshRateLimit: async () => {
    if (!isTauri) return;
    try {
      set({ rateRemaining: await gitHostRateRemaining() });
    } catch {
      // Not worth surfacing: this only feeds a warning that appears when the
      // budget runs low, and the real requests report their own failures.
      set({ rateRemaining: null });
    }
  },

  signOut: async () => {
    if (isTauri) {
      await gitHostTokenDelete('github').catch(() => {
        /* already gone, or the vault is unavailable — the view resets either way */
      });
    }
    set({ signedIn: false, viewer: null, repo: null, rateRemaining: null, prs: {} });
  },
}));
