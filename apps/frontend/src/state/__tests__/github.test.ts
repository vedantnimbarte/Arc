import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store's only dependency is the tauri bridge. Stub it with mutable
// fixtures so a call can be counted, and so the keychain and /user can be
// made to disagree — which is the case the sign-in gate has to get right.
const calls = { prList: 0, viewer: 0 };
const fixture = {
  token: 'ghp_test' as string | null,
  viewerThrows: false,
  prs: [{ number: 1, title: 'first' }],
};

vi.mock('../../lib/tauri', () => ({
  isTauri: true,
  gitHostTokenGet: async () => fixture.token,
  gitHostTokenDelete: async () => {},
  gitHostViewer: async () => {
    calls.viewer += 1;
    if (fixture.viewerThrows) throw new Error('401 Bad credentials');
    return { login: 'octocat', avatar_url: 'https://x/a.png', name: 'Octo Cat' };
  },
  gitHostPrListFor: async () => {
    calls.prList += 1;
    return fixture.prs;
  },
}));

const { useGitHub, repoKey, splitRepoKey } = await import('../github');

beforeEach(() => {
  calls.prList = 0;
  calls.viewer = 0;
  fixture.token = 'ghp_test';
  fixture.viewerThrows = false;
  fixture.prs = [{ number: 1, title: 'first' }];
  useGitHub.setState({
    signedIn: undefined,
    viewer: null,
    section: 'repos',
    repo: null,
    rateRemaining: null,
    prs: {},
  });
});

describe('repo keys', () => {
  it('round-trips owner and name', () => {
    expect(splitRepoKey(repoKey('octocat', 'Hello-World'))).toEqual({
      owner: 'octocat',
      name: 'Hello-World',
    });
  });

  it('keeps slashes that belong to the name', () => {
    // Splitting on the last slash would mangle these; the store splits on the
    // first, because the owner is always one segment.
    expect(splitRepoKey('owner/some/nested')).toEqual({ owner: 'owner', name: 'some/nested' });
  });

  it('rejects keys that aren\'t owner/name', () => {
    expect(splitRepoKey('just-owner')).toBeNull();
    expect(splitRepoKey('/leading')).toBeNull();
    expect(splitRepoKey('trailing/')).toBeNull();
    expect(splitRepoKey('')).toBeNull();
  });
});

describe('auth check', () => {
  it('signs in when the token works', async () => {
    await useGitHub.getState().checkAuth();
    expect(useGitHub.getState().signedIn).toBe(true);
    expect(useGitHub.getState().viewer?.login).toBe('octocat');
  });

  it('stays signed out when there is no token, without calling the API', async () => {
    fixture.token = null;
    await useGitHub.getState().checkAuth();
    expect(useGitHub.getState().signedIn).toBe(false);
    expect(calls.viewer).toBe(0);
  });

  it('treats a stored-but-rejected token as signed out', async () => {
    // A revoked token is still in the keychain. Trusting its presence would
    // drop the user into a workspace where every request fails.
    fixture.viewerThrows = true;
    await useGitHub.getState().checkAuth();
    expect(useGitHub.getState().signedIn).toBe(false);
    expect(useGitHub.getState().viewer).toBeNull();
  });
});

describe('pull request cache', () => {
  it('serves the second read from cache', async () => {
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open');
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open');
    expect(calls.prList).toBe(1);
  });

  it('keys on the filter, not just the repo', async () => {
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open');
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'closed');
    expect(calls.prList).toBe(2);
  });

  it('refetches when forced', async () => {
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open');
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open', true);
    expect(calls.prList).toBe(2);
  });

  it('drops every filter for a repo on invalidate, and only that repo', async () => {
    // This is what makes merging in the GitHub tab visible in the sidebar's
    // PR sheet: both read this cache, so a stale entry would show a merged PR
    // as still open.
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open');
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'closed');
    await useGitHub.getState().loadPrs('octocat', 'Other', 'open');

    useGitHub.getState().invalidatePrs('octocat', 'Hello-World');

    expect(Object.keys(useGitHub.getState().prs)).toEqual(['octocat/Other:open']);
  });

  it('does not invalidate a repo whose name merely starts the same', async () => {
    await useGitHub.getState().loadPrs('octocat', 'Hello', 'open');
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open');

    useGitHub.getState().invalidatePrs('octocat', 'Hello');

    expect(Object.keys(useGitHub.getState().prs)).toEqual(['octocat/Hello-World:open']);
  });

  it('clears the cache on sign out', async () => {
    await useGitHub.getState().loadPrs('octocat', 'Hello-World', 'open');
    await useGitHub.getState().signOut();
    expect(useGitHub.getState().prs).toEqual({});
    expect(useGitHub.getState().signedIn).toBe(false);
  });
});
