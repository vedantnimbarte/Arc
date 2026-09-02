import { useMemo, useState } from 'react';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import { useSettings } from '../state/settings';
import { layoutModeOf, useWorkspace } from '../state/workspace';
import { AI_CLI_COMMANDS, AI_CLIS, type AiCliId, type AiCliInfo } from '../lib/tauri';
import { groupColorDef, rgba, type TabGroupColorId } from '../lib/tabGroups';
import { cn } from '../lib/cn';

/** A stable hue per agent from the shared tab-group palette — the same eight
 *  ARC already uses for workspaces and tab groups. Hand-assigned rather than
 *  cycled so an agent keeps its colour as the list grows, and so neighbours in
 *  the grid never collide. Colour is the only thing separating thirteen rows
 *  of identical shape, so it has to be scannable. */
const AGENT_HUE: Record<AiCliId, TabGroupColorId> = {
  'claude-cli': 'orange',
  'codex-cli': 'green',
  'opencode-cli': 'cyan',
  'kimi-code-cli': 'violet',
  'gemini-cli': 'blue',
  'qwen-code-cli': 'rose',
  'cursor-agent-cli': 'slate',
  'copilot-cli': 'amber',
  'amp-cli': 'green',
  'aider-cli': 'violet',
  'crush-cli': 'rose',
  'droid-cli': 'cyan',
  'grok-cli': 'slate',
  'pi-cli': 'amber',
  'wingman-cli': 'blue',
};

/** How many agents one launch can start. Four is where a tiled grid stops
 *  being readable on a laptop display — past that the panes are too narrow to
 *  hold an agent's output without wrapping every line. */
const COUNTS = [1, 2, 3, 4] as const;

/** Rectangles, in a 24×18 box, for the pane arrangement ARC's dwindle produces
 *  at each count: split right, then down into the new pane, then right again.
 *  Drawn rather than iconified because the shape *is* the information — this
 *  is the one control that shows what the workspace will look like. */
const PANE_CELLS: Record<number, [number, number, number, number][]> = {
  1: [[0, 0, 24, 18]],
  2: [
    [0, 0, 11.25, 18],
    [12.75, 0, 11.25, 18],
  ],
  3: [
    [0, 0, 11.25, 18],
    [12.75, 0, 11.25, 8.25],
    [12.75, 9.75, 11.25, 8.25],
  ],
  4: [
    [0, 0, 11.25, 18],
    [12.75, 0, 11.25, 8.25],
    [12.75, 9.75, 5, 8.25],
    [19, 9.75, 5, 8.25],
  ],
};

/**
 * Miniature of what `n` agents will do to the workspace: the dwindle grid when
 * tiling, a tab strip when the workspace is tabbed. Honest about which of the
 * two you are actually going to get.
 */
