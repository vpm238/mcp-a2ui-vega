/**
 * Catalog functions — the small amount of computation a dashboard needs so the
 * agent does not have to precompute numbers and re-send them.
 *
 * `{"call": "aggregate", "args": {...}}` in a component property is evaluated by
 * the renderer against the live data model, which means an appended row moves
 * every KPI tile on the surface without a single message from the agent.
 */
import { z } from 'zod';
import { createFunctionImplementation, CommonSchemas, getValue } from '@a2ui/web_core/v0_9';
import type { DataContext } from '@a2ui/web_core/v0_9';
import { FiltersSchema, RowsSchema, type Filter } from './components.js';

export type Row = Record<string, unknown>;

const asRows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

/**
 * Function arguments arrive exactly as the agent wrote them — a binding is
 * still `{path: "/datasets/…"}` here, not the array it points at. Component
 * properties are resolved for us by the binder; function arguments are not,
 * because a function may want the binding itself.
 *
 * Resolving through a *signal* rather than a plain read is what makes the call
 * reactive. A2UI subscribes the function to the bindings it can see at the top
 * level of `args`, but not to ones nested inside an array — and a filter clause
 * is exactly that. Without this, picking a show would re-filter every table on
 * the surface and leave every metric showing the old number, until something
 * else happened to invalidate it.
 */
const resolve = <T>(value: unknown, context: DataContext): T | undefined =>
  value === undefined || value === null ? undefined : (getValue(context.resolveSignal<T>(value as never)) as T);

const resolveRows = (value: unknown, context: DataContext): Row[] => asRows(resolve<Row[]>(value, context));

/** Resolve each clause's comparison value; the field and operator are literals. */
const resolveFilters = (where: unknown, context: DataContext): Filter[] => {
  if (!Array.isArray(where)) return [];
  return (where as Filter[]).map(clause => ({ ...clause, value: resolve(clause.value, context) as Filter['value'] }));
};

const asNumber = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
};

/** An unset filter value means "no constraint" — that is what an "All" option sends. */
const isUnset = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/** Test one row against one clause. */
function matches(row: Row, clause: Filter): boolean {
  const { field, op } = clause;
  const value = clause.value as unknown;
  if (isUnset(value)) return true;

  const actual = row[field];
  const list = Array.isArray(value) ? value : [value];

  switch (op) {
    case 'eq':
      return String(actual) === String(value);
    case 'neq':
      return String(actual) !== String(value);
    case 'in':
      return list.some(v => String(v) === String(actual));
    case 'notIn':
      return !list.some(v => String(v) === String(actual));
    case 'gt':
      return asNumber(actual) > asNumber(value);
    case 'gte':
      return asNumber(actual) >= asNumber(value);
    case 'lt':
      return asNumber(actual) < asNumber(value);
    case 'lte':
      return asNumber(actual) <= asNumber(value);
    case 'contains':
      return String(actual).toLowerCase().includes(String(value).toLowerCase());
    case 'startsWith':
      return String(actual).startsWith(String(value));
    case 'between': {
      // Strings compare lexicographically, which is what ISO dates want.
      const [lo, hi] = list as [unknown, unknown];
      if (typeof actual === 'string' && typeof lo === 'string') return actual >= lo && actual <= String(hi);
      const n = asNumber(actual);
      return n >= asNumber(lo) && n <= asNumber(hi);
    }
    default:
      return true;
  }
}

/** Apply every clause. Exported because the chart and table components use it too. */
export function applyFilters(rows: Row[], filters?: Filter[] | null): Row[] {
  if (!filters || filters.length === 0) return rows;
  return rows.filter(row => filters.every(clause => matches(row, clause)));
}

type AggregateOp = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'countDistinct';

export function aggregateRows(rows: Row[], op: AggregateOp, field?: string): number {
  if (op === 'count') return rows.length;
  if (!field) return rows.length;
  if (op === 'countDistinct') return new Set(rows.map(r => String(r[field]))).size;

  const values = rows.map(r => asNumber(r[field])).filter(n => Number.isFinite(n));
  if (values.length === 0) return 0;
  switch (op) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

/** Locale-aware display formatting, shared by KpiTile, DataTable and the format functions. */
export function formatValue(
  value: unknown,
  format?: string,
  options: { currency?: string; maximumFractionDigits?: number; locale?: string } = {},
): string {
  const { currency = 'USD', locale = 'en-US' } = options;
  if (value === null || value === undefined || value === '') return '—';

  switch (format) {
    case 'currency': {
      const n = asNumber(value);
      if (!Number.isFinite(n)) return String(value);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        maximumFractionDigits: options.maximumFractionDigits ?? (Math.abs(n) >= 1000 ? 0 : 2),
      }).format(n);
    }
    case 'number': {
      const n = asNumber(value);
      if (!Number.isFinite(n)) return String(value);
      return new Intl.NumberFormat(locale, {
        maximumFractionDigits: options.maximumFractionDigits ?? 0,
      }).format(n);
    }
    case 'compact': {
      const n = asNumber(value);
      if (!Number.isFinite(n)) return String(value);
      return new Intl.NumberFormat(locale, {
        notation: 'compact',
        maximumFractionDigits: options.maximumFractionDigits ?? 1,
      }).format(n);
    }
    case 'percent': {
      const n = asNumber(value);
      if (!Number.isFinite(n)) return String(value);
      return new Intl.NumberFormat(locale, {
        style: 'percent',
        maximumFractionDigits: options.maximumFractionDigits ?? 1,
      }).format(n);
    }
    case 'date':
    case 'datetime': {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) return String(value);
      return new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        ...(format === 'datetime' ? { timeStyle: 'short' } : {}),
      }).format(date);
    }
    default:
      return String(value);
  }
}

