import { beforeEach, describe, expect, it, vi } from 'vitest';

const started: unknown[] = [];
vi.mock('../../lib/tauri', async (orig) => ({
  ...(await orig<typeof import('../../lib/tauri')>()),
  claudeSessionLoad: async () => [
    { kind: 'user', payload: { text: 'fix it' } },
    { kind: 'tool_start', payload: { id: 't', name: 'Edit', input: { file_path: '/r/a.ts' } } },
    { kind: 'tool_result', payload: { id: 't', output: 'ok', is_error: false } },
    { kind: 'text_delta', payload: { text: 'Done.' } },
  ],
  claudeTurnStart: async (opts: unknown) => {
    started.push(opts);
    return 'claude://turn/1';
  },
  onClaudeTurn: async () => () => {},
}));

const { claudeWindow, __resetClaudeForTests } = await import('../claudeCode');

const prefs = {
  cwd: '/r',
  model: 'opus',
  permissionMode: 'manual' as const,
  sidebarHidden: false,
};

describe('claude code windows', () => {
  beforeEach(() => {
    __resetClaudeForTests();
    started.length = 0;
  });

  it('replays a recorded conversation and continues it', async () => {
    const w = claudeWindow('tab-1', prefs);
    await w.getState().loadSession('/r', 'sess-1');
    const s = w.getState();
    expect(s.sessionId).toBe('sess-1');
    expect(s.chat.map((c) => c.kind)).toEqual(['user', 'tool', 'assistant']);
    expect(s.editedFiles).toEqual([{ path: '/r/a.ts', tool: 'Edit', edits: 1 }]);

    await w.getState().send('and the tests');
    expect(started).toEqual([
      expect.objectContaining({
        cwd: '/r',
        resume: 'sess-1',
        model: 'opus',
        permissionMode: 'manual',
        content: [{ type: 'text', text: 'and the tests' }],
      }),
    ]);
  });

  it("runs each window's turns with its own settings", async () => {
    const w = claudeWindow('tab-1', prefs);
    w.setState({ model: 'haiku', permissionMode: 'plan', cwd: '/other' });
    await w.getState().send('hi');
    expect(started[0]).toEqual(
      expect.objectContaining({ cwd: '/other', model: 'haiku', permissionMode: 'plan', resume: null }),
    );
  });

  it('refuses to send a conversation another window is running', async () => {
    const a = claudeWindow('tab-a', prefs);
    const b = claudeWindow('tab-b', prefs);
    a.setState({ sessionId: 'sess-1', streaming: true });
    b.setState({ sessionId: 'sess-1' });

    await b.getState().send('me too');
    expect(started).toHaveLength(0);
    expect(b.getState().chat.at(-1)).toEqual({
      kind: 'error',
      message: 'This conversation is running in another window.',
    });
  });

  it('keeps windows independent', () => {
    const a = claudeWindow('tab-a', prefs);
    const b = claudeWindow('tab-b', prefs);
    a.setState({ sessionId: 'x' });
    expect(b.getState().sessionId).toBeNull();
    // Same tab id → same store, so a remount doesn't lose the conversation.
    expect(claudeWindow('tab-a', prefs)).toBe(a);
  });
});
