/**
 * CSV in and out for the console: a pasted/uploaded search result becomes a
 * selection; a finished run becomes a CSV export.
 *
 * Parsing follows RFC 4180 closely enough for search exports: quoted fields,
 * doubled quotes, embedded newlines, CRLF or LF, a header row. A file with no
 * recognisable header (just one column of set numbers or paths) is accepted
 * too, with the column named by what it looks like.
 */

export interface ParsedCsv {
  header: string[];
  records: Record<string, string>[];
}

/** Split CSV text into rows of fields. Handles quotes and embedded newlines. */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  // Drop rows that are entirely empty (trailing newline, blank lines).
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

/** Choose the delimiter by which one splits the first line into the most fields. */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  let best = ',', bestN = 0;
  for (const d of [',', '\t', ';', '|']) {
    const n = first.split(d).length;
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

const KNOWN_HEADERS = new Set(['set', 'set_num', 'setnum', 'path', 'file', 'model', 'pack', 'name', 'src', 'year', 'parts', 'asm', 'sev']);

/**
 * Parse CSV text to records keyed by header. Without a header the single
 * column is named `path` when it looks like a path, otherwise `set`.
 */
export function parseCsv(text: string): ParsedCsv {
  const rows = parseCsvRows(text, detectDelimiter(text));
  if (!rows.length) return { header: [], records: [] };
  const first = rows[0]!.map(h => h.trim());
  const hasHeader = first.some(h => KNOWN_HEADERS.has(h.toLowerCase()));
  let header: string[];
  let body: string[][];
  if (hasHeader) {
    header = first.map(h => h.trim());
    body = rows.slice(1);
  } else {
    const looksLikePath = (v: string) => /[\\/]|\.(io|ldr|mpd|lxf|mcaddon|schem)$/i.test(v.trim());
    header = first.map((v, i) => (i === 0 ? (looksLikePath(v) ? 'path' : 'set') : `col${i + 1}`));
    body = rows;
  }
  const records = body.map(r => {
    const rec: Record<string, string> = {};
    header.forEach((h, i) => { rec[h] = (r[i] ?? '').trim(); });
    return rec;
  });
  return { header, records };
}

/** A plain-text listing (one set number or path per line) as records. */
export function parseTextList(text: string): Record<string, string>[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map((l): Record<string, string> =>
    (/[\\/]|\.(io|ldr|mpd|lxf|mcaddon|schem)$/i.test(l) ? { path: l } : { set: l }));
}

/** Quote a field when it needs it. */
export const csvField = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Serialize records with a fixed column order (missing values are empty). */
export function toCsv(columns: readonly string[], records: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(csvField).join(',')];
  for (const r of records) lines.push(columns.map(c => csvField(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
