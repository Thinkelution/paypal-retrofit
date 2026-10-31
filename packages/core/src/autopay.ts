import { createCheckout, finalizeCheckout } from './commerce.ts';
import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { PAID_STATUSES } from './paypal/client.ts';
import type { AutopayRecord } from './state/store.ts';
import { expectedTotal } from './terms.ts';
import type { ActionOrigin, ActionRecord } from './types.ts';
import { round2, todayIso, toMoney } from './util.ts';

/**
 * Autopay: a customer saves their PayPal with the business once (PayPal Vault: a setup token they approve at
 * PayPal, exchanged for a payment token), and their invoices are paid on the due date without a reminder.
 * The customer can set a cap per invoice and turn it off in the portal or in their PayPal account. Each
 * charge is an action under the owner's rules (amount rules, daily limits), and a declined charge falls back
 * to the normal reminders instead of being retried.
 */

export async function startAutopay(
  rf: Retrofit,
  customerPk: string,
  opts: { returnUrl: string; cancelUrl: string; maxAmount?: number | null },
): Promise<{ approveUrl: string; setupTokenId: string }> {
  const r = await rf.paypal.createSetupToken(
    {
      payment_source: {
        paypal: {
          description: `Pay ${rf.config.business.name} invoices automatically on their due date`.slice(
            0,
            127,
          ),
          usage_type: 'MERCHANT',
          customer_type: 'CONSUMER',
          permit_multiple_payment_tokens: false,
          experience_context: {
            brand_name: rf.config.business.name.slice(0, 127),
            shipping_preference: 'NO_SHIPPING',
            return_url: opts.returnUrl,
            cancel_url: opts.cancelUrl,
          },
        },
      },
    },
    `retrofit-autopay-${customerPk}-${Date.now()}`,
  );
  const approveUrl = r?.links?.find((l: any) => l.rel === 'approve')?.href;
  if (!approveUrl) throw new Error('PayPal did not return an approval link');
  const cap = opts.maxAmount && opts.maxAmount > 0 ? round2(opts.maxAmount) : null;
  rf.state.saveAutopay({
    customerPk,
    status: rf.state.getAutopay(customerPk)?.status === 'active' ? 'active' : 'pending',
    setupTokenId: r.id,
    paypalCustomerId: r.customer?.id ?? null,
    maxAmount: cap,
    lastError: null,
  });
  rf.emit('autopay', { customerPk });
  return { approveUrl, setupTokenId: r.id };
}

/** After the customer approves at PayPal: the setup token becomes a saved payment token. */
export async function confirmAutopay(rf: Retrofit, customerPk: string, setupTokenId?: string) {
  const rec = rf.state.getAutopay(customerPk);
  const id = setupTokenId || rec?.setupTokenId;
  if (!rec || !id || (rec.setupTokenId && id !== rec.setupTokenId))
    throw new Error('No autopay set-up is waiting for this customer.');
  const t = await rf.paypal.createPaymentToken(id, `retrofit-autopay-token-${id}`);
  if (rec.paymentTokenId && rec.paymentTokenId !== t.id)
    await rf.paypal.deletePaymentToken(rec.paymentTokenId).catch(() => undefined);
  const saved = rf.state.saveAutopay({
    customerPk,
    status: 'active',
    paymentTokenId: t.id,
    paypalCustomerId: t.customer?.id ?? rec.paypalCustomerId,
    payerEmail: t.payment_source?.paypal?.email_address ?? null,
    lastError: null,
  });
  rf.log.info(`autopay on for customer ${customerPk}`);
  rf.emit('autopay', { customerPk });
  return saved;
}

export async function stopAutopay(rf: Retrofit, customerPk: string, reason = 'Turned off by the customer') {
  const rec = rf.state.getAutopay(customerPk);
  if (!rec || rec.status === 'off') return rec;
  if (rec.paymentTokenId) await rf.paypal.deletePaymentToken(rec.paymentTokenId).catch(() => undefined);
  const saved = rf.state.saveAutopay({ customerPk, status: 'off', paymentTokenId: null, lastError: reason });
  rf.emit('autopay', { customerPk });
  return saved;
}

export interface AutopayItem {
  legacyPk: string;
  number: string;
  customerPk: string;
  customer: string;
  amount: number;
  due: string;
}

/** Whether autopay will pay this invoice itself: collections hold their reminders for these. */
export function autopayCovers(rf: Retrofit, customerPk: string, legacyPk: string, amount: number) {
  const a = rf.state.getAutopay(customerPk);
  if (a?.status !== 'active') return false;
  if (a.maxAmount != null && amount > a.maxAmount) return false;
  return !failedCharge(rf, legacyPk);
}

