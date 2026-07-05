// Pure prompt-shaping for the "explain this failed command" action in the
// command-blocks panel. Kept free of React/Tauri so it can be unit-tested; the
// streaming itself reuses `llmStream` from lib/tauri (see CommandBlocks.tsx).

import type { LlmMessage } from './tauri';

export interface ExplainInput {
  command: string;
  exitCode: number | null;
  /** Captured stdout/stderr excerpt (OSC 133), possibly null/empty. */
  output: string | null;
  /** Working directory the command ran in, for context. */
  cwd?: string | null;
}

export const EXPLAIN_SYSTEM =
  'You are a terminal expert helping debug a shell command that failed. ' +
  'Given the command, its non-zero exit code, and any captured output, ' +
  'explain concisely (1) what went wrong and (2) the most likely fix. ' +
  'Prefer a corrected command in a fenced code block when applicable. ' +
  'Be terse — no preamble, no restating the question.';

const OUTPUT_CAP = 4000;

/** Build the system prompt + message list for an error explanation. Fed
 *  straight into `llmStream`. */
export function buildExplainMessages(input: ExplainInput): {
  system: string;
  messages: LlmMessage[];
} {
  const parts = [`Command: ${input.command.trim()}`];
  if (input.cwd) parts.push(`Directory: ${input.cwd}`);
  parts.push(`Exit code: ${input.exitCode ?? 'unknown'}`);
  const out = (input.output ?? '').trim();
  parts.push(out ? `Output:\n${out.slice(-OUTPUT_CAP)}` : 'Output: (none captured)');
  return {
    system: EXPLAIN_SYSTEM,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  };
}
