import { create } from 'zustand';
import { gitRoot, isTauri, sessionSchedulesLoad, sessionSchedulesSave } from '../lib/tauri';
import { createRaceWorktrees } from '../lib/agentRace';
import { notifyEvent } from '../lib/notifyEvent';
import { isDue, parseSchedules, type Schedule } from '../lib/schedules';
import { agentLabel, availableAgents, launchAgentWindow } from './acpAgents';

/**
 * Scheduled agent prompts. Each run opens an agent window behind the current
 * tab, like a helper, so it shows up in the Sessions view and notifies when it
 * finishes. Saved in Arc's SQLite store.
 *
 * Runs only while Arc is open: a check every `TICK_MS`, plus one at launch, so
 * a schedule that came due while Arc was closed runs once when it opens.
 */

const TICK_MS = 30_000;

interface SchedulesState {
  loaded: boolean;
  schedules: Schedule[];
  /** This app session's runs: window tab id → schedule id. */
  runs: Record<string, string>;
  /** Add a schedule, or replace the one with the same id. */
  save: (s: Schedule) => void;
  remove: (id: string) => void;
  setPaused: (id: string, paused: boolean) => void;
  runNow: (id: string) => Promise<void>;
}

/** Schedules starting right now, so a slow start isn't started twice. */
const inFlight = new Set<string>();

export const useSchedules = create<SchedulesState>((set, get) => {
  const patch = (id: string, p: Partial<Schedule>) =>
    set((s) => ({ schedules: s.schedules.map((x) => (x.id === id ? { ...x, ...p } : x)) }));

  return {
    loaded: false,
    schedules: [],
    runs: {},
    save: (s) =>
      set((st) => ({
        schedules: st.schedules.some((x) => x.id === s.id)
          ? st.schedules.map((x) => (x.id === s.id ? s : x))
          : [...st.schedules, s],
      })),
    remove: (id) => set((s) => ({ schedules: s.schedules.filter((x) => x.id !== id) })),
    setPaused: (id, paused) => patch(id, { paused }),
    runNow: async (id) => {
      const s = get().schedules.find((x) => x.id === id);
      if (!s || inFlight.has(id)) return;
      inFlight.add(id);
      // Stamped before starting, so the next tick doesn't see it as still due.
      patch(id, { lastRunAt: Date.now(), lastError: null });
      try {
        await runSchedule(s, (tabId) => set((st) => ({ runs: { ...st.runs, [tabId]: s.id } })));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        patch(id, { lastError: message });
        notifyEvent({
          source: 'agent',
          title: `Scheduled run “${s.name}” couldn't start`,
          body: message,
          tone: 'error',
          target: { kind: 'sidebar', view: 'sessions' },
        });
      } finally {
        inFlight.delete(id);
      }
    },
  };
});

async function runSchedule(s: Schedule, onOpen: (tabId: string) => void): Promise<void> {
  const label = agentLabel(s.agent);
  if (!(await availableAgents()).some(([id]) => id === s.agent)) {
    throw new Error(`${label} isn't installed.`);
  }
  // A folder that isn't a git repo can't have worktrees; the run uses it as is.
  const where =
    s.worktree && (await gitRoot(s.cwd).catch(() => null))
      ? (await createRaceWorktrees(s.cwd, s.name, 1, label))[0]!.path
      : s.cwd;
  await launchAgentWindow({ agent: s.agent, cwd: where, title: s.name, prompt: s.prompt, onOpen });
}

/** Run everything due. Exported for tests; the ticker calls it. */
export function runDue(now = Date.now()): void {
  for (const s of useSchedules.getState().schedules) {
    if (isDue(s, now)) void useSchedules.getState().runNow(s.id);
  }
}

let started = false;

/** Load saved schedules, keep them saved, and start the ticker. Once. */
export async function initSchedules(): Promise<void> {
  if (!isTauri || started) return;
  started = true;
  const schedules = parseSchedules(await sessionSchedulesLoad().catch(() => null));
  useSchedules.setState({ schedules, loaded: true });
  useSchedules.subscribe((s, prev) => {
    if (s.schedules !== prev.schedules) {
      void sessionSchedulesSave(JSON.stringify(s.schedules)).catch(() => {});
    }
  });
  // Catch up on anything that came due while Arc was closed, then keep time.
  runDue();
  setInterval(runDue, TICK_MS);
}
