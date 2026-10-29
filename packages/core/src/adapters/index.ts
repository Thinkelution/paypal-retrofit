import path from 'node:path';
import type { SourceAdapter } from './common.ts';
import { CsvAdapter } from './csv.ts';
import { PostgresAdapter } from './postgres.ts';
import { SqliteAdapter } from './sqlite.ts';

export type { SourceAdapter } from './common.ts';
export { assertReadOnlySql } from './common.ts';
export { CsvAdapter, PostgresAdapter, SqliteAdapter };

/**
 * Opens a source from a connection string:
 *   sqlite:./path/to/file.db
 *   postgres://user:pass@host:5432/db?schema=public
 *   csv:./folder-of-csv-files
 */
export function openSource(conn: string, baseDir = process.cwd()): SourceAdapter {
  if (conn.startsWith('sqlite:'))
    return new SqliteAdapter(path.resolve(baseDir, conn.slice('sqlite:'.length)));
  if (conn.startsWith('csv:')) return new CsvAdapter(path.resolve(baseDir, conn.slice('csv:'.length)));
  if (conn.startsWith('postgres://') || conn.startsWith('postgresql://')) return new PostgresAdapter(conn);
  if (/\.(db|sqlite|sqlite3)$/i.test(conn)) return new SqliteAdapter(path.resolve(baseDir, conn));
  throw new Error(`Unrecognised source "${conn}". Use sqlite:<file>, csv:<folder> or postgres://...`);
}
