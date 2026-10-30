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
  offer_payment_plan: 'confirm',
  apply_late_fee: 'confirm',
  expire_discount: 'auto',
  send_statement: 'confirm',
};

/** A conditional policy: the first rule whose kind and amount range match decides the mode. */
export const ApprovalRule = z.object({
  kind: z.enum(ACTION_KINDS),
  mode: PolicyModeSchema,
  /** Applies when the action's amount is at most this. */
  maxAmount: z.number().nonnegative().optional(),
  /** Applies when the action's amount is at least this. */
  minAmount: z.number().nonnegative().optional(),
  note: z.string().optional(),
});

/** Caps on what may run automatically per calendar day (in the business time zone). Over the cap, "auto" becomes "confirm". */
export const ActionLimit = z.object({
  kind: z.enum(ACTION_KINDS),
  perDay: z.number().int().positive().optional(),
  amountPerDay: z.number().positive().optional(),
});

/** Customer-facing actions are held until business hours instead of going out at night. */
export const QuietHours = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().default('UTC'),
  weekends: z.boolean().default(true),
  kinds: z.array(z.enum(ACTION_KINDS)).default(['send_reminder', 'offer_payment_plan']),
});

export const CollectionStep = z.object({
  afterDaysOverdue: z.number().int().min(0),
  tone: z.enum(['friendly', 'firm', 'final']),
});

export const CollectionsPlaybook = z.object({
  steps: z.array(CollectionStep).default([
    { afterDaysOverdue: 3, tone: 'friendly' },
    { afterDaysOverdue: 14, tone: 'firm' },
    { afterDaysOverdue: 30, tone: 'final' },
  ]),
  /** Never remind the same invoice more often than this. */
  minDaysBetween: z.number().int().min(1).default(5),
  /** Notes containing these mean the customer promised to pay: hold reminders. */
  promiseKeywords: z.array(z.string()).default(['promise', 'promised', 'will pay', 'paying on', 'pay by']),
  /** Notes containing these mean the customer asked to pay in parts: offer a payment plan instead. */
  planKeywords: z.array(z.string()).default(['split', 'instal', 'payment plan', 'in parts', 'installment']),
  /** Hold reminders for this many days after a promise note (counted from the invoice due date). */
  promiseGraceDays: z.number().int().min(0).default(10),
});

/** Payment terms the owner sets: a late fee after a grace period, and a discount for paying early. */
export const PaymentTerms = z.object({
  lateFee: z
    .object({
      kind: z.enum(['percent', 'flat']),
      /** Percent of the amount due, or a flat amount in the mapping currency. */
      amount: z.number().positive(),
      /** Days overdue before the fee is added. */
      afterDays: z.number().int().min(0).default(30),
      label: z.string().default('Late payment fee'),
    })
    .optional(),
  earlyDiscount: z
    .object({
      percent: z.number().positive().max(50),
      /** Days from the invoice date during which the discount applies. */
      withinDays: z.number().int().min(1).default(10),
    })
    .optional(),
});

/** Agentic commerce: a catalogue from the product table that buyers' agents can check out through PayPal Orders. */
export const Commerce = z.object({
  enabled: z.boolean().default(false),
  /** Largest order a buyer (or a buyer's agent) can create. */
  maxOrderTotal: z.number().positive().default(2000),
  maxQuantity: z.number().int().positive().default(20),
  /** One line shown to buyers' agents about what the business sells. */
  description: z.string().optional(),
});

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
  rules: z.array(ApprovalRule).default([]),
  limits: z.array(ActionLimit).default([]),
  quietHours: QuietHours.optional(),
  collections: CollectionsPlaybook.default({}),
  terms: PaymentTerms.default({}),
  commerce: Commerce.default({}),
  /** Why each part of the mapping was chosen. Keys are dotted paths such as "invoice.fields.total". */
  rationale: z.record(z.string(), z.string()).default({}),
  confidence: z.record(z.string(), z.number().min(0).max(1)).default({}),
  generatedBy: z.string().default('manual'),
});

export type RetrofitMapping = z.infer<typeof RetrofitMapping>;
export type ApprovalRule = z.infer<typeof ApprovalRule>;
export type ActionLimit = z.infer<typeof ActionLimit>;
export type QuietHours = z.infer<typeof QuietHours>;
export type CollectionsPlaybook = z.infer<typeof CollectionsPlaybook>;
export type PaymentTerms = z.infer<typeof PaymentTerms>;
export type Commerce = z.infer<typeof Commerce>;

/**
 * Controls retrofit recommends for a new mapping: small refunds run on their own, big ones and daily
 * totals need a person, and reminders are not sent at night or at weekends.
 */
export function recommendedControls(timezone = 'UTC') {
  return {
    rules: [
      { kind: 'create_refund', mode: 'auto', maxAmount: 100, note: 'Small refunds run automatically' },
      {
        kind: 'record_payment',
        mode: 'auto',
        maxAmount: 250,
        note: 'Small payments received outside PayPal are recorded automatically',
      },
    ] satisfies ApprovalRule[],
    limits: [
      { kind: 'create_refund', amountPerDay: 500 },
      { kind: 'send_reminder', perDay: 40 },
    ] satisfies ActionLimit[],
    quietHours: {
      start: '20:00',
      end: '08:00',
      timezone,
      weekends: true,
      kinds: ['send_reminder', 'offer_payment_plan', 'apply_late_fee', 'send_statement'],
    } satisfies QuietHours,
  };
}
export type InvoiceMapping = z.infer<typeof InvoiceMapping>;
export type CustomerMapping = z.infer<typeof CustomerMapping>;
export type SubscriptionMapping = z.infer<typeof SubscriptionMapping>;
export type ProductMapping = z.infer<typeof ProductMapping>;
