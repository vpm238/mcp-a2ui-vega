/**
 * The reference dashboard.
 *
 * This is what `render_dashboard` sends when the agent does not compose its own
 * layout, and it is also the worked example the skill points at: every pattern
 * the catalog supports — bound data, reactive filters, in-surface aggregation,
 * a live badge, CSV intake — appears here exactly once.
 *
 * It is deliberately data written in TypeScript rather than a template string:
 * the agent receives the same JSON it would have had to write itself, so
 * "change the sales chart to a line" is a one-component edit, not a re-render.
 */
import { CATALOG_ID, A2UI_VERSION } from './index.js';
import { SURFACE_ID, datasetRowsPath } from './types.js';

/** An A2UI component as it appears on the wire. */
export type A2uiComponent = Record<string, unknown> & { id: string; component: string };

/** One A2UI server-to-client message. */
export type A2uiMessage = Record<string, unknown> & { version: string };

export interface DashboardOptions {
  datasetId: string;
  title?: string;
  /** Today in the dataset's timezone (YYYY-MM-DD) — drives the "today" tile. */
  today: string;
  /** Values for the filter pickers, normally the dataset's distinct values. */
  shows?: string[];
  channels?: string[];
  rowCount?: number;
  updatedAt?: string;
}

const option = (value: string) => ({ label: value, value });

/**
 * The clauses every chart and tile shares, so one pick in a filter moves the
 * whole dashboard. An empty selection means no constraint.
 */
function filterClauses() {
  return [
    { field: 'show', op: 'in' as const, value: { path: '/filters/show' } },
    { field: 'channel', op: 'in' as const, value: { path: '/filters/channel' } },
  ];
}

