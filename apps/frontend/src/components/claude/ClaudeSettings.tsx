import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { CLAUDE_PERMISSION_MODES, useSettings } from '../../state/settings';
import { useClaudeCode } from '../../state/claudeCode';
import type { ClaudePermissionMode } from '../../lib/tauri';
import { Select, type SelectOption } from '../Select';
import { Input } from '../ui';

/**
 * Settings block for the Claude Code panel.
 *
 * There is no connection to configure and no credential to store — Arc spawns
 * the user's own `claude` binary, which already holds their login. What's left
 * are the two decisions Arc has to make on their behalf every turn: how much
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

/** Plain names for the CLI's mode ids; the ids mean nothing to a reader. */
const MODE_LABEL: Record<ClaudePermissionMode, string> = {
  plan: 'Plan only',
  manual: 'Ask every time',
  auto: 'Ask when unsure',
  acceptEdits: 'Auto-apply edits',
  dontAsk: "Don't ask",
  bypassPermissions: 'Skip all checks',
};

export const RISKY_MODES: ClaudePermissionMode[] = ['dontAsk', 'bypassPermissions'];

/** Each mode carries its own help into the popover, so you can read what a
 *  mode does before choosing it rather than after. */
export const MODE_OPTIONS: SelectOption<ClaudePermissionMode>[] = CLAUDE_PERMISSION_MODES.map((m) => ({
  value: m,
  label: MODE_LABEL[m],
  hint: MODE_HELP[m],
  risky: RISKY_MODES.includes(m),
}));

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
      <div className="flex items-start gap-1.5 font-display text-xs">
        {status === 'ready' ? (
          <>
            <CircleCheck size={12} strokeWidth={2} className="mt-px shrink-0 text-status-ok" />
            <span className="min-w-0 break-all font-mono text-2xs text-fg-muted">{binary}</span>
          </>
        ) : status === 'checking' ? (
          <span className="text-fg-subtle">Looking for Claude Code…</span>
        ) : (
          <>
            <CircleAlert size={12} strokeWidth={2} className="mt-px shrink-0 text-fg-subtle" />
            <span className="text-fg-muted">
              <code className="font-mono">claude</code> is not on your PATH. Install Claude
              Code and sign in; Arc needs no key of its own.
            </span>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-display text-2xs text-fg-muted">Permission mode</span>
        <Select
          value={mode}
          onChange={setMode}
          ariaLabel="Permission mode"
          options={MODE_OPTIONS}
        />
        <span className="font-display text-2xs leading-relaxed text-fg-subtle">
          {MODE_HELP[mode]}
        </span>
      </div>

      {RISKY_MODES.includes(mode) && (
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
        <Input
          mono
          value={modelDraft}
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => setModel(modelDraft.trim())}
          placeholder="Default (whatever the CLI is set to)"
        />
        <span className="font-display text-2xs leading-relaxed text-fg-subtle">
          An alias — <code className="font-mono">opus</code>,{' '}
          <code className="font-mono">sonnet</code>, <code className="font-mono">haiku</code> —
          or a full model id. Leave empty to use your CLI&rsquo;s own default.
        </span>
      </label>

      <label className="flex flex-col gap-1">
        <span className="font-display text-2xs text-fg-muted">Spend cap per turn (USD)</span>
        <Input
          value={budgetDraft}
          onChange={(e) => setBudgetDraft(e.target.value)}
          onBlur={() => setBudget(Number.parseFloat(budgetDraft))}
          inputMode="decimal"
          placeholder="No cap"
        />
        <span className="font-display text-2xs leading-relaxed text-fg-subtle">
          Stops a turn once it has spent this much. Blank or 0 means no cap.
        </span>
      </label>
    </div>
  );
}
