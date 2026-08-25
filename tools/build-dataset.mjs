#!/usr/bin/env node
/**
 * Rebuild data/ticket_sales.csv from the real Broadway weekly grosses dataset.
 *
 *   node tools/build-dataset.mjs [--end 2026-08-25] [--days 90] [--shows 12]
 *                               [--share 0.02] [--seed 20260825]
 *
 * Downloads the source CSV to .cache/ on first run. Deterministic: the same
 * flags always produce the same file, byte for byte.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from '../packages/catalog/dist/index.js';
import { buildShowProfiles, generateOrders, ORDER_COLUMNS } from './lib/generator.mjs';

// The dataset is New York time end to end: Broadway is a New York business,
// and a fixed zone keeps the file reproducible wherever it is generated.
process.env.TZ = 'America/New_York';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_URL =
  'https://raw.githubusercontent.com/rfordatascience/tidytuesday/master/data/2020/2020-04-28/grosses.csv';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

async function loadSource() {
  const cached = path.join(ROOT, '.cache', 'grosses.csv');
  if (!fs.existsSync(cached)) {
    process.stderr.write(`fetching ${SOURCE_URL}\n`);
    const res = await fetch(SOURCE_URL);
    if (!res.ok) throw new Error(`source download failed: ${res.status} ${res.statusText}`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, await res.text());
  }
  return parseCsv(fs.readFileSync(cached, 'utf8'));
}

const end = arg('end', today());
const days = Number(arg('days', 90));
const showCount = Number(arg('shows', 12));
const share = Number(arg('share', 0.02));
const seed = Number(arg('seed', 20260825));
// The last full pre-pandemic Broadway season in the source data.
const seasonFrom = arg('season-from', '2019-09-01');
const seasonTo = arg('season-to', '2020-02-23');

const rows = await loadSource();
const profiles = buildShowProfiles(rows, { seasonFrom, seasonTo, showCount });
if (profiles.length === 0) throw new Error('no shows matched the requested season window');

// An explicit --end means "through the end of that day"; the default means "up
// to right now", so the newest row is minutes old rather than hours ahead.
const endDate = process.argv.includes('--end') ? new Date(`${end}T23:59:59`) : new Date();
const fromDate = new Date(endDate.getTime() - days * 86400000);
const orders = generateOrders({
  profiles,
  from: fromDate,
  to: endDate,
  share,
  seed,
});

const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'shows.json'), JSON.stringify(profiles, null, 2) + '\n');
fs.writeFileSync(path.join(dataDir, 'ticket_sales.csv'), toCsv(orders, ORDER_COLUMNS));

const tickets = orders.reduce((sum, o) => sum + o.quantity, 0);
const gross = orders.reduce((sum, o) => sum + Number(o.gross), 0);
const meta = {
  dataset: 'ticket_sales',
  generatedFrom: {
    source: SOURCE_URL,
    sourceDescription:
      'Weekly Broadway grosses (Playbill), 1985-2020, via the TidyTuesday project. Real shows, theatres, seat counts, capacity and ticket prices.',
    seasonWindow: [seasonFrom, seasonTo],
  },
  modelled:
    'Individual orders are modelled, not real: the source data is weekly and aggregate. Each show plays its real eight-performance week at its real weekly capacity; this platform sells `share` of the house and splits those seats into orders across sections, channels, promos and party sizes, priced off the show\'s real average ticket price.',
  parameters: { end, days, shows: showCount, share, seed, timezone: 'America/New_York' },
  columns: ORDER_COLUMNS,
  window: { from: orders[0]?.ordered_at ?? null, to: orders.at(-1)?.ordered_at ?? null },
  rows: orders.length,
  tickets,
  gross: Number(gross.toFixed(2)),
  avgTicketPrice: Number((gross / tickets).toFixed(2)),
};
fs.writeFileSync(path.join(dataDir, 'ticket_sales.meta.json'), JSON.stringify(meta, null, 2) + '\n');

process.stdout.write(
  `${orders.length} orders · ${tickets} tickets · $${Math.round(gross).toLocaleString('en-US')} gross\n` +
    `${profiles.length} shows · ${meta.window.from} → ${meta.window.to}\n` +
    `avg ticket $${meta.avgTicketPrice} (real season avg $${(
      profiles.reduce((s, p) => s + p.avgTicketPrice, 0) / profiles.length
    ).toFixed(2)})\n`,
);
