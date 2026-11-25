import { useEffect } from 'react';
import { useStore, type StoreApi } from 'zustand';
import { Select } from '../Select';
import { chooseConfig, flatChoices, useAcpPrefs } from '../../state/acpAgents';
import type { ClaudeSession } from '../../state/claudeCode';

/**
 * One picker per setting an ACP agent offers (model, mode, effort, …), built
 * from what the agent itself reports, so any agent's options work without
 * ARC knowing them.
 *
 * Before a conversation exists, shows the options the agent offered last time,
 * set to the user's remembered choices — which the next conversation starts
 * with.
 */
export function AgentConfigPickers({
  store,
  provider,
  className,
}: {
  store: StoreApi<ClaudeSession>;
  provider: string;
  className?: string;
}) {
  const live = useStore(store, (s) => s.config);
  const known = useAcpPrefs((s) => s.known[provider]);
  const choices = useAcpPrefs((s) => s.choices[provider]);
  const remember = useAcpPrefs((s) => s.remember);

  useEffect(() => {
    if (live) remember(provider, live);
  }, [live, provider, remember]);

  const options = (live ?? known ?? []).filter((o) => o.type === 'select');
  if (options.length === 0) return null;

  return (
    <>
      {options.map((o) => {
        const value = live ? o.currentValue : (choices?.[o.id] ?? o.currentValue);
        const items = flatChoices(o).map((c) => ({
          value: c.value,
          label: c.name,
          hint: c.description ?? undefined,
        }));
        // A remembered value the agent no longer lists still shows as itself.
        if (!items.some((i) => i.value === value))
          items.unshift({ value, label: value, hint: undefined });
        return (
          <Select
            key={o.id}
            size="compact"
            ariaLabel={o.name}
            value={value}
            options={items}
            onChange={(v) => void chooseConfig(store, provider, o.id, v)}
            className={className ?? 'w-auto max-w-[12rem]'}
          />
        );
      })}
    </>
  );
}
