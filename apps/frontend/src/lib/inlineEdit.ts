// Pure helpers for the editor's inline "⌘K" AI edit. Kept free of React and
// Tauri so the prompt-shaping and response-cleanup logic can be unit-tested in
// isolation; the streaming itself lives in the InlineEdit component, which
// reuses `llmStream` from lib/tauri.

import type { LlmMessage } from './tauri';

/** What the editor hands the helper when the user invokes ⌘K. */
export interface InlineEditInput {
  /** The exact text currently selected in the editor (the edit target). */
  code: string;
  /** The natural-language instruction the user typed. */
  instruction: string;
  /** File name (basename) — gives the model a language/context hint. */
  fileName: string;
  /** CodeMirror language id (e.g. 'typescript', 'rust'), or null if unknown. */
  language: string | null;
}

/** System prompt: the model is a surgical code editor. It must return only
 *  the rewritten snippet — no prose, no fences — because the result replaces
 *  the selection verbatim. We still strip fences defensively (see
 *  `stripCodeFence`) since models leak them anyway. */
export const INLINE_EDIT_SYSTEM =
  'You are a precise code-editing engine embedded in a text editor. ' +
  'You are given a snippet of code and an instruction. Rewrite the snippet to ' +
  'satisfy the instruction. Respond with ONLY the rewritten code that should ' +
  'replace the snippet — no explanations, no commentary, and no Markdown code ' +
  'fences. Preserve the surrounding indentation style and do not add or remove ' +
  'trailing blank lines beyond what the edit requires.';

/** Build the system prompt + message list for an inline edit. The result is
 *  fed straight into `llmStream`. */
export function buildInlineEditMessages(input: InlineEditInput): {
  system: string;
  messages: LlmMessage[];
} {
  const langHint = input.language ? ` (${input.language})` : '';
  const user =
    `File: ${input.fileName}${langHint}\n\n` +
    `Instruction: ${input.instruction.trim()}\n\n` +
    `Code to rewrite:\n${input.code}`;
  return {
    system: INLINE_EDIT_SYSTEM,
    messages: [{ role: 'user', content: user }],
  };
}

/**
 * Strip a single surrounding Markdown code fence from a model response, if
 * present. Models frequently wrap edits in ```lang … ``` despite being told
 * not to. We only peel one outer fence and only when the whole response is
 * fenced — an interior ``` (e.g. a snippet that legitimately contains a fence)
 * is left untouched.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.replace(/^\n+/, '').replace(/\s+$/, '');
  // Opening fence: ``` optionally followed by a language token on the same line.
  const fenceOpen = /^```[^\n]*\n/;
  const fenceClose = /\n```$/;
  if (fenceOpen.test(trimmed) && fenceClose.test(trimmed)) {
    return trimmed.replace(fenceOpen, '').replace(fenceClose, '');
  }
  return text;
}

/** True when the instruction is substantive enough to send. Guards against
 *  firing a request on an empty / whitespace-only prompt. */
export function isUsableInstruction(instruction: string): boolean {
  return instruction.trim().length > 0;
}

export type DiffOp = 'same' | 'add' | 'del';
export interface DiffLine {
  op: DiffOp;
  text: string;
}

/**
 * A minimal line-level diff between two blocks of text, used to preview an
 * inline edit before it's applied. Classic LCS over lines, then a walk-back
 * that emits deletions (only in old), additions (only in new), and unchanged
 * context. Small inputs only — a selection rewrite, not whole files — so the
 * O(n·m) table is fine.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  // The `!` assertions are safe: every index below is bounded by the loop and
  // the table is sized n+1 × m+1. They satisfy `noUncheckedIndexedAccess`.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const next = lcs[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i]!;
    const bj = b[j]!;
    if (ai === bj) {
      out.push({ op: 'same', text: ai });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: 'del', text: ai });
      i++;
    } else {
      out.push({ op: 'add', text: bj });
      j++;
    }
  }
  while (i < n) out.push({ op: 'del', text: a[i++]! });
  while (j < m) out.push({ op: 'add', text: b[j++]! });
  return out;
}
