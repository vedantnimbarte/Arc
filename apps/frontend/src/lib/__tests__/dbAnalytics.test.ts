import { describe, expect, it } from 'vitest';
import { DIALECTS, formatBytes, parseCounters, point } from '../dbAnalytics';

const res = (columns: string[], rows: Array<Array<string | null>>) => ({
  columns,
  rows,
  rows_affected: 0,
  duration_ms: 0,
  truncated: false,
});

describe('parseCounters', () => {
  it('reads MySQL SHOW STATUS rows into shared keys and derives idle', () => {
    const c = parseCounters(
      'mysql',
      res(['Variable_name', 'Value'], [['Threads_connected', '7'], ['Threads_running', '2'], ['Com_commit', '40']]),
    );
    expect(c).toMatchObject({ total: 7, active: 2, idle: 5, commits: 40 });
  });

  it('reads the Postgres wide row', () => {
    expect(parseCounters('postgres', res(['commits', 'rollbacks'], [['10', null]]))).toEqual({ commits: 10 });
  });
});

describe('point', () => {
  const tx = DIALECTS.postgres.charts.find((c) => c.title === 'Transactions')!;
  const sessions = DIALECTS.postgres.charts.find((c) => c.title === 'Sessions')!;

  it('turns counter deltas into per-second rates, clamping resets to 0', () => {
    expect(point(tx, null, { commits: 5 }, 2)).toBeNull();
    expect(point(tx, { commits: 10, rollbacks: 4 }, { commits: 30, rollbacks: 1 }, 2)).toEqual([10, 0]);
  });

  it('draws gauges as-is', () => {
    expect(point(sessions, null, { total: 3, active: 1, idle: 2 }, 0)).toEqual([3, 1, 2]);
  });
});

it('formatBytes', () => {
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(1536)).toBe('1.5 KB');
  expect(formatBytes(50 * 1024 ** 3)).toBe('50 GB');
});
