import { describe, expect, it } from 'vitest';
import { lspServerFor, lspSupportedLanguages } from '../lspServers';

describe('lspServerFor', () => {
  it('returns null for unknown or null languages', () => {
    expect(lspServerFor(null)).toBeNull();
    expect(lspServerFor('plain')).toBeNull();
    expect(lspServerFor('json')).toBeNull();
  });

  it('shares one session across the TS/JS family but varies languageId', () => {
    const ts = lspServerFor('typescript')!;
    const tsx = lspServerFor('typescript-jsx')!;
    const jsx = lspServerFor('javascript-jsx')!;
    expect(ts.sessionId).toBe('typescript-language-server');
    expect(tsx.sessionId).toBe('typescript-language-server');
    expect(ts.languageId).toBe('typescript');
    expect(tsx.languageId).toBe('typescriptreact');
    expect(jsx.languageId).toBe('javascriptreact');
    expect(ts.args).toEqual(['--stdio']);
  });

  it('maps rust/go/python/cpp to their conventional servers', () => {
    expect(lspServerFor('rust')!.command).toBe('rust-analyzer');
    expect(lspServerFor('go')!.command).toBe('gopls');
    expect(lspServerFor('python')!.command).toBe('pyright-langserver');
    expect(lspServerFor('cpp')!.command).toBe('clangd');
  });

  it('applies a command/args override keyed by sessionId', () => {
    const overridden = lspServerFor('rust', {
      'rust-analyzer': { command: '/opt/ra/rust-analyzer', args: ['--log'] },
    })!;
    expect(overridden.command).toBe('/opt/ra/rust-analyzer');
    expect(overridden.args).toEqual(['--log']);
    // sessionId + languageId are preserved.
    expect(overridden.sessionId).toBe('rust-analyzer');
    expect(overridden.languageId).toBe('rust');
  });

  it('ignores an override that targets a different session', () => {
    const ts = lspServerFor('typescript', { 'rust-analyzer': { command: 'x' } })!;
    expect(ts.command).toBe('typescript-language-server');
  });

  it('lists supported languages', () => {
    expect(lspSupportedLanguages()).toContain('rust');
    expect(lspSupportedLanguages()).toContain('typescript');
  });
});
