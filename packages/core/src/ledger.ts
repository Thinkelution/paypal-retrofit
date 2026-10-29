import type { Retrofit } from './engine.ts';
import { loadInvoices, loadSubscriptions } from './entities.ts';
import { cashForecast, invoiceRisks } from './insights.ts';
import { todayIso } from './util.ts';

export interface LedgerRow {
  key: string;
  entity: 'invoice' | 'subscription';
  legacyPk: string;
  number: string;
  customer: string;
  customerEmail: string;
  legacyStatus: string;
  legacyState: string;
  legacyTotal: number;
  issued: string | null;
  due: string | null;
  daysOverdue: number | null;
  paypalId: string | null;
  paypalStatus: string | null;
  paypalAmount: number | null;
  paypalPaid: number | null;
  paypalPaidAt: string | null;
  paypalTransactionId: string | null;
  payLink: string | null;
  lastSyncedAt: string | null;
  discrepancies: string[];
  pendingActions: number;
  inSync: boolean;
  riskBand: 'low' | 'medium' | 'high' | null;
  riskScore: number | null;
  riskFactors: string[];
  expectedPayDate: string | null;
  plan: { installments: number; covered: number; nextDue: string | null; behind: number } | null;
}

export async function ledger(rf: Retrofit): Promise<LedgerRow[]> {
  const today = todayIso();
  const links = new Map(rf.state.listLinks().map((l) => [`${l.entity}:${l.legacyPk}`, l]));
  const disc = new Map<string, string[]>();
  for (const d of rf.state.listDiscrepancies()) {
    const k = `${d.entity}:${d.legacyPk}`;
    disc.set(k, [...(disc.get(k) ?? []), d.kind]);
  }
  const pending = new Map<string, number>();
  for (const a of rf.state.listActions('pending', 1000)) {
    const k = `${a.target.entity}:${a.target.legacyPk}`;
    pending.set(k, (pending.get(k) ?? 0) + 1);
  }

  const risks = new Map((await invoiceRisks(rf, today)).map((r) => [r.legacyPk, r]));
  const rows: LedgerRow[] = [];
  for (const inv of await loadInvoices(rf.source, rf.mapping)) {
    const key = `invoice:${inv.pk}`;
    const l = links.get(key);
    const overdue =
      inv.state === 'open' && inv.due && inv.due < today
        ? Math.round((Date.parse(today) - Date.parse(inv.due)) / 86400000)
        : null;
    const ppPaid = l?.paypalStatus === 'PAID' || l?.paypalStatus === 'MARKED_AS_PAID';
    const inSync = !l
      ? inv.state !== 'open' || !rf.mapping.entities.invoice.push.includes(inv.status)
      : (inv.state === 'paid') === ppPaid || (inv.state === 'cancelled' && l.paypalStatus === 'CANCELLED');
    rows.push({
      key,
      entity: 'invoice',
      legacyPk: inv.pk,
      number: inv.number,
      customer: inv.customer?.name ?? `#${inv.customerPk}`,
      customerEmail: inv.customer?.email ?? '',
      legacyStatus: inv.status,
      legacyState: inv.state,
      legacyTotal: inv.total,
      issued: inv.issued ?? null,
      due: inv.due ?? null,
      daysOverdue: overdue,
      paypalId: l?.paypalId ?? null,
      paypalStatus: l?.paypalStatus ?? null,
      paypalAmount: l?.paypalAmount ?? null,
      paypalPaid: l?.paypalPaid ?? null,
      paypalPaidAt: l?.paypalPaidAt ?? null,
      paypalTransactionId: l?.paypalTransactionId ?? null,
      payLink: l?.payLink ?? null,
      lastSyncedAt: l?.lastSyncedAt ?? null,
      discrepancies: disc.get(key) ?? [],
      pendingActions: pending.get(key) ?? 0,
      inSync: inSync && !disc.get(key)?.length,
      riskBand: risks.get(inv.pk)?.band ?? null,
      riskScore: risks.get(inv.pk)?.score ?? null,
      riskFactors: risks.get(inv.pk)?.factors ?? [],
      expectedPayDate: risks.get(inv.pk)?.expectedPayDate ?? null,
      plan: risks.get(inv.pk)?.plan ?? null,
    });
  }
  for (const s of await loadSubscriptions(rf.source, rf.mapping)) {
    const key = `subscription:${s.pk}`;
    const l = links.get(key);
    rows.push({
      key,
      entity: 'subscription',
      legacyPk: s.pk,
      number: s.title,
      customer: s.customer?.name ?? `#${s.customerPk}`,
      customerEmail: s.customer?.email ?? '',
      legacyStatus: s.status,
      legacyState: s.state,
      legacyTotal: s.amount,
      issued: s.startedAt ?? null,
      due: null,
      daysOverdue: null,
      paypalId: l?.paypalId ?? null,
      paypalStatus: l?.paypalStatus ?? null,
      paypalAmount: l?.paypalAmount ?? null,
      paypalPaid: l?.paypalPaid ?? null,
      paypalPaidAt: l?.paypalPaidAt ?? null,
      paypalTransactionId: l?.paypalTransactionId ?? null,
      payLink: l?.payLink ?? null,
      lastSyncedAt: l?.lastSyncedAt ?? null,
      discrepancies: disc.get(key) ?? [],
      pendingActions: pending.get(key) ?? 0,
      inSync: !disc.get(key)?.length,
      riskBand: null,
      riskScore: null,
      riskFactors: [],
      expectedPayDate: null,
      plan: null,
    });
  }
  return rows;
}

export async function summary(rf: Retrofit) {
  const rows = await ledger(rf);
  const inv = rows.filter((r) => r.entity === 'invoice');
  const sum = (xs: LedgerRow[], f: (r: LedgerRow) => number) =>
    Math.round(xs.reduce((s, r) => s + f(r), 0) * 100) / 100;
  const open = inv.filter((r) => r.legacyState === 'open');
  const overdue = open.filter((r) => (r.daysOverdue ?? 0) > 0);
  const forecast = await cashForecast(rf);
  return {
    business: rf.config.business.name,
    currency: rf.mapping.currency,
    environment: rf.config.env.paypalEnvironment,
    invoices: inv.length,
    linked: inv.filter((r) => r.paypalId).length,
    readyToSend: inv.filter(
      (r) =>
        !r.paypalId && r.legacyState === 'open' && rf.mapping.entities.invoice.push.includes(r.legacyStatus),
    ).length,
    open: open.length,
    openAmount: sum(open, (r) => r.legacyTotal),
    overdue: overdue.length,
    overdueAmount: sum(overdue, (r) => r.legacyTotal),
    paidViaPayPal: inv.filter((r) => r.paypalStatus === 'PAID').length,
    paidViaPayPalAmount: sum(
      inv.filter((r) => r.paypalStatus === 'PAID'),
      (r) => r.paypalPaid ?? r.legacyTotal,
    ),
    subscriptions: rows.filter((r) => r.entity === 'subscription').length,
    discrepancies: rf.state.listDiscrepancies().length,
    pendingActions: rf.state.listActions('pending').length,
    lastSyncAt: rf.state.getMeta('lastSyncAt') ?? null,
    lastReconcileAt: rf.state.getMeta('lastReconcileAt') ?? null,
    lastWebhookAt: rf.state.listEvents(1)[0]?.receivedAt ?? null,
    scheduledActions: rf.state.listActions('scheduled').length,
    activePlans: rf.state.listPlans('active').length,
    expectedNext30: forecast.next30,
    atRisk: forecast.atRisk,
    lastCollectionsAt: rf.state.getMeta('lastCollectionsAt') ?? null,
  };
}
