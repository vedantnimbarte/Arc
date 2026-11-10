import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useFiles } from '../state/files';
import { useWorkspace } from '../state/workspace';
import {
  loadProjectMemory,
  PROJECT_RULES_FILES,
  type MemoryFile,
  type MemoryItem,
  type ProjectMemory as Memory,
} from '../lib/projectMemory';

/** What an agent reads before every conversation in this project: rules
 *  files, skills and custom slash commands, each one click from its source. */
export function ProjectMemory() {
  const root = useFiles((s) => s.root);
  const [memory, setMemory] = useState<Memory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    loadProjectMemory(root)
      .then(setMemory)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(refresh, [root]);

  const open = (path: string) => useWorkspace.getState().openFile(path);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-semibold tracking-tight text-fg-base">
              Project memory
            </h1>
            <p className="text-xs text-fg-muted">
              What your agent reads before every conversation{root ? ` in ${root}` : ''}.
            </p>
          </div>
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-base"
          >
            <RefreshCw size={12} strokeWidth={2} />
            Refresh
          </button>
        </header>

        {error && <p className="text-xs text-status-err">{error}</p>}
        {!memory ? (
          <p className="text-sm text-fg-muted">Reading project memory…</p>
        ) : (
          <>
            <Section title="Project rules">
              {memory.projectRules.length === 0 ? (
                <Empty>
                  {root
                    ? `None of ${PROJECT_RULES_FILES.slice(0, 3).join(', ')}… in this folder.`
                    : 'Open a folder to see its rules files.'}
                </Empty>
              ) : (
                memory.projectRules.map((f) => <FileRow key={f.path} file={f} onOpen={open} />)
              )}
            </Section>
            <Section title="Global rules">
              {memory.globalRules.length === 0 ? (
                <Empty>No ~/.claude/CLAUDE.md or ~/.codex/AGENTS.md.</Empty>
              ) : (
                memory.globalRules.map((f) => <FileRow key={f.path} file={f} onOpen={open} />)
              )}
            </Section>
            <Section title="Skills">
              {memory.skills.length === 0 ? (
                <Empty>No skills in .claude/skills or ~/.claude/skills.</Empty>
              ) : (
                memory.skills.map((s) => <ItemRow key={s.path} item={s} onOpen={open} />)
              )}
            </Section>
            <Section title="Custom commands">
              {memory.commands.length === 0 ? (
                <Empty>No commands in .claude/commands or ~/.claude/commands.</Empty>
              ) : (
                memory.commands.map((c) => <ItemRow key={c.path} item={c} onOpen={open} />)
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-border-subtle bg-surface-1 p-3">
      <div className="px-1 pb-1 text-2xs font-semibold uppercase tracking-[0.14em] text-fg-subtle">
        {title}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-xs text-fg-subtle">{children}</p>;
}

function FileRow({ file, onOpen }: { file: MemoryFile; onOpen: (path: string) => void }) {
  return (
    <button
      onClick={() => onOpen(file.path)}
      title={file.path}
      className="flex flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
    >
      <span className="text-sm text-fg-base">{file.label}</span>
      {file.preview && <span className="truncate text-xs text-fg-muted">{file.preview}</span>}
    </button>
  );
}

function ItemRow({ item, onOpen }: { item: MemoryItem; onOpen: (path: string) => void }) {
  return (
    <button
      onClick={() => onOpen(item.path)}
      title={item.path}
      className="flex flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
    >
      <span className="flex items-center gap-2 text-sm text-fg-base">
        {item.name}
        <span className="rounded bg-surface-2 px-1 text-2xs text-fg-subtle">{item.scope}</span>
      </span>
      {item.description && (
        <span className="line-clamp-2 text-xs text-fg-muted">{item.description}</span>
      )}
    </button>
  );
}
