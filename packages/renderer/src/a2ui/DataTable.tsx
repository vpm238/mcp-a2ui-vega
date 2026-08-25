/**
 * DataTable — the receipt.
 *
 * A chart moving by a pixel is not proof that an appended order landed; a row
 * appearing at the top of a table is. Sorting is client-side and clicking a
 * header re-sorts, but the agent's `sortBy` is the initial state so a dashboard
 * opens showing what it meant to show.
 */
import { useMemo, useState } from 'react';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { DataTableApi, applyFilters, formatValue, type Filter } from '@mcp-a2ui-vega/catalog';

type Row = Record<string, unknown>;

const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

interface Column {
  field: string;
  label?: string;
  format?: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

/** Numbers sort numerically, everything else as text — including ISO dates. */
function compare(a: unknown, b: unknown): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}

export const DataTable = createComponentImplementation(DataTableApi, ({ props }) => {
  const [sort, setSort] = useState<{ field: string; order: 'asc' | 'desc' } | null>(null);

  const columns: Column[] = useMemo(() => {
    if (props.columns && props.columns.length > 0) return props.columns as Column[];
    const first = asRows(props.rows)[0];
    return Object.keys(first ?? {}).map(field => ({ field }));
  }, [props.columns, props.rows]);

  const active = sort ?? (props.sortBy ? { field: props.sortBy, order: props.sortOrder ?? 'asc' } : null);
  const limit = Number(props.limit ?? 50);

  const rows = useMemo(() => {
    const filtered = applyFilters(asRows(props.rows), props.filters as Filter[] | undefined);
    const sorted = active
      ? [...filtered].sort((a, b) => {
          const result = compare(a[active.field], b[active.field]);
          return active.order === 'desc' ? -result : result;
        })
      : filtered;
    return sorted.slice(0, limit);
  }, [props.rows, props.filters, active?.field, active?.order, limit]);

  const total = applyFilters(asRows(props.rows), props.filters as Filter[] | undefined).length;

  if (rows.length === 0) {
    return <p className="table__empty">{props.emptyText ?? 'No rows match the current filters.'}</p>;
  }

  const toggleSort = (field: string) =>
    setSort(current =>
      current?.field === field
        ? { field, order: current.order === 'asc' ? 'desc' : 'asc' }
        : { field, order: 'desc' },
    );

  return (
    <div className="table__scroll">
      <table className={`table${props.dense ? ' table--dense' : ''}`}>
        <thead>
          <tr>
            {columns.map(column => (
              <th
                key={column.field}
                style={{ width: column.width, textAlign: column.align ?? 'left' }}
                aria-sort={
                  active?.field === column.field ? (active.order === 'asc' ? 'ascending' : 'descending') : 'none'
                }
              >
                <button type="button" className="table__sort" onClick={() => toggleSort(column.field)}>
                  {column.label ?? column.field}
                  {active?.field === column.field ? <span aria-hidden="true">{active.order === 'asc' ? ' ↑' : ' ↓'}</span> : null}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={String(row.order_id ?? row.id ?? index)}
              className={props.onRowSelect ? 'table__row--interactive' : undefined}
              onClick={props.onRowSelect ? () => (props.onRowSelect as (ctx?: unknown) => void)(row) : undefined}
            >
              {columns.map(column => (
                <td key={column.field} style={{ textAlign: column.align ?? 'left' }}>
                  {formatValue(row[column.field], column.format)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {total > rows.length ? (
        <p className="table__more">
          Showing {rows.length.toLocaleString()} of {total.toLocaleString()} rows
        </p>
      ) : null}
    </div>
  );
});
