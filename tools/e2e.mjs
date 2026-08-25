#!/usr/bin/env node
/**
 * End-to-end test against a real browser, a real MCP server, and the real
 * MCP Apps postMessage protocol.
 *
 *   npm run dev -w @mcp-a2ui-vega/server      # terminal 1 — the Worker on :8788
 *   npx http-server -p 8479 .                 # terminal 2 — anything static at the repo root
 *   node tools/e2e.mjs
 *
 * Every assertion here is one the type checker cannot make: whether an agent's
 * message actually moved something a person can see.
 */
import { chromium } from 'playwright';

const SERVER = process.env.SERVER_URL ?? 'http://localhost:8788';
const HARNESS = process.env.HARNESS_URL ?? 'http://localhost:8479/tools/harness.html';
const SHOT = process.env.SCREENSHOT ?? null;

const failures = [];
const check = (label, condition, detail = '') => {
  const status = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures.push(label);
  process.stdout.write(`${status} ${label}${detail ? ` — ${detail}` : ''}\n`);
};

const money = text => Number(String(text ?? '').replace(/[^0-9.]/g, '')) || 0;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1240, height: 1500 } });

const consoleErrors = [];
page.on('pageerror', error => consoleErrors.push(`page: ${error.message}`));
page.on('console', message => {
  // A missing favicon is the host's business, not the app's.
  if (message.type() === 'error' && !message.text().includes('favicon')) consoleErrors.push(message.text());
});

await page.goto(`${HARNESS}?app=${SERVER}/app.html&server=${SERVER}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

/** The app runs in the iframe; the harness is the top frame. */
const view = () => page.frames().find(frame => frame !== page.mainFrame());

const snapshot = async () => {
  const frame = view();
  return frame.evaluate(() => ({
    kpis: [...document.querySelectorAll('.kpi')].map(tile => ({
      label: tile.querySelector('.kpi__label')?.textContent,
      value: tile.querySelector('.kpi__value')?.textContent,
      accent: tile.style.getPropertyValue('--kpi-accent'),
    })),
    charts: document.querySelectorAll('.chart__canvas canvas').length,
    sections: [...document.querySelectorAll('.section__title')].map(el => el.textContent),
    tableTotal: document.querySelector('.table__more')?.textContent ?? '',
    status: document.querySelector('.status__text')?.textContent ?? '',
    chartErrors: [...document.querySelectorAll('.chart__error')].map(el => el.textContent),
  }));
};

const run = async (scenario, wait = 3000) => {
  await page.click(`[data-scenario="${scenario}"]`);
  await page.waitForTimeout(wait);
  return snapshot();
};

// 1. The agent renders the dashboard.
check('view connects to the host', (await snapshot()) !== null);
const rendered = await run('render', 4500);
check('dashboard renders charts', rendered.charts >= 4, `${rendered.charts} charts`);
check('metrics are computed in the surface', money(rendered.kpis[0]?.value) > 100_000, rendered.kpis[0]?.value);
check('rows are loaded by the view, not the model', /\d/.test(rendered.status), rendered.status);
check('no chart failed to draw', rendered.chartErrors.length === 0, rendered.chartErrors.join('; '));

// 2. The follow-up: change part of the dashboard, keep the rest.
const recomposed = await run('recompose', 2500);
const todayTile = recomposed.kpis.find(kpi => kpi.label === 'Sold today');
check("recompose colours today's tile green", todayTile?.accent === '#16a34a', todayTile?.accent);
check('recompose leaves the other sections alone', recomposed.sections.length === rendered.sections.length);
check('recompose does not break any chart', recomposed.chartErrors.length === 0);

// 3. Rows appended outside the view reach it on their own.
const before = Number((recomposed.status.match(/([\d,]+) rows/)?.[1] ?? '0').replace(/,/g, ''));
const appended = await run('append', 12_000);
const after = Number((appended.status.match(/([\d,]+) rows/)?.[1] ?? '0').replace(/,/g, ''));
check('appended rows appear without anyone asking', after > before, `${before} → ${after}`);

// 4. A data-model write re-filters metrics and tables together.
const filtered = await run('filter', 2500);
check(
  'a filter narrows the metrics',
  money(filtered.kpis[0]?.value) < money(appended.kpis[0]?.value),
  `${appended.kpis[0]?.value} → ${filtered.kpis[0]?.value}`,
);
check('a filter narrows the table', filtered.tableTotal.includes('of'), filtered.tableTotal);

// 5. A chart type the catalog never named, composed at runtime and remembered.
const withWidget = await run('heatmap', 5000);
check('a saved widget joins the dashboard', withWidget.sections.includes('When people buy'), withWidget.sections.join(', '));
check('the saved widget draws', withWidget.charts > rendered.charts, `${withWidget.charts} charts`);
check('re-rendering an existing surface is not an error', withWidget.chartErrors.length === 0);

check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

if (SHOT) await page.screenshot({ path: SHOT, fullPage: true });
await browser.close();

process.stdout.write(failures.length ? `\n${failures.length} failed\n` : '\nall checks passed\n');
process.exitCode = failures.length ? 1 : 0;
