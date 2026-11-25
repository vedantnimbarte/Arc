import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  CircleCheck,
  CircleDot,
  FileDiff,
  MessageSquare,
  RefreshCw,
  Square,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '../lib/cn';
import { gitWorktreeList, ptyKill, ptyWrite } from '../lib/tauri';
import { groupRaceRuns, loadRaceMeta, type RaceGroup } from '../lib/agentRuns';
import {
  chatRows,
  groupRows,
  raceRows,
  terminalRows,
  wingmanRows,
  type SessionRow,
} from '../lib/sessionRows';
import { getTerminal } from '../lib/terminalRegistry';
import { chatStore, focusChat, useChatSessions, type SessionStatus } from '../state/agentSessions';
import { useAgentRun } from '../state/agentRun';
import { askConfirm } from '../state/confirm';
import { useFiles } from '../state/files';
import { useWingman } from '../state/wingman';
import { useWorkspace } from '../state/workspace';
import { PanelTitle } from './PanelTitle';

/** "This app session" for history: rows that finished before ARC started are
 *  left to each agent's own history list. */
const APP_STARTED = Date.now();

const GROUPS: { status: SessionStatus; label: string; Icon: LucideIcon; tone: string }[] = [
  { status: 'waiting', label: 'Waiting on you', Icon: CircleDot, tone: 'text-status-warn' },
  { status: 'working', label: 'Working', Icon: RefreshCw, tone: 'text-accent' },
  { status: 'done', label: 'Done', Icon: CircleCheck, tone: 'text-status-ok' },
];

/**
 * Every agent ARC knows about, wherever it runs — chat panels and windows,
 * agent CLIs in terminal tabs, worktree race runs and Wingman runs — grouped
 * by what it needs from you. A row opens its agent; hover actions stop it,
 * show what it changed, or send it a follow-up without leaving the list.
 */
export function SessionsPanel() {
  const root = useFiles((s) => s.root);
  const snaps = useChatSessions((s) => s.snaps);
  const tabs = useWorkspace((s) => s.tabs);
  const waiting = useWorkspace((s) => s.agentWaiting);
  const exited = useWorkspace((s) => s.agentExited);
  const wingmanOn = useWingman((s) => s.status === 'connected');
  const cards = useWingman((s) => s.cards);
  const [races, setRaces] = useState<RaceGroup[]>([]);
  const seq = useRef(0);

  // Races live in git, not in a store, so they're read on open and on demand.
  const loadRaces = useCallback(async () => {
    const mine = ++seq.current;
    if (!root) return setRaces([]);
    try {
      const found = groupRaceRuns(await gitWorktreeList(root), loadRaceMeta());
      if (mine === seq.current) setRaces(found);
    } catch {
      if (mine === seq.current) setRaces([]);
    }
  }, [root]);
  // A new agent tab may be a race run, so tab changes re-read too.
  const agentTabCount = tabs.filter((t) => t.shellOverride).length;
  useEffect(() => {
    void loadRaces();
  }, [loadRaces, agentTabCount]);

  const groups = useMemo(
    () =>
      groupRows([
        ...chatRows(snaps),
        ...terminalRows(tabs, waiting, exited, races),
        ...raceRows(races, tabs, APP_STARTED),
        ...(wingmanOn ? wingmanRows(cards, APP_STARTED) : []),
      ]),
    [snaps, tabs, waiting, exited, races, wingmanOn, cards],
  );
  const empty = GROUPS.every((g) => groups[g.status].length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        <PanelTitle view="sessions" />
        <button
          type="button"
          onClick={() => void loadRaces()}
          title="Refresh worktree runs"
          aria-label="Refresh worktree runs"
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {empty ? (
          <p className="px-3 py-6 text-center font-display text-2xs leading-relaxed text-fg-subtle">
            No agents yet. Start one from the Agents view or the agent launcher; it shows up here
            wherever it runs.
          </p>
        ) : (
          GROUPS.map((g) =>
            groups[g.status].length === 0 ? null : (
              <section key={g.status} className="mt-2 first:mt-0">
                <h3 className="flex items-center gap-1.5 px-2 py-1 font-display text-2xs text-fg-subtle">
                  <g.Icon size={11} strokeWidth={2} className={g.tone} />
                  {g.label}
                  <span className="tabular-nums">({groups[g.status].length})</span>
                </h3>
                <ul>
                  {groups[g.status].map((row) => (
                    <SessionItem key={row.key} row={row} />
                  ))}
                </ul>
              </section>
            ),
          )
        )}
      </div>
    </div>
  );
}

