import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { Row, SchemaDescription, SourceKind, TableInfo } from '../types.ts';
import {
  assertReadOnlySql,
  enumCandidates,
  maskSample,
  normaliseRow,
  quoteIdent,
  type SourceAdapter,
} from './common.ts';

export class SqliteAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'sqlite';
  protected rw: Database.Database;
  protected ro: Database.Database;

  constructor(
    readonly location: string,
    db?: Database.Database,
  ) {
    if (db) {
      this.rw = db;
      this.ro = db;
    } else {
      if (!fs.existsSync(location)) throw new Error(`SQLite database not found: ${location}`);
      this.rw = new Database(location);
      this.rw.pragma('busy_timeout = 3000');
      this.ro = new Database(location, { readonly: true, fileMustExist: true });
    }
  }

  async introspect(sampleRows = 5): Promise<SchemaDescription> {
    const tables = this.rw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const out: TableInfo[] = [];
    for (const { name } of tables) {
      const cols = this.rw.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: unknown;
      }>;
      const fks = this.rw.prepare(`PRAGMA foreign_key_list(${quoteIdent(name)})`).all() as Array<{
        from: string;
        table: string;
        to: string | null;
      }>;
      const { n } = this.rw.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`).get() as { n: number };
      const samples = (
        this.rw.prepare(`SELECT * FROM ${quoteIdent(name)} LIMIT ${Math.max(0, sampleRows)}`).all() as Row[]
      ).map((r) => maskSample(normaliseRow(r)));
      const info: TableInfo = {
        name,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type || 'TEXT',
          nullable: !c.notnull && !c.pk,
          pk: c.pk > 0,
          // An INTEGER PRIMARY KEY is filled by SQLite.
          hasDefault: c.dflt_value != null || (c.pk > 0 && /^int/i.test(c.type)),
        })),
        foreignKeys: fks.map((f) => ({ column: f.from, refTable: f.table, refColumn: f.to ?? 'id' })),
        rowCount: n,
        samples,
        enums: {},
      };
      info.enums = await enumCandidates(info, async (col) =>
        (
          this.rw
            .prepare(
              `SELECT DISTINCT ${quoteIdent(col)} AS v FROM ${quoteIdent(name)} WHERE ${quoteIdent(col)} IS NOT NULL LIMIT 13`,
            )
            .all() as Array<{ v: unknown }>
        ).map((r) => String(r.v)),
      );
      out.push(info);
    }
    return { source: this.kind, location: this.location, tables: out };
  }

  async select(sql: string, params: unknown[] = []): Promise<Row[]> {
    assertReadOnlySql(sql);
    return (this.ro.prepare(sql).all(...(params as any[])) as Row[]).map(normaliseRow);
  }

  async readTable(table: string, where?: { column: string; in: unknown[] }): Promise<Row[]> {
    let sql = `SELECT * FROM ${quoteIdent(table)}`;
    const params: unknown[] = [];
    if (where) {
      if (where.in.length === 0) return [];
      sql += ` WHERE ${quoteIdent(where.column)} IN (${where.in.map(() => '?').join(',')})`;
      params.push(...where.in);
    }
    return (this.rw.prepare(sql).all(...(params as any[])) as Row[]).map(normaliseRow);
  }

  async update(table: string, pkColumn: string, pk: unknown, patch: Row): Promise<void> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sql = `UPDATE ${quoteIdent(table)} SET ${keys.map((k) => `${quoteIdent(k)} = ?`).join(', ')} WHERE ${quoteIdent(pkColumn)} = ?`;
    this.rw.prepare(sql).run(...(keys.map((k) => patch[k]) as any[]), pk as any);
  }

  async insert(table: string, _pkColumn: string, row: Row): Promise<Row> {
    const keys = Object.keys(row);
    const sql = `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    const { lastInsertRowid } = this.rw.prepare(sql).run(...(keys.map((k) => row[k]) as any[]));
    return normaliseRow(
      this.rw.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE rowid = ?`).get(lastInsertRowid) as Row,
    );
  }

  async close(): Promise<void> {
    if (this.ro !== this.rw) this.ro.close();
    this.rw.close();
  }
}
