import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import fs from 'node:fs';
import path from 'node:path';
import { ROW_KEY, TabularAdapter, type Sheet } from './tabular.ts';

/**
 * A folder of CSV files, one per table (exports from an old system, or a spreadsheet saved as CSV).
 * Re-exporting into the folder is picked up on the next sync. The files are never changed: write-backs
 * and new rows go to `<table>.retrofit.csv` next to each source file.
 */
export class CsvAdapter extends TabularAdapter {
  override readonly kind = 'csv' as const;

  constructor(readonly folder: string) {
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
      throw new Error(`CSV folder not found: ${folder}`);
    super(folder, path.join(folder, '.retrofit-changes.json'));
  }

  private files() {
    return fs
      .readdirSync(this.folder)
      .filter((f) => f.toLowerCase().endsWith('.csv') && !f.endsWith('.retrofit.csv'))
      .sort();
  }

  protected async version() {
    return this.files()
      .map((f) => {
        const s = fs.statSync(path.join(this.folder, f));
        return `${f}:${s.mtimeMs}:${s.size}`;
      })
      .join('|');
  }

  protected async readSheets(): Promise<Sheet[]> {
    return this.files().map((f) => {
      const records = parse(fs.readFileSync(path.join(this.folder, f)), {
        skip_empty_lines: true,
        bom: true,
        relax_column_count: true,
      }) as string[][];
      const [headers = [], ...rows] = records;
      return { source: path.basename(f, path.extname(f)), headers, rows };
    });
  }

  protected async writeCopy(tables: string[]) {
    for (const t of this.changedTables(tables)) {
      const out = path.join(this.folder, `${t.shape.source}.retrofit.csv`);
      const rows = t.rows.map((r) => {
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (k === ROW_KEY && t.shape.byPosition) continue;
          o[t.shape.headers.get(k) ?? k] = v ?? '';
        }
        return o;
      });
      fs.writeFileSync(out, stringify(rows, { header: true }));
    }
  }
}
