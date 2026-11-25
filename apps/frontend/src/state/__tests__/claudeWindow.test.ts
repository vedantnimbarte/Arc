import { beforeEach, describe, expect, it, vi } from 'vitest';

const started: unknown[] = [];
const order: [string, string][] = [];
vi.mock('../../lib/tauri', async (orig) => ({
  ...(await orig<typeof import('../../lib/tauri')>()),
  claudeSessionLoad: async () => [
    { kind: 'user', payload: { text: 'fix it' } },
    { kind: 'tool_start', payload: { id: 't', name: 'Edit', input: { file_path: '/r/a.ts' } } },
    { kind: 'tool_result', payload: { id: 't', output: 'ok', is_error: false } },
    { kind: 'text_delta', payload: { text: 'Done.' } },
  ],
  claudeTurnStart: async (opts: { topic: string }) => {
    started.push(opts);
    order.push(['start', opts.topic]);
    return opts.topic;
  },
  onClaudeTurn: async (topic: string) => {
    order.push(['listen', topic]);
    return () => {};
  },
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
      expect.objectContaining({
        cwd: '/other',
        model: 'haiku',
        permissionMode: 'plan',
        resume: null,
      }),
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

describe('turn events', () => {
  beforeEach(() => {
    __resetClaudeForTests();
    order.length = 0;
  });

  it('are listened for before the turn starts', async () => {
    // A fast agent's first events arrive before the start call returns; an
    // event nobody listens for yet is lost.
    const w = claudeWindow('tab-1', prefs);
    await w.getState().send('hi');
    expect(order.map(([what]) => what)).toEqual(['listen', 'start']);
    expect(order[0]![1]).toBe(order[1]![1]);
    expect(w.getState().activeTopic).toBe(order[0]![1]);
  });
});

describe('slash commands on send', () => {
  beforeEach(() => {
    __resetClaudeForTests();
    started.length = 0;
  });

  it('shows what was typed and sends the expansion', async () => {
    const w = claudeWindow('tab-1', prefs);
    await w.getState().send('/advisor should this be a queue?');
    expect(w.getState().chat[0]).toEqual({
      kind: 'user',
      text: '/advisor should this be a queue?',
    });
    const sent = (started[0] as { content: { text: string }[] }).content[0]!.text;
    expect(sent).toContain('Get a second opinion from another agent on: should this be a queue?');
  });
});

describe('agent windows over another transport', () => {
  beforeEach(() => __resetClaudeForTests());

  const transport = () => {
    const closed: string[] = [];
    return {
      closed,
      t: {
        ready: () => true,
        start: async () => 'acp://turn/1',
        respond: async () => {},
        cancel: async () => {},
        close: (id: string) => void closed.push(id),
        load: async () => [
          { kind: 'user', payload: { text: 'fix ' } },
          { kind: 'user_delta', payload: { text: 'it' } },
          { kind: 'text_delta', payload: { text: 'Done.' } },
        ],
      },
    };
  };

  it('loads through the transport, joining replayed prompt chunks', async () => {
    const { t } = transport();
    const w = claudeWindow('tab-acp', prefs, t);
    await w.getState().loadSession('/r', 'ses_1');
    expect(w.getState().sessionId).toBe('ses_1');
    expect(w.getState().chat).toEqual([
      { kind: 'user', text: 'fix it' },
      { kind: 'assistant', text: 'Done.' },
    ]);
  });

  it('closes the conversation it leaves for another', async () => {
    // Each ACP conversation is a running agent; switching must not leak one.
    const { t, closed } = transport();
    const w = claudeWindow('tab-acp', prefs, t);
    await w.getState().loadSession('/r', 'ses_1');
    await w.getState().loadSession('/r', 'ses_2');
    expect(closed).toEqual(['ses_1']);
  });

  it('hands a conversation over without closing it', async () => {
    const { takeConversation } = await import('../claudeCode');
    const { t, closed } = transport();
    const from = claudeWindow('tab-a', prefs, t);
    await from.getState().loadSession('/r', 'ses_1');
    const taken = takeConversation(from);
    expect(taken).toMatchObject({
      sessionId: 'ses_1',
      chat: [{ kind: 'user' }, { kind: 'assistant' }],
    });
    expect(from.getState().sessionId).toBeNull();
    expect(from.getState().chat).toEqual([]);
    expect(closed).toEqual([]);

    from.setState({ sessionId: 'ses_2', streaming: true });
    expect(takeConversation(from)).toBeNull();
  });
});
