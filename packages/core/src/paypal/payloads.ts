import type { LegacyInvoice, LegacySubscription } from '../entities.ts';
import { splitName, toMoney, todayIso } from '../util.ts';

export interface PayloadContext {
  currency: string;
  businessName: string;
  businessEmail?: string;
  website?: string;
  invoicePrefix: string;
  today?: Date;
}

/** Builds a PayPal Invoicing v2 draft from a legacy invoice. */
export function invoiceDraft(inv: LegacyInvoice, ctx: PayloadContext) {
  const c = inv.customer;
  if (!c) throw new Error(`Invoice ${inv.number} has no customer`);
  if (!c.email) throw new Error(`Customer of invoice ${inv.number} has no email address`);
  const today = todayIso(ctx.today);
  const dueInFuture = inv.due && inv.due > today;
  const items =
    inv.lines.length > 0
      ? inv.lines.map((l) => ({
          name: l.description.slice(0, 200),
          quantity: String(l.qty),
          unit_amount: { currency_code: ctx.currency, value: toMoney(l.unitPrice) },
          unit_of_measure: 'QUANTITY',
        }))
      : [
          {
            name: `Invoice ${inv.number}`,
            quantity: '1',
            unit_amount: { currency_code: ctx.currency, value: toMoney(inv.total) },
            unit_of_measure: 'AMOUNT',
          },
        ];

  const origin = [inv.issued && `issued ${inv.issued}`, inv.due && `due ${inv.due}`]
    .filter(Boolean)
    .join(', ');
  const address =
    c.line1 && c.country && /^[A-Za-z]{2}$/.test(c.country)
      ? {
          address_line_1: c.line1,
          admin_area_2: c.city,
          admin_area_1: c.state,
          postal_code: c.postal,
          country_code: c.country.toUpperCase(),
        }
      : undefined;

  return {
    detail: {
      invoice_number: `${ctx.invoicePrefix}${inv.number}`.slice(0, 127),
      reference: `legacy:${inv.pk}`,
      currency_code: ctx.currency,
      note:
        [inv.notes, origin ? `Originally ${origin}.` : undefined].filter(Boolean).join(' ').slice(0, 4000) ||
        undefined,
      memo: `Synced by paypal-retrofit from legacy record ${inv.pk}`,
      payment_term: dueInFuture
        ? { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: inv.due }
        : { term_type: 'DUE_ON_RECEIPT' },
    },
    invoicer: {
      business_name: ctx.businessName,
      ...(ctx.businessEmail ? { email_address: ctx.businessEmail } : {}),
      ...(ctx.website ? { website: ctx.website } : {}),
    },
    primary_recipients: [
      {
        billing_info: {
          name: splitName(c.name),
          email_address: c.email,
          ...(address ? { address } : {}),
        },
      },
    ],
    items,
    configuration: { allow_tip: false, tax_calculated_after_discount: true, tax_inclusive: false },
  };
}

export function productBody(ctx: PayloadContext) {
  return {
    name: `${ctx.businessName} retainers`.slice(0, 127),
    description: 'Recurring agreements managed by paypal-retrofit',
    type: 'SERVICE',
  };
}

export function planBody(sub: LegacySubscription, productId: string, interval: string, ctx: PayloadContext) {
  return {
    product_id: productId,
    name: sub.title.slice(0, 127),
    description: `Legacy agreement ${sub.pk}`,
    status: 'ACTIVE',
    billing_cycles: [
      {
        frequency: { interval_unit: interval, interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: toMoney(sub.amount), currency_code: ctx.currency } },
      },
    ],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
  };
}

export function subscriptionBody(
  sub: LegacySubscription,
  planId: string,
  ctx: PayloadContext & { returnUrl: string },
) {
  const c = sub.customer;
  if (!c?.email) throw new Error(`Subscription ${sub.pk} has no customer email`);
  return {
    plan_id: planId,
    custom_id: `legacy:${sub.pk}`,
    subscriber: { name: splitName(c.name), email_address: c.email },
    application_context: {
      brand_name: ctx.businessName.slice(0, 127),
      user_action: 'SUBSCRIBE_NOW',
      shipping_preference: 'NO_SHIPPING',
      return_url: ctx.returnUrl,
      cancel_url: ctx.returnUrl,
    },
  };
}
