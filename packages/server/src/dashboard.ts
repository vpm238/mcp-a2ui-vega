/**
 * Composing the A2UI messages a dashboard is made of, and refusing to send
 * broken ones.
 *
 * The agent may hand over its own components, ask for the reference layout, or
 * ask for the reference layout plus some widgets it saved earlier. Whichever it
 * is, the components are validated against the catalog before they leave — a
 * mistyped property should come back as a sentence the agent can act on, not as
 * a blank panel in front of the user.
 */
import { BASIC_COMPONENTS } from '@a2ui/web_core/v0_9/basic_catalog';
import { A2uiMessageListSchema } from '@a2ui/web_core/v0_9';
import {
  A2UI_VERSION,
  CATALOG_ID,
  SURFACE_ID,
  componentApis,
  datasetRowsPath,
  ticketSalesComponents,
  ticketSalesDataModel,
  type A2uiComponent,
  type A2uiMessage,
  type SavedWidget,
} from '@mcp-a2ui-vega/catalog';

/** Every component this catalog can draw, by name. */
const API_BY_NAME = new Map(
  [...BASIC_COMPONENTS, ...componentApis].map(api => [api.name, api] as const),
);

export const KNOWN_COMPONENTS = [...API_BY_NAME.keys()];

/**
 * Check components against the catalog's schemas.
 *
 * @returns human-readable problems; empty means the components are renderable
 */
export function validateComponents(components: unknown): string[] {
  if (!Array.isArray(components)) return ['`components` must be an array of A2UI components'];

  const problems: string[] = [];
  const ids = new Set<string>();

  for (const [index, raw] of components.entries()) {
    if (!raw || typeof raw !== 'object') {
      problems.push(`component ${index} is not an object`);
      continue;
    }
    const { id, component, catalogId: _catalogId, ...props } = raw as Record<string, unknown>;

    if (typeof id !== 'string' || id === '') {
      problems.push(`component ${index} needs a string \`id\``);
      continue;
    }
    if (ids.has(id)) problems.push(`duplicate component id "${id}"`);
    ids.add(id);

    if (typeof component !== 'string') {
      problems.push(`"${id}" needs a \`component\` name`);
      continue;
    }
    const api = API_BY_NAME.get(component);
    if (!api) {
      problems.push(`"${id}" uses unknown component "${component}" — this catalog has: ${KNOWN_COMPONENTS.join(', ')}`);
      continue;
    }

    const result = api.schema.safeParse(props);
    if (!result.success) {
      for (const issue of result.error.issues.slice(0, 4)) {
        problems.push(`"${id}" (${component}): ${issue.path.join('.') || '(root)'} — ${issue.message}`);
      }
    }
  }

  // A surface renders from `root` down; anything else is invisible.
  if (components.length > 0 && !ids.has('root')) {
    problems.push('no component with id "root" — a surface renders from `root` down');
  }
  return problems;
}

/** Turn a saved widget into the Section + VegaChart pair that displays it. */
export function widgetComponents(widget: SavedWidget, datasetId: string): A2uiComponent[] {
  const chartId = `chart_${widget.name}`;
  return [
    {
      id: `sec_${widget.name}`,
      component: 'Section',
      title: widget.title,
      ...(widget.description ? { subtitle: widget.description } : {}),
      child: chartId,
    },
    {
      id: chartId,
      component: 'VegaChart',
      data: { path: datasetRowsPath(widget.datasetId ?? datasetId) },
      spec: widget.spec,
      ...(widget.filters ? { filters: widget.filters } : {}),
      ...(widget.height ? { height: widget.height } : {}),
      ...(widget.accent ? { accent: widget.accent } : {}),
    },
  ];
}

export interface ComposeOptions {
  datasetId: string;
  title?: string;
  today: string;
  shows?: string[];
  channels?: string[];
  rowCount?: number;
  updatedAt?: string;
  /** The agent's own layout. When absent, the reference dashboard is used. */
  components?: A2uiComponent[];
  /** Initial data model, merged over the default one. */
  dataModel?: Record<string, unknown>;
  /** Saved widgets to add to the reference layout. */
  widgets?: SavedWidget[];
}

/**
 * The full message sequence for a fresh dashboard: create the surface, put the
 * components on it, seed the data model.
 */
