#!/usr/bin/env node
/**
 * Open the dashboard in a real browser, report what the console said, and save
 * a screenshot.
 *
 *   node tools/screenshot.mjs [url] [outfile] [--width 1200] [--height 1600]
 *
 * Used during development and by the end-to-end test: a chart that throws at
 * runtime typechecks perfectly, so the only proof that the catalog works is a
 * browser drawing it.
 */
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:8477/index.html';
const out = process.argv[3] ?? 'dashboard.png';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: arg('width', 1200), height: arg('height', 1400) } });

const problems = [];
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') {
    problems.push(`${message.type()}: ${message.text()}`);
  }
});
page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));

await page.goto(url, { waitUntil: 'networkidle' });

// Charts render asynchronously after the data lands.
await page.waitForSelector('canvas, .chart__error, .shell__notice--error', { timeout: 20_000 }).catch(() => {});
await page.waitForTimeout(1500);

const summary = await page.evaluate(() => ({
  charts: document.querySelectorAll('.chart__canvas canvas').length,
  chartErrors: [...document.querySelectorAll('.chart__error')].map(el => el.textContent),
  kpis: [...document.querySelectorAll('.kpi')].map(el => ({
    label: el.querySelector('.kpi__label')?.textContent,
    value: el.querySelector('.kpi__value')?.textContent,
  })),
  tableRows: document.querySelectorAll('.table tbody tr').length,
  notices: [...document.querySelectorAll('.shell__notice')].map(el => el.textContent),
  status: document.querySelector('.status__text')?.textContent,
}));

await page.screenshot({ path: out, fullPage: true });
await browser.close();

console.log(JSON.stringify({ url, out, ...summary, problems }, null, 2));
if (summary.charts === 0) process.exitCode = 1;
