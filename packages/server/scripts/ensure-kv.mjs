#!/usr/bin/env node
/**
 * Make sure the KV namespace this Worker binds to exists, and point
 * wrangler.toml at it.
 *
 * Asking someone to run one command, copy a 32-character id out of the output
 * and paste it into two places is three chances to get it wrong. The id is not
 * a secret — it identifies a namespace and is useless without the account
 * token — so it can simply be looked up, created if missing, and written in.
 *
 *   node scripts/ensure-kv.mjs            # uses your wrangler login
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/ensure-kv.mjs
 *
 * Idempotent: run it as often as you like.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(SERVER, 'wrangler.toml');
const BINDING = 'DATA';
const ID_PATTERN = /^[0-9a-f]{32}$/;

const config = fs.readFileSync(CONFIG, 'utf8');
const workerName = config.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? 'worker';

/** The id currently configured, if it is a real one. */
function currentId() {
  // The `id` on the line following the DATA binding.
  const block = config.match(/\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"DATA"[\s\S]*?(?=\n\[|$)/);
  const id = block?.[0].match(/^\s*id\s*=\s*"([^"]*)"/m)?.[1];
  return id && ID_PATTERN.test(id) ? id : null;
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], {
    cwd: SERVER,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Look for a namespace this project would have created. */
function findExisting() {
  let output;
  try {
    output = wrangler(['kv', 'namespace', 'list']);
  } catch {
    return null; // No access, or none exist yet — creating will report properly.
  }
  const json = output.slice(output.indexOf('['));
  let namespaces;
  try {
    namespaces = JSON.parse(json);
  } catch {
    return null;
  }
  const wanted = [`${workerName}-${BINDING}`, BINDING];
  const match = namespaces.find(ns => wanted.includes(ns.title));
  return match?.id ?? null;
}

function create() {
  let output;
  try {
    output = wrangler(['kv', 'namespace', 'create', BINDING]);
  } catch {
    // Almost always one of two things, and the raw wrangler stack says neither.
    process.stderr.write(
      'Could not reach Cloudflare to create the KV namespace.\n' +
        'Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.\n' +
        'The token needs the "Edit Cloudflare Workers" template, which includes Workers KV Storage.\n',
    );
    process.exit(1);
  }
  const id = output.match(/[0-9a-f]{32}/)?.[0];
  if (!id) throw new Error(`could not find a namespace id in wrangler's output:\n${output}`);
  return id;
}

const existing = currentId();
if (existing) {
  process.stdout.write(`KV namespace already configured: ${existing}\n`);
  process.exit(0);
}

// An explicit id wins — useful for pointing a deployment at a namespace that
// this project did not create.
const id = process.env.CLOUDFLARE_KV_NAMESPACE_ID?.trim() || findExisting() || create();

const patched = config.replace(
  /(\[\[kv_namespaces\]\][\s\S]*?binding\s*=\s*"DATA"[\s\S]*?^\s*id\s*=\s*")[^"]*(")/m,
  `$1${id}$2`,
);
if (patched === config) {
  throw new Error(`could not find the ${BINDING} kv_namespaces binding in wrangler.toml`);
}
fs.writeFileSync(CONFIG, patched);
process.stdout.write(`KV namespace ${id} → wrangler.toml\n`);
