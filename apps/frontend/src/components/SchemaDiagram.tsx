import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Background,
  Controls,
  getNodesBounds,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import dagre from '@dagrejs/dagre';
import { toPng, toSvg } from 'html-to-image';
import { Copy, ImageDown, KeyRound, Link2, Table2, X } from 'lucide-react';
import {
  fsPickSaveFile,
  fsWriteBytes,
  fsWriteFile,
  type DbBackend,
  type DbRowCount,
  type DbTableSchema,
} from '../lib/tauri';
import { buildRelations, type Relation, type RelationKind } from '../lib/dbRelations';
import { createTableSql } from '../lib/schemaDiff';
import { formatRowCount } from '../lib/dbFormat';
import { toast, toastError } from '../state/toast';
import { cn } from '../lib/cn';

interface Props {
  backend: DbBackend;
  /** Every table's schema, loaded by the caller. */
  schemas: Record<string, DbTableSchema>;
  rowCounts: Record<string, DbRowCount>;
  onOpenTable: (table: string) => void;
  /** `onCloseDetails` deselects the table, closing just the side panel. */
  renderDetails: (table: string, schema: DbTableSchema, onCloseDetails: () => void) => ReactNode;
  onClose: () => void;
}

const NODE_W = 230;
const HEADER_H = 30;
const ROW_H = 20;

interface TableNodeData extends Record<string, unknown> {
  table: string;
  schema: DbTableSchema;
  isJunction: boolean;
  rows: string | null;
  dim: boolean;
  highlightedColumns: Set<string>;
}

/** Left-to-right auto layout, sized from each table's row count. */
function layout(nodes: Node<TableNodeData>[], edges: Array<{ source: string; target: string }>) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 36, ranksep: 90 });
  for (const n of nodes) {
    g.setNode(n.id, { width: n.width ?? NODE_W, height: n.height ?? HEADER_H });
  }
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const pos = g.node(n.id);
    const width = n.width ?? NODE_W;
    const height = n.height ?? HEADER_H;
    return { ...n, position: { x: pos.x - width / 2, y: pos.y - height / 2 } };
  });
}

function TableNode({ data, selected }: NodeProps<Node<TableNodeData>>) {
  const fkColumns = useMemo(
    () => new Set(data.schema.foreign_keys.flatMap((fk) => fk.columns.split(',').map((c) => c.trim()))),
    [data.schema],
  );
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-bg-panel shadow-panel transition-opacity',
        selected ? 'border-accent ring-1 ring-accent/60' : 'border-border-hairline',
        data.dim && 'opacity-30',
      )}
      style={{ width: NODE_W }}
    >
      <div className="flex items-center gap-1.5 border-b border-border-hairline bg-surface-1 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-base">{data.table}</span>
        {data.rows && (
          <span className="shrink-0 font-sans text-[9px] text-fg-subtle" title="rows">
            {data.rows}
          </span>
        )}
        {data.isJunction && (
          <span className="shrink-0 rounded bg-status-merged/15 px-1 py-0.5 font-sans text-[9px] uppercase tracking-wide text-status-merged">
            M:N
          </span>
        )}
      </div>
      {data.schema.columns.map((c) => {
        const isHighlighted = data.highlightedColumns.has(c.name);
        return (
          <div
            key={c.name}
            className={cn(
              'relative flex items-center gap-1.5 border-b border-border-hairline/60 px-2 py-1 last:border-b-0',
              isHighlighted && 'bg-accent-soft',
            )}
            style={{ height: ROW_H }}
          >
            <Handle type="target" position={Position.Left} id={`t:${c.name}`} style={handleStyle('left')} />
            {c.primary_key ? (
              <KeyRound size={9} className="shrink-0 text-accent" />
            ) : fkColumns.has(c.name) ? (
              <Link2 size={9} className="shrink-0 text-fg-subtle" />
            ) : (
              <span className="w-[9px] shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-base/85">{c.name}</span>
            <span className="shrink-0 truncate font-mono text-2xs text-fg-subtle/70">{c.data_type}</span>
            <Handle type="source" position={Position.Right} id={`s:${c.name}`} style={handleStyle('right')} />
          </div>
        );
      })}
    </div>
  );
}

