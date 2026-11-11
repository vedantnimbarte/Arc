/** Compact relative age — "2m", "5h", "3d", "7mo", "2y".
 *
 *  Short on purpose: it sits in a mono meta line under a dense row, where a
 *  full "3 days ago" would push out the branch name next to it. */
export function relative(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 2592000) return `${Math.floor(secs / 86400)}d`;
  if (secs < 31536000) return `${Math.floor(secs / 2592000)}mo`;
  return `${Math.floor(secs / 31536000)}y`;
}

/** Join meta fragments, dropping the empty ones so a missing field doesn't
 *  leave a dangling separator. */
export function meta(...parts: (string | number | false | null | undefined)[]): string {
  return parts.filter((p) => p !== '' && p !== false && p != null).join(' · ');
}

/** GitHub's own language colours, for the ones people actually have. A repo
 *  card's lane is painted in it, so a grid of Rust and TypeScript repos sorts
 *  itself by eye. */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Rust: '#dea584',
  Python: '#3572a5',
  Go: '#00add8',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Swift: '#f05138',
  C: '#8a8f98',
  'C++': '#f34b7d',
  'C#': '#178600',
  Ruby: '#cc342d',
  PHP: '#4f5d95',
  Dart: '#00b4ab',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#663399',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Zig: '#ec915c',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
  Scala: '#c22d40',
  Lua: '#4a6cd4',
  Nix: '#7e7eff',
  Dockerfile: '#384d54',
  'Jupyter Notebook': '#da5b0b',
  MDX: '#fcb32c',
};

/** Lane colours for things GitHub doesn't colour itself — branches, and
 *  languages missing above. Picked to stay legible on dark and light themes. */
const LANES = ['#4fa3ff', '#b88cff', '#ff8f5a', '#2fc9a5', '#e6b422', '#ff6fa8', '#7cc35a'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The same name always gets the same lane, like a branch in a commit graph. */
export function laneColor(name: string): string {
  return LANES[hash(name) % LANES.length] ?? '#8a8f98';
}

export function languageColor(language: string): string {
  return LANGUAGE_COLORS[language] ?? (language ? laneColor(language) : '#8a8f98');
}
