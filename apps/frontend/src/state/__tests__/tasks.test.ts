import { describe, expect, it } from 'vitest';
import { parsePackageScripts, runnerCommand } from '../tasks';

describe('parsePackageScripts', () => {
  it('returns the script names', () => {
    const raw = JSON.stringify({ scripts: { dev: 'vite', build: 'tsc && vite build' } });
    expect(parsePackageScripts(raw)).toEqual(['dev', 'build']);
  });

  it('ignores non-string script values and missing scripts', () => {
    expect(parsePackageScripts(JSON.stringify({ scripts: { a: 'x', b: 5 } }))).toEqual(['a']);
    expect(parsePackageScripts(JSON.stringify({ name: 'pkg' }))).toEqual([]);
  });

  it('returns [] on malformed JSON rather than throwing', () => {
    expect(parsePackageScripts('{ not json')).toEqual([]);
  });
});

describe('runnerCommand', () => {
  it('uses the manager-specific invocation', () => {
    expect(runnerCommand('pnpm', 'dev')).toBe('pnpm run dev');
    expect(runnerCommand('yarn', 'dev')).toBe('yarn dev');
    expect(runnerCommand('bun', 'dev')).toBe('bun run dev');
    expect(runnerCommand('npm', 'dev')).toBe('npm run dev');
  });
});
