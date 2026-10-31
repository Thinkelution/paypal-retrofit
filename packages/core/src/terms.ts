import type { Retrofit } from './engine.ts';
import { rulesFor } from './customer-rules.ts';
import { loadInvoices } from './entities.ts';
import type { PaymentTerms } from './mapping/schema.ts';
import type { ActionRecord } from './types.ts';
import { addDaysIso, daysBetween, round2, toMoney, todayIso } from './util.ts';

/**
 * Payment terms the owner sets: a late fee once an invoice is far enough overdue, and an early-payment
 * discount that is applied when the invoice is created and removed when the window closes. Both change
 * the PayPal invoice (so the customer sees and pays the right amount), are recorded as adjustments, and
 * go through the policy engine like every other action.
 */

const OPEN = ['SENT', 'UNPAID', 'PARTIALLY_PAID'];

export function lateFeeAmount(terms: PaymentTerms, amountDue: number): number {
  const f = terms.lateFee;
  if (!f) return 0;
  return round2(f.kind === 'flat' ? f.amount : (amountDue * f.amount) / 100);
}

/** The early-payment discount for a new invoice, if its window is still open. */
export function earlyDiscountFor(
  terms: PaymentTerms,
  total: number,
  issued: string | undefined,
  today = todayIso(),
): { percent: number; amount: number; until: string } | null {
  const d = terms.earlyDiscount;
  if (!d) return null;
  const until = addDaysIso(issued ?? today, d.withinDays);
  if (until < today) return null;
  return { percent: d.percent, amount: round2((total * d.percent) / 100), until };
}

/** What the invoice should total in PayPal: the legacy total plus fees, minus discounts still in force. */
export function expectedTotal(rf: Retrofit, legacyPk: string, legacyTotal: number): number {
  return round2(legacyTotal + rf.state.adjustmentTotal(legacyPk));
}

export interface TermsItem {
  legacyPk: string;
  number: string;
  customer: string;
  kind: 'late_fee' | 'expire_discount';
  amount: number;
  reason: string;
}

/** Late fees and discount expiries that are due today. */
export async function planTerms(rf: Retrofit, today = todayIso()): Promise<TermsItem[]> {
  const terms = rf.mapping.terms;
  const out: TermsItem[] = [];
  const disputes = new Set(
    rf.state
      .listDiscrepancies()
      .filter((d) => d.kind === 'dispute')
      .map((d) => d.legacyPk),
  );
  for (const inv of await loadInvoices(rf.source, rf.mapping)) {
    if (inv.state !== 'open') continue;
    const link = rf.state.getLink('invoice', inv.pk);
    if (!link || !OPEN.includes(link.paypalStatus ?? '')) continue;
    const adjustments = rf.state.listAdjustments(inv.pk);
    const pending = (kind: ActionRecord['kind']) =>
      rf.state
        .actionsFor(kind, 'invoice', inv.pk)
        .some((a) => a.status === 'pending' || a.status === 'scheduled');
    const base = { legacyPk: inv.pk, number: inv.number, customer: inv.customer?.name ?? '' };

    for (const d of adjustments.filter((a) => a.kind === 'early_discount' && a.until && a.until < today)) {
      if (!pending('expire_discount'))
        out.push({
          ...base,
          kind: 'expire_discount',
          amount: -d.amount,
          reason: `The ${toMoney(-d.amount)} early-payment discount ended on ${d.until}`,
        });
    }

    const f = terms.lateFee;
    if (!f || !inv.due) continue;
    const daysOverdue = daysBetween(inv.due, today);
    if (daysOverdue < f.afterDays) continue;
    if (adjustments.some((a) => a.kind === 'late_fee')) continue;
    if (pending('apply_late_fee')) continue;
    // Never charge a fee to a customer who is disputing, on a plan, or has asked for one or promised a date.
    if (disputes.has(inv.pk)) continue;
    if (rulesFor(rf.mapping, inv).some((r) => r.noLateFees)) continue;
    if (rf.state.getPlan(inv.pk)?.status === 'active') continue;
    if (rf.state.listRequests({ status: 'open', legacyPk: inv.pk }).length) continue;
    if (rf.state.actionsFor('apply_late_fee', 'invoice', inv.pk).some((a) => a.status === 'rejected'))
      continue;
    const due = round2(expectedTotal(rf, inv.pk, inv.total) - (link.paypalPaid ?? 0));
    const amount = lateFeeAmount(terms, due);
    if (amount <= 0) continue;
    out.push({
      ...base,
      kind: 'late_fee',
      amount,
      reason: `${daysOverdue} days overdue (fee applies after ${f.afterDays}): ${f.kind === 'percent' ? `${f.amount}% of ${toMoney(due)}` : 'flat fee'}`,
    });
  }
  return out;
}

/** Proposes the late fees and discount expiries that are due. Policies decide what runs. */
export async function runTerms(
  rf: Retrofit,
  opts: { today?: string; origin?: ActionRecord['origin'] } = {},
): Promise<ActionRecord[]> {
  const out: ActionRecord[] = [];
  for (const t of await planTerms(rf, opts.today)) {
    const target = { entity: 'invoice' as const, legacyPk: t.legacyPk, label: t.number };
    out.push(
      await rf.propose({
        origin: opts.origin ?? 'cli',
        kind: t.kind === 'late_fee' ? 'apply_late_fee' : 'expire_discount',
        target,
        payload: { amount: t.amount },
        reason: t.kind === 'late_fee' ? `Late fee: ${t.reason}` : t.reason,
      }),
    );
  }
  return out;
}
