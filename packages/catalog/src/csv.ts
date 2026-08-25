/**
 * Minimal RFC 4180 CSV reader/writer. The Broadway source data contains quoted
 * fields with embedded commas (e.g. "Harry Potter and the Cursed Child, Parts
 * One and Two"), so a split(',') parser is not good enough.
 */

/** Parse CSV text into an array of row objects keyed by the header row. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  return rows.slice(1).map(cells => {
    const row: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) row[header[i]!] = cells[i] ?? '';
    return row;
  });
}

/** Parse CSV text into an array of string arrays. */
export function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  // Strip a UTF-8 BOM so the first header name stays clean.
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      // Treat \r\n as one terminator; skip a bare \r followed by \n.
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

/** Quote a single CSV field only when it needs it. */
export function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize an array of row objects using `columns` for order. */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const lines = [columns.map(csvCell).join(',')];
  for (const row of rows) lines.push(columns.map(c => csvCell(row[c])).join(','));
  return lines.join('\n') + '\n';
}

/** Serialize rows without a header — for appending to an existing file. */
export function toCsvBody(rows: Array<Record<string, unknown>>, columns: string[]): string {
  return rows.map(row => columns.map(c => csvCell(row[c])).join(',')).join('\n') + '\n';
}
