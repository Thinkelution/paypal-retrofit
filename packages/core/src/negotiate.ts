import crypto from 'node:crypto';
import type { Retrofit } from './engine.ts';
import { customerProfiles } from './insights.ts';
import { PAID_STATUSES } from './paypal/client.ts';
import type { NegotiationRecord, PlanTerms } from './state/store.ts';
import { buildStatement, formatMoney } from './statements.ts';
import { addDaysIso, daysBetween, round2, todayIso } from './util.ts';

/**
 * Payment-plan negotiation between a customer (usually their AI assistant) and the business's own rules.
 * The owner sets the limits once (PlanPolicy): inside `autoAccept` the plan is agreed and set up on PayPal
 * straight away; inside the outer limits it is offered and waits for the owner; beyond them the customer gets
 * the closest plan the business would accept, which they can take. Every outcome says why.
 */

export interface PlanAsk {
  customerPk: string;
  legacyPk: string;
  installments: number;
  intervalDays?: number;
  firstDue?: string;
  via?: string;
}

export interface NegotiationResult {
  id: string;
  status: NegotiationRecord['status'];
  invoice: string;
  balance: number;
  currency: string;
  offer: PlanTerms | null;
  reason: string;
  /** What the customer's assistant should do next. */
  next: string;
}

const terms = (balance: number, installments: number, intervalDays: number, firstDue: string): PlanTerms => {
  const each = Math.floor((balance * 100) / installments) / 100;
  return {
    installments,
    intervalDays,
    firstDue,
    amounts: Array.from({ length: installments }, (_, i) =>
      i === installments - 1 ? round2(balance - each * (installments - 1)) : each,
    ),
  };
};

export async function negotiatePlan(
  rf: Retrofit,
  ask: PlanAsk,
  today = todayIso(),
): Promise<NegotiationResult> {
  const p = rf.mapping.plans;
  const cur = rf.mapping.currency;
  const s = await buildStatement(rf, ask.customerPk, today);
  const line = s.lines.find((l) => l.legacyPk === ask.legacyPk);
  const id = `neg_${crypto.randomBytes(5).toString('hex')}`;
  const base = { id, invoice: line?.number ?? ask.legacyPk, balance: line?.balance ?? 0, currency: cur };
  const record = (
    status: NegotiationRecord['status'],
    reason: string,
    offer: PlanTerms | null,
    actionId: number | null = null,
  ) =>
    rf.state.saveNegotiation({
      id,
      customerPk: ask.customerPk,
      legacyPk: ask.legacyPk,
      ask: { installments: ask.installments, intervalDays: ask.intervalDays, firstDue: ask.firstDue },
      offer,
      status,
      reason,
      actionId,
      via: ask.via ?? null,
    });

  // Not every invoice can go on a plan.
  const link = rf.state.getLink('invoice', ask.legacyPk);
  const disputed = rf.state
    .listDiscrepancies()
    .some((d) => d.kind === 'dispute' && d.legacyPk === ask.legacyPk);
  const refuse = (reason: string): NegotiationResult => {
    record('declined', reason, null);
    return {
      ...base,
      status: 'declined',
      offer: null,
      reason,
      next: 'Tell the customer; they can pay in full or ask the business directly.',
    };
  };
  if (!line) return refuse('That invoice is not open.');
  if (!link || !line.inPayPal || PAID_STATUSES.includes(link.paypalStatus ?? ''))
    return refuse('That invoice cannot be paid online yet.');
  if (line.onPlan || rf.state.getPlan(ask.legacyPk)?.status === 'active')
    return refuse('That invoice is already on a payment plan.');
  if (disputed) return refuse('That invoice is in a PayPal dispute; it has to be resolved first.');

  // The closest plan inside the owner's limits.
  const askedParts = Math.max(2, Math.round(ask.installments || 2));
  const askedGap = Math.max(7, Math.round(ask.intervalDays ?? 14));
  const latestFirst = addDaysIso(today, p.maxDaysToFirstPayment);
  const askedFirst =
    ask.firstDue && /^\d{4}-\d{2}-\d{2}$/.test(ask.firstDue) && ask.firstDue >= today
      ? ask.firstDue
      : addDaysIso(today, 7);
  const parts = Math.min(askedParts, p.maxInstallments);
  const gap = Math.min(askedGap, p.maxIntervalDays);
  const first = askedFirst > latestFirst ? latestFirst : askedFirst;
  const offer = terms(line.balance, parts, gap, first);
  const changed = [
    parts !== askedParts ? `${parts} payments instead of ${askedParts}` : null,
    gap !== askedGap ? `every ${gap} days instead of ${askedGap}` : null,
    first !== askedFirst ? `starting by ${first}` : null,
  ].filter(Boolean);
  const describe = (t: PlanTerms) =>
    `${t.installments} payments of about ${formatMoney(t.amounts[0]!, cur)}, every ${t.intervalDays} days from ${t.firstDue}`;

  if (changed.length) {
    record('counter', `The business can offer ${changed.join(', ')}.`, offer);
    return {
      ...base,
      status: 'counter',
      offer,
      reason: `Outside what ${rf.config.business.name} agrees to; closest offer: ${describe(offer)}.`,
      next: `Ask the customer, then call accept_plan_offer with offer_id "${id}" if they agree.`,
    };
  }
  return agree(rf, id, base, ask, offer, today);
}

