/**
 * The component APIs this catalog offers on top of A2UI's basic catalog.
 *
 * The basic catalog already covers layout and input — Column, Row, Card, Text,
 * Button, TextField, ChoicePicker, Slider, Tabs. What it has no notion of is
 * *data*: charts, metrics, tables, and getting a CSV into the surface. That is
 * everything below.
 *
 * Every property that could reasonably change at runtime is a A2UI dynamic
 * value, so the agent can bind it to the data model and later move it with a
 * single `updateDataModel` instead of re-sending components.
 */
import { z } from 'zod';
import { CommonSchemas } from '@a2ui/web_core/v0_9';

const { DynamicString, DynamicNumber, DynamicBoolean, DynamicValue, ChildList, ComponentId, Action } =
  CommonSchemas;

/**
 * A2UI's per-component common properties. Every catalog is expected to carry
 * them, and the basic catalog does, so ours does too — otherwise `weight` in a
 * Row would silently do nothing for our components but work for A2UI's.
 */
const common = {
  weight: DynamicNumber.optional().describe('Flex weight when this component sits in a Row or Column.'),
  accessibility: CommonSchemas.AccessibilityAttributes.optional(),
};

/** Component property schema: the component's own props plus the common ones. */
const props = <T extends z.ZodRawShape>(shape: T) => z.object({ ...shape, ...common });

/** A value that is either a literal array of records or a binding to one. */
export const RowsSchema = z.union([z.array(z.record(z.string(), z.any())), CommonSchemas.DataBinding]);

/**
 * One filter clause, applied client-side before a chart or table renders.
 * `value` may be bound, so a picker wired to `/filters/show` re-filters every
 * chart on the surface with no round trip to the agent.
 */
