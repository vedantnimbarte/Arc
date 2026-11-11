import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import type { DbTableSchema } from '../../lib/tauri';
import { ObjIcon, ToolButton, ToolWindowHeader, type ObjKind } from './chrome';

const TD = 'h-6 max-w-md truncate border-b border-edge-1 px-2.5 font-mono text-xs';

/** A group heading inside the properties view: the object icon, a name, a count. */
function Section({ kind, label, count, children }: { kind: ObjKind; label: string; count: number; children: ReactNode }) {
  return (
    <section className="mt-2">
      <h3 className="flex h-7 items-center gap-1.5 border-b border-edge-1 px-3 font-display text-xs font-medium text-fg-muted">
        <ObjIcon kind={kind} />
        {label}
        <span className="font-mono text-2xs tabular-nums text-fg-subtle">{count}</span>
      </h3>
      <table className="w-max min-w-full border-separate border-spacing-0 text-left">
        <tbody>{children}</tbody>
      </table>
    </section>
  );
}

/** A table's columns, indexes, foreign keys and checks, as an IDE properties view. */
export function SchemaView({
  table,
  schema,
  onClose,
  actions,
}: {
  table: string;
  schema: DbTableSchema;
  onClose: () => void;
  /** Buttons for the header, e.g. Import CSV / Copy DDL. */
  actions?: ReactNode;
}) {
  // Columns that point at another table get the foreign-key icon, as an IDE
  // marks them, so the key structure reads from the column list alone.
  const fkCols = new Set(schema.foreign_keys.flatMap((fk) => fk.columns.split(',').map((c) => c.trim())));
  return (
    <div className="pb-3">
      <ToolWindowHeader
        actions={
          <>
            {actions}
            <ToolButton icon={X} label="Close" onClick={onClose} />
          </>
        }
      >
        <span className="flex min-w-0 items-center gap-1.5 px-1">
          <ObjIcon kind="table" />
          <span className="truncate font-mono text-xs font-medium text-fg-base">{table}</span>
          <span className="truncate font-display text-2xs text-fg-subtle">
            {schema.columns.length} column{schema.columns.length === 1 ? '' : 's'}
          </span>
        </span>
      </ToolWindowHeader>

      <Section kind="column" label="Columns" count={schema.columns.length}>
        {schema.columns.map((c) => (
          <tr key={c.name} className="hover:bg-surface-1">
            <td className={TD}>
              <span className="flex items-center gap-1.5 text-fg-base">
                <span title={c.primary_key ? 'Primary key' : fkCols.has(c.name) ? 'Foreign key' : undefined}>
                  <ObjIcon kind={c.primary_key ? 'pk' : fkCols.has(c.name) ? 'fk' : 'column'} size={11} />
                </span>
                <span className={c.primary_key ? 'font-semibold' : undefined}>{c.name}</span>
              </span>
            </td>
            <td className={`${TD} lowercase text-fg-muted`}>{c.data_type}</td>
            <td className={`${TD} font-display text-2xs text-fg-subtle`}>{c.nullable ? 'nullable' : 'not null'}</td>
            <td className={`${TD} text-2xs text-fg-subtle`} title={c.default ?? ''}>
              {c.default !== null && <>default <span className="text-fg-muted">{c.default}</span></>}
            </td>
          </tr>
        ))}
      </Section>

      {schema.indexes.length > 0 && (
        <Section kind="index" label="Indexes" count={schema.indexes.length}>
          {schema.indexes.map((ix) => (
            <tr key={ix.name} className="hover:bg-surface-1">
              <td className={TD}>
                <span className="flex items-center gap-1.5 text-fg-base">
                  <ObjIcon kind={ix.primary ? 'pk' : 'index'} size={11} />
                  {ix.name}
                </span>
              </td>
              <td className={`${TD} text-fg-muted`}>({ix.columns})</td>
              <td
                className={`${TD} font-display text-2xs text-fg-subtle`}
                title={ix.implicit && !ix.primary ? 'Created by a UNIQUE constraint' : undefined}
              >
                {ix.primary ? 'primary key' : ix.implicit ? 'unique constraint' : ix.unique ? 'unique' : ''}
              </td>
            </tr>
          ))}
        </Section>
      )}

      {schema.foreign_keys.length > 0 && (
        <Section kind="fk" label="Foreign keys" count={schema.foreign_keys.length}>
          {schema.foreign_keys.map((fk, i) => (
            <tr key={`${fk.name}-${i}`} className="hover:bg-surface-1">
              {fk.name && (
                <td className={TD}>
                  <span className="flex items-center gap-1.5 text-fg-base">
                    <ObjIcon kind="fk" size={11} />
                    {fk.name}
                  </span>
                </td>
              )}
              <td className={`${TD} text-fg-muted`}>
                ({fk.columns}) <span className="text-fg-subtle">→</span> {fk.references}
              </td>
            </tr>
          ))}
        </Section>
      )}

      {schema.checks.length > 0 && (
        <Section kind="column" label="Checks" count={schema.checks.length}>
          {schema.checks.map((c, i) => (
            <tr key={`${c.name}-${i}`} className="hover:bg-surface-1">
              {c.name && <td className={`${TD} text-fg-base`}>{c.name}</td>}
              <td className={`${TD} text-fg-muted`} title={c.expression}>
                {c.expression}
              </td>
            </tr>
          ))}
        </Section>
      )}
    </div>
  );
}