function LayoutGlyph({ n, tabbed }: { n: number; tabbed: boolean }) {
  return (
    <svg viewBox="0 0 24 18" className="h-[18px] w-6 shrink-0" aria-hidden>
      {tabbed ? (
        <>
          {Array.from({ length: n }, (_, i) => (
            <rect
              key={i}
              x={i * (24 / n) + 0.5}
              y={0}
              width={24 / n - 1}
              height={4}
              rx={1}
              fill={i === 0 ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth={1}
              opacity={i === 0 ? 0.9 : 0.5}
            />
          ))}
          <rect x={0.5} y={5.5} width={23} height={12} rx={1.5} fill="currentColor" opacity={0.16} />
        </>
      ) : (
        PANE_CELLS[n]!.map(([x, y, w, h], i) => (
          <rect key={i} x={x} y={y} width={w} height={h} rx={1.5} fill="currentColor" opacity={0.85} />
        ))
      )}
    </svg>
  );
}

/** Resolve after the browser has laid out and run resize observers. Two frames
 *  because the observer fires between them: React commits the new pane in one,
 *  the observer reports its size before the next. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}

/** Split a start command into argv, honouring double quotes so a flag value
 *  with a space (`--system "be terse"`) survives. Deliberately not a shell:
 *  the command is spawned directly, so there is no expansion to emulate. */
export function parseCommand(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of input.trim()) {
    if (ch === '"') quoted = !quoted;
    else if (/\s/.test(ch) && !quoted) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

interface Props {
  /** Agents the Rust detector actually found on PATH. Every supported agent is
   *  listed regardless; this only decides which are marked as found. */
  detected: AiCliInfo[];
  /** Return to the parent menu. Omit when the panel stands on its own — the
   *  header then drops the back control rather than showing a dead one. */
  onBack?: () => void;
  /** Close the surface hosting this panel — called after a launch. */
  onDone: () => void;
}

/**
 * Agent launch panel: pick one of the supported CLIs, choose how many copies
 * to start, adjust the command it runs, launch.
 *
 * Every agent in `AI_CLIS` is offered, not just the detected ones — the point
 * is to show what ARC supports. One that isn't on PATH is marked and still
 * launchable; it spawns a terminal that reports `command not found`, which is
 * a clearer answer than a tile that silently does nothing.
 */
export function AgentLauncher({ detected, onBack, onDone }: Props) {
  const launchAiCli = useWorkspace((s) => s.launchAiCli);
  const tabbed = useWorkspace((s) => layoutModeOf(s.workspaces, s.activeWorkspaceId) === 'standard');
  const agentCommands = useSettings((s) => s.agentCommands);
  const setAgentCommand = useSettings((s) => s.setAgentCommand);

  const ids = useMemo(() => Object.keys(AI_CLIS) as AiCliId[], []);
  const installed = useMemo(() => new Map(detected.map((c) => [c.id, c])), [detected]);
  // Default the selection to something that will actually run.
  const [selected, setSelected] = useState<AiCliId>(
    () => (detected[0]?.id as AiCliId | undefined) ?? ids[0]!,
  );
  // Installed first — that is the set the user is actually choosing from.
  // Both keep `AI_CLIS` order so an agent never moves around within its group.
  const available = useMemo(() => ids.filter((id) => installed.has(id)), [ids, installed]);
  const missing = useMemo(() => ids.filter((id) => !installed.has(id)), [ids, installed]);
  const [count, setCount] = useState(1);
  // `null` means "follow the stored/default command" — typing forks it, Reset
  // and switching agents return to following.
  const [draft, setDraft] = useState<string | null>(null);

  const command = draft ?? agentCommands[selected] ?? AI_CLI_COMMANDS[selected];
  const isDefault = command.trim() === AI_CLI_COMMANDS[selected];
  const runnable = parseCommand(command).length > 0;
  const label = AI_CLIS[selected];
  const found = installed.has(selected);
  const unit = tabbed ? 'tab' : 'pane';

  const pick = (id: AiCliId) => {
    setSelected(id);
    setDraft(null); // the command belongs to the agent, not the panel
  };

  const launch = () => {
    const argv = parseCommand(command);
    if (argv.length === 0) return;
    setAgentCommand(selected, command);
    const [bin, ...args] = argv;
    // Prefer the detector's absolute path, but only while the user is running
    // the command it found — an edited binary name has to go back through PATH.
    const hit = installed.get(selected);
    const path = hit && bin === AI_CLI_COMMANDS[selected] ? hit.path : bin!;
    onDone();
    void (async () => {
      for (let i = 0; i < count; i++) {
        await launchAiCli(
          { id: selected, label, path },
          { args, title: count > 1 ? `${label} ${i + 1}` : label },
        );
        // Yield a frame between launches. `addTab` picks its split direction
        // from `dwindleSide`, which reads pane rects kept current by a
        // ResizeObserver — firing all four synchronously outruns that observer,
        // so every split would read the original wide pane and open to the
        // right, leaving four unreadable columns instead of a grid.
        if (i < count - 1) await nextFrame();
      }
    })();
  };

  return (
    <div className="flex w-[318px] flex-col">
      <header className="flex items-center gap-2 border-b border-border-hairline px-3 py-2.5">
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back"
            className="-ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <ChevronLeft size={14} strokeWidth={2} />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-sm font-semibold tracking-tight text-fg-base">
            Launch agents
          </h2>
          {/* Real counts beat a tagline: this is the one place that can tell you
              how much of ARC's agent support your machine can actually run. */}
          <p className="font-display text-2xs text-fg-subtle">
            {ids.length} supported · {installed.size} on your PATH
          </p>
        </div>
      </header>

      {/* Split by what this machine can actually run. On a real install that
          is two or three agents against a dozen it isn't, so a single flat
          list makes you hunt past the ones you can't use to reach the ones you
          can. Splitting them means the common case needs no scrolling at all,
          and the two groups get shapes that match their weight: your agents as
          full rows naming the command they'll run, the rest as quiet chips. */}
      {/* Fifteen agents overflow this box in every combination, so the fade is
          unconditional: a hard clip mid-row reads as a rendering fault, a fade
          reads as "more below". */}
      <div
        className={cn(
          'scrollbar-thin max-h-[228px] overflow-y-auto px-3 pt-2.5',
          '[mask-image:linear-gradient(to_bottom,black_calc(100%-16px),transparent)]',
        )}
      >
        {available.length > 0 && (
          <>
            <SectionLabel>On your PATH</SectionLabel>
            <div className="flex flex-col gap-1 pb-1">
              {available.map((id) => (
                <AgentRow
                  key={id}
                  id={id}
                  active={id === selected}
                  command={agentCommands[id] ?? AI_CLI_COMMANDS[id]}
                  title={installed.get(id)!.path}
                  onPick={pick}
                />
              ))}
            </div>
          </>
        )}

        <div className={cn(available.length > 0 && 'pt-2')}>
          <SectionLabel>{available.length > 0 ? 'Also supported' : 'Supported agents'}</SectionLabel>
          {available.length === 0 && (
            // The empty case is the one that needs direction, not a shrug.
            <p className="-mt-1 pb-2 font-display text-2xs text-fg-subtle">
              None of these are on your PATH yet. Pick one to see the command it
              needs, or install it and reopen this panel.
            </p>
          )}
          <div className="grid grid-cols-2 gap-1 pb-1">
            {missing.map((id) => (
              <AgentChip key={id} id={id} active={id === selected} onPick={pick} />
            ))}
          </div>
        </div>
      </div>

      <div className="px-3 pt-3">
        <SectionLabel>{tabbed ? 'Tabs' : 'Panes'}</SectionLabel>
        <div className="flex items-stretch gap-1">
          {COUNTS.map((n) => {
            const on = n === count;
            const hex = groupColorDef(AGENT_HUE[selected]).hex;
            return (
              <button
                key={n}
                onClick={() => setCount(n)}
                aria-pressed={on}
                aria-label={`${n} ${n === 1 ? unit : `${unit}s`}`}
                style={on ? { backgroundColor: rgba(hex, 0.14), borderColor: rgba(hex, 0.42) } : undefined}
                className={cn(
                  'flex flex-1 flex-col items-center gap-1 rounded-lg border py-2',
                  'font-display text-2xs font-medium tabular-nums',
                  'transition-all duration-150 ease-apple',
                  on
                    ? 'text-fg-base'
                    : 'border-transparent text-fg-subtle hover:border-border-hairline hover:bg-surface-1 hover:text-fg-muted',
                )}
              >
                <span style={on ? { color: hex } : undefined}>
                  <LayoutGlyph n={n} tabbed={tabbed} />
                </span>
                {n}
              </button>
            );
          })}
        </div>
      </div>

      <div className="px-3 pt-3">
        <div className="flex items-center justify-between">
          <SectionLabel>Command</SectionLabel>
          <button
            onClick={() => {
              setDraft(null);
              setAgentCommand(selected, '');
            }}
            disabled={isDefault}
            className={cn(
              'mb-2 flex items-center gap-1 font-display text-2xs transition-colors',
              isDefault ? 'cursor-default text-fg-subtle/35' : 'text-fg-subtle hover:text-fg-base',
            )}
          >
            <RotateCcw size={10} strokeWidth={2} />
            Reset
          </button>
        </div>
        <input
          value={command}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && runnable) launch();
          }}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          aria-label="Start command"
          className={cn(
            'w-full rounded-lg border border-border-hairline bg-bg-base/50 px-2.5 py-1.5',
            'font-mono text-xs text-fg-base placeholder:text-fg-subtle/50',
            'transition-colors focus:border-accent/45 focus:outline-none focus:shadow-focus',
          )}
        />
      </div>

      <div className="p-3">
        <button
          onClick={launch}
          disabled={!runnable}
          className={cn(
            'flex w-full items-center justify-center rounded-lg border border-border-subtle py-2',
            'bg-surface-2 font-display text-xs font-medium tracking-tight text-fg-base',
            'transition-all duration-150 ease-apple',
            'hover:border-border-subtle hover:bg-surface-3 active:scale-[0.99]',
            'disabled:pointer-events-none disabled:opacity-40',
          )}
        >
          Launch {count} {label} {count === 1 ? unit : `${unit}s`}
        </button>
        {!found && (
          // Direction, not an apology — say what to do about it.
          <p className="pt-1.5 text-center font-display text-2xs text-fg-subtle">
            Not on your PATH. Install it, or edit the command above.
          </p>
        )}
      </div>
    </div>
  );
}

