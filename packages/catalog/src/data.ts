/**
 * Typing rows that arrive from a CSV.
 *
 * Everything in a CSV is a string, and a chart that sums `"1460.00"` produces
 * an empty axis rather than an error — the worst kind of bug, because the
 * dashboard looks fine and is simply wrong. Rows are typed once, on the way in,
 * so nothing downstream has to remember to coerce.
 *
 * Times deliberately stay strings. They are ISO-8601, which sorts and
 * prefix-matches correctly as text, and that is what filters like "orders whose
 * `ordered_at` starts with today's date" rely on. Charts get their parsing from
 * the Vega-Lite spec instead.
 */
export type ColumnType = 'quantitative' | 'temporal' | 'nominal';

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/;

/** True when every non-empty sample parses as a finite number. */
function looksNumeric(values: string[]): boolean {
  let seen = 0;
  for (const value of values) {
    if (value === '') continue;
    // `Number('')` is 0 and `Number('19:00')` is NaN — both are handled, but
    // leading zeros in identifiers ("00123") would be lost, so require that the
    // text round-trips as a number.
    const n = Number(value);
    if (!Number.isFinite(n)) return false;
    if (String(n) !== value.trim() && String(Number(value.trim())) !== value.trim()) {
      if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return false;
    }
    seen++;
  }
  return seen > 0;
}

function looksTemporal(values: string[]): boolean {
  const nonEmpty = values.filter(value => value !== '');
  return nonEmpty.length > 0 && nonEmpty.every(value => ISO_LIKE.test(value));
}

/** Infer a type per column from a sample of the rows. */
export function inferColumnTypes(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
  sampleSize = 200,
): Record<string, ColumnType> {
  const names = columns ?? Object.keys(rows[0] ?? {});
  const sample = rows.slice(0, sampleSize);
  const types: Record<string, ColumnType> = {};

  for (const name of names) {
    const values = sample.map(row => (row[name] == null ? '' : String(row[name])));
    types[name] = looksTemporal(values) ? 'temporal' : looksNumeric(values) ? 'quantitative' : 'nominal';
  }
  return types;
}

/** Convert the quantitative columns to real numbers, leaving everything else alone. */
export function coerceRows(
  rows: Array<Record<string, unknown>>,
  types: Record<string, ColumnType>,
): Array<Record<string, unknown>> {
  const numeric = Object.entries(types)
    .filter(([, type]) => type === 'quantitative')
    .map(([name]) => name);
  if (numeric.length === 0) return rows;

  return rows.map(row => {
    const typed: Record<string, unknown> = { ...row };
    for (const name of numeric) {
      const value = row[name];
      if (typeof value === 'string' && value !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) typed[name] = n;
      }
    }
    return typed;
  });
}

/**
 * The dataset's own clock.
 *
 * Rows are New York wall-clock time with no zone suffix, so anything that
 * stamps a new row has to use the same clock — a server in UTC writing
 * `2026-08-26T04:52` for an order placed at 00:52 in New York puts it in
 * tomorrow, and "sold today" quietly stops counting it.
 */
export const DATASET_TIME_ZONE = 'America/New_York';

/** `YYYY-MM-DD` in the given zone. */
export function todayInZone(timeZone: string = DATASET_TIME_ZONE, at: Date = new Date()): string {
  // `en-CA` formats as YYYY-MM-DD, which is the format the dataset stores.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

/** `YYYY-MM-DDTHH:mm:ss` in the given zone, matching `ordered_at`. */
export function nowInZone(timeZone: string = DATASET_TIME_ZONE, at: Date = new Date()): string {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(at);
  return `${todayInZone(timeZone, at)}T${time}`;
}
