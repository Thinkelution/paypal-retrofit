import { KIND_LABEL } from './digest.ts';
import type { Retrofit } from './engine.ts';
import { loadBills } from './payouts.ts';
import { toMoney } from './util.ts';

/**
 * The money trail for one invoice or subscription: every step in order, with who caused it. Actions show
 * who proposed them (sync, the agent, the owner, a customer in the portal) and which rule decided whether
 * they ran; webhooks show what PayPal reported; write-backs show exactly which columns of the business's own
 * system retrofit changed. Built from retrofit's state; nothing here is inferred.
 */

export interface TrailStep {
  at: string;
  kind:
    'link' | 'action' | 'webhook' | 'payment' | 'writeback' | 'request' | 'order' | 'adjustment' | 'message';
  /** Who or what caused the step. */
  by: string;
  title: string;
  detail?: string;
  status?: string;
}

const ORIGIN: Record<string, string> = {
  sync: 'sync',
  agent: 'Ops agent',
  dashboard: 'owner (console)',
  cli: 'owner (command line)',
  reconcile: 'reconciler',
  portal: 'customer (portal)',
  inbox: 'customer (email)',
};

export async function moneyTrail(
  rf: Retrofit,
  entity: 'invoice' | 'subscription' | 'payable',
  legacyPk: string,
): Promise<{ entity: string; legacyPk: string; number: string | null; steps: TrailStep[] }> {
  const steps: TrailStep[] = [];
  const link = rf.state.getLink(entity, legacyPk);
  const cur = rf.mapping.currency;
  let number: string | null = null;
  if (entity === 'invoice') {
    try {
      number = (await rf.invoice(legacyPk)).number;
    } catch {
      number = null;
    }
  }

  if (link)
    steps.push({
      at: link.createdAt,
      kind: 'link',
      by: 'sync',
      title: `Linked to PayPal ${link.paypalKind} ${link.paypalId}`,
      detail: link.payLink ? `Pay link ${link.payLink}` : undefined,
      status: link.paypalStatus ?? undefined,
    });

  for (const a of rf.state
    .listActions(undefined, 2000)
    .filter((x) => x.target.entity === entity && x.target.legacyPk === legacyPk)) {
    steps.push({
      at: a.createdAt,
      kind: 'action',
      by: ORIGIN[a.origin] ?? a.origin,
      title: `${KIND_LABEL[a.kind] ?? a.kind} proposed${a.amount != null ? ` (${toMoney(a.amount)} ${cur})` : ''}`,
      detail: [a.reason, a.policyReason ? `Rule: ${a.policyReason}` : null].filter(Boolean).join(' · '),
      status: a.status,
    });
    if (a.decidedAt && a.status !== 'pending')
      steps.push({
        at: a.decidedAt,
        kind: 'action',
        by: a.policy === 'auto' ? 'rules (ran on its own)' : 'owner',
        title: `${KIND_LABEL[a.kind] ?? a.kind} ${a.status}`,
        detail: summarizeResult(a.result),
        status: a.status,
      });
  }

  // Orders, requests and adjustments belong to invoices (a bill's key can equal an invoice's).
  const orders =
    entity === 'invoice'
      ? rf.state.listOrders(1000).filter((o) => o.invoices?.some((i) => i.legacyPk === legacyPk))
      : [];
  for (const o of orders)
    steps.push({
      at: o.createdAt,
      kind: 'order',
      by:
        o.channel === 'autopay'
          ? 'autopay (saved PayPal)'
          : o.buyer?.agent
            ? `customer's assistant (${o.buyer.agent})`
            : 'customer (portal)',
      title: `PayPal order ${o.paypalOrderId} for ${toMoney(o.total)} ${o.currency}`,
      detail:
        o.invoices && o.invoices.length > 1
          ? `Covers ${o.invoices.map((i) => i.number).join(', ')}`
          : undefined,
      status: o.status,
    });

  const payouts = entity === 'payable' ? rf.state.listPayouts(legacyPk) : [];
  if (entity === 'payable') number = (await loadBills(rf, [legacyPk]))[0]?.number ?? null;
  for (const p of payouts)
    steps.push({
      at: p.createdAt,
      kind: 'payment',
      by: 'PayPal Payouts',
      title: `Payout ${p.batchId}: ${toMoney(p.amount)} ${p.currency} to ${p.receiver}`,
      detail:
        [
          p.transactionId ? `transaction ${p.transactionId}` : null,
          p.fee != null ? `PayPal fee ${toMoney(p.fee)}` : null,
          p.error,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      status: p.status,
    });

  for (const e of rf.state.eventsMentioning([
    link?.paypalId ?? '',
    ...orders.map((o) => o.paypalOrderId ?? ''),
    ...payouts.flatMap((p) => [p.batchId, p.itemId ?? '']),
  ]))
    steps.push({
      at: e.receivedAt,
      kind: 'webhook',
      by: 'PayPal (verified webhook)',
      title: e.type,
      detail: e.summary ?? e.error ?? undefined,
      status: e.status,
    });

  for (const p of rf.state.listPayments().filter((x) => x.legacyPk === legacyPk && x.entity === entity))
    steps.push({
      // A payment date has no time: order it by when retrofit recorded it that day (else at the end of it).
      at:
        p.occurredAt.length > 10
          ? p.occurredAt
          : p.recordedAt.startsWith(p.occurredAt)
            ? p.recordedAt
            : `${p.occurredAt}T23:59:59.999Z`,
      kind: 'payment',
      by: p.method === 'PAYPAL' ? 'PayPal' : 'recorded payment',
      title: `${p.kind.replace('_', ' ')}: ${toMoney(p.gross)} ${p.currency}${p.fee != null ? `, PayPal fee ${toMoney(p.fee)}` : ''}`,
      detail: `Method ${p.method} · id ${p.id}`,
    });

  for (const w of rf.state.listWritebacks(entity, legacyPk))
    steps.push({
      at: w.createdAt,
      kind: 'writeback',
      by: 'retrofit',
      title: w.kind === 'insert' ? 'Added to your system' : 'Written back to your system',
      detail: Object.entries(w.patch)
        .map(([k, v]) => `${k} = ${v === null ? 'empty' : String(v)}`)
        .join(', '),
    });

  for (const r of entity === 'invoice' ? rf.state.listRequests({ legacyPk }) : [])
    steps.push({
      at: r.createdAt,
      kind: 'request',
      by: 'customer',
      title:
        r.kind === 'promise'
          ? `Promised to pay by ${r.until}`
          : r.kind === 'plan'
            ? `Asked to pay in ${r.installments} parts`
            : 'Asked a question',
      detail: r.detail ?? undefined,
      status: r.status,
    });

  for (const a of entity === 'invoice' ? rf.state.listAdjustments(legacyPk, false) : [])
    steps.push({
      at: a.createdAt,
      kind: 'adjustment',
      by: 'payment terms',
      title: `${a.kind === 'late_fee' ? 'Late fee' : 'Early-payment discount'} ${toMoney(a.amount)} ${cur}`,
      detail: a.detail ?? undefined,
      status: a.status,
    });

  steps.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
  return { entity, legacyPk, number, steps };
}

function summarizeResult(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.error === 'string') return r.error;
  const bits = ['summary', 'paypalId', 'status', 'orderId', 'captureId', 'payment_id', 'batchId']
    .filter((k) => r[k] != null && typeof r[k] !== 'object')
    .map((k) => `${k} ${String(r[k])}`);
  return bits.length ? bits.join(' · ') : undefined;
}
