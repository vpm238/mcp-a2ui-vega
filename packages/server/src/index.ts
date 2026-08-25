/**
 * The Worker.
 *
 * `/mcp` is the endpoint you give Claude. Everything under `/api` is the same
 * tools reached over plain HTTP, for the standalone page and for scripts like
 * `tools/append-sales.mjs` — and "the same" is literal: a REST call is turned
 * into a JSON-RPC `tools/call` against this very server, so there is no second
 * implementation to drift.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { TOOLS } from '@mcp-a2ui-vega/catalog';
import appHtml from './generated/app.html';
import type { Env } from './env.ts';
import { createMcpServer } from './mcp.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization',
  'access-control-expose-headers': 'mcp-session-id',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS },
  });

/**
 * Handle one MCP request.
 *
 * Stateless: a Worker invocation has no memory of the last one, so each request
 * gets a fresh server and transport. Every tool here reads its state from KV,
 * which is what makes that safe.
 */
async function handleMcp(request: Request, env: Env): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer(env);
  await server.connect(transport);
  const response = await transport.handleRequest(request);

  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}

/** Call a tool without speaking MCP, by speaking MCP internally. */
async function callTool(env: Env, name: string, args: unknown): Promise<Response> {
  const rpc = new Request('https://internal/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer(env);
  await server.connect(transport);

  const response = await transport.handleRequest(rpc);
  const payload = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (payload.error) return json({ error: payload.error.message ?? 'tool call failed' }, 400);
  return json(payload.result ?? {});
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/mcp') return handleMcp(request, env);

    // The app bundle, so the dashboard can be opened directly against a
    // deployment as well as inside a host.
    if (url.pathname === '/app.html' || url.pathname === '/app') {
      return new Response(appHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS },
      });
    }

    if (url.pathname.startsWith('/api/tools/') && request.method === 'POST') {
      const name = url.pathname.slice('/api/tools/'.length);
      const args = await request.json().catch(() => ({}));
      return callTool(env, name, args);
    }

    // A convenience shape for scripts: POST rows straight at a dataset.
    const appendMatch = url.pathname.match(/^\/api\/datasets\/([^/]+)\/rows$/);
    if (appendMatch && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { rows?: unknown };
      const result = await callTool(env, TOOLS.appendRows, { datasetId: appendMatch[1], rows: body.rows ?? [] });
      const payload = (await result.json()) as { structuredContent?: { rowCount?: number; rowsAdded?: number } };
      return json({
        dataset: appendMatch[1],
        rowsAdded: payload.structuredContent?.rowsAdded ?? 0,
        rows: payload.structuredContent?.rowCount ?? 0,
      });
    }

    if (url.pathname === '/health') return json({ ok: true });

    if (url.pathname === '/') {
      return new Response(INDEX_HTML(url.origin), {
        headers: { 'content-type': 'text/html; charset=utf-8', ...CORS },
      });
    }

    return json({ error: 'not found' }, 404);
  },
};

const INDEX_HTML = (origin: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A2UI Vega dashboard — MCP server</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; max-width: 46rem; margin: 6vh auto; padding: 0 1.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  pre { padding: .75rem 1rem; border-radius: 8px; background: rgba(127,127,127,.12); overflow-x: auto; }
  a { color: #2563eb; }
  li { margin: .25rem 0; }
</style></head>
<body>
  <h1>A2UI Vega dashboard</h1>
  <p>An MCP App that renders agent-composed dashboards: an A2UI renderer with a Vega-Lite chart catalog.</p>
  <h2>Connect it</h2>
  <p>Add this as a custom connector in Claude:</p>
  <pre>${origin}/mcp</pre>
  <p>Then ask for the ticket sales dashboard.</p>
  <h2>Look at it without a host</h2>
  <ul>
    <li><a href="/app.html?server=${origin}">/app.html</a> — the dashboard, talking to this server</li>
    <li><a href="/health">/health</a></li>
  </ul>
  <p>No API keys are involved: this server stores rows and composes A2UI JSON. The agent is whichever MCP host connects to it.</p>
</body></html>`;
