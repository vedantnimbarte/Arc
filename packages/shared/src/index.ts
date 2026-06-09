// Shared cross-package types. Keep this small — anything that grows belongs in
// a dedicated package.

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, 'SessionId'>;
export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type AgentId = Brand<string, 'AgentId'>;

export interface Result<T, E = Error> {
  ok: boolean;
  value?: T;
  error?: E;
}

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export {
  MODEL_PRICING,
  lookupPricing,
  estimateCostUsd,
  formatUsd,
  type ModelPricing,
} from './pricing';