function handleStyle(side: 'left' | 'right'): CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    [side]: -4,
    transform: 'translateY(-50%)',
    width: 6,
    height: 6,
    border: 'none',
    background: 'var(--fg-subtle, rgba(220, 226, 238, 0.4))',
  };
}

const KIND_PILL: Record<RelationKind, string> = {
  '1:1': 'bg-accent-soft text-fg-base ring-1 ring-accent/40',
  '1:N': 'bg-surface-2 text-fg-muted',
  'M:N': 'bg-status-merged/15 text-status-merged',
};

const KIND_STROKE: Record<RelationKind, string> = {
  '1:1': 'rgb(var(--accent-bright, 230 232 236))',
  '1:N': 'var(--fg-subtle, rgba(220, 226, 238, 0.4))',
  'M:N': '#9f8cf2',
};

interface RelationEdgeData extends Record<string, unknown> {
  kind: RelationKind;
  highlighted: boolean;
  dim: boolean;
  /** Collapsed M:N edge: the junction table it stands for. */
  via?: string;
}

function RelationEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<Edge<RelationEdgeData>>) {
  const kind = data?.kind ?? '1:N';
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });
  const opacity = data?.dim ? 0.2 : 1;
  const label = data?.via ? `M:N · ${data.via}` : kind;
  const w = Math.max(32, label.length * 6 + 10);
  return (
    <>
      <path
        id={id}
        d={path}
        fill="none"
        markerEnd={markerEnd}
        style={{
          stroke: KIND_STROKE[kind],
          strokeWidth: data?.highlighted ? 2 : 1.25,
          strokeDasharray: kind === 'M:N' ? '4 3' : undefined,
          opacity,
        }}
      />
      <foreignObject x={labelX - w / 2} y={labelY - 8} width={w} height={16} style={{ opacity, overflow: 'visible' }}>
        {/* Solid backing so the edge line doesn't show through the tinted pill. */}
        <div className="rounded bg-bg-panel">
          <div
            className={cn(
              'flex items-center justify-center whitespace-nowrap rounded px-1 font-mono text-[9px] leading-4',
              KIND_PILL[kind],
            )}
          >
            {label}
          </div>
        </div>
      </foreignObject>
    </>
  );
}

const NODE_TYPES = { table: TableNode };
const EDGE_TYPES = { relation: RelationEdge };
const EMPTY_SET = new Set<string>();

/** The page background, so an exported image isn't transparent. */
function canvasBackground(el: HTMLElement | null): string {
  let node: HTMLElement | null = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !bg.endsWith(', 0)')) return bg;
    node = node.parentElement;
  }
  return '#161618';
}

/**
 * Every table in the connection, laid out as an ER diagram: foreign keys
 * drawn column-to-column and labeled 1:1 / 1:N / M:N. Selecting a table
 * highlights its neighborhood and opens a details panel; double-clicking
 * jumps to that table's data preview. Tables can be filtered, junction
 * tables collapsed into one M:N edge, and the diagram exported as PNG/SVG.
 */
