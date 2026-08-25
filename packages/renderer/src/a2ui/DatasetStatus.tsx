/**
 * DatasetStatus — how the dashboard proves it is live.
 *
 * With `refreshSeconds` set it re-reads the dataset on a timer, which is what
 * makes an append from anywhere (the CSV drop zone, the agent, a script running
 * in a terminal) show up without anyone asking the dashboard to update.
 */
import { useEffect, useRef } from 'react';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { DatasetStatusApi } from '@mcp-a2ui-vega/catalog';
import { useDatasetState, useGateway } from './context.ts';

/** "just now", "4 min ago" — precise enough for a freshness badge. */
function ago(timestamp: number | undefined): string {
  if (!timestamp) return 'not loaded';
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

export const DatasetStatus = createComponentImplementation(DatasetStatusApi, ({ props }) => {
  const gateway = useGateway();
  const state = useDatasetState(props.datasetId);
  const lastCount = useRef<number | null>(null);
  const interval = Number(props.refreshSeconds ?? 0);

  useEffect(() => {
    if (!gateway || interval <= 0) return;
    const timer = setInterval(() => void gateway.loadDataset(props.datasetId, { force: true }), interval * 1000);
    return () => clearInterval(timer);
  }, [gateway, props.datasetId, interval]);

  // Tell the agent only when the row count actually moved — a poll that found
  // nothing new is not news.
  useEffect(() => {
    if (lastCount.current === null) {
      lastCount.current = state.rowCount;
      return;
    }
    if (state.rowCount !== lastCount.current) {
      const added = state.rowCount - lastCount.current;
      lastCount.current = state.rowCount;
      (props.action as ((ctx?: unknown) => void) | undefined)?.({
        datasetId: props.datasetId,
        rowCount: state.rowCount,
        rowsAdded: added,
      });
    }
  }, [state.rowCount]);

  return (
    <div className={`status${state.loading ? ' status--busy' : ''}`}>
      <span className={`status__dot${interval > 0 ? ' status__dot--live' : ''}`} aria-hidden="true" />
      <span className="status__text">
        {props.label ?? `${state.rowCount.toLocaleString()} rows`}
        <span className="status__meta">
          {state.error ? ` · ${state.error}` : ` · ${state.loading ? 'refreshing…' : ago(state.refreshedAt)}`}
        </span>
      </span>
      {props.showRefreshButton ? (
        <button
          type="button"
          className="status__refresh"
          disabled={state.loading}
          onClick={() => void gateway?.loadDataset(props.datasetId, { force: true })}
        >
          Refresh
        </button>
      ) : null}
    </div>
  );
});
