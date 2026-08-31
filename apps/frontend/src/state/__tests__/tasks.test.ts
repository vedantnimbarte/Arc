import { describe, expect, it } from 'vitest';
import {
  parseJustRecipes,
  parseMakeTargets,
  parsePackageScripts,
  runnerCommand,
  taskTitle,
} from '../tasks';

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

describe('parseMakeTargets', () => {
  it('finds plain targets, with and without prerequisites', () => {
    const mk = ['build:', 'test: build', 'clean:'].join('\n');
    expect(parseMakeTargets(mk)).toEqual(['build', 'test', 'clean']);
  });

  it('splits multiple targets declared on one line', () => {
    expect(parseMakeTargets('lint fmt:\n\techo hi')).toEqual(['lint', 'fmt']);
  });

  it('ignores recipe bodies, which can contain colons of their own', () => {
    // The `curl` line is indented with a tab: it belongs to `deploy`, and
    // reading it as a target would offer a nonsense `curl -H "Accept" task.
    const mk = 'deploy:\n\tcurl -H "Accept: application/json" https://x/y\n';
    expect(parseMakeTargets(mk)).toEqual(['deploy']);
  });

  it('ignores assignments, pattern rules, directives, and computed names', () => {
    const mk = [
      'CC := gcc',
      'CFLAGS ::= -O2',
      'OUT = build',
      '.PHONY: build',
      '%.o: %.c',
      '$(BIN): $(OBJ)',
      '# comment: not a target',
      'build:',
    ].join('\n');
    expect(parseMakeTargets(mk)).toEqual(['build']);
  });

  it('de-duplicates a target declared twice', () => {
    expect(parseMakeTargets('build:\nbuild: extra\n')).toEqual(['build']);
  });

  it('returns [] for an empty file', () => {
    expect(parseMakeTargets('')).toEqual([]);
  });
});

describe('parseJustRecipes', () => {
  it('finds recipes, including ones that take parameters', () => {
    const jf = ['build:', '    cargo build', 'test target:', '    cargo test {{target}}'].join('\n');
    expect(parseJustRecipes(jf)).toEqual(['build', 'test']);
  });

  it('ignores assignments, settings, aliases, imports, and comments', () => {
    const jf = [
      '# a comment',
      'set shell := ["bash", "-c"]',
      'export FOO := "bar"',
      'version := "1.0"',
      'alias b := build',
      'import "other.just"',
      'build:',
    ].join('\n');
    expect(parseJustRecipes(jf)).toEqual(['build']);
  });

  it('hides private recipes, both spellings', () => {
    const jf = ['_helper:', '[private]', 'internal:', 'public:'].join('\n');
    expect(parseJustRecipes(jf)).toEqual(['public']);
  });

  it('applies a [private] attribute only to the recipe directly after it', () => {
    const jf = ['[private]', 'hidden:', 'shown:'].join('\n');
    expect(parseJustRecipes(jf)).toEqual(['shown']);
  });

  it('ignores indented recipe bodies containing colons', () => {
    const jf = 'deploy:\n    curl -H "Accept: application/json" https://x\n';
    expect(parseJustRecipes(jf)).toEqual(['deploy']);
  });

  it('returns [] for an empty file', () => {
    expect(parseJustRecipes('')).toEqual([]);
  });
});

describe('taskTitle', () => {
  it('leaves node scripts unqualified', () => {
    expect(taskTitle({ name: 'dev', command: 'pnpm run dev', source: 'node' })).toBe('Run: dev');
  });

  it('names the source for make and just, so same-named tasks stay distinct', () => {
    expect(taskTitle({ name: 'build', command: 'make build', source: 'make' })).toBe(
      'Run: build (make)',
    );
    expect(taskTitle({ name: 'build', command: 'just build', source: 'just' })).toBe(
      'Run: build (just)',
    );
  });
});
