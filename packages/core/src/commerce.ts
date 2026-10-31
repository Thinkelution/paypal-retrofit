import crypto from 'node:crypto';
import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { PAID_STATUSES } from './paypal/client.ts';
import type { OrderRecord } from './state/store.ts';
import { expectedTotal } from './terms.ts';
import { round2, toMoney, todayIso } from './util.ts';

/**
 * PayPal Orders for two kinds of buyer:
 *  - the business's own customers paying several open invoices at once from the customer portal, and
 *  - new buyers (people on the shop page, or AI shopping agents over MCP) buying from the catalogue.
 *
 * Prices always come from the business's own data, never from the buyer. A buyer (or their agent) only
 * gets an approval link: no money moves until a person approves the payment at PayPal. Captured orders
 * are written into the payments ledger; portal payments are recorded against each invoice.
 */

export interface CatalogItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
}

export async function loadCatalog(rf: Retrofit): Promise<CatalogItem[]> {
  const pm = rf.mapping.entities.product;
  if (!pm?.fields.price) return [];
  const rows = await rf.source.readTable(pm.table);
  // Products with an "active" style column set to 0 / false are not for sale.
  const forSale = (r: Record<string, unknown>) => {
    const flag = r.active ?? r.is_active ?? r.enabled;
    return flag === undefined || flag === null || !['0', 'false', 'no'].includes(String(flag).toLowerCase());
  };
  return rows
    .filter(forSale)
    .map((r) => ({
      id: String(r[pm.pk]),
      name: String(r[pm.fields.name] ?? '').trim(),
      description: pm.fields.description ? ((r[pm.fields.description] as string | null) ?? null) : null,
      price: round2(Number(r[pm.fields.price!] ?? 0)),
      currency: rf.mapping.currency,
    }))
    .filter((p) => p.name && p.price > 0);
}

