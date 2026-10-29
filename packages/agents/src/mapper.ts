import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  hasErrors,
  recommendedControls,
  heuristicMapping,
  validateMapping,
  type MappingIssue,
  type RetrofitMapping,
  type SchemaDescription,
} from '@paypal-retrofit/core';
import * as z from 'zod/v4';
import { claude, claudeConfigured, describeApiError, FALLBACK_BETA, model } from './client.ts';

const Col = z.string().nullable().describe('Exact column name, or null if there is no suitable column');

const MapperOutput = z.object({
  currency: z.string().describe('ISO 4217 code, e.g. USD'),
  customer: z.object({
    table: z.string(),
    pk: z.string(),
    name: z.string().describe('Column with the customer or company display name'),
    email: z.string(),
    phone: Col,
    line1: Col,
    city: Col,
    state: Col,
    postal: Col,
    country: Col.describe('Only if it holds ISO 3166-1 alpha-2 codes'),
  }),
  product: z
    .object({ table: z.string(), pk: z.string(), name: z.string(), description: Col, price: Col })
    .nullable(),
  invoice: z.object({
    table: z.string(),
    pk: z.string(),
    number: z.string().describe('Human-facing invoice number column'),
    customer: z.string().describe('Foreign key column to the customer table'),
    issued: Col,
    due: Col,
    status: z.string(),
    total: z.string().describe('Column with the amount the customer owes'),
    notes: Col,
    lines: z
      .object({
        table: z.string(),
        fk: z.string(),
        description: z.string(),
        qty: z.string(),
        unitPrice: z.string(),
        product: Col,
      })
      .nullable(),
    open: z.array(z.string()).describe('Status values meaning money is still owed (including drafts)'),
    paid: z.array(z.string()),
    cancelled: z.array(z.string()),
    push: z
      .array(z.string())
      .describe('Subset of open statuses that should be sent to PayPal (usually exclude drafts)'),
    writeBack: z.object({ paypalId: Col, payLink: Col, status: Col, paidAt: Col, paidAmount: Col }),
  }),
  subscription: z
    .object({
      table: z.string(),
      pk: z.string(),
      customer: z.string(),
      amount: z.string(),
      title: Col,
      startedAt: Col,
      status: z.string(),
      interval: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']),
      pending: z.array(z.string()),
      active: z.array(z.string()),
      cancelled: z.array(z.string()),
      push: z.array(z.string()),
      writeBack: z.object({ paypalId: Col, status: Col }),
    })
    .nullable(),
  rationale: z
    .array(z.object({ path: z.string(), reason: z.string() }))
    .describe('One entry per table choice and per non-obvious column choice'),
  confidence: z
    .object({ customer: z.number(), invoice: z.number(), subscription: z.number().nullable() })
    .describe('0 to 1'),
  warnings: z.array(z.string()).describe('Things the owner should check before syncing'),
});
type MapperOutput = z.infer<typeof MapperOutput>;

const SYSTEM = `You map an existing business database onto PayPal objects for paypal-retrofit, an open-source tool that connects legacy systems to PayPal Invoicing and Subscriptions without changing their schema.

You receive the database schema: tables, columns, primary and foreign keys, row counts, distinct values of status-like columns, and a few sample rows with personal data masked.

Produce a mapping:
- customer: the table of people or companies who receive invoices. It must have an email column; PayPal invoices are delivered by email.
- product (optional): a catalogue of services or products, if one exists.
- invoice: the table of bills owed by customers. "total" is what the customer owes. "status" is the column whose values say whether it is open, paid or cancelled. Classify every distinct status value into open, paid or cancelled. "push" lists the open statuses that should be sent to PayPal; leave out drafts and anything not yet final.
- invoice.lines (optional): the line-item table, joined by a foreign key to the invoice table.
- invoice.writeBack: existing columns where retrofit may record the PayPal invoice id, the payer link, the status (it will write the first "paid" value when paid), the paid date and the paid amount. Only name columns that exist and are clearly meant for that; otherwise null. Never repurpose a column that holds other data.
- subscription (optional): recurring agreements such as retainers, memberships or plans with a periodic fee. "push" lists statuses for agreements that should get a new PayPal subscription (usually pending/new ones, not ones already being paid another way).

Use exact table and column names from the schema. Prefer foreign keys over name similarity. If something is ambiguous, choose the safer option, lower the confidence, and add a warning. Keep rationale entries short and concrete: name the evidence (a foreign key, a status value, a column name).`;

export interface MapperResult {
  mapping: RetrofitMapping | null;
  issues: MappingIssue[];
  warnings: string[];
  engine: 'claude' | 'heuristic';
  usage?: { input: number; output: number };
  error?: string;
}

