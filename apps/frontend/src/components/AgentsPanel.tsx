import { Bot, Sparkles, type LucideIcon } from 'lucide-react';
import { useFiles, type AgentPanelTab } from '../state/files';
import { ClaudePanel } from './claude/ClaudePanel';
import { WingmanPanel } from './wingman/WingmanPanel';
import { cn } from '../lib/cn';

/** The agents ARC can drive headlessly, and so can host a chat for.
 *
 *  Membership is not a style choice: Claude Code ships a documented
 *  non-interactive mode (`--output-format stream-json`) and Wingman serves an
 *  HTTP/SSE API, which is what lets ARC render a conversation instead of a
 *  terminal. The other supported CLIs are TUI-first with no stable machine
 *  protocol, so they launch as terminal tabs from the agent launcher. Add a row
 *  here when a CLI gains a documented streaming protocol — not before. */
const AGENT_TABS: { id: AgentPanelTab; label: string; Icon: LucideIcon }[] = [
  { id: 'claude', label: 'Claude Code', Icon: Sparkles },
  { id: 'wingman', label: 'Wingman', Icon: Bot },
];

/**
 * The Agents sidebar view: one home for the agents ARC talks to directly,
 * with a switcher above whichever conversation is showing.
 *
 * Both panels already reduce the same event vocabulary (`text_delta`,
 * `tool_start`, `tool_result`, …) — see the header of `rust/claude-code` — so
 * this is the shell that shared shape was always heading toward, not a new
 * abstraction over two unrelated things.
 */
export function AgentsPanel() {
  const tab = useFiles((s) => s.agentPanelTab);
  const setTab = useFiles((s) => s.setAgentPanelTab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border-hairline px-1.5 py-1.5">
        {AGENT_TABS.map(({ id, label, Icon }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-pressed={active}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1',
                'font-display text-xs font-medium tracking-tight',
                'transition-all duration-150 ease-apple',
                active
                  ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30'
                  : 'text-fg-muted hover:bg-surface-2 hover:text-fg-base',
              )}
            >
              <Icon size={12} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>

      {/* Keyed so each agent's panel remounts on switch, replaying its own
          empty/installing states rather than showing the other's scroll
          position. The conversations live in their stores, not here. */}
      <div className="flex min-h-0 flex-1 flex-col" key={tab}>
        {tab === 'claude' ? <ClaudePanel /> : <WingmanPanel />}
      </div>
    </div>
  );
}
