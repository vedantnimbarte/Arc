import { queryJsonPath } from './jsonPath';
import type { HttpResponseDto } from './tauri';

/**
 * Response chaining for the API Client: after a successful response, read
 * values out of it into environment variables (`token ← $.data.accessToken`).
 * Pure — the component writes the results into the active environment.
 */

export interface PostVarRule {
  id: string;
  enabled: boolean;
  variable: string;
  source: 'json' | 'header' | 'status';
  /** JSONPath for `json`, header name for `header`, unused for `status`. */
  path: string;
}

export interface PostVarResult {
  variable: string;
  /** The value set, or undefined when the rule found nothing. */
  value?: string;
  error?: string;
}

/** Evaluate every enabled, named rule against `resp`. */
export function extractVariables(
  rules: PostVarRule[],
  resp: Pick<HttpResponseDto, 'status' | 'headers' | 'body_text'>,
): PostVarResult[] {
  let body: { ok: true; value: unknown } | { ok: false } | undefined;
  return rules
    .filter((r) => r.enabled && r.variable.trim())
    .map((r) => {
      const variable = r.variable.trim();
      if (r.source === 'status') return { variable, value: String(resp.status) };
      if (r.source === 'header') {
        const name = r.path.trim().toLowerCase();
        const h = resp.headers.find((x) => x.name.toLowerCase() === name);
        return h ? { variable, value: h.value } : { variable, error: `no ${r.path} header` };
      }
      if (!body) {
        try {
          body = { ok: true, value: JSON.parse(resp.body_text ?? '') };
        } catch {
          body = { ok: false };
        }
      }
      if (!body.ok) return { variable, error: 'response is not JSON' };
      try {
        const v = queryJsonPath(body.value, r.path);
        if (v === undefined) return { variable, error: `nothing at ${r.path}` };
        return { variable, value: typeof v === 'string' ? v : JSON.stringify(v) };
      } catch (e) {
        return { variable, error: e instanceof Error ? e.message : String(e) };
      }
    });
}
