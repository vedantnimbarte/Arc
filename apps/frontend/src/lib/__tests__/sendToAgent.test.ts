import { describe, expect, it, vi } from 'vitest';

vi.mock('../../state/claudeCode', () => ({ useClaudeCode: { getState: () => ({ status: 'idle' }) } }));

const { pickAgentTab } = await import('../sendToAgent');
const { hunkPrompt, testFailurePrompt } = await import('../agentPrompt');

const tab = (id: string, agent = true) => ({
  id,
  title: id,
  kind: 'terminal' as const,
  ptyId: `pty-${id}`,
  ...(agent ? { shellOverride: '/bin/claude' } : {}),
});

describe('pickAgentTab', () => {
  const tabs = [tab('shell', false), tab('a'), tab('b'), tab('c')];

  it('prefers the active agent, then the longest-waiting, then the newest', () => {
    expect(pickAgentTab(tabs, 'b', { a: { at: 1 } })?.id).toBe('b');
    expect(pickAgentTab(tabs, 'shell', { c: { at: 5 }, a: { at: 2 } })?.id).toBe('a');
    expect(pickAgentTab(tabs, 'shell', {})?.id).toBe('c');
  });

  it('ignores plain shells and agents without a live PTY', () => {
    expect(pickAgentTab([tab('shell', false), { ...tab('dead'), ptyId: undefined }], null, {})).toBeNull();
  });
});

describe('prompts', () => {
  it('keeps the tail of long output', () => {
    const text = testFailurePrompt('vitest run', `${'x'.repeat(9000)}THE END`);
    expect(text).toContain('THE END');
    expect(text).toContain('earlier output trimmed');
  });

  it('fences a hunk as a diff', () => {
    expect(hunkPrompt('src/a.ts', '@@ -1 +1 @@\n-a\n+b')).toContain('```diff\n@@ -1 +1 @@');
  });
});