const failedCharge = (rf: Retrofit, legacyPk: string) =>
  rf.state.actionsFor('charge_autopay', 'invoice', legacyPk).some((x) => x.status === 'failed');

/** Invoices of customers on autopay that are due, open in PayPal, within the customer's cap, and not on hold. */
export async function planAutopay(rf: Retrofit, today = todayIso()): Promise<AutopayItem[]> {
  const active = new Map(rf.state.listAutopay('active').map((a) => [a.customerPk, a]));
  if (!active.size) return [];
  const disputes = new Set(
    rf.state
      .listDiscrepancies()
      .filter((d) => d.kind === 'dispute')
      .map((d) => d.legacyPk),
  );
  const pks = rf.state
    .listLinks()
    .filter(
      (l) =>
        l.entity === 'invoice' &&
        !PAID_STATUSES.includes(l.paypalStatus ?? '') &&
        !['CANCELLED', 'REFUNDED', 'DRAFT'].includes(l.paypalStatus ?? ''),
    )
    .map((l) => l.legacyPk);
  const items: AutopayItem[] = [];
  for (const inv of pks.length ? await loadInvoices(rf.source, rf.mapping, { pks }) : []) {
    const a = active.get(inv.customerPk);
    if (!a || inv.state !== 'open' || !inv.due || inv.due > today || disputes.has(inv.pk)) continue;
    // A promise, a question or a payment plan means the customer wants to handle this one themselves.
    if (rf.state.listRequests({ status: 'open', legacyPk: inv.pk }).length) continue;
    if (rf.state.getPlan(inv.pk)?.status === 'active') continue;
    const history = rf.state.actionsFor('charge_autopay', 'invoice', inv.pk);
    if (history.some((x) => ['pending', 'scheduled', 'executed', 'failed'].includes(x.status))) continue;
    const link = rf.state.getLink('invoice', inv.pk)!;
    const amount = round2(expectedTotal(rf, inv.pk, inv.total) - (link.paypalPaid ?? 0));
    if (amount <= 0 || (a.maxAmount != null && amount > a.maxAmount)) continue;
    items.push({
      legacyPk: inv.pk,
      number: inv.number,
      customerPk: inv.customerPk,
      customer: inv.customer?.name ?? inv.customerPk,
      amount,
      due: inv.due,
    });
  }
  return items;
}

export async function runAutopay(
  rf: Retrofit,
  opts: { today?: string; origin?: ActionOrigin } = {},
): Promise<ActionRecord[]> {
  const out: ActionRecord[] = [];
  for (const it of await planAutopay(rf, opts.today)) {
    out.push(
      await rf.propose({
        origin: opts.origin ?? 'sync',
        kind: 'charge_autopay',
        target: { entity: 'invoice', legacyPk: it.legacyPk, label: it.number },
        payload: { amount: it.amount },
        reason: `${it.customer} pays by autopay; ${it.number} was due ${it.due}`,
      }),
    );
  }
  return out;
}

/** Charges the customer's saved PayPal for one invoice and books it like a portal payment. */
export async function chargeAutopay(rf: Retrofit, legacyPk: string) {
  const [inv] = await loadInvoices(rf.source, rf.mapping, { pks: [legacyPk] });
  if (!inv) throw new Error(`Invoice ${legacyPk} not found`);
  const a: AutopayRecord | null = rf.state.getAutopay(inv.customerPk);
  if (a?.status !== 'active' || !a.paymentTokenId)
    throw new Error(`${inv.customer?.name ?? 'The customer'} is not on autopay`);
  try {
    const order = await createCheckout(rf, {
      channel: 'autopay',
      invoices: [legacyPk],
      customerPk: inv.customerPk,
      vaultId: a.paymentTokenId,
      returnUrl: '',
      cancelUrl: '',
    });
    const done = await finalizeCheckout(rf, order.id);
    if (done?.order.status !== 'COMPLETED')
      throw new Error(`PayPal did not complete the charge (${done?.order.status ?? 'unknown'})`);
    rf.state.saveAutopay({
      customerPk: inv.customerPk,
      status: 'active',
      lastChargeAt: new Date().toISOString(),
      lastError: null,
    });
    return {
      orderId: done.order.id,
      paypalOrderId: done.order.paypalOrderId,
      captureId: done.order.captureId,
      amount: done.order.total,
      summary: `Charged ${toMoney(done.order.total)} ${done.order.currency} to ${a.payerEmail ?? 'saved PayPal'}`,
    };
  } catch (e) {
    rf.state.saveAutopay({ customerPk: inv.customerPk, status: 'active', lastError: (e as Error).message });
    throw e;
  }
}