/** The components of the reference ticket-sales dashboard. */
export function ticketSalesComponents(options: DashboardOptions): A2uiComponent[] {
  const rows = { path: datasetRowsPath(options.datasetId) };
  const where = filterClauses();
  const paid = [...where, { field: 'status', op: 'eq' as const, value: 'paid' }];

  return [
    { id: 'root', component: 'Column', children: ['header', 'kpis', 'filters', 'charts', 'recent', 'intake'] },

    // Header — title on the left, liveness on the right.
    { id: 'header', component: 'Row', justify: 'spaceBetween', align: 'center', children: ['header_text', 'status'] },
    { id: 'header_text', component: 'Text', text: { path: '/meta/title' }, variant: 'h3', weight: 1 },
    {
      id: 'status',
      component: 'DatasetStatus',
      datasetId: options.datasetId,
      refreshSeconds: 10,
      showRefreshButton: true,
    },

    // Metrics. Each one aggregates the live rows, so an appended order moves
    // them without the agent being involved.
    { id: 'kpis', component: 'DashboardGrid', columns: 4, children: ['kpi_gross', 'kpi_today', 'kpi_tickets', 'kpi_price'] },
    {
      id: 'kpi_gross',
      component: 'KpiTile',
      label: 'Gross sales',
      format: 'currency',
      caption: 'All orders in the window',
      value: { call: 'aggregate', args: { rows, op: 'sum', field: 'gross', where: paid } },
    },
    {
      id: 'kpi_today',
      component: 'KpiTile',
      label: 'Sold today',
      format: 'currency',
      accent: 'green',
      caption: 'Since midnight, New York',
      value: {
        call: 'aggregate',
        args: {
          rows,
          op: 'sum',
          field: 'gross',
          where: [...paid, { field: 'ordered_at', op: 'startsWith', value: { path: '/meta/today' } }],
        },
      },
    },
    {
      id: 'kpi_tickets',
      component: 'KpiTile',
      label: 'Tickets sold',
      format: 'number',
      caption: 'Seats across all orders',
      value: { call: 'aggregate', args: { rows, op: 'sum', field: 'quantity', where: paid } },
    },
    {
      id: 'kpi_price',
      component: 'KpiTile',
      label: 'Average ticket',
      format: 'currency',
      caption: 'Mean paid price per seat',
      value: { call: 'aggregate', args: { rows, op: 'avg', field: 'unit_price', where: paid } },
    },

    // Filters. Both pickers write into /filters, which every clause above reads.
    { id: 'filters', component: 'Row', align: 'end', children: ['filter_show', 'filter_channel'] },
    {
      id: 'filter_show',
      component: 'ChoicePicker',
      label: 'Show',
      displayStyle: 'chips',
      value: { path: '/filters/show' },
      options: (options.shows ?? []).map(option),
      weight: 2,
    },
    {
      id: 'filter_channel',
      component: 'ChoicePicker',
      label: 'Channel',
      displayStyle: 'chips',
      value: { path: '/filters/channel' },
      options: (options.channels ?? []).map(option),
      weight: 1,
    },

    // Charts.
    { id: 'charts', component: 'DashboardGrid', columns: 2, children: ['sec_timeline', 'sec_channel', 'sec_show', 'sec_section'] },

    { id: 'sec_timeline', component: 'Section', title: 'Sales over time', subtitle: 'Gross by order date', child: 'chart_timeline' },
    {
      id: 'chart_timeline',
      component: 'VegaChart',
      data: rows,
      filters: paid,
      height: 240,
      spec: {
        mark: { type: 'area', line: true, opacity: 0.22, interpolate: 'monotone' },
        encoding: {
          x: { field: 'ordered_at', type: 'temporal', timeUnit: 'yearmonthdate', title: null },
          y: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: 'Gross' },
          tooltip: [
            { field: 'ordered_at', type: 'temporal', timeUnit: 'yearmonthdate', title: 'Date' },
            { field: 'gross', type: 'quantitative', aggregate: 'sum', format: '$,.0f', title: 'Gross' },
          ],
        },
      },
    },

    { id: 'sec_channel', component: 'Section', title: 'Where the sales come from', subtitle: 'Gross by channel', child: 'chart_channel' },
    {
      id: 'chart_channel',
      component: 'VegaChart',
      data: rows,
      filters: paid,
      height: 240,
      spec: {
        mark: { type: 'bar', cornerRadiusEnd: 3 },
        encoding: {
          y: { field: 'channel', type: 'nominal', sort: '-x', title: null },
          x: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: 'Gross' },
          tooltip: [
            { field: 'channel', type: 'nominal', title: 'Channel' },
            { field: 'gross', type: 'quantitative', aggregate: 'sum', format: '$,.0f', title: 'Gross' },
          ],
        },
      },
    },

    { id: 'sec_show', component: 'Section', title: 'Top shows', subtitle: 'Gross by production', child: 'chart_show' },
    {
      id: 'chart_show',
      component: 'VegaChart',
      data: rows,
      filters: paid,
      height: 260,
      spec: {
        mark: { type: 'bar', cornerRadiusEnd: 3 },
        encoding: {
          y: { field: 'show', type: 'nominal', sort: '-x', title: null },
          x: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: 'Gross' },
          color: { field: 'show', type: 'nominal', legend: null },
          tooltip: [
            { field: 'show', type: 'nominal', title: 'Show' },
            { field: 'gross', type: 'quantitative', aggregate: 'sum', format: '$,.0f', title: 'Gross' },
            { field: 'quantity', type: 'quantitative', aggregate: 'sum', title: 'Seats' },
          ],
        },
      },
    },

    { id: 'sec_section', component: 'Section', title: 'Seating mix', subtitle: 'Gross by section of the house', child: 'chart_section' },
    {
      id: 'chart_section',
      component: 'VegaChart',
      data: rows,
      filters: paid,
      height: 260,
      spec: {
        mark: { type: 'arc', innerRadius: 58, stroke: '#fff', strokeWidth: 1 },
        encoding: {
          theta: { field: 'gross', type: 'quantitative', aggregate: 'sum', stack: true },
          color: { field: 'section', type: 'nominal', title: 'Section' },
          tooltip: [
            { field: 'section', type: 'nominal', title: 'Section' },
            { field: 'gross', type: 'quantitative', aggregate: 'sum', format: '$,.0f', title: 'Gross' },
          ],
        },
      },
    },

    // The newest orders, so an append is visible as a row and not only as a
    // nudge in a chart.
    { id: 'recent', component: 'Section', title: 'Latest orders', subtitle: 'Newest first', child: 'table_recent' },
    {
      id: 'table_recent',
      component: 'DataTable',
      rows,
      filters: where,
      sortBy: 'ordered_at',
      sortOrder: 'desc',
      limit: 12,
      dense: true,
      columns: [
        { field: 'ordered_at', label: 'Ordered', format: 'datetime', width: '18ch' },
        { field: 'show', label: 'Show' },
        { field: 'section', label: 'Section', width: '16ch' },
        { field: 'channel', label: 'Channel', width: '13ch' },
        { field: 'quantity', label: 'Seats', format: 'number', align: 'right', width: '7ch' },
        { field: 'gross', label: 'Total', format: 'currency', align: 'right', width: '10ch' },
      ],
    },

    // Getting new data in, from the surface itself.
    { id: 'intake', component: 'Section', title: 'Update the data', subtitle: 'Upload a CSV or add a single order', child: 'intake_row' },
    { id: 'intake_row', component: 'Row', align: 'stretch', children: ['csv_drop', 'append_form'] },
    {
      id: 'csv_drop',
      component: 'CsvDropZone',
      datasetId: options.datasetId,
      mode: 'append',
      label: 'Drop a CSV of orders',
      helpText: 'Same columns as the dataset. Appends by default; drop a full export to replace it.',
      weight: 1,
    },
    {
      id: 'append_form',
      component: 'AppendRowForm',
      datasetId: options.datasetId,
      title: 'Add one order',
      submitLabel: 'Add order',
      weight: 1,
      fields: [
        { field: 'show', label: 'Show', type: 'select', options: { call: 'distinctValues', args: { rows, field: 'show' } }, required: true },
        { field: 'section', label: 'Section', type: 'select', options: { call: 'distinctValues', args: { rows, field: 'section' } } },
        { field: 'channel', label: 'Channel', type: 'select', options: { call: 'distinctValues', args: { rows, field: 'channel' } } },
        { field: 'quantity', label: 'Seats', type: 'number', defaultValue: 2, required: true },
        { field: 'unit_price', label: 'Price per seat', type: 'number', defaultValue: 129, required: true },
      ],
    },
  ];
}

