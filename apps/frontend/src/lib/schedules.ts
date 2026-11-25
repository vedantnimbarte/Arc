/**
 * Scheduled agent prompts: the model and the timing math, kept pure so the
 * "when is it due" rules are testable without a clock or a UI.
 *
 * Timing is three presets rather than cron. Times are local wall-clock.
 */

export type Timing =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string };

export interface Schedule {
  id: string;
  name: string;
  /** `claude` or an ACP agent's CLI id. */
  agent: string;
  prompt: string;
  /** Folder the run works in. */
  cwd: string;
  /** Give each run its own git worktree, so it can't collide with work in
   *  progress in `cwd`. */
  worktree: boolean;
  timing: Timing;
  paused: boolean;
  createdAt: number;
  lastRunAt: number | null;
  /** Why the last run couldn't start, if it couldn't. */
  lastError: string | null;
}

const MINUTE = 60_000;

/** `HH:MM` → minutes past midnight, or null when malformed. */
export function parseTime(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * When this schedule next fires (ms): the first time after its last run (or
 * its creation). Interval schedules add the interval; clock schedules take the
 * next matching wall-clock time. In the past means due.
 */
export function nextRun(s: Pick<Schedule, 'timing' | 'createdAt' | 'lastRunAt'>): number {
  const base = s.lastRunAt ?? s.createdAt;
  const t = s.timing;
  if (t.kind === 'interval') return base + Math.max(1, t.minutes) * MINUTE;
  const at = parseTime(t.time) ?? 9 * 60;
  const d = new Date(base);
  d.setSeconds(0, 0);
  d.setHours(Math.floor(at / 60), at % 60);
  // Up to a week ahead covers a weekday schedule starting on a Friday night.
  for (let i = 0; i < 8; i++) {
    const weekday = d.getDay() >= 1 && d.getDay() <= 5;
    if (d.getTime() > base && (t.kind === 'daily' || weekday)) return d.getTime();
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

/**
 * Whether a schedule should run now. A schedule whose time passed while Arc
 * was closed is due once — running it moves `lastRunAt` to now, so missed
 * runs never pile up into a backlog.
 */
export function isDue(s: Schedule, now: number): boolean {
  return !s.paused && nextRun(s) <= now;
}

export function describeTiming(t: Timing): string {
  switch (t.kind) {
    case 'interval':
      return t.minutes % 60 === 0
        ? `Every ${t.minutes / 60 === 1 ? 'hour' : `${t.minutes / 60} hours`}`
        : `Every ${t.minutes} min`;
    case 'daily':
      return `Daily at ${t.time}`;
    case 'weekdays':
      return `Weekdays at ${t.time}`;
  }
}

/** "in 5m", "in 3h", "tomorrow 09:00", or a date for anything further. */
export function describeNext(at: number, now: number): string {
  const mins = Math.round((at - now) / MINUTE);
  if (mins <= 0) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 12 * 60) return `in ${Math.round(mins / 60)}h`;
  const d = new Date(at);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (d.toDateString() === new Date(now).toDateString()) return `today ${hhmm}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${hhmm}`;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`;
}

/** Schedules from stored JSON, dropping anything that isn't one. */
export function parseSchedules(json: string | null): Schedule[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v)
      ? (v as Schedule[]).filter((s) => s && typeof s.id === 'string' && s.timing)
      : [];
  } catch {
    return [];
  }
}
