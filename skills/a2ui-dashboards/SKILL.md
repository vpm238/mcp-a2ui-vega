---
name: a2ui-dashboards
description: Compose and recompose live dashboards through the a2ui-vega-dashboard MCP server — Vega-Lite charts, metrics and tables built from an A2UI catalog. Use when someone asks for a dashboard, a chart, a breakdown, a metric or a data view from a dataset that server holds (ticket sales), when they want an existing dashboard changed ("make that a line chart", "show today in green", "add a heatmap"), or when they want to upload, append to or reset that data.
---

# Dashboards with A2UI and Vega-Lite

This server draws dashboards you compose. You send components; the host renders
them; the user sees a live surface they can filter, upload to and type into. You
are not producing a picture — you are producing a small program's worth of JSON
that stays on screen and keeps updating after you have stopped talking.

## The one rule that matters

**Bind data, never inline it.** Every chart, tile and table points at a path in
the data model:

```json
{ "data": { "path": "/datasets/ticket_sales/rows" } }
```

The view loads the rows itself and refreshes them on a timer. Bound components
follow. If you paste rows into a spec instead, the chart is a snapshot: the next
appended order will not appear in it, and you will have put a dataset through
the conversation for nothing.

## Who updates what

There are two writers to a dashboard, and only one of them is you.

**You** write components. `render_dashboard` and `update_dashboard` are the only
times a dashboard's *structure* changes, and they happen at conversation speed —
when someone asks for something.

**The view** writes data. Once a chart is bound to a dataset path, the view
fetches the rows itself and issues its own `updateDataModel` locally, on a timer.
An A2UI message does not have to come from an agent; the renderer does not care
who produced it. So an order placed thirty seconds ago appears on the dashboard
without you being told, without a tool call, and without a turn.

This is why binding matters so much. A bound dashboard keeps working after the
conversation moves on. An inlined one is a photograph.

You are told about new data only if you asked to be: give `DatasetStatus` an
`action` and it fires when the row count changes. Leave it off unless the user
wants commentary on every sale.

## Dashboards update themselves

Any dashboard you compose is live, because the view polls whatever datasets its
components bind to — you do not have to arrange it. Two things are still worth
doing:

- Include a `DatasetStatus` somewhere. It shows the row count and freshness, so
  the user can see the thing is live rather than having to trust it. It also
  carries the two controls they need: **Refresh** to re-read now, and an
  **Auto** switch to pause and resume polling — theirs to flip, whatever you
  set. Use `refreshSeconds` for the pace (10 for a demo, 60 for something
  long-running, 0 to start paused).
- Compute with `aggregate` rather than pasting numbers into `Text`. A tile that
  recomputes stays true; a sentence you wrote goes stale on the next order.

## Getting started

1. `render_dashboard` with no arguments gives the reference ticket-sales
   dashboard — metrics, sales over time, channel and show breakdowns, latest
   orders, CSV intake. Start here unless the user asked for something specific.
2. `describe_dataset` before composing your own charts. It returns column types,
   ranges and distinct values, which is what makes the encodings right first
   time.
3. Read the catalog resource (`a2ui://catalog/vega-dashboard`) when you need the
   full property list for a component.

## Changing a dashboard that is already on screen

Use `update_dashboard` and send **only the components whose ids changed**.
Everything else stays exactly as it is — including the filters the user picked
and where they had scrolled to. Re-rendering the whole surface throws that away
and is almost always the wrong answer to a follow-up.

> "Make the sales one a line chart and show today's sales in green"

```json
{
  "components": [
    {
      "id": "chart_timeline",
      "component": "VegaChart",
      "data": { "path": "/datasets/ticket_sales/rows" },
      "filters": [{ "field": "status", "op": "eq", "value": "paid" }],
      "accent": "green",
      "height": 240,
      "spec": {
        "mark": { "type": "line", "point": true, "interpolate": "monotone" },
        "encoding": {
          "x": { "field": "ordered_at", "type": "temporal", "timeUnit": "yearmonthdate", "title": null },
          "y": { "field": "gross", "type": "quantitative", "aggregate": "sum", "title": "Gross" }
        }
      }
    },
    { "id": "kpi_today", "component": "KpiTile", "accent": "green", "label": "Sold today", "format": "currency",
      "value": { "call": "aggregate", "args": {
        "rows": { "path": "/datasets/ticket_sales/rows" }, "op": "sum", "field": "gross",
        "where": [{ "field": "ordered_at", "op": "startsWith", "value": { "path": "/meta/today" } }] } } }
  ]
}
```

Two components, one call. The ids in the reference dashboard are stable and
descriptive — `kpi_gross`, `kpi_today`, `kpi_tickets`, `kpi_price`,
`chart_timeline`, `chart_channel`, `chart_show`, `chart_section`,
`table_recent`, and the `sec_*` sections that wrap them.

## Inline or full panel

A dashboard opens in the host's larger panel; a single chart stays in the
conversation. The view works this out from what you sent — two or more sections,
a grid of three, or eight components means "workspace" — so you usually do not
have to think about it.

When you do, `render_dashboard` takes `display: "inline" | "fullscreen"`. Use
`inline` for a one-chart answer to a passing question, and `fullscreen` when
someone will actually work in the thing. The host may refuse either; the
dashboard renders regardless.

## Recipes

[`references/recipes.md`](references/recipes.md) has a worked, verified spec for
every shape of question — trend, ranking, share over time, composition, heatmap,
histogram, box plot, computed field, running total, small multiples, scatter with
a trend line. Every one of them was rendered in a browser against this dataset
before being written down. Start from the closest one rather than composing from
nothing.

