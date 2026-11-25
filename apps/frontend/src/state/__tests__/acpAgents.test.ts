import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpConfigOption } from '../../lib/tauri';

const setCalls: unknown[][] = [];
let setResult: () => Promise<AcpConfigOption[]> = async () => [];
vi.mock('../../lib/tauri', async (orig) => ({
  ...(await orig<typeof import('../../lib/tauri')>()),
  acpSetConfig: (...args: unknown[]) => {
    setCalls.push(args);
    return setResult();
  },
}));

const { acpSession, chooseConfig, flatChoices, useAcpPrefs } = await import('../acpAgents');
const { __applyEventForTests: applyEvent } = await import('../claudeCode');

const model = (current: string): AcpConfigOption => ({
  id: 'model',
  name: 'Model',
  type: 'select',
  currentValue: current,
  options: [
    { value: 'a', name: 'A' },
    { value: 'b', name: 'B' },
  ],
});

describe('ACP agent config', () => {
  beforeEach(() => {
    setCalls.length = 0;
    useAcpPrefs.setState({ choices: {}, known: {} });
    acpSession('opencode-cli').setState({ sessionId: null, config: null });
  });

  it('takes the options an agent reports', () => {
    const store = acpSession('opencode-cli');
    applyEvent((fn) => store.setState(fn as never), {
      kind: 'config',
      payload: { options: [model('a')] },
    });
    expect(store.getState().config?.[0]?.currentValue).toBe('a');
  });

  it('only remembers a choice when no conversation is live', async () => {
    // The next conversation starts with it; there is nothing to change yet.
    await chooseConfig(acpSession('opencode-cli'), 'opencode-cli', 'model', 'b');
    expect(useAcpPrefs.getState().choices['opencode-cli']).toEqual({ model: 'b' });
    expect(setCalls).toEqual([]);
  });

  it("applies a choice to the live conversation and takes the agent's answer", async () => {
    const store = acpSession('opencode-cli');
    store.setState({ sessionId: 'ses_1', config: [model('a')] });
    // Changing the model can add options, so the store takes the whole list.
    const effort: AcpConfigOption = { ...model('low'), id: 'effort', name: 'Effort' };
    setResult = async () => [model('b'), effort];
    await chooseConfig(store, 'opencode-cli', 'model', 'b');
    expect(setCalls).toEqual([['ses_1', 'model', 'b']]);
    expect(store.getState().config?.map((o) => o.id)).toEqual(['model', 'effort']);
  });

  it('snaps back when the agent refuses', async () => {
    const store = acpSession('opencode-cli');
    store.setState({ sessionId: 'ses_1', config: [model('a')] });
    setResult = async () => {
      throw new Error('nope');
    };
    await chooseConfig(store, 'opencode-cli', 'model', 'b');
    expect(store.getState().config?.[0]?.currentValue).toBe('a');
  });

  it('flattens grouped choices', () => {
    const grouped: AcpConfigOption = {
      ...model('a'),
      options: [
        { group: 'g', name: 'Group', options: [{ value: 'x', name: 'X' }] },
        { value: 'y', name: 'Y' },
      ],
    };
    expect(flatChoices(grouped).map((c) => c.value)).toEqual(['x', 'y']);
  });
});
