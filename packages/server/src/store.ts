/**
 * Storage.
 *
 * Datasets are kept as CSV text, not as JSON rows. That is the format they
 * arrive in, the format the upload tool receives, the format a user gets back
 * when they export, and appending to it is a string concatenation rather than a
 * parse-mutate-serialize round trip. Rows are parsed only when someone asks for
 * rows.
 *
 * Saved widgets are small JSON blobs under their own key prefix.
 */
import type { Env } from './env.ts';
import {
  coerceRows,
  inferColumnTypes,
  nowInZone,
  parseCsv,
  toCsv,
  toCsvBody,
  type ColumnType,
  type SavedWidget,
} from '@mcp-a2ui-vega/catalog';
import seedCsv from './generated/ticket_sales.csv';

const DATASET_KEY = (id: string) => `dataset:${id}`;
const META_KEY = (id: string) => `dataset-meta:${id}`;
const WIDGET_KEY = (name: string) => `widget:${name}`;

export interface DatasetMeta {
  id: string;
  title: string;
  description?: string;
  source?: string;
  columns: string[];
  rowCount: number;
  updatedAt: string;
}

export interface DatasetProfile extends DatasetMeta {
  types: Record<string, ColumnType>;
  columnDetail: Array<{
    name: string;
    type: ColumnType;
    distinctCount: number;
    examples: string[];
    min?: string | number;
    max?: string | number;
  }>;
  sampleCsv: string;
}

/** The dataset the server ships with, so a fresh deployment has something to show. */
const SEED = {
  id: 'ticket_sales',
  title: 'Ticket sales',
  description:
    'Ticket orders for twelve Broadway shows, one row per order. Shows, theatres, house sizes and price levels come from the real Playbill weekly grosses; the individual orders are modelled from them. Times are America/New_York.',
  source: 'https://github.com/rfordatascience/tidytuesday/tree/master/data/2020/2020-04-28',
};

export class Store {
  constructor(private readonly env: Env) {}

  private get kv() {
    return this.env.DATA;
  }

  /** Write the bundled dataset on first use so a new deployment is not empty. */
  private async ensureSeeded(id: string): Promise<void> {
    if (id !== SEED.id) return;
    if (await this.kv.get(META_KEY(id))) return;
    await this.replaceDataset(id, seedCsv, { title: SEED.title, description: SEED.description, source: SEED.source });
  }

  async getCsv(id: string): Promise<string | null> {
    await this.ensureSeeded(id);
    return this.kv.get(DATASET_KEY(id));
  }

  async getMeta(id: string): Promise<DatasetMeta | null> {
    await this.ensureSeeded(id);
    const raw = await this.kv.get(META_KEY(id));
    return raw ? (JSON.parse(raw) as DatasetMeta) : null;
  }

  async listDatasets(): Promise<DatasetMeta[]> {
    await this.ensureSeeded(SEED.id);
    const listed = await this.kv.list({ prefix: 'dataset-meta:' });
    const metas = await Promise.all(listed.keys.map(key => this.kv.get(key.name)));
    return metas.filter((raw): raw is string => Boolean(raw)).map(raw => JSON.parse(raw) as DatasetMeta);
  }

  /** Rows, typed: numeric columns come back as numbers, times stay ISO strings. */
  async getRows(id: string, limit?: number): Promise<{ rows: Array<Record<string, unknown>>; meta: DatasetMeta }> {
    const csv = await this.getCsv(id);
    const meta = await this.getMeta(id);
    if (csv === null || !meta) throw new Error(`no dataset named "${id}"`);

    const parsed = parseCsv(csv);
    const rows = limit && limit > 0 ? parsed.slice(-limit) : parsed;
    return { rows: coerceRows(rows, inferColumnTypes(parsed, meta.columns)), meta };
  }

  /** Column types, ranges and distinct values — what an agent needs to encode a chart. */
  async profile(id: string, sampleSize = 400): Promise<DatasetProfile> {
    const csv = await this.getCsv(id);
    const meta = await this.getMeta(id);
    if (csv === null || !meta) throw new Error(`no dataset named "${id}"`);

    const rows = parseCsv(csv);
    const types = inferColumnTypes(rows, meta.columns);
    const sample = rows.length > sampleSize ? rows.slice(-sampleSize) : rows;

    const columnDetail = meta.columns.map(name => {
      const values = rows.map(row => row[name] ?? '').filter(value => value !== '');
      const distinct = new Set(values);
      const type = types[name] ?? 'nominal';
      const detail: DatasetProfile['columnDetail'][number] = {
        name,
        type,
        distinctCount: distinct.size,
        // For a low-cardinality column the whole domain is the useful thing to
        // know; for a high-cardinality one, a few examples.
        examples: [...distinct].slice(0, distinct.size <= 25 ? 25 : 4).sort(),
      };
      if (type === 'quantitative') {
        const numbers = values.map(Number).filter(Number.isFinite);
        if (numbers.length) {
          detail.min = Math.min(...numbers);
          detail.max = Math.max(...numbers);
        }
      } else if (type === 'temporal' && values.length) {
        const sorted = [...values].sort();
        detail.min = sorted[0];
        detail.max = sorted[sorted.length - 1];
      }
      return detail;
    });

    return {
      ...meta,
      types,
      columnDetail,
      sampleCsv: toCsv(sample.slice(-5), meta.columns),
    };
  }

