import type { Problem } from './problemMatchers';

/** Problems included before the list is truncated.
 *
 *  A checker that has gone badly wrong reports hundreds, and pasting all of
 *  them buries the ask in noise and wastes the agent's context on repetition —
 *  the first two dozen are almost always the same handful of root causes. */
const MAX_PROBLEMS = 24;

/** How many characters of one message survive. Rust and TypeScript both emit
 *  multi-line diagnostics that can run to whole paragraphs. */
const MAX_MESSAGE = 300;

function oneLine(message: string, cap = MAX_MESSAGE): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/** `src/app.ts:12:4` — the form every editor and agent already understands. */
function location(p: Problem): string {
  if (!p.line) return p.file;
  return p.column ? `${p.file}:${p.line}:${p.column}` : `${p.file}:${p.line}`;
}

/**
 * Turn checker output into a prompt an agent can act on.
 *
 * The point is that the user does not retype diagnostics they are already
 * looking at. Problems arrive grouped by file, because that is the order
 * someone fixes them in, and each line keeps the `file:line:col` form so the
 * agent can open exactly what the checker complained about.
 *
 * Errors are listed before warnings and truncation drops warnings first: if
 * only some of the list survives, it should be the part that stops a build.
 */
export function problemsPrompt(problems: Problem[]): string {
  const ranked = [...problems].sort((a, b) => {
    const weight = (s: Problem['severity']) => (s === 'error' ? 0 : s === 'warning' ? 1 : 2);
    return weight(a.severity) - weight(b.severity);
  });
  const shown = ranked.slice(0, MAX_PROBLEMS);
  const dropped = ranked.length - shown.length;

  // Group *after* ranking so a file with an error sorts above one with only
  // warnings, while each file's own problems stay together.
  const byFile = new Map<string, Problem[]>();
  for (const p of shown) {
    const list = byFile.get(p.file);
    if (list) list.push(p);
    else byFile.set(p.file, [p]);
  }

  const lines: string[] = [
    `Fix the following ${shown.length === 1 ? 'problem' : `${shown.length} problems`} reported by my project's checkers.`,
    '',
  ];
  for (const [file, list] of byFile) {
    lines.push(`${file}`);
    for (const p of list) {
      const code = p.code ? ` [${p.code}]` : '';
      lines.push(`  ${location(p)} — ${p.severity}${code}: ${oneLine(p.message)}`);
    }
    lines.push('');
  }
  if (dropped > 0) {
    lines.push(
      `(${dropped} further ${dropped === 1 ? 'problem is' : 'problems are'} reported; re-run the checkers after fixing these.)`,
      '',
    );
  }
  lines.push('Make the smallest change that resolves each one, and do not silence a');
  lines.push('diagnostic by suppressing it unless there is genuinely nothing to fix.');
  return lines.join('\n');
}
