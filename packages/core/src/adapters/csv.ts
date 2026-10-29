import Database from 'better-sqlite3';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import fs from 'node:fs';
import path from 'node:path';
import type { Row } from '../types.ts';
import { quoteIdent } from './common.ts';
import { SqliteAdapter } from './sqlite.ts';

/**
 * A folder of CSV files, one per table. Files are loaded into an in-memory SQLite database so the rest
 * of retrofit (and the agents) can use SQL. Write-backs never touch the original files: they are written
 * to `<table>.retrofit.csv` next to the source.
 */
export class CsvAdapter extends SqliteAdapter {
  override readonly kind = 'csv' as const;
  private files = new Map<string, string>();

  constructor(readonly folder: string) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
      throw new Error(`CSV folder not found: ${folder}`);
    const db = new Database(':memory:');
    super(folder, db);
    for (const f of fs.readdirSync(folder)) {
      if (!f.endsWith('.csv') || f.endsWith('.retrofit.csv')) continue;
      const table = path.basename(f, '.csv').replace(/[^A-Za-z0-9_]/g, '_');
      const sidecar = path.join(folder, `${path.basename(f, '.csv')}.retrofit.csv`);
      const src = fs.existsSync(sidecar) ? sidecar : path.join(folder, f);
      const records = parse(fs.readFileSync(src), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
      }) as Row[];
      const header = Object.keys(records[0] ?? {});
      if (header.length === 0) continue;
      const types = header.map((h) => inferType(records.map((r) => r[h])));
      const pk = header.includes('id') ? 'id' : null;
      db.exec(
        `CREATE TABLE ${quoteIdent(table)} (${header
          .map((h, i) => `${quoteIdent(h)} ${types[i]}${h === pk ? ' PRIMARY KEY' : ''}`)
          .join(', ')})`,
      );
      const ins = db.prepare(`INSERT INTO ${quoteIdent(table)} VALUES (${header.map(() => '?').join(',')})`);
      db.transaction(() => {
        for (const r of records) ins.run(...header.map((h, i) => coerce(r[h], types[i]!)));
      })();
      this.files.set(table, path.join(folder, `${path.basename(f, '.csv')}.retrofit.csv`));
    }
  }

  override async update(table: string, pkColumn: string, pk: unknown, patch: Row): Promise<void> {
    for (const k of Object.keys(patch)) {
      const cols = this.rw.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{
        name: string;
      }>;
      if (!cols.some((c) => c.name === k))
        this.rw.exec(`ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(k)} TEXT`);
    }
    await super.update(table, pkColumn, pk, patch);
    const out = this.files.get(table);
    if (out) {
      const rows = this.rw.prepare(`SELECT * FROM ${quoteIdent(table)}`).all() as Row[];
      fs.writeFileSync(out, stringify(rows, { header: true }));
    }
  }
}

function inferType(values: unknown[]): 'INTEGER' | 'REAL' | 'TEXT' {
  const vs = values.filter((v) => v !== '' && v != null).map(String);
  if (vs.length === 0) return 'TEXT';
  if (vs.every((v) => /^-?\d+$/.test(v))) return 'INTEGER';
  if (vs.every((v) => /^-?\d+(\.\d+)?$/.test(v))) return 'REAL';
  return 'TEXT';
}

function coerce(v: unknown, t: string): unknown {
  if (v === '' || v == null) return null;
  if (t === 'INTEGER') return Number.parseInt(String(v), 10);
  if (t === 'REAL') return Number.parseFloat(String(v));
  return String(v);
}
