/**
 * The MCP server: what the agent can ask for.
 *
 * Two rules shape the tool surface.
 *
 * First, rows never travel through the model. `render_dashboard` returns a
 * layout and a row *count*; the view fetches the rows itself with
 * `get_dataset_rows`, a tool marked app-only so it never appears in the agent's
 * tool list. Twelve thousand orders belong in a chart, not in a context window.
 *
 * Second, a dashboard is components, not a picture. `update_dashboard` replaces
 * individual components by id, so "make the sales chart a line and colour today
 * green" edits two components and leaves the user's filters and scroll position
 * alone.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import {
  CATALOG_ID,
  TOOLS,
  parseCsv,
  todayInZone,
  type SavedWidget,
} from '@mcp-a2ui-vega/catalog';
import catalogDocument from '@mcp-a2ui-vega/catalog/catalog.json';
import appHtml from './generated/app.html';
import type { Env } from './env.ts';
import { Store, distinctValues, type DatasetMeta } from './store.ts';
import { hubFor } from './hub.ts';
import {
  assertValidMessages,
  composeDashboard,
  composeUpdate,
  validateComponents,
} from './dashboard.ts';

export const UI_RESOURCE = 'ui://a2ui-vega/dashboard';
export const CATALOG_RESOURCE = 'a2ui://catalog/vega-dashboard';
export const PAYLOAD_RESOURCE = 'a2ui://dashboard/ticket_sales';
export const WIDGETS_RESOURCE = 'a2ui://widgets';

const DEFAULT_DATASET = 'ticket_sales';

/** A2UI messages ride in `_meta`, where they reach the view without reaching the model. */
const A2UI_META = 'a2ui/messages';
const DATASETS_META = 'a2ui/datasets';
const DISPLAY_META = 'a2ui/display';

const componentSchema = z.record(z.string(), z.unknown());

/** Text for the model plus a payload for the view. */
function dashboardResult(
  summary: string,
  messages: unknown[],
  datasets: Array<{ id: string; rowCount: number; columns: string[] }>,
  structured: Record<string, unknown> = {},
  display?: string,
) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: structured,
    _meta: { [A2UI_META]: messages, [DATASETS_META]: datasets, ...(display ? { [DISPLAY_META]: display } : {}) },
  };
}

function problemResult(problems: string[]) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `The dashboard was not rendered — these components do not match the catalog:\n- ${problems.join('\n- ')}`,
      },
    ],
    isError: true,
  };
}

/**
 * The app is served with its own origin baked in.
 *
 * A view loaded from a `ui://` resource has no origin of its own to infer — the
 * host decides where it runs — so the server, which does know, writes it into
 * the bundle on the way out.
 */
export function withOrigin(html: string, origin: string): string {
  // The token deliberately differs from the property name it is assigned to:
  // the bundle contains `window.__MCP_SERVER_ORIGIN__`, and replacing the first
  // match of *that* rewrites the property access into `window.https://…`, which
  // is a syntax error and a genuinely confusing one to debug.
  return html.replaceAll('@@MCP_SERVER_ORIGIN@@', origin);
}