const rowsArg = z.object({ rows: RowsSchema, where: FiltersSchema.optional() });

export const aggregate = createFunctionImplementation(
  {
    name: 'aggregate',
    returnType: 'number',
    schema: rowsArg.extend({
      op: z.enum(['sum', 'avg', 'count', 'min', 'max', 'countDistinct']),
      field: z.string().optional(),
    }),
  },
  (args, context) =>
    aggregateRows(applyFilters(resolveRows(args.rows, context), resolveFilters(args.where, context)), args.op, args.field),
);

export const filterRows = createFunctionImplementation(
  { name: 'filterRows', returnType: 'array', schema: rowsArg },
  (args, context) => applyFilters(resolveRows(args.rows, context), resolveFilters(args.where, context)),
);

export const countRows = createFunctionImplementation(
  { name: 'countRows', returnType: 'number', schema: rowsArg },
  (args, context) => applyFilters(resolveRows(args.rows, context), resolveFilters(args.where, context)).length,
);

/**
 * Group rows and aggregate each group — the shape a bar chart or a leaderboard
 * wants. Returns `[{key, value}]` sorted by value.
 */
export const groupRows = createFunctionImplementation(
  {
    name: 'groupRows',
    returnType: 'array',
    schema: rowsArg.extend({
      groupBy: z.string(),
      field: z.string().optional(),
      op: z.enum(['sum', 'avg', 'count', 'min', 'max', 'countDistinct']).optional(),
      limit: z.number().optional(),
      order: z.enum(['asc', 'desc']).optional(),
    }),
  },
  (args, context) => {
    const rows = applyFilters(resolveRows(args.rows, context), resolveFilters(args.where, context));
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = String(row[args.groupBy] ?? '');
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    const out = [...groups.entries()].map(([key, bucket]) => ({
      key,
      value: aggregateRows(bucket, args.op ?? 'sum', args.field),
    }));
    out.sort((a, b) => (args.order === 'asc' ? a.value - b.value : b.value - a.value));
    return args.limit ? out.slice(0, args.limit) : out;
  },
);

/** The distinct values of a field — how a picker gets its options from the data. */
export const distinctValues = createFunctionImplementation(
  {
    name: 'distinctValues',
    returnType: 'array',
    schema: rowsArg.extend({
      field: z.string(),
      limit: z.number().optional(),
      includeAll: z.boolean().optional().describe('Prepend an empty option that clears the filter.'),
    }),
  },
  (args, context) => {
    const rows = applyFilters(resolveRows(args.rows, context), resolveFilters(args.where, context));
    const values = [...new Set(rows.map(r => String(r[args.field] ?? '')).filter(Boolean))].sort();
    const limited = args.limit ? values.slice(0, args.limit) : values;
    return args.includeAll ? ['', ...limited] : limited;
  },
);

/** `(current - previous) / previous`, the ratio a KpiTile delta expects. */
export const changeRatio = createFunctionImplementation(
  {
    name: 'changeRatio',
    returnType: 'number',
    schema: z.object({ current: CommonSchemas.DynamicNumber, previous: CommonSchemas.DynamicNumber }),
  },
  (args, context) => {
    const previous = asNumber(resolve(args.previous, context));
    const current = asNumber(resolve(args.current, context));
    if (!Number.isFinite(previous) || previous === 0) return 0;
    return (current - previous) / previous;
  },
);

/*
 * Formatting functions are deliberately absent: A2UI's basic catalog already
 * ships `formatString`, `formatNumber`, `formatCurrency` and `formatDate`, and
 * two catalogs claiming the same function name is an ambiguity nobody needs.
 * Components here take a `format` property instead, handled by `formatValue`.
 */

/**
 * Today's date as `YYYY-MM-DD`. Pair it with a `startsWith` filter to get "today"
 * without the agent hardcoding a date that goes stale overnight.
 */
export const today = createFunctionImplementation(
  {
    name: 'today',
    returnType: 'string',
    schema: z.object({
      timeZone: z.string().optional().describe('IANA zone. Defaults to America/New_York, the dataset\'s zone.'),
      offsetDays: z.number().optional().describe('Negative for past days: -1 is yesterday.'),
    }),
  },
  args => {
    const date = new Date();
    if (args.offsetDays) date.setDate(date.getDate() + args.offsetDays);
    // `en-CA` renders as YYYY-MM-DD, which is what the dataset stores.
    return new Intl.DateTimeFormat('en-CA', { timeZone: args.timeZone ?? 'America/New_York' }).format(date);
  },
);

export const catalogFunctions = [
  aggregate,
  filterRows,
  countRows,
  groupRows,
  distinctValues,
  changeRatio,
  today,
];
