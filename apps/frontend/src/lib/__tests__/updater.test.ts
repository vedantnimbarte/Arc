import { describe, expect, it } from 'vitest';
import { createProgressTracker, type DownloadEvent } from '../updater';

function run(events: DownloadEvent[]): number[] {
  const seen: number[] = [];
  const track = createProgressTracker((p) => seen.push(p));
  events.forEach(track);
  return seen;
}

describe('createProgressTracker', () => {
  it('reports percentages against the advertised content length', () => {
    expect(
      run([
        { event: 'Started', data: { contentLength: 100 } },
        { event: 'Progress', data: { chunkLength: 25 } },
        { event: 'Progress', data: { chunkLength: 25 } },
        { event: 'Finished' },
      ]),
    ).toEqual([0, 25, 50, 100]);
  });

  it('stays at 0 while the size is unknown, then finishes at 100', () => {
    expect(
      run([
        { event: 'Started', data: {} },
        { event: 'Progress', data: { chunkLength: 4096 } },
        { event: 'Finished' },
      ]),
    ).toEqual([0, 100]);
  });

  it('clamps overshoot past the advertised total', () => {
    expect(
      run([
        { event: 'Started', data: { contentLength: 10 } },
        { event: 'Progress', data: { chunkLength: 99 } },
      ]),
    ).toEqual([0, 100]);
  });

  it('resets its byte count when a download restarts', () => {
    expect(
      run([
        { event: 'Started', data: { contentLength: 10 } },
        { event: 'Progress', data: { chunkLength: 5 } },
        { event: 'Started', data: { contentLength: 10 } },
        { event: 'Progress', data: { chunkLength: 1 } },
      ]),
    ).toEqual([0, 50, 0, 10]);
  });
});