export function createMcpServer(env: Env, origin?: string, ctx?: ExecutionContext): McpServer {
  const store = new Store(env, meta => notifyHub(env, meta, ctx));
  const server = new McpServer(
    { name: 'a2ui-vega-dashboard', version: '0.1.0' },
    {
      instructions: [
        'This server renders dashboards as A2UI: the agent composes components from a catalog and the host draws them.',
        `Read the catalog at ${CATALOG_RESOURCE} before composing your own layout.`,
        'Call render_dashboard with no components for the reference ticket-sales dashboard; pass `components` to compose your own.',
        'To change a dashboard that is already on screen, use update_dashboard and send only the components whose ids changed — do not re-render the whole surface.',
        'Never put dataset rows in a tool argument. Charts bind to a path such as /datasets/ticket_sales/rows and the view loads the rows itself.',
        'Any Vega-Lite chart type works, including ones the catalog does not name. Compose the spec, and if the user wants it again later, save_widget remembers it by name.',
      ].join(' '),
    },
  );

  // -- Resources ----------------------------------------------------------

  // The app itself. Everything is inlined, so it needs no network access at
  // all — the CSP below says exactly that.
  registerAppResource(
    server,
    'dashboard-app',
    UI_RESOURCE,
    {
      title: 'A2UI Vega dashboard',
      description: 'An A2UI renderer with a Vega-Lite chart catalog.',
      mimeType: 'text/html;profile=mcp-app',
      _meta: {
        ui: {
          // The one thing the app reaches for directly: a change stream, so the
          // dashboard learns about new rows instead of asking every few seconds.
          // Rows themselves still come through the host's tool proxy.
          csp: { connectDomains: origin ? [origin] : [], resourceDomains: [] },
          prefersBorder: true,
        },
      },
    },
    () => ({
      contents: [
        {
          uri: UI_RESOURCE,
          mimeType: 'text/html;profile=mcp-app',
          text: withOrigin(appHtml, origin ?? ''),
        },
      ],
    }),
  );

  // The catalog document: the contract an agent composes against.
  server.registerResource(
    'catalog',
    CATALOG_RESOURCE,
    {
      title: 'Vega dashboard catalog',
      description:
        'Every component and function this renderer can draw, as JSON Schema. Read this before composing a custom layout.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [{ uri: CATALOG_RESOURCE, mimeType: 'application/json', text: JSON.stringify(catalogDocument) }],
    }),
  );

  /*
   * The same dashboard as a portable A2UI payload.
   *
   * A host that speaks A2UI natively does not need the iframe app at all: it
   * can read this and render with its own catalog implementation. Serving both
   * is the point — the payload is the portable artifact, and the MCP App is how
   * hosts that do not speak A2UI get to see it anyway.
   */
  server.registerResource(
    'dashboard-payload',
    PAYLOAD_RESOURCE,
    {
      title: 'Ticket sales dashboard (A2UI)',
      description: 'The reference dashboard as A2UI messages, for hosts with their own A2UI renderer.',
      mimeType: 'application/a2ui+json',
    },
    async () => {
      const { messages } = await buildDashboard(store, {});
      return {
        contents: [
          { uri: PAYLOAD_RESOURCE, mimeType: 'application/a2ui+json', text: JSON.stringify(messages) },
        ],
      };
    },
  );

  server.registerResource(
    'widgets',
    WIDGETS_RESOURCE,
    {
      title: 'Saved widgets',
      description: 'Charts composed in earlier conversations and kept by name.',
      mimeType: 'application/json',
    },
    async () => ({
      contents: [
        { uri: WIDGETS_RESOURCE, mimeType: 'application/json', text: JSON.stringify(await store.listWidgets()) },
      ],
    }),
  );

  // -- Dashboard tools ----------------------------------------------------

  registerAppTool(
    server,
    TOOLS.renderDashboard,
    {
      title: 'Show a dashboard',
      description:
        'Render a dashboard in the conversation. With no `components` this shows the reference ticket-sales dashboard: metrics, sales over time, channel and show breakdowns, the latest orders, and CSV intake. Pass `components` to compose your own layout from the catalog, or `widgets` to add charts saved earlier.',
      inputSchema: {
        datasetId: z.string().optional().describe(`Dataset to bind to. Defaults to "${DEFAULT_DATASET}".`),
        title: z.string().optional().describe('Heading shown at the top of the dashboard.'),
        components: z
          .array(componentSchema)
          .optional()
          .describe(
            'A complete A2UI component list, including one with id "root". Read the catalog resource first. Omit for the reference dashboard.',
          ),
        dataModel: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Extra initial data-model values, merged over the defaults.'),
        widgets: z
          .array(z.string())
          .optional()
          .describe('Names of saved widgets to add to the reference dashboard.'),
        display: z
          .enum(['auto', 'inline', 'fullscreen'])
          .optional()
          .describe(
            'How much room to ask the host for. Defaults to auto: a full dashboard opens in the larger panel, a single chart or a couple of tiles stays inline. The host may refuse.',
          ),
      },
      _meta: { ui: { resourceUri: UI_RESOURCE, visibility: ['model', 'app'] } },
    },
    async args => {
      if (args.components) {
        const problems = validateComponents(args.components);
        if (problems.length) return problemResult(problems);
      }
      const { messages, meta, componentCount } = await buildDashboard(store, args);
      return dashboardResult(
        `Rendered the dashboard for "${meta.title}" — ${meta.rowCount.toLocaleString()} rows, ${componentCount} components. The view loads the rows itself; they are not in this result.`,
        messages,
        [{ id: meta.id, rowCount: meta.rowCount, columns: meta.columns }],
        { datasetId: meta.id, rowCount: meta.rowCount, columns: meta.columns, updatedAt: meta.updatedAt },
        args.display ?? 'auto',
      );
    },
  );

  registerAppTool(
    server,
    TOOLS.updateDashboard,
    {
      title: 'Change part of the dashboard',
      description:
        'Replace components on the dashboard already on screen, by id. Send only what changed — a chart swapped for a different mark, a tile given a colour, a section retitled. Components not named here are untouched, and the user keeps their filters and scroll position. Use this rather than re-rendering.',
      inputSchema: {
        components: z
          .array(componentSchema)
          .optional()
          .describe('Components to add or replace. An existing id replaces that component in place.'),
        dataModel: z
          .array(z.object({ path: z.string(), value: z.unknown() }))
          .optional()
          .describe('Data-model writes, as JSON Pointer paths, e.g. {"path": "/filters/show", "value": ["Wicked"]}.'),
      },
      _meta: { ui: { resourceUri: UI_RESOURCE, visibility: ['model', 'app'] } },
    },
    async args => {
      if (args.components) {
        // A partial update has no `root`, which is legal here and only here.
        const problems = validateComponents(args.components).filter(problem => !problem.includes('id "root"'));
        if (problems.length) return problemResult(problems);
      }
      const messages = assertValidMessages(
        composeUpdate({
          components: args.components as never,
          dataModel: args.dataModel as Array<{ path: string; value: unknown }>,
        }),
      );
      if (messages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Nothing to update — pass `components` or `dataModel`.' }],
          isError: true,
        };
      }
      const ids = (args.components ?? []).map(component => String((component as { id?: unknown }).id));
      return dashboardResult(
        ids.length ? `Updated ${ids.length} component(s): ${ids.join(', ')}.` : 'Updated the data model.',
        messages,
        [],
        { updatedComponents: ids },
      );
    },
  );

  // -- Dataset tools ------------------------------------------------------

  server.registerTool(
    TOOLS.listDatasets,
    {
      title: 'List datasets',
      description: 'The datasets this server holds, with row counts and columns.',
      inputSchema: {},
    },
    async () => {
      const datasets = await store.listDatasets();
      return {
        content: [
          {
            type: 'text' as const,
            text: datasets
              .map(d => `${d.id}: ${d.rowCount.toLocaleString()} rows · ${d.columns.join(', ')}`)
              .join('\n') || 'No datasets yet.',
          },
        ],
        structuredContent: { datasets },
      };
    },
  );

  server.registerTool(
    TOOLS.describeDataset,
    {
      title: 'Describe a dataset',
      description:
        'Column types, ranges, distinct values and a few sample rows. Read this before writing a Vega-Lite spec so the encodings match the data.',
      inputSchema: {
        datasetId: z.string().optional().describe(`Defaults to "${DEFAULT_DATASET}".`),
      },
    },
    async args => {
      const profile = await store.profile(args.datasetId ?? DEFAULT_DATASET);
      const lines = profile.columnDetail.map(column => {
        const range =
          column.min !== undefined ? ` range ${column.min}…${column.max}` : ` ${column.distinctCount} distinct`;
        return `${column.name} (${column.type}):${range} e.g. ${column.examples.slice(0, 6).join(', ')}`;
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `${profile.title} — ${profile.rowCount.toLocaleString()} rows\n${profile.description ?? ''}\n\n${lines.join('\n')}\n\nSample:\n${profile.sampleCsv}`,
          },
        ],
        structuredContent: profile as unknown as Record<string, unknown>,
      };
    },
  );

  // App-only: this is the tool that carries the rows, and the whole point is
  // that it goes to the view and not to the model.
  registerAppTool(
    server,
    TOOLS.getDatasetRows,
    {
      title: 'Get dataset rows',
      description: 'Rows for the view to plot. Not for the model — use describe_dataset instead.',
      inputSchema: {
        datasetId: z.string().optional(),
        format: z.enum(['rows', 'columnar']).optional(),
        limit: z.number().optional(),
        since: z
          .string()
          .optional()
          .describe(
            "The `updatedAt` the caller already has. If the dataset has not changed since then, the rows are omitted and `unchanged: true` comes back instead.",
          ),
      },
      _meta: { ui: { visibility: ['app'] } },
    },
    async args => {
      const id = args.datasetId ?? DEFAULT_DATASET;

      // A poll that finds nothing new should cost a few bytes, not the whole
      // dataset. This is what makes a fifteen-second refresh reasonable.
      if (args.since) {
        const current = await store.getMeta(id);
        if (current && current.updatedAt === args.since) {
          return {
            content: [{ type: 'text' as const, text: 'unchanged' }],
            structuredContent: { unchanged: true, rowCount: current.rowCount, updatedAt: current.updatedAt },
          };
        }
      }

      const { rows, meta } = await store.getRows(id, args.limit);
      // Columnar cuts the payload roughly in half by not repeating every key on
      // every row — worth it when the view pulls the whole dataset.
      const structured =
        args.format === 'columnar'
          ? {
              format: 'columnar',
              columns: meta.columns,
              rows: rows.map(row => meta.columns.map(column => row[column] ?? '')),
              rowCount: meta.rowCount,
              updatedAt: meta.updatedAt,
            }
          : { format: 'rows', columns: meta.columns, rows, rowCount: meta.rowCount, updatedAt: meta.updatedAt };

      return {
        content: [{ type: 'text' as const, text: `${rows.length} rows` }],
        structuredContent: structured,
      };
    },
  );

  registerAppTool(
    server,
    TOOLS.appendRows,
    {
      title: 'Add rows',
      description:
        'Append orders to a dataset. Missing columns are filled in: an order id, the current time in the dataset timezone, status "paid", and gross from price times quantity.',
      inputSchema: {
        datasetId: z.string().optional(),
        rows: z.array(z.record(z.string(), z.unknown())).describe('Rows to append, as objects keyed by column.'),
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    async args => {
      const meta = await store.appendRows(args.datasetId ?? DEFAULT_DATASET, args.rows as Array<Record<string, unknown>>);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Added ${args.rows.length} row(s) to ${meta.id} — ${meta.rowCount.toLocaleString()} rows total.`,
          },
        ],
        structuredContent: { datasetId: meta.id, rowsAdded: args.rows.length, rowCount: meta.rowCount, updatedAt: meta.updatedAt },
      };
    },
  );

  registerAppTool(
    server,
    TOOLS.uploadCsv,
    {
      title: 'Upload a CSV',
      description: 'Add a CSV to a dataset, or replace it entirely. The first line must be a header row.',
      inputSchema: {
        datasetId: z.string().optional(),
        csv: z.string().describe('CSV text, including the header row.'),
        mode: z.enum(['append', 'replace']).optional().describe('Defaults to append.'),
        title: z.string().optional(),
        description: z.string().optional(),
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    async args => {
      const id = args.datasetId ?? DEFAULT_DATASET;
      const rows = parseCsvRows(args.csv);
      const meta =
        args.mode === 'replace' || !(await store.getMeta(id))
          ? await store.replaceDataset(id, args.csv, { title: args.title, description: args.description })
          : await store.appendRows(id, rows);

      return {
        content: [
          {
            type: 'text' as const,
            text: `${args.mode === 'replace' ? 'Replaced' : 'Added to'} ${meta.id}: ${rows.length} row(s) in, ${meta.rowCount.toLocaleString()} total.`,
          },
        ],
        structuredContent: { datasetId: meta.id, rowsAdded: rows.length, rowCount: meta.rowCount, updatedAt: meta.updatedAt },
      };
    },
  );

  server.registerTool(
    TOOLS.resetDataset,
    {
      title: 'Reset a dataset',
      description: 'Restore the dataset that shipped with this server, discarding uploads and appends.',
      inputSchema: { datasetId: z.string().optional() },
      annotations: { destructiveHint: true },
    },
    async args => {
      const meta = await store.resetDataset(args.datasetId ?? DEFAULT_DATASET);
      return {
        content: [{ type: 'text' as const, text: `Reset ${meta.id} to ${meta.rowCount.toLocaleString()} rows.` }],
        structuredContent: { datasetId: meta.id, rowCount: meta.rowCount },
      };
    },
  );

  // -- Saved widgets ------------------------------------------------------

  registerAppTool(
    server,
    TOOLS.saveWidget,
    {
      title: 'Remember this chart',
      description:
        'Save a Vega-Lite chart under a name so it can be asked for again later. Use this when the user likes a chart you composed — especially one the catalog does not name, like a heatmap or a box plot. The spec must not contain `data`.',
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/, 'lower case letters, digits and underscores, starting with a letter')
          .describe('Short handle, e.g. "sales_by_hour_heatmap".'),
        title: z.string().describe('What the user would call it.'),
        description: z.string().optional().describe('One line on what it shows.'),
        spec: z.record(z.string(), z.unknown()).describe('The Vega-Lite spec, without `data`.'),
        datasetId: z.string().optional(),
        filters: z.array(z.record(z.string(), z.unknown())).optional(),
        height: z.number().optional(),
        accent: z.string().optional(),
      },
      _meta: { ui: { visibility: ['model', 'app'] } },
    },
    async args => {
      if ('data' in args.spec) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Remove `data` from the spec — the widget binds to a dataset when it is rendered, so a saved spec with data in it would go stale.',
            },
          ],
          isError: true,
        };
      }
      const saved = await store.saveWidget(args as Omit<SavedWidget, 'createdAt' | 'updatedAt'>);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Saved "${saved.title}" as \`${saved.name}\`. Add it to a dashboard with render_dashboard({widgets: ["${saved.name}"]}).`,
          },
        ],
        structuredContent: { name: saved.name, title: saved.title, updatedAt: saved.updatedAt },
      };
    },
  );

  server.registerTool(
    TOOLS.listWidgets,
    {
      title: 'List saved charts',
      description: 'Charts saved in earlier conversations, by name.',
      inputSchema: {},
    },
    async () => {
      const widgets = await store.listWidgets();
      return {
        content: [
          {
            type: 'text' as const,
            text:
              widgets.map(w => `${w.name}: ${w.title}${w.description ? ` — ${w.description}` : ''}`).join('\n') ||
              'Nothing saved yet.',
          },
        ],
        structuredContent: { widgets: widgets.map(({ spec: _spec, ...rest }) => rest) },
      };
    },
  );

  server.registerTool(
    TOOLS.getWidget,
    {
      title: 'Get a saved chart',
      description: 'The full spec of a saved chart, so you can adapt it rather than starting again.',
      inputSchema: { name: z.string() },
    },
    async args => {
      const widget = await store.getWidget(args.name);
      if (!widget) {
        return { content: [{ type: 'text' as const, text: `No saved widget called "${args.name}".` }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(widget, null, 2) }],
        structuredContent: widget as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    TOOLS.deleteWidget,
    {
      title: 'Forget a saved chart',
      description: 'Delete a saved chart by name.',
      inputSchema: { name: z.string() },
      annotations: { destructiveHint: true },
    },
    async args => {
      const deleted = await store.deleteWidget(args.name);
      return {
        content: [
          { type: 'text' as const, text: deleted ? `Forgot "${args.name}".` : `No saved widget called "${args.name}".` },
        ],
        isError: !deleted,
      };
    },
  );

  return server;
}

/**
 * Tell connected views that a dataset moved.
 *
 * Handed to `waitUntil` rather than left floating: a Worker cancels pending
 * promises the moment its response is returned, so a bare `void fetch(...)`
 * survives `wrangler dev` and is silently dropped in production — the stream
 * connects, the append succeeds, and the notification never arrives.
 *
 * Still fire-and-forget in spirit: a view that misses one falls back to its own
 * poll, whereas a write that failed because nobody was listening would be a
 * genuine bug.
 */
function notifyHub(env: Env, meta: DatasetMeta, ctx?: ExecutionContext): void {
  try {
    const broadcast = hubFor(env.HUB)
      .fetch('https://hub/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ datasetId: meta.id, updatedAt: meta.updatedAt, rowCount: meta.rowCount }),
      })
      .catch(() => {});
    if (ctx) ctx.waitUntil(broadcast);
  } catch {
    // No hub binding (a test harness, say). The dashboard still works.
  }
}

