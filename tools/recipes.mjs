/**
 * Chart recipes for the ticket-sales dataset.
 *
 * These exist so an agent composing a dashboard on the fly has a worked example
 * of every *shape* of question — a trend, a ranking, a share, a distribution, a
 * relationship, a running total — rather than having to invent Vega-Lite from
 * first principles each time.
 *
 * They are the single source for two things: `verify-recipes.mjs` renders every
 * one in a browser and fails if any of them does not draw, and the reference
 * page in the skill is generated from the same array *after* that check passes.
 * A recipe in the documentation is therefore a recipe that was seen to work.
 */

const ROWS = { path: '/datasets/ticket_sales/rows' };
const PAID = [{ field: 'status', op: 'eq', value: 'paid' }];

/** @type {Array<{id: string, title: string, when: string, note?: string, spec: object, height?: number, accent?: string}>} */
export const RECIPES = [
  {
    id: 'trend_line',
    title: 'Gross over time',
    when: 'A trend. The default answer to "how are sales doing".',
    spec: {
      mark: { type: 'line', interpolate: 'monotone', point: false },
      encoding: {
        x: { field: 'ordered_at', type: 'temporal', timeUnit: 'yearmonthdate', title: null },
        y: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: 'Gross' },
        tooltip: [
          { field: 'ordered_at', type: 'temporal', timeUnit: 'yearmonthdate', title: 'Date' },
          { field: 'gross', aggregate: 'sum', type: 'quantitative', format: '$,.0f', title: 'Gross' },
        ],
      },
    },
  },
  {
    id: 'trend_weekly_bars',
    title: 'Gross by week',
    when: 'A trend where the individual days are noise. Bars read as "per period" where a line reads as "continuous".',
    spec: {
      mark: { type: 'bar', cornerRadiusEnd: 3 },
      encoding: {
        x: { field: 'ordered_at', type: 'temporal', timeUnit: 'yearweek', title: null },
        y: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: 'Gross' },
      },
    },
  },
  {
    id: 'ranking_bar',
    title: 'Top shows by gross',
    when: 'A ranking. Horizontal bars, sorted — never a pie, and never a vertical bar with rotated labels.',
    spec: {
      mark: { type: 'bar', cornerRadiusEnd: 3 },
      encoding: {
        y: { field: 'show', type: 'nominal', sort: '-x', title: null },
        x: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: 'Gross' },
        color: { field: 'show', type: 'nominal', legend: null },
        tooltip: [
          { field: 'show', type: 'nominal', title: 'Show' },
          { field: 'gross', aggregate: 'sum', type: 'quantitative', format: '$,.0f', title: 'Gross' },
          { field: 'quantity', aggregate: 'sum', type: 'quantitative', title: 'Seats' },
        ],
      },
    },
    height: 280,
  },
  {
    id: 'share_over_time',
    title: 'Channel share over time',
    when: 'How a mix changes. `stack: "normalize"` turns absolute values into a share of each period.',
    spec: {
      mark: { type: 'area', interpolate: 'monotone' },
      encoding: {
        x: { field: 'ordered_at', type: 'temporal', timeUnit: 'yearweek', title: null },
        y: { field: 'gross', type: 'quantitative', aggregate: 'sum', stack: 'normalize', axis: { format: '%' }, title: 'Share' },
        color: { field: 'channel', type: 'nominal', title: 'Channel' },
      },
    },
  },
  {
    id: 'composition_donut',
    title: 'Seating mix',
    when: 'Parts of one whole, and only when there are few enough parts to read — five or six at most.',
    spec: {
      mark: { type: 'arc', innerRadius: 58 },
      encoding: {
        theta: { field: 'gross', type: 'quantitative', aggregate: 'sum', stack: true },
        color: { field: 'section', type: 'nominal', title: 'Section' },
        tooltip: [
          { field: 'section', type: 'nominal', title: 'Section' },
          { field: 'gross', aggregate: 'sum', type: 'quantitative', format: '$,.0f', title: 'Gross' },
        ],
      },
    },
    height: 260,
  },
  {
    id: 'heatmap',
    title: 'When people buy',
    when: 'Two categorical axes and one measure — the shape that finds patterns nothing else shows.',
    note: 'Nothing in the catalog is called a heatmap. It is a `rect` mark, composed at runtime.',
    spec: {
      mark: 'rect',
      encoding: {
        x: { field: 'ordered_at', type: 'ordinal', timeUnit: 'hours', title: 'Hour of day' },
        y: { field: 'ordered_at', type: 'ordinal', timeUnit: 'day', title: null },
        color: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: 'Gross', scale: { scheme: 'blues' } },
      },
    },
  },
  {
    id: 'distribution_histogram',
    title: 'What people pay',
    when: 'The spread of one number. An average hides a bimodal distribution; this does not.',
    spec: {
      mark: { type: 'bar', cornerRadiusEnd: 2 },
      encoding: {
        x: { field: 'unit_price', type: 'quantitative', bin: { maxbins: 40 }, title: 'Price per seat' },
        y: { aggregate: 'count', type: 'quantitative', title: 'Orders' },
      },
    },
  },
  {
    id: 'distribution_boxplot',
    title: 'Price by section',
    when: 'Comparing distributions across categories, rather than comparing their averages.',
    spec: {
      mark: { type: 'boxplot', extent: 'min-max' },
      encoding: {
        y: { field: 'section', type: 'nominal', title: null },
        x: { field: 'unit_price', type: 'quantitative', title: 'Price per seat' },
        color: { field: 'section', type: 'nominal', legend: null },
      },
    },
    height: 260,
  },
  {
    id: 'computed_lead_time',
    title: 'How far ahead people book',
    when: 'A field the data does not have. `transform.calculate` makes one — here, days between the order and the performance.',
    note: 'Vega expressions run in the browser, so no round trip and no new column in the dataset.',
    spec: {
      transform: [
        { calculate: '(toDate(datum.event_date) - toDate(datum.ordered_at)) / 86400000', as: 'lead_days' },
        { filter: 'datum.lead_days >= 0 && datum.lead_days < 120' },
      ],
      mark: { type: 'bar', cornerRadiusEnd: 2 },
      encoding: {
        x: { field: 'lead_days', type: 'quantitative', bin: { maxbins: 30 }, title: 'Days before the performance' },
        y: { aggregate: 'sum', field: 'quantity', type: 'quantitative', title: 'Seats' },
      },
    },
  },
  {
    id: 'running_total',
    title: 'Gross to date',
    when: 'Progress towards a total. A `window` transform accumulates without the server computing anything.',
    spec: {
      transform: [
        { timeUnit: 'yearmonthdate', field: 'ordered_at', as: 'day' },
        { aggregate: [{ op: 'sum', field: 'gross', as: 'daily' }], groupby: ['day'] },
        { sort: [{ field: 'day' }], window: [{ op: 'sum', field: 'daily', as: 'cumulative' }] },
      ],
      mark: { type: 'area', line: true, opacity: 0.2, interpolate: 'monotone' },
      encoding: {
        x: { field: 'day', type: 'temporal', title: null },
        y: { field: 'cumulative', type: 'quantitative', title: 'Cumulative gross' },
      },
    },
  },
  {
    id: 'small_multiples',
    title: 'Each show on its own axis',
    when: 'One pattern per category, where a single chart with ten colours would be unreadable.',
    note: 'A faceted spec sizes its own children — set `width` and `height` inside the spec, not on the component.',
    spec: {
      mark: { type: 'line', interpolate: 'monotone' },
      width: 150,
      height: 70,
      encoding: {
        x: { field: 'ordered_at', type: 'temporal', timeUnit: 'yearweek', title: null, axis: { format: '%b' } },
        y: { field: 'gross', type: 'quantitative', aggregate: 'sum', title: null },
        facet: { field: 'show', type: 'nominal', columns: 3, title: null, header: { labelLimit: 130, labelFontSize: 10 } },
      },
    },
    height: 520,
  },
  {
    id: 'relationship_scatter',
    title: 'Seats against order value',
    when: 'The relationship between two numbers. A `loess` layer shows the trend through the cloud.',
    spec: {
      layer: [
        {
          mark: { type: 'point', filled: true, opacity: 0.25, size: 18 },
          encoding: {
            x: { field: 'quantity', type: 'quantitative', title: 'Seats in the order' },
            y: { field: 'gross', type: 'quantitative', title: 'Order value' },
            color: { field: 'customer_segment', type: 'nominal', title: 'Segment' },
          },
        },
        {
          transform: [{ loess: 'gross', on: 'quantity' }],
          mark: { type: 'line', color: '#1f2933', strokeWidth: 2 },
          encoding: {
            x: { field: 'quantity', type: 'quantitative' },
            y: { field: 'gross', type: 'quantitative' },
          },
        },
      ],
    },
  },
];

/** Turn a recipe into the VegaChart component that renders it. */
export function recipeComponent(recipe) {
  return {
    id: `chart_${recipe.id}`,
    component: 'VegaChart',
    data: ROWS,
    filters: PAID,
    ...(recipe.height ? { height: recipe.height } : {}),
    ...(recipe.accent ? { accent: recipe.accent } : {}),
    spec: recipe.spec,
  };
}

/** A whole dashboard of every recipe — what the verifier renders. */
export function allRecipesDashboard() {
  const components = [
    { id: 'root', component: 'Column', children: ['title', 'grid'] },
    { id: 'title', component: 'Text', text: 'Every recipe', variant: 'h3' },
    {
      id: 'grid',
      component: 'DashboardGrid',
      columns: 2,
      children: RECIPES.map(recipe => `sec_${recipe.id}`),
    },
  ];

  for (const recipe of RECIPES) {
    components.push({
      id: `sec_${recipe.id}`,
      component: 'Section',
      title: recipe.title,
      subtitle: recipe.when,
      child: `chart_${recipe.id}`,
    });
    components.push(recipeComponent(recipe));
  }
  return components;
}

export { ROWS, PAID };
