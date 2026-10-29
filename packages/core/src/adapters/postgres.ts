import pg from 'pg';
import type { Row, SchemaDescription, TableInfo } from '../types.ts';
import {
  assertReadOnlySql,
  enumCandidates,
  maskSample,
  normaliseRow,
  quoteIdent,
  type SourceAdapter,
} from './common.ts';

/** Postgres source. Uses the `public` schema unless `?schema=` is set in the connection string. */
export class PostgresAdapter implements SourceAdapter {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;
  private schema: string;

  constructor(readonly location: string) {
    const url = new URL(location);
    this.schema = url.searchParams.get('schema') ?? 'public';
    url.searchParams.delete('schema');
    this.pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  }

  async introspect(sampleRows = 5): Promise<SchemaDescription> {
    const q = (sql: string, p: unknown[] = []) => this.pool.query(sql, p).then((r) => r.rows as any[]);
    const tables = await q(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name`,
      [this.schema],
    );
    const out: TableInfo[] = [];
    for (const { table_name: name } of tables) {
      const cols = await q(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
        [this.schema, name],
      );
      const pks = await q(
        `SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
         WHERE tc.table_schema=$1 AND tc.table_name=$2 AND tc.constraint_type='PRIMARY KEY'`,
        [this.schema, name],
      );
      const fks = await q(
        `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
         WHERE tc.table_schema=$1 AND tc.table_name=$2 AND tc.constraint_type='FOREIGN KEY'`,
        [this.schema, name],
      );
      const t = `${quoteIdent(this.schema)}.${quoteIdent(name)}`;
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM ${t}`);
      const samples = (await q(`SELECT * FROM ${t} LIMIT ${Math.max(0, sampleRows)}`)).map((r) =>
        maskSample(normaliseRow(r)),
      );
      const pkSet = new Set(pks.map((p) => p.column_name));
      const info: TableInfo = {
        name,
        columns: cols.map((c) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          pk: pkSet.has(c.column_name),
        })),
        foreignKeys: fks.map((f) => ({
          column: f.column_name,
          refTable: f.ref_table,
          refColumn: f.ref_column,
        })),
        rowCount: n,
        samples,
        enums: {},
      };
      info.enums = await enumCandidates(info, async (col) =>
        (
          await q(
            `SELECT DISTINCT ${quoteIdent(col)}::text AS v FROM ${t} WHERE ${quoteIdent(col)} IS NOT NULL LIMIT 13`,
          )
        ).map((r) => String(r.v)),
      );
      out.push(info);
    }
    return { source: 'postgres', location: redactUrl(this.location), tables: out };
  }

  async select(sql: string, params: unknown[] = []): Promise<Row[]> {
    assertReadOnlySql(sql);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      await client.query(`SET LOCAL search_path TO ${quoteIdent(this.schema)}`);
      const r = await client.query(sql, params);
      await client.query('ROLLBACK');
      return r.rows.map(normaliseRow);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async readTable(table: string, where?: { column: string; in: unknown[] }): Promise<Row[]> {
    let sql = `SELECT * FROM ${quoteIdent(this.schema)}.${quoteIdent(table)}`;
    const params: unknown[] = [];
    if (where) {
      if (where.in.length === 0) return [];
      sql += ` WHERE ${quoteIdent(where.column)}::text = ANY($1::text[])`;
      params.push(where.in.map(String));
    }
    return (await this.pool.query(sql, params)).rows.map(normaliseRow);
  }

  async update(table: string, pkColumn: string, pk: unknown, patch: Row): Promise<void> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(', ');
    await this.pool.query(
      `UPDATE ${quoteIdent(this.schema)}.${quoteIdent(table)} SET ${sets} WHERE ${quoteIdent(pkColumn)}::text = $${keys.length + 1}`,
      [...keys.map((k) => patch[k]), String(pk)],
    );
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
    return 'postgres://***';
  }
}
