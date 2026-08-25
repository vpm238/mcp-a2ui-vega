#!/usr/bin/env node
/**
 * Append freshly-placed ticket orders — the liveness demo.
 *
 *   node tools/append-sales.mjs                      # 6 orders, appended to the local CSV
 *   node tools/append-sales.mjs --count 25
 *   node tools/append-sales.mjs --watch 10           # 6 orders every 10s until Ctrl-C
 *   node tools/append-sales.mjs --url https://…      # push to a running server instead
 *
 * Rows carry the current wall-clock time, so a dashboard bound to this dataset
 * shows them the moment it refreshes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRows, toCsvBody } from '../packages/catalog/dist/index.js';
import { generateBurst, ORDER_COLUMNS } from './lib/generator.mjs';

// The dataset is New York time end to end: Broadway is a New York business,
// and a fixed zone keeps the file reproducible wherever it is generated.
process.env.TZ = 'America/New_York';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSV = path.join(ROOT, 'data', 'ticket_sales.csv');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const count = Number(arg('count', 6));
const watch = arg('watch', null);
const url = arg('url', null);
const dataset = arg('dataset', 'ticket_sales');
const spreadSeconds = Number(arg('spread', watch ? Number(watch) : 90));

const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));

/** Continue the order-id sequence from whatever the CSV already ends with. */
function nextOrderIndex() {
  if (!fs.existsSync(CSV)) return 1;
  const text = fs.readFileSync(CSV, 'utf8');
  const lastLine = text.trimEnd().split('\n').at(-1) ?? '';
  const id = parseRows(lastLine)[0]?.[0] ?? '';
  const n = Number(id.replace(/^ORD-/, ''));
  return Number.isFinite(n) && n > 0 ? n + 1 : 1;
}

async function appendToServer(rows) {
  const endpoint = `${url.replace(/\/$/, '')}/api/datasets/${dataset}/rows`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  if (!res.ok) throw new Error(`append failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function tick() {
  const rows = generateBurst({
    profiles,
    count,
    spreadSeconds,
    startIndex: url ? 1 : nextOrderIndex(),
    seed: (Date.now() ^ Math.floor(Math.random() * 2 ** 31)) >>> 0,
  });

  const gross = rows.reduce((sum, r) => sum + Number(r.gross), 0);
  const tickets = rows.reduce((sum, r) => sum + r.quantity, 0);

  if (url) {
    const result = await appendToServer(rows);
    process.stdout.write(
      `+${rows.length} orders · ${tickets} tickets · $${gross.toFixed(2)} → ${dataset} (${result.rows ?? '?'} rows total)\n`,
    );
  } else {
    fs.appendFileSync(CSV, toCsvBody(rows, ORDER_COLUMNS));
    process.stdout.write(
      `+${rows.length} orders · ${tickets} tickets · $${gross.toFixed(2)} → data/ticket_sales.csv\n`,
    );
  }
}

await tick();
if (watch) {
  const every = Number(watch) * 1000;
  process.stdout.write(`watching — appending every ${watch}s, Ctrl-C to stop\n`);
  setInterval(() => {
    tick().catch(err => process.stderr.write(`${err.message}\n`));
  }, every);
}
