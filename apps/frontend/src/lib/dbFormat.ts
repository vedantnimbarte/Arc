import type { DbRowCount } from './tauri';

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** `1.2K rows`, with `~` for a catalog estimate. Null when there's no count. */
export function formatRowCount(rc: DbRowCount | undefined): string | null {
  if (!rc || rc.rows === null) return null;
  return `${rc.estimated ? '~' : ''}${compact.format(rc.rows)}`;
}
