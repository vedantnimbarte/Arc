import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { toast, toastError, useToasts } from '../toast';

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('auto-dismisses after the TTL', () => {
    toast('Copied path');
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(2399);
    expect(useToasts.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it('caps the stack, keeping the newest', () => {
    for (const n of [1, 2, 3, 4, 5]) toast(`copy ${n}`);
    const texts = useToasts.getState().toasts.map((t) => t.text);
    expect(texts).toEqual(['copy 3', 'copy 4', 'copy 5']);
  });

  it('tags errors so the stack can style them apart', () => {
    toastError('Clipboard unavailable');
    expect(useToasts.getState().toasts[0]?.tone).toBe('error');
  });

  it('dismissing one leaves its siblings and their timers alone', () => {
    toast('a');
    toast('b');
    const [first] = useToasts.getState().toasts;
    useToasts.getState().dismiss(first!.id);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(['b']);
    // The dropped toast's timer still fires; it must not take 'b' with it.
    vi.advanceTimersByTime(2400);
    expect(useToasts.getState().toasts).toHaveLength(0);
  });
});
