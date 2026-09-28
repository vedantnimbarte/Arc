import { dbTableSchema, type DbTableSchema } from './tauri';

/**
 * Every listed table's schema. A few at a time: the backend pool is three
 * connections, and one may be pinned to a transaction.
 */
// ponytail: one IPC call per table. Add a batched command if a schema with
// thousands of tables makes this slow.
export async function loadSchemas(
  connId: string,
  tables: string[],
  concurrency = 3,
): Promise<Record<string, DbTableSchema>> {
  const out: Record<string, DbTableSchema> = {};
  let next = 0;
  const worker = async () => {
    while (next < tables.length) {
      const t = tables[next++]!;
      out[t] = await dbTableSchema(connId, t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tables.length) }, worker));
  // Keep the listing's order.
  return Object.fromEntries(tables.filter((t) => t in out).map((t) => [t, out[t]!]));
}
