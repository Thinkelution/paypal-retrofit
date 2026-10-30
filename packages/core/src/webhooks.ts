import { finalizeCheckout } from './commerce.ts';
import type { Retrofit } from './engine.ts';
import { PAID_STATUSES } from './paypal/client.ts';
import { toMoney } from './util.ts';

export interface WebhookResult {
  httpStatus: number;
  status: 'processed' | 'duplicate' | 'ignored' | 'rejected' | 'failed';
  summary: string;
}

const H = {
  algo: 'paypal-auth-algo',
  cert: 'paypal-cert-url',
  id: 'paypal-transmission-id',
  sig: 'paypal-transmission-sig',
  time: 'paypal-transmission-time',
} as const;

/**
 * Verifies a webhook with PayPal's verify-webhook-signature endpoint, stores it once (idempotent on the
 * event id), applies it to the legacy system, and only then reports success.
 */
export async function handleWebhook(
  rf: Retrofit,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
): Promise<WebhookResult> {
  const h = (k: string) => {
    const v = headers[k] ?? headers[k.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { httpStatus: 400, status: 'rejected', summary: 'Body is not JSON' };
  }
  if (!event?.id || !event?.event_type)
    return { httpStatus: 400, status: 'rejected', summary: 'Not a PayPal event' };

  const skip =
    process.env.RETROFIT_SKIP_WEBHOOK_VERIFY === '1' && rf.config.env.paypalEnvironment !== 'PRODUCTION';
  if (!skip) {
    const webhookId = rf.config.env.paypalWebhookId ?? rf.state.getMeta('paypal.webhookId');
    if (!webhookId)
      return {
        httpStatus: 400,
        status: 'rejected',
        summary: 'PAYPAL_WEBHOOK_ID is not configured; cannot verify',
      };
    const missing = Object.values(H).filter((k) => !h(k));
    if (missing.length)
      return { httpStatus: 400, status: 'rejected', summary: `Missing headers: ${missing.join(', ')}` };
    try {
      const v = await rf.paypal.verifyWebhookSignature({
        auth_algo: h(H.algo)!,
        cert_url: h(H.cert)!,
        transmission_id: h(H.id)!,
        transmission_sig: h(H.sig)!,
        transmission_time: h(H.time)!,
        webhook_id: webhookId,
        webhook_event: event,
      });
      if (v.verification_status !== 'SUCCESS')
        return { httpStatus: 400, status: 'rejected', summary: 'Signature verification failed' };
    } catch (e) {
      return {
        httpStatus: 502,
        status: 'failed',
        summary: `Could not verify signature: ${(e as Error).message}`,
      };
    }
  }

  if (!rf.state.recordEvent(event.id, event.event_type, event)) {
    const prior = rf.state.getEvent(event.id);
    if (prior && prior.status !== 'failed')
      return { httpStatus: 200, status: 'duplicate', summary: `Already handled ${event.id}` };
  }

  try {
    const summary = await applyEvent(rf, event);
    rf.state.finishEvent(
      event.id,
      summary ? 'processed' : 'ignored',
      summary ?? `No handler for ${event.event_type}`,
    );
    rf.emit('webhook', { id: event.id, type: event.event_type, summary });
    return { httpStatus: 200, status: summary ? 'processed' : 'ignored', summary: summary ?? 'ignored' };
  } catch (e) {
    rf.state.finishEvent(event.id, 'failed', null, (e as Error).message);
    // 500 makes PayPal retry later; reconciliation is the backstop.
    return { httpStatus: 500, status: 'failed', summary: (e as Error).message };
  }
}

async function applyEvent(rf: Retrofit, event: any): Promise<string | null> {
  const type: string = event.event_type;
  const r = event.resource ?? {};

  if (type.startsWith('INVOICING.INVOICE.')) {
    const id: string | undefined = r.id ?? r.invoice?.id;
    if (!id) return null;
    const res = await rf.refreshInvoice(id);
    return res?.summary ?? `Invoice ${id} is not managed by retrofit`;
  }

  if (type.startsWith('CHECKOUT.ORDER.')) {
    // A buyer approved (or completed) a portal, shop or agent checkout: capture and book it.
    const res = r.id ? await finalizeCheckout(rf, String(r.id)) : null;
    return res?.summary ?? null;
  }

  if (type.startsWith('PAYMENT.CAPTURE.')) {
    const orderId = r.supplementary_data?.related_ids?.order_id;
    if (orderId && rf.state.getOrder(String(orderId))) {
      const res = await finalizeCheckout(rf, String(orderId));
      return res?.summary ?? null;
    }
    // Invoice payments carry the merchant invoice number in invoice_id.
    const number: string | undefined = r.invoice_id;
    const link = number ? await findInvoiceLinkByNumber(rf, number) : undefined;
    if (!link) return null;
    const res = await rf.refreshInvoice(link.paypalId);
    // Captures carry PayPal's fee; keep it so the books can show gross, fee and net.
    const fee = r.seller_receivable_breakdown?.paypal_fee?.value;
    if (type === 'PAYMENT.CAPTURE.COMPLETED' && r.id && fee !== undefined) {
      rf.state.setPaymentFee(String(r.id), Number(fee));
      return `${res?.summary ?? 'Payment captured'}; PayPal fee ${fee} recorded`;
    }
    return res?.summary ?? null;
  }

  if (type.startsWith('BILLING.SUBSCRIPTION.')) {
    const link = r.id ? rf.state.findLinkByPayPalId(r.id) : undefined;
    if (!link) return null;
    if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') {
      rf.state.openDiscrepancy({
        entity: 'subscription',
        legacyPk: link.legacyPk,
        paypalId: link.paypalId,
        kind: 'payment_failed',
        detail: `A recurring payment failed for subscription ${link.paypalId}`,
        suggestion: 'Contact the customer; PayPal retries up to the failure threshold.',
      });
      return `Subscription ${link.paypalId} payment failed`;
    }
    await rf.applySubscriptionStatus(link, r.status ?? type.split('.').pop());
    return `Subscription ${link.paypalId} is ${r.status ?? type.split('.').pop()}`;
  }

  if (type === 'PAYMENT.SALE.COMPLETED') {
    const link = r.billing_agreement_id ? rf.state.findLinkByPayPalId(r.billing_agreement_id) : undefined;
    if (!link) return null;
    const amount = Number(r.amount?.total ?? 0);
    rf.state.upsertLink({
      ...link,
      paypalPaid: (link.paypalPaid ?? 0) + amount,
      paypalPaidAt: r.create_time ?? new Date().toISOString(),
      paypalTransactionId: r.id,
    });
    rf.emit('subscription', { pk: link.legacyPk });
    return `Subscription ${link.paypalId} collected ${toMoney(amount)}`;
  }

  if (type.startsWith('CUSTOMER.DISPUTE.')) {
    const tx = r.disputed_transactions?.[0] ?? {};
    const link =
      (tx.invoice_number && (await findInvoiceLinkByNumber(rf, tx.invoice_number))) ||
      (tx.seller_transaction_id &&
        rf.state.listLinks('invoice').find((l) => l.paypalTransactionId === tx.seller_transaction_id)) ||
      undefined;
    // A dispute naming an invoice this business does not have belongs to another account or workspace.
    if (!link && tx.invoice_number) return null;
    const pk = link?.legacyPk ?? null;
    if (type === 'CUSTOMER.DISPUTE.RESOLVED') {
      for (const d of rf.state
        .listDiscrepancies()
        .filter((d) => d.kind === 'dispute' && d.paypalId === r.dispute_id)) {
        rf.state.resolveDiscrepancy(
          d.id,
          `Dispute resolved: ${r.dispute_outcome?.outcome_code ?? r.status ?? 'closed'}`,
        );
      }
      return `Dispute ${r.dispute_id} resolved`;
    }
    rf.state.openDiscrepancy({
      entity: 'invoice',
      legacyPk: pk,
      paypalId: r.dispute_id,
      kind: 'dispute',
      detail: `Buyer dispute ${r.dispute_id}: ${String(r.reason ?? 'reason unknown')
        .replace(/_/g, ' ')
        .toLowerCase()} (${String(r.status ?? 'open')
        .toLowerCase()
        .replace(
          /_/g,
          ' ',
        )}), ${r.dispute_amount?.value ?? '?'} ${r.dispute_amount?.currency_code ?? ''}`.trim(),
      suggestion: 'Ask the Support agent to draft a response with evidence from the legacy record.',
    });
    return `Dispute ${r.dispute_id} ${type.endsWith('CREATED') ? 'opened' : 'updated'}`;
  }
  return null;
}

async function findInvoiceLinkByNumber(rf: Retrofit, paypalNumber: string) {
  const prefix = rf.config.paypal.invoicePrefix ?? '';
  const number = prefix && paypalNumber.startsWith(prefix) ? paypalNumber.slice(prefix.length) : paypalNumber;
  const im = rf.mapping.entities.invoice;
  const rows = await rf.source.readTable(im.table, { column: im.fields.number, in: [number] });
  const pk = rows[0]?.[im.pk];
  return pk === undefined ? undefined : rf.state.getLink('invoice', String(pk));
}

export function isPaidStatus(s: string | null | undefined) {
  return !!s && PAID_STATUSES.includes(s);
}