/** Shared by the render tool and the portable A2UI resource. */
export async function buildDashboard(
  store: Store,
  args: { datasetId?: string; title?: string; components?: unknown[]; dataModel?: Record<string, unknown>; widgets?: string[] },
) {
  const datasetId = args.datasetId ?? DEFAULT_DATASET;
  const { rows, meta } = await store.getRows(datasetId);

  const saved: SavedWidget[] = [];
  for (const name of args.widgets ?? []) {
    const widget = await store.getWidget(name);
    if (widget) saved.push(widget);
  }

  const messages = assertValidMessages(
    composeDashboard({
      datasetId,
      title: args.title ?? meta.title,
      today: todayInZone(),
      shows: distinctValues(rows, 'show'),
      channels: distinctValues(rows, 'channel'),
      rowCount: meta.rowCount,
      updatedAt: meta.updatedAt,
      components: args.components as never,
      dataModel: args.dataModel,
      widgets: saved,
    }),
  );

  const update = messages.find(message => 'updateComponents' in message) as
    | { updateComponents: { components: unknown[] } }
    | undefined;

  return { messages, meta, componentCount: update?.updateComponents.components.length ?? 0 };
}

/** Count rows in an uploaded CSV without holding a second copy of the parse. */
function parseCsvRows(csv: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (const row of parseCsv(csv)) rows.push(row);
  return rows;
}
