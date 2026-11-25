import { describe, expect, it } from 'vitest';
import { groupRows, raceRows, terminalRows, wingmanRows, type SessionRow } from '../sessionRows';
import type { RaceGroup } from '../agentRuns';
import type { Tab } from '../../state/workspace';
import type { WingmanCard } from '../tauri';

const agentTab = (id: string, extra: Partial<Tab> = {}): Tab =>
  ({
    id,
    title: `tab ${id}`,
    kind: 'terminal',
    shellOverride: '/bin/codex',
    agentCliId: 'codex-cli',
    cwd: '/r/app',
    ...extra,
  }) as Tab;

const race: RaceGroup = {
  id: 'r',
  label: 'fix lint',
  agent: 'OpenAI Codex',
  baseBranch: 'main',
  repo: '/r/app',
  createdAt: 1000,
  runs: [
    { index: 1, branch: 'arc/fix-lint/1', path: 'C:\\r\\.arc-agents\\1', prunable: false },
    { index: 2, branch: 'arc/fix-lint/2', path: 'C:\\r\\.arc-agents\\2', prunable: false },
  ],
} as RaceGroup;

describe('terminal agent rows', () => {
  it('reads status from waiting and exited, and names a race run by its branch', () => {
    const rows = terminalRows(
      [
        agentTab('a'),
        agentTab('b', { launchCwd: 'C:/r/.arc-agents/1' }),
        agentTab('c'),
        { id: 'plain', title: 'shell', kind: 'terminal' } as Tab,
      ],
      { b: { reason: 'Codex is waiting', at: 5 } },
      { c: 9 },
      [race],
    );
    expect(rows.map((r) => [r.key, r.status, r.where])).toEqual([
      ['terminal:a', 'working', 'app'],
      ['terminal:b', 'waiting', 'arc/fix-lint/1'],
      ['terminal:c', 'done', 'app'],
    ]);
    expect(rows[1]!.detail).toBe('Codex is waiting');
    expect(rows[0]!.agent).toBe('OpenAI Codex');
  });
});

describe('race rows', () => {
  it('lists only runs whose agent tab is gone, from races started since', () => {
    const tabs = [agentTab('b', { launchCwd: 'C:/r/.arc-agents/1' })];
    expect(raceRows([race], tabs, 0).map((r) => r.where)).toEqual(['arc/fix-lint/2']);
    expect(raceRows([race], tabs, 2000)).toEqual([]);
  });
});

describe('wingman rows', () => {
  const card = (column: WingmanCard['column'], extra: Partial<WingmanCard['rollup']> = {}) =>
    ({
      id: column,
      title: `t-${column}`,
      project: 'p',
      project_name: 'App',
      column,
      archived: false,
      run_id: 'run',
      created_at: '1970-01-01T00:00:05Z',
      rollup: { status: null, total: 4, done: 2, failed: 0, blocked: 0, usd: 0.5, ...extra },
    }) as unknown as WingmanCard;

  it('maps columns to statuses and skips cards that never ran', () => {
    const rows = wingmanRows(
      [
        card('in_progress'),
        card('review'),
        card('done'),
        card('backlog'),
        { ...card('planned'), run_id: null } as WingmanCard,
      ],
      0,
    );
    expect(rows.map((r) => [r.title, r.status])).toEqual([
      ['t-in_progress', 'working'],
      ['t-review', 'waiting'],
      ['t-done', 'done'],
    ]);
    expect(rows[0]!.detail).toBe('2/4 tasks');
  });

  it('flags a blocked run as waiting, and hides old finished runs', () => {
    expect(wingmanRows([card('in_progress', { blocked: 1 })], 0)[0]!.status).toBe('waiting');
    expect(wingmanRows([card('done')], 10_000)).toEqual([]);
  });
});

describe('grouping', () => {
  it('puts the longest wait first and the newest work first', () => {
    const row = (key: string, status: SessionRow['status'], at: number) =>
      ({ key, status, at }) as SessionRow;
    const g = groupRows([
      row('w1', 'waiting', 20),
      row('w2', 'waiting', 10),
      row('d1', 'done', 1),
      row('d2', 'done', 5),
    ]);
    expect(g.waiting.map((r) => r.key)).toEqual(['w2', 'w1']);
    expect(g.done.map((r) => r.key)).toEqual(['d2', 'd1']);
    expect(g.working).toEqual([]);
  });
});
