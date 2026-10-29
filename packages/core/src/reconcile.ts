import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { OPEN_STATUSES, PAID_STATUSES, PayPalError } from './paypal/client.ts';
import { cents, toMoney } from './util.ts';

export interface ReconcileReport {
  checked: number;
  fixed: string[];
  discrepancies: number;
  errors: string[];
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
      if (ppTotal !== null && ppOpen && ppTotal !== cents(inv.total)) {
        flag(
          inv.pk,
          pp.id,
          'amount_mismatch',
          `${inv.number}: legacy total ${toMoney(inv.total)} but PayPal shows ${toMoney(ppTotal / 100)}`,
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
  report.discrepancies = rf.state.listDiscrepancies().length;
  rf.state.setMeta('lastReconcileAt', new Date().toISOString());
  rf.emit('reconcile', report);
  return report;
}
