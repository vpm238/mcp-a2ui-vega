/**
 * Turning an agent's Vega-Lite spec into something that looks right in a chat
 * panel.
 *
 * The agent writes the interesting half — marks, encodings, transforms — and
 * this file supplies the half that is the same every time: the host's colours
 * and fonts, sizing that follows the container, and a *named* data source so a
 * refreshed dataset can be pushed into a live view instead of rebuilding it.
 */
import { CATEGORICAL, resolveAccent } from '@mcp-a2ui-vega/catalog';

/** The name every chart's data source gets, so rows can be swapped in place. */
export const DATA_NAME = 'table';

export interface ThemeTokens {
  text: string;
  muted: string;
  grid: string;
  surface: string;
  font: string;
}

/**
 * Read the host's own CSS variables where it provides them (MCP hosts pass a
 * palette down), and fall back to a neutral pair that works in either mode.
 */
export function themeTokens(dark: boolean): ThemeTokens {
  const css = typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : null;
  const read = (name: string, fallback: string) => {
    const value = css?.getPropertyValue(name)?.trim();
    return value ? value : fallback;
  };
  return {
    text: read('--text-primary', dark ? '#e6e8eb' : '#1f2933'),
    muted: read('--text-secondary', dark ? '#9aa4b2' : '#647085'),
    grid: dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
    surface: read('--background-primary', dark ? '#15181d' : '#ffffff'),
    font: read(
      '--font-family',
      'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    ),
  };
}

/** Vega config that makes charts sit quietly inside a chat surface. */
export function vegaConfig(tokens: ThemeTokens, accent?: string) {
  const primary = resolveAccent(accent);
  return {
    background: 'transparent',
    font: tokens.font,
    padding: 4,
    arc: { stroke: tokens.surface, strokeWidth: 1 },
    mark: { color: primary, tooltip: true },
    bar: { color: primary },
    line: { color: primary, strokeWidth: 2 },
    point: { color: primary, filled: true },
    area: { color: primary },
    axis: {
      labelColor: tokens.muted,
      titleColor: tokens.muted,
      labelFont: tokens.font,
      titleFont: tokens.font,
      labelFontSize: 11,
      titleFontSize: 11,
      titleFontWeight: 500,
      titlePadding: 8,
      domainColor: tokens.grid,
      tickColor: tokens.grid,
      gridColor: tokens.grid,
      grid: false,
    },
    axisY: { grid: true, domain: false, ticks: false, labelPadding: 6 },
    axisX: { labelAngle: 0 },
    legend: {
      labelColor: tokens.muted,
      titleColor: tokens.muted,
      labelFont: tokens.font,
      titleFont: tokens.font,
      labelFontSize: 11,
      titleFontSize: 11,
      symbolType: 'circle',
      orient: 'bottom',
      direction: 'horizontal',
      labelLimit: 140,
      symbolLimit: 12,
      columns: 3,
    },
    title: { color: tokens.text, font: tokens.font, fontSize: 13, fontWeight: 600, anchor: 'start' },
    view: { stroke: 'transparent', continuousWidth: 320, continuousHeight: 200 },
    // A single accent means "one series"; the categorical scale takes over the
    // moment a chart encodes colour by a field.
    range: { category: accent ? [primary, ...CATEGORICAL] : CATEGORICAL },
  };
}

/**
 * Collect every field the spec encodes as temporal.
 *
 * Times stay strings in the data model so that prefix filters like "today"
 * keep working, which means Vega has to be told to parse them. Vega-Lite infers
 * this for inline data but not for a named source being pushed rows, so the
 * parse instructions are derived from the spec the agent wrote.
 */
function temporalFields(node: unknown, found = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) temporalFields(item, found);
    return found;
  }
  const record = node as Record<string, unknown>;
  if (record.type === 'temporal' && typeof record.field === 'string') found.add(record.field);
  for (const value of Object.values(record)) temporalFields(value, found);
  return found;
}

export interface BuildSpecOptions {
  height?: number;
  accent?: string;
  dark: boolean;
  /** Rows to embed directly. Omit to use the named source and push rows later. */
  rows?: unknown[];
}

/**
 * Merge an agent-authored spec with the housekeeping it should not have to
 * write. Anything the agent set explicitly wins.
 */
export function buildSpec(userSpec: Record<string, unknown>, options: BuildSpecOptions): Record<string, unknown> {
  const tokens = themeTokens(options.dark);
  const spec: Record<string, unknown> = { ...userSpec };

  // The agent is told not to send `data`; if it does anyway, honour it rather
  // than throwing away a chart that would otherwise render.
  if (!spec.data) {
    const temporal = [...temporalFields(spec)];
    const format = temporal.length
      ? { parse: Object.fromEntries(temporal.map(field => [field, 'date'])) }
      : undefined;
    spec.data = options.rows
      ? { name: DATA_NAME, values: options.rows, ...(format ? { format } : {}) }
      : { name: DATA_NAME, ...(format ? { format } : {}) };
  }

  spec.$schema = spec.$schema ?? 'https://vega.github.io/schema/vega-lite/v6.json';
  spec.background = 'transparent';

  // Faceted, concatenated and repeated specs size their own children; forcing a
  // container width on the outer spec breaks them.
  const isComposite = 'facet' in spec || 'hconcat' in spec || 'vconcat' in spec || 'concat' in spec || 'repeat' in spec;
  if (!isComposite) {
    if (spec.width === undefined) spec.width = 'container';
    if (spec.height === undefined) spec.height = options.height ?? 260;
    spec.autosize = spec.autosize ?? { type: 'fit', contains: 'padding', resize: true };
  }

  const userConfig = (spec.config ?? {}) as Record<string, unknown>;
  const base = vegaConfig(tokens, options.accent);
  spec.config = {
    ...base,
    ...userConfig,
    axis: { ...base.axis, ...((userConfig.axis as object) ?? {}) },
    legend: { ...base.legend, ...((userConfig.legend as object) ?? {}) },
    mark: { ...base.mark, ...((userConfig.mark as object) ?? {}) },
  };

  return spec;
}
