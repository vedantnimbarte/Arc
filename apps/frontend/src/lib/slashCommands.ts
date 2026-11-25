/**
 * Composer slash commands for working with other agents: `/handoff`,
 * `/advisor`, `/committee`.
 *
 * They aren't features of their own — each expands into a prompt telling the
 * agent how to use Arc's orchestration tools (the `arc` MCP server:
 * `start_agent`, `wait_for_agent`, …) for that pattern. The transcript shows
 * what the user typed; the agent receives the expansion.
 */

export interface SlashCommand {
  name: string;
  /** What it does, for the composer's hint list. */
  hint: string;
  /** What the user types after the name. */
  arg: string;
  expand: (arg: string) => string;
}

const NO_TOOLS =
  "If you don't have Arc's `arc` MCP tools (start_agent, wait_for_agent), say so and stop.";

const AGENT_CHOICE =
  'If the request names an agent (for example "with codex"), use that one; otherwise call `list_agents` and pick';

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'handoff',
    hint: 'Plan here, then hand the implementation to another agent',
    arg: 'task',
    expand: (task) =>
      [
        `Hand off this task to another agent: ${task}`,
        '',
        'Do it in three steps:',
        "1. Plan it here. Read what you need in this repo and write a concrete plan: the files to change, the approach, and how to check it works. Don't edit files yourself.",
        `2. Start one helper with \`start_agent\` (worktree: true). ${AGENT_CHOICE} the most capable one for implementation. The helper can't see this conversation, so its prompt must be self-contained: the task, your full plan, and how to verify.`,
        '3. Call `wait_for_agent` until it finishes (call it again while it is still working). Then review its reply and edited files against the plan, and report what it did, where (its worktree), and anything that still needs doing. If it is waiting on the user, say so.',
        '',
        NO_TOOLS,
      ].join('\n'),
  },
  {
    name: 'advisor',
    hint: 'Get a second opinion from another agent, without it changing files',
    arg: 'question',
    expand: (question) =>
      [
        `Get a second opinion from another agent on: ${question}`,
        '',
        `1. Start one helper with \`start_agent\` (worktree: false — it only reads). ${AGENT_CHOICE} a different agent from yourself if one is available. Its prompt must be self-contained: the question, the relevant context and code locations, and any approach you're leaning towards. Ask it to critique and suggest, and not to edit files.`,
        '2. Call `wait_for_agent` until it finishes.',
        "3. Report its view next to yours: where you agree, where you differ, and what you now recommend. Don't change any files.",
        '',
        NO_TOOLS,
      ].join('\n'),
  },
  {
    name: 'committee',
    hint: 'Ask two different agents the same question and compare',
    arg: 'question',
    expand: (question) =>
      [
        `Convene a committee of two agents on: ${question}`,
        '',
        '1. Call `list_agents` and start two helpers with `start_agent` (worktree: false — analysis only), using two different agents if at least two are available. If the request names agents, use those; otherwise pick the two best suited. Give both the same self-contained prompt: the question, the context, and a request for a root-cause analysis and a recommended plan, without editing files.',
        '2. Call `wait_for_agent` for each until both finish.',
        "3. Compare their answers: where they agree, where they disagree and why, and which reasoning holds up. Finish with one combined recommendation. Don't change any files.",
        '',
        NO_TOOLS,
      ].join('\n'),
  },
];

/** `/name rest` → the command and its argument, or null. */
export function parseSlash(text: string): { cmd: SlashCommand; arg: string } | null {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const cmd = m && SLASH_COMMANDS.find((c) => c.name === m[1]!.toLowerCase());
  return cmd ? { cmd, arg: (m![2] ?? '').trim() } : null;
}

/** What the agent should receive for `text`: a command's expansion, or the
 *  text unchanged. A command with nothing after it is sent as typed. */
export function expandSlash(text: string): string {
  const parsed = parseSlash(text);
  return parsed && parsed.arg ? parsed.cmd.expand(parsed.arg) : text;
}

/** Commands matching what's being typed, while it is still just `/name`. */
export function slashMatches(text: string): SlashCommand[] {
  const m = /^\/(\w*)$/.exec(text);
  if (!m) return [];
  const q = m[1]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}
