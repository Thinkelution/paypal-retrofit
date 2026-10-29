import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReadOnlySql,
  CsvAdapter,
  heuristicMapping,
  invoiceDraft,
  redact,
  validateMapping,
  type LegacyInvoice,
} from '../src/index.ts';

describe('read-only SQL guard', () => {
  it('allows SELECT and WITH', () => {
    expect(() => assertReadOnlySql('SELECT * FROM invoices')).not.toThrow();
    expect(() =>
      assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x WHERE note = 'delete me'"),
    ).not.toThrow();
  });
  it('rejects writes and multiple statements', () => {
    expect(() => assertReadOnlySql('DELETE FROM invoices')).toThrow();
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE invoices')).toThrow();
    expect(() => assertReadOnlySql('WITH x AS (DELETE FROM invoices RETURNING *) SELECT * FROM x')).toThrow();
  });
});

describe('redaction', () => {
  it('masks emails and secrets', () => {
    const out = redact({ email: 'maya.okafor@example.com', note: 'contact tom@x.io', clientSecret: 'abc' });
    expect(out.email).toBe('m***@example.com');
    expect(out.note).toBe('contact t***@x.io');
    expect(out.clientSecret).toBe('[redacted]');
  });
});

describe('invoice payload', () => {
  const inv: LegacyInvoice = {
    pk: '7',
    number: 'INV-1016',
    status: 'overdue',
    state: 'open',
    total: 268,
    issued: '2026-09-01',
    due: '2026-09-15',
    customerPk: '3',
    customer: {
      pk: '3',
      name: 'Priya Natarajan',
      email: 'priya.n@example.com',
      line1: '9 Elm Court',
      city: 'Austin',
      state: 'TX',
      postal: '73301',
      country: 'US',
    },
    lines: [
      { description: 'Portrait session', qty: 1, unitPrice: 250 },
      { description: 'Photo editing', qty: 1, unitPrice: 18 },
    ],
    raw: {},
    hash: 'x',
  };
  it('uses DUE_ON_RECEIPT for past due dates and keeps the legacy number', () => {
    const d = invoiceDraft(inv, {
      currency: 'USD',
      businessName: 'Fernhill Studio',
      invoicePrefix: 'FH-',
      today: new Date('2026-10-29'),
    });
    expect(d.detail.invoice_number).toBe('FH-INV-1016');
    expect(d.detail.payment_term).toEqual({ term_type: 'DUE_ON_RECEIPT' });
    expect(d.items).toHaveLength(2);
    expect(d.items[0]!.unit_amount).toEqual({ currency_code: 'USD', value: '250.00' });
    expect(d.primary_recipients[0]!.billing_info.name).toEqual({ given_name: 'Priya', surname: 'Natarajan' });
    expect(d.detail.note).toContain('Originally issued 2026-09-01');
  });
  it('keeps a future due date', () => {
    const d = invoiceDraft(
      { ...inv, due: '2026-11-20' },
      { currency: 'USD', businessName: 'F', invoicePrefix: '', today: new Date('2026-10-29') },
    );
    expect(d.detail.payment_term).toEqual({ term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-11-20' });
  });
});

describe('CSV source', () => {
  it('maps a folder of CSV exports and writes back to sidecar files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-csv-'));
    fs.writeFileSync(
      path.join(dir, 'clients.csv'),
      'id,name,email,city\n1,Ana Ruiz,ana@example.com,Lisbon\n2,Ben Ito,ben@example.com,Osaka\n',
    );
    fs.writeFileSync(
      path.join(dir, 'bills.csv'),
      'id,bill_number,client_id,due_date,status,amount_due,paypal_id\n10,B-1,1,2026-11-30,unpaid,120.50,\n11,B-2,2,2026-10-01,paid,80,\n',
    );
    const src = new CsvAdapter(dir);
    const schema = await src.introspect();
    const m = heuristicMapping(schema);
    expect(m).not.toBeNull();
    const { mapping, issues } = validateMapping(m, schema);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(mapping.entities.customer.table).toBe('clients');
    expect(mapping.entities.invoice.table).toBe('bills');
    expect(mapping.entities.invoice.fields.total).toBe('amount_due');
    expect(mapping.entities.invoice.push).toEqual(['unpaid']);
    await src.update('bills', 'id', 10, { paypal_id: 'INV2-ABC' });
    expect(fs.readFileSync(path.join(dir, 'bills.retrofit.csv'), 'utf8')).toContain('INV2-ABC');
    expect(fs.readFileSync(path.join(dir, 'bills.csv'), 'utf8')).not.toContain('INV2-ABC');
    await src.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
