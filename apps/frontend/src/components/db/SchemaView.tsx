import type { ReactNode } from 'react';
import { Columns3, KeyRound, X } from 'lucide-react';
import type { DbTableSchema } from '../../lib/tauri';

const TH =
  'whitespace-nowrap border-b border-r border-border-hairline px-2.5 py-1 font-sans text-2xs uppercase tracking-widest text-fg-subtle/70';
const TD =
  'max-w-md truncate border-b border-r border-border-hairline px-2.5 py-0.5 font-mono text-xs text-fg-base/85';

/** A table's columns, indexes, foreign keys and checks, in the grid's own styling. */
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
  const section = (label: string) => (
    <div className="px-3 pb-1 pt-3 font-sans text-2xs uppercase tracking-widest text-fg-subtle/60">
      {label}
    </div>
  );
  return (
    <div className="pb-3">
      <div className="flex items-center gap-2 border-b border-border-hairline px-3 py-1.5">
        <Columns3 size={12} className="shrink-0 text-fg-subtle" />
        <span className="truncate font-mono text-xs text-fg-base">{table}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
          <button type="button" onClick={onClose} title="Close" className="text-fg-subtle hover:text-fg-base">
            <X size={12} />
          </button>
        </span>
      </div>

      {section('Columns')}
      <table className="w-max min-w-full border-collapse text-left">
        <thead>
          <tr>
            {['Name', 'Type', 'Nullable', 'Default'].map((h) => (
              <th key={h} className={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {schema.columns.map((c) => (
            <tr key={c.name}>
              <td className={TD}>
                <span className="flex items-center gap-1.5">
                  {c.name}
                  {c.primary_key && (
                    <span title="Primary key">
                      <KeyRound size={10} className="text-accent" />
                    </span>
                  )}
                </span>
              </td>
              <td className={TD}>{c.data_type}</td>
              <td className={TD}>{c.nullable ? 'yes' : 'no'}</td>
              <td className={TD} title={c.default ?? ''}>
                {c.default ?? <span className="italic text-fg-subtle/60">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {schema.indexes.length > 0 && (
        <>
          {section('Indexes')}
          <table className="w-max min-w-full border-collapse text-left">
            <tbody>
              {schema.indexes.map((ix) => (
                <tr key={ix.name}>
                  <td className={TD}>{ix.name}</td>
                  <td className={TD}>{ix.columns}</td>
                  <td className={TD} title={ix.implicit && !ix.primary ? 'Created by a UNIQUE constraint' : undefined}>
                    {ix.primary ? 'primary key' : ix.implicit ? 'unique constraint' : ix.unique ? 'unique' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {schema.foreign_keys.length > 0 && (
        <>
          {section('Foreign keys')}
          <table className="w-max min-w-full border-collapse text-left">
            <tbody>
              {schema.foreign_keys.map((fk, i) => (
                <tr key={`${fk.name}-${i}`}>
                  {fk.name && <td className={TD}>{fk.name}</td>}
                  <td className={TD}>
                    {fk.columns} → {fk.references}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {schema.checks.length > 0 && (
        <>
          {section('Checks')}
          <table className="w-max min-w-full border-collapse text-left">
            <tbody>
              {schema.checks.map((c, i) => (
                <tr key={`${c.name}-${i}`}>
                  {c.name && <td className={TD}>{c.name}</td>}
                  <td className={TD} title={c.expression}>
                    {c.expression}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
