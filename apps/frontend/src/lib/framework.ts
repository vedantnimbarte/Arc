// Framework + dev-server-port detection for the Preview pane's port picker.
//
// The heuristic reads the workspace root's package.json (via the existing
// fs_read_file Tauri command — no new Rust required) and walks an ordered
// table of dependency keys → display name + default ports. Order matters:
// SvelteKit must be matched before raw Svelte, Next.js before React, etc.

import { fsReadFile } from './tauri';
import { useFiles } from '../state/files';

export interface FrameworkHit {
  framework: string;
  ports: number[];
}

// Ordered detection table. First match wins, so list more-specific keys first.
const DETECTORS: Array<{ dep: string; name: string; ports: number[] }> = [
  { dep: '@sveltejs/kit', name: 'SvelteKit', ports: [5173] },
  { dep: 'next',           name: 'Next.js',   ports: [3000, 3001] },
  { dep: 'nuxt',           name: 'Nuxt',      ports: [3000] },
  { dep: 'remix',          name: 'Remix',     ports: [3000] },
  { dep: 'astro',          name: 'Astro',     ports: [4321] },
  { dep: 'gatsby',         name: 'Gatsby',    ports: [8000] },
  { dep: '@angular/core',  name: 'Angular',   ports: [4200] },
  { dep: 'vite',           name: 'Vite',      ports: [5173, 5174] },
  { dep: 'react-scripts',  name: 'CRA',       ports: [3000] },
  { dep: 'svelte',         name: 'Svelte',    ports: [5173] },
  { dep: 'vue',            name: 'Vue',       ports: [8080, 5173] },
];

// Catch-all ports tried when no framework is detected. Covers the
// "I'm running something on a common port" case.
export const FALLBACK_PORTS = [3000, 5173, 4200, 4321, 8000, 8080];

export async function detectFramework(): Promise<FrameworkHit> {
  const root = useFiles.getState().root;
  if (!root) return { framework: 'Unknown', ports: FALLBACK_PORTS };
  const sep = root.includes('\\') ? '\\' : '/';
  try {
    const raw = await fsReadFile(`${root}${sep}package.json`);
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const d of DETECTORS) {
      if (deps[d.dep]) return { framework: d.name, ports: d.ports };
    }
  } catch {
    // No package.json, invalid JSON, or filesystem read failure — fall through.
  }
  return { framework: 'Unknown', ports: FALLBACK_PORTS };
}
