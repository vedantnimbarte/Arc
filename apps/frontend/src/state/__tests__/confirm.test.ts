import { describe, expect, it, beforeEach } from 'vitest';
import { askConfirm, askText, useConfirm } from '../confirm';

const reset = () => useConfirm.setState({ pending: null });

describe('confirm store', () => {
  beforeEach(reset);

  it('resolves true only when settled with a value', async () => {
    const yes = askConfirm({ title: 'go?' });
    useConfirm.getState().settle('');
    expect(await yes).toBe(true);

    const no = askConfirm({ title: 'go?' });
    useConfirm.getState().settle(null);
    expect(await no).toBe(false);
  });

  it('hands back the typed text, trimmed by the dialog', async () => {
    const p = askText('Name it', { label: 'Name' });
    useConfirm.getState().settle('billing');
    expect(await p).toBe('billing');
  });

  it('cancels a superseded ask instead of leaving it pending', async () => {
    const first = askConfirm({ title: 'first' });
    const second = askConfirm({ title: 'second' });
    expect(useConfirm.getState().pending?.title).toBe('second');
    expect(await first).toBe(false);
    useConfirm.getState().settle('');
    expect(await second).toBe(true);
  });

  it('ignores a settle with nothing pending', () => {
    expect(() => useConfirm.getState().settle('')).not.toThrow();
  });
});
