import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store's only dependency is the tauri bridge; stub it with a mutable
// fixture so a "refresh" can return identical or changed results on demand.
const fixture = {
  entries: [{ path: 'a.ts', kind: 'changes', status: 'M' }],
};

vi.mock('../../lib/tauri', () => ({
  gitStatus: async () => ({ branch: 'main', dirty: true }),
  gitChanges: async () => fixture.entries,
  gitDiffStat: async () => null,
  gitRoot: async () => '/repo',
}));

const { useGit, __resetGitSnapshotForTests } = await import('../git');

describe('git store refresh', () => {
  beforeEach(() => {
    __resetGitSnapshotForTests();
    useGit.getState().reset();
    fixture.entries = [{ path: 'a.ts', kind: 'changes', status: 'M' }];
  });

  it('keeps state identity when nothing changed', async () => {
    await useGit.getState().refresh('/repo');
    const first = useGit.getState();

    await useGit.getState().refresh('/repo', { background: true });
    const second = useGit.getState();

    // Same objects => no re-render in SourceControl or the file tree, which
    // is what stopped the panel flickering on every watcher event.
    expect(second.entries).toBe(first.entries);
    expect(second.statusByPath).toBe(first.statusByPath);
  });

  it('publishes new state when the changes differ', async () => {
    await useGit.getState().refresh('/repo');
    const first = useGit.getState().entries;

    fixture.entries = [{ path: 'b.ts', kind: 'untracked', status: '?' }];
    await useGit.getState().refresh('/repo', { background: true });

    expect(useGit.getState().entries).not.toBe(first);
    expect(useGit.getState().entries[0]?.path).toBe('b.ts');
  });

  it('does not flip loading for a background refresh', async () => {
    await useGit.getState().refresh('/repo');
    const seen: boolean[] = [];
    const unsub = useGit.subscribe((s) => seen.push(s.loading));

    const p = useGit.getState().refresh('/repo', { background: true });
    expect(useGit.getState().loading).toBe(false);
    await p;
    unsub();

    expect(seen.every((l) => l === false)).toBe(true);
  });
});
