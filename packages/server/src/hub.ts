/**
 * The push side of the server.
 *
 * MCP gives a server no way to reach a running view: it answers the host, and
 * the host talks to the view. So the view opens a connection here instead —
 * directly, declared in the app resource's `csp.connectDomains` — and this
 * Durable Object holds it open and writes a line down it whenever a dataset
 * changes.
 *
 * What travels is a *notification*, not the data: `{datasetId, updatedAt,
 * rowCount}`. The rows still come back through the host's tool proxy, where a
 * host can see and gate them. That keeps MCP Apps' auditability while removing
 * the reason to poll — the view now fetches when something happened, and stays
 * silent when nothing did.
 */
/// <reference types="@cloudflare/workers-types" />

export interface DatasetChange {
  datasetId: string;
  updatedAt: string;
  rowCount: number;
}

/** One connected view. */
interface Subscriber {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  datasetId: string | null;
}

const encoder = new TextEncoder();

export class DatasetHub implements DurableObject {
  private readonly subscribers = new Set<Subscriber>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/subscribe') return this.subscribe(url.searchParams.get('dataset'));
    if (url.pathname === '/broadcast') return this.broadcast(await request.json());
    if (url.pathname === '/count') {
      return Response.json({ subscribers: this.subscribers.size });
    }
    return new Response('not found', { status: 404 });
  }

  /** Hold a server-sent-events stream open for one view. */
  private subscribe(datasetId: string | null): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const subscriber: Subscriber = { writer: writable.getWriter(), datasetId };
    this.subscribers.add(subscriber);

    // Say hello immediately: a stream that sends nothing for a minute looks
    // indistinguishable from one that failed to connect.
    void this.send(subscriber, 'ready', { subscribers: this.subscribers.size });

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Proxies that buffer would defeat the point.
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      },
    });
  }

  /** Tell every interested view that a dataset moved. */
  private async broadcast(change: DatasetChange): Promise<Response> {
    const targets = [...this.subscribers].filter(
      subscriber => !subscriber.datasetId || subscriber.datasetId === change.datasetId,
    );
    await Promise.all(targets.map(subscriber => this.send(subscriber, 'dataset-changed', change)));
    return Response.json({ delivered: targets.length });
  }

  private async send(subscriber: Subscriber, event: string, data: unknown): Promise<void> {
    try {
      await subscriber.writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      // The view navigated away or the host tore the iframe down.
      this.subscribers.delete(subscriber);
      try {
        await subscriber.writer.close();
      } catch {
        // Already gone.
      }
    }
  }
}

/** Everything shares one hub instance; the fan-out here is small. */
export function hubFor(namespace: DurableObjectNamespace): DurableObjectStub {
  return namespace.get(namespace.idFromName('datasets'));
}
