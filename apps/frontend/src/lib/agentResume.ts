import type { AiCliId } from './tauri';

/**
 * Arguments that make an agent CLI pick up its most recent conversation in
 * the current directory. Only CLIs with a documented flag are listed; the rest
 * relaunch fresh, which still beats coming back as a bare shell.
 * ponytail: hand-kept list — add a CLI when its resume flag is confirmed.
 */
export const AGENT_RESUME_ARGS: Partial<Record<AiCliId, string[]>> = {
  'claude-cli': ['--continue'],
  'codex-cli': ['resume', '--last'],
  'opencode-cli': ['--continue'],
  'aider-cli': ['--restore-chat-history'],
};

/** Terminal answers xterm sends on its own — cursor position, device
 *  attributes, focus in/out, OSC colour replies. They belong to the terminal
 *  that was asked, so broadcast input must never copy them to its siblings. */
const TERMINAL_REPLY = /^(?:\x1b\[[?>]?[\d;]*[Rcn]|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))$/;

export function isTerminalReply(data: string): boolean {
  return TERMINAL_REPLY.test(data);
}