  /** Replace a dataset wholesale. Used by upload (replace mode) and by reset. */
  async replaceDataset(
    id: string,
    csv: string,
    options: { title?: string; description?: string; source?: string } = {},
  ): Promise<DatasetMeta> {
    const rows = parseCsv(csv);
    const columns = Object.keys(rows[0] ?? {});
    if (columns.length === 0) throw new Error('that CSV has no header row');

    const previous = await this.kv.get(META_KEY(id));
    const existing = previous ? (JSON.parse(previous) as DatasetMeta) : null;
    const meta: DatasetMeta = {
      id,
      title: options.title ?? existing?.title ?? id,
      description: options.description ?? existing?.description,
      source: options.source ?? existing?.source,
      columns,
      rowCount: rows.length,
      updatedAt: new Date().toISOString(),
    };

    await this.kv.put(DATASET_KEY(id), csv);
    await this.kv.put(META_KEY(id), JSON.stringify(meta));
    return meta;
  }

  /**
   * Append rows, filling in what the caller left out.
   *
   * A row from the dashboard's little form carries a show, a section and a
   * price — not an order id, not a timestamp, not a gross. Rejecting it for
   * that would be pedantic, so the missing pieces are derived here, in the
   * dataset's own timezone.
   */
  async appendRows(id: string, incoming: Array<Record<string, unknown>>): Promise<DatasetMeta> {
    const csv = await this.getCsv(id);
    const meta = await this.getMeta(id);
    if (csv === null || !meta) throw new Error(`no dataset named "${id}"`);
    if (incoming.length === 0) return meta;

    const filled = incoming.map((row, index) => this.fillRow(row, meta, index));
    const body = toCsvBody(filled, meta.columns);
    const next = csv.endsWith('\n') ? csv + body : `${csv}\n${body}`;

    const updated: DatasetMeta = {
      ...meta,
      rowCount: meta.rowCount + filled.length,
      updatedAt: new Date().toISOString(),
    };
    await this.kv.put(DATASET_KEY(id), next);
    await this.kv.put(META_KEY(id), JSON.stringify(updated));
    return updated;
  }

  /** Defaults for the columns an order-shaped dataset expects. */
  private fillRow(row: Record<string, unknown>, meta: DatasetMeta, index: number): Record<string, unknown> {
    const filled: Record<string, unknown> = { ...row };
    const has = (column: string) => meta.columns.includes(column);

    if (has('order_id') && !filled.order_id) {
      filled.order_id = `ORD-${String(meta.rowCount + index + 1).padStart(7, '0')}`;
    }
    if (has('ordered_at') && !filled.ordered_at) filled.ordered_at = nowInZone();
    if (has('status') && !filled.status) filled.status = 'paid';
    if (has('quantity') && !filled.quantity) filled.quantity = 1;
    if (has('gross') && !filled.gross && filled.unit_price !== undefined) {
      filled.gross = (Number(filled.unit_price) * Number(filled.quantity ?? 1)).toFixed(2);
    }
    if (has('event_date') && !filled.event_date && typeof filled.ordered_at === 'string') {
      filled.event_date = filled.ordered_at.slice(0, 10);
    }

    // Anything still missing becomes an empty cell rather than a shifted row.
    for (const column of meta.columns) if (filled[column] === undefined) filled[column] = '';
    return filled;
  }

  /** Restore the dataset that shipped with the server. */
  async resetDataset(id: string): Promise<DatasetMeta> {
    if (id !== SEED.id) throw new Error(`only "${SEED.id}" has a seed to reset to`);
    return this.replaceDataset(id, seedCsv, {
      title: SEED.title,
      description: SEED.description,
      source: SEED.source,
    });
  }

  // -- Saved widgets ------------------------------------------------------

  async saveWidget(widget: Omit<SavedWidget, 'createdAt' | 'updatedAt'>): Promise<SavedWidget> {
    const existing = await this.getWidget(widget.name);
    const now = new Date().toISOString();
    const saved: SavedWidget = {
      ...widget,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.kv.put(WIDGET_KEY(widget.name), JSON.stringify(saved));
    return saved;
  }

  async getWidget(name: string): Promise<SavedWidget | null> {
    const raw = await this.kv.get(WIDGET_KEY(name));
    return raw ? (JSON.parse(raw) as SavedWidget) : null;
  }

  async listWidgets(): Promise<SavedWidget[]> {
    const listed = await this.kv.list({ prefix: 'widget:' });
    const values = await Promise.all(listed.keys.map(key => this.kv.get(key.name)));
    return values
      .filter((raw): raw is string => Boolean(raw))
      .map(raw => JSON.parse(raw) as SavedWidget)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteWidget(name: string): Promise<boolean> {
    if (!(await this.getWidget(name))) return false;
    await this.kv.delete(WIDGET_KEY(name));
    return true;
  }
}

/** Distinct values for a column, used to fill the dashboard's filter pickers. */
export function distinctValues(rows: Array<Record<string, unknown>>, field: string, limit = 40): string[] {
  const values = new Set<string>();
  for (const row of rows) {
    const value = row[field];
    if (value !== undefined && value !== null && value !== '') values.add(String(value));
    if (values.size > limit) break;
  }
  return [...values].sort();
}
