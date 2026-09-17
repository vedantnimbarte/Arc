import type { DbBackend, DbQueryResult } from './tauri';

/**
 * EXPLAIN for the database client: build the dialect's EXPLAIN statement and
 * parse what comes back into one tree shape. Pure, so each engine's format is
 * tested against fixture output.
 */

export interface PlanNode {
  /** Operation: `Seq Scan`, `Full scan`, `SEARCH t USING INDEX …`. */
  label: string;
  /** Table (or index) the node reads, when there is one. */
  relation?: string;
  /** Extra one-line context: filter, index, join condition. */
  detail?: string;
  estRows?: number;
  /** Planner cost, including the node's subtree. */
  estCost?: number;
  /** ANALYZE only. */
  actualRows?: number;
  /** ANALYZE only: total time across loops, ms, cumulative. */
  actualMs?: number;
  children: PlanNode[];
}

/** The EXPLAIN statement for `sql`. `analyze` is Postgres-only and runs it. */
export function explainSql(backend: DbBackend, sql: string, analyze: boolean): string {
  const body = sql.trim().replace(/;+\s*$/, '');
  switch (backend) {
    case 'postgres':
      return `EXPLAIN (${analyze ? 'ANALYZE, ' : ''}FORMAT JSON) ${body}`;
    case 'mysql':
      return `EXPLAIN FORMAT=JSON ${body}`;
    case 'sqlite':
      return `EXPLAIN QUERY PLAN ${body}`;
  }
}

