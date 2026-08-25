/**
 * The `vega-dashboard` A2UI catalog.
 *
 * A catalog is the contract between the agent and the renderer: the agent may
 * only ask for components that appear here, and the renderer promises to draw
 * anything that does. This package holds the half of that contract that both
 * sides need — the component APIs and the functions — with no React and no DOM,
 * so the server can serve the same definitions it validates against.
 */
export const CATALOG_ID = 'https://vpm238.github.io/mcp-a2ui-vega/catalog/v0_1/catalog.json';
export const CATALOG_VERSION = '0.1.0';
export const A2UI_VERSION = 'v0.9' as const;

/** The A2UI basic catalog this one is meant to be used alongside. */
export const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

export * from './components.js';
export * from './functions.js';
export * from './theme.js';
export * from './types.js';
export * from './presets.js';
export * from './csv.js';
export * from './data.js';
