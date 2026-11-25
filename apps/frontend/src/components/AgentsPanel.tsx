import { useEffect } from 'react';
import { Bot, Sparkles, Terminal, type LucideIcon } from 'lucide-react';
import { useFiles, type AgentPanelTab } from '../state/files';
import { acpSession, expandToWindow, useAcpAgents } from '../state/acpAgents';
import { ClaudePanel, SessionChat } from './claude/ClaudePanel';
import { WingmanPanel } from './wingman/WingmanPanel';
import { cn } from '../lib/cn';
import { PanelTitle } from './PanelTitle';

/** The agents ARC can drive headlessly, and so can host a chat for.
 *
 *  Membership is not a style choice: Claude Code ships a documented
 *  non-interactive mode (`--output-format stream-json`), Wingman serves an
 *  HTTP/SSE API, and the ACP agents appended at runtime speak the Agent Client
 *  Protocol (see rust/acp). That is what lets ARC render a conversation instead
 *  of a terminal. CLIs with none of these launch as terminal tabs from the
 *  agent launcher. */
const AGENT_TABS: { id: AgentPanelTab; label: string; Icon: LucideIcon }[] = [
  { id: 'claude', label: 'Claude Code', Icon: Sparkles },
  { id: 'wingman', label: 'Wingman', Icon: Bot },
];

/**
 * The Agents sidebar view: one home for the agents ARC talks to directly,
 * with a switcher above whichever conversation is showing.
 *
 * Every panel reduces the same event vocabulary (`text_delta`, `tool_start`,
 * `tool_result`, …) — see the header of `rust/claude-code` — so Claude Code
 * and the ACP agents share one chat component over different transports.
 */
export function AgentsPanel() {
  const stored = useFiles((s) => s.agentPanelTab);
  const setTab = useFiles((s) => s.setAgentPanelTab);
  const acp = useAcpAgents((s) => s.providers);
  const acpStatus = useAcpAgents((s) => s.status);
  const detectAcp = useAcpAgents((s) => s.detect);

  useEffect(() => {
    if (acpStatus === 'checking') void detectAcp();
  }, [acpStatus, detectAcp]);

  const tabs = [
    ...AGENT_TABS,
    ...acp.map((p) => ({ id: p.id as AgentPanelTab, label: p.label, Icon: Terminal })),
  ];
  // A remembered ACP agent that has since been uninstalled falls back to Claude.
  const tab = tabs.some((t) => t.id === stored) ? stored : 'claude';
  const provider = acp.find((p) => p.id === tab);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center px-3 py-2">
        <PanelTitle view="agents" />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border-hairline px-1.5 py-1.5">
        {tabs.map(({ id, label, Icon }) => {
          const active = id === tab;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              aria-pressed={active}
              title={label}
              className={cn(
                'flex min-w-[5.5rem] flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1',
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
        {provider ? (
          <SessionChat
            store={acpSession(provider.id)}
            agent={provider.label}
            onExpand={() =>
              expandToWindow(acpSession(provider.id), {
                provider: provider.id,
                title: provider.label,
              })
            }
          />
        ) : tab === 'wingman' ? (
          <WingmanPanel />
        ) : (
          <ClaudePanel />
        )}
      </div>
    </div>
  );
}