export const FilterSchema = z.object({
  field: z.string().describe('Row field to test.'),
  op: z
    .enum(['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'between'])
    .describe('Comparison to apply.'),
  value: DynamicValue.describe(
    'Value to compare against. Use an array for `in`/`notIn`/`between`. A binding makes the filter reactive. An empty string or null disables the clause, which is what makes "All" options work.',
  ),
});

export const FiltersSchema = z.array(FilterSchema);

const ValueFormat = z
  .enum(['currency', 'number', 'compact', 'percent', 'date', 'datetime', 'text'])
  .describe('How to format the value for display.');

/**
 * A Vega-Lite chart bound to rows in the data model.
 *
 * The agent writes an ordinary Vega-Lite spec but leaves `data` out of it: the
 * renderer injects the bound rows, applies the host theme, and sizes the chart
 * to its container. That split is what lets the same chart re-render on an
 * `updateDataModel` without the spec being re-sent.
 */
export const VegaChartApi = {
  name: 'VegaChart',
  schema: props({
    spec: z
      .union([z.record(z.string(), z.any()), CommonSchemas.DataBinding])
      .describe(
        'A Vega-Lite v6 spec WITHOUT a `data` property — mark, encoding, transform, layer, facet, etc. `width` and `height` are managed by the renderer unless you set them.',
      ),
    data: RowsSchema.describe('Rows to plot. Normally a binding such as {"path": "/datasets/ticket_sales/rows"}.'),
    filters: FiltersSchema.optional().describe('Applied to the rows before they reach the spec.'),
    title: DynamicString.optional(),
    subtitle: DynamicString.optional(),
    height: z.number().optional().describe('Chart height in pixels. Defaults to 260.'),
    accent: DynamicString.optional().describe(
      'Overrides the mark colour: a CSS colour, or one of green, red, blue, amber, violet, teal, slate.',
    ),
    onSelect: Action.optional().describe(
      'Fired when a mark is clicked. The clicked datum is merged into the action context.',
    ),
    emptyText: DynamicString.optional(),
  }),
};

/** A single headline number, with an optional delta and sparkline. */
export const KpiTileApi = {
  name: 'KpiTile',
  schema: props({
    label: DynamicString,
    value: DynamicValue.describe('The number itself, usually a function call such as `aggregate`.'),
    format: ValueFormat.optional(),
    caption: DynamicString.optional(),
    delta: DynamicNumber.optional().describe('Change versus the comparison period, as a ratio: 0.12 renders as +12%.'),
    deltaLabel: DynamicString.optional().describe('What the delta is measured against, e.g. "vs last week".'),
    accent: DynamicString.optional().describe(
      'Tile accent colour: a CSS colour, or one of green, red, blue, amber, violet, teal, slate.',
    ),
    sparkline: RowsSchema.optional().describe('Rows for a trend line under the value.'),
    sparklineField: z.string().optional().describe('Numeric field to plot from `sparkline`. Defaults to the second key.'),
    sparklineTimeField: z.string().optional().describe('Time/order field for the sparkline x axis. Defaults to the first key.'),
    action: Action.optional(),
  }),
};

/** A compact, sortable table over the same bound rows. */
export const DataTableApi = {
  name: 'DataTable',
  schema: props({
    rows: RowsSchema,
    columns: z
      .array(
        z.object({
          field: z.string(),
          label: z.string().optional(),
          format: ValueFormat.optional(),
          align: z.enum(['left', 'right', 'center']).optional(),
          width: z.string().optional().describe('CSS width, e.g. "12ch".'),
        }),
      )
      .describe('Columns in display order. Omit to infer from the first row.')
      .optional(),
    filters: FiltersSchema.optional(),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional(),
    limit: DynamicNumber.optional().describe('Maximum rows to show. Defaults to 50.'),
    dense: DynamicBoolean.optional(),
    emptyText: DynamicString.optional(),
    onRowSelect: Action.optional().describe('Fired on row click with the row merged into the action context.'),
  }),
};

/**
 * Drop or pick a CSV to replace or extend a dataset.
 *
 * The renderer performs the upload itself through the MCP host — it holds the
 * tool connection — then refreshes the bound rows. `action` fires afterwards so
 * the agent can react to what arrived.
 */
export const CsvDropZoneApi = {
  name: 'CsvDropZone',
  schema: props({
    datasetId: z.string(),
    mode: z.enum(['append', 'replace']).optional().describe('Defaults to append.'),
    label: DynamicString.optional(),
    helpText: DynamicString.optional(),
    accept: z.string().optional().describe('File input accept attribute. Defaults to ".csv,text/csv".'),
    action: Action.optional().describe('Fired after a successful upload with {datasetId, rowsAdded, totalRows}.'),
  }),
};

/** A small form that appends one row to a dataset. */
export const AppendRowFormApi = {
  name: 'AppendRowForm',
  schema: props({
    datasetId: z.string(),
    fields: z
      .array(
        z.object({
          field: z.string(),
          label: z.string().optional(),
          type: z.enum(['text', 'number', 'date', 'datetime', 'select']).optional(),
          options: CommonSchemas.DynamicStringList.optional().describe(
            'Choices for `select`. Bind or call `distinctValues` to fill these from the data rather than hardcoding them.',
          ),
          placeholder: z.string().optional(),
          defaultValue: DynamicValue.optional(),
          required: z.boolean().optional(),
        }),
      )
      .describe('Fields to collect. Anything the dataset expects and you omit is left blank.'),
    submitLabel: DynamicString.optional(),
    title: DynamicString.optional(),
    action: Action.optional().describe('Fired after the row is stored with {datasetId, row, totalRows}.'),
  }),
};

/**
 * Row count, freshness, and an optional poll — the liveness indicator.
 *
 * With `refreshSeconds` set it re-reads the dataset on a timer and writes the
 * new rows into the data model, so appends made anywhere show up without the
 * agent being asked to do anything.
 */
export const DatasetStatusApi = {
  name: 'DatasetStatus',
  schema: props({
    datasetId: z.string(),
    label: DynamicString.optional(),
    refreshSeconds: z
      .number()
      .optional()
      .describe('Poll interval in seconds. Omitted uses the renderer default of 15; 0 starts paused.'),
    showRefreshButton: DynamicBoolean.optional().describe('Show a button that re-reads the dataset now. Defaults to true.'),
    showAutoRefreshToggle: DynamicBoolean.optional().describe(
      'Show a switch that lets the viewer pause and resume auto-refresh. Defaults to true.',
    ),
    action: Action.optional().describe('Fired after each refresh that changed the row count.'),
  }),
};

/** A responsive grid. Children flow into columns that collapse on narrow hosts. */
export const DashboardGridApi = {
  name: 'DashboardGrid',
  schema: props({
    children: ChildList,
    columns: z.number().min(1).max(4).optional().describe('Target column count. Defaults to 2.'),
    gap: z.number().optional(),
    minColumnWidth: z.number().optional().describe('Pixels below which the grid collapses to one column. Defaults to 320.'),
  }),
};

/** A titled block. Use one per logical group so the agent can replace a group by id. */
export const SectionApi = {
  name: 'Section',
  schema: props({
    title: DynamicString.optional(),
    subtitle: DynamicString.optional(),
    child: ComponentId,
    trailing: ComponentId.optional().describe('A component pinned to the right of the title, e.g. a picker.'),
  }),
};

export const componentApis = [
  VegaChartApi,
  KpiTileApi,
  DataTableApi,
  CsvDropZoneApi,
  AppendRowFormApi,
  DatasetStatusApi,
  DashboardGridApi,
  SectionApi,
];

export type Filter = z.infer<typeof FilterSchema>;
export type Rows = z.infer<typeof RowsSchema>;
