#!/usr/bin/env node
/**
 * Gather what the Worker bundles: the built single-file app and the seed CSV.
 *
 * Both are text modules imported by the Worker (see the Text rule in
 * wrangler.toml), which is what lets a deployment be self-contained — no
 * external asset host for the app, no seeding step for the data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(HERE, '..', 'src', 'generated');

const assets = [
  {
    from: path.join(REPO, 'packages/renderer/dist/app/index.html'),
    to: path.join(OUT, 'app.html'),
    hint: 'run `npm run build:app -w @mcp-a2ui-vega/renderer` first',
  },
  {
    from: path.join(REPO, 'data/ticket_sales.csv'),
    to: path.join(OUT, 'ticket_sales.csv'),
    hint: 'run `npm run data:build` first',
  },
];

fs.mkdirSync(OUT, { recursive: true });
for (const asset of assets) {
  if (!fs.existsSync(asset.from)) {
    throw new Error(`missing ${path.relative(REPO, asset.from)} — ${asset.hint}`);
  }
  fs.copyFileSync(asset.from, asset.to);
  const size = fs.statSync(asset.to).size;
  process.stdout.write(`${path.basename(asset.to)} · ${(size / 1024).toFixed(0)} kB\n`);
}
