import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { OPEN_STATUSES, PAID_STATUSES, PayPalError } from './paypal/client.ts';
import { expectedTotal } from './terms.ts';
import { cents, toMoney } from './util.ts';

export interface ReconcileReport {
  checked: number;
  fixed: string[];
  discrepancies: number;
  errors: string[];
  feesFilled?: number;
}

/**
 * Compares every linked record with PayPal. Safe corrections (a payment PayPal saw that the legacy system
 * missed, for example after a lost webhook) are written back automatically. Everything else becomes a
 * discrepancy for a person (or the Ops agent) to look at.
 */
export async function reconcile(rf: Retrofit): Promise<ReconcileReport> {
  const report: ReconcileReport = { checked: 0, fixed: [], discrepancies: 0, errors: [] };
  const im = rf.mapping.entities.invoice;
  const links = rf.state.listLinks('invoice');
  const legacy = new Map((await loadInvoices(rf.source, rf.mapping)).map((i) => [i.pk, i]));
  const seen = new Set<string>();
  const flag = (
    pk: string | null,
    paypalId: string | null,
    kind: string,
    detail: string,
    suggestion: string,
  ) => {
    rf.state.openDiscrepancy({ entity: 'invoice', legacyPk: pk, paypalId, kind, detail, suggestion });
    seen.add(`${pk}:${kind}`);
  };

  for (const link of links) {
    const inv = legacy.get(link.legacyPk);
    if (!inv) {
      flag(
        link.legacyPk,
        link.paypalId,
        'missing_in_legacy',
        `Legacy record ${link.legacyPk} no longer exists but PayPal invoice ${link.paypalId} does`,
        'Cancel the PayPal invoice if it is no longer owed.',
      );
      continue;
    }
    report.checked++;
    try {
      const pp = await rf.paypal.getInvoice(link.paypalId);
      const wasPaidInLegacy = inv.state === 'paid';
      const res = await rf.applyInvoiceState(link, pp);
      if (PAID_STATUSES.includes(pp.status) && !wasPaidInLegacy) report.fixed.push(res.summary);

      const ppOpen = OPEN_STATUSES.includes(pp.status);
      const ppTotal = pp.amount?.value !== undefined ? cents(pp.amount.value) : null;
      // Late fees and early-payment discounts are expected differences.
      const expected = expectedTotal(rf, inv.pk, inv.total);
      if (ppTotal !== null && ppOpen && ppTotal !== cents(expected)) {
        flag(
          inv.pk,
          pp.id,
          'amount_mismatch',
          `${inv.number}: expected ${toMoney(expected)}${expected !== inv.total ? ` (legacy ${toMoney(inv.total)} with fees and discounts)` : ''} but PayPal shows ${toMoney(ppTotal / 100)}`,
          'Run sync to update the PayPal invoice, or correct the legacy record.',
        );
      }
      if (wasPaidInLegacy && ppOpen) {
        flag(
          inv.pk,
          pp.id,
          'paid_in_legacy_not_paypal',
          `${inv.number} is paid in the legacy system but still ${pp.status} in PayPal, so the customer can still pay it twice`,
          'Approve "record payment" so PayPal stops asking the customer to pay.',
        );
      }
      if (inv.state === 'cancelled' && ppOpen) {
        flag(
          inv.pk,
          pp.id,
          'cancelled_in_legacy_not_paypal',
          `${inv.number} is void in the legacy system but still ${pp.status} in PayPal`,
          'Approve "cancel invoice" in PayPal.',
        );
      }
    } catch (e) {
      const msg = e instanceof PayPalError ? e.message : (e as Error).message;
      report.errors.push(`${inv.number}: ${msg}`);
    }
  }

  const linked = new Set(links.map((l) => l.legacyPk));
  for (const inv of legacy.values()) {
    if (inv.state === 'open' && im.push.includes(inv.status) && !linked.has(inv.pk)) {
      const problem = rf.invoiceProblem(inv);
      if (problem)
        flag(
          inv.pk,
          null,
          'invalid_source',
          `${inv.number}: ${problem}`,
          'Fix the record in the legacy system; sync will pick it up.',
        );
      else
        flag(
          inv.pk,
          null,
          'not_in_paypal',
          `${inv.number} is ${inv.status} but has not been sent through PayPal yet`,
          'Run sync.',
        );
    }
  }

  // Close discrepancies that no longer apply.
  const reconcilable = [
    'amount_mismatch',
    'paid_in_legacy_not_paypal',
    'cancelled_in_legacy_not_paypal',
    'not_in_paypal',
    'invalid_source',
    'missing_in_legacy',
  ];
  for (const d of rf.state.listDiscrepancies()) {
    if (d.entity === 'invoice' && reconcilable.includes(d.kind) && !seen.has(`${d.legacyPk}:${d.kind}`)) {
      rf.state.resolveDiscrepancy(d.id, 'No longer detected by reconciliation');
    }
  }
  report.feesFilled = await backfillFees(rf).catch((e) => {
    report.errors.push(`fees: ${(e as Error).message}`);
    return 0;
  });
  report.discrepancies = rf.state.listDiscrepancies().length;
  rf.state.setMeta('lastReconcileAt', new Date().toISOString());
  rf.emit('reconcile', report);
  return report;
}

/**
 * Fills PayPal fees for payments whose capture webhook never arrived, from Transaction Search
 * (PayPal can take a few hours to list sandbox transactions there).
 */
export async function backfillFees(rf: Retrofit): Promise<number> {
  const missing = rf.state.listPayments().filter((p) => p.kind === 'payment' && p.fee === null);
  if (missing.length === 0) return 0;
  const oldest = missing.reduce((m, p) => (p.occurredAt < m ? p.occurredAt : m), missing[0]!.occurredAt);
  const start = new Date(Math.max(Date.parse(oldest.slice(0, 10)) - 86400000, Date.now() - 30 * 86400000));
  const tx = await rf.paypal.listTransactions(start, new Date());
  const fees = new Map<string, number>();
  for (const t of tx.transaction_details ?? []) {
    const info = t.transaction_info ?? {};
    if (info.transaction_id && info.fee_amount?.value !== undefined)
      fees.set(String(info.transaction_id), Math.abs(Number(info.fee_amount.value)));
  }
  let filled = 0;
  for (const p of missing) {
    const fee = fees.get(p.id);
    if (fee !== undefined) {
      rf.state.setPaymentFee(p.id, fee);
      filled++;
    }
  }
  return filled;
}
