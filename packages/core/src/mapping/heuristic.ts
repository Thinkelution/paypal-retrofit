import type { SchemaDescription, TableInfo } from '../types.ts';
import { CollectionsPlaybook, Commerce, recommendedControls, type RetrofitMapping } from './schema.ts';

/**
 * A deterministic, name-based mapper. Used when no Claude API key is configured, and as a hint for the
 * Mapper agent. It handles conventional schemas; the agent handles everything else.
 */
export function heuristicMapping(
  schema: SchemaDescription,
  currency = 'USD',
  timezone = 'UTC',
): RetrofitMapping | null {
  const score = (t: TableInfo, words: string[]) =>
    words.reduce((s, w) => s + (new RegExp(w, 'i').test(t.name) ? 3 : 0), 0) +
    t.columns.reduce((s, c) => s + (words.some((w) => new RegExp(w, 'i').test(c.name)) ? 1 : 0), 0);
  const pick = (words: string[], exclude: string[] = []) =>
    schema.tables
      .filter((t) => !exclude.includes(t.name))
      .map((t) => ({ t, s: score(t, words) }))
      .filter((x) => x.s >= 3)
      .sort((a, b) => b.s - a.s)[0]?.t;

  const col = (t: TableInfo | undefined, patterns: RegExp[]) => {
    if (!t) return undefined;
    for (const p of patterns) {
      const c = t.columns.find((x) => p.test(x.name));
      if (c) return c.name;
    }
    return undefined;
  };
  const pk = (t: TableInfo) => t.columns.find((c) => c.pk)?.name ?? 'id';

  const customers = pick(['customer', 'client', 'contact', 'member', 'account', 'email']);
  const lines = pick(['item', 'line'], customers ? [customers.name] : []);
  const invoices = pick(
    ['invoice', 'bill', 'due', 'total'],
    [customers?.name, lines?.name].filter(Boolean) as string[],
  );
  const products = pick(
    ['service', 'product', 'catalog', 'sku', 'price'],
    [customers?.name, lines?.name, invoices?.name].filter(Boolean) as string[],
  );
  const subs = pick(
    ['retainer', 'subscription', 'membership', 'plan', 'recurring', 'monthly'],
    [customers?.name, lines?.name, invoices?.name, products?.name].filter(Boolean) as string[],
  );
  if (!customers || !invoices) return null;

  const statusCol = col(invoices, [/^status$/i, /state$/i]) ?? 'status';
  const statuses = invoices.enums[statusCol] ?? [];
  const isPaid = (s: string) => /^(paid|settled|complete|completed|closed)$/i.test(s);
  const isCancelled = (s: string) => /^(void|cancel+ed|written_off|deleted)$/i.test(s);
  const open = statuses.filter((s) => !isPaid(s) && !isCancelled(s));
  const push = open.filter((s) => !/draft/i.test(s));

  const singular = invoices.name.replace(/s$/i, '').replace(/[^A-Za-z0-9_]/g, '');
  const fkToInvoice =
    lines?.foreignKeys.find((f) => f.refTable === invoices.name)?.column ??
    col(lines, [/invoice_?id/i, new RegExp(`^${singular}_?id$`, 'i')]);

  const m: RetrofitMapping = {
    version: 1,
    currency,
    entities: {
      customer: {
        table: customers.name,
        pk: pk(customers),
        fields: {
          name: col(customers, [/^full_?name$/i, /^name$/i, /display_?name/i, /company/i]) ?? 'name',
          email: col(customers, [/email/i]) ?? 'email',
          phone: col(customers, [/phone|mobile|tel/i]),
          line1: col(customers, [/addr(ess)?_?1|line_?1|street|^address$/i]),
          city: col(customers, [/city|town/i]),
          state: col(customers, [/^state$|province|region/i]),
          postal: col(customers, [/zip|postal|postcode/i]),
          country: col(customers, [/country/i]),
        },
      },
      product: products
        ? {
            table: products.name,
            pk: pk(products),
            fields: {
              name: col(products, [/^name$/i, /title/i]) ?? 'name',
              description: col(products, [/desc/i]),
              price: col(products, [/price|rate|amount|fee/i]),
            },
          }
        : undefined,
      invoice: {
        table: invoices.name,
        pk: pk(invoices),
        fields: {
          number: col(invoices, [/invoice_?(no|num|number)/i, /^number$/i, /^ref/i]) ?? pk(invoices),
          customer:
            invoices.foreignKeys.find((f) => f.refTable === customers.name)?.column ??
            col(invoices, [/customer|client/i]) ??
            'customer_id',
          issued: col(invoices, [/issue|invoice_?date|created/i]),
          due: col(invoices, [/due/i]),
          status: statusCol,
          total: col(invoices, [/^total$/i, /amount_?due/i, /^amount$/i, /total/i]) ?? 'total',
          notes: col(invoices, [/note|memo/i]),
        },
        lines:
          lines && fkToInvoice
            ? {
                table: lines.name,
                fk: fkToInvoice,
                fields: {
                  description: col(lines, [/desc|name|title/i]) ?? 'description',
                  qty: col(lines, [/qty|quantity|hours|units/i]) ?? 'quantity',
                  unitPrice: col(lines, [/unit_?price|rate|price/i]) ?? 'unit_price',
                  product: products
                    ? lines.foreignKeys.find((f) => f.refTable === products.name)?.column
                    : undefined,
                },
              }
            : undefined,
        statusMap: { open, paid: statuses.filter(isPaid), cancelled: statuses.filter(isCancelled) },
        push: push.length ? push : open,
        writeBack: {
          paypalId: col(invoices, [/paypal_?invoice_?id/i, /paypal_?id/i]),
          payLink: col(invoices, [/paypal_?(link|url)/i, /pay_?(link|url)/i]),
          status: statusCol,
          paidAt: col(invoices, [/paid_?(at|on|date)/i]),
          paidAmount: col(invoices, [/paid_?amount|amount_?paid/i]),
        },
      },
      subscription: undefined,
    },
    policies: {},
    ...recommendedControls(timezone),
    collections: CollectionsPlaybook.parse({}),
    terms: {},
    commerce: Commerce.parse({}),
    rationale: {
      'customer.table': `"${customers.name}" has the strongest customer/contact signals`,
      'invoice.table': `"${invoices.name}" has invoice-like columns and references "${customers.name}"`,
    },
    confidence: { customer: 0.6, invoice: 0.6 },
    generatedBy: 'heuristic',
  };

  if (subs) {
    const sStatus = col(subs, [/^status$/i, /state$/i]) ?? 'status';
    const sVals = subs.enums[sStatus] ?? [];
    m.entities.subscription = {
      table: subs.name,
      pk: pk(subs),
      fields: {
        customer:
          subs.foreignKeys.find((f) => f.refTable === customers.name)?.column ??
          col(subs, [/customer|client/i]) ??
          'customer_id',
        amount: col(subs, [/fee|amount|price|rate/i]) ?? 'amount',
        title: col(subs, [/title|name|plan/i]),
        startedAt: col(subs, [/start/i]),
        status: sStatus,
      },
      interval: /week/i.test(subs.columns.map((c) => c.name).join(' ')) ? 'WEEK' : 'MONTH',
      statusMap: {
        pending: sVals.filter((s) => /pending|new|draft/i.test(s)),
        active: sVals.filter((s) => /active|live/i.test(s)),
        cancelled: sVals.filter((s) => /cancel|ended|expired|inactive/i.test(s)),
      },
      push: sVals.filter((s) => /pending|new/i.test(s)).length
        ? sVals.filter((s) => /pending|new/i.test(s))
        : ['pending'],
      writeBack: { paypalId: col(subs, [/paypal/i]), status: sStatus },
    };
    m.rationale['subscription.table'] = `"${subs.name}" looks like a recurring agreement`;
    m.confidence.subscription = 0.5;
  }
  return JSON.parse(JSON.stringify(m));
}
