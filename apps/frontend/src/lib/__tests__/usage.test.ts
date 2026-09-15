import { describe, expect, it } from 'vitest';
import { formatReset, parsePlanLimits, parseUsage, totalCost } from '../usage';

describe('parseUsage', () => {
  it('reads ccusage-shaped output under a totals key', () => {
    const out = JSON.stringify({
      totals: { totalCost: 42.184, inputTokens: 12480331, outputTokens: 892104 },
      daily: [{ date: '2026-09-01' }],
    });
    const summary = parseUsage(out);
    expect(summary.json).toBe(true);
    expect(summary.rows).toContainEqual({ label: 'Total Cost', value: '$42.18' });
    expect(summary.rows).toContainEqual({ label: 'Input Tokens', value: '12,480,331' });
    // Arrays are not summarized into rows/groups, but stay in raw.
    expect(summary.groups).toEqual([]);
    expect(summary.raw).toBe(out);
  });

  it('falls back to the root object when there is no totals/summary key', () => {
    const out = JSON.stringify({ cost_usd: 3.5, tokens: 1000 });
    const summary = parseUsage(out);
    expect(summary.rows).toContainEqual({ label: 'Cost Usd', value: '$3.50' });
    expect(summary.rows).toContainEqual({ label: 'Tokens', value: '1,000' });
  });

  it('turns each nested plain-object field into its own group', () => {
    const out = JSON.stringify({
      totalCost: 10,
      opus: { cost: 7, tokens: 100 },
      sonnet: { cost: 3 },
    });
    const summary = parseUsage(out);
    expect(summary.rows).toEqual([{ label: 'Total Cost', value: '$10.00' }]);
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups.find((g) => g.title === 'Opus')?.rows).toEqual([
      { label: 'Cost', value: '$7.00' },
      { label: 'Tokens', value: '100' },
    ]);
    expect(summary.groups.find((g) => g.title === 'Sonnet')?.rows).toEqual([
      { label: 'Cost', value: '$3.00' },
    ]);
  });

  it('shows raw text as-is when stdout is not JSON', () => {
    const summary = parseUsage('total: $12.34\n');
    expect(summary.json).toBe(false);
    expect(summary.rows).toEqual([]);
    expect(summary.raw).toBe('total: $12.34\n');
  });

  it('treats an empty or whitespace-only command output as non-JSON', () => {
    expect(parseUsage('').json).toBe(false);
    expect(parseUsage('   \n').json).toBe(false);
  });

  it('treats a JSON array or primitive as non-JSON for summary purposes', () => {
    expect(parseUsage('[1,2,3]').json).toBe(false);
    expect(parseUsage('42').json).toBe(false);
  });
});

describe('parsePlanLimits', () => {
  it('labels session, weekly, and model-scoped limits', () => {
    const body = JSON.stringify({
      limits: [
        { kind: 'session', group: 'session', percent: 4, severity: 'normal', resets_at: '2026-09-14T21:50:00Z', scope: null },
        { kind: 'weekly_all', group: 'weekly', percent: 32, severity: 'warning', resets_at: null, scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 120, severity: 'bogus', scope: { model: { display_name: 'Fable' } } },
        { kind: 'broken' },
      ],
    });
    const [session, week, fable, ...rest] = parsePlanLimits(body);
    expect(session).toMatchObject({ label: 'Current session', percent: 4, windowMs: 5 * 3_600_000 });
    expect(session!.resetsAt).toBe(Date.parse('2026-09-14T21:50:00Z'));
    expect(week).toMatchObject({ label: 'All models this week', severity: 'warning', resetsAt: null });
    expect(fable).toMatchObject({ label: 'Fable this week', percent: 100, severity: 'normal' });
    expect(rest).toEqual([]);
    expect(parsePlanLimits('not json')).toEqual([]);
  });

  it('formats resets relative inside a day', () => {
    const now = 0;
    expect(formatReset(now + 3 * 3_600_000 + 12 * 60_000, now)).toBe('Resets in 3h 12m');
    expect(formatReset(now + 59 * 60_000 + 30_000, now)).toBe('Resets in 1h 0m');
    expect(formatReset(now + 5 * 60_000, now)).toBe('Resets in 5m');
  });
});

describe('totalCost', () => {
  it('sums the cost row of each loaded agent and counts contributors', () => {
    const claude = parseUsage('{"totals":{"inputTokens":10,"totalCost":1.25}}');
    const codex = parseUsage('{"costUSD":2.5}');
    const noCost = parseUsage('{"tokens":7}');
    expect(totalCost([claude, codex, noCost, null])).toEqual({ usd: 3.75, counted: 2 });
  });
});
