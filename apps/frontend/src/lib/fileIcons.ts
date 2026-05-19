/**
 * Catppuccin Mocha-flavored file-icon mapping.
 *
 * Rather than ship the full vscode-icons SVG set (heavy), we map file
 * extensions and well-known filenames to a lucide icon + a color drawn
 * from the Catppuccin Mocha palette. The result is visually consistent
 * with the Catppuccin file-icons theme used in editors.
 */
import {
  Folder,
  FolderOpen,
  File as FileIcon,
  FileText,
  FileCode,
  FileCode2,
  FileType2,
  FileTerminal,
  FileLock,
  FileSpreadsheet,
  FileVideo,
  FileAudio,
  FileImage,
  FileArchive,
  Braces,
  Hash,
  Coffee,
  GitBranch,
  Database,
  Package,
  Settings,
  Cog,
  Boxes,
  Container,
  Palette,
  PenTool,
  BookOpen,
  Binary,
  Key,
  ScrollText,
  TerminalSquare,
  Component,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

// Re-export the Catppuccin Mocha palette from the shared package so the
// editor + file tree + any future consumer pull from the same source.
export { MOCHA } from '@arc/ui';
import { MOCHA } from '@arc/ui';

export interface FileIconSpec {
  Icon: LucideIcon;
  color: string;
}

/* ---------- Folder icons ---------- */
// Some folder names get tinted variants (the Catppuccin "folder accents")
const FOLDER_BY_NAME: Record<string, string> = {
  src: MOCHA.blue,
  source: MOCHA.blue,
  lib: MOCHA.blue,
  app: MOCHA.blue,
  apps: MOCHA.blue,
  components: MOCHA.mauve,
  ui: MOCHA.mauve,
  pages: MOCHA.lavender,
  views: MOCHA.lavender,
  routes: MOCHA.lavender,
  api: MOCHA.green,
  server: MOCHA.green,
  backend: MOCHA.green,
  test: MOCHA.peach,
  tests: MOCHA.peach,
  __tests__: MOCHA.peach,
  spec: MOCHA.peach,
  docs: MOCHA.sky,
  doc: MOCHA.sky,
  documentation: MOCHA.sky,
  assets: MOCHA.pink,
  images: MOCHA.pink,
  img: MOCHA.pink,
  public: MOCHA.pink,
  static: MOCHA.pink,
  styles: MOCHA.flamingo,
  css: MOCHA.flamingo,
  scss: MOCHA.flamingo,
  utils: MOCHA.teal,
  helpers: MOCHA.teal,
  hooks: MOCHA.teal,
  config: MOCHA.yellow,
  configs: MOCHA.yellow,
  settings: MOCHA.yellow,
  scripts: MOCHA.yellow,
  bin: MOCHA.yellow,
  node_modules: MOCHA.overlay1,
  '.git': MOCHA.peach,
  '.github': MOCHA.overlay2,
  '.vscode': MOCHA.blue,
  '.idea': MOCHA.blue,
  dist: MOCHA.overlay1,
  build: MOCHA.overlay1,
  target: MOCHA.overlay1,
  out: MOCHA.overlay1,
  '.next': MOCHA.overlay1,
  '.cache': MOCHA.overlay1,
  rust: MOCHA.peach,
  packages: MOCHA.mauve,
};

export function folderIcon(name: string, isOpen: boolean): FileIconSpec {
  const color = FOLDER_BY_NAME[name.toLowerCase()] ?? MOCHA.sapphire;
  return { Icon: isOpen ? FolderOpen : Folder, color };
}

/* ---------- Files by exact filename ---------- */
// Filenames recognized regardless of extension. Lowercased lookup.
const FILE_BY_NAME: Record<string, FileIconSpec> = {
  'readme.md': { Icon: BookOpen, color: MOCHA.sky },
  'readme.txt': { Icon: BookOpen, color: MOCHA.sky },
  'readme': { Icon: BookOpen, color: MOCHA.sky },
  'license': { Icon: ScrollText, color: MOCHA.yellow },
  'license.md': { Icon: ScrollText, color: MOCHA.yellow },
  'license.txt': { Icon: ScrollText, color: MOCHA.yellow },
  'package.json': { Icon: Package, color: MOCHA.red },
  'package-lock.json': { Icon: FileLock, color: MOCHA.red },
  'pnpm-lock.yaml': { Icon: FileLock, color: MOCHA.peach },
  'pnpm-workspace.yaml': { Icon: Boxes, color: MOCHA.peach },
  'yarn.lock': { Icon: FileLock, color: MOCHA.blue },
  'tsconfig.json': { Icon: FileType2, color: MOCHA.blue },
  'jsconfig.json': { Icon: FileType2, color: MOCHA.yellow },
  'tailwind.config.ts': { Icon: PenTool, color: MOCHA.teal },
  'tailwind.config.js': { Icon: PenTool, color: MOCHA.teal },
  'vite.config.ts': { Icon: Wrench, color: MOCHA.mauve },
  'vite.config.js': { Icon: Wrench, color: MOCHA.mauve },
  'postcss.config.js': { Icon: Wrench, color: MOCHA.red },
  'cargo.toml': { Icon: Package, color: MOCHA.peach },
  'cargo.lock': { Icon: FileLock, color: MOCHA.peach },
  'rust-toolchain.toml': { Icon: Wrench, color: MOCHA.peach },
  '.gitignore': { Icon: GitBranch, color: MOCHA.overlay2 },
  '.gitattributes': { Icon: GitBranch, color: MOCHA.overlay2 },
  '.env': { Icon: Key, color: MOCHA.yellow },
  '.env.local': { Icon: Key, color: MOCHA.yellow },
  '.env.development': { Icon: Key, color: MOCHA.yellow },
  '.env.production': { Icon: Key, color: MOCHA.yellow },
  'dockerfile': { Icon: Container, color: MOCHA.blue },
  'docker-compose.yml': { Icon: Container, color: MOCHA.blue },
  'docker-compose.yaml': { Icon: Container, color: MOCHA.blue },
  'makefile': { Icon: Wrench, color: MOCHA.peach },
  'claude.md': { Icon: FileText, color: MOCHA.mauve },
  'tauri.conf.json': { Icon: Settings, color: MOCHA.peach },
  // Settings re-imported below
};

/* ---------- Files by extension ---------- */
const FILE_BY_EXT: Record<string, FileIconSpec> = {
  // JavaScript / TypeScript
  js: { Icon: FileCode, color: MOCHA.yellow },
  mjs: { Icon: FileCode, color: MOCHA.yellow },
  cjs: { Icon: FileCode, color: MOCHA.yellow },
  jsx: { Icon: Component, color: MOCHA.sky },
  ts: { Icon: FileCode, color: MOCHA.blue },
  tsx: { Icon: Component, color: MOCHA.sapphire },
  // Web
  html: { Icon: FileCode2, color: MOCHA.peach },
  htm: { Icon: FileCode2, color: MOCHA.peach },
  css: { Icon: Palette, color: MOCHA.flamingo },
  scss: { Icon: Palette, color: MOCHA.pink },
  sass: { Icon: Palette, color: MOCHA.pink },
  less: { Icon: Palette, color: MOCHA.pink },
  // Data
  json: { Icon: Braces, color: MOCHA.yellow },
  jsonc: { Icon: Braces, color: MOCHA.yellow },
  json5: { Icon: Braces, color: MOCHA.yellow },
  yaml: { Icon: FileCode, color: MOCHA.red },
  yml: { Icon: FileCode, color: MOCHA.red },
  toml: { Icon: FileCode, color: MOCHA.peach },
  xml: { Icon: FileCode2, color: MOCHA.peach },
  csv: { Icon: FileSpreadsheet, color: MOCHA.green },
  tsv: { Icon: FileSpreadsheet, color: MOCHA.green },
  // Docs
  md: { Icon: FileText, color: MOCHA.sky },
  mdx: { Icon: FileText, color: MOCHA.sky },
  txt: { Icon: FileText, color: MOCHA.subtext0 },
  pdf: { Icon: FileText, color: MOCHA.red },
  // Systems languages
  rs: { Icon: FileCode, color: MOCHA.peach },
  go: { Icon: FileCode, color: MOCHA.sky },
  py: { Icon: FileCode, color: MOCHA.yellow },
  java: { Icon: Coffee, color: MOCHA.red },
  kt: { Icon: FileCode, color: MOCHA.mauve },
  swift: { Icon: FileCode, color: MOCHA.peach },
  c: { Icon: FileCode, color: MOCHA.blue },
  h: { Icon: FileCode, color: MOCHA.lavender },
  cpp: { Icon: FileCode, color: MOCHA.blue },
  hpp: { Icon: FileCode, color: MOCHA.lavender },
  cs: { Icon: Hash, color: MOCHA.mauve },
  php: { Icon: FileCode, color: MOCHA.lavender },
  rb: { Icon: FileCode, color: MOCHA.red },
  // Shell
  sh: { Icon: FileTerminal, color: MOCHA.green },
  bash: { Icon: FileTerminal, color: MOCHA.green },
  zsh: { Icon: FileTerminal, color: MOCHA.green },
  fish: { Icon: FileTerminal, color: MOCHA.green },
  ps1: { Icon: TerminalSquare, color: MOCHA.blue },
  bat: { Icon: TerminalSquare, color: MOCHA.blue },
  cmd: { Icon: TerminalSquare, color: MOCHA.blue },
  // Database
  sql: { Icon: Database, color: MOCHA.sapphire },
  db: { Icon: Database, color: MOCHA.sapphire },
  sqlite: { Icon: Database, color: MOCHA.sapphire },
  // Images
  png: { Icon: FileImage, color: MOCHA.pink },
  jpg: { Icon: FileImage, color: MOCHA.pink },
  jpeg: { Icon: FileImage, color: MOCHA.pink },
  gif: { Icon: FileImage, color: MOCHA.pink },
  webp: { Icon: FileImage, color: MOCHA.pink },
  svg: { Icon: FileImage, color: MOCHA.peach },
  ico: { Icon: FileImage, color: MOCHA.yellow },
  // Video / audio
  mp4: { Icon: FileVideo, color: MOCHA.mauve },
  mkv: { Icon: FileVideo, color: MOCHA.mauve },
  mov: { Icon: FileVideo, color: MOCHA.mauve },
  webm: { Icon: FileVideo, color: MOCHA.mauve },
  mp3: { Icon: FileAudio, color: MOCHA.teal },
  wav: { Icon: FileAudio, color: MOCHA.teal },
  flac: { Icon: FileAudio, color: MOCHA.teal },
  // Archives
  zip: { Icon: FileArchive, color: MOCHA.overlay2 },
  tar: { Icon: FileArchive, color: MOCHA.overlay2 },
  gz: { Icon: FileArchive, color: MOCHA.overlay2 },
  '7z': { Icon: FileArchive, color: MOCHA.overlay2 },
  rar: { Icon: FileArchive, color: MOCHA.overlay2 },
  // Misc binaries
  exe: { Icon: Binary, color: MOCHA.overlay1 },
  dll: { Icon: Binary, color: MOCHA.overlay1 },
  so: { Icon: Binary, color: MOCHA.overlay1 },
  // Config-ish
  ini: { Icon: Cog, color: MOCHA.yellow },
  conf: { Icon: Cog, color: MOCHA.yellow },
  // Web app config
  lock: { Icon: FileLock, color: MOCHA.overlay2 },
};

export function fileIcon(name: string): FileIconSpec {
  const lower = name.toLowerCase();
  const byName = FILE_BY_NAME[lower];
  if (byName) return byName;

  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  const byExt = FILE_BY_EXT[ext];
  if (byExt) return byExt;

  return { Icon: FileIcon, color: MOCHA.overlay2 };
}
