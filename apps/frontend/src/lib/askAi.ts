import { Sparkles } from 'lucide-react';
import type { CommandAction } from '../state/commands';

/** Offer "Ask AI" only when the palette is close to empty, so it never
 *  pushes a real command out of the top slots. */
export const ASK_AI_MAX_MATCHES = 3;
export const ASK_AI_MIN_QUERY_LENGTH = 3;

/** Append an "Ask AI: <query>" row when few commands match the query. */
export function withAskAiFallback(
  visible: readonly CommandAction[],
  query: string,
  ask: (prompt: string) => void,
): CommandAction[] {
  const prompt = query.trim();
  if (visible.length >= ASK_AI_MAX_MATCHES || prompt.length < ASK_AI_MIN_QUERY_LENGTH) {
    return [...visible];
  }
  return [
    ...visible,
    {
      id: 'ai.ask-palette-query',
      title: `Ask AI: ${prompt}`,
      description: 'Send this to your agent',
      group: 'Claude Code',
      icon: Sparkles,
      run: () => ask(prompt),
    },
  ];
}