/** The customer accepts a counter-offer. */
export async function acceptPlanOffer(
  rf: Retrofit,
  id: string,
  customerPk: string,
  today = todayIso(),
): Promise<NegotiationResult> {
  const n = rf.state.getNegotiation(id);
  if (!n || n.customerPk !== customerPk) throw new Error('No such offer for this customer.');
  if (n.status !== 'counter' || !n.offer) throw new Error(`This offer is ${n.status}.`);
  const s = await buildStatement(rf, customerPk, today);
  const line = s.lines.find((l) => l.legacyPk === n.legacyPk);
  if (!line) throw new Error('That invoice is no longer open.');
  if (
    Math.abs(line.balance - n.offer.amounts.reduce((a, b) => a + b, 0)) > 0.01 ||
    daysBetween(n.createdAt.slice(0, 10), today) > 7
  )
    throw new Error('The offer has expired; ask again for a new one.');
  return agree(
    rf,
    n.id,
    { id: n.id, invoice: line.number, balance: line.balance, currency: rf.mapping.currency },
    { customerPk, legacyPk: n.legacyPk, installments: n.offer.installments, via: n.via ?? undefined },
    n.offer,
    today,
  );
}

/** Inside the outer limits: agreed on the spot within autoAccept, otherwise offered for the owner to approve. */
async function agree(
  rf: Retrofit,
  id: string,
  base: { id: string; invoice: string; balance: number; currency: string },
  ask: PlanAsk,
  offer: PlanTerms,
  today: string,
): Promise<NegotiationResult> {
  const p = rf.mapping.plans;
  const cur = rf.mapping.currency;
  const profile = (await customerProfiles(rf, today)).get(ask.customerPk);
  const reliable = profile?.onTimeRate != null && profile.onTimeRate >= p.autoAccept.minOnTimeRate;
  const small = base.balance <= p.autoAccept.maxAmount && offer.installments <= p.autoAccept.maxInstallments;
  const auto = small && reliable;
  const why = auto
    ? `Within the plans the owner agrees to without being asked (up to ${formatMoney(p.autoAccept.maxAmount, cur)} in ${p.autoAccept.maxInstallments} payments, for customers who pay on time)`
    : !small
      ? `Inside the plan limits, but above what is agreed without the owner (${formatMoney(p.autoAccept.maxAmount, cur)}, ${p.autoAccept.maxInstallments} payments)`
      : profile?.onTimeRate == null
        ? 'Inside the plan limits; a new customer, so the owner decides'
        : `Inside the plan limits; this customer pays on time ${Math.round(profile.onTimeRate * 100)}% of the time, so the owner decides`;
  const action = await rf.propose({
    origin: 'assistant',
    kind: 'offer_payment_plan',
    target: { entity: 'invoice', legacyPk: ask.legacyPk, label: base.invoice },
    payload: {
      installments: offer.installments,
      intervalDays: offer.intervalDays,
      firstDue: offer.firstDue,
      amount: base.balance,
    },
    reason: `Asked ${ask.via ?? 'by the customer'} for ${offer.installments} payments; ${why}`,
    ownerRule: auto ? why : undefined,
  });
  const status: NegotiationRecord['status'] =
    action.status === 'executed'
      ? 'agreed'
      : action.status === 'pending' || action.status === 'scheduled'
        ? 'owner'
        : 'declined';
  rf.state.saveNegotiation({
    id,
    customerPk: ask.customerPk,
    legacyPk: ask.legacyPk,
    ask: rf.state.getNegotiation(id)?.ask ?? {
      installments: ask.installments,
      intervalDays: ask.intervalDays,
      firstDue: ask.firstDue,
    },
    offer,
    status: status === 'agreed' || status === 'owner' ? status : 'declined',
    reason:
      status === 'declined'
        ? String((action.result as any)?.error ?? action.policyReason ?? 'Not possible')
        : why,
    actionId: action.id,
    via: ask.via ?? null,
  });
  rf.emit('negotiation', { id });
  return {
    ...base,
    status,
    offer,
    reason: why,
    next:
      status === 'agreed'
        ? `Agreed. The PayPal invoice now accepts ${offer.installments} payments; the customer pays each one from the same link.`
        : status === 'owner'
          ? `${rf.config.business.name} will confirm by email; nothing to pay until then.`
          : 'The plan could not be set up; ask the business directly.',
  };
}
