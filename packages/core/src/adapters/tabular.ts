import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { Row, SchemaDescription } from '../types.ts';
import { quoteIdent, safeIdent } from './common.ts';
import { SqliteAdapter } from './sqlite.ts';

/** One sheet (or CSV file) as read from the source. */
export interface Sheet {
  /** Sheet or file name in the source. */
  source: string;
  headers: string[];
  /** Values by header position. */
  rows: unknown[][];
  /** Where each row sits in the sheet (1-based), for writing the copy. */
  rowNumbers?: number[];
}

export interface TableShape {
  source: string;
  /** retrofit column -> header in the source. Columns retrofit added are not in here. */
  headers: Map<string, string>;
  pk: string;
  /** No column could serve as a key, so rows are keyed by their position in the sheet. */
  byPosition: boolean;
}

/** retrofit's own edits, replayed over the owner's latest data every time the source is read. */
interface Changes {
  updates: Record<string, Record<string, Row>>;
  inserts: Record<string, Row[]>;
}

/** Column retrofit adds when a sheet has nothing that can serve as a key. */
export const ROW_KEY = 'row_no';

/**
 * Spreadsheet-like sources (CSV folders, Excel workbooks, Google Sheets) are read into an in-memory SQLite
 * database so the rest of retrofit, and the agents, can use SQL. Headers such as "Due Date" or "Invoice #"
 * become Due_Date and Invoice_no. The owner's files are never changed: write-backs and new rows are kept in
 * a changes file, replayed over the latest data each time the source is re-read (so a fresh export or an
 * edited sheet is picked up), and written into a copy next to the source.
 */
export abstract class TabularAdapter extends SqliteAdapter {
  protected shapes = new Map<string, TableShape>();
  private changes: Changes;
  private loading?: Promise<void>;
  private loadedVersion = '';

  constructor(
    location: string,
    private readonly changesFile: string,
  ) {
    super(location, new Database(':memory:'));
    this.changes = readChanges(changesFile);
  }

  /** The sheets as they are now. */
  protected abstract readSheets(): Promise<Sheet[]>;
  /** Changes whenever the source may have changed. */
  protected abstract version(): Promise<string>;
  /** Writes the owner's copy with retrofit's changes applied. */
  protected abstract writeCopy(tables: string[]): Promise<void>;

  protected ready(): Promise<void> {
    return (this.loading ??= this.load());
  }

  async refresh(): Promise<void> {
    await this.ready();
    if ((await this.version()) !== this.loadedVersion) await (this.loading = this.load());
  }

  private async load(): Promise<void> {
    const version = await this.version();
    const sheets = await this.readSheets();
    const db = new Database(':memory:');
    const shapes = new Map<string, TableShape>();
    for (const sheet of sheets) {
      const names = uniqueNames(sheet.headers.map((h, i) => safeIdent(h, `column_${i + 1}`)));
      if (!names.length) continue;
      const table = uniqueName(safeIdent(sheet.source, 'sheet'), shapes);
      const rows = sheet.rows.filter((r) => r.some((v) => v !== '' && v != null));
      const types = names.map((_, i) => inferType(rows.map((r) => r[i])));
      const keyIndex = pickKey(names, rows);
      const pk = keyIndex >= 0 ? names[keyIndex]! : ROW_KEY;
      const cols = names.map((n, i) => `${quoteIdent(n)} ${types[i]}${i === keyIndex ? ' PRIMARY KEY' : ''}`);
      if (keyIndex < 0) cols.unshift(`${quoteIdent(ROW_KEY)} INTEGER PRIMARY KEY`);
      db.exec(`CREATE TABLE ${quoteIdent(table)} (${cols.join(', ')})`);
      const all = keyIndex < 0 ? [ROW_KEY, ...names] : names;
      const ins = db.prepare(
        `INSERT INTO ${quoteIdent(table)} (${all.map(quoteIdent).join(', ')}) VALUES (${all.map(() => '?').join(', ')})`,
      );
      const positions = sheet.rowNumbers ?? sheet.rows.map((_, i) => i + 2);
      db.transaction(() => {
        sheet.rows.forEach((r, i) => {
          if (!r.some((v) => v !== '' && v != null)) return;
          const values = names.map((_, j) => coerce(r[j], types[j]!));
          ins.run(...((keyIndex < 0 ? [positions[i], ...values] : values) as any[]));
        });
      })();
      shapes.set(table, {
        source: sheet.source,
        headers: new Map(names.map((n, i) => [n, sheet.headers[i]!])),
        pk,
        byPosition: keyIndex < 0,
      });
    }
    // Replay retrofit's own changes over the latest data. A row the owner has since added themselves wins.
    for (const [table, rows] of Object.entries(this.changes.inserts)) {
      const shape = shapes.get(table);
      if (!shape) continue;
      for (const row of rows) {
        const key = row[shape.pk];
        const exists =
          key != null &&
          db
            .prepare(`SELECT 1 FROM ${quoteIdent(table)} WHERE CAST(${quoteIdent(shape.pk)} AS TEXT) = ?`)
            .get(String(key));
        if (exists) continue;
        addColumns(db, table, Object.keys(row));
        insertRow(db, table, row);
      }
    }
    for (const [table, byKey] of Object.entries(this.changes.updates)) {
      const shape = shapes.get(table);
      if (!shape) continue;
      for (const [key, patch] of Object.entries(byKey)) {
        addColumns(db, table, Object.keys(patch));
        updateRow(db, table, shape.pk, key, patch);
      }
    }
    const old = this.rw;
    this.rw = this.ro = db;
    this.shapes = shapes;
    this.loadedVersion = version;
    if (old !== db) old.close();
  }

