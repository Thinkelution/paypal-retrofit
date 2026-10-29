import { z } from 'zod';
import { ACTION_KINDS } from '../types.ts';

const col = z.string().min(1);

export const CustomerMapping = z.object({
  table: col,
  pk: col,
  fields: z.object({
    name: col,
    email: col,
    phone: col.optional(),
    line1: col.optional(),
    city: col.optional(),
    state: col.optional(),
    postal: col.optional(),
    country: col.optional(),
  }),
});

export const ProductMapping = z.object({
  table: col,
  pk: col,
  fields: z.object({ name: col, description: col.optional(), price: col.optional() }),
});

export const InvoiceMapping = z.object({
  table: col,
  pk: col,
  fields: z.object({
    number: col,
    customer: col,
    issued: col.optional(),
    due: col.optional(),
    status: col,
    total: col,
    notes: col.optional(),
  }),
  lines: z
    .object({
      table: col,
      fk: col,
      fields: z.object({ description: col, qty: col, unitPrice: col, product: col.optional() }),
    })
    .optional(),
  statusMap: z.object({
    open: z.array(z.string()),
    paid: z.array(z.string()),
    cancelled: z.array(z.string()),
  }),
  /** Legacy statuses that should be pushed to PayPal by `sync`. */
  push: z.array(z.string()).min(1),
  writeBack: z
    .object({
      paypalId: col.optional(),
      payLink: col.optional(),
      status: col.optional(),
      paidAt: col.optional(),
      paidAmount: col.optional(),
    })
    .default({}),
});

export const SubscriptionMapping = z.object({
  table: col,
  pk: col,
  fields: z.object({
    customer: col,
    amount: col,
    title: col.optional(),
    startedAt: col.optional(),
    status: col,
  }),
  interval: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']).default('MONTH'),
  statusMap: z.object({
    pending: z.array(z.string()),
    active: z.array(z.string()),
    cancelled: z.array(z.string()),
  }),
  push: z.array(z.string()).min(1),
  writeBack: z.object({ paypalId: col.optional(), status: col.optional() }).default({}),
});

export const PolicyModeSchema = z.enum(['auto', 'confirm', 'never']);

export const DEFAULT_POLICIES: Record<(typeof ACTION_KINDS)[number], z.infer<typeof PolicyModeSchema>> = {
  create_invoice: 'auto',
  send_invoice: 'auto',
  update_invoice: 'auto',
  send_reminder: 'confirm',
  cancel_invoice: 'confirm',
  record_payment: 'confirm',
  create_refund: 'confirm',
  create_subscription: 'confirm',
  cancel_subscription: 'confirm',
  accept_dispute: 'never',
};

export const RetrofitMapping = z.object({
  version: z.literal(1),
  currency: z.string().length(3).default('USD'),
  entities: z.object({
    customer: CustomerMapping,
    product: ProductMapping.optional(),
    invoice: InvoiceMapping,
    subscription: SubscriptionMapping.optional(),
  }),
  policies: z.record(z.enum(ACTION_KINDS), PolicyModeSchema).default({}),
  /** Why each part of the mapping was chosen. Keys are dotted paths such as "invoice.fields.total". */
  rationale: z.record(z.string(), z.string()).default({}),
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
  generatedBy: z.string().default('manual'),
});

export type RetrofitMapping = z.infer<typeof RetrofitMapping>;
export type InvoiceMapping = z.infer<typeof InvoiceMapping>;
export type CustomerMapping = z.infer<typeof CustomerMapping>;
export type SubscriptionMapping = z.infer<typeof SubscriptionMapping>;
export type ProductMapping = z.infer<typeof ProductMapping>;
