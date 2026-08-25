/**
 * VegaChart — the component that makes the catalog open-ended.
 *
 * Everything else here is a fixed widget. This one takes a whole Vega-Lite spec
 * as a property, which means a chart type nobody anticipated — a heatmap, a
 * box plot, a bullet chart, a layered target-versus-actual — needs no change to
 * the catalog, the renderer or the server. The agent composes it at runtime and
 * the host draws it.
 *
 * Rows arrive through a *named* data source, so when the dataset refreshes the
 * view is handed new values rather than being torn down and rebuilt.
 */
import { useEffect, useRef, useState } from 'react';
import embed, { type Result as EmbedResult } from 'vega-embed';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { VegaChartApi, applyFilters, type Filter } from '@mcp-a2ui-vega/catalog';
import { buildSpec, DATA_NAME } from '../vega/spec.ts';
import { useIsDark } from './context.ts';

type Rows = Array<Record<string, unknown>>;

const asRows = (value: unknown): Rows => (Array.isArray(value) ? (value as Rows) : []);

/**
 * A stable identity for a spec, so re-renders that did not change the chart do
 * not re-embed it. Cheap next to the embed it prevents.
 */
const specKey = (spec: unknown) => {
  try {
    return JSON.stringify(spec);
  } catch {
    return String(spec);
  }
};

export const VegaChart = createComponentImplementation(VegaChartApi, ({ props }) => {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EmbedResult | null>(null);
  const dark = useIsDark();
  const [error, setError] = useState<string | null>(null);

  const rows = applyFilters(asRows(props.data), props.filters as Filter[] | undefined);
  const spec = (props.spec ?? {}) as Record<string, unknown>;
  const hasRows = rows.length > 0;
  const key = `${specKey(spec)}|${props.height ?? ''}|${props.accent ?? ''}|${dark}|${hasRows}`;

  // Embed once per spec/theme. Data is pushed separately, below.
  useEffect(() => {
    const element = host.current;
    // Embedding before the rows arrive draws an empty chart and warns about an
    // infinite extent; wait for the data that is already on its way.
    if (!element || !hasRows) return;
    let disposed = false;

    // Seed the view with the rows it already has. Embedding empty and pushing
    // data afterwards means Vega runs once against nothing first, which it
    // reports as an infinite extent on every scale.
    const full = buildSpec(spec, { height: props.height, accent: props.accent as string, dark, rows });
    embed(element, full as never, {
      actions: false,
      renderer: 'canvas',
      tooltip: { theme: dark ? 'dark' : 'light' },
    })
      .then(result => {
        if (disposed) {
          result.finalize();
          return;
        }
        view.current = result;
        setError(null);

        if (props.onSelect) {
          result.view.addEventListener('click', (_event, item) => {
            const datum = item?.datum as Record<string, unknown> | undefined;
            if (!datum) return;
            // Vega adds bookkeeping fields to every datum; the agent only wants
            // the fields that came from the data.
            const clean = Object.fromEntries(Object.entries(datum).filter(([k]) => !k.startsWith('_')));
            (props.onSelect as (context?: unknown) => void)(clean);
          });
        }
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      disposed = true;
      view.current?.finalize();
      view.current = null;
    };
    // `rows` is intentionally absent: data changes are pushed into the live view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Push new rows into the existing view whenever the bound data changes.
  useEffect(() => {
    const result = view.current;
    if (!result) return;
    try {
      result.view.data(DATA_NAME, rows).resize().run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rows]);

  const empty = rows.length === 0;

  return (
    <figure className="chart" style={{ minHeight: (props.height ?? 260) + 8 }}>
      {props.title ? <figcaption className="chart__title">{props.title}</figcaption> : null}
      {props.subtitle ? <p className="chart__subtitle">{props.subtitle}</p> : null}
      <div ref={host} className="chart__canvas" hidden={Boolean(error) || empty} />
      {error ? (
        <p className="chart__error" role="alert">
          This chart could not be drawn: {error}
        </p>
      ) : null}
      {!error && empty ? <p className="chart__empty">{props.emptyText ?? 'No rows match the current filters.'}</p> : null}
    </figure>
  );
});
