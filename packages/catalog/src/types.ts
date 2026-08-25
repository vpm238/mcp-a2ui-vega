/** Shapes shared by the server, the renderer and the tools between them. */

/** A dataset as the server stores and returns it. */
export interface Dataset {
  id: string;
  title: string;
  description?: string;
  columns: string[];
  rows: Record<string, string | number>[];
  rowCount: number;
  updatedAt: string;
  /** Where the data came from — kept so the UI can say so honestly. */
  source?: string;
}

/** The light summary returned by list_datasets and dataset mutations. */
export interface DatasetSummary {
  id: string;
  title: string;
  columns: string[];
  rowCount: number;
  updatedAt: string;
  description?: string;
}

/** Column-level profile the agent uses to pick sensible encodings. */
export interface ColumnProfile {
  name: string;
  type: 'quantitative' | 'temporal' | 'nominal';
  examples: (string | number)[];
  distinctCount: number;
  min?: number | string;
  max?: number | string;
}

/** Tool names, in one place so the renderer and server cannot drift apart. */
export const TOOLS = {
  renderDashboard: 'render_dashboard',
  updateDashboard: 'update_dashboard',
  listDatasets: 'list_datasets',
  describeDataset: 'describe_dataset',
  getDatasetRows: 'get_dataset_rows',
  appendRows: 'append_rows',
  uploadCsv: 'upload_csv',
  resetDataset: 'reset_dataset',
  saveWidget: 'save_widget',
  listWidgets: 'list_widgets',
  getWidget: 'get_widget',
  deleteWidget: 'delete_widget',
} as const;

/**
 * A chart the agent composed once and was asked to remember.
 *
 * The catalog cannot enumerate every chart anyone will ever want, and it does
 * not try: `VegaChart` takes a whole Vega-Lite spec, so a heatmap or a box plot
 * is composed at runtime without anything being added to the catalog. A saved
 * widget is that composition given a name, so the next conversation can ask for
 * it instead of describing it again.
 */
export interface SavedWidget {
  name: string;
  title: string;
  description?: string;
  /** The Vega-Lite spec, without `data`. */
  spec: Record<string, unknown>;
  datasetId?: string;
  filters?: unknown[];
  height?: number;
  accent?: string;
  createdAt: string;
  updatedAt: string;
}

/** The single surface this app renders into. */
export const SURFACE_ID = 'dashboard';

/** Where the renderer keeps dataset rows in the data model. */
export const datasetPath = (id: string) => `/datasets/${id}`;
export const datasetRowsPath = (id: string) => `${datasetPath(id)}/rows`;
