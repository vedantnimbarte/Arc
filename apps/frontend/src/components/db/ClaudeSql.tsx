import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react';
import { AiError, explainSqlIssue, suggestSql, type SqlContext, type SqlExplanation } from '../../lib/ai';

const errorText = (e: unknown) => (e instanceof AiError ? e.message : `Something went wrong: ${String(e)}`);

/**
 * "Describe the query you want": Claude writes SQL against the connection's
 * schema, shown here for review. Nothing runs — Use puts it in the editor.
 */
export function AskClaudeBar({
  ctx,
  onUse,
  onClose,
}: {
  ctx: SqlContext;
  onUse: (sql: string) => void;
  onClose: () => void;
}) {
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const ask = async () => {
    const r = request.trim();
    if (!r || busy) return;
    setBusy(true);
    setError(null);
    setSql(null);
    try {
      setSql(await suggestSql(r, ctx));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-border-hairline bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-2">
        <Sparkles size={12} className="shrink-0 text-accent" />
        <input
          ref={input}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Describe the query, e.g. “ten customers with the most orders this month”"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-sans text-xs text-fg-base placeholder:text-fg-subtle focus:outline-none"
        />
        {busy ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-fg-subtle" />
        ) : (
          <button
            type="button"
            onClick={() => void ask()}
            disabled={!request.trim()}
            title="Ask Claude (Enter)"
            className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-surface-2 hover:text-fg-base disabled:opacity-40"
          >
            <CornerDownLeft size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
        >
          <X size={12} />
        </button>
      </div>
      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 font-sans text-xs text-status-err">
          <CircleAlert size={12} className="mt-0.5 shrink-0" />
          {error}
        </p>
      )}
      {sql && (
        <div className="mt-2">
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg-base px-3 py-2 font-mono text-xs text-fg-base/90 ring-1 ring-border-hairline">
            {sql}
          </pre>
          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => onUse(sql)}
              className="rounded-lg bg-accent-soft px-2.5 py-1 font-sans text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20"
            >
              Use in editor
            </button>
            <span className="font-sans text-2xs text-fg-subtle">Read it before running — nothing has run yet.</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Claude's reading of an error or a slow plan, with an optional fixed statement. */
export function ClaudeExplain({
  sql,
  problem,
  ctx,
  onUseFix,
  onClose,
}: {
  sql: string;
  problem: { error: string } | { plan: string };
  ctx: SqlContext;
  onUseFix: (sql: string) => void;
  onClose: () => void;
}) {
  const [result, setResult] = useState<SqlExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    explainSqlIssue(sql, problem, ctx).then(
      (r) => live && setResult(r),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
    // Asked once per panel; a new question opens a new panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="shrink-0 border-b border-border-hairline bg-surface-1 px-3 py-2 font-sans text-xs">
      <div className="flex items-start gap-2">
        <Sparkles size={12} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          {!result && !error && (
            <span className="flex items-center gap-1.5 text-fg-subtle">
              <Loader2 size={11} className="animate-spin" /> Asking Claude…
            </span>
          )}
          {error && <span className="text-status-err">{error}</span>}
          {result && <p className="whitespace-pre-wrap leading-relaxed text-fg-base/90">{result.explanation}</p>}
          {result?.fix && (
            <>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-bg-base px-3 py-2 font-mono text-xs text-fg-base/90 ring-1 ring-border-hairline">
                {result.fix}
              </pre>
              <button
                type="button"
                onClick={() => onUseFix(result.fix!)}
                className="mt-1.5 rounded-lg bg-accent-soft px-2.5 py-1 text-xs text-fg-base ring-1 ring-accent/45 transition-colors hover:bg-accent/20"
              >
                Use in editor
              </button>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Close"
          className="shrink-0 rounded p-1 text-fg-muted transition hover:bg-surface-2 hover:text-fg-base"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
