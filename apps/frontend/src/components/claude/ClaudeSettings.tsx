import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { CLAUDE_PERMISSION_MODES, useSettings } from '../../state/settings';
import { useClaudeCode } from '../../state/claudeCode';
import type { ClaudePermissionMode } from '../../lib/tauri';

/**
 * Settings block for the Claude Code panel.
 *
 * There is no connection to configure and no credential to store — ARC spawns
 * the user's own `claude` binary, which already holds their login. What's left
 * are the two decisions ARC has to make on their behalf every turn: how much
 * Claude may do without asking, and how much it may spend.
 */

/** One line each, because "acceptEdits" does not tell you it writes files. */
const MODE_HELP: Record<ClaudePermissionMode, string> = {
  plan: 'Read and plan only — never writes to your files.',
  manual: 'Asks in the panel before every tool. Safest mode you can still work in.',
  auto: 'Claude decides per tool and asks in the panel whenever it is unsure.',
  acceptEdits:
    'Applies file edits without asking, but still asks before shell commands. Review edits in the panel’s diff list.',
  dontAsk: 'Runs every tool it chooses, including shell commands, without asking.',
  bypassPermissions: 'Skips every permission check. Use only in a repo you can throw away.',
};

const RISKY: ClaudePermissionMode[] = ['dontAsk', 'bypassPermissions'];

export function ClaudeSettings() {
  const status = useClaudeCode((s) => s.status);
  const binary = useClaudeCode((s) => s.binary);
  const detect = useClaudeCode((s) => s.detect);

  const mode = useSettings((s) => s.claudePermissionMode);
  const setMode = useSettings((s) => s.setClaudePermissionMode);
  const model = useSettings((s) => s.claudeModel);
  const setModel = useSettings((s) => s.setClaudeModel);
  const budget = useSettings((s) => s.claudeMaxBudgetUsd);
  const setBudget = useSettings((s) => s.setClaudeMaxBudgetUsd);

  // Local drafts for the free-text fields, so a half-typed value never reaches
  // the CLI. The settings window is separate and rehydrates on broadcast, so
  // external edits have to be tracked too.
  const [modelDraft, setModelDraft] = useState(model);
  const [budgetDraft, setBudgetDraft] = useState(budget ? String(budget) : '');
  useEffect(() => setModelDraft(model), [model]);
  useEffect(() => setBudgetDraft(budget ? String(budget) : ''), [budget]);

  useEffect(() => {
    if (status === 'checking') void detect();
  }, [status, detect]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-1.5 font-mono text-2xs">
        {status === 'ready' ? (
          <>
            <CircleCheck size={12} strokeWidth={2} className="mt-px shrink-0 text-status-ok" />
            <span className="min-w-0 break-all text-fg-muted">{binary}</span>
          </>
        ) : status === 'checking' ? (
          <span className="text-fg-subtle">looking for the CLI…</span>
        ) : (
          <>
            <CircleAlert size={12} strokeWidth={2} className="mt-px shrink-0 text-fg-subtle" />
            <span className="text-fg-muted">
              <code className="font-mono">claude</code> is not on your PATH. Install Claude
              Code and sign in; ARC needs no key of its own.
            </span>
          </>
        )}
      </div>

      <label className="flex flex-col gap-1">
        <span className="font-display text-2xs text-fg-muted">Permission mode</span>
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ClaudePermissionMode)}
          className="rounded border border-edge-1 bg-surface-1 px-2 py-1 font-mono text-2xs text-fg-base focus:outline-none"
        >
          {CLAUDE_PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="font-display text-2xs leading-relaxed text-fg-subtle">
          {MODE_HELP[mode]}
        </span>
      </label>

      {RISKY.includes(mode) && (
        <p className="flex items-start gap-1.5 rounded bg-status-warn/10 px-2 py-1.5 font-display text-2xs leading-relaxed text-status-warn">
          <TriangleAlert size={12} strokeWidth={2} className="mt-px shrink-0" />
          <span>
            Claude will run commands in your workspace without confirmation. These are the two
            modes that skip the panel&rsquo;s approval prompt entirely, so nothing will stop a
            destructive one.
          </span>
        </p>
      )}

      <label className="flex flex-col gap-1">
        <span className="font-display text-2xs text-fg-muted">Model</span>
        <input
          value={modelDraft}
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => setModel(modelDraft.trim())}
          placeholder="default (whatever the CLI is set to)"
          spellCheck={false}
          className="rounded border border-edge-1 bg-surface-1 px-2 py-1 font-mono text-2xs text-fg-base placeholder:text-fg-subtle focus:outline-none"
        />
        <span className="font-display text-2xs leading-relaxed text-fg-subtle">
          An alias — <code className="font-mono">opus</code>,{' '}
          <code className="font-mono">sonnet</code>, <code className="font-mono">haiku</code> —
          or a full model id. Leave empty to use your CLI&rsquo;s own default.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-display text-2xs text-fg-muted">Spend cap per turn (USD)</span>
        <input
          value={budgetDraft}
          onChange={(e) => setBudgetDraft(e.target.value)}
          onBlur={() => setBudget(Number.parseFloat(budgetDraft))}
          inputMode="decimal"
          placeholder="no cap"
          className="rounded border border-edge-1 bg-surface-1 px-2 py-1 font-mono text-2xs text-fg-base placeholder:text-fg-subtle focus:outline-none"
        />
        <span className="font-display text-2xs leading-relaxed text-fg-subtle">
          Stops a turn once it has spent this much. Blank or 0 means no cap.
        </span>
      </label>
    </div>
  );
}