/** The initial data model: metadata, empty filters, and a slot for the rows. */
export function ticketSalesDataModel(options: DashboardOptions) {
  return {
    meta: {
      title: options.title ?? 'Ticket sales',
      today: options.today,
      datasetId: options.datasetId,
      rowCount: options.rowCount ?? 0,
      updatedAt: options.updatedAt ?? '',
    },
    filters: { show: [], channel: [] },
    datasets: {
      [options.datasetId]: { rows: [], rowCount: options.rowCount ?? 0, updatedAt: options.updatedAt ?? '' },
    },
  };
}

/**
 * The full message sequence for the reference dashboard: create the surface,
 * put the components on it, seed the data model. Rows are fetched by the view
 * itself, so they never travel through the model's context.
 */
export function ticketSalesDashboard(options: DashboardOptions): A2uiMessage[] {
  return [
    {
      version: A2UI_VERSION,
      createSurface: { surfaceId: SURFACE_ID, catalogId: CATALOG_ID, sendDataModel: false },
    },
    {
      version: A2UI_VERSION,
      updateComponents: { surfaceId: SURFACE_ID, components: ticketSalesComponents(options) },
    },
    {
      version: A2UI_VERSION,
      updateDataModel: { surfaceId: SURFACE_ID, path: '/', value: ticketSalesDataModel(options) },
    },
  ];
}
