import type { Tab } from '../state/workspace';
import { useWorkspace } from '../state/workspace';
import { useClaudeCode } from '../state/claudeCode';
import { useFiles } from '../state/files';
import { copyText } from './clipboard';
import { toast } from '../state/toast';
import { getTerminal } from './terminalRegistry';

/**
 * Which agent terminal a "send to agent" goes to: the active tab if it is an
 * agent, else one that is waiting on the user (oldest wait first — it has been
 * idle longest), else the most recently opened agent. Null when no agent CLI
 * is running.
 */
export function pickAgentTab(
  tabs: readonly Tab[],
  activeTabId: string | null,
  waiting: Readonly<Record<string, { at: number }>>,
): Tab | null {
  const agents = tabs.filter((t) => t.kind === 'terminal' && t.shellOverride && t.ptyId);
  if (agents.length === 0) return null;
  const active = agents.find((t) => t.id === activeTabId);
  if (active) return active;
  const idle = agents
    .filter((t) => waiting[t.id])
    .sort((a, b) => waiting[a.id]!.at - waiting[b.id]!.at)[0];
  return idle ?? agents[agents.length - 1]!;
}

/**
 * Put `prompt` in front of an agent without the user retyping it.
 *
 * A running agent CLI gets it pasted onto its input line — not submitted, so
 * the user can add to it and press Enter. Failing that the Claude Code panel
 * takes it, and failing that it lands on the clipboard.
 */
export function sendToAgent(prompt: string, label = 'Agent prompt'): void {
  const ws = useWorkspace.getState();
  const tab = pickAgentTab(ws.tabs, ws.activeTabId, ws.agentWaiting);
  const term = tab ? getTerminal(tab.id) : undefined;
  if (tab && term) {
    ws.setActive(tab.id);
    term.paste(prompt);
    term.focus();
    toast(`Sent to ${tab.title}`);
    return;
  }
  const claude = useClaudeCode.getState();
  if (claude.status === 'ready') {
    useFiles.getState().setAgentPanelTab('claude');
    useFiles.getState().showSidebarView('agents');
    void claude.send(prompt);
    return;
  }
  copyText(prompt, label);
}
