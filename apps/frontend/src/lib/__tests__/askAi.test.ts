import { describe, expect, it, vi } from 'vitest';
import { withAskAiFallback } from '../askAi';
import type { CommandAction } from '../../state/commands';

const action = (id: string): CommandAction => ({ id, title: id, group: 'View', run: () => {} });

describe('withAskAiFallback', () => {
  it('appends an Ask AI row that sends the trimmed query when few commands match', async () => {
    const ask = vi.fn();
    const rows = withAskAiFallback([action('a')], '  refactor the parser ', ask);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.title).toBe('Ask AI: refactor the parser');
    await rows[1]!.run();
    expect(ask).toHaveBeenCalledWith('refactor the parser');
  });

  it('stays out of the way when enough commands match or the query is too short', () => {
    const many = [action('a'), action('b'), action('c')];
    expect(withAskAiFallback(many, 'open settings', vi.fn())).toHaveLength(3);
    expect(withAskAiFallback([], 'ab', vi.fn())).toHaveLength(0);
  });
});
