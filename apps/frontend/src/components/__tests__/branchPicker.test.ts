import { describe, expect, it } from 'vitest';
import { popoverPosition } from '../BranchPicker';

// 420px sheet, 8px viewport margin, 6px gap off the trigger.
describe('popoverPosition', () => {
  it('sits above a status bar chip, left-aligned to it', () => {
    expect(popoverPosition({ x: 200, y: 980, placement: 'above' }, 1440, 1000)).toEqual({
      left: 200,
      bottom: 26,
    });
  });

  it('hangs below a pane header pill', () => {
    expect(popoverPosition({ x: 300, y: 40, placement: 'below' }, 1440, 1000)).toEqual({
      left: 300,
      top: 46,
    });
  });

  it('pulls back from the right edge instead of overflowing', () => {
    expect(popoverPosition({ x: 1380, y: 40, placement: 'below' }, 1440, 1000).left).toBe(1012);
  });

  it('never goes past the left edge on a narrow window', () => {
    expect(popoverPosition({ x: 4, y: 40, placement: 'below' }, 300, 1000).left).toBe(8);
  });
});
