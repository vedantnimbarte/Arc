import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../state/workspace';
import { TAB_GROUP_COLORS, type TabGroupColorId } from '../lib/tabGroups';
import { cn } from '../lib/cn';

/** Fallback rail colour when a workspace has none set yet. */
export const DEFAULT_WORKSPACE_COLOR: TabGroupColorId = 'slate';

// ponytail: curated emoji set instead of a full picker dependency. Bump the
// list if users want more; a real emoji-picker lib is the upgrade path.
export const EMOJI_CHOICES = [
  '💻', '🖥️', '⚡', '🚀', '🔧', '🐛', '📦', '🧪', '🎨', '📝',
  '🔬', '🌐', '🗄️', '🔒', '🧩', '⭐', '🔥', '💡', '📊', '🎯',
  '🛠️', '🧠', '☁️', '🐳', '🦀', '🐍', '📡', '🎮',
];

/**
 * Combined name / emoji / colour editor for one workspace. Self-contained:
 * reads the workspace and writes via the store, so both the rail popover and
 * the empty-workspace header can drop it in with just an id. Changes apply
 * live (store persist is debounced); Enter or Escape closes.
 */
export function WorkspaceEditPanel({
  workspaceId,
  onDone,
}: {
  workspaceId: string;
  onDone: () => void;
}) {
  const workspace = useWorkspace((s) => s.workspaces.find((w) => w.id === workspaceId));
  const renameWorkspace = useWorkspace((s) => s.renameWorkspace);
  const setWorkspaceIcon = useWorkspace((s) => s.setWorkspaceIcon);

  const [name, setName] = useState(workspace?.name ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  if (!workspace) return null;
  const selectedColor = workspace.color ?? DEFAULT_WORKSPACE_COLOR;

  return (
    <>
      <label className="mb-1 block font-display text-2xs uppercase tracking-wider text-fg-subtle/80">
        Name
      </label>
      <input
        ref={ref}
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          renameWorkspace(workspaceId, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            onDone();
          }
        }}
        placeholder="Workspace name"
        className="mb-3 w-full rounded border border-accent/45 bg-bg-base/80 px-2 py-1 font-display text-sm tracking-tight text-fg-base focus:shadow-focus focus:outline-none"
      />

      <label className="mb-1 block font-display text-2xs uppercase tracking-wider text-fg-subtle/80">
        Icon
      </label>
      <div className="grid grid-cols-7 gap-1">
        <button
          onClick={() => setWorkspaceIcon(workspaceId, { icon: undefined })}
          title="No emoji (use initials)"
          className={cn(
            'flex h-7 items-center justify-center rounded text-2xs font-medium transition-colors hover:bg-surface-2 hover:text-fg-base',
            workspace.icon ? 'text-fg-subtle' : 'bg-surface-2 text-fg-base',
          )}
        >
          Aa
        </button>
        {EMOJI_CHOICES.map((emoji) => (
          <button
            key={emoji}
            onClick={() => setWorkspaceIcon(workspaceId, { icon: emoji })}
            className={cn(
              'flex h-7 items-center justify-center rounded text-lg transition-colors hover:bg-surface-2',
              workspace.icon === emoji && 'bg-surface-3',
            )}
          >
            {emoji}
          </button>
        ))}
      </div>

      <label className="mb-1 mt-3 block font-display text-2xs uppercase tracking-wider text-fg-subtle/80">
        Colour
      </label>
      <div className="flex items-center justify-between px-0.5">
        {TAB_GROUP_COLORS.map((c) => (
          <button
            key={c.id}
            onClick={() => setWorkspaceIcon(workspaceId, { color: c.id })}
            title={c.label}
            aria-label={c.label}
            className={cn(
              'h-5 w-5 rounded-full transition-transform hover:scale-110',
              selectedColor === c.id && 'ring-2 ring-white/80 ring-offset-2 ring-offset-bg-panel',
            )}
            style={{ backgroundColor: c.hex }}
          />
        ))}
      </div>
    </>
  );
}
