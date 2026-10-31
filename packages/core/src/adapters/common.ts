import type { Row, SchemaDescription, SourceKind, TableInfo } from '../types.ts';
import { maskEmail } from '../util.ts';

export interface SourceAdapter {
  readonly kind: SourceKind;
  readonly location: string;
  introspect(sampleRows?: number): Promise<SchemaDescription>;
  /** Run a read-only SELECT. Throws on anything else. */
  select(sql: string, params?: unknown[]): Promise<Row[]>;
  /** All rows of a table, optionally where `column IN (values)`. Identifiers must be known columns. */
  readTable(table: string, where?: { column: string; in: unknown[] }): Promise<Row[]>;
  /** Update allowed columns of one row. */
  update(table: string, pkColumn: string, pk: unknown, patch: Row): Promise<void>;
  /** Insert one row and return it as stored. */
  insert(table: string, pkColumn: string, row: Row): Promise<Row>;
  /** Pick up changes made outside retrofit (re-read spreadsheets and exports). Databases need nothing. */
  refresh?(): Promise<void>;
  close(): Promise<void>;
}

const READ_ONLY_RE = /^\s*(select|with)\b/i;
const FORBIDDEN_RE =
  /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|grant|truncate|copy)\b/i;

export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!READ_ONLY_RE.test(trimmed)) throw new Error('Only SELECT/WITH queries are allowed');
  if (trimmed.includes(';')) throw new Error('Only one statement is allowed');
  if (FORBIDDEN_RE.test(trimmed.replace(/'[^']*'/g, "''"))) throw new Error('Query contains a write keyword');
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

/** A column or table name from a spreadsheet header made safe for SQL: "Due Date" -> Due_Date, "Invoice #" -> Invoice_no. */
export function safeIdent(name: string, fallback = 'column'): string {
  const s = String(name ?? '')
    .trim()
    .replace(/#/g, ' no ')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!s) return fallback;
  return /^[0-9]/.test(s) ? `_${s}` : s;
}

const ENUM_NAME_RE = /(status|state|type|kind|stage|category|interval|frequency|currency)$/i;

export function maskSample(row: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    if (/@/.test(v) && /\./.test(v)) out[k] = maskEmail(v);
    else if (/phone|mobile|tel/i.test(k)) out[k] = v.replace(/\d(?=\d{2})/g, '•');
    else if (/addr|street|line1|line2/i.test(k)) out[k] = v.replace(/^\d+/, '##');
    else out[k] = v.length > 60 ? v.slice(0, 57) + '...' : v;
  }
  return out;
}

export function enumCandidates(table: TableInfo, distinct: (column: string) => Promise<string[]>) {
  return Promise.all(
    table.columns
      .filter((c) => ENUM_NAME_RE.test(c.name) && !c.pk)
      .map(async (c) => [c.name, await distinct(c.name)] as const),
  ).then((pairs) => Object.fromEntries(pairs.filter(([, vals]) => vals.length > 0 && vals.length <= 12)));
}

export function normaliseValue(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

export function normaliseRow(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) out[k] = normaliseValue(v);
  return out;
}
