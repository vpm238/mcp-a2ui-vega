#!/usr/bin/env node
/**
 * Write a small CSV of freshly-placed orders, for dropping into the dashboard
 * by hand.
 *
 *   node tools/make-sample-csv.mjs                          # 40 orders, timed now
 *   node tools/make-sample-csv.mjs --count 200 --out big.csv
 *
 * The rows carry the current wall-clock time, so appending them moves "Sold
 * today" and pushes the right-hand end of the sales-over-time chart. That is
 * the point: it is the same generator the live feed uses, so what you upload is
 * indistinguishable from what the feed would have produced.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateBurst, ORDER_COLUMNS } from './lib/generator.mjs';

// New York time end to end, matching the dataset.
process.env.TZ = 'America/New_York';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const count = Number(arg('count', 40));
const out = path.resolve(arg('out', path.join(ROOT, 'data', 'sample-append.csv')));
const spreadSeconds = Number(arg('spread', 3 * 60 * 60));

const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));

// A high start index keeps these ids clear of the ones already in the dataset,
// so an upload never looks like a duplicate of an existing order.
const rows = generateBurst({
  profiles,
  count,
  spreadSeconds,
  startIndex: 900_000,
  seed: 20260825,
});

const escape = value => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const csv = [
  ORDER_COLUMNS.join(','),
  ...rows.map(row => ORDER_COLUMNS.map(column => escape(row[column])).join(',')),
].join('\n');

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${csv}\n`);

const gross = rows.reduce((total, row) => total + Number(row.gross || 0), 0);
process.stdout.write(
  `${out}\n${rows.length} orders · $${gross.toLocaleString('en-US', { maximumFractionDigits: 0 })} gross · ` +
    `${rows[0].ordered_at} → ${rows[rows.length - 1].ordered_at}\n`,
);
