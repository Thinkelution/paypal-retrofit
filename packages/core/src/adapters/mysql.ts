import mysql from 'mysql2/promise';
import type { Row, SchemaDescription, TableInfo } from '../types.ts';
import {
  assertReadOnlySql,
  enumCandidates,
  maskSample,
  normaliseRow,
  quoteIdent,
  type SourceAdapter,
} from './common.ts';

/**
 * MySQL or MariaDB source (mysql://user:pass@host:3306/database). Sessions run with ANSI_QUOTES so
 * identifiers are quoted the same way as everywhere else in retrofit, including SQL the agents write.
 */
export class MysqlAdapter implements SourceAdapter {
  readonly kind = 'mysql' as const;
  private pool: mysql.Pool;
  private database: string;

  constructor(readonly location: string) {
    const url = new URL(location);
    this.database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!this.database) throw new Error('Add the database name to the MySQL URL: mysql://user:pass@host/db');
    this.pool = mysql.createPool({
      uri: location,
      connectionLimit: 4,
      dateStrings: true,
      decimalNumbers: true,
    });
    this.pool.pool.on('connection', (c) => {
      c.query(`SET SESSION sql_mode = CONCAT(@@SESSION.sql_mode, ',ANSI_QUOTES')`);
    });
  }

  private async q(sql: string, params: unknown[] = []): Promise<any[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as any[];
  }

  async introspect(sampleRows = 5): Promise<SchemaDescription> {
    const tables = await this.q(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [this.database],
    );
    const out: TableInfo[] = [];
    for (const { name } of tables) {
      const cols = await this.q(
        `SELECT COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt, COLUMN_KEY AS ckey, EXTRA AS extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
        [this.database, name],
      );
      const fks = await this.q(
        `SELECT COLUMN_NAME AS col, REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refColumn
         FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
        [this.database, name],
      );
      const t = quoteIdent(name);
      const [{ n }] = await this.q(`SELECT COUNT(*) AS n FROM ${t}`);
      const samples = (await this.q(`SELECT * FROM ${t} LIMIT ${Math.max(0, sampleRows)}`)).map((r) =>
        maskSample(normaliseRow(r)),
      );
      const info: TableInfo = {
        name,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          nullable: c.nullable === 'YES',
          pk: c.ckey === 'PRI',
          hasDefault: c.dflt != null || /auto_increment/i.test(String(c.extra ?? '')),
        })),
        foreignKeys: fks.map((f) => ({ column: f.col, refTable: f.refTable, refColumn: f.refColumn })),
        rowCount: Number(n),
        samples,
        enums: {},
      };
      info.enums = await enumCandidates(info, async (col) =>
        (
          await this.q(
            `SELECT DISTINCT CAST(${quoteIdent(col)} AS CHAR) AS v FROM ${t} WHERE ${quoteIdent(col)} IS NOT NULL LIMIT 13`,
          )
        ).map((r) => String(r.v)),
      );
      out.push(info);
    }
    return { source: 'mysql', location: redactUrl(this.location), tables: out };
  }

  async select(sql: string, params: unknown[] = []): Promise<Row[]> {
    assertReadOnlySql(sql);
    const conn = await this.pool.getConnection();
    try {
      await conn.query('START TRANSACTION READ ONLY');
      const [rows] = await conn.query(sql, params);
      await conn.query('ROLLBACK');
      return (rows as Row[]).map(normaliseRow);
    } catch (e) {
      await conn.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async readTable(table: string, where?: { column: string; in: unknown[] }): Promise<Row[]> {
    let sql = `SELECT * FROM ${quoteIdent(table)}`;
    const params: unknown[] = [];
    if (where) {
      if (where.in.length === 0) return [];
      sql += ` WHERE CAST(${quoteIdent(where.column)} AS CHAR) IN (${where.in.map(() => '?').join(', ')})`;
      params.push(...where.in.map(String));
    }
    return (await this.q(sql, params)).map(normaliseRow);
  }

  async update(table: string, pkColumn: string, pk: unknown, patch: Row): Promise<void> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    await this.q(
      `UPDATE ${quoteIdent(table)} SET ${keys.map((k) => `${quoteIdent(k)} = ?`).join(', ')} WHERE CAST(${quoteIdent(pkColumn)} AS CHAR) = ?`,
      [...keys.map((k) => patch[k]), String(pk)],
    );
  }

  async insert(table: string, pkColumn: string, row: Row): Promise<Row> {
    const keys = Object.keys(row);
    const [res] = await this.pool.query(
      `INSERT INTO ${quoteIdent(table)} (${keys.map(quoteIdent).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((k) => row[k]),
    );
    const key = row[pkColumn] ?? (res as { insertId?: number }).insertId;
    const [stored] = await this.readTable(table, { column: pkColumn, in: [key] });
    return stored ?? row;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return 'mysql://***';
  }
}
