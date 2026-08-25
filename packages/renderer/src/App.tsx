/**
 * The app shell, in two flavours.
 *
 * Hosted: an MCP App inside Claude. The host hands us tool results; we render
 * them and call tools back through the host.
 *
 * Standalone: the same bundle opened directly. It talks to a server if it was
 * given one, and otherwise runs the demo entirely in the tab. This is not a
 * lesser mode — it is how you look at the dashboard without a chat client, and
 * it is what makes the thing reviewable.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { A2uiSurface } from '@a2ui/react/v0_9';
import { useApp, useDocumentTheme, useHostStyles, useAutoResize } from '@modelcontextprotocol/ext-apps/react';
import type { App as McpApp } from '@modelcontextprotocol/ext-apps';
import { TOOLS } from '@mcp-a2ui-vega/catalog';
import { DarkContext, GatewayContext } from './a2ui/context.ts';
import { useDashboard } from './useDashboard.ts';
import { demoToolCaller, httpToolCaller, mcpToolCaller } from './mcp/transports.ts';
import type { CallTool, ToolResult } from './mcp/gateway.ts';

const APP_INFO = { name: 'A2UI Vega Dashboard', version: '0.1.0' };

/** Where the standalone page should look for data, if anywhere. */
function standaloneSource() {
  const params = new URLSearchParams(window.location.search);
  const server = params.get('server') ?? (window as { MCP_SERVER_URL?: string }).MCP_SERVER_URL;
  return {
    server: server ?? null,
    csv: params.get('csv') ?? './demo/ticket_sales.csv',
  };
}

/** Renders whatever surfaces the agent has created, with a first-run message. */
function Surfaces({
  state,
  waiting,
}: {
  state: ReturnType<typeof useDashboard>;
  waiting: string;
}) {
  if (state.error) {
    return (
      <div className="shell__notice shell__notice--error" role="alert">
        <strong>The dashboard could not be rendered.</strong>
        <span>{state.error}</span>
      </div>
    );
  }
  if (state.surfaces.length === 0) {
    return <div className="shell__notice">{waiting}</div>;
  }
  return (
    <>
      {state.surfaces.map(surface => (
        <A2uiSurface key={surface.id} surface={surface as never} />
      ))}
    </>
  );
}

function HostedApp() {
  const rootRef = useRef<HTMLDivElement>(null);

  /*
   * Tool results must be handled from the moment the app connects: the host is
   * free to deliver the result of the tool that opened this view as soon as the
   * handshake finishes. Registering in an effect is too late — the SDK warns
   * about exactly that — so the handler goes on in `onAppCreated`, and points
   * at a ref that later renders keep current.
   */
  const handler = useRef<(result: ToolResult) => void>(() => {});
  const [app, setApp] = useState<McpApp | null>(null);
  const attach = useCallback((created: McpApp) => {
    created.ontoolresult = result => handler.current(result as ToolResult);
    setApp(created);
  }, []);

  const { app: connectedApp, isConnected, error } = useApp({
    appInfo: APP_INFO,
    capabilities: {},
    onAppCreated: attach,
  });

  useHostStyles(connectedApp);
  useAutoResize(connectedApp, rootRef);
  const dark = useDocumentTheme() === 'dark';

  const callTool = useMemo<CallTool | null>(
    () => (connectedApp && isConnected ? mcpToolCaller(connectedApp) : null),
    [connectedApp, isConnected],
  );

  /**
   * An A2UI action is a user intent, so it goes to the agent as a message. The
   * context travels as JSON in the same turn, which is how a click on a bar
   * becomes "drill into this show" without a bespoke channel.
   */
  const forwardAction = useCallback(
    (name: string, context: Record<string, unknown>) => {
      void connectedApp?.sendMessage({
        role: 'user',
        content: [{ type: 'text', text: `Dashboard action: ${name}\n${JSON.stringify(context)}` }],
      });
    },
    [connectedApp],
  );

  const state = useDashboard(callTool, forwardAction);
  handler.current = state.applyToolResult;

  return (
    <DarkContext.Provider value={dark}>
      <GatewayContext.Provider value={state.gateway}>
        <div className="shell" ref={rootRef}>
          {error ? (
            <div className="shell__notice shell__notice--error" role="alert">
              Could not connect to the host: {error.message}
            </div>
          ) : (
            <Surfaces state={state} waiting={isConnected ? 'Waiting for the agent…' : 'Connecting…'} />
          )}
        </div>
      </GatewayContext.Provider>
    </DarkContext.Provider>
  );
}

function StandaloneApp() {
  const source = useMemo(standaloneSource, []);
  const callTool = useMemo<CallTool>(
    () => (source.server ? httpToolCaller(source.server) : demoToolCaller(source.csv)),
    [source.server, source.csv],
  );
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!query) return;
    const listener = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, []);

  const state = useDashboard(callTool, (name, context) =>
    // Nobody is listening in standalone mode, so say so where a developer will
    // see it rather than pretending the action went somewhere.
    console.info('[a2ui action]', name, context),
  );

  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    callTool(TOOLS.renderDashboard, {})
      .then(result => state.applyToolResult(result))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    // Once, on load: this stands in for the agent's first tool call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callTool]);

  return (
    <DarkContext.Provider value={dark}>
      <GatewayContext.Provider value={state.gateway}>
        <div className="shell shell--standalone" data-theme={dark ? 'dark' : 'light'}>
          {error ? (
            <div className="shell__notice shell__notice--error" role="alert">
              {error}
            </div>
          ) : (
            <Surfaces state={state} waiting="Loading the dashboard…" />
          )}
        </div>
      </GatewayContext.Provider>
    </DarkContext.Provider>
  );
}

export function App() {
  // An MCP App is always framed by its host. No frame means nobody is going to
  // send us a tool result, so run the standalone path instead of waiting.
  const hosted = window.parent !== window;
  return hosted ? <HostedApp /> : <StandaloneApp />;
}
