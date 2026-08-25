/**
 * The one place the view talks to the outside world.
 *
 * Components never call tools themselves. They ask the gateway, which owns the
 * MCP connection, the change stream, the A2UI message processor, and the rule
 * that keeps them in step: anything that changes data on the server is followed
 * by an `updateDataModel` into the surface, so the charts move for the same
 * reason they would move if the agent had sent the message itself.
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
export const DISPLAY_META = 'a2ui/display';
/**
 * The incremental form of an update.
 *
 * `a2ui/messages` renders from nothing; this renders a change onto a surface
 * that is already here. Which of the two a view uses depends on what that view
 * already holds — not on what the server guessed it would hold.
 */
export const A2UI_PATCH_META = 'a2ui/patch';

export interface DatasetState {
  rowCount: number;
  updatedAt: string;
  columns: string[];
  loading: boolean;
  error?: string;
  /** When this view last pulled rows. */
  refreshedAt?: number;
  /** True while the server is pushing change notifications to this view. */
  live?: boolean;
}

/** Rows on the wire: either plain objects, or columnar for a smaller payload. */
interface RowsPayload {
  columns?: string[];
  rows?: Array<Record<string, unknown>> | unknown[][];
  rowCount?: number;
  updatedAt?: string;
  format?: 'rows' | 'columnar';
  /** The server's answer when nothing has changed since `since`. */
  unchanged?: boolean;
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
 * How often a dataset is re-read when nothing is telling us it changed.
 *
 * This is the fallback, not the plan. When the change stream is connected the
 * server says when to look, and this drops to a slow heartbeat that exists only
 * to catch a notification lost to a dropped connection.
 */
const DEFAULT_POLL_SECONDS = 15;
const SUBSCRIBED_POLL_SECONDS = 120;

/**
 * Which server this bundle belongs to.
 *
 * A bundle served by the Worker has the Worker's origin written into it on the
 * way out, so it knows where it came from without being told. `?server=` still
 * wins, for pointing a copy of the page at a different deployment. A bundle
 * served from anywhere else — GitHub Pages, a file:// path — still holds the
 * placeholder, and gets null: there is no server, and the caller falls back to
 * the demo data.
 */
export function serverOrigin(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get('server');
  if (fromQuery) return fromQuery.replace(/\/$/, '');
  const injected = (window as { __MCP_SERVER_ORIGIN__?: string }).__MCP_SERVER_ORIGIN__;
  return injected && !injected.startsWith('@@') ? injected.replace(/\/$/, '') : null;
}

export class Gateway {
  private readonly datasets = new Map<string, DatasetState>();
  private readonly listeners = new Set<Listener>();
  private inFlight = new Map<string, Promise<void>>();
  private readonly polls = new Map<string, { seconds: number; timer: ReturnType<typeof setInterval> }>();
  /**
   * The last rows published for each dataset.
   *
   * Needed because "unchanged" is relative to what *this gateway* last fetched,
   * not to what the surface currently holds — and a re-render replaces the
   * surface with an empty data model. Without the cache, rendering a dashboard
   * twice in a row leaves the second one with no data.
   */
  private readonly rowsCache = new Map<string, Array<Record<string, unknown>>>();
  private readonly streams = new Map<string, EventSource>();
  /** True while the server is telling us when to look. */
  private subscribed = false;

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
   * Re-read a dataset on a timer — the fallback for when the change stream is
   * not available, and a slow heartbeat when it is. Called automatically the
   * first time a dataset loads; `DatasetStatus` calls it again with the interval
   * the agent asked for. Zero stops it.
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

  /**
   * Listen for change notifications instead of asking for them.
   *
   * The server cannot reach a view through MCP — it answers the host, and the
   * host talks to the view — so the view opens this connection itself, to the
   * origin declared in the app resource's `csp.connectDomains`. What arrives is
   * a notification, not data: the rows are still fetched through the host's
   * tool proxy, so nothing about the data path stops being auditable.
   */
  watchDataset(id: string): void {
    if (this.streams.has(id) || typeof EventSource === 'undefined') return;
    const origin = serverOrigin();
    if (!origin) return; // No stream available: the poll fallback covers it.

    let stream: EventSource;
    try {
      stream = new EventSource(`${origin}/events?dataset=${encodeURIComponent(id)}`);
    } catch {
      return;
    }
    this.streams.set(id, stream);

    stream.addEventListener('ready', () => {
      this.subscribed = true;
      // Keep a slow heartbeat rather than trusting the stream completely.
      this.setPollInterval(id, SUBSCRIBED_POLL_SECONDS);
      this.emit();
    });

    stream.addEventListener('dataset-changed', event => {
      const change = JSON.parse((event as MessageEvent<string>).data) as { updatedAt?: string };
      // Ignore an echo of what we already have.
      if (change.updatedAt && change.updatedAt === this.datasetState(id).updatedAt) return;
      void this.loadDataset(id, { force: true });
    });

    stream.onerror = () => {
      // EventSource reconnects on its own; until it does, poll at the normal
      // pace so the dashboard does not silently freeze.
      this.subscribed = false;
      this.setPollInterval(id, DEFAULT_POLL_SECONDS);
      this.emit();
    };
  }

  /** Whether change notifications are arriving, for the status badge to show. */
  isSubscribed(): boolean {
    return this.subscribed;
  }

  /** Stop every poll and close every stream — used when the view is torn down. */
  dispose() {
    for (const { timer } of this.polls.values()) clearInterval(timer);
    for (const stream of this.streams.values()) stream.close();
    this.polls.clear();
    this.streams.clear();
    this.listeners.clear();
    this.rowsCache.clear();
  }

  datasetState(id: string): DatasetState {
    const state = this.datasets.get(id) ?? { rowCount: 0, updatedAt: '', columns: [], loading: false };
    return { ...state, live: this.subscribed };
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
  async loadDataset(id: string, options: { force?: boolean; publish?: boolean } = {}): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing && !options.force) return existing;

    const request = (async () => {
      const previous = this.datasetState(id);
      this.datasets.set(id, { ...previous, loading: true, error: undefined });
      this.emit();

      try {
        // Tell the server what we already have. A poll that finds nothing new
        // comes back as a few bytes instead of the whole dataset.
        const payload = readResult(
          await this.callTool(TOOLS.getDatasetRows, {
            datasetId: id,
            format: 'columnar',
            ...(previous.updatedAt ? { since: previous.updatedAt } : {}),
          }),
        ) as RowsPayload;

        if (payload.unchanged) {
          this.datasets.set(id, { ...previous, loading: false, refreshedAt: Date.now() });
          // A fresh surface needs the rows even though the server has nothing
          // new to say. Publishing from cache costs nothing over the wire.
          const cached = this.rowsCache.get(id);
          if (options.publish && cached) {
            this.writeDataModel(datasetPath(id), {
              rows: cached,
              rowCount: previous.rowCount,
              updatedAt: previous.updatedAt,
              columns: previous.columns,
            });
          }
          return;
        }

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

        this.rowsCache.set(id, rows);
        this.writeDataModel(datasetPath(id), {
          rows,
          rowCount: payload.rowCount ?? rows.length,
          updatedAt: payload.updatedAt ?? '',
          columns: payload.columns ?? Object.keys(rows[0] ?? {}),
        });

        // Anything bound to this dataset is now live, without the dashboard
        // having had to ask for it: a change stream if the server offers one,
        // and a poll either way.
        this.watchDataset(id);
        if (!this.polls.has(id)) {
          this.setPollInterval(id, this.subscribed ? SUBSCRIBED_POLL_SECONDS : DEFAULT_POLL_SECONDS);
        }
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
