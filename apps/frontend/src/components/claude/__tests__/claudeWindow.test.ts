import { describe, expect, it } from 'vitest';
import { groupByDate } from '../ClaudeHistoryRail';
import { mentionAt } from '../ClaudeComposer';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
const meta = (id: string, updatedAt: number) => ({ id, title: id, firstPrompt: null, updatedAt });

describe('groupByDate', () => {
  it('buckets by local calendar day, dropping empty groups', () => {
    const now = new Date(2026, 9, 1, 9); // Oct 1, 09:00
    const groups = groupByDate(
      [
        meta('this-morning', at(2026, 9, 1, 0)),
        meta('last-night', at(2026, 8, 30, 23)),
        meta('last-week', at(2026, 8, 25)),
        meta('long-ago', at(2026, 5, 1)),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['this-morning']],
      ['Yesterday', ['last-night']],
      ['Last 7 days', ['last-week']],
      ['Older', ['long-ago']],
    ]);
    expect(groupByDate([meta('x', at(2026, 9, 1))], now).map((g) => g.label)).toEqual(['Today']);
  });
});

describe('mentionAt', () => {
  it('finds the @query right before the caret', () => {
    expect(mentionAt('fix @src/Ta', 11)).toEqual({ start: 4, query: 'src/Ta' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('ignores emails and finished mentions', () => {
    expect(mentionAt('mail me@x.dev', 13)).toBeNull();
    expect(mentionAt('see @a.ts now', 13)).toBeNull();
  });
});
