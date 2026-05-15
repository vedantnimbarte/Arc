import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export type PtyId = string;

export interface PtySpawnOptions {
  shell?: string | null;
  cwd?: string | null;
  cols: number;
  rows: number;
}

export interface PtyDataEvent {
  id: PtyId;
  bytes: number[];
}

export interface PtyExitEvent {
  id: PtyId;
  code: number | null;
}

export async function ptySpawn(opts: PtySpawnOptions): Promise<PtyId> {
  return invoke<PtyId>('pty_spawn', { opts });
}

export async function ptyWrite(id: PtyId, data: string): Promise<void> {
  await invoke('pty_write', { id, data });
}

export async function ptyResize(id: PtyId, cols: number, rows: number): Promise<void> {
  await invoke('pty_resize', { id, cols, rows });
}

export async function ptyKill(id: PtyId): Promise<void> {
  await invoke('pty_kill', { id });
}

export async function onPtyData(
  id: PtyId,
  handler: (chunk: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<PtyDataEvent>(`pty://data/${id}`, (event) => {
    handler(new Uint8Array(event.payload.bytes));
  });
}

export async function onPtyExit(
  id: PtyId,
  handler: (code: number | null) => void,
): Promise<UnlistenFn> {
  return listen<PtyExitEvent>(`pty://exit/${id}`, (event) => {
    handler(event.payload.code);
  });
}

// ----- LLM streaming -----------------------------------------------------

export type LlmProvider = 'openai' | 'anthropic' | 'ollama';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmStreamReq {
  id: string;
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
  system?: string;
  temperature?: number;
  max_tokens?: number;
  api_key?: string;
  base_url?: string;
}

export interface LlmChunk {
  text: string;
  done: boolean;
}

export interface LlmDoneEvent {
  ok?: true;
  cancelled?: true;
  error?: string;
}

/**
 * Start a streaming LLM completion. Returns a cancel function. `onChunk`
 * fires for every text delta, `onDone` fires exactly once with the final
 * status. Both happen on the main thread.
 */
export async function llmStream(
  req: LlmStreamReq,
  onChunk: (chunk: LlmChunk) => void,
  onDone: (ev: LlmDoneEvent) => void,
): Promise<() => Promise<void>> {
  const unlistenChunk = await listen<LlmChunk>(`llm://chunk/${req.id}`, (e) => onChunk(e.payload));
  const unlistenDone = await listen<LlmDoneEvent>(`llm://done/${req.id}`, (e) => {
    unlistenChunk();
    unlistenDone();
    onDone(e.payload);
  });

  try {
    await invoke('llm_stream', { req });
  } catch (err) {
    unlistenChunk();
    unlistenDone();
    onDone({ error: String(err) });
  }

  return async () => {
    unlistenChunk();
    unlistenDone();
    try {
      await invoke('llm_cancel', { id: req.id });
    } catch {
      /* already gone */
    }
  };
}
