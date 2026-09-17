import { describe, expect, it } from 'vitest';
import {
  groupRaceRuns,
  mergeStrategy,
  parseNumstat,
  parseRaceBranch,
  runStatus,
} from '../agentRuns';
import { raceNames } from '../agentRace';
import type { GitWorktreeEntry } from '../tauri';
import type { Tab } from '../../state/workspace';

const wt = (path: string, branch: string | null, is_main = false): GitWorktreeEntry => ({
  path,
  branch,
  is_main,
  head_short: 'abc1234',
  locked: false,
  prunable: false,
});

describe('parseRaceBranch', () => {
  it('reads back what raceNames writes', () => {
    const { branch } = raceNames('arc', 'fix-login', 1_700_000_000_000, 2);
    expect(parseRaceBranch(branch)).toEqual({ runId: `fix-login-${(1_700_000_000_000).toString(36)}`, index: 3 });
  });

  it('ignores branches that are not race runs', () => {
    expect(parseRaceBranch('main')).toBeNull();
    expect(parseRaceBranch('arc/notes')).toBeNull();
    expect(parseRaceBranch(null)).toBeNull();
  });
});

describe('groupRaceRuns', () => {
  const older = raceNames('arc', 'old', 1000, 0).branch;
  const worktrees = [
    wt('C:/repo', 'develop', true),
    wt('C:/x/b', 'arc/task-zz/2'),
    wt('C:/x/a', 'arc/task-zz/1'),
    wt('C:/x/old', older),
    wt('C:/x/other', 'feature/unrelated'),
  ];

  it('groups by race, newest first, runs in launch order', () => {
    const groups = groupRaceRuns(worktrees, {});
    expect(groups.map((g) => g.id)).toEqual(['task-zz', `old-${(1000).toString(36)}`]);
    expect(groups[0]!.runs.map((r) => r.path)).toEqual(['C:/x/a', 'C:/x/b']);
    expect(groups[0]!.repo).toBe('C:/repo');
  });

  it('falls back to the main tree branch and the slug without a record', () => {
    const [g] = groupRaceRuns(worktrees, {});
    expect(g!.baseBranch).toBe('develop');
    expect(g!.label).toBe('task');
    const [m] = groupRaceRuns(worktrees, {
      'task-zz': { goal: 'Fix the task', agent: 'Codex', baseBranch: 'main' },
    });
    expect(m).toMatchObject({ label: 'Fix the task', agent: 'Codex', baseBranch: 'main' });
  });
});

describe('parseNumstat', () => {
  it('sums lines and counts binaries as files', () => {
    const s = parseNumstat('3\t1\tsrc/a.ts\n-\t-\timg.png\n10\t0\tdir with\ttab.txt\n');
    expect(s.insertions).toBe(13);
    expect(s.deletions).toBe(1);
    expect(s.files.map((f) => f.path)).toEqual(['src/a.ts', 'img.png', 'dir with\ttab.txt']);
    expect(s.files[1]!.binary).toBe(true);
  });

  it('is empty for no changes', () => {
    expect(parseNumstat('')).toEqual({ files: [], insertions: 0, deletions: 0 });
  });
});

describe('mergeStrategy', () => {
  it('fast-forwards only when the base has not moved', () => {
    expect(mergeStrategy(2, 0)).toBe('fast-forward');
    expect(mergeStrategy(2, 1)).toBe('merge-commit');
    expect(mergeStrategy(0, 5)).toBe('up-to-date');
  });
});

describe('runStatus', () => {
  const agent = (id: string, launchCwd: string): Tab => ({
    id,
    title: id,
    kind: 'terminal',
    shellOverride: 'claude',
    launchCwd,
  });

  it('matches the tab by checkout, whatever the separator', () => {
    const tabs = [agent('t1', 'C:\\x\\a'), agent('t2', 'C:\\x\\b')];
    expect(runStatus('C:/x/a', tabs, {})).toMatchObject({ status: 'running', tab: { id: 't1' } });
    expect(runStatus('C:/x/b', tabs, { t2: { at: 1 } }).status).toBe('waiting');
    expect(runStatus('C:/x/c', tabs, {}).status).toBe('exited');
  });
});
