#!/usr/bin/env node
/**
 * Emit `dist/catalog.json` — the agent-facing description of this catalog.
 *
 * The zod APIs in `src/` are the single source of truth; A2UI's own capability
 * generator turns them into the JSON-Schema catalog document that the MCP
 * server serves and the skill points at. Nothing here is hand-maintained, so
 * the document cannot drift from what the renderer actually draws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Catalog, MessageProcessor } from '@a2ui/web_core/v0_9';
import { BASIC_COMPONENTS, BASIC_FUNCTIONS } from '@a2ui/web_core/v0_9/basic_catalog';
import { CATALOG_ID, CATALOG_VERSION, componentApis, catalogFunctions } from '../dist/index.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// The document has to describe the catalog the renderer actually registers,
// which extends A2UI's basic catalog rather than sitting beside it — a surface
// resolves every component against one catalog id.
const catalog = new Catalog(
  CATALOG_ID,
  [...BASIC_COMPONENTS, ...componentApis],
  [...BASIC_FUNCTIONS, ...catalogFunctions],
);
const processor = new MessageProcessor([catalog]);
const capabilities = processor.getClientCapabilities({ includeInlineCatalogs: true });

const inlineCatalogs = capabilities['v0.9']?.inlineCatalogs ?? [];
const inline = inlineCatalogs.find(entry => entry.catalogId === CATALOG_ID) ?? inlineCatalogs[0];
if (!inline) throw new Error('A2UI produced no inline catalog — check the component APIs');

const document = {
  ...inline,
  version: CATALOG_VERSION,
  title: 'Vega dashboard catalog',
  description:
    'Charts, metrics, tables and CSV intake for agent-composed dashboards. Use alongside the A2UI basic catalog, which supplies layout and input components.',
  instructions: [
    'Compose a dashboard as one Section per idea, laid out in a DashboardGrid.',
    'Bind data, never inline it: point `data` at a dataset path such as {"path": "/datasets/ticket_sales/rows"} so appended rows appear without re-sending components.',
    'Write plain Vega-Lite v6 in `spec` and leave `data` out of it — the renderer injects the bound rows, themes the chart and sizes it to its container.',
    'Compute in the surface with `aggregate`, `groupRows` and `changeRatio` rather than precomputing numbers that go stale on the next append.',
    'Give every component a stable, meaningful id (kpi_gross, chart_sales_by_day). Changing one part of a dashboard then means re-sending that one component, not the whole surface.',
    'Filter reactively: bind a ChoicePicker to /filters/<name> and give charts a matching `filters` clause. An empty value means no constraint, which is how an "All" option works.',
  ].join(' '),
};

fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'catalog.json'), JSON.stringify(document, null, 2) + '\n');

const components = Object.keys(document.components ?? {});
const functions = (document.functions ?? []).map(fn => fn.name);
process.stdout.write(
  `catalog.json · ${components.length} components (${components.join(', ')})\n` +
    `             · ${functions.length} functions (${functions.join(', ')})\n`,
);
