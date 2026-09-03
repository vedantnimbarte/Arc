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

const { useGit, isIgnoredPath, __resetGitSnapshotForTests } = await import('../git');

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

  it('keeps ignored paths out of entries and dims everything beneath them', async () => {
    fixture.entries = [
      { path: 'src/a.ts', kind: 'unstaged', status: 'M' },
      { path: 'node_modules/', kind: 'ignored', status: '!' },
    ];
    await useGit.getState().refresh('/repo');
    const s = useGit.getState();

    // SourceControl must not see a "change" it can't stage.
    expect(s.entries.map((e) => e.path)).toEqual(['src/a.ts']);
    // One collapsed record dims the whole subtree.
    expect(isIgnoredPath('/repo/node_modules/pkg/index.js', s.ignoredPaths)).toBe(true);
    expect(isIgnoredPath('/repo/src/a.ts', s.ignoredPaths)).toBe(false);
  });

  it('rolls the loudest change up onto the folder', async () => {
    fixture.entries = [
      { path: 'src/new.ts', kind: 'untracked', status: '?' },
      { path: 'src/old.ts', kind: 'unstaged', status: 'M' },
    ];
    await useGit.getState().refresh('/repo');

    // Untracked comes first but a tracked edit outranks it, so the folder
    // reads as modified rather than new.
    expect(useGit.getState().dirtyDirs.get('/repo/src')?.status).toBe('M');
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
