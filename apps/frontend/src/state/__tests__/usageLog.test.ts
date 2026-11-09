import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_LOG,
  addEntries,
  claudeUsageRecorder,
  dayKey,
  entriesFromHistory,
  summarize,
  useUsageLog,
  type UsageEntry,
} from '../usageLog';

const NOON = new Date(2026, 10, 9, 12).getTime();

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    at: NOON,
    source: 'claude',
    model: 'sonnet',
    sessionId: 's1',
    cwd: '/repo',
    input: 100,
    output: 50,
    cacheWrite: 0,
    cacheRead: 0,
    costUsd: 0.01,
    ...overrides,
  };
}

describe('addEntries', () => {
  it('merges turns of the same day, model and session into one bucket', () => {
    const log = addEntries(EMPTY_LOG, [entry(), entry({ costUsd: 0.02 })]);
    expect(log.buckets).toHaveLength(1);
    expect(log.buckets[0]).toMatchObject({ turns: 2, input: 200, output: 100 });
    expect(log.buckets[0]!.costUsd).toBeCloseTo(0.03);
  });

  it('keeps separate buckets per model and per day', () => {
    const log = addEntries(EMPTY_LOG, [
      entry(),
      entry({ model: 'opus' }),
      entry({ at: NOON - 86_400_000 }),
    ]);
    expect(log.buckets).toHaveLength(3);
  });

  it('leaves cost null when no entry reports one', () => {
    const log = addEntries(EMPTY_LOG, [entry({ costUsd: null }), entry({ costUsd: null })]);
    expect(log.buckets[0]!.costUsd).toBeNull();
  });
});

describe('entriesFromHistory', () => {
  const row = (id: string) => ({
    id,
    timestamp: '2026-11-09T10:00:00.000Z',
    model: 'claude-sonnet-4',
    session_id: 'abc',
    cwd: '/repo',
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 3,
  });

  it('counts each assistant message once even when the CLI repeats it', () => {
    const entries = entriesFromHistory([row('m1'), row('m1'), row('m2'), { ...row('m3'), timestamp: 'bad' }]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ input: 10, output: 5, cacheRead: 3, costUsd: null, source: 'claude-history' });
  });
});

describe('summarize', () => {
  it('zero-fills the activity window and ranks models by tokens', () => {
    const log = addEntries(EMPTY_LOG, [
      entry({ model: 'opus', input: 1000 }),
      entry({ model: 'sonnet', input: 10 }),
    ]);
    const summary = summarize(log, 7, NOON);
    expect(summary.byDay).toHaveLength(7);
    expect(summary.byDay[6]).toEqual({ day: dayKey(NOON), tokens: 1110 });
    expect(summary.byDay[0]!.tokens).toBe(0);
    expect(summary.byModel.map((m) => m.model)).toEqual(['opus', 'sonnet']);
    expect(summary.sessions).toBe(1);
    expect(summary.costUsd).toBeCloseTo(0.02);
  });
});

describe('claudeUsageRecorder', () => {
  beforeEach(() => {
    useUsageLog.setState({ log: EMPTY_LOG, loaded: true, importing: false, importError: null });
  });

  it('records the turn totals and cost when the result line arrives', () => {
    const record = claudeUsageRecorder({ cwd: '/repo', model: 'opus' });
    record({ kind: 'text_delta', payload: { text: 'hi' } });
    record({ kind: 'usage', payload: { usage: { input_tokens: 40, output_tokens: 7 } } });
    record({ kind: 'result', payload: { session_id: 's9', cost_usd: 0.5 } });
    const [bucket] = useUsageLog.getState().log.buckets;
    expect(bucket).toMatchObject({ model: 'opus', sessionId: 's9', input: 40, output: 7, costUsd: 0.5 });
  });
});
