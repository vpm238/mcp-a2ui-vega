#!/usr/bin/env node
/**
 * A pass-through to a deployed server, for testing from a network where the
 * browser cannot egress but Node can.
 *
 *   node tools/relay.mjs https://your-worker.workers.dev [port]
 *
 * Everything — the app bundle, the tool calls — is fetched from the real
 * deployment; only the hop from the browser is local. That keeps the end-to-end
 * test honest about which code is being exercised.
 */
import http from 'node:http';

const target = (process.argv[2] ?? '').replace(/\/$/, '');
const port = Number(process.argv[3] ?? 8790);
if (!target) {
  process.stderr.write('usage: node tools/relay.mjs https://your-worker.workers.dev [port]\n');
  process.exit(1);
}

const server = http.createServer(async (request, response) => {
  const url = `${target}${request.url}`;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);

  try {
    const upstream = await fetch(url, {
      method: request.method,
      headers: {
        'content-type': request.headers['content-type'] ?? 'application/json',
        accept: request.headers.accept ?? '*/*',
      },
      body: ['GET', 'HEAD'].includes(request.method ?? '') ? undefined : Buffer.concat(chunks),
    });

    const body = Buffer.from(await upstream.arrayBuffer());
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    response.end(body);
  } catch (error) {
    response.writeHead(502, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: String(error) }));
  }
});

server.listen(port, () => process.stdout.write(`relaying http://localhost:${port} → ${target}\n`));
