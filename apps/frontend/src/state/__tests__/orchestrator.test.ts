import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

vi.mock('../../lib/notifyEvent', () => ({ notifyEvent: () => {} }));

const { childMode, lastReply, runTool, useOrchestrator } = await import('../orchestrator');
const { registerChat, unregisterChat } = await import('../agentSessions');
type ClaudeSession = import('../claudeCode').ClaudeSession;

function fakeSession(extra: Partial<ClaudeSession> = {}) {
  return create<ClaudeSession>()(
    () =>
      ({
        sessionId: 's',
        chat: [],
        streaming: false,
        pending: null,
        costUsd: 0,
        editedFiles: [],
        cancel: async () => {},
        ...extra,
      }) as unknown as ClaudeSession,
  );
}

describe('helper permission mode', () => {
  it('is the default, but never looser than a Claude parent', () => {
    expect(childMode('acceptEdits', undefined)).toBe('acceptEdits');
    expect(childMode('acceptEdits', 'plan')).toBe('plan');
    expect(childMode('acceptEdits', 'bypassPermissions')).toBe('acceptEdits');
  });
});

describe('a helper reply', () => {
  it('is every answer after the last prompt', () => {
    const s = {
      chat: [
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'old' },
        { kind: 'user', text: 'second' },
        { kind: 'tool', id: 't', name: 'bash', input: {} },
        { kind: 'assistant', text: 'new' },
        { kind: 'error', message: 'budget' },
      ],
    } as unknown as ClaudeSession;
    expect(lastReply(s)).toBe('new\n\n[error] budget');
  });
});

describe('orchestrator tools', () => {
  beforeEach(() => {
    useOrchestrator.setState({ helpers: {} });
    unregisterChat('window:h1');
  });

  const helper = (parent = 'panel:claude') =>
    useOrchestrator.setState({
      helpers: {
        h1: { id: 'h1', parent, agent: 'claude', label: 'Claude Code', depth: 1, worktree: null },
      },
    });

  it("refuses helpers the caller didn't start", async () => {
    helper('panel:opencode-cli');
    registerChat(
      'window:h1',
      'Claude Code',
      { kind: 'window', tabId: 'h1' },
      fakeSession(),
      () => '/r',
    );
    await expect(runTool('panel:claude', 'wait_for_agent', { id: 'h1' })).rejects.toThrow(
      /No helper "h1"/,
    );
  });

  it('waits for a helper to finish and returns its reply and edits', async () => {
    helper();
    const store = fakeSession({ streaming: true, chat: [{ kind: 'user', text: 'go' }] });
    registerChat('window:h1', 'Claude Code', { kind: 'window', tabId: 'h1' }, store, () => '/r');
    const waiting = runTool('panel:claude', 'wait_for_agent', { id: 'h1', timeout_seconds: 5 });
    store.setState({
      streaming: false,
      chat: [
        { kind: 'user', text: 'go' },
        { kind: 'assistant', text: 'done it' },
      ],
      editedFiles: [{ path: '/r/a.ts', tool: 'Edit', edits: 1 }],
    });
    expect(JSON.parse(await waiting)).toMatchObject({
      status: 'done',
      reply: 'done it',
      edited_files: ['/r/a.ts'],
    });
  });

  it('returns early when a helper is waiting on the user', async () => {
    helper();
    const store = fakeSession({
      streaming: true,
      pending: { requestId: '1', tool: 'Bash', title: null, summary: 'ls' } as never,
    });
    registerChat('window:h1', 'Claude Code', { kind: 'window', tabId: 'h1' }, store, () => '/r');
    const out = JSON.parse(await runTool('panel:claude', 'wait_for_agent', { id: 'h1' }));
    expect(out.status).toBe('waiting_for_user');
    expect(out.waiting_for).toContain('Allow Bash?');
  });

  it("won't send to a helper that is still working", async () => {
    helper();
    registerChat(
      'window:h1',
      'Claude Code',
      { kind: 'window', tabId: 'h1' },
      fakeSession({ streaming: true }),
      () => '/r',
    );
    await expect(
      runTool('panel:claude', 'send_message', { id: 'h1', message: 'more' }),
    ).rejects.toThrow(/still working/);
  });

  it('rejects unknown tools', async () => {
    await expect(runTool('panel:claude', 'rm_rf', {})).rejects.toThrow(/Unknown tool/);
  });
});
