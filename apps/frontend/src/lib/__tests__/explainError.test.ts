import { describe, expect, it } from 'vitest';
import { buildExplainMessages, EXPLAIN_SYSTEM } from '../explainError';

describe('buildExplainMessages', () => {
  it('embeds command, exit code, cwd, and output', () => {
    const { system, messages } = buildExplainMessages({
      command: 'cargo build',
      exitCode: 101,
      output: 'error[E0433]: failed to resolve',
      cwd: '/home/u/proj',
    });
    expect(system).toBe(EXPLAIN_SYSTEM);
    const content = messages[0]!.content;
    expect(content).toContain('cargo build');
    expect(content).toContain('101');
    expect(content).toContain('/home/u/proj');
    expect(content).toContain('E0433');
  });

  it('notes when no output was captured', () => {
    const { messages } = buildExplainMessages({
      command: 'ls',
      exitCode: 2,
      output: null,
    });
    expect(messages[0]!.content).toContain('(none captured)');
  });

  it('caps very long output to the tail', () => {
    const big = 'x'.repeat(10_000) + 'TAIL_MARKER';
    const { messages } = buildExplainMessages({ command: 'x', exitCode: 1, output: big });
    expect(messages[0]!.content).toContain('TAIL_MARKER');
    expect(messages[0]!.content.length).toBeLessThan(5000);
  });
});
