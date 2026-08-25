/**
 * The renderer's half of the catalog contract: a React implementation for every
 * component API the shared package declares, assembled into an A2UI Catalog.
 *
 * The assertion at the bottom is the contract check. If someone adds a
 * component to the API package and forgets to draw it here, the app fails at
 * startup with a useful message rather than silently rendering a blank box the
 * first time an agent asks for it.
 */
import { Catalog } from '@a2ui/web_core/v0_9';
import { basicCatalog, type ReactComponentImplementation } from '@a2ui/react/v0_9';
import { CATALOG_ID, catalogFunctions, componentApis } from '@mcp-a2ui-vega/catalog';
import { VegaChart } from './VegaChart.tsx';
import { KpiTile } from './KpiTile.tsx';
import { DataTable } from './DataTable.tsx';
import { CsvDropZone, AppendRowForm } from './intake.tsx';
import { DatasetStatus } from './DatasetStatus.tsx';
import { DashboardGrid, Section } from './layout.tsx';

const implementations: ReactComponentImplementation[] = [
  VegaChart,
  KpiTile,
  DataTable,
  CsvDropZone,
  AppendRowForm,
  DatasetStatus,
  DashboardGrid,
  Section,
];

const drawn = new Set(implementations.map(impl => impl.name));
const missing = componentApis.map(api => api.name).filter(name => !drawn.has(name));
if (missing.length > 0) {
  throw new Error(`Catalog declares components with no renderer implementation: ${missing.join(', ')}`);
}

/**
 * One catalog, not two.
 *
 * A surface names a single catalog, and every component on it resolves against
 * that catalog unless it overrides `catalogId`. A dashboard is a Column of our
 * widgets, so if this catalog held only our widgets the very first component
 * would fail to resolve. Extending the basic catalog rather than sitting beside
 * it means the agent has one id to name and every layout and input component
 * A2UI ships is available inside it.
 */
export const vegaDashboardCatalog = new Catalog(
  CATALOG_ID,
  [...(basicCatalog.components.values() as Iterable<ReactComponentImplementation>), ...implementations],
  [...basicCatalog.functions.values(), ...catalogFunctions],
);
