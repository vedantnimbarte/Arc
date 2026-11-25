import { AI_CLIS, type AiCliId, type WingmanCard } from './tauri';
import { samePath, type RaceGroup } from './agentRuns';
import type { Tab } from '../state/workspace';
import type { ChatSnapshot, ChatSurface, SessionStatus } from '../state/agentSessions';

/**
 * The Sessions view's rows: every agent ARC knows about, from wherever it runs,
 * flattened into one shape. Pure, so the joins (a race run's branch on its
 * terminal tab, a run with no tab left) are testable without a UI.
 */
export interface SessionRow {
  key: string;
  agent: string;
  title: string;
  /** Folder or branch it works in. */
  where: string;
  status: SessionStatus;
  /** When it entered `status`; 0 when unknown. */
  at: number;
  costUsd?: number;
  /** One line on why it's in its group: what it's asking, how far it got. */
  detail?: string;
  source:
    | { kind: 'chat'; key: string; surface: ChatSurface }
    | { kind: 'terminal'; tabId: string }
    | { kind: 'race'; path: string }
    | { kind: 'wingman'; cardId: string };
}

function basename(p: string | null | undefined): string {
  return p
    ? (p
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .pop() ?? p)
    : '';
}

export function chatRows(snaps: Readonly<Record<string, ChatSnapshot>>): SessionRow[] {
  return Object.values(snaps).flatMap((s) =>
    s.status
      ? [
          {
            key: s.key,
            agent: s.agent,
            title: s.title || 'Conversation',
            where: basename(s.cwd),
            status: s.status,
            at: s.at,
            costUsd: s.costUsd || undefined,
            detail: s.detail || undefined,
            source: { kind: 'chat', key: s.key, surface: s.surface },
          } satisfies SessionRow,
        ]
      : [],
  );
}

/** Agent CLIs in terminal tabs. A tab started in a race worktree shows the
 *  run's branch rather than the folder. */
export function terminalRows(
  tabs: readonly Tab[],
  waiting: Readonly<Record<string, { reason: string; at: number }>>,
  exited: Readonly<Record<string, number>>,
  races: readonly RaceGroup[],
): SessionRow[] {
  return tabs
    .filter((t) => t.kind === 'terminal' && t.shellOverride && t.agentCliId)
    .map((t) => {
      const run = races.flatMap((g) => g.runs).find((r) => samePath(r.path, t.launchCwd));
      const status: SessionStatus = exited[t.id] ? 'done' : waiting[t.id] ? 'waiting' : 'working';
      return {
        key: `terminal:${t.id}`,
        agent: AI_CLIS[t.agentCliId as AiCliId] ?? t.agentCliId!,
        title: t.title,
        where: run?.branch ?? basename(t.launchCwd ?? t.cwd),
        status,
        at: exited[t.id] ?? waiting[t.id]?.at ?? 0,
        detail: status === 'waiting' ? waiting[t.id]!.reason : undefined,
        source: { kind: 'terminal', tabId: t.id },
      };
    });
}

/** Race runs whose agent tab is gone, from races started since `since`. Runs
 *  with a live tab already appear as that tab's row. */
export function raceRows(
  races: readonly RaceGroup[],
  tabs: readonly Tab[],
  since: number,
): SessionRow[] {
  return races
    .filter((g) => (g.createdAt ?? 0) >= since)
    .flatMap((g) =>
      g.runs
        .filter((r) => !r.prunable)
        .filter((r) => !tabs.some((t) => t.shellOverride && samePath(t.launchCwd, r.path)))
        .map((r) => ({
          key: `race:${r.path}`,
          agent: g.agent ?? 'Agent',
          title: g.label,
          where: r.branch,
          status: 'done' as const,
          at: g.createdAt ?? 0,
          detail: `Run ${r.index} of ${g.runs.length} — compare in Agent Runs`,
          source: { kind: 'race' as const, path: r.path },
        })),
    );
}

/** Wingman runs in flight or awaiting review, and those finished since
 *  `since`. Cards that never ran are planning, not sessions. */
export function wingmanRows(cards: readonly WingmanCard[], since: number): SessionRow[] {
  return cards.flatMap((c) => {
    if (c.archived || !c.run_id || !c.rollup) return [];
    const r = c.rollup;
    const created = Date.parse(c.created_at ?? '') || 0;
    let status: SessionStatus;
    if (c.column === 'in_progress') status = r.blocked > 0 ? 'waiting' : 'working';
    else if (c.column === 'review') status = 'waiting';
    else if (c.column === 'done' && created >= since) status = 'done';
    else return [];
    return [
      {
        key: `wingman:${c.id}`,
        agent: 'Wingman',
        title: c.title || c.goal || 'Wingman run',
        where: c.project_name ?? c.project,
        status,
        at: created,
        costUsd: r.usd || undefined,
        detail:
          c.column === 'review'
            ? `Ready for review · ${r.done}/${r.total} tasks`
            : r.blocked > 0
              ? `${r.blocked} blocked · ${r.done}/${r.total} tasks`
              : `${r.done}/${r.total} tasks`,
        source: { kind: 'wingman', cardId: c.id },
      },
    ];
  });
}

/** Rows by status. Waiting oldest first (it's waited longest), the rest
 *  newest first. */
export function groupRows(rows: readonly SessionRow[]): Record<SessionStatus, SessionRow[]> {
  const by = (s: SessionStatus) => rows.filter((r) => r.status === s);
  return {
    waiting: by('waiting').sort((a, b) => a.at - b.at),
    working: by('working').sort((a, b) => b.at - a.at),
    done: by('done').sort((a, b) => b.at - a.at),
  };
}
