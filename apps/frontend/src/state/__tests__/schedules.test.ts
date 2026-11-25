import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule } from '../../lib/schedules';

const launched: { agent: string; cwd: string; prompt: string }[] = [];
const notified: { title: string; tone?: string }[] = [];
let installed: [string, string][] = [['claude', 'Claude Code']];

vi.mock('../acpAgents', () => ({
  agentLabel: (a: string) => (a === 'claude' ? 'Claude Code' : a),
  availableAgents: async () => installed,
  launchAgentWindow: async (o: {
    agent: string;
    cwd: string;
    prompt: string;
    onOpen?: (id: string) => void;
  }) => {
    launched.push(o);
    o.onOpen?.('tab-1');
    return 'tab-1';
  },
}));
vi.mock('../../lib/notifyEvent', () => ({
  notifyEvent: (n: { title: string; tone?: string }) => void notified.push(n),
}));
vi.mock('../../lib/tauri', async (orig) => ({
  ...(await orig<typeof import('../../lib/tauri')>()),
  gitRoot: async () => null,
}));

const { useSchedules, runDue } = await import('../schedules');

const schedule = (patch: Partial<Schedule> = {}): Schedule => ({
  id: 's1',
  name: 'nightly lint',
  agent: 'claude',
  prompt: 'fix lint',
  cwd: '/r',
  worktree: true,
  timing: { kind: 'interval', minutes: 60 },
  paused: false,
  createdAt: 0,
  lastRunAt: null,
  lastError: null,
  ...patch,
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('scheduled runs', () => {
  beforeEach(() => {
    launched.length = 0;
    notified.length = 0;
    installed = [['claude', 'Claude Code']];
    useSchedules.setState({ schedules: [], runs: {} });
  });

  it('runs what is due, in its folder when it is not a git repo, and remembers the window', async () => {
    useSchedules.getState().save(schedule());
    runDue(2 * 60 * 60_000);
    await settle();
    expect(launched).toEqual([
      expect.objectContaining({ agent: 'claude', cwd: '/r', prompt: 'fix lint' }),
    ]);
    expect(useSchedules.getState().runs).toEqual({ 'tab-1': 's1' });
    expect(useSchedules.getState().schedules[0]!.lastRunAt).toBeGreaterThan(0);
  });

  it("doesn't start a run twice while it is starting, or run a paused schedule", async () => {
    useSchedules.getState().save(schedule());
    useSchedules.getState().save(schedule({ id: 's2', paused: true }));
    runDue(2 * 60 * 60_000);
    runDue(2 * 60 * 60_000);
    await settle();
    expect(launched).toHaveLength(1);
  });

  it('records and announces a run that could not start', async () => {
    installed = [];
    useSchedules.getState().save(schedule());
    await useSchedules.getState().runNow('s1');
    const s = useSchedules.getState().schedules[0]!;
    expect(s.lastError).toBe("Claude Code isn't installed.");
    // Stamped anyway, so it waits for its next time instead of retrying every tick.
    expect(s.lastRunAt).not.toBeNull();
    expect(notified[0]).toMatchObject({
      title: "Scheduled run “nightly lint” couldn't start",
      tone: 'error',
    });
  });

  it('edits replace and deletes remove', () => {
    const { save, remove, setPaused } = useSchedules.getState();
    save(schedule());
    save(schedule({ name: 'renamed' }));
    setPaused('s1', true);
    expect(useSchedules.getState().schedules).toEqual([
      expect.objectContaining({ name: 'renamed', paused: true }),
    ]);
    remove('s1');
    expect(useSchedules.getState().schedules).toEqual([]);
  });
});
