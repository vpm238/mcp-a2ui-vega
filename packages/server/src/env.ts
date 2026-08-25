/// <reference types="@cloudflare/workers-types" />

/**
 * The Worker's bindings.
 *
 * There is no model here and no API key: the agent is whichever MCP host is
 * connected, and this server only stores rows and composes A2UI JSON.
 */
export interface Env {
  /** Datasets, their metadata, and saved widgets. */
  DATA: KVNamespace;
  /** Optional: the public origin, used when a resource needs an absolute URL. */
  PUBLIC_ORIGIN?: string;
}
