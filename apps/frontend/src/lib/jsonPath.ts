/**
 * A small JSONPath subset for the API Client's post-response variables:
 * `$`, `.name`, `[0]`, `['x-y']` / `["x-y"]`. No wildcards, filters or
 * recursive descent. Pure.
 */

type Segment = string | number;

/** Split a path into keys and indexes. Throws on anything outside the subset. */
export function parseJsonPath(path: string): Segment[] {
  const p = path.trim();
  if (!p.startsWith('$')) throw new Error(`JSONPath must start with $: ${path}`);
  const out: Segment[] = [];
  let i = 1;
  while (i < p.length) {
    if (p[i] === '.') {
      const m = /^[^.[\]]+/.exec(p.slice(i + 1));
      if (!m) throw new Error(`Expected a name after "." at ${i}: ${path}`);
      out.push(m[0]);
      i += 1 + m[0].length;
    } else if (p[i] === '[') {
      const m = /^\[\s*(?:(\d+)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\]/.exec(p.slice(i));
      if (!m) throw new Error(`Bad bracket at ${i}: ${path}`);
      if (m[1] !== undefined) out.push(Number(m[1]));
      else out.push((m[2] ?? m[3]!).replace(/\\(.)/g, '$1'));
      i += m[0].length;
    } else {
      throw new Error(`Unexpected "${p[i]}" at ${i}: ${path}`);
    }
  }
  return out;
}

/** The value at `path` in `root`, or `undefined` when any step is missing. */
export function queryJsonPath(root: unknown, path: string): unknown {
  let cur = root;
  for (const seg of parseJsonPath(path)) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur) || !Object.hasOwn(cur, seg)) {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}
