import ExcelJS, { type CellValue } from 'exceljs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROW_KEY, TabularAdapter, type Sheet } from './tabular.ts';

/**
 * An Excel workbook (.xlsx): every worksheet is a table, its first non-empty row the headers. The workbook is
 * never changed; retrofit writes `<name>.retrofit.xlsx` next to it, the same workbook with PayPal ids, pay
 * links and payments filled in (formatting and formulas kept).
 */
export class ExcelAdapter extends TabularAdapter {
  override readonly kind: 'excel' | 'gsheet' = 'excel';
  private headerRows = new Map<string, number>();
  private lastBytes?: Buffer;

  constructor(
    readonly file: string,
    files = {
      changes: file.replace(/\.xlsx$/i, '') + '.retrofit-changes.json',
      copy: file.replace(/\.xlsx$/i, '') + '.retrofit.xlsx',
    },
  ) {
    super(file, files.changes);
    this.copyFile = files.copy;
  }

  /** Where the workbook with retrofit's changes is written. */
  readonly copyFile: string;

  protected async bytes(): Promise<Buffer> {
    if (!fs.existsSync(this.file)) throw new Error(`Excel workbook not found: ${this.file}`);
    return fs.readFileSync(this.file);
  }

  protected async version(): Promise<string> {
    const s = fs.statSync(this.file);
    return `${s.mtimeMs}:${s.size}`;
  }

  protected async readSheets(): Promise<Sheet[]> {
    const bytes = (this.lastBytes = await this.bytes());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as any);
    const sheets: Sheet[] = [];
    for (const ws of wb.worksheets) {
      if (ws.state !== 'visible') continue;
      let headerRow = 0;
      ws.eachRow({ includeEmpty: false }, (_row, n) => {
        if (!headerRow) headerRow = n;
      });
      if (!headerRow) continue;
      const cols: number[] = [];
      const headers: string[] = [];
      ws.getRow(headerRow).eachCell({ includeEmpty: false }, (cell, c) => {
        const h = String(cellValue(cell.value) ?? '').trim();
        if (h) {
          cols.push(c);
          headers.push(h);
        }
      });
      const rows: unknown[][] = [];
      const rowNumbers: number[] = [];
      for (let n = headerRow + 1; n <= ws.rowCount; n++) {
        const r = ws.getRow(n);
        const values = cols.map((c) => cellValue(r.getCell(c).value));
        if (values.every((v) => v === '' || v == null)) continue;
        rows.push(values);
        rowNumbers.push(n);
      }
      this.headerRows.set(ws.name, headerRow);
      sheets.push({ source: ws.name, headers, rows, rowNumbers });
    }
    return sheets;
  }

  protected async writeCopy(tables: string[]) {
    if (!this.changedTables(tables).length || !this.lastBytes) return;
    // Rebuilt from the owner's workbook each time, with all of retrofit's changes applied.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(this.lastBytes as any);
    for (const t of this.changedTables()) {
      const ws = wb.getWorksheet(t.shape.source);
      const headerRow = this.headerRows.get(t.shape.source);
      if (!ws || !headerRow) continue;
      const header = ws.getRow(headerRow);
      const colOf = new Map<string, number>();
      header.eachCell({ includeEmpty: false }, (cell, c) => {
        const h = String(cellValue(cell.value) ?? '').trim();
        for (const [name, original] of t.shape.headers) if (original === h) colOf.set(name, c);
      });
      const ensureCol = (name: string) => {
        if (!colOf.has(name)) {
          const c = Math.max(header.cellCount, ...colOf.values()) + 1;
          header.getCell(c).value = name;
          colOf.set(name, c);
        }
        return colOf.get(name)!;
      };
      const rowFor = (key: string) => {
        if (t.shape.byPosition) return Number(key);
        const kc = colOf.get(t.shape.pk);
        if (!kc) return 0;
        for (let n = headerRow + 1; n <= ws.rowCount; n++)
          if (String(cellValue(ws.getRow(n).getCell(kc).value) ?? '') === key) return n;
        return 0;
      };
      for (const row of t.inserts) {
        if (rowFor(String(row[t.shape.pk])) && !t.shape.byPosition) continue;
        const n = ws.rowCount + 1;
        for (const [k, v] of Object.entries(row))
          if (!(k === ROW_KEY && t.shape.byPosition)) ws.getRow(n).getCell(ensureCol(k)).value = v as any;
      }
      for (const [key, patch] of Object.entries(t.updates)) {
        const n = rowFor(key);
        if (!n) continue;
        for (const [k, v] of Object.entries(patch)) ws.getRow(n).getCell(ensureCol(k)).value = v as any;
      }
    }
    await wb.xlsx.writeFile(this.copyFile);
  }
}

/**
 * A Google Sheet shared with "Anyone with the link can view" (or published to the web). retrofit reads the
 * whole spreadsheet as Excel at most every 30 seconds, so rows the owner adds are picked up on the next sync.
 * Google is never written to: PayPal ids, pay links and payments live in retrofit and in a downloadable copy.
 */
export class GoogleSheetAdapter extends ExcelAdapter {
  override readonly kind = 'gsheet' as const;

  constructor(
    readonly url: string,
    baseDir: string,
  ) {
    const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 10);
    super(url, {
      changes: path.join(baseDir, `google-sheet-${id}.retrofit-changes.json`),
      copy: path.join(baseDir, `google-sheet-${id}.retrofit.xlsx`),
    });
  }

  protected override async bytes(): Promise<Buffer> {
    const res = await fetch(sheetExportUrl(this.url), { redirect: 'follow' }).catch(() => null);
    const type = res?.headers.get('content-type') ?? '';
    if (!res?.ok || /text\/html/i.test(type))
      throw new Error(
        'Could not read the Google Sheet. In Google Sheets press Share, set General access to "Anyone with the link" (Viewer), then paste the link again.',
      );
    return Buffer.from(await res.arrayBuffer());
  }

  protected override async version(): Promise<string> {
    return String(Math.floor(Date.now() / 30_000));
  }
}

/** The download link for a Google Sheets link: the whole spreadsheet as .xlsx. Other URLs are used as they are. */
export function sheetExportUrl(url: string): string {
  const u = new URL(url);
  if (u.hostname !== 'docs.google.com') return url;
  const published = u.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/);
  if (published) return `https://docs.google.com/spreadsheets/d/e/${published[1]}/pub?output=xlsx`;
  const id = u.pathname.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!id) throw new Error('That is not a Google Sheets link.');
  return `https://docs.google.com/spreadsheets/d/${id[1]}/export?format=xlsx`;
}

function cellValue(v: CellValue): unknown {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as CellValue);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return cellValue(v.text as CellValue);
    if ('error' in v) return null;
    return null;
  }
  return v;
}
