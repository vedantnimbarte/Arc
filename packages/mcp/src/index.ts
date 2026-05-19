// Shared TypeScript types for the Model Context Protocol client. The real
// transport lives Rust-side in `apps/desktop/src/commands/mcp.rs` — this
// package only exists so the frontend (and any future TS-side consumer)
// can name the same shapes Tauri serializes across the boundary.

/** One tool exported by a connected MCP server. */
export interface McpTool {
  name: string;
  description?: string | null;
  /** JSON Schema for the tool's `arguments`. Servers often omit it. */
  inputSchema?: unknown;
}

/**
 * One JSON-RPC notification forwarded from a server. Emitted on the
 * Tauri event topic `mcp://notification/<server_id>`. The Rust side
 * dispatches every JSON-RPC message it sees with no `id` and a
 * `method` field.
 */
export interface McpNotification {
  server_id: string;
  /** JSON-RPC method, e.g. `notifications/message`. */
  method: string;
  /** Raw params object — schema is method-dependent. */
  params: unknown;
}

/**
 * Known MCP notification methods. The transport forwards anything that
 * looks like a notification, so callers should treat unknown methods as
 * a forward-compatibility hook rather than an error.
 */
export const McpNotificationMethod = {
  /** Server log message, often with `level` + `data`. */
  Message: 'notifications/message',
  /** Long-running operation progress update. */
  Progress: 'notifications/progress',
  /** Server's tool inventory changed — clients should re-list. */
  ToolsListChanged: 'notifications/tools/list_changed',
  /** Server's resource inventory changed. */
  ResourcesListChanged: 'notifications/resources/list_changed',
  /** Server's prompt inventory changed. */
  PromptsListChanged: 'notifications/prompts/list_changed',
  /** Resource subscribed via `resources/subscribe` was updated. */
  ResourceUpdated: 'notifications/resources/updated',
  /** Sent by the client after `initialize` succeeds; included for
   *  completeness — not something the client receives. */
  Initialized: 'notifications/initialized',
  /** Generic cancellation, either direction. */
  Cancelled: 'notifications/cancelled',
} as const;

export type McpNotificationMethod =
  (typeof McpNotificationMethod)[keyof typeof McpNotificationMethod];

/** Payload shape for `notifications/message`. */
export interface McpLogParams {
  level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
  logger?: string;
  data?: unknown;
}

/** Payload shape for `notifications/progress`. */
export interface McpProgressParams {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}
