/** Ambient wiring the catalog components need: the gateway, and the host theme. */
import { createContext, useContext, useEffect, useState } from 'react';
import type { Gateway, DatasetState } from '../mcp/gateway.ts';

export const GatewayContext = createContext<Gateway | null>(null);
export const DarkContext = createContext(false);

export function useGateway(): Gateway | null {
  return useContext(GatewayContext);
}

export function useIsDark(): boolean {
  return useContext(DarkContext);
}

/** Re-render when a dataset's load state or row count changes. */
export function useDatasetState(datasetId: string): DatasetState {
  const gateway = useGateway();
  const [state, setState] = useState<DatasetState>(() =>
    gateway ? gateway.datasetState(datasetId) : { rowCount: 0, updatedAt: '', columns: [], loading: false },
  );

  useEffect(() => {
    if (!gateway) return;
    setState(gateway.datasetState(datasetId));
    return gateway.subscribe(() => setState(gateway.datasetState(datasetId)));
  }, [gateway, datasetId]);

  return state;
}
