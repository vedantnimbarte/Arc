import { describe, expect, it } from 'vitest';
import {
  describeNext,
  describeTiming,
  isDue,
  nextRun,
  parseSchedules,
  parseTime,
  type Schedule,
} from '../schedules';

// Local wall-clock times; 25 Nov 2026 is a Wednesday.
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();

const schedule = (patch: Partial<Schedule>): Schedule => ({
  id: 's',
  name: 'nightly lint',
  agent: 'claude',
  prompt: 'fix lint',
  cwd: '/r',
  worktree: true,
  timing: { kind: 'daily', time: '09:00' },
  paused: false,
  createdAt: at(25, 8),
  lastRunAt: null,
  lastError: null,
  ...patch,
});

describe('next run', () => {
  it('counts intervals from the last run, or creation', () => {
    const s = schedule({ timing: { kind: 'interval', minutes: 30 } });
    expect(nextRun(s)).toBe(at(25, 8, 30));
    expect(nextRun({ ...s, lastRunAt: at(25, 10) })).toBe(at(25, 10, 30));
  });

  it('takes the next matching clock time after the last run', () => {
    expect(nextRun(schedule({}))).toBe(at(25, 9));
    // Already ran today at 09:00: next is tomorrow.
    expect(nextRun(schedule({ lastRunAt: at(25, 9) }))).toBe(at(26, 9));
  });

  it('skips the weekend for weekday schedules', () => {
    const s = schedule({ timing: { kind: 'weekdays', time: '09:00' }, lastRunAt: at(27, 9) });
    expect(nextRun(s)).toBe(at(30, 9)); // Friday → Monday
  });
});

describe('due', () => {
  it('runs a missed schedule once, not once per missed day', () => {
    // Last ran Monday; Arc was closed until Thursday afternoon.
    const s = schedule({ lastRunAt: at(23, 9) });
    expect(isDue(s, at(26, 15))).toBe(true);
    // Running it stamps now, after which it waits for the next 09:00.
    expect(isDue({ ...s, lastRunAt: at(26, 15) }, at(26, 16))).toBe(false);
    expect(nextRun({ ...s, lastRunAt: at(26, 15) })).toBe(at(27, 9));
  });

  it('never fires while paused', () => {
    expect(isDue(schedule({ paused: true }), at(30, 12))).toBe(false);
  });
});

describe('text', () => {
  it('reads timings and next runs plainly', () => {
    expect(describeTiming({ kind: 'interval', minutes: 45 })).toBe('Every 45 min');
    expect(describeTiming({ kind: 'interval', minutes: 60 })).toBe('Every hour');
    expect(describeTiming({ kind: 'interval', minutes: 180 })).toBe('Every 3 hours');
    expect(describeTiming({ kind: 'weekdays', time: '09:30' })).toBe('Weekdays at 09:30');
    expect(describeNext(at(25, 10, 5), at(25, 10))).toBe('in 5m');
    expect(describeNext(at(26, 9), at(25, 20))).toBe('tomorrow 09:00');
    expect(describeNext(at(25, 9), at(25, 10))).toBe('due now');
  });

  it('parses times and stored data defensively', () => {
    expect(parseTime('9:05')).toBe(545);
    expect(parseTime('24:00')).toBeNull();
    expect(parseSchedules('not json')).toEqual([]);
    expect(parseSchedules(JSON.stringify([schedule({}), { nope: 1 }]))).toHaveLength(1);
  });
});
