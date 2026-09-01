import type { PackageManager } from './testDiscovery';

/**
 * Problem matchers: turn a checker's console output into navigable
 * `{file, line, column, message}` rows.
 *
 * Why parse text rather than ask a language server. LSP already publishes
 * diagnostics, but only for files that are *open* — it is a per-buffer
 * protocol, and ARC attaches one server per editor tab. "Is the project
 * broken right now" is a different question, and the only thing that answers
 * it is the project's own checker: `tsc`, `cargo check`, `eslint`, `ruff`,
 * `go vet`. So the panel runs those and reads what they print.
 *
 * Every matcher below asks its tool for the most machine-friendly output it
 * has (`--pretty false`, `--message-format=short`, `--format compact`,
 * `--output-format=concise`), which in each case collapses to one problem per
 * line. That is what keeps these regexes short enough to trust: we are not
 * parsing the pretty rendering with its carets and colour codes, we are
 * parsing the format the tool ships for exactly this purpose.
 *
 * ponytail: no watch mode — the panel re-runs the checker on demand. Add
 * `tsc --watch` / `cargo watch` if a full run gets slow enough that people
 * stop pressing the button.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Problem {
  /** Path exactly as the tool printed it — usually relative to the directory
   *  it ran in, which is the workspace root. Resolved when the row is opened. */
  file: string;
  /** 1-based. 0 when the tool reported something with no line. */
  line: number;
  /** 1-based. 0 when the tool gave no column. */
  column: number;
  severity: Severity;
  message: string;
  /** Rule or error code — `TS2345`, `E0308`, `no-unused-vars`, `F401`. */
  code?: string;
  /** Which checker produced this — the row badge, and the grouping key. */
  source: string;
}

export interface Checker {
  id: string;
  /** Shown on the run button and on each problem's badge. */
  label: string;
  /** Marker files at the workspace root that mean this checker applies. */
  detect: string[];
  /** True when this runs a JS binary through the package manager, so the
   *  command gets a pnpm/yarn/bun/npx prefix. */
  js?: boolean;
  program: string;
  args: string[];
  parse: (stdout: string, stderr: string) => Problem[];
}

/** Prefix that runs a local JS binary under the detected package manager.
 *  Mirrors `testDiscovery`'s private `jsRunner` — same problem, same answer. */
function jsRunner(manager: PackageManager, bin: string): { program: string; args: string[] } {
  if (manager === 'yarn') return { program: 'yarn', args: [bin] };
  if (manager === 'bun') return { program: 'bun', args: ['x', bin] };
  if (manager === 'pnpm') return { program: 'pnpm', args: ['exec', bin] };
  return { program: 'npx', args: ['--no-install', bin] };
}

const sev = (raw: string): Severity =>
  raw.startsWith('warn') ? 'warning' : raw.startsWith('err') ? 'error' : 'info';

/** Capture group as a string — an unmatched optional group reads as empty
 *  rather than `undefined`, which is what every field below wants anyway. */
const g = (m: RegExpExecArray, i: number): string => m[i] ?? '';

/** Capture group as a 1-based position; 0 when the tool gave none. */
const num = (m: RegExpExecArray, i: number): number => {
  const raw = m[i];
  return raw ? Number(raw) : 0;
};

// ── tsc ─────────────────────────────────────────────────────────────────────
// `tsc --noEmit --pretty false` prints:
//   src/app.ts(12,5): error TS2345: Argument of type X is not assignable.
const TSC_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) ([A-Z]+\d+): (.*)$/;

// A configuration error (a bad compiler option, a missing tsconfig) has no
// file at all — it is just `error TS5023: ...`. Worth keeping rather than
// dropping: when tsc bails this way it never type-checked anything, and a
// panel that showed nothing would read as "the project is clean".
const TSC_GLOBAL_RE = /^(error|warning) ([A-Z]+\d+): (.*)$/;

export function parseTsc(out: string): Problem[] {
  const problems: Problem[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const m = TSC_RE.exec(line);
    if (m) {
      problems.push({
        file: g(m, 1),
        line: num(m, 2),
        column: num(m, 3),
        severity: sev(g(m, 4)),
        code: g(m, 5),
        message: g(m, 6).trim(),
        source: 'tsc',
      });
      continue;
    }
    const global_ = TSC_GLOBAL_RE.exec(line);
    if (!global_) continue;
    problems.push({
      file: '',
      line: 0,
      column: 0,
      severity: sev(g(global_, 1)),
      code: g(global_, 2),
      message: g(global_, 3).trim(),
      source: 'tsc',
    });
  }
  return problems;
}

// ── cargo ───────────────────────────────────────────────────────────────────
// `cargo check --message-format=short` prints one line per diagnostic on
// stderr:
//   src/lib.rs:42:9: error[E0308]: mismatched types
//   src/lib.rs:7:1: warning: unused import
// Trailing summary lines ("error: could not compile ...") carry no file:line
// and are dropped — the real diagnostics above them say the same thing with a
// location attached.
const CARGO_RE = /^(.+?):(\d+):(\d+): (error|warning)(?:\[([A-Z]?\d+)\])?: (.*)$/;

export function parseCargo(out: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = CARGO_RE.exec(line.trim());
    if (!m) continue;
    problems.push({
      file: g(m, 1),
      line: num(m, 2),
      column: num(m, 3),
      severity: sev(g(m, 4)),
      code: m[5],
      message: g(m, 6).trim(),
      source: 'cargo',
    });
  }
  return problems;
}