export async function proposeMapping(
  schema: SchemaDescription,
  opts: { useClaude?: boolean; currencyHint?: string; timezone?: string } = {},
): Promise<MapperResult> {
  const hint = heuristicMapping(schema, opts.currencyHint, opts.timezone);
  const fallback = (error?: string): MapperResult => {
    if (!hint)
      return {
        mapping: null,
        issues: [{ path: '', level: 'error', message: 'Could not find customer and invoice tables' }],
        warnings: [],
        engine: 'heuristic',
        error,
      };
    const { mapping, issues } = validateMapping(hint, schema);
    return {
      mapping,
      issues,
      warnings: error ? [`Claude was not used: ${error}`] : [],
      engine: 'heuristic',
      error,
    };
  };

  if (opts.useClaude === false || !claudeConfigured()) return fallback();

  const payload = {
    source: schema.source,
    tables: schema.tables.map((t) => ({
      name: t.name,
      rows: t.rowCount,
      columns: t.columns.map(
        (c) => `${c.name} ${c.type}${c.pk ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}`,
      ),
      foreignKeys: t.foreignKeys.map((f) => `${f.column} -> ${f.refTable}.${f.refColumn}`),
      statusValues: t.enums,
      samples: t.samples.slice(0, 3),
    })),
  };

  try {
    const response = await claude().beta.messages.parse({
      model: model(),
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(MapperOutput) },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `Database schema:\n${JSON.stringify(payload, null, 1)}\n\nA name-based heuristic suggested this (it may be wrong):\n${JSON.stringify(hint?.entities ?? null)}\n\nCurrency hint: ${opts.currencyHint ?? 'none (infer from data, default USD)'}`,
        },
      ],
    });
    if (response.stop_reason === 'refusal') return fallback('the request was declined');
    if (response.stop_reason === 'max_tokens') return fallback('the response was cut off');
    const out = response.parsed_output;
    if (!out) return fallback('the response could not be parsed');
    const candidate = toMapping(out, opts.timezone);
    const { mapping, issues } = validateMapping(candidate, schema);
    if (hasErrors(issues)) {
      const h = fallback();
      return {
        ...h,
        warnings: [
          `Claude's mapping had errors (${issues
            .filter((i) => i.level === 'error')
            .map((i) => i.message)
            .join('; ')}); using the heuristic instead.`,
          ...h.warnings,
        ],
      };
    }
    return {
      mapping,
      issues,
      warnings: out.warnings,
      engine: 'claude',
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    };
  } catch (e) {
    return fallback(describeApiError(e));
  }
}

const nn = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

function toMapping(o: MapperOutput, timezone = 'UTC'): RetrofitMapping {
  const i = o.invoice;
  const s = o.subscription;
  return JSON.parse(
    JSON.stringify({
      version: 1,
      currency: o.currency.toUpperCase().slice(0, 3) || 'USD',
      entities: {
        customer: {
          table: o.customer.table,
          pk: o.customer.pk,
          fields: {
            name: o.customer.name,
            email: o.customer.email,
            phone: nn(o.customer.phone),
            line1: nn(o.customer.line1),
            city: nn(o.customer.city),
            state: nn(o.customer.state),
            postal: nn(o.customer.postal),
            country: nn(o.customer.country),
          },
        },
        product: o.product
          ? {
              table: o.product.table,
              pk: o.product.pk,
              fields: {
                name: o.product.name,
                description: nn(o.product.description),
                price: nn(o.product.price),
              },
            }
          : undefined,
        invoice: {
          table: i.table,
          pk: i.pk,
          fields: {
            number: i.number,
            customer: i.customer,
            issued: nn(i.issued),
            due: nn(i.due),
            status: i.status,
            total: i.total,
            notes: nn(i.notes),
          },
          lines: i.lines
            ? {
                table: i.lines.table,
                fk: i.lines.fk,
                fields: {
                  description: i.lines.description,
                  qty: i.lines.qty,
                  unitPrice: i.lines.unitPrice,
                  product: nn(i.lines.product),
                },
              }
            : undefined,
          statusMap: { open: i.open, paid: i.paid, cancelled: i.cancelled },
          push: i.push,
          writeBack: {
            paypalId: nn(i.writeBack.paypalId),
            payLink: nn(i.writeBack.payLink),
            status: nn(i.writeBack.status),
            paidAt: nn(i.writeBack.paidAt),
            paidAmount: nn(i.writeBack.paidAmount),
          },
        },
        subscription: s
          ? {
              table: s.table,
              pk: s.pk,
              fields: {
                customer: s.customer,
                amount: s.amount,
                title: nn(s.title),
                startedAt: nn(s.startedAt),
                status: s.status,
              },
              interval: s.interval,
              statusMap: { pending: s.pending, active: s.active, cancelled: s.cancelled },
              push: s.push.length ? s.push : s.pending,
              writeBack: { paypalId: nn(s.writeBack.paypalId), status: nn(s.writeBack.status) },
            }
          : undefined,
      },
      policies: {},
      ...recommendedControls(timezone),
      rationale: Object.fromEntries(o.rationale.map((r) => [r.path, r.reason])),
      confidence: Object.fromEntries(
        Object.entries(o.confidence)
          .filter(([, v]) => typeof v === 'number')
          .map(([k, v]) => [k, Math.max(0, Math.min(1, v as number))]),
      ),
      generatedBy: model(),
    }),
  );
}
