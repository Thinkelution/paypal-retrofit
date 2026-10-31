import path from 'node:path';
import type { SourceAdapter } from './common.ts';
import { CsvAdapter } from './csv.ts';
import { ExcelAdapter, GoogleSheetAdapter, sheetExportUrl } from './excel.ts';
import { MysqlAdapter } from './mysql.ts';
import { PostgresAdapter } from './postgres.ts';
import { SqliteAdapter } from './sqlite.ts';

export type { SourceAdapter } from './common.ts';
export { assertReadOnlySql, safeIdent } from './common.ts';
export { CsvAdapter, ExcelAdapter, GoogleSheetAdapter, MysqlAdapter, PostgresAdapter, SqliteAdapter };
export { sheetExportUrl };

/**
 * Opens a source from a connection string:
 *   sqlite:./path/to/file.db
 *   postgres://user:pass@host:5432/db?schema=public
 *   mysql://user:pass@host:3306/db
 *   csv:./folder-of-csv-files
 *   excel:./workbook.xlsx
 *   gsheet:https://docs.google.com/spreadsheets/d/<id>/edit   (shared "anyone with the link")
 */
export function openSource(conn: string, baseDir = process.cwd()): SourceAdapter {
  if (conn.startsWith('sqlite:'))
    return new SqliteAdapter(path.resolve(baseDir, conn.slice('sqlite:'.length)));
  if (conn.startsWith('csv:')) return new CsvAdapter(path.resolve(baseDir, conn.slice('csv:'.length)));
  if (conn.startsWith('excel:')) return new ExcelAdapter(path.resolve(baseDir, conn.slice('excel:'.length)));
  if (conn.startsWith('gsheet:')) return new GoogleSheetAdapter(conn.slice('gsheet:'.length), baseDir);
  if (/^https:\/\/docs\.google\.com\/spreadsheets\//.test(conn)) return new GoogleSheetAdapter(conn, baseDir);
  if (conn.startsWith('postgres://') || conn.startsWith('postgresql://')) return new PostgresAdapter(conn);
  if (conn.startsWith('mysql://') || conn.startsWith('mariadb://'))
    return new MysqlAdapter(conn.replace(/^mariadb:/, 'mysql:'));
  if (/\.(db|sqlite|sqlite3)$/i.test(conn)) return new SqliteAdapter(path.resolve(baseDir, conn));
  if (/\.xlsx$/i.test(conn)) return new ExcelAdapter(path.resolve(baseDir, conn));
  throw new Error(
    `Unrecognised source "${conn}". Use sqlite:<file>, csv:<folder>, excel:<file.xlsx>, gsheet:<link>, postgres://... or mysql://...`,
  );
}
