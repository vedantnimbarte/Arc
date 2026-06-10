import type { LanguageId } from '@arc/editor';

/** Symbol categories the outline recognises. Drives the row icon. */
export type OutlineKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'heading'
  | 'section';

export interface OutlineSymbol {
  name: string;
  kind: OutlineKind;
  /** 1-based source line. */
  line: number;
  /** Nesting depth, for indentation (markdown heading level, python methods). */
  depth: number;
}

const MAX_LINES = 6000;
const MAX_SYMBOLS = 800;

/**
 * Extract a lightweight symbol outline from source text. This is deliberately
 * regex/line based rather than a full parse: it stays fast, dependency-free,
 * and good enough to navigate. Pure + synchronous so it's trivially testable.
 */
export function extractOutline(text: string, lang: LanguageId | null): OutlineSymbol[] {
  if (!text) return [];
  const lines = text.split('\n', MAX_LINES);
  switch (lang) {
    case 'javascript':
    case 'javascript-jsx':
    case 'typescript':
    case 'typescript-jsx':
      return cap(tsOutline(lines));
    case 'python':
      return cap(pyOutline(lines));
    case 'rust':
      return cap(rustOutline(lines));
    case 'go':
      return cap(goOutline(lines));
    case 'markdown':
      return cap(mdOutline(lines));
    case 'css':
      return cap(cssOutline(lines));
    case 'java':
    case 'cpp':
    case 'php':
      return cap(curlyOutline(lines));
    default:
      return [];
  }
}

function cap(symbols: OutlineSymbol[]): OutlineSymbol[] {
  return symbols.length > MAX_SYMBOLS ? symbols.slice(0, MAX_SYMBOLS) : symbols;
}

// ── TypeScript / JavaScript ──────────────────────────────────────────────────

const TS_RULES: { re: RegExp; kind: OutlineKind }[] = [
  { re: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: 'type' },
  { re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  // const foo = (…) =>  /  const foo = async (…) =>  /  const foo = <T>(…) =>
  {
    re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>]*>\s*)?\([^)]*\)\s*(?::[^=]+?)?=>/,
    kind: 'function',
  },
];

function tsOutline(lines: string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  lines.forEach((line, i) => {
    for (const { re, kind } of TS_RULES) {
      const m = re.exec(line);
      if (m && m[1]) {
        out.push({ name: m[1], kind, line: i + 1, depth: 0 });
        break;
      }
    }
  });
  return out;
}

// ── Python ───────────────────────────────────────────────────────────────────

function pyOutline(lines: string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  lines.forEach((line, i) => {
    const cls = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
    if (cls) {
      const indent = cls[1] ?? '';
      const name = cls[2];
      if (name) out.push({ name, kind: 'class', line: i + 1, depth: indentDepth(indent) });
      return;
    }
    const def = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
    if (def) {
      const indent = def[1] ?? '';
      const name = def[2];
      const depth = indentDepth(indent);
      if (name) out.push({ name, kind: depth > 0 ? 'method' : 'function', line: i + 1, depth });
    }
  });
  return out;
}

function indentDepth(indent: string): number {
  // Treat a tab or 4 spaces as one level; good enough for display.
  const spaces = indent.replace(/\t/g, '    ').length;
  return Math.floor(spaces / 4);
}

// ── Rust ───────────────────────────────────────────────────────────────────

const RUST_RULES: { re: RegExp; kind: OutlineKind }[] = [
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
  { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait' },
  { re: /^\s*impl(?:<[^>]*>)?\s+(.+?)\s*(?:\{|where|$)/, kind: 'section' },
];

function rustOutline(lines: string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  lines.forEach((line, i) => {
    for (const { re, kind } of RUST_RULES) {
      const m = re.exec(line);
      if (m && m[1]) {
        out.push({ name: m[1].trim(), kind, line: i + 1, depth: 0 });
        break;
      }
    }
  });
  return out;
}

// ── Go ───────────────────────────────────────────────────────────────────────

function goOutline(lines: string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  lines.forEach((line, i) => {
    const fn = /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(line);
    if (fn && fn[1]) {
      const method = /^\s*func\s+\(/.test(line);
      out.push({ name: fn[1], kind: method ? 'method' : 'function', line: i + 1, depth: 0 });
      return;
    }
    const ty = /^\s*type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/.exec(line);
    if (ty && ty[1]) {
      out.push({
        name: ty[1],
        kind: ty[2] === 'interface' ? 'interface' : 'struct',
        line: i + 1,
        depth: 0,
      });
    }
  });
  return out;
}

// ── Markdown ───────────────────────────────────────────────────────────────

function mdOutline(lines: string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && m[2]) {
      out.push({ name: m[2], kind: 'heading', line: i + 1, depth: (m[1]?.length ?? 1) - 1 });
    }
  });
  return out;
}

// ── CSS ───────────────────────────────────────────────────────────────────

function cssOutline(lines: string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  lines.forEach((line, i) => {
    // Selector lines that open a block, skipping at-rules like @media.
    const m = /^\s*([.#&]?[A-Za-z_][\w\-,.\s#:>&[\]="']*?)\s*\{\s*$/.exec(line);
    if (m && m[1] && !line.trim().startsWith('@')) {
      out.push({ name: m[1].trim(), kind: 'section', line: i + 1, depth: 0 });
    }
  });
  return out;
}

// ── Curly-brace languages (Java / C++ / PHP) ──────────────────────────────────

const CURLY_RULES: { re: RegExp; kind: OutlineKind }[] = [
  { re: /^\s*(?:public|private|protected|final|abstract|static|\s)*\b(?:class|interface)\s+([A-Za-z_]\w*)/, kind: 'class' },
  { re: /^\s*(?:public|private|protected|final|abstract|static|\s)*\b(?:struct)\s+([A-Za-z_]\w*)/, kind: 'struct' },
  { re: /^\s*(?:public|private|protected|static|\s)*function\s+&?\s*([A-Za-z_]\w*)\s*\(/, kind: 'function' },
];

function curlyOutline(lines: string[]): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  lines.forEach((line, i) => {
    for (const { re, kind } of CURLY_RULES) {
      const m = re.exec(line);
      if (m && m[1]) {
        out.push({ name: m[1], kind, line: i + 1, depth: 0 });
        break;
      }
    }
  });
  return out;
}
