import { describe, expect, it } from 'vitest';
import { problemsPrompt } from '../agentPrompt';
import type { Problem } from '../problemMatchers';

const p = (over: Partial<Problem> = {}): Problem => ({
  file: 'src/app.ts',
  line: 12,
  column: 4,
  severity: 'error',
  message: 'Type string is not assignable to number',
  source: 'tsc',
  ...over,
});

describe('problemsPrompt', () => {
  it('keeps file:line:col so the agent can open what the checker flagged', () => {
    expect(problemsPrompt([p()])).toContain('src/app.ts:12:4');
  });

  it('omits the parts the checker did not report', () => {
    expect(problemsPrompt([p({ column: 0 })])).toContain('src/app.ts:12 —');
    expect(problemsPrompt([p({ line: 0, column: 0 })])).toMatch(/src\/app\.ts\s+—/);
  });

  it('groups by file so the list reads in fixing order', () => {
    const text = problemsPrompt([
      p({ file: 'a.ts', line: 1 }),
      p({ file: 'b.ts', line: 2 }),
      p({ file: 'a.ts', line: 3 }),
    ]);
    // Both of a.ts's problems appear before b.ts's heading.
    expect(text.indexOf('a.ts:3')).toBeLessThan(text.indexOf('b.ts:2'));
  });

  it('ranks errors above warnings', () => {
    const text = problemsPrompt([
      p({ file: 'w.ts', severity: 'warning', message: 'unused' }),
      p({ file: 'e.ts', severity: 'error', message: 'broken' }),
    ]);
    expect(text.indexOf('broken')).toBeLessThan(text.indexOf('unused'));
  });

  it('truncates a runaway checker and says it did', () => {
    const many = Array.from({ length: 60 }, (_, i) => p({ line: i + 1 }));
    const text = problemsPrompt(many);
    expect(text).toContain('36 further problems are reported');
    // The cap is on problems, not files — the surviving lines are all there.
    expect(text.split('\n').filter((l) => l.includes('src/app.ts:'))).toHaveLength(24);
  });

  it('drops warnings before errors when truncating', () => {
    const errors = Array.from({ length: 24 }, (_, i) => p({ line: i + 1 }));
    const warning = p({ severity: 'warning', message: 'SHOULD-BE-DROPPED', line: 99 });
    const text = problemsPrompt([warning, ...errors]);
    expect(text).not.toContain('SHOULD-BE-DROPPED');
  });

  it('flattens a multi-line diagnostic onto one line', () => {
    const text = problemsPrompt([p({ message: 'expected\n  found\n  note: here' })]);
    expect(text).toContain('expected found note: here');
  });

  it('includes the rule code, which is what an agent searches for', () => {
    expect(problemsPrompt([p({ code: 'TS2345' })])).toContain('[TS2345]');
  });

  it('counts correctly for a single problem', () => {
    expect(problemsPrompt([p()])).toContain('the following problem reported');
  });
});
