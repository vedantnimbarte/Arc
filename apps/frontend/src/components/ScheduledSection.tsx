import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  FolderOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { fsPickFolder } from '../lib/tauri';
import {
  describeNext,
  describeTiming,
  nextRun,
  parseTime,
  type Schedule,
  type Timing,
} from '../lib/schedules';
import { agentLabel, availableAgents } from '../state/acpAgents';
import { askConfirm } from '../state/confirm';
import { useFiles } from '../state/files';
import { useSchedules } from '../state/schedules';
import { Select } from './Select';

/**
 * The Sessions view's "Scheduled" section: prompts that run an agent on a
 * timer. Each run opens as an agent window and is listed below like any other
 * session.
 */
export function ScheduledSection() {
  const schedules = useSchedules((s) => s.schedules);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const now = useNow();

  return (
    <section className="mb-2">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1.5 font-display text-2xs text-fg-subtle"
          aria-expanded={open}
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Clock size={11} strokeWidth={2} className="text-accent" />
          Scheduled
          <span className="tabular-nums">({schedules.length})</span>
        </button>
        <IconButton Icon={Plus} label="New scheduled prompt" onClick={() => setEditing('new')} />
      </div>

      {open && (
        <ul>
          {editing === 'new' && <ScheduleForm onDone={() => setEditing(null)} />}
          {schedules.length === 0 && editing !== 'new' && (
            <li className="px-3 pb-1 font-display text-2xs leading-relaxed text-fg-subtle">
              Run a prompt on a timer — a nightly lint fix, a morning summary. Runs only while Arc
              is open; one missed while it was closed runs when it opens.
            </li>
          )}
          {schedules.map((s) =>
            editing !== 'new' && editing?.id === s.id ? (
              <ScheduleForm key={s.id} initial={s} onDone={() => setEditing(null)} />
            ) : (
              <ScheduleRow key={s.id} s={s} now={now} onEdit={() => setEditing(s)} />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function ScheduleRow({ s, now, onEdit }: { s: Schedule; now: number; onEdit: () => void }) {
  const { runNow, setPaused, remove } = useSchedules.getState();
  return (
    <li className="group/row relative">
      <div className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 pr-24 hover:bg-surface-2">
        <span className="flex min-w-0 items-baseline gap-1.5 font-display text-xs">
          <span className="shrink-0 text-fg-muted">{agentLabel(s.agent)}</span>
          <span className={cn('min-w-0 truncate', s.paused ? 'text-fg-subtle' : 'text-fg-base')}>
            {s.name}
          </span>
        </span>
        <span
          className="truncate font-mono text-2xs text-fg-subtle"
          title={`${describeTiming(s.timing)} in ${s.cwd}`}
        >
          {describeTiming(s.timing)} · {s.paused ? 'paused' : describeNext(nextRun(s), now)}
        </span>
        {s.lastError && (
          <span className="truncate font-display text-2xs text-status-err" title={s.lastError}>
            Last run failed: {s.lastError}
          </span>
        )}
      </div>
      <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
        <IconButton Icon={Play} label="Run now" onClick={() => void runNow(s.id)} />
        <IconButton
          Icon={s.paused ? Clock : Pause}
          label={s.paused ? 'Resume' : 'Pause'}
          onClick={() => setPaused(s.id, !s.paused)}
        />
        <IconButton Icon={Pencil} label="Edit" onClick={onEdit} />
        <IconButton
          Icon={Trash2}
          label="Delete"
          danger
          onClick={async () => {
            const ok = await askConfirm({
              title: `Delete “${s.name}”?`,
              body: 'It stops running. Windows from earlier runs stay open.',
              confirmLabel: 'Delete',
              destructive: true,
            });
            if (ok) remove(s.id);
          }}
        />
      </div>
    </li>
  );
}

type Kind = Timing['kind'];

function ScheduleForm({ initial, onDone }: { initial?: Schedule; onDone: () => void }) {
  const root = useFiles((s) => s.root);
  const [agents, setAgents] = useState<[string, string][]>([]);
  const [name, setName] = useState(initial?.name ?? '');
  const [agent, setAgent] = useState(initial?.agent ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? root ?? '');
  const [worktree, setWorktree] = useState(initial?.worktree ?? true);
  const [kind, setKind] = useState<Kind>(initial?.timing.kind ?? 'daily');
  const [minutes, setMinutes] = useState(
    initial?.timing.kind === 'interval' ? initial.timing.minutes : 60,
  );
  const [time, setTime] = useState(
    initial?.timing.kind !== 'interval' ? (initial?.timing.time ?? '09:00') : '09:00',
  );

  useEffect(() => {
    void availableAgents().then((a) => {
      setAgents(a);
      setAgent((cur) => cur || a[0]?.[0] || '');
    });
  }, []);

  const timing: Timing =
    kind === 'interval' ? { kind, minutes: Math.max(5, Math.round(minutes) || 5) } : { kind, time };
  const valid =
    name.trim() &&
    prompt.trim() &&
    agent &&
    cwd &&
    (kind === 'interval' || parseTime(time) !== null);

  const submit = () => {
    if (!valid) return;
    // Editing the timing restarts the clock from now, so a change doesn't
    // fire at once because the new time was "missed".
    const timingChanged = JSON.stringify(timing) !== JSON.stringify(initial?.timing);
    useSchedules.getState().save({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      agent,
      prompt: prompt.trim(),
      cwd,
      worktree,
      timing,
      paused: initial?.paused ?? false,
      createdAt: initial && !timingChanged ? initial.createdAt : Date.now(),
      lastRunAt: initial && !timingChanged ? initial.lastRunAt : null,
      lastError: initial?.lastError ?? null,
    });
    onDone();
  };

  const field =
    'w-full rounded-md bg-surface-1 px-2 py-1 font-display text-xs text-fg-base ring-1 ring-edge-1 placeholder:text-fg-subtle focus:outline-none focus:ring-accent/40';

  return (
    <li className="mx-1.5 mb-2 flex flex-col gap-1.5 rounded-md bg-surface-1/60 p-2 ring-1 ring-edge-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name, e.g. Nightly lint fix"
        aria-label="Schedule name"
        className={field}
      />
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder="What should the agent do?"
        aria-label="Prompt"
        className={cn(field, 'resize-none')}
      />
      {agents.length > 0 ? (
        <Select
          size="compact"
          ariaLabel="Agent"
          value={agent}
          options={agents.map(([value, label]) => ({ value, label }))}
          onChange={setAgent}
          className="w-full"
        />
      ) : (
        <p className="font-display text-2xs text-fg-subtle">No chat agent is installed.</p>
      )}
      <div className="flex items-center gap-1">
        <Select
          size="compact"
          ariaLabel="When"
          value={kind}
          options={[
            { value: 'interval' as Kind, label: 'Every…' },
            { value: 'daily' as Kind, label: 'Daily at' },
            { value: 'weekdays' as Kind, label: 'Weekdays at' },
          ]}
          onChange={setKind}
          className="w-auto"
        />
        {kind === 'interval' ? (
          <label className="flex items-center gap-1 font-display text-2xs text-fg-subtle">
            <input
              type="number"
              min={5}
              step={5}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              aria-label="Minutes between runs"
              className={cn(field, 'w-16')}
            />
            min
          </label>
        ) : (
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Time of day"
            className={cn(field, 'w-24')}
          />
        )}
      </div>
      <button
        type="button"
        onClick={async () => {
          const dir = await fsPickFolder(cwd || null);
          if (dir) setCwd(dir);
        }}
        title={cwd || 'Choose the folder runs work in'}
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-left font-mono text-2xs text-fg-muted hover:bg-surface-2"
      >
        <FolderOpen size={11} strokeWidth={2} className="shrink-0" />
        <span className="min-w-0 truncate">{cwd || 'Choose folder…'}</span>
      </button>
      <label className="flex items-center gap-1.5 font-display text-2xs text-fg-muted">
        <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
        Each run in its own git worktree
      </label>
      <div className="flex justify-end gap-1.5">
        <button
          type="button"
          onClick={onDone}
          className="rounded px-2 py-1 font-display text-2xs text-fg-muted hover:text-fg-base"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!valid}
          className="rounded bg-accent-soft px-2 py-1 font-display text-2xs text-fg-base ring-1 ring-accent/45 disabled:opacity-40"
        >
          {initial ? 'Save' : 'Schedule'}
        </button>
      </div>
    </li>
  );
}

function IconButton({
  Icon,
  label,
  onClick,
  danger,
}: {
  Icon: LucideIcon;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        'flex h-6 w-6 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base',
        danger && 'hover:text-status-err',
      )}
    >
      <Icon size={11} strokeWidth={2.2} />
    </button>
  );
}

/** The time, refreshed every 30s, for "in 5m" labels. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
