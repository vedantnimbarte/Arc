import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes: [string, string][] = [];
vi.mock('../../lib/tauri', async (orig) => ({
  ...(await orig<typeof import('../../lib/tauri')>()),
  ptyWrite: async (id: string, data: string) => void writes.push([id, data]),
}));

const { useWorkspace, singleLeafLayout } = await import('../workspace');
const { useAgentQueue, SUBMIT_DELAY_MS } = await import('../agentQueue');
const { registerTerminal } = await import('../../lib/terminalRegistry');

// The queue types into a live agent on its own, so the failure modes are
// sending twice into one turn, sending while the user is answering a prompt,
// and sending into a plain shell that would run the text as a command.

const pasted: string[] = [];
registerTerminal('agent', { paste: (t) => pasted.push(t), selection: () => '', focus: () => {} });
registerTerminal('shell', { paste: (t) => pasted.push(t), selection: () => '', focus: () => {} });

const q = () => useAgentQueue.getState();
const waiting = (id: string, on: boolean) => useWorkspace.getState().setAgentWaiting(id, on ? 'done' : null);

beforeEach(() => {
  vi.useFakeTimers();
  pasted.length = 0;
  writes.length = 0;
  useAgentQueue.setState({ queues: {} });
  useWorkspace.setState({
    tabs: [
      { id: 'agent', title: 'Claude', kind: 'terminal', ptyId: 'p1', shellOverride: 'claude' },
      { id: 'shell', title: 'pwsh', kind: 'terminal', ptyId: 'p2' },
    ],
    layout: singleLeafLayout(['agent', 'shell'], 'agent'),
    agentWaiting: {},
  });
});

describe('agent prompt queue', () => {
  it('sends exactly one prompt per waiting transition, then submits', async () => {
    q().add('agent', 'first');
    q().add('agent', 'second');
    waiting('agent', true);
    // Still waiting — another update to the same wait must not send again.
    waiting('agent', true);
    expect(pasted).toEqual(['first']);
    expect(writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(SUBMIT_DELAY_MS);
    expect(writes).toEqual([['p1', '\r']]);

    waiting('agent', false); // the agent works on it
    waiting('agent', true);
    expect(pasted).toEqual(['first', 'second']);
    expect(q().queues.agent!.items).toEqual([]);
  });

  it('holds while paused and resumes on the next wait', () => {
    q().add('agent', 'later');
    q().setPaused('agent', true);
    waiting('agent', true);
    expect(pasted).toEqual([]);
    q().setPaused('agent', false);
    waiting('agent', false);
    waiting('agent', true);
    expect(pasted).toEqual(['later']);
  });

  it('pauses when the user types into a tab with prompts queued', () => {
    q().noteInput('agent'); // nothing queued: nothing to pause
    expect(q().queues.agent).toBeUndefined();
    q().add('agent', 'x');
    q().noteInput('agent');
    expect(q().queues.agent!.paused).toBe(true);
    waiting('agent', true);
    expect(pasted).toEqual([]);
    // "Send next now" is the user's explicit call and ignores the pause.
    expect(q().sendNext('agent')).toBe(true);
    expect(pasted).toEqual(['x']);
  });

  it('never queues for a tab that is not an agent', () => {
    expect(q().add('shell', 'rm -rf /')).toBe(false);
    expect(q().sendNext('shell')).toBe(false);
    expect(pasted).toEqual([]);
  });

  it('reorders and removes', () => {
    q().add('agent', 'a');
    q().add('agent', 'b');
    const [a, b] = q().queues.agent!.items;
    q().move('agent', b!.id, -1);
    expect(q().queues.agent!.items.map((i) => i.text)).toEqual(['b', 'a']);
    q().remove('agent', a!.id);
    expect(q().queues.agent!.items.map((i) => i.text)).toEqual(['b']);
  });

  it('drops the queue when the tab closes', () => {
    q().add('agent', 'orphan');
    useWorkspace.getState().closeTab('agent');
    expect(q().queues.agent).toBeUndefined();
  });
});
