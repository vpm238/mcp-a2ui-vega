#!/usr/bin/env node
/**
 * How long does a dashboard take to notice new data, and what did it have to
 * ask for along the way?
 *
 *   node tools/push-latency.mjs [serverUrl]
 *
 * The number that matters is not the milliseconds — it is the request list. An
 * idle dashboard should make no requests at all, and a change should produce
 * exactly one: the fetch it was told to make.
 */
import { chromium } from 'playwright';

const SERVER = process.argv[2] ?? process.env.SERVER_URL ?? 'http://localhost:8788';
const HARNESS = process.env.HARNESS_URL ?? 'http://localhost:8479/tools/harness.html';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

const requests = [];
page.on('request', request => {
  const url = request.url();
  if (url.includes('/api/tools/') || url.includes('/events')) {
    requests.push(url.slice(url.indexOf('/', 8)).slice(0, 48));
  }
});

await page.goto(`${HARNESS}?app=${SERVER}/app.html&server=${SERVER}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
await page.evaluate(async () => {
  await window.deliver('render_dashboard', {});
});
await page.waitForTimeout(5000);

const view = page.frames().find(frame => frame !== page.mainFrame());
const status = () => view.$eval('.status__text', el => el.textContent);

const subscribers = await fetch(`${SERVER}/api/subscribers`).then(r => r.json());
process.stdout.write(`connected views: ${subscribers.subscribers}\n`);

// Now go quiet and watch what an idle dashboard does.
requests.length = 0;
await page.waitForTimeout(20_000);
process.stdout.write(`requests while idle for 20s: ${requests.length ? requests.join(', ') : 'none'}\n`);

const before = await status();
requests.length = 0;
const started = Date.now();

await fetch(`${SERVER}/api/tools/append_rows`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rows: [{ show: 'Wicked', section: 'Box', channel: 'Web', quantity: 7, unit_price: 250 }] }),
});

let elapsed = null;
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(250);
  if ((await status()) !== before) {
    elapsed = Date.now() - started;
    break;
  }
}

process.stdout.write(`before: ${before}\nafter : ${await status()}\n`);
process.stdout.write(elapsed ? `noticed in ${elapsed} ms\n` : 'DID NOT NOTICE within 10s\n');
process.stdout.write(`requests it made to catch up: ${requests.join(', ') || 'none'}\n`);

await browser.close();
process.exitCode = elapsed && elapsed < 5000 ? 0 : 1;
