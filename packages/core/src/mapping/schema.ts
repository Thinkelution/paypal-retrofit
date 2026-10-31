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

/** Money the business owes: contractor and supplier bills, paid to the payee's PayPal email with Payouts. */
export const PayableMapping = z.object({
  table: col,
  pk: col,
  fields: z.object({
    number: col.optional(),
    payee: col,
    /** The payee's PayPal email. */
    email: col,
    amount: col,
    due: col.optional(),
    description: col.optional(),
    status: col,
  }),
  statusMap: z.object({
    open: z.array(z.string()),
    paid: z.array(z.string()),
    cancelled: z.array(z.string()).default([]),
  }),
  writeBack: z
    .object({ status: col.optional(), paidAt: col.optional(), reference: col.optional() })
    .default({}),
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
  // Always waits for the owner, whatever the policy says (see the engine).
  submit_dispute_evidence: 'confirm',
  // A first payment to a payee, or one to a changed PayPal email, always waits (see the engine).
  pay_supplier: 'confirm',
  offer_payment_plan: 'confirm',
  apply_late_fee: 'confirm',
  expire_discount: 'auto',
  send_statement: 'confirm',
  // The customer agreed to it; the owner's amount rules and daily limits still apply.
  charge_autopay: 'auto',
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

/**
 * A rule for some customers, written by the owner (often in plain English): which customers it covers, and
 * how to treat them. Collections and late fees respect it.
 */
export const CustomerRule = z.object({
  match: z
    .object({
      /** Customer keys. */
      customers: z.array(z.string()).optional(),
      /** Any of these words in the customer's name (case-insensitive), e.g. "school". */
      nameContains: z.array(z.string().min(2)).optional(),
      /** Email domains, e.g. "harborview.example". */
      emailDomains: z.array(z.string().min(3)).optional(),
    })
    .refine((m) => Boolean(m.customers?.length || m.nameContains?.length || m.emailDomains?.length), {
      message: 'A customer rule needs at least one way to match customers',
    }),
  /** No reminders before this day of the month (for example when they are paid on the 20th). */
  noRemindersBeforeDay: z.number().int().min(2).max(28).optional(),
  /** Never send reminders; the owner deals with them in person. */
  noReminders: z.boolean().optional(),
  noLateFees: z.boolean().optional(),
  /** The owner's own words. */
  note: z.string().optional(),
});

/**
 * The payment plans the business will agree to when a customer (or their AI assistant) asks. Inside
 * `autoAccept` a plan is agreed on the spot; inside the outer limits it waits for the owner; beyond them the
 * customer gets a counter-offer.
 */
export const PlanPolicy = z.object({
  maxInstallments: z.number().int().min(2).max(12).default(4),
  /** Longest gap between payments. */
  maxIntervalDays: z.number().int().min(7).max(92).default(30),
  /** Latest first payment, in days from today. */
  maxDaysToFirstPayment: z.number().int().min(0).max(60).default(14),
  autoAccept: z
    .object({
      /** Balance up to which a plan can be agreed without the owner. */
      maxAmount: z.number().nonnegative().default(1500),
      maxInstallments: z.number().int().min(2).max(12).default(3),
      /** Share of past invoices the customer paid on time (customers with no history wait for the owner). */
      minOnTimeRate: z.number().min(0).max(1).default(0.5),
    })
    .default({}),
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
    payable: PayableMapping.optional(),
  }),
  policies: z.record(z.enum(ACTION_KINDS), PolicyModeSchema).default({}),
  rules: z.array(ApprovalRule).default([]),
  limits: z.array(ActionLimit).default([]),
  quietHours: QuietHours.optional(),
  collections: CollectionsPlaybook.default({}),
  terms: PaymentTerms.default({}),
  commerce: Commerce.default({}),
  plans: PlanPolicy.default({}),
  customerRules: z.array(CustomerRule).default([]),
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
export type PlanPolicy = z.infer<typeof PlanPolicy>;
export type CustomerRule = z.infer<typeof CustomerRule>;

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
export type PayableMapping = z.infer<typeof PayableMapping>;
