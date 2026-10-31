import ExcelJS from 'exceljs';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addInvoice,
  intakeContext,
  nextKey,
  openSource,
  parseInvoiceText,
  sheetExportUrl,
  type IntakeContext,
} from '../src/index.ts';
import { harness, listen } from './helpers.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A small business's whole invoicing in one Excel sheet, the way many keep it. */
async function jobsWorkbook(file: string, extra: unknown[][] = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Invoices');
  ws.addRow(['Invoice #', 'Date', 'Customer', 'Email', 'Amount', 'Due Date', 'Status', 'Notes']);
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  for (const r of [
    [
      1001,
      d('2026-09-01'),
      'Harbor View Apartments',
      'maya.harbor@example.com',
      420,
      d('2026-09-15'),
      'Sent',
      '',
    ],
    [
      1002,
      d('2026-09-20'),
      'Rosa Diaz',
      'rosa@example.com',
      180,
      d('2026-10-04'),
      'Overdue',
      'promised friday',
    ],
    [
      1003,
      d('2026-10-01'),
      'Harbor View Apartments',
      'maya.harbor@example.com',
      95.5,
      d('2026-10-15'),
      'Paid',
      '',
    ],
    [1004, d('2026-10-20'), 'Kim Lee', 'kim@example.com', 300, d('2026-11-03'), 'Draft', ''],
    ...extra,
  ])
    ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(file);
}

describe('spreadsheet sources', () => {
  it("runs a business from one Excel sheet: maps it, syncs it, adds invoices and keeps the owner's file untouched", async () => {
    const h = await harness({
      business: 'Lakeside Repairs',
      source: async (dir) => {
        await jobsWorkbook(path.join(dir, 'jobs.xlsx'));
        return 'excel:./jobs.xlsx';
      },
    });
    cleanups.push(h.close);
    const file = path.join(h.dir, 'jobs.xlsx');
    const original = fs.readFileSync(file);

    // "Invoice #" and "Due Date" become safe columns; the customer lives on each row, keyed by email.
    const t = h.schema.tables.find((x) => x.name === 'Invoices')!;
    expect(t.columns.find((c) => c.pk)?.name).toBe('Invoice_no');
    expect(h.mapping.entities.customer).toMatchObject({ table: 'Invoices', pk: 'Email' });
    expect(h.mapping.entities.invoice.fields).toMatchObject({
      number: 'Invoice_no',
      customer: 'Email',
      due: 'Due_Date',
    });
    expect(h.mapping.entities.invoice.push.sort()).toEqual(['Overdue', 'Sent']);
    expect(h.mapping.entities.invoice.writeBack.paypalId).toBe('PayPal_invoice');

    await h.rf.sync();
    expect(
      h.rf.state
        .listLinks()
        .map((l) => l.legacyPk)
        .sort(),
    ).toEqual(['1001', '1002']);
    const due = (await h.rf.invoice('1002')).due;
    expect(due).toBe('2026-10-04');

    // A new invoice goes into the sheet's numbering, with the business's usual 14-day terms, then to PayPal.
    const added = await addInvoice(h.rf, {
      customer: { name: 'Harbor View Apartments' },
      lines: [{ description: 'Replace water heater valve', qty: 1, unitPrice: 240 }],
    });
    expect(added).toMatchObject({ number: '1005', status: 'Sent', newCustomer: false, total: 240 });
    expect(added.paypal?.id).toBeTruthy();
    expect(added.due).toBe(new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10));

    // The owner's workbook is never changed; the copy has the PayPal columns and the new row.
    expect(fs.readFileSync(file).equals(original)).toBe(true);
    const copy = new ExcelJS.Workbook();
    await copy.xlsx.readFile(path.join(h.dir, 'jobs.retrofit.xlsx'));
    const ws = copy.getWorksheet('Invoices')!;
    const header = (ws.getRow(1).values as unknown[]).map(String);
    const col = (name: string) => header.indexOf(name);
    expect(col('PayPal_invoice')).toBeGreaterThan(0);
    expect(ws.getRow(2).getCell(col('PayPal_invoice')).value).toBe(
      h.rf.state.getLink('invoice', '1001')!.paypalId,
    );
    expect(ws.getRow(6).getCell(1).value).toBe(1005);
    expect(ws.getRow(1).font?.bold).toBe(true);

    // The owner adds a row to their own file: the next sync picks it up, and retrofit's row is still there.
    await new Promise((r) => setTimeout(r, 20));
    await jobsWorkbook(file, [
      [
        1006,
        new Date('2026-10-28T00:00:00Z'),
        'Kim Lee',
        'kim@example.com',
        120,
        new Date('2026-11-11T00:00:00Z'),
        'Sent',
        '',
      ],
    ]);
    await h.rf.sync();
    const linked = h.rf.state.listLinks().map((l) => l.legacyPk);
    expect(linked).toContain('1006');
    expect((await h.rf.invoice('1005')).total).toBe(240);
  });

  it('reads a shared Google Sheet as a workbook and explains how to share a private one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-gsheet-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    await jobsWorkbook(path.join(dir, 'sheet.xlsx'));
    const app = express();
    app.get('/sheet.xlsx', (_req, res) =>
      res
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .send(fs.readFileSync(path.join(dir, 'sheet.xlsx'))),
    );
    app.get('/private', (_req, res) => res.type('html').send('<html>Sign in</html>'));
    const server = await listen(app);
    cleanups.push(server.close);

    const src = openSource(`gsheet:${server.url}/sheet.xlsx`, dir);
    const schema = await src.introspect();
    expect(schema.source).toBe('gsheet');
    expect(schema.tables[0]).toMatchObject({ name: 'Invoices', rowCount: 4 });
    await src.close();
    const priv = openSource(`gsheet:${server.url}/private`, dir);
    await expect(priv.introspect()).rejects.toThrow(/Anyone with the link/);

    expect(sheetExportUrl('https://docs.google.com/spreadsheets/d/abc123/edit?usp=sharing')).toBe(
      'https://docs.google.com/spreadsheets/d/abc123/export?format=xlsx',
    );
    expect(sheetExportUrl('https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pubhtml')).toBe(
      'https://docs.google.com/spreadsheets/d/e/2PACX-xyz/pub?output=xlsx',
    );
  });

  it('picks up a re-exported CSV file on the next sync', async () => {
    const h = await harness({
      business: 'Brightside Plumbing',
      source: (dir) => {
        const data = path.join(dir, 'data');
        fs.mkdirSync(data);
        const samples = fileURLToPath(new URL('../../server/samples/brightside-plumbing', import.meta.url));
        for (const f of fs.readdirSync(samples)) fs.copyFileSync(path.join(samples, f), path.join(data, f));
        return 'csv:./data';
      },
    });
    cleanups.push(h.close);
    await h.rf.sync();
    const before = h.rf.state.listLinks().length;
    const bills = path.join(h.dir, 'data', 'bills.csv');
    fs.appendFileSync(bills, '31,BP-2431,1,2026-10-28,2026-11-12,410.00,billed,,,,\n');
    await h.rf.sync();
    expect(h.rf.state.listLinks().length).toBe(before + 1);
    expect(fs.readFileSync(path.join(h.dir, 'data', 'bills.retrofit.csv'), 'utf8')).toMatch(/BP-2431/);
  });
});

