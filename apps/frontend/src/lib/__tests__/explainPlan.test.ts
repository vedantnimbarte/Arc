import { describe, expect, it } from 'vitest';
import { explainSql, hotNodes, parsePlan, type PlanNode } from '../explainPlan';

// Trimmed from real server output.
const PG_ANALYZE = [
  {
    Plan: {
      'Node Type': 'Hash Join',
      'Join Type': 'Inner',
      'Total Cost': 250.5,
      'Plan Rows': 1000,
      'Actual Total Time': 12.5,
      'Actual Rows': 990,
      'Actual Loops': 1,
      'Hash Cond': '(o.user_id = u.id)',
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          Alias: 'o',
          'Total Cost': 180,
          'Plan Rows': 10000,
          'Actual Total Time': 9,
          'Actual Rows': 10000,
          'Actual Loops': 1,
          Filter: '(total > 10)',
        },
        {
          'Node Type': 'Hash',
          'Total Cost': 30,
          'Plan Rows': 500,
          'Actual Total Time': 0.25,
          'Actual Rows': 500,
          'Actual Loops': 1,
          Plans: [
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'users',
              'Index Name': 'users_pkey',
              'Total Cost': 25,
              'Plan Rows': 500,
              'Actual Total Time': 0.1,
              'Actual Rows': 500,
              'Actual Loops': 2,
            },
          ],
        },
      ],
    },
    'Planning Time': 0.2,
    'Execution Time': 13,
  },
];

const MYSQL = {
  query_block: {
    select_id: 1,
    cost_info: { query_cost: '1210.50' },
    ordering_operation: {
      using_filesort: true,
      nested_loop: [
        {
          table: {
            table_name: 'orders',
            access_type: 'ALL',
            rows_examined_per_scan: 10000,
            filtered: '33.33',
            cost_info: { read_cost: '800.00', eval_cost: '200.00', prefix_cost: '1000.00' },
            used_columns: ['id', 'user_id'],
            attached_condition: '(`orders`.`total` > 10)',
          },
        },
        {
          table: {
            table_name: 'users',
            access_type: 'eq_ref',
            key: 'PRIMARY',
            rows_examined_per_scan: 1,
            cost_info: { read_cost: '150.00', eval_cost: '60.50', prefix_cost: '1210.50' },
          },
        },
      ],
    },
  },
};

const SQLITE = {
  columns: ['id', 'parent', 'notused', 'detail'],
  rows: [
    ['2', '0', '0', 'SCAN orders'],
    ['5', '0', '0', 'SEARCH users USING INTEGER PRIMARY KEY (rowid=?)'],
    ['9', '0', '0', 'CORRELATED SCALAR SUBQUERY 1'],
    ['12', '9', '0', 'SCAN items USING COVERING INDEX items_order'],
  ],
};

const strip = (n: PlanNode): unknown => ({
  label: n.label,
  relation: n.relation,
  children: n.children.map(strip),
});

describe('explainSql', () => {
  it('wraps the statement per dialect', () => {
    expect(explainSql('postgres', 'SELECT 1;', false)).toBe('EXPLAIN (FORMAT JSON) SELECT 1');
    expect(explainSql('postgres', 'SELECT 1', true)).toBe('EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1');
    expect(explainSql('mysql', 'SELECT 1', true)).toBe('EXPLAIN FORMAT=JSON SELECT 1');
    expect(explainSql('sqlite', ' SELECT 1 ', false)).toBe('EXPLAIN QUERY PLAN SELECT 1');
  });
});

describe('parsePlan', () => {
  it('reads a Postgres ANALYZE plan', () => {
    const [root] = parsePlan('postgres', { columns: ['QUERY PLAN'], rows: [[JSON.stringify(PG_ANALYZE)]] });
    expect(strip(root!)).toEqual({
      label: 'Inner Hash Join',
      relation: undefined,
      children: [
        { label: 'Seq Scan', relation: 'orders', children: [] },
        { label: 'Hash', relation: undefined, children: [{ label: 'Index Scan', relation: 'users', children: [] }] },
      ],
    });
    expect(root).toMatchObject({ estRows: 1000, estCost: 250.5, actualRows: 990, actualMs: 12.5 });
    expect(root!.children[0]).toMatchObject({ detail: '(total > 10)' });
    // Time is per loop in the plan; the node reports the total.
    expect(root!.children[1]!.children[0]).toMatchObject({ actualMs: 0.2, detail: 'using users_pkey' });

    const hot = hotNodes([root!]);
    expect([...hot].map((n) => n.label)).toEqual(['Seq Scan']);
  });

  it('reads a MySQL JSON plan', () => {
    const roots = parsePlan('mysql', { columns: ['EXPLAIN'], rows: [[JSON.stringify(MYSQL)]] });
    expect(roots.map(strip)).toEqual([
      {
        label: 'query block',
        relation: undefined,
        children: [
          {
            label: 'ordering operation',
            relation: undefined,
            children: [
              {
                label: 'nested loop',
                relation: undefined,
                children: [
                  { label: 'Full scan', relation: 'orders', children: [] },
                  { label: 'eq_ref access', relation: 'users', children: [] },
                ],
              },
            ],
          },
        ],
      },
    ]);
    const loop = roots[0]!.children[0]!.children[0]!;
    expect(loop.children[0]).toMatchObject({ estRows: 10000, estCost: 1000, detail: '(`orders`.`total` > 10)' });
    expect(loop.children[1]).toMatchObject({ estCost: 210.5, detail: 'using PRIMARY' });
    expect(roots[0]).toMatchObject({ estCost: 1210.5 });

    expect([...hotNodes(roots)].map((n) => n.relation)).toEqual(['orders']);
  });

  it('reads a SQLite query plan', () => {
    const roots = parsePlan('sqlite', SQLITE);
    expect(roots.map(strip)).toEqual([
      { label: 'SCAN orders', relation: 'orders', children: [] },
      { label: 'SEARCH users USING INTEGER PRIMARY KEY (rowid=?)', relation: 'users', children: [] },
      {
        label: 'CORRELATED SCALAR SUBQUERY 1',
        relation: undefined,
        children: [{ label: 'SCAN items USING COVERING INDEX items_order', relation: 'items', children: [] }],
      },
    ]);
    // No costs: a full scan is the hot spot, a covering-index scan is not.
    expect([...hotNodes(roots)].map((n) => n.label)).toEqual(['SCAN orders']);
  });

  it('rejects an empty result', () => {
    expect(() => parsePlan('postgres', { columns: [], rows: [] })).toThrow(/no plan/);
  });
});