export function composeDashboard(options: ComposeOptions): A2uiMessage[] {
  let components = options.components ?? ticketSalesComponents(options);

  // Saved widgets extend the reference layout by joining its chart grid. A
  // custom layout is left exactly as the agent wrote it.
  if (!options.components && options.widgets?.length) {
    const extra = options.widgets.flatMap(widget => widgetComponents(widget, options.datasetId));
    components = components.map(component =>
      component.id === 'charts'
        ? {
            ...component,
            children: [
              ...((component.children as string[]) ?? []),
              ...options.widgets!.map(widget => `sec_${widget.name}`),
            ],
          }
        : component,
    );
    components = [...components, ...extra];
  }

  const dataModel = {
    ...ticketSalesDataModel(options),
    ...(options.dataModel ?? {}),
  };

  return [
    { version: A2UI_VERSION, createSurface: { surfaceId: SURFACE_ID, catalogId: CATALOG_ID, sendDataModel: false } },
    { version: A2UI_VERSION, updateComponents: { surfaceId: SURFACE_ID, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId: SURFACE_ID, path: '/', value: dataModel } },
  ];
}

/**
 * The messages that rebuild a surface from stored state, with no history
 * needed.
 *
 * A patch is only meaningful to a view that already holds the surface, and
 * whether the view receiving a tool result is that view is the host's business,
 * not ours — some hosts route a second result into the running view, some open
 * a fresh one. So every update also travels with a sequence that stands on its
 * own, and the view picks whichever applies to it.
 */
export function composeRestore(options: {
  components: A2uiComponent[];
  dataModel: Record<string, unknown>;
}): A2uiMessage[] {
  return [
    { version: A2UI_VERSION, createSurface: { surfaceId: SURFACE_ID, catalogId: CATALOG_ID, sendDataModel: false } },
    { version: A2UI_VERSION, updateComponents: { surfaceId: SURFACE_ID, components: options.components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId: SURFACE_ID, path: '/', value: options.dataModel } },
  ];
}

/**
 * Fold changed components into the tree the dashboard is currently made of.
 *
 * An id that exists is replaced in place — keeping its position, so recolouring
 * a tile does not move it to the end — and an id that does not is appended.
 */
export function mergeComponents(existing: unknown[], incoming: A2uiComponent[]): unknown[] {
  const byId = new Map(incoming.map(component => [String((component as { id?: unknown }).id), component]));
  const merged = existing.map(component => {
    const id = String((component as { id?: unknown }).id);
    const replacement = byId.get(id);
    if (!replacement) return component;
    byId.delete(id);
    return replacement;
  });
  return [...merged, ...byId.values()];
}

/**
 * Write a JSON Pointer path into a plain object, creating the objects on the
 * way down. Used to keep the stored data model in step with the writes an
 * update sends, so a rebuilt view shows the same filters as the one on screen.
 */
export function setByPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointer.split('/').filter(Boolean).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.length === 0) {
    if (value && typeof value === 'object') Object.assign(target, value);
    return;
  }
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Messages for changing a dashboard already on screen.
 *
 * This is the whole point of sending components rather than pictures: swapping
 * one chart for another is one `updateComponents` naming one id, and the rest
 * of the surface — including whatever the user had filtered or scrolled to —
 * stays exactly as it was.
 */
export function composeUpdate(options: {
  components?: A2uiComponent[];
  dataModel?: Array<{ path: string; value: unknown }>;
}): A2uiMessage[] {
  const messages: A2uiMessage[] = [];
  if (options.components?.length) {
    messages.push({
      version: A2UI_VERSION,
      updateComponents: { surfaceId: SURFACE_ID, components: options.components },
    });
  }
  for (const update of options.dataModel ?? []) {
    messages.push({
      version: A2UI_VERSION,
      updateDataModel: { surfaceId: SURFACE_ID, path: update.path, value: update.value },
    });
  }
  return messages;
}

/** Final check against A2UI's own message schema before anything is sent. */
export function assertValidMessages(messages: A2uiMessage[]): A2uiMessage[] {
  const result = A2uiMessageListSchema.safeParse(messages);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(
      `composed an invalid A2UI message: ${first?.path.join('.') ?? '(root)'} — ${first?.message ?? 'unknown problem'}`,
    );
  }
  return messages;
}
