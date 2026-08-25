/**
 * The one place the view talks to the outside world.
 *
 * Components never call tools themselves. They ask the gateway, which owns the
 * MCP connection, the A2UI message processor and the rule that keeps the two in
 * step: anything that changes data on the server is followed by an
 * `updateDataModel` into the surface, so the charts move for the same reason
 * they would move if the agent had sent the message itself.
 */
import type { MessageProcessor } from '@a2ui/web_core/v0_9';
import { A2UI_VERSION, TOOLS, coerceRows, datasetPath, inferColumnTypes } from '@mcp-a2ui-vega/catalog';

/** Calls a tool on the MCP server and returns its result. */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolResult {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/**
 * Where the A2UI payload rides.
 *
 * `_meta` reaches the view but not the model, which is the point: a dashboard
 * is ten kilobytes of component JSON that the agent wrote and does not need
 * read back to it.
 */
export const A2UI_META = 'a2ui/messages';
export const DATASETS_META = 'a2ui/datasets';

export interface DatasetState {
  rowCount: number;
  updatedAt: string;
  columns: string[];
  loading: boolean;
  error?: string;
  /** When this view last pulled rows. */
  refreshedAt?: number;
}

/** Rows on the wire: either plain objects, or columnar for a smaller payload. */
interface RowsPayload {
  columns?: string[];
  rows?: Array<Record<string, unknown>> | unknown[][];
  rowCount?: number;
  updatedAt?: string;
  format?: 'rows' | 'columnar';
}

/** Read a tool result that may report structured data or a JSON text block. */
export function readResult(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find(block => block.type === 'text')?.text;
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

/** Expand a columnar payload back into row objects. */
export function expandRows(payload: RowsPayload): Array<Record<string, unknown>> {
  const rows = payload.rows ?? [];
  if (rows.length === 0) return [];
  if (!Array.isArray(rows[0])) return rows as Array<Record<string, unknown>>;

  const columns = payload.columns ?? [];
  return (rows as unknown[][]).map(values => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) row[columns[i]!] = values[i];
    return row;
  });
}

type Listener = () => void;

/**
 * How often a dataset is re-read once something has bound to it.
 *
 * Polling lives here rather than in a component because a dashboard should be
 * live whether or not whoever composed it remembered to include a status
 * badge. `DatasetStatus` tunes this; it does not own it.
 */
const DEFAULT_POLL_SECONDS = 15;

export class Gateway {
  private readonly datasets = new Map<string, DatasetState>();
  private readonly listeners = new Set<Listener>();
  private inFlight = new Map<string, Promise<void>>();
  private readonly polls = new Map<string, { seconds: number; timer: ReturnType<typeof setInterval> }>();

  constructor(
    private readonly processor: MessageProcessor<never>,
    private readonly callTool: CallTool,
    /** Forwards an A2UI action to the agent. */
    readonly forwardAction: (name: string, context: Record<string, unknown>) => void = () => {},
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }

  /**
   * Re-read a dataset on a timer. Called automatically the first time a dataset
   * loads; `DatasetStatus` calls it again with the interval the agent asked
   * for. Zero stops it.
   */
  setPollInterval(id: string, seconds: number = DEFAULT_POLL_SECONDS) {
    const existing = this.polls.get(id);
    if (existing?.seconds === seconds) return;
    if (existing) clearInterval(existing.timer);
    this.polls.delete(id);
    if (!(seconds > 0)) return;

    const timer = setInterval(() => {
      // A hidden panel does not need fresh numbers, and a tab left open
      // overnight should not keep asking for them.
      if (typeof document !== 'undefined' && document.hidden) return;
      void this.loadDataset(id, { force: true });
    }, seconds * 1000);
    this.polls.set(id, { seconds, timer });
  }

  /** Stop every poll — used when the view is torn down. */
  dispose() {
    for (const { timer } of this.polls.values()) clearInterval(timer);
    this.polls.clear();
    this.listeners.clear();
  }

  datasetState(id: string): DatasetState {
    return this.datasets.get(id) ?? { rowCount: 0, updatedAt: '', columns: [], loading: false };
  }

  /** Write into every live surface's data model — dashboards here are single-surface. */
  writeDataModel(path: string, value: unknown) {
    for (const surface of this.processor.model.surfacesMap.values()) {
      this.processor.processMessages([
        { version: A2UI_VERSION, updateDataModel: { surfaceId: surface.id, path, value } },
      ] as never);
    }
  }

  /**
   * Pull a dataset's rows and publish them to the surface.
   *
   * Concurrent calls for the same dataset share one request: a poll landing on
   * top of a manual refresh should not double the work.
   */
  async loadDataset(id: string, options: { force?: boolean } = {}): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing && !options.force) return existing;

    const request = (async () => {
      const previous = this.datasetState(id);
      this.datasets.set(id, { ...previous, loading: true, error: undefined });
      this.emit();

      try {
        const payload = readResult(
          await this.callTool(TOOLS.getDatasetRows, { datasetId: id, format: 'columnar' }),
        ) as RowsPayload;
        // CSV rows arrive as text. Type them here, once, rather than leaving
        // every chart and aggregate to coerce for itself.
        const raw = expandRows(payload);
        const rows = coerceRows(raw, inferColumnTypes(raw, payload.columns));

        this.datasets.set(id, {
          rowCount: payload.rowCount ?? rows.length,
          updatedAt: payload.updatedAt ?? '',
          columns: payload.columns ?? Object.keys(rows[0] ?? {}),
          loading: false,
          refreshedAt: Date.now(),
        });

        this.writeDataModel(datasetPath(id), {
          rows,
          rowCount: payload.rowCount ?? rows.length,
          updatedAt: payload.updatedAt ?? '',
          columns: payload.columns ?? Object.keys(rows[0] ?? {}),
        });

        // Anything bound to this dataset is now live, without the dashboard
        // having had to ask for it.
        if (!this.polls.has(id)) this.setPollInterval(id);
      } catch (error) {
        this.datasets.set(id, {
          ...this.datasetState(id),
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.inFlight.delete(id);
        this.emit();
      }
    })();

    this.inFlight.set(id, request);
    return request;
  }

  /** Append rows, then reload so every bound component sees them. */
  async appendRows(id: string, rows: Array<Record<string, unknown>>): Promise<{ rowsAdded: number; totalRows: number }> {
    const result = readResult(await this.callTool(TOOLS.appendRows, { datasetId: id, rows }));
    await this.loadDataset(id, { force: true });
    return {
      rowsAdded: Number(result.rowsAdded ?? rows.length),
      totalRows: Number(result.rowCount ?? this.datasetState(id).rowCount),
    };
  }

  /** Upload CSV text as an append or a full replacement. */
  async uploadCsv(
    id: string,
    csv: string,
    mode: 'append' | 'replace',
  ): Promise<{ rowsAdded: number; totalRows: number }> {
    const result = readResult(await this.callTool(TOOLS.uploadCsv, { datasetId: id, csv, mode }));
    await this.loadDataset(id, { force: true });
    return {
      rowsAdded: Number(result.rowsAdded ?? 0),
      totalRows: Number(result.rowCount ?? this.datasetState(id).rowCount),
    };
  }
}
