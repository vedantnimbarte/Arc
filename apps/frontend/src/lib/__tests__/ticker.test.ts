import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { every } from '../ticker';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('every', () => {
  it('shares one interval per period and stops it with the last subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = every(1000, a);
    const offB = every(1000, b);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(2000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);

    offA();
    vi.advanceTimersByTime(1000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(3);

    offB();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps ticking the others when one subscriber throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    const offBad = every(500, () => {
      throw new Error('boom');
    });
    const offOk = every(500, ok);
    vi.advanceTimersByTime(500);
    expect(ok).toHaveBeenCalledTimes(1);
    offBad();
    offOk();
    spy.mockRestore();
  });

  it('restarts cleanly after a group was torn down', () => {
    const off = every(250, () => {});
    off();
    const fn = vi.fn();
    const off2 = every(250, fn);
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
    off2();
  });
});