describe('new invoices', () => {
  const ctx: IntakeContext = {
    business: 'Brightside Plumbing',
    currency: 'USD',
    today: '2026-10-30',
    usualTermsDays: 14,
    customers: [
      { key: '1', name: 'Harbor View Apartments', email: 'maya.harbor@example.com' },
      { key: '2', name: 'Juniper Street Bakery', email: 'luis.juniper@example.com' },
    ],
    products: [{ name: 'Portrait session', price: 350 }],
  };

  it('reads everyday sentences without Claude', () => {
    expect(
      parseInvoiceText(
        'Invoice Harbor View Apartments $420 for replacing the water heater valve, due in 14 days',
        ctx,
      ),
    ).toMatchObject({
      customer: { key: '1' },
      lines: [{ description: 'Replacing the water heater valve', qty: 1, unitPrice: 420 }],
      due: '2026-11-13',
      questions: [],
    });
    expect(
      parseInvoiceText('Bill Rosa Diaz rosa@example.com 2 hours at $85 for retouching, net 30', ctx),
    ).toMatchObject({
      customer: { name: 'Rosa Diaz', email: 'rosa@example.com' },
      lines: [{ description: 'Retouching', qty: 2, unitPrice: 85 }],
      due: '2026-11-29',
    });
    expect(
      parseInvoiceText('Juniper Street Bakery: drain cleaning 145, call-out fee 65.50, due Friday', ctx),
    ).toMatchObject({
      customer: { key: '2' },
      lines: [
        { description: 'Drain cleaning', unitPrice: 145 },
        { description: 'Call-out fee', unitPrice: 65.5 },
      ],
      due: '2026-11-06', // the next Friday after Friday 30 October
    });
    const unknown = parseInvoiceText('Invoice Pine Cafe for a portrait session', ctx);
    expect(unknown.customer).toMatchObject({ name: 'Pine Cafe' });
    expect(unknown.lines).toEqual([{ description: 'Portrait session', qty: 1, unitPrice: 350 }]);
    expect(unknown.questions.join(' ')).toMatch(/email/);
    expect(nextKey(['INV-1041', 'INV-1042'])).toBe('INV-1043');
    expect(nextKey([7, 12, 3])).toBe(13);
    expect(nextKey(['BP-0099'])).toBe('BP-0100');
  });

  it('writes a new customer, invoice and lines into the legacy database, then sends it through PayPal', async () => {
    const h = await harness({ autoApprove: true });
    cleanups.push(h.close);
    await h.rf.sync();
    const c = await intakeContext(h.rf);
    expect(c.products.length).toBeGreaterThan(0);
    const r = await addInvoice(h.rf, {
      customer: { name: 'Pine Street Cafe', email: 'owner@pinestreet.example' },
      lines: [
        { description: 'Menu photography', qty: 3, unitPrice: 150 },
        { description: 'Editing', qty: 1, unitPrice: 90 },
      ],
      notes: 'Shot on site, 29 Oct',
    });
    expect(r).toMatchObject({ newCustomer: true, total: 540, status: 'sent' });
    expect(r.number).toMatch(/^INV-\d+$/);
    const inv = await h.rf.invoice(r.legacyPk);
    expect(inv.customer?.email).toBe('owner@pinestreet.example');
    expect(inv.lines.map((l) => l.description)).toEqual(['Menu photography', 'Editing']);
    const pp = await h.rf.paypal.getInvoice(r.paypal!.id);
    expect(Number(pp.amount?.value)).toBe(540);
    // Write-back into the legacy table, as for any synced invoice.
    const [row] = await h.rf.source.select(
      'SELECT paypal_invoice_id, created_on FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ?',
      [Number(r.legacyPk)],
    );
    expect(row).toMatchObject({ paypal_invoice_id: r.paypal!.id });
    expect(row!.created_on).toMatch(/^\d{4}-\d{2}-\d{2}/);
    await expect(
      addInvoice(h.rf, {
        customer: { name: 'Nobody' },
        lines: [{ description: 'x', qty: 1, unitPrice: 10 }],
      }),
    ).rejects.toThrow(/email/);
  });
});
