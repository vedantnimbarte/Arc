import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

const notified: { title: string; body?: string; target?: unknown }[] = [];
vi.mock('../../lib/notifyEvent', () => ({
  notifyEvent: (n: { title: string; body?: string; target?: unknown }) => void notified.push(n),
}));

const { registerChat, unregisterChat, useChatSessions, waitingQueue } =
  await import('../agentSessions');
type ClaudeSession = import('../claudeCode').ClaudeSession;

/** Just the fields the registry reads. */
function fakeSession() {
  return create<ClaudeSession>()(
    () =>
      ({
        sessionId: null,
        chat: [],
        streaming: false,
        pending: null,
        costUsd: 0,
      }) as unknown as ClaudeSession,
  );
}

const pending = {
  requestId: '1',
  tool: 'bash',
  input: {},
  title: 'bash',
  description: null,
  summary: 'rm -rf build',
};

describe('chat session registry', () => {
  beforeEach(() => {
    notified.length = 0;
    unregisterChat('w');
  });

  it('lists a surface only once it holds a conversation', () => {
    const s = fakeSession();
    registerChat('w', 'OpenCode', { kind: 'window', tabId: 't1' }, s, () => '/r/app');
    expect(useChatSessions.getState().snaps.w?.status).toBeNull();

    s.setState({ chat: [{ kind: 'user', text: 'fix the build\nplease' }], streaming: true });
    expect(useChatSessions.getState().snaps.w).toMatchObject({
      status: 'working',
      title: 'fix the build',
      cwd: '/r/app',
    });
  });

  it('notifies when a chat needs the user, and counts only permissions as waiting', () => {
    const s = fakeSession();
    registerChat('w', 'OpenCode', { kind: 'window', tabId: 't1' }, s, () => null);
    s.setState({ chat: [{ kind: 'user', text: 'go' }], streaming: true });

    s.setState({ pending });
    expect(useChatSessions.getState().snaps.w).toMatchObject({
      status: 'waiting',
      pending: true,
      detail: 'Allow bash?',
    });
    expect(notified.at(-1)).toMatchObject({
      title: 'OpenCode is waiting on you',
      target: { kind: 'tab', tabId: 't1' },
    });

    s.setState({ pending: null });
    s.setState({ streaming: false });
    expect(useChatSessions.getState().snaps.w).toMatchObject({ status: 'done', pending: false });
    expect(notified.at(-1)).toMatchObject({ title: 'OpenCode finished', body: 'go' });
  });

  it('reports a turn that ended in an error as such', () => {
    const s = fakeSession();
    registerChat('w', 'Gemini CLI', { kind: 'panel', provider: 'gemini-cli' }, s, () => null);
    s.setState({ chat: [{ kind: 'user', text: 'go' }], streaming: true });
    s.setState({
      streaming: false,
      chat: [
        { kind: 'user', text: 'go' },
        { kind: 'error', message: 'not signed in' },
      ],
    });
    expect(notified.at(-1)).toMatchObject({
      title: 'Gemini CLI stopped with an error',
      body: 'not signed in',
      target: { kind: 'sidebar', view: 'sessions' },
    });
  });

  it('stops watching on unregister', () => {
    const s = fakeSession();
    registerChat('w', 'OpenCode', { kind: 'window', tabId: 't1' }, s, () => null);
    unregisterChat('w');
    s.setState({ chat: [{ kind: 'user', text: 'go' }], streaming: true });
    expect(useChatSessions.getState().snaps.w).toBeUndefined();
  });

  it('queues everything waiting, longest wait first', () => {
    const q = waitingQueue({ tabA: { at: 30 }, tabB: { at: 10 } }, {
      c: { key: 'c', pending: true, at: 20 },
      d: { key: 'd', pending: false, at: 5 },
    } as never);
    expect(q.map((x) => (x.kind === 'tab' ? x.tabId : x.snap.key))).toEqual(['tabB', 'c', 'tabA']);
  });
});