/** Tint applied to a selected agent, in that agent's own hue. Shared so a row
 *  and a chip highlight identically despite their different shapes. */
function selectedStyle(id: AiCliId): React.CSSProperties {
  const hex = groupColorDef(AGENT_HUE[id]).hex;
  return { backgroundColor: rgba(hex, 0.14), borderColor: rgba(hex, 0.42) };
}

/** The hue dot every agent carries — solid once it's on PATH, hollow while it
 *  is only supported. Same mark the tab-group chips use. */
function AgentDot({ id, filled }: { id: AiCliId; filled: boolean }) {
  const hex = groupColorDef(AGENT_HUE[id]).hex;
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={filled ? { background: hex } : { boxShadow: `inset 0 0 0 1.5px ${rgba(hex, 0.55)}` }}
    />
  );
}

/** An installed agent: a full-width row that also names the command it runs,
 *  so a customised one shows its override without opening the field below. */
function AgentRow({
  id,
  active,
  command,
  title,
  onPick,
}: {
  id: AiCliId;
  active: boolean;
  command: string;
  title: string;
  onPick: (id: AiCliId) => void;
}) {
  return (
    <button
      onClick={() => onPick(id)}
      aria-pressed={active}
      title={title}
      style={active ? selectedStyle(id) : undefined}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left',
        'transition-all duration-150 ease-apple',
        active
          ? 'text-fg-base'
          : 'border-transparent text-fg-muted hover:border-border-hairline hover:bg-surface-1 hover:text-fg-base',
      )}
    >
      <AgentDot id={id} filled />
      <span className="flex-1 truncate font-display text-xs tracking-tight">{AI_CLIS[id]}</span>
      <span className="shrink-0 truncate font-mono text-2xs text-fg-subtle">{command}</span>
    </button>
  );
}

/** A supported-but-absent agent: compact, quieter, two to a row. */
function AgentChip({
  id,
  active,
  onPick,
}: {
  id: AiCliId;
  active: boolean;
  onPick: (id: AiCliId) => void;
}) {
  return (
    <button
      onClick={() => onPick(id)}
      aria-pressed={active}
      title={`${AI_CLIS[id]} — not on your PATH`}
      style={active ? selectedStyle(id) : undefined}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left',
        'font-display text-xs tracking-tight transition-all duration-150 ease-apple',
        active
          ? 'text-fg-base'
          : 'border-transparent text-fg-subtle hover:border-border-hairline hover:bg-surface-1 hover:text-fg-muted',
      )}
    >
      <AgentDot id={id} filled={false} />
      <span className="flex-1 truncate">{AI_CLIS[id]}</span>
    </button>
  );
}

/** ARC's section label: small caps, wide tracking, quiet. Matches the launcher
 *  (`EmptyWorkspace`) so the two surfaces read as one system. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 font-display text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle/80">
      {children}
    </div>
  );
}