/** Parse an EXPLAIN result grid into plan roots. Throws on unexpected output. */
export function parsePlan(backend: DbBackend, result: Pick<DbQueryResult, 'columns' | 'rows'>): PlanNode[] {
  if (backend === 'sqlite') return parseSqlitePlan(result.rows);
  const text = result.rows[0]?.[0];
  if (!text) throw new Error('EXPLAIN returned no plan');
  const json: unknown = JSON.parse(text);
  return backend === 'postgres' ? parsePostgresPlan(json) : parseMysqlPlan(json);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

// ─── Postgres: EXPLAIN (FORMAT JSON) ─────────────────────────────────────

export function parsePostgresPlan(json: unknown): PlanNode[] {
  const roots = Array.isArray(json) ? json : [json];
  return roots.filter(isObj).map((r) => pgNode(r.Plan));
}

function pgNode(v: unknown): PlanNode {
  const p = isObj(v) ? v : {};
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
  const join = str('Join Type');
  const loops = num(p['Actual Loops']) ?? 1;
  const total = num(p['Actual Total Time']);
  return {
    label: [join, str('Node Type') ?? '?'].filter(Boolean).join(' '),
    relation: str('Relation Name') ?? str('CTE Name') ?? str('Function Name'),
    detail: str('Index Name')
      ? `using ${str('Index Name')}`
      : (str('Filter') ?? str('Hash Cond') ?? str('Merge Cond') ?? str('Join Filter')),
    estRows: num(p['Plan Rows']),
    estCost: num(p['Total Cost']),
    actualRows: num(p['Actual Rows']),
    actualMs: total === undefined ? undefined : total * loops,
    children: Array.isArray(p.Plans) ? p.Plans.map(pgNode) : [],
  };
}

// ─── MySQL: EXPLAIN FORMAT=JSON ──────────────────────────────────────────

/**
 * MySQL's JSON plan is a nest of named operations (`query_block`,
 * `ordering_operation`, `nested_loop`, …) with `table` leaves. Every object
 * under a key becomes a node named after the key; arrays are flattened into
 * their parent, except `nested_loop`, which is the join itself.
 */
export function parseMysqlPlan(json: unknown): PlanNode[] {
  return isObj(json) ? mysqlChildren(json) : [];
}

/** Keys holding metadata objects rather than plan operations. */
const MYSQL_META = new Set(['cost_info']);

function mysqlChildren(o: Obj): PlanNode[] {
  const out: PlanNode[] = [];
  for (const [key, value] of Object.entries(o)) {
    if (MYSQL_META.has(key)) continue;
    if (key === 'nested_loop' && Array.isArray(value)) {
      out.push({ label: 'nested loop', children: value.filter(isObj).flatMap(mysqlChildren) });
    } else if (Array.isArray(value)) {
      out.push(...value.filter(isObj).flatMap(mysqlChildren));
    } else if (key === 'table' && isObj(value)) {
      out.push(mysqlTable(value));
    } else if (isObj(value)) {
      const cost = isObj(value.cost_info) ? value.cost_info : {};
      out.push({
        label: key.replace(/_/g, ' '),
        estCost: num(cost.query_cost) ?? num(cost.sort_cost),
        children: mysqlChildren(value),
      });
    }
  }
  return out;
}

function mysqlTable(t: Obj): PlanNode {
  const cost = isObj(t.cost_info) ? t.cost_info : {};
  const access = typeof t.access_type === 'string' ? t.access_type : '';
  const read = num(cost.read_cost);
  const evalCost = num(cost.eval_cost);
  const key = typeof t.key === 'string' ? `using ${t.key}` : undefined;
  const cond = typeof t.attached_condition === 'string' ? t.attached_condition : undefined;
  return {
    label: access === 'ALL' ? 'Full scan' : `${access || 'table'} access`,
    relation: typeof t.table_name === 'string' ? t.table_name : undefined,
    detail: key ?? cond,
    estRows: num(t.rows_examined_per_scan),
    estCost: read === undefined && evalCost === undefined ? undefined : (read ?? 0) + (evalCost ?? 0),
    // Subqueries hang off the table that evaluates them.
    children: mysqlChildren(
      Object.fromEntries(Object.entries(t).filter(([, v]) => isObj(v) || Array.isArray(v))),
    ),
  };
}

// ─── SQLite: EXPLAIN QUERY PLAN ──────────────────────────────────────────

/** Rows are `id, parent, notused, detail`; parent 0 is the root. */
export function parseSqlitePlan(rows: Array<Array<string | null>>): PlanNode[] {
  const byId = new Map<string, PlanNode>();
  const roots: PlanNode[] = [];
  for (const [id, parent, , detail] of rows) {
    const node: PlanNode = { label: detail ?? '', children: [] };
    const table = /^(?:SCAN|SEARCH)\s+(?:TABLE\s+)?(\S+)/.exec(node.label)?.[1];
    if (table) node.relation = table;
    byId.set(id ?? '', node);
    const up = byId.get(parent ?? '');
    (up ? up.children : roots).push(node);
  }
  return roots;
}

// ─── Hot spots ───────────────────────────────────────────────────────────

/**
 * The nodes worth highlighting. With timings or costs, a node is hot when its
 * own share is at least half of the largest share. A node's measure (ANALYZE
 * time, else estimated cost) includes its subtree — true of Postgres, and of
 * MySQL's `query_cost` over its tables — so its own share is the measure
 * minus its children's; a node with no measure passes its children's total
 * up. Without any numbers (SQLite) a full `SCAN` is hot, since that's what an
 * index fixes.
 */
export function hotNodes(roots: PlanNode[]): Set<PlanNode> {
  const all: PlanNode[] = [];
  const walk = (n: PlanNode) => {
    all.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);

  const timed = all.some((n) => n.actualMs !== undefined);
  const measure = (n: PlanNode) => (timed ? n.actualMs : n.estCost);
  if (!all.some((n) => measure(n) !== undefined)) {
    return new Set(all.filter((n) => /^SCAN\b/.test(n.label) && !/COVERING INDEX/.test(n.label)));
  }
  const total = (n: PlanNode): number =>
    measure(n) ?? n.children.reduce((s, c) => s + total(c), 0);
  const own = new Map(
    all.map((n) => {
      const m = measure(n);
      const kids = n.children.reduce((s, c) => s + total(c), 0);
      return [n, m === undefined ? 0 : Math.max(0, m - kids)];
    }),
  );
  const max = Math.max(...own.values());
  if (max <= 0) return new Set();
  return new Set(all.filter((n) => own.get(n)! >= max / 2));
}
