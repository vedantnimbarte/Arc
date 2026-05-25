// Byte / throughput formatting helpers used by the System Resources surfaces.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Format a byte count as a human-readable string with a sensible unit.
 *  Uses 1024 as the base (binary units presented with SI labels — matching
 *  Windows Task Manager / macOS Activity Monitor conventions). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  const digits = n >= 100 || i === 0 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${UNITS[i]}`;
}

/** Format a per-second byte rate (e.g. `1.2 MB/s`). Zero is rendered as
 *  `0 B/s` so the column width stays stable. */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}