// ── eslint ──────────────────────────────────────────────────────────────────
// `eslint --format compact` prints:
//   /abs/src/a.ts: line 3, col 1, Error - unexpected var. (no-unused-vars)
// The trailing rule in parens is optional — a parse error has no rule.
const ESLINT_RE =
  /^(.+?): line (\d+), col (\d+), (Error|Warning|Info) - (.*?)(?: \(([^()\s]+)\))?$/;

export function parseEslint(out: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = ESLINT_RE.exec(line.trim());
    if (!m) continue;
    problems.push({
      file: g(m, 1),
      line: num(m, 2),
      column: num(m, 3),
      severity: sev(g(m, 4).toLowerCase()),
      message: g(m, 5).trim(),
      code: m[6],
      source: 'eslint',
    });
  }
  return problems;
}

// ── ruff ────────────────────────────────────────────────────────────────────
// `ruff check --output-format=concise` prints:
//   src/app.py:3:1: F401 [*] os imported but unused
// Ruff has no severity axis — everything it reports is a lint violation, so
// they all land as warnings rather than pretending some are errors.
const RUFF_RE = /^(.+?):(\d+):(\d+): ([A-Z]+\d+)(?: \[\*\])? (.*)$/;

export function parseRuff(out: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = RUFF_RE.exec(line.trim());
    if (!m) continue;
    problems.push({
      file: g(m, 1),
      line: num(m, 2),
      column: num(m, 3),
      severity: 'warning',
      code: g(m, 4),
      message: g(m, 5).trim(),
      source: 'ruff',
    });
  }
  return problems;
}

// ── go vet ──────────────────────────────────────────────────────────────────
// `go vet ./...` prints to stderr:
//   ./main.go:12:2: unreachable code
// Column is optional; the leading package headers (lines starting `#`) are
// skipped.
const GOVET_RE = /^(.+?\.go):(\d+)(?::(\d+))?: (.*)$/;

export function parseGoVet(out: string): Problem[] {
  const problems: Problem[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const m = GOVET_RE.exec(line);
    if (!m) continue;
    problems.push({
      file: g(m, 1).replace(/^\.[/\\]/, ''),
      line: num(m, 2),
      column: num(m, 3),
      severity: 'error',
      message: g(m, 4).trim(),
      source: 'go vet',
    });
  }
  return problems;
}

/** The catalogue, in the order the panel offers them. */
export const CHECKERS: Checker[] = [
  {
    id: 'tsc',
    label: 'TypeScript',
    detect: ['tsconfig.json', 'tsconfig.base.json'],
    js: true,
    program: 'tsc',
    args: ['--noEmit', '--pretty', 'false'],
    parse: (stdout) => parseTsc(stdout),
  },
  {
    id: 'eslint',
    label: 'ESLint',
    detect: [
      'eslint.config.js',
      'eslint.config.mjs',
      '.eslintrc',
      '.eslintrc.json',
      '.eslintrc.cjs',
    ],
    js: true,
    program: 'eslint',
    args: ['.', '--format', 'compact'],
    parse: (stdout) => parseEslint(stdout),
  },
  {
    id: 'cargo',
    label: 'Cargo',
    detect: ['Cargo.toml'],
    program: 'cargo',
    // `--workspace` so a virtual manifest (no root package) still checks every
    // member rather than reporting nothing at all.
    args: ['check', '--workspace', '--message-format=short'],
    // Diagnostics go to stderr; stdout carries the artifact stream.
    parse: (_stdout, stderr) => parseCargo(stderr),
  },
  {
    id: 'ruff',
    label: 'Ruff',
    detect: ['pyproject.toml', 'ruff.toml', '.ruff.toml'],
    program: 'ruff',
    args: ['check', '--output-format=concise'],
    parse: (stdout) => parseRuff(stdout),
  },
  {
    id: 'govet',
    label: 'go vet',
    detect: ['go.mod'],
    program: 'go',
    args: ['vet', './...'],
    parse: (_stdout, stderr) => parseGoVet(stderr),
  },
];

/** Which checkers apply, given the file names present at the workspace root. */
export function detectCheckers(rootEntries: string[]): Checker[] {
  const present = new Set(rootEntries);
  return CHECKERS.filter((c) => c.detect.some((f) => present.has(f)));
}

/** Resolve a checker to the command that runs it, adding the JS package
 *  manager prefix where one is needed. */
export function checkerCommand(
  checker: Checker,
  manager: PackageManager,
): { program: string; args: string[] } {
  if (!checker.js) return { program: checker.program, args: checker.args };
  const base = jsRunner(manager, checker.program);
  return { program: base.program, args: [...base.args, ...checker.args] };
}

/** Stable identity for a problem, used to de-dupe repeat runs and overlapping
 *  checkers (tsc and eslint both flagging the same unused import). */
export function problemKey(p: Problem): string {
  return `${p.source}${p.file}${p.line}${p.column}${p.message}`;
}

/** Group by file, preserving first-seen file order and sorting each file's
 *  rows by position. */
export function groupByFile(problems: Problem[]): Array<[string, Problem[]]> {
  const groups = new Map<string, Problem[]>();
  for (const p of problems) {
    const list = groups.get(p.file);
    if (list) list.push(p);
    else groups.set(p.file, [p]);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.line - b.line || a.column - b.column);
  }
  return [...groups.entries()];
}

export function countBySeverity(problems: Problem[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const p of problems) {
    if (p.severity === 'error') errors += 1;
    else if (p.severity === 'warning') warnings += 1;
  }
  return { errors, warnings };
}