export function SchemaDiagram({ backend, schemas, rowCounts, onOpenTable, renderDetails, onClose }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [collapseJunctions, setCollapseJunctions] = useState(false);
  const [menu, setMenu] = useState<{ table: string; x: number; y: number } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<Node<TableNodeData>, Edge<RelationEdgeData>> | null>(null);

  const { relations, junctions } = useMemo(() => buildRelations(schemas), [schemas]);

  /** The relations to draw: junction legs become one edge when collapsed. */
  const shown = useMemo<Array<Relation & { via?: string }>>(() => {
    if (!collapseJunctions) return relations;
    const out: Array<Relation & { via?: string }> = relations.filter((r) => !r.viaJunction);
    for (const junction of Object.keys(junctions)) {
      // Each leg points junction → outer table; the edge joins the columns
      // the legs reference.
      const [a, b] = relations.filter((r) => r.viaJunction === junction);
      if (!a || !b) continue;
      out.push({ from: a.to, fromColumns: a.toColumns, to: b.to, toColumns: b.toColumns, kind: 'M:N', via: junction });
    }
    return out;
  }, [relations, junctions, collapseJunctions]);

  const hiddenJunctions = collapseJunctions ? junctions : {};

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<TableNodeData>>([]);

  // Layout runs when the schema or the collapse setting changes, not on
  // every selection — otherwise selecting a table would undo your dragging.
  useEffect(() => {
    const rawNodes: Node<TableNodeData>[] = Object.entries(schemas)
      .filter(([table]) => !(table in hiddenJunctions))
      .map(([table, s]) => ({
        id: table,
        type: 'table',
        position: { x: 0, y: 0 },
        width: NODE_W,
        height: HEADER_H + s.columns.length * ROW_H,
        data: {
          table,
          schema: s,
          isJunction: table in junctions,
          rows: null,
          dim: false,
          highlightedColumns: EMPTY_SET,
        },
      }));
    setNodes(layout(rawNodes, shown.map((r) => ({ source: r.from, target: r.to }))));
    requestAnimationFrame(() => flow.current?.fitView({ padding: 0.15 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas, collapseJunctions]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    return new Set(Object.keys(schemas).filter((t) => t.toLowerCase().includes(q)));
  }, [search, schemas]);

  // Fit the filtered tables into view.
  useEffect(() => {
    if (!matches || matches.size === 0) return;
    const ids = [...matches].map((id) => ({ id }));
    requestAnimationFrame(() => flow.current?.fitView({ nodes: ids, padding: 0.3, duration: 200 }));
  }, [matches]);

  const neighbors = useMemo(() => {
    if (!selected) return null;
    const set = new Set<string>([selected]);
    for (const r of shown) {
      if (r.from === selected) set.add(r.to);
      if (r.to === selected) set.add(r.from);
    }
    return set;
  }, [selected, shown]);

  const highlightedColumns = useMemo(() => {
    const map = new Map<string, Set<string>>();
    if (!selected) return map;
    const add = (table: string, columns: string[]) => {
      const set = map.get(table) ?? new Set<string>();
      for (const c of columns) set.add(c);
      map.set(table, set);
    };
    for (const r of shown) {
      if (r.from === selected || r.to === selected) {
        add(r.from, r.fromColumns);
        add(r.to, r.toColumns);
      }
    }
    return map;
  }, [selected, shown]);

  // Position/size come from `nodes` state (so dragging sticks); selection,
  // search and counts are layered on without touching that state.
  const decoratedNodes = useMemo<Node<TableNodeData>[]>(
    () =>
      nodes.map((n) => ({
        ...n,
        selected: n.id === selected,
        hidden: matches != null && !matches.has(n.id),
        data: {
          ...n.data,
          rows: formatRowCount(rowCounts[n.id]),
          dim: neighbors != null && !neighbors.has(n.id),
          highlightedColumns: highlightedColumns.get(n.id) ?? EMPTY_SET,
        },
      })),
    [nodes, selected, matches, rowCounts, neighbors, highlightedColumns],
  );

  const decoratedEdges = useMemo<Edge<RelationEdgeData>[]>(
    () =>
      shown.map((r, i) => {
        const touches = selected != null && (r.from === selected || r.to === selected);
        return {
          id: `${r.from}.${r.fromColumns.join('+')}->${r.to}.${r.toColumns.join('+')}#${i}`,
          source: r.from,
          sourceHandle: r.fromColumns[0] ? `s:${r.fromColumns[0]}` : undefined,
          target: r.to,
          targetHandle: r.toColumns[0] ? `t:${r.toColumns[0]}` : undefined,
          type: 'relation',
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: KIND_STROKE[r.kind] },
          data: { kind: r.kind, highlighted: touches, dim: selected != null && !touches, via: r.via },
        };
      }),
    [shown, selected],
  );

  const exportImage = async (kind: 'png' | 'svg') => {
    const viewport = container.current?.querySelector<HTMLElement>('.react-flow__viewport');
    const visible = decoratedNodes.filter((n) => !n.hidden);
    if (!viewport || visible.length === 0) return;
    const pad = 40;
    const bounds = getNodesBounds(visible);
    const width = Math.ceil(bounds.width + pad * 2);
    const height = Math.ceil(bounds.height + pad * 2);
    const opts = {
      backgroundColor: canvasBackground(container.current),
      width,
      height,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        transform: `translate(${pad - bounds.x}px, ${pad - bounds.y}px) scale(1)`,
      },
    };
    try {
      const path = await fsPickSaveFile(`schema.${kind}`);
      if (!path) return;
      if (kind === 'svg') {
        const url = await toSvg(viewport, opts);
        await fsWriteFile(path, decodeURIComponent(url.slice(url.indexOf(',') + 1)));
      } else {
        const url = await toPng(viewport, { ...opts, pixelRatio: 2 });
        await fsWriteBytes(path, url.slice(url.indexOf(',') + 1));
      }
      toast(`Saved ${path}`);
    } catch (e) {
      toastError(String(e));
    }
  };

  const copyDdl = async (table: string) => {
    const s = schemas[table];
    if (!s) return;
    const sql = createTableSql(backend, table, s).join(';\n\n') + ';';
    await navigator.clipboard.writeText(sql);
    toast(`CREATE TABLE ${table} copied`);
  };

  if (Object.keys(schemas).length === 0) {
    return (
      <div className="flex h-full items-center justify-center font-sans text-xs text-fg-subtle">No tables.</div>
    );
  }

  const selectedSchema = selected ? schemas[selected] : null;
  const toolBtn =
    'flex items-center gap-1 rounded px-1.5 py-0.5 font-sans text-2xs text-fg-muted transition hover:bg-surface-2 hover:text-fg-base';

  return (
    <div className="flex h-full">
      <div ref={container} className="relative min-w-0 flex-1" onClick={() => setMenu(null)}>
        <ReactFlow
          nodes={decoratedNodes}
          edges={decoratedEdges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onInit={(inst) => {
            flow.current = inst;
          }}
          onNodeClick={(_, node) => setSelected((prev) => (prev === node.id ? null : node.id))}
          onNodeDoubleClick={(_, node) => onOpenTable(node.id)}
          onNodeContextMenu={(e, node) => {
            e.preventDefault();
            const box = container.current!.getBoundingClientRect();
            setMenu({ table: node.id, x: e.clientX - box.left, y: e.clientY - box.top });
          }}
          onPaneClick={() => setSelected(null)}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} size={1} color="var(--border-hairline, rgba(0,0,0,0.42))" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="!bg-bg-panel" style={{ width: 140, height: 90 }} />
        </ReactFlow>

        <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-lg bg-bg-panel/90 p-1 shadow-control ring-1 ring-edge-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find table"
            spellCheck={false}
            className="w-36 rounded border border-border-subtle bg-bg-base/60 px-1.5 py-0.5 font-sans text-2xs text-fg-base placeholder:text-fg-subtle focus:border-accent/45 focus:outline-none"
          />
          {matches && <span className="px-1 font-sans text-2xs text-fg-subtle">{matches.size}</span>}
          {Object.keys(junctions).length > 0 && (
            <label className={cn(toolBtn, 'cursor-pointer')} title="Draw each junction table as one M:N edge">
              <input
                type="checkbox"
                checked={collapseJunctions}
                onChange={(e) => setCollapseJunctions(e.target.checked)}
                className="h-3 w-3 accent-accent"
              />
              Collapse M:N
            </label>
          )}
          <button type="button" onClick={() => void exportImage('png')} className={toolBtn} title="Export PNG">
            <ImageDown size={11} /> PNG
          </button>
          <button type="button" onClick={() => void exportImage('svg')} className={toolBtn} title="Export SVG">
            SVG
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Back to results"
          className="absolute right-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded bg-bg-panel text-fg-subtle shadow-control hover:text-fg-base"
        >
          <X size={12} />
        </button>

        {menu && (
          <div
            className="absolute z-20 min-w-[11rem] rounded-lg bg-bg-panel py-1 shadow-panel ring-1 ring-edge-2"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {[
              { label: 'Open data', icon: <Table2 size={11} />, run: () => onOpenTable(menu.table) },
              { label: 'Show details', icon: <KeyRound size={11} />, run: () => setSelected(menu.table) },
              { label: 'Copy CREATE TABLE', icon: <Copy size={11} />, run: () => void copyDdl(menu.table) },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setMenu(null);
                  item.run();
                }}
                className="flex w-full items-center gap-2 px-3 py-1 text-left font-sans text-xs text-fg-base/90 hover:bg-surface-2"
              >
                <span className="text-fg-subtle">{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {selected && selectedSchema && (
        <div className="w-72 shrink-0 overflow-auto border-l border-border-hairline">
          {renderDetails(selected, selectedSchema, () => setSelected(null))}
        </div>
      )}
    </div>
  );
}
