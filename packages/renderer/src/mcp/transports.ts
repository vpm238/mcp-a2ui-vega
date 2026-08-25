/**
 * Three ways to reach the tools, behind one function type.
 *
 * The view does not care which one it got. That is what lets the same bundle be
 * the MCP App inside Claude, a page pointed at a running server, and a
 * self-contained demo on static hosting with no server at all.
 */
import type { App } from '@modelcontextprotocol/ext-apps';
import {
  TOOLS,
  nowInZone,
  parseCsv,
  ticketSalesDashboard,
  toCsv,
  todayInZone,
} from '@mcp-a2ui-vega/catalog';
import { A2UI_META, DATASETS_META, type CallTool, type ToolResult } from './gateway.ts';

/** Inside an MCP host: every call is proxied to the server by the host. */
export function mcpToolCaller(app: App): CallTool {
  return async (name, args) => (await app.callServerTool({ name, arguments: args })) as ToolResult;
}

/** Pointed at a running server: the same tools over plain HTTP. */
export function httpToolCaller(baseUrl: string): CallTool {
  const base = baseUrl.replace(/\/$/, '');
  return async (name, args) => {
    const response = await fetch(`${base}/api/tools/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!response.ok) throw new Error(`${name} failed: ${response.status} ${await response.text()}`);
    // The REST route returns the tool result verbatim, `_meta` included.
    return (await response.json()) as ToolResult;
  };
}

/**
 * No server: read the published CSV once and hold the dataset in memory.
 *
 * Appends and uploads are real — they just do not outlive the tab. It keeps the
 * static demo honest about what the dashboard does without pretending to be a
 * backend.
 */
export function demoToolCaller(csvUrl: string): CallTool {
  const datasetId = 'ticket_sales';
  let rows: Array<Record<string, string>> | null = null;
  let updatedAt = new Date().toISOString();

  async function load(): Promise<Array<Record<string, string>>> {
    if (rows) return rows;
    const response = await fetch(csvUrl);
    if (!response.ok) throw new Error(`could not load the demo dataset: ${response.status}`);
    rows = parseCsv(await response.text());
    return rows;
  }

  const distinct = (data: Array<Record<string, string>>, field: string) =>
    [...new Set(data.map(row => row[field] ?? '').filter(Boolean))].sort();

  return async (name, args) => {
    const data = await load();
    const columns = Object.keys(data[0] ?? {});

    switch (name) {
      case TOOLS.renderDashboard:
        return {
          _meta: {
            [A2UI_META]: ticketSalesDashboard({
              datasetId,
              title: 'Ticket sales',
              today: todayInZone(),
              shows: distinct(data, 'show'),
              channels: distinct(data, 'channel'),
              rowCount: data.length,
              updatedAt,
            }),
            [DATASETS_META]: [{ id: datasetId, rowCount: data.length, columns, updatedAt }],
          },
          structuredContent: { datasetId, rowCount: data.length, columns, updatedAt },
        };

      case TOOLS.getDatasetRows:
        return {
          structuredContent: {
            columns,
            rows: data.map(row => columns.map(column => row[column] ?? '')),
            rowCount: data.length,
            updatedAt,
            format: 'columnar',
          },
        };

      case TOOLS.appendRows: {
        const incoming = (args.rows ?? []) as Array<Record<string, string>>;
        const stamped = incoming.map((row, index) => ({
          ordered_at: nowInZone(),
          order_id: `ORD-LOCAL-${data.length + index + 1}`,
          status: 'paid',
          ...row,
          gross:
            row.gross ?? (Number(row.unit_price ?? 0) * Number(row.quantity ?? 1)).toFixed(2),
        }));
        data.push(...stamped);
        updatedAt = new Date().toISOString();
        return { structuredContent: { rowsAdded: stamped.length, rowCount: data.length, updatedAt } };
      }

      case TOOLS.uploadCsv: {
        const incoming = parseCsv(String(args.csv ?? ''));
        if (args.mode === 'replace') data.length = 0;
        data.push(...incoming);
        updatedAt = new Date().toISOString();
        return { structuredContent: { rowsAdded: incoming.length, rowCount: data.length, updatedAt } };
      }

      case TOOLS.describeDataset:
        return {
          structuredContent: {
            id: datasetId,
            columns,
            rowCount: data.length,
            updatedAt,
            sample: toCsv(data.slice(0, 3), columns),
          },
        };

      case TOOLS.listDatasets:
        return { structuredContent: { datasets: [{ id: datasetId, rowCount: data.length, columns, updatedAt }] } };

      default:
        throw new Error(`${name} needs a server — this page is running the standalone demo.`);
    }
  };
}
