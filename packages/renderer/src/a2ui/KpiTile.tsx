/**
 * KpiTile — one number, said clearly.
 *
 * The value is normally a catalog function call rather than a literal, so the
 * tile recomputes from the live rows. That is what makes "sold today" honest:
 * an order appended a second ago is already in it.
 *
 * The sparkline is drawn by hand rather than by Vega. A tile is a few dozen
 * points with no axes or interaction, and four of them should not cost four
 * chart runtimes.
 */
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { KpiTileApi, formatValue, resolveAccent } from '@mcp-a2ui-vega/catalog';

type Rows = Array<Record<string, unknown>>;

const asRows = (value: unknown): Rows => (Array.isArray(value) ? (value as Rows) : []);

/** Build an SVG polyline path from the bound rows, or null if there is nothing to draw. */
function sparklinePath(rows: Rows, valueField?: string, timeField?: string, width = 120, height = 28) {
  if (rows.length < 2) return null;
  const keys = Object.keys(rows[0] ?? {});
  const vField = valueField ?? keys[1] ?? keys[0];
  const tField = timeField ?? keys[0];
  if (!vField) return null;

  const points = rows
    .map(row => ({ t: row[tField!], v: Number(row[vField]) }))
    .filter(point => Number.isFinite(point.v));
  if (points.length < 2) return null;

  if (tField) points.sort((a, b) => String(a.t).localeCompare(String(b.t)));

  const values = points.map(p => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (points.length - 1);

  return points
    .map((point, i) => {
      const x = (i * step).toFixed(1);
      const y = (height - ((point.v - min) / span) * height).toFixed(1);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
}

export const KpiTile = createComponentImplementation(KpiTileApi, ({ props }) => {
  const accent = resolveAccent(props.accent as string | undefined, 'var(--kpi-default-accent)');
  const delta = typeof props.delta === 'number' ? props.delta : undefined;
  const path = props.sparkline
    ? sparklinePath(asRows(props.sparkline), props.sparklineField, props.sparklineTimeField)
    : null;

  const body = (
    <>
      <span className="kpi__label">{props.label}</span>
      <span className="kpi__value">{formatValue(props.value, props.format)}</span>
      {delta !== undefined ? (
        <span className={`kpi__delta kpi__delta--${delta >= 0 ? 'up' : 'down'}`}>
          {delta >= 0 ? '▲' : '▼'} {formatValue(Math.abs(delta), 'percent')}
          {props.deltaLabel ? <span className="kpi__delta-label"> {props.deltaLabel}</span> : null}
        </span>
      ) : null}
      {path ? (
        <svg className="kpi__spark" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true">
          <path d={path} fill="none" stroke={accent} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      {props.caption ? <span className="kpi__caption">{props.caption}</span> : null}
    </>
  );

  const style = { '--kpi-accent': accent } as React.CSSProperties;

  return props.action ? (
    <button type="button" className="kpi kpi--interactive" style={style} onClick={() => (props.action as () => void)()}>
      {body}
    </button>
  ) : (
    <div className="kpi" style={style}>
      {body}
    </div>
  );
});
