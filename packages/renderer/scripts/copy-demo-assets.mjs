#!/usr/bin/env node
/**
 * Copy the demo dataset into the static site build.
 *
 * The standalone page reads `./demo/ticket_sales.csv` when no server is
 * configured, and `emptyOutDir` clears the directory on every build, so this
 * runs as part of the build rather than being remembered by hand.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const OUT = path.resolve(HERE, '..', 'dist', 'site', 'demo');

const files = ['data/ticket_sales.csv', 'data/ticket_sales.meta.json'];

fs.mkdirSync(OUT, { recursive: true });
for (const file of files) {
  const source = path.join(REPO, file);
  if (!fs.existsSync(source)) {
    throw new Error(`${file} is missing — run \`npm run data:build\` first`);
  }
  fs.copyFileSync(source, path.join(OUT, path.basename(file)));
}

process.stdout.write(`demo assets → ${path.relative(REPO, OUT)}/ (${files.length} files)\n`);
