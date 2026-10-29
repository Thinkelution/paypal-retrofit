import type { SourceAdapter } from './adapters/common.ts';
import type { RetrofitMapping } from './mapping/schema.ts';
import type { Row } from './types.ts';
import { cents, hashOf } from './util.ts';

export interface LegacyCustomer {
  pk: string;
  name: string;
  email: string;
  phone?: string;
  line1?: string;
  city?: string;
  state?: string;
  postal?: string;
  country?: string;
}

export interface LegacyLine {
  description: string;
  qty: number;
  unitPrice: number;
  productPk?: string;
}

export interface LegacyInvoice {
  pk: string;
  number: string;
  status: string;
  state: 'open' | 'paid' | 'cancelled' | 'unknown';
  total: number;
  issued?: string;
  due?: string;
  notes?: string;
  customerPk: string;
  customer: LegacyCustomer | null;
  lines: LegacyLine[];
  raw: Row;
  /** Hash of the fields that matter to PayPal. Status and write-back columns are excluded. */
  hash: string;
}

export interface LegacySubscription {
  pk: string;
  title: string;
  amount: number;
  status: string;
  state: 'pending' | 'active' | 'cancelled' | 'unknown';
  startedAt?: string;
  customerPk: string;
  customer: LegacyCustomer | null;
  raw: Row;
  hash: string;
}

const str = (v: unknown) => (v == null ? undefined : String(v));
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v));

function toCustomer(m: RetrofitMapping, r: Row): LegacyCustomer {
  const f = m.entities.customer.fields;
  return {
    pk: String(r[m.entities.customer.pk]),
    name: String(r[f.name] ?? '').trim() || 'Customer',
    email: String(r[f.email] ?? '').trim(),
    phone: f.phone ? str(r[f.phone]) : undefined,
    line1: f.line1 ? str(r[f.line1]) : undefined,
    city: f.city ? str(r[f.city]) : undefined,
    state: f.state ? str(r[f.state]) : undefined,
    postal: f.postal ? str(r[f.postal]) : undefined,
    country: f.country ? str(r[f.country]) : undefined,
  };
}

async function loadCustomers(source: SourceAdapter, m: RetrofitMapping, pks: string[]) {
  const rows = await source.readTable(m.entities.customer.table, {
    column: m.entities.customer.pk,
    in: [...new Set(pks)],
  });
  return new Map(rows.map((r) => [String(r[m.entities.customer.pk]), toCustomer(m, r)]));
}

export function invoiceState(m: RetrofitMapping, status: string): LegacyInvoice['state'] {
  const sm = m.entities.invoice.statusMap;
  if (sm.paid.includes(status)) return 'paid';
  if (sm.cancelled.includes(status)) return 'cancelled';
  if (sm.open.includes(status)) return 'open';
  return 'unknown';
}

/** Loads invoices with their customers and lines. Filter by legacy status and/or primary keys. */
export async function loadInvoices(
  source: SourceAdapter,
  m: RetrofitMapping,
  filter: { statuses?: string[]; pks?: string[] } = {},
): Promise<LegacyInvoice[]> {
  const im = m.entities.invoice;
  let rows: Row[];
  if (filter.pks) rows = await source.readTable(im.table, { column: im.pk, in: filter.pks });
  else if (filter.statuses)
    rows = await source.readTable(im.table, { column: im.fields.status, in: filter.statuses });
  else rows = await source.readTable(im.table);
  if (filter.pks && filter.statuses)
    rows = rows.filter((r) => filter.statuses!.includes(String(r[im.fields.status])));
  if (rows.length === 0) return [];

  const customers = await loadCustomers(
    source,
    m,
    rows.map((r) => String(r[im.fields.customer])),
  );
  const linesByInvoice = new Map<string, LegacyLine[]>();
  if (im.lines) {
    const lf = im.lines.fields;
    const lineRows = await source.readTable(im.lines.table, {
      column: im.lines.fk,
      in: rows.map((r) => r[im.pk]),
    });
    for (const lr of lineRows) {
      const key = String(lr[im.lines.fk]);
      const list = linesByInvoice.get(key) ?? [];
      list.push({
        description: String(lr[lf.description] ?? 'Item'),
        qty: num(lr[lf.qty]) || 1,
        unitPrice: num(lr[lf.unitPrice]),
        productPk: lf.product ? str(lr[lf.product]) : undefined,
      });
      linesByInvoice.set(key, list);
    }
  }

  return rows.map((r) => {
    const pk = String(r[im.pk]);
    const status = String(r[im.fields.status] ?? '');
    const customer = customers.get(String(r[im.fields.customer])) ?? null;
    const lines = linesByInvoice.get(pk) ?? [];
    const inv = {
      pk,
      number: String(r[im.fields.number] ?? pk),
      status,
      state: invoiceState(m, status),
      total: num(r[im.fields.total]),
      issued: im.fields.issued ? str(r[im.fields.issued]) : undefined,
      due: im.fields.due ? str(r[im.fields.due]) : undefined,
      notes: im.fields.notes ? str(r[im.fields.notes]) : undefined,
      customerPk: String(r[im.fields.customer]),
      customer,
      lines,
      raw: r,
      hash: '',
    } satisfies LegacyInvoice;
    inv.hash = hashOf({
      number: inv.number,
      total: cents(inv.total),
      due: inv.due,
      lines: lines.map((l) => [l.description, l.qty, cents(l.unitPrice)]),
      customer: customer ? [customer.name, customer.email] : null,
    });
    return inv;
  });
}

export function linesTotal(inv: LegacyInvoice): number {
  return inv.lines.reduce((s, l) => s + cents(l.qty * l.unitPrice), 0);
}

export function subscriptionState(m: RetrofitMapping, status: string): LegacySubscription['state'] {
  const sm = m.entities.subscription?.statusMap;
  if (!sm) return 'unknown';
  if (sm.pending.includes(status)) return 'pending';
  if (sm.active.includes(status)) return 'active';
  if (sm.cancelled.includes(status)) return 'cancelled';
  return 'unknown';
}

export async function loadSubscriptions(
  source: SourceAdapter,
  m: RetrofitMapping,
  filter: { statuses?: string[]; pks?: string[] } = {},
): Promise<LegacySubscription[]> {
  const sm = m.entities.subscription;
  if (!sm) return [];
  let rows: Row[];
  if (filter.pks) rows = await source.readTable(sm.table, { column: sm.pk, in: filter.pks });
  else if (filter.statuses)
    rows = await source.readTable(sm.table, { column: sm.fields.status, in: filter.statuses });
  else rows = await source.readTable(sm.table);
  if (rows.length === 0) return [];
  const customers = await loadCustomers(
    source,
    m,
    rows.map((r) => String(r[sm.fields.customer])),
  );
  return rows.map((r) => {
    const status = String(r[sm.fields.status] ?? '');
    const s: LegacySubscription = {
      pk: String(r[sm.pk]),
      title: sm.fields.title ? String(r[sm.fields.title] ?? 'Subscription') : 'Subscription',
      amount: num(r[sm.fields.amount]),
      status,
      state: subscriptionState(m, status),
      startedAt: sm.fields.startedAt ? str(r[sm.fields.startedAt]) : undefined,
      customerPk: String(r[sm.fields.customer]),
      customer: customers.get(String(r[sm.fields.customer])) ?? null,
      raw: r,
      hash: '',
    };
    s.hash = hashOf({
      title: s.title,
      amount: cents(s.amount),
      interval: sm.interval,
      customer: s.customer?.email,
    });
    return s;
  });
}
