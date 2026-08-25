/**
 * The view's state machine: A2UI messages in, surfaces out.
 *
 * One processor holds the surfaces, one gateway holds the connection, and a
 * tool result is nothing more than a batch of A2UI messages to feed the first
 * and a list of datasets to hand the second.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageProcessor } from '@a2ui/web_core/v0_9';
import type { SurfaceModel } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/react/v0_9';
import { vegaDashboardCatalog } from './a2ui/catalog.ts';
import {
  A2UI_META,
  DATASETS_META,
  DISPLAY_META,
  Gateway,
  readResult,
  type CallTool,
  type ToolResult,
} from './mcp/gateway.ts';

/**
 * Asking for a dashboard twice is normal — "now add a heatmap" is a second
 * `render_dashboard`. A2UI refuses to create a surface that already exists, so a
 * repeat render is turned into a replacement: delete, then create.
 */
function replaceExistingSurfaces(messages: unknown[], processor: { model: { surfacesMap: ReadonlyMap<string, unknown> } }): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    const create = (message as { createSurface?: { surfaceId?: string } }).createSurface;
    if (create?.surfaceId && processor.model.surfacesMap.has(create.surfaceId)) {
      out.push({
        version: (message as { version: string }).version,
        deleteSurface: { surfaceId: create.surfaceId },
      });
    }
    out.push(message);
  }
  return out;
}

/** What a dashboard tool returns: messages to render, datasets to fetch. */
interface DashboardPayload {
  a2ui?: unknown[];
  datasets?: Array<{ id: string }>;
}

export interface DashboardState {
  surfaces: SurfaceModel<never>[];
  gateway: Gateway | null;
  /** Feed a tool result — from a host notification or a direct call. */
  applyToolResult: (result: ToolResult) => void;
  error: string | null;
  /** How much room this surface wants. Null until something has been rendered. */
  display: DisplayMode | null;
}

export type DisplayMode = 'inline' | 'fullscreen' | 'pip';

/**
 * How much room a surface deserves.
 *
 * A single chart someone asked for in passing belongs in the conversation. A
 * dashboard — several sections, a grid, a table — is a workspace, and squeezing
 * it into the width of a chat message helps nobody. So the view measures what it
 * was given and asks the host accordingly; the agent can override with
 * `display`, and the host is free to refuse either way.
 */
function measureDisplay(components: unknown[]): DisplayMode {
  let sections = 0;
  let gridChildren = 0;
  for (const component of components) {
    const name = (component as { component?: string }).component;
    if (name === 'Section') sections++;
    if (name === 'DashboardGrid') {
      gridChildren += ((component as { children?: unknown[] }).children ?? []).length;
    }
  }
  return sections >= 2 || gridChildren >= 3 || components.length >= 8 ? 'fullscreen' : 'inline';
}

export function useDashboard(
  callTool: CallTool | null,
  forwardAction: (name: string, context: Record<string, unknown>) => void,
): DashboardState {
  // The action handler is fixed at construction, so route it through a ref that
  // the caller can update as the connection comes and goes.
  const forward = useRef(forwardAction);
  forward.current = forwardAction;

  const [processor] = useState(
    () =>
      new MessageProcessor([vegaDashboardCatalog, basicCatalog] as never, action => {
        forward.current(action.name, (action.context ?? {}) as Record<string, unknown>);
      }),
  );

  const gateway = useMemo(
    () => (callTool ? new Gateway(processor as never, callTool, (...args) => forward.current(...args)) : null),
    [processor, callTool],
  );

  const [surfaces, setSurfaces] = useState<SurfaceModel<never>[]>(() => [
    ...(processor.model.surfacesMap.values() as Iterable<SurfaceModel<never>>),
  ]);
  const [error, setError] = useState<string | null>(null);
  const [display, setDisplay] = useState<DisplayMode | null>(null);

  useEffect(() => {
    const sync = () => setSurfaces([...(processor.model.surfacesMap.values() as Iterable<SurfaceModel<never>>)]);
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    return () => {
      created.unsubscribe();
      deleted.unsubscribe();
    };
  }, [processor]);

  const applyToolResult = useCallback(
    (result: ToolResult) => {
      // Messages travel in `_meta`; `structuredContent` is the fallback for a
      // host that does not pass it through.
      const meta = result._meta ?? {};
      const payload = readResult(result) as DashboardPayload;
      const messages = (meta[A2UI_META] as unknown[]) ?? payload.a2ui;
      if (!Array.isArray(messages) || messages.length === 0) return;

      try {
        processor.processMessages(replaceExistingSurfaces(messages, processor) as never);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return;
      }

      // Only a full render decides the display mode; a partial update should
      // not yank the panel open because it happened to send two components.
      const created = messages.find(message => 'createSurface' in (message as object));
      const update = messages.find(message => 'updateComponents' in (message as object)) as
        | { updateComponents: { components: unknown[] } }
        | undefined;
      if (created && update) {
        const asked = meta[DISPLAY_META] as DisplayMode | 'auto' | undefined;
        setDisplay(asked && asked !== 'auto' ? asked : measureDisplay(update.updateComponents.components));
      }

      // Rows are deliberately not in the payload — they would land in the
      // model's context on the way here. The view fetches them itself.
      const datasets = (meta[DATASETS_META] as Array<{ id: string }>) ?? payload.datasets ?? [];
      for (const dataset of datasets) {
        void gateway?.loadDataset(dataset.id, { force: true, publish: true });
      }
    },
    [processor, gateway],
  );

  return { surfaces, gateway, applyToolResult, error, display };
}
