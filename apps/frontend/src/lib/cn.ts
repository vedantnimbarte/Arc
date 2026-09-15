import { clsx, type ClassValue } from 'clsx';

/** Joins class names. No conflict resolution: when two classes of the same
 *  kind (two text colours, two paddings) can both be present, pick one in the
 *  expression — the stylesheet's order, not argument order, decides otherwise. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
