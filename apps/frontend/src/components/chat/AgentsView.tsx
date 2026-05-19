import { useState } from 'react';
import { ArrowLeft, Check, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  AGENT_ICONS,
  AGENT_TINTS,
  DEFAULT_AGENTS,
  useAgents,
  type Agent,
  type AgentIconKey,
  type AgentTint,
} from '../../state/agents';
import { useChat } from '../../state/chat';
import { cn } from '../../lib/cn';

interface Props {
  onBack: () => void;
  onPicked: () => void;
}

const ICON_KEYS = Object.keys(AGENT_ICONS) as AgentIconKey[];
const TINT_KEYS = Object.keys(AGENT_TINTS) as AgentTint[];

export function AgentsView({ onBack, onPicked }: Props) {
  const custom = useAgents((s) => s.custom);
  const deleteAgent = useAgents((s) => s.deleteAgent);

  const activeSessionId = useChat((s) => s.activeSessionId);
  const sessions = useChat((s) => s.sessions);
  const setSessionAgent = useChat((s) => s.setSessionAgent);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeAgentId = activeSession?.agentId;

  // `null` = the picker grid. An Agent shape (with or without id) = the form.
  const [editing, setEditing] = useState<EditState | null>(null);

  if (editing) {
    return (
      <AgentForm
        initial={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
    );
  }

  const pick = (id: string) => {
    if (!activeSessionId) return;
    setSessionAgent(activeSessionId, id);
    onPicked();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-hairline/70 px-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-display text-[11.5px] tracking-tight text-fg-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg-base"
          aria-label="Back to chat"
        >
          <ArrowLeft size={12} strokeWidth={2.2} />
          <span>Agents</span>
        </button>
        <button
          onClick={() =>
            setEditing({
              mode: 'create',
              draft: {
                name: '',
                description: '',
                systemPrompt: '',
                iconKey: 'bot',
                tint: 'platinum',
              },
            })
          }
          className={cn(
            'flex items-center gap-1.5 rounded-md px-2 py-1 font-display text-[11px] font-medium tracking-tight',
            'bg-white/[0.06] text-fg-base ring-1 ring-white/[0.06]',
            'transition-all duration-150 ease-apple',
            'hover:bg-white/[0.10] hover:ring-white/[0.12]',
            'active:scale-[0.97]',
          )}
        >
          <Plus size={11} strokeWidth={2.2} />
          New agent
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-2 px-1 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
          Built-in
        </div>
        <ul className="flex flex-col gap-1.5">
          {DEFAULT_AGENTS.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              active={a.id === activeAgentId}
              onPick={() => pick(a.id)}
            />
          ))}
        </ul>

        <div className="mt-4 mb-2 px-1 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
          Custom
        </div>
        {custom.length === 0 ? (
          <button
            onClick={() =>
              setEditing({
                mode: 'create',
                draft: {
                  name: '',
                  description: '',
                  systemPrompt: '',
                  iconKey: 'bot',
                  tint: 'platinum',
                },
              })
            }
            className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/[0.08] bg-black/[0.15] px-4 py-5 text-center transition-colors duration-150 hover:border-white/[0.14] hover:bg-black/[0.22]"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.05] text-fg-muted">
              <Plus size={14} strokeWidth={2.1} />
            </span>
            <span className="font-display text-[12px] font-medium tracking-tight text-fg-base">
              Create your first agent
            </span>
            <span className="font-display text-[10.5px] tracking-tight text-fg-subtle">
              Give it a name and a system prompt.
            </span>
          </button>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {custom.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                active={a.id === activeAgentId}
                onPick={() => pick(a.id)}
                onEdit={() => setEditing({ mode: 'edit', draft: a, id: a.id })}
                onDelete={() => {
                  if (window.confirm(`Delete agent "${a.name}"?`)) deleteAgent(a.id);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

type EditState =
  | { mode: 'create'; draft: AgentDraft }
  | { mode: 'edit'; id: string; draft: AgentDraft };

interface AgentDraft {
  name: string;
  description: string;
  systemPrompt: string;
  iconKey: AgentIconKey;
  tint: AgentTint;
}

function AgentRow({
  agent,
  active,
  onPick,
  onEdit,
  onDelete,
}: {
  agent: Agent;
  active: boolean;
  onPick: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const Icon = AGENT_ICONS[agent.iconKey];
  const tint = AGENT_TINTS[agent.tint];
  return (
    <li
      className={cn(
        'group flex items-start gap-2.5 rounded-lg p-2.5 transition-colors duration-150',
        active
          ? cn('bg-white/[0.06] ring-1 ring-inset', tint.ringActive)
          : 'ring-1 ring-inset ring-transparent hover:bg-white/[0.035]',
      )}
    >
      <button
        onClick={onPick}
        className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
      >
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1',
            tint.chipBg,
            tint.chipFg,
            tint.chipRing,
          )}
        >
          <Icon size={14} strokeWidth={2.1} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-display text-[12.5px] font-semibold tracking-tight text-fg-base">
              {agent.name}
            </span>
            {active && (
              <span
                className={cn(
                  'inline-flex h-3.5 w-3.5 items-center justify-center rounded-full',
                  'bg-white/[0.08] text-fg-base ring-1',
                  tint.chipRing,
                )}
                aria-label="Active agent"
              >
                <Check size={9} strokeWidth={2.8} />
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 font-display text-[11px] leading-snug tracking-tight text-fg-muted">
            {agent.description}
          </p>
        </div>
      </button>
      {(onEdit || onDelete) && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          {onEdit && (
            <button
              onClick={onEdit}
              className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-white/[0.08] hover:text-fg-base"
              aria-label={`Edit ${agent.name}`}
              title="Edit"
            >
              <Pencil size={11} strokeWidth={2.1} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-status-err/15 hover:text-status-err"
              aria-label={`Delete ${agent.name}`}
              title="Delete"
            >
              <Trash2 size={11} strokeWidth={2.1} />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function AgentForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial: EditState;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const createAgent = useAgents((s) => s.createAgent);
  const updateAgent = useAgents((s) => s.updateAgent);

  const [draft, setDraft] = useState<AgentDraft>(initial.draft);

  const canSave = draft.name.trim().length > 0 && draft.systemPrompt.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim() || 'Custom agent',
      systemPrompt: draft.systemPrompt.trim(),
      iconKey: draft.iconKey,
      tint: draft.tint,
    };
    if (initial.mode === 'create') {
      createAgent(payload);
    } else {
      updateAgent(initial.id, payload);
    }
    onSaved();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-hairline/70 px-2">
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-display text-[11.5px] tracking-tight text-fg-muted transition-colors duration-150 hover:bg-white/[0.06] hover:text-fg-base"
        >
          <ArrowLeft size={12} strokeWidth={2.2} />
          <span>{initial.mode === 'create' ? 'New agent' : 'Edit agent'}</span>
        </button>
        <button
          onClick={save}
          disabled={!canSave}
          className={cn(
            'rounded-md px-2.5 py-1 font-display text-[11px] font-medium tracking-tight',
            'transition-all duration-150 ease-apple',
            canSave
              ? 'surface-silver active:scale-[0.97]'
              : 'cursor-not-allowed bg-white/[0.05] text-fg-subtle',
          )}
        >
          {initial.mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3 py-3">
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Sprint Planner Pro"
            className="selectable w-full rounded-md border border-white/[0.05] bg-black/[0.22] px-2.5 py-1.5 font-display text-[12px] tracking-tight text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:outline-none focus:shadow-focus"
          />
        </Field>

        <Field label="Description">
          <input
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="What this agent is good at"
            className="selectable w-full rounded-md border border-white/[0.05] bg-black/[0.22] px-2.5 py-1.5 font-display text-[12px] tracking-tight text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:outline-none focus:shadow-focus"
          />
        </Field>

        <Field label="System prompt">
          <textarea
            value={draft.systemPrompt}
            onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
            placeholder="You are…"
            rows={6}
            className="selectable w-full resize-y rounded-md border border-white/[0.05] bg-black/[0.22] px-2.5 py-2 font-display text-[12px] leading-relaxed tracking-tight text-fg-base placeholder:text-fg-subtle focus:border-accent/40 focus:outline-none focus:shadow-focus"
          />
        </Field>

        <Field label="Icon">
          <div className="grid grid-cols-5 gap-1.5">
            {ICON_KEYS.map((key) => {
              const Icon = AGENT_ICONS[key];
              const selected = draft.iconKey === key;
              return (
                <button
                  key={key}
                  onClick={() => setDraft({ ...draft, iconKey: key })}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md transition-all duration-150',
                    selected
                      ? 'bg-white/[0.10] text-fg-base ring-1 ring-inset ring-white/20'
                      : 'bg-black/[0.18] text-fg-muted ring-1 ring-inset ring-white/[0.04] hover:bg-white/[0.05] hover:text-fg-base',
                  )}
                  aria-label={key}
                  aria-pressed={selected}
                >
                  <Icon size={13} strokeWidth={2} />
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Accent">
          <div className="grid grid-cols-7 gap-1.5">
            {TINT_KEYS.map((tint) => {
              const t = AGENT_TINTS[tint];
              const selected = draft.tint === tint;
              return (
                <button
                  key={tint}
                  onClick={() => setDraft({ ...draft, tint })}
                  className={cn(
                    'flex aspect-square items-center justify-center rounded-md transition-all duration-150',
                    selected
                      ? cn('ring-1 ring-inset', t.ringActive, t.chipBg)
                      : cn('ring-1 ring-inset ring-white/[0.04] hover:ring-white/[0.10]', t.chipBg),
                  )}
                  aria-label={tint}
                  aria-pressed={selected}
                >
                  <span className={cn('h-3 w-3 rounded-full', t.dot)} />
                </button>
              );
            })}
          </div>
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="px-0.5 font-display text-[10px] uppercase tracking-widest2 text-fg-subtle">
        {label}
      </span>
      {children}
    </label>
  );
}