  override async introspect(sampleRows?: number): Promise<SchemaDescription> {
    await this.ready();
    return super.introspect(sampleRows);
  }

  override async select(sql: string, params?: unknown[]): Promise<Row[]> {
    await this.ready();
    return super.select(sql, params);
  }

  override async readTable(table: string, where?: { column: string; in: unknown[] }): Promise<Row[]> {
    await this.ready();
    return super.readTable(table, where);
  }

  override async update(table: string, pkColumn: string, pk: unknown, patch: Row): Promise<void> {
    await this.ready();
    addColumns(this.rw, table, Object.keys(patch));
    updateRow(this.rw, table, pkColumn, String(pk), patch);
    const byKey = (this.changes.updates[table] ??= {});
    byKey[String(pk)] = { ...byKey[String(pk)], ...patch };
    this.saveChanges();
    await this.writeCopy([table]);
  }

  override async insert(table: string, pkColumn: string, row: Row): Promise<Row> {
    await this.ready();
    addColumns(this.rw, table, Object.keys(row));
    const stored = await super.insert(table, pkColumn, row);
    (this.changes.inserts[table] ??= []).push(stored);
    this.saveChanges();
    await this.writeCopy([table]);
    return stored;
  }

  /** Tables retrofit has changed, with every row as retrofit sees it now. */
  protected changedTables(tables?: string[]) {
    const names = new Set([...Object.keys(this.changes.updates), ...Object.keys(this.changes.inserts)]);
    return [...names]
      .filter((t) => this.shapes.has(t) && (!tables || tables.includes(t)))
      .map((t) => ({
        table: t,
        shape: this.shapes.get(t)!,
        rows: this.rw.prepare(`SELECT * FROM ${quoteIdent(t)}`).all() as Row[],
        updates: this.changes.updates[t] ?? {},
        inserts: this.changes.inserts[t] ?? [],
      }));
  }

  private saveChanges() {
    fs.writeFileSync(this.changesFile, JSON.stringify(this.changes, null, 2));
  }
}

function readChanges(file: string): Changes {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { updates: c.updates ?? {}, inserts: c.inserts ?? {} };
  } catch {
    return { updates: {}, inserts: {} };
  }
}

function addColumns(db: Database.Database, table: string, keys: string[]) {
  const have = new Set(
    (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  for (const k of keys)
    if (!have.has(k)) db.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(k)} TEXT`);
}

function insertRow(db: Database.Database, table: string, row: Row) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
  ).run(...(keys.map((k) => row[k]) as any[]));
}

function updateRow(db: Database.Database, table: string, pkColumn: string, key: string, patch: Row) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(
    `UPDATE ${quoteIdent(table)} SET ${keys.map((k) => `${quoteIdent(k)} = ?`).join(', ')} WHERE CAST(${quoteIdent(pkColumn)} AS TEXT) = ?`,
  ).run(...(keys.map((k) => patch[k]) as any[]), key);
}

function uniqueNames(names: string[]) {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const count = (seen.get(k) ?? 0) + 1;
    seen.set(k, count);
    return count === 1 ? n : `${n}_${count}`;
  });
}

function uniqueName(name: string, taken: Map<string, unknown>) {
  let n = name;
  for (let i = 2; [...taken.keys()].some((t) => t.toLowerCase() === n.toLowerCase()); i++) n = `${name}_${i}`;
  return n;
}

/** The column that identifies a row: "id", else a unique "..._id", "..._no", "number", "reference" or "code". */
function pickKey(names: string[], rows: unknown[][]) {
  const unique = (i: number) => {
    const vs = rows.map((r) => r[i]);
    return vs.every((v) => v !== '' && v != null) && new Set(vs.map(String)).size === vs.length;
  };
  const lower = names.map((n) => n.toLowerCase());
  const id = lower.indexOf('id');
  if (id >= 0 && unique(id)) return id;
  return lower.findIndex((n, i) => /(^|_)(id|no|num|number|ref|reference|code|key)$/.test(n) && unique(i));
}

export function inferType(values: unknown[]): 'INTEGER' | 'REAL' | 'TEXT' {
  const vs = values.filter((v) => v !== '' && v != null).map(String);
  if (vs.length === 0) return 'TEXT';
  if (vs.every((v) => /^-?\d+$/.test(v) && v.length < 16 && !/^0\d/.test(v))) return 'INTEGER';
  if (vs.every((v) => /^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v))) return 'REAL';
  return 'TEXT';
}

function coerce(v: unknown, t: string): unknown {
  if (v === '' || v == null) return null;
  if (t === 'INTEGER') return Number.parseInt(String(v), 10);
  if (t === 'REAL') return Number.parseFloat(String(v));
  return String(v);
}
