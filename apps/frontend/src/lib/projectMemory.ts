import { homeDir, join } from '@tauri-apps/api/path';
import { fsReadDir, fsReadFile } from './tauri';

/** Instruction files agents pick up from a project root, in the order Claude
 *  Code and the other common agents read them. */
export const PROJECT_RULES_FILES = [
  'CLAUDE.md',
  'CLAUDE.local.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
  '.rules',
  '.github/copilot-instructions.md',
];

export interface MemoryFile {
  label: string;
  path: string;
  /** First non-empty line, for a one-line preview. */
  preview: string;
}

export interface MemoryItem {
  name: string;
  description: string;
  path: string;
  scope: 'project' | 'global';
}

export interface ProjectMemory {
  projectRules: MemoryFile[];
  globalRules: MemoryFile[];
  skills: MemoryItem[];
  commands: MemoryItem[];
}

/** `name` / `description` from a SKILL.md or command file's YAML front matter. */
export function parseFrontMatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]!] = field[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return { name: fields.name, description: fields.description };
}

export function firstLine(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const line = body.split(/\r?\n/).find((l) => l.trim()) ?? '';
  return line.replace(/^#+\s*/, '').trim().slice(0, 140);
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await fsReadFile(path);
  } catch {
    return null;
  }
}

async function listDir(path: string) {
  try {
    return await fsReadDir(path);
  } catch {
    return [];
  }
}

async function loadSkills(dir: string, scope: MemoryItem['scope']): Promise<MemoryItem[]> {
  const items: MemoryItem[] = [];
  for (const entry of await listDir(dir)) {
    if (entry.kind !== 'dir') continue;
    const path = await join(entry.path, 'SKILL.md');
    const text = await readIfPresent(path);
    if (text === null) continue;
    const meta = parseFrontMatter(text);
    items.push({
      name: meta.name || entry.name,
      description: meta.description || firstLine(text),
      path,
      scope,
    });
  }
  return items;
}

async function loadCommands(dir: string, scope: MemoryItem['scope']): Promise<MemoryItem[]> {
  const items: MemoryItem[] = [];
  for (const entry of await listDir(dir)) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue;
    const text = (await readIfPresent(entry.path)) ?? '';
    const meta = parseFrontMatter(text);
    items.push({
      name: `/${entry.name.replace(/\.md$/, '')}`,
      description: meta.description || firstLine(text),
      path: entry.path,
      scope,
    });
  }
  return items;
}

/** Everything an agent reads before a conversation in `root`. */
export async function loadProjectMemory(root: string | null): Promise<ProjectMemory> {
  const home = await homeDir();
  const claudeHome = await join(home, '.claude');
  const memory: ProjectMemory = { projectRules: [], globalRules: [], skills: [], commands: [] };

  if (root) {
    for (const name of PROJECT_RULES_FILES) {
      const path = await join(root, ...name.split('/'));
      const text = await readIfPresent(path);
      if (text !== null) memory.projectRules.push({ label: name, path, preview: firstLine(text) });
    }
    memory.skills.push(...(await loadSkills(await join(root, '.claude', 'skills'), 'project')));
    memory.commands.push(...(await loadCommands(await join(root, '.claude', 'commands'), 'project')));
  }

  for (const [label, path] of [
    ['~/.claude/CLAUDE.md', await join(claudeHome, 'CLAUDE.md')],
    ['~/.codex/AGENTS.md', await join(home, '.codex', 'AGENTS.md')],
  ] as const) {
    const text = await readIfPresent(path);
    if (text !== null) memory.globalRules.push({ label, path, preview: firstLine(text) });
  }
  memory.skills.push(...(await loadSkills(await join(claudeHome, 'skills'), 'global')));
  memory.commands.push(...(await loadCommands(await join(claudeHome, 'commands'), 'global')));
  // With the home folder open as the project, its .claude is also the global
  // one; list each file once, under the scope found first (project).
  memory.skills = uniqueByPath(memory.skills);
  memory.commands = uniqueByPath(memory.commands);
  return memory;
}

export function uniqueByPath<T extends { path: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.path.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
