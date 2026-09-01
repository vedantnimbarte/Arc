import { describe, expect, it } from 'vitest';
import {
  checkerCommand,
  countBySeverity,
  detectCheckers,
  groupByFile,
  parseCargo,
  parseEslint,
  parseGoVet,
  parseRuff,
  parseTsc,
  CHECKERS,
} from '../problemMatchers';

describe('parseTsc', () => {
  it('reads file, position, code and message', () => {
    const out = [
      "src/app.ts(12,5): error TS2345: Argument of type 'x' is not assignable.",
      'packages/ui/src/Button.tsx(3,1): warning TS6133: unused.',
    ].join('\n');
    const problems = parseTsc(out);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({
      file: 'src/app.ts',
      line: 12,
      column: 5,
      severity: 'error',
      code: 'TS2345',
      source: 'tsc',
    });
    expect(problems[1]!.severity).toBe('warning');
  });

  it('keeps a project-level error that has no line/column', () => {
    const problems = parseTsc("error TS5023: Unknown compiler option 'nope'.");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ line: 0, column: 0, code: 'TS5023' });
  });

  it('ignores lines that are not diagnostics', () => {
    expect(parseTsc('Files: 42\nLines: 9001\n\n')).toEqual([]);
  });
});

describe('parseCargo', () => {
  it('reads short-format diagnostics with and without a code', () => {
    const out = [
      'rust/git/src/lib.rs:42:9: error[E0308]: mismatched types',
      'rust/pty/src/lib.rs:7:1: warning: unused import: `std::fmt`',
      'error: could not compile `arc-git` (lib) due to 1 previous error',
    ].join('\n');
    const problems = parseCargo(out);
    // The trailing summary has no file:line, so it must not become a row.
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({
      file: 'rust/git/src/lib.rs',
      line: 42,
      column: 9,
      severity: 'error',
      code: 'E0308',
    });
    expect(problems[1]).toMatchObject({ severity: 'warning', code: undefined });
  });
});

describe('parseEslint', () => {
  it('reads compact format, with the rule optional', () => {
    const out = [
      '/repo/src/a.ts: line 3, col 1, Error - Unexpected var. (no-var)',
      '/repo/src/b.ts: line 9, col 4, Warning - Missing semi.',
    ].join('\n');
    const problems = parseEslint(out);
    expect(problems[0]).toMatchObject({
      file: '/repo/src/a.ts',
      line: 3,
      column: 1,
      severity: 'error',
      code: 'no-var',
      message: 'Unexpected var.',
    });
    expect(problems[1]).toMatchObject({ severity: 'warning', code: undefined });
    expect(problems[1]!.message).toBe('Missing semi.');
  });
});

describe('parseRuff', () => {
  it('reads concise format and strips the autofix marker', () => {
    const out = [
      'src/app.py:3:1: F401 [*] `os` imported but unused',
      'src/app.py:11:5: E741 ambiguous variable name',
    ].join('\n');
    const problems = parseRuff(out);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({ code: 'F401', line: 3, severity: 'warning' });
    expect(problems[0]!.message).toBe('`os` imported but unused');
    expect(problems[1]!.code).toBe('E741');
  });
});

describe('parseGoVet', () => {
  it('reads locations, drops package headers and normalizes ./', () => {
    const out = ['# example.com/m', './main.go:12:2: unreachable code', './util.go:3: bad printf'].join(
      '\n',
    );
    const problems = parseGoVet(out);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatchObject({ file: 'main.go', line: 12, column: 2 });
    // No column reported — the row still opens the file at the right line.
    expect(problems[1]).toMatchObject({ file: 'util.go', line: 3, column: 0 });
  });
});

describe('detectCheckers', () => {
  it('picks only the checkers whose marker files are present', () => {
    const ids = detectCheckers(['Cargo.toml', 'tsconfig.json', 'README.md']).map((c) => c.id);
    expect(ids).toEqual(['tsc', 'cargo']);
  });

  it('returns nothing for a workspace with no recognised project files', () => {
    expect(detectCheckers(['notes.txt'])).toEqual([]);
  });
});

describe('checkerCommand', () => {
  const tsc = CHECKERS.find((c) => c.id === 'tsc')!;
  const cargo = CHECKERS.find((c) => c.id === 'cargo')!;

  it('routes JS binaries through the detected package manager', () => {
    expect(checkerCommand(tsc, 'pnpm')).toEqual({
      program: 'pnpm',
      args: ['exec', 'tsc', '--noEmit', '--pretty', 'false'],
    });
    expect(checkerCommand(tsc, 'npm').program).toBe('npx');
    expect(checkerCommand(tsc, 'yarn')).toEqual({
      program: 'yarn',
      args: ['tsc', '--noEmit', '--pretty', 'false'],
    });
  });

  it('leaves non-JS checkers alone whatever the package manager', () => {
    expect(checkerCommand(cargo, 'pnpm')).toEqual({
      program: 'cargo',
      args: ['check', '--workspace', '--message-format=short'],
    });
  });
});

describe('groupByFile / countBySeverity', () => {
  const problems = parseTsc(
    [
      'src/b.ts(9,1): error TS1: later in b',
      'src/a.ts(2,1): warning TS2: in a',
      'src/b.ts(3,1): error TS3: earlier in b',
    ].join('\n'),
  );

  it('groups in first-seen file order, sorted by position within a file', () => {
    const groups = groupByFile(problems);
    expect(groups.map(([file]) => file)).toEqual(['src/b.ts', 'src/a.ts']);
    expect(groups[0]![1].map((p) => p.line)).toEqual([3, 9]);
  });

  it('counts errors and warnings separately', () => {
    expect(countBySeverity(problems)).toEqual({ errors: 2, warnings: 1 });
  });
});