export function searchCatalog(items: CatalogItem[], query?: string): CatalogItem[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return items;
  const words = q.split(/\s+/);
  return items
    .map((i) => {
      const hay = `${i.name} ${i.description ?? ''}`.toLowerCase();
      return { i, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.i);
}

export interface CheckoutInput {
  channel: OrderRecord['channel'];
  /** Catalogue purchase. */
  items?: Array<{ productId: string; quantity: number }>;
  /** Portal payment: legacy invoice keys, all belonging to `customerPk`. */
  invoices?: string[];
  customerPk?: string;
  buyer?: { name?: string; email?: string; agent?: string };
  returnUrl: string;
  cancelUrl: string;
  /** Charge the customer's saved PayPal (autopay) instead of sending them to approve. */
  vaultId?: string;
}

const approveLink = (o: any) =>
  o?.links?.find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href ?? null;

/** Creates the PayPal order and records it. Throws a readable error for anything the rules do not allow. */
export async function createCheckout(rf: Retrofit, input: CheckoutInput): Promise<OrderRecord> {
  const cur = rf.mapping.currency;
  const id = `ord_${crypto.randomBytes(6).toString('hex')}`;
  const items: OrderRecord['items'] = [];
  let invoices: OrderRecord['invoices'] = null;
  let description: string;

  if (input.invoices?.length) {
    if (!input.customerPk) throw new Error('customerPk is required for invoice payments');
    const wanted = new Set(input.invoices.map(String));
    const all = await loadInvoices(rf.source, rf.mapping, { pks: [...wanted] });
    invoices = [];
    for (const inv of all) {
      if (inv.customerPk !== input.customerPk) throw new Error(`${inv.number} is not your invoice`);
      const link = rf.state.getLink('invoice', inv.pk);
      if (!link || inv.state !== 'open' || PAID_STATUSES.includes(link.paypalStatus ?? ''))
        throw new Error(`${inv.number} cannot be paid here`);
      const balance = round2(expectedTotal(rf, inv.pk, inv.total) - (link.paypalPaid ?? 0));
      if (balance <= 0) continue;
      invoices.push({ legacyPk: inv.pk, number: inv.number, amount: balance });
      items.push({ legacyPk: inv.pk, name: `Invoice ${inv.number}`, quantity: 1, unitPrice: balance });
    }
    if (!invoices.length) throw new Error('Nothing to pay');
    description = `${rf.config.business.name}: ${invoices.map((i) => i.number).join(', ')}`;
  } else {
    const c = rf.mapping.commerce;
    if (!c.enabled) throw new Error(`${rf.config.business.name} does not sell online yet`);
    const catalog = new Map((await loadCatalog(rf)).map((p) => [p.id, p]));
    for (const it of input.items ?? []) {
      const p = catalog.get(String(it.productId));
      if (!p) throw new Error(`Unknown product ${it.productId}`);
      const quantity = Math.floor(Number(it.quantity ?? 1));
      if (!(quantity >= 1 && quantity <= c.maxQuantity))
        throw new Error(`Quantity must be between 1 and ${c.maxQuantity}`);
      items.push({ productId: p.id, name: p.name, quantity, unitPrice: p.price });
    }
    if (!items.length) throw new Error('Add at least one product');
    description = `${rf.config.business.name} order ${id}`;
  }
  const total = round2(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0));
  if (!input.invoices?.length && total > rf.mapping.commerce.maxOrderTotal)
    throw new Error(
      `Orders above ${toMoney(rf.mapping.commerce.maxOrderTotal)} ${cur} need to be arranged with ${rf.config.business.name} directly`,
    );

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: id,
        custom_id: `retrofit:${id}`,
        description: description.slice(0, 127),
        amount: {
          currency_code: cur,
          value: toMoney(total),
          breakdown: { item_total: { currency_code: cur, value: toMoney(total) } },
        },
        items: items.map((i) => ({
          name: i.name.slice(0, 127),
          quantity: String(i.quantity),
          unit_amount: { currency_code: cur, value: toMoney(i.unitPrice) },
          category: 'DIGITAL_GOODS',
        })),
      },
    ],
    payment_source: {
      paypal: input.vaultId
        ? { vault_id: input.vaultId }
        : {
            experience_context: {
              brand_name: rf.config.business.name.slice(0, 127),
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
    },
  };
  const order = await rf.paypal.createOrder(body, `retrofit-order-${id}`);
  const rec: OrderRecord = {
    id,
    paypalOrderId: order.id,
    channel: input.channel,
    status: 'CREATED',
    items,
    invoices,
    total,
    currency: cur,
    buyer: input.buyer || input.customerPk ? { ...input.buyer, customerPk: input.customerPk } : null,
    approveUrl: approveLink(order),
    captureId: null,
    fee: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  rf.state.saveOrder(rec);
  rf.emit('order', { id });
  rf.log.info(`order ${id} (${input.channel}) created for ${toMoney(total)} ${cur}`);
  return rf.state.getOrder(id)!;
}

/**
 * Captures an approved order (idempotent) and books it: portal payments are recorded against each
 * invoice in PayPal and written back; shop and agent sales go into the payments ledger.
 */
export async function finalizeCheckout(
  rf: Retrofit,
  idOrPayPalId: string,
): Promise<{ order: OrderRecord; summary: string } | null> {
  const rec = rf.state.getOrder(idOrPayPalId);
  if (!rec?.paypalOrderId) return null;
  if (rec.status === 'COMPLETED') return { order: rec, summary: `Order ${rec.id} already completed` };
  let o = await rf.paypal.getOrder(rec.paypalOrderId);
  if (o.status === 'APPROVED')
    o = await rf.paypal.captureOrder(rec.paypalOrderId, `retrofit-capture-${rec.id}`);
  if (o.status !== 'COMPLETED') {
    rf.state.saveOrder({ ...rec, status: o.status === 'VOIDED' ? 'CANCELLED' : rec.status });
    return { order: rf.state.getOrder(rec.id)!, summary: `Order ${rec.id} is ${o.status}` };
  }
  const capture = o.purchase_units?.[0]?.payments?.captures?.[0];
  const captureId = String(capture?.id ?? `${rec.paypalOrderId}-capture`);
  const feeValue = capture?.seller_receivable_breakdown?.paypal_fee?.value;
  const fee = feeValue !== undefined ? Number(feeValue) : null;
  const date = (capture?.create_time ?? new Date().toISOString()).slice(0, 10);

  if (rec.invoices?.length) {
    // Record the PayPal payment against each invoice, then share the capture fee by amount.
    for (const inv of rec.invoices) {
      const link = rf.state.getLink('invoice', inv.legacyPk);
      if (!link) continue;
      const r = await rf.paypal.recordInvoicePayment(
        link.paypalId,
        {
          method: 'PAYPAL',
          payment_date: date,
          amount: { currency_code: rec.currency, value: toMoney(inv.amount) },
          note: `${rec.channel === 'autopay' ? 'Paid automatically with saved PayPal' : 'Paid in the customer portal'} (PayPal order ${rec.paypalOrderId}, capture ${captureId})`,
        },
        `retrofit-portal-${rec.id}-${inv.legacyPk}`,
      );
      await rf.refreshInvoice(link.paypalId);
      if (fee !== null && r?.payment_id)
        rf.state.setPaymentFee(r.payment_id, round2((fee * inv.amount) / rec.total));
    }
  } else {
    rf.state.recordPayment({
      id: captureId,
      entity: 'order',
      legacyPk: rec.id,
      paypalId: rec.paypalOrderId,
      kind: 'payment',
      gross: rec.total,
      fee,
      currency: rec.currency,
      method: 'PAYPAL',
      occurredAt: date || todayIso(),
    });
  }
  rf.state.saveOrder({ ...rec, status: 'COMPLETED', captureId, fee });
  rf.emit('order', { id: rec.id });
  const summary = rec.invoices?.length
    ? `${rec.channel === 'autopay' ? 'Autopay' : 'Portal payment'} ${toMoney(rec.total)} ${rec.currency} for ${rec.invoices.map((i) => i.number).join(', ')}`
    : `${rec.channel === 'agent' ? 'Agent' : 'Shop'} order ${rec.id} paid: ${toMoney(rec.total)} ${rec.currency}`;
  rf.log.info(summary);
  return { order: rf.state.getOrder(rec.id)!, summary };
}