## Charts the catalog never named

`VegaChart` takes a whole Vega-Lite v6 spec, so the catalog does not limit which
charts exist. Heatmaps, box plots, layered actual-versus-target, faceted small
multiples, bullet charts — compose the spec and it renders. Leave `data` out of
the spec: the renderer injects the bound rows and themes the chart to the host.

When the user likes one, **remember it**:

```
save_widget({ name: "sales_by_hour_heatmap", title: "When people buy",
              description: "Orders by weekday and hour", spec: { … } })
```

Later, `render_dashboard({ widgets: ["sales_by_hour_heatmap"] })` puts it back on
the dashboard, still bound to the live dataset. `list_widgets` shows what has
been saved; `get_widget` returns a spec you can adapt rather than rewrite.

## Computing in the surface

Do not precompute numbers and send them as text — they go stale the moment a row
is added. Use the catalog's functions, which re-evaluate against the live data:

| Function | Use it for |
|---|---|
| `aggregate` | `{rows, op: sum\|avg\|count\|min\|max\|countDistinct, field, where}` — the value of a KpiTile |
| `groupRows` | `{rows, groupBy, field, op, limit}` → `[{key, value}]` for a leaderboard |
| `countRows`, `filterRows` | row counts and subsets |
| `changeRatio` | `{current, previous}` → the ratio a tile's `delta` expects |
| `distinctValues` | fill a select's options from the data |
| `today` | today's date in the dataset's timezone, for "today" filters |

`/meta/today` is already in the data model, so `{"path": "/meta/today"}` is the
simplest way to say today.

## Filters

Filter clauses are `{field, op, value}` where `value` may be a binding. Bind a
`ChoicePicker` to `/filters/<name>` and give charts a matching clause, and one
pick re-filters the whole surface with no round trip to you:

```json
{ "field": "show", "op": "in", "value": { "path": "/filters/show" } }
```

An empty value means no constraint — that is how an "All" option works.
Operators: `eq`, `neq`, `in`, `notIn`, `gt`, `gte`, `lt`, `lte`, `contains`,
`startsWith`, `between`.

You can also set a filter yourself, which is the right way to answer "just show
me Hamilton":

```
update_dashboard({ dataModel: [{ path: "/filters/show", value: ["Hamilton"] }] })
```

## Components

| Component | What it is |
|---|---|
| `VegaChart` | `spec` (Vega-Lite, no `data`), `data`, `filters`, `title`, `height`, `accent`, `onSelect` |
| `KpiTile` | `label`, `value`, `format`, `caption`, `delta`, `deltaLabel`, `accent`, `sparkline` |
| `DataTable` | `rows`, `columns[{field,label,format,align,width}]`, `filters`, `sortBy`, `limit` |
| `DashboardGrid` | `children`, `columns` (1–4) — collapses on a narrow panel |
| `Section` | `title`, `subtitle`, `child`, `trailing` — one per idea, so it can be replaced by id |
| `CsvDropZone` | `datasetId`, `mode` — the user drops a CSV and the dashboard updates |
| `AppendRowForm` | `datasetId`, `fields[]` — add one row from the surface |
| `DatasetStatus` | `datasetId`, `refreshSeconds`, `showRefreshButton`, `showAutoRefreshToggle` — row count, freshness, and the viewer's refresh and pause controls |

Plus A2UI's basic catalog in the same catalog id: `Column`, `Row`, `Card`,
`Text`, `Button`, `TextField`, `ChoicePicker`, `Slider`, `Tabs`, `Divider`,
`List`, `Image`, `Icon`, `Modal`, `CheckBox`, `DateTimeInput`.

Formats: `currency`, `number`, `compact`, `percent`, `date`, `datetime`, `text`.
Accents: `green`, `red`, `blue`, `amber`, `violet`, `teal`, `slate`, `pink`,
`orange`, `cyan`, or any CSS colour.

## Composing your own layout

A surface renders from the component with id `root` downwards. Give every
component a stable, meaningful id so you can change one thing later.

```json
[
  { "id": "root", "component": "Column", "children": ["kpis", "charts"] },
  { "id": "kpis", "component": "DashboardGrid", "columns": 4, "children": ["kpi_gross", "kpi_tickets"] },
  { "id": "charts", "component": "DashboardGrid", "columns": 2, "children": ["sec_daily"] },
  { "id": "sec_daily", "component": "Section", "title": "Daily gross", "child": "chart_daily" },
  { "id": "chart_daily", "component": "VegaChart", "data": { "path": "/datasets/ticket_sales/rows" }, "spec": { … } }
]
```

If a component does not match the catalog, `render_dashboard` refuses and tells
you which property is wrong — fix it and call again rather than shipping a
surface with a hole in it.

## Data in and out

- `upload_csv` — `{csv, mode: "append" | "replace"}`. The user can also drop a
  file on the dashboard itself.
- `append_rows` — `{rows: [{show, section, channel, quantity, unit_price}]}`.
  Order id, timestamp, status and gross are filled in for you.
- `reset_dataset` — back to the dataset the server shipped with.

After any of these the dashboard picks the rows up on its own within about ten
seconds; you do not need to re-render it.

## What not to do

- Do not put rows in a tool argument or a chart spec.
- Do not re-render the whole dashboard to change one chart.
- Do not report a number you calculated yourself as if it were on the dashboard
  — put it in a tile and let it stay true.
- Do not invent component names. The catalog is the list.
