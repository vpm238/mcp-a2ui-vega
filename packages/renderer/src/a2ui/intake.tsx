/**
 * Getting data in from the surface itself: a CSV drop zone and a one-row form.
 *
 * Both go through the gateway rather than talking to the server directly, so an
 * upload ends the same way an agent-driven change would — new rows in the data
 * model, every bound chart and tile moving on its own.
 */
import { useRef, useState } from 'react';
import { createComponentImplementation } from '@a2ui/react/v0_9';
import { CsvDropZoneApi, AppendRowFormApi } from '@mcp-a2ui-vega/catalog';
import { useGateway } from './context.ts';

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

export const CsvDropZone = createComponentImplementation(CsvDropZoneApi, ({ props }) => {
  const gateway = useGateway();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const mode = (props.mode ?? 'append') as 'append' | 'replace';

  async function ingest(file: File | undefined) {
    if (!file || !gateway) return;
    setStatus({ kind: 'busy' });
    try {
      const text = await file.text();
      const result = await gateway.uploadCsv(props.datasetId, text, mode);
      setStatus({
        kind: 'done',
        message: `${mode === 'replace' ? 'Replaced with' : 'Added'} ${plural(result.rowsAdded, 'row')} · ${plural(
          result.totalRows,
          'row',
        )} total`,
      });
      (props.action as ((ctx?: unknown) => void) | undefined)?.({
        datasetId: props.datasetId,
        mode,
        rowsAdded: result.rowsAdded,
        totalRows: result.totalRows,
        fileName: file.name,
      });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <div
      className={`drop${dragging ? ' drop--over' : ''}`}
      onDragOver={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        void ingest(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={input}
        type="file"
        accept={props.accept ?? '.csv,text/csv'}
        className="drop__input"
        onChange={event => void ingest(event.target.files?.[0])}
      />
      <button type="button" className="drop__button" onClick={() => input.current?.click()} disabled={status.kind === 'busy'}>
        {status.kind === 'busy' ? 'Reading…' : (props.label ?? 'Choose a CSV')}
      </button>
      <p className="drop__hint">
        {props.helpText ?? `Drop a CSV here to ${mode === 'replace' ? 'replace the dataset' : 'add rows'}.`}
      </p>
      {status.kind === 'done' ? <p className="drop__status drop__status--ok">{status.message}</p> : null}
      {status.kind === 'error' ? (
        <p className="drop__status drop__status--error" role="alert">
          {status.message}
        </p>
      ) : null}
    </div>
  );
});

export const AppendRowForm = createComponentImplementation(AppendRowFormApi, ({ props }) => {
  const gateway = useGateway();
  const fields = (props.fields ?? []) as Array<{
    field: string;
    label?: string;
    type?: string;
    options?: string[];
    placeholder?: string;
    defaultValue?: unknown;
    required?: boolean;
  }>;

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map(field => [field.field, field.defaultValue == null ? '' : String(field.defaultValue)])),
  );
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!gateway) return;
    setStatus({ kind: 'busy' });
    try {
      // Blank fields are left out entirely; the server fills what it can.
      const row = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
      const result = await gateway.appendRows(props.datasetId, [row]);
      setStatus({ kind: 'done', message: `Added · ${plural(result.totalRows, 'row')} total` });
      (props.action as ((ctx?: unknown) => void) | undefined)?.({
        datasetId: props.datasetId,
        row,
        totalRows: result.totalRows,
      });
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <form className="rowform" onSubmit={submit}>
      {props.title ? <p className="rowform__title">{props.title}</p> : null}
      <div className="rowform__fields">
        {fields.map(field => {
          const id = `${props.datasetId}-${field.field}`;
          const label = field.label ?? field.field;
          const value = values[field.field] ?? '';
          const onChange = (next: string) => setValues(current => ({ ...current, [field.field]: next }));

          return (
            <label key={field.field} className="rowform__field" htmlFor={id}>
              <span className="rowform__label">{label}</span>
              {field.type === 'select' ? (
                <select id={id} value={value} required={field.required} onChange={event => onChange(event.target.value)}>
                  <option value="">—</option>
                  {(field.options ?? []).map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text'}
                  value={value}
                  placeholder={field.placeholder}
                  required={field.required}
                  step={field.type === 'number' ? 'any' : undefined}
                  onChange={event => onChange(event.target.value)}
                />
              )}
            </label>
          );
        })}
      </div>
      <div className="rowform__actions">
        <button type="submit" className="rowform__submit" disabled={status.kind === 'busy'}>
          {status.kind === 'busy' ? 'Adding…' : (props.submitLabel ?? 'Add row')}
        </button>
        {status.kind === 'done' ? <span className="rowform__status rowform__status--ok">{status.message}</span> : null}
        {status.kind === 'error' ? (
          <span className="rowform__status rowform__status--error" role="alert">
            {status.message}
          </span>
        ) : null}
      </div>
    </form>
  );
});