/** What a row can do, by where its agent lives. */
function actionsFor(row: SessionRow) {
  const ws = useWorkspace.getState();
  const s = row.source;
  const live = row.status !== 'done';
  switch (s.kind) {
    case 'chat': {
      const store = chatStore(s.key);
      return {
        open: () => focusChat(s.surface),
        stop: live && store?.getState().streaming ? () => void store.getState().cancel() : null,
        diff: () => useFiles.getState().showSidebarView('git'),
        followUp:
          store && !store.getState().streaming && !store.getState().pending
            ? (text: string) => void store.getState().send(text)
            : null,
      };
    }
    case 'terminal': {
      const tab = ws.tabs.find((t) => t.id === s.tabId);
      return {
        open: () => ws.setActive(s.tabId),
        stop:
          live && tab?.ptyId
            ? async () => {
                const ok = await askConfirm({
                  title: `Stop ${row.agent}?`,
                  body: `This ends the agent process in “${row.title}”. Its conversation stays in the agent's own history.`,
                  confirmLabel: 'Stop',
                  destructive: true,
                });
                if (ok && tab.ptyId) await ptyKill(tab.ptyId).catch(() => {});
              }
            : null,
        // Source Control can narrow to what the agent changed since it started.
        diff: () => {
          useAgentRun.getState().setFiltering(true);
          useFiles.getState().showSidebarView('git');
        },
        followUp:
          live && tab?.ptyId
            ? (text: string) => {
                const term = getTerminal(s.tabId);
                if (!term || !tab.ptyId) return;
                term.paste(text);
                void ptyWrite(tab.ptyId, '\r');
              }
            : null,
      };
    }
    case 'race':
      return {
        open: () => ws.openAgentRuns(),
        stop: null,
        diff: () => ws.openAgentRuns(),
        followUp: null,
      };
    case 'wingman':
      return {
        open: () => ws.openWingmanBoard(),
        stop: null,
        diff: row.status === 'waiting' ? () => ws.openWingmanReview() : null,
        followUp: null,
      };
  }
}

function SessionItem({ row }: { row: SessionRow }) {
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const a = actionsFor(row);

  const send = () => {
    const t = text.trim();
    if (!t || !a.followUp) return;
    a.followUp(t);
    setText('');
    setAsking(false);
  };

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={a.open}
        title={row.detail ?? row.title}
        className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 pr-20 text-left transition-colors hover:bg-surface-2"
      >
        <span className="flex min-w-0 items-baseline gap-1.5 font-display text-xs">
          <span className="shrink-0 text-fg-muted">{row.agent}</span>
          <span className="min-w-0 truncate text-fg-base">{row.title}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 font-mono text-2xs text-fg-subtle">
          {row.where && <span className="min-w-0 truncate">{row.where}</span>}
          {row.at > 0 && <span className="shrink-0">{ago(row.at)}</span>}
          {row.costUsd !== undefined && (
            <span className="shrink-0 tabular-nums">${row.costUsd.toFixed(2)}</span>
          )}
        </span>
        {row.detail && row.status !== 'done' && (
          <span className="truncate font-display text-2xs text-status-warn/90">{row.detail}</span>
        )}
      </button>

      <div className="absolute right-1.5 top-1.5 hidden items-center gap-0.5 group-focus-within/row:flex group-hover/row:flex">
        {a.followUp && (
          <RowAction
            Icon={MessageSquare}
            label="Send a follow-up"
            onClick={() => setAsking((v) => !v)}
          />
        )}
        {a.diff && <RowAction Icon={FileDiff} label="Review changes" onClick={a.diff} />}
        {a.stop && <RowAction Icon={Square} label="Stop" onClick={() => void a.stop?.()} danger />}
      </div>

      {asking && a.followUp && (
        <div className="mx-2 mb-1.5 flex items-end gap-1 rounded-md bg-surface-1 px-1.5 py-1 ring-1 ring-edge-1 focus-within:ring-accent/40">
          <textarea
            autoFocus
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              } else if (e.key === 'Escape') {
                setAsking(false);
              }
            }}
            placeholder={`Tell ${row.agent}…`}
            aria-label={`Follow-up for ${row.agent}`}
            className="min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 font-display text-xs text-fg-base placeholder:text-fg-subtle focus:outline-none"
          />
          <button
            type="button"
            onClick={send}
            disabled={!text.trim()}
            aria-label="Send follow-up"
            className="mb-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-accent-soft text-fg-base ring-1 ring-accent/45 disabled:opacity-40"
          >
            <ArrowUp size={11} strokeWidth={2.3} />
          </button>
        </div>
      )}
    </li>
  );
}

function RowAction({
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
        'flex h-6 w-6 items-center justify-center rounded bg-bg-panel text-fg-subtle ring-1 ring-edge-1 transition-colors hover:text-fg-base',
        danger && 'hover:text-status-err',
      )}
    >
      <Icon size={11} strokeWidth={2.2} />
    </button>
  );
}

/** "now", "3m", "2h", "4d". */
function ago(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
