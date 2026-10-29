/**
 * Insights computed from the business's own history: how each customer pays, how likely each open
 * invoice is to be paid late, what cash to expect week by week, and month-end books with PayPal fees.
 * Everything here is deterministic and explainable; the agents use it, they don't replace it.
 */
import type { Retrofit } from './engine.ts';
import { loadInvoices, loadSubscriptions, type LegacyInvoice } from './entities.ts';
import { PAID_STATUSES } from './paypal/client.ts';
import type { PaymentRecord } from './state/store.ts';
import { addDaysIso, daysBetween, median, round2, toMoney, todayIso } from './util.ts';

export interface CustomerProfile {
  customerPk: string;
  name: string;
  invoices: number;
  averageInvoice: number;
  paidCount: number;
  onTimeRate: number | null;
  medianDaysLate: number | null;
  worstDaysLate: number | null;
  openCount: number;
  openAmount: number;
  overdueAmount: number;
  disputes: number;
  behaviour: 'reliable' | 'sometimes late' | 'usually late' | 'new customer';
}

export interface InvoiceRisk {
  legacyPk: string;
  number: string;
  customer: string;
  amountDue: number;
  daysOverdue: number;
  score: number;
  band: 'low' | 'medium' | 'high';
  expectedPayDate: string;
  factors: string[];
  plan: { installments: number; covered: number; nextDue: string | null; behind: number } | null;
}

export interface ForecastWeek {
  start: string;
  end: string;
  expected: number;
  fromInvoices: number;
  fromSubscriptions: number;
  items: Array<{
    label: string;
    amount: number;
    date: string;
    kind: 'invoice' | 'instalment' | 'subscription';
  }>;
}

export interface CashForecast {
  generatedAt: string;
  currency: string;
  weeks: ForecastWeek[];
  next30: number;
  next60: number;
  atRisk: number;
  overdueTotal: number;
  assumptions: string[];
}

const CONFIDENCE = { low: 0.95, medium: 0.75, high: 0.45 } as const;

function paidDate(rf: Retrofit, inv: LegacyInvoice): string | undefined {
  const col = rf.mapping.entities.invoice.writeBack.paidAt;
  const v = col ? inv.raw[col] : undefined;
  if (v) return String(v).slice(0, 10);
  return rf.state.getLink('invoice', inv.pk)?.paypalPaidAt?.slice(0, 10) ?? undefined;
}

export async function customerProfiles(
  rf: Retrofit,
  today = todayIso(),
): Promise<Map<string, CustomerProfile>> {
  const invoices = await loadInvoices(rf.source, rf.mapping);
  const disputes = rf.state.listDiscrepancies().filter((d) => d.kind === 'dispute');
  const out = new Map<string, CustomerProfile>();
  const lateBy = new Map<string, number[]>();
  for (const inv of invoices) {
    const p =
      out.get(inv.customerPk) ??
      ({
        customerPk: inv.customerPk,
        name: inv.customer?.name ?? `#${inv.customerPk}`,
        invoices: 0,
        averageInvoice: 0,
        paidCount: 0,
        onTimeRate: null,
        medianDaysLate: null,
        worstDaysLate: null,
        openCount: 0,
        openAmount: 0,
        overdueAmount: 0,
        disputes: 0,
        behaviour: 'new customer',
      } satisfies CustomerProfile);
    p.averageInvoice = round2((p.averageInvoice * p.invoices + inv.total) / (p.invoices + 1));
    p.invoices++;
    if (inv.state === 'paid' && inv.due) {
      const pd = paidDate(rf, inv);
      if (pd) {
        p.paidCount++;
        lateBy.set(inv.customerPk, [...(lateBy.get(inv.customerPk) ?? []), daysBetween(inv.due, pd)]);
      }
    }
    if (inv.state === 'open') {
      const paid = rf.state.getLink('invoice', inv.pk)?.paypalPaid ?? 0;
      const due = round2(inv.total - paid);
      p.openCount++;
      p.openAmount = round2(p.openAmount + due);
      if (inv.due && inv.due < today) p.overdueAmount = round2(p.overdueAmount + due);
    }
    if (disputes.some((d) => d.legacyPk === inv.pk)) p.disputes++;
    out.set(inv.customerPk, p);
  }
  for (const [pk, lates] of lateBy) {
    const p = out.get(pk)!;
    p.onTimeRate = round2(lates.filter((d) => d <= 0).length / lates.length);
    p.medianDaysLate = median(lates);
    p.worstDaysLate = Math.max(...lates);
    p.behaviour =
      p.onTimeRate >= 0.8 ? 'reliable' : (p.medianDaysLate ?? 0) > 7 ? 'usually late' : 'sometimes late';
  }
  return out;
}

export async function invoiceRisks(rf: Retrofit, today = todayIso()): Promise<InvoiceRisk[]> {
  const profiles = await customerProfiles(rf, today);
  const allLate = [...profiles.values()].map((p) => p.medianDaysLate).filter((x): x is number => x !== null);
  const prior = median(allLate) ?? 5;
  const disputes = rf.state.listDiscrepancies().filter((d) => d.kind === 'dispute');
  const cfg = rf.mapping.collections;
  const open = (await loadInvoices(rf.source, rf.mapping)).filter((i) => i.state === 'open');
  const out: InvoiceRisk[] = [];

  for (const inv of open) {
    const link = rf.state.getLink('invoice', inv.pk);
    const paid = link?.paypalPaid ?? 0;
    const amountDue = round2(inv.total - paid);
    if (amountDue <= 0 || (link?.paypalStatus && PAID_STATUSES.includes(link.paypalStatus))) continue;
    const prof = profiles.get(inv.customerPk);
    const daysOverdue = inv.due ? Math.max(0, daysBetween(inv.due, today)) : 0;
    const factors: string[] = [];
    let score = 15;

    if (daysOverdue > 0) {
      score += Math.min(45, daysOverdue * 0.9);
      factors.push(`${daysOverdue} days overdue`);
    } else if (inv.due) factors.push(`due in ${daysBetween(today, inv.due)} days`);

    if (prof && prof.paidCount >= 2 && prof.medianDaysLate !== null) {
      if (prof.medianDaysLate > 7) {
        score += 15;
        factors.push(
          `usually pays ${Math.round(prof.medianDaysLate)} days late (${prof.paidCount} paid invoices)`,
        );
      } else if ((prof.onTimeRate ?? 0) >= 0.8) {
        score -= 10;
        factors.push(
          `pays on time (${Math.round((prof.onTimeRate ?? 0) * 100)}% of ${prof.paidCount} invoices)`,
        );
      } else factors.push(`sometimes pays late (median ${Math.round(prof.medianDaysLate)} days)`);
    } else {
      score += 5;
      factors.push('little payment history');
    }

    if (disputes.some((d) => d.legacyPk === inv.pk)) {
      score += 25;
      factors.push('open dispute on this invoice');
    } else if (prof && prof.disputes > 0) {
      score += 10;
      factors.push('customer has an open dispute');
    }

    const notes = (inv.notes ?? '').toLowerCase();
    if (cfg.promiseKeywords.some((k) => notes.includes(k))) {
      score -= 5;
      factors.push('customer promised to pay (note)');
    }
    if (paid > 0) {
      score -= 5;
      factors.push(`${toMoney(paid)} already paid`);
    }

    const planRec = rf.state.getPlan(inv.pk);
    let plan: InvoiceRisk['plan'] = null;
    if (planRec?.status === 'active') {
      const prog = rf.planProgress(planRec, paid - (inv.total - planRec.total), today);
      plan = {
        installments: planRec.installments,
        covered: prog.covered,
        nextDue: prog.nextDue?.due ?? null,
        behind: prog.behind,
      };
      score -= 15;
      factors.push(`on a ${planRec.installments}-part payment plan (${prog.covered} paid)`);
      if (prog.behind > 0) {
        score += 15;
        factors.push(`instalment behind by ${toMoney(prog.behind)}`);
      }
    }

    if (prof && prof.invoices > 2 && amountDue > prof.averageInvoice * 2 && amountDue > 500) {
      score += 5;
      factors.push('larger than this customer usually owes');
    }

    score = Math.max(1, Math.min(99, Math.round(score)));
    const band = score < 35 ? 'low' : score < 60 ? 'medium' : 'high';
    const late =
      prof && prof.paidCount >= 1 && prof.medianDaysLate !== null
        ? (prof.medianDaysLate * prof.paidCount + prior * 2) / (prof.paidCount + 2)
        : prior;
    let expected =
      plan?.nextDue ?? (inv.due ? addDaysIso(inv.due, Math.max(0, Math.round(late))) : addDaysIso(today, 14));
    // Already late: riskier invoices are expected later (about 2 weeks at score 30, 5 weeks at 70).
    if (expected <= today) expected = addDaysIso(today, Math.round(3 + score * 0.45));
    out.push({
      legacyPk: inv.pk,
      number: inv.number,
      customer: inv.customer?.name ?? `#${inv.customerPk}`,
      amountDue,
      daysOverdue,
      score,
      band,
      expectedPayDate: expected,
      factors,
      plan,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function cashForecast(
  rf: Retrofit,
  opts: { today?: string; weeks?: number } = {},
): Promise<CashForecast> {
  const today = opts.today ?? todayIso();
  const nWeeks = opts.weeks ?? 9;
  const risks = await invoiceRisks(rf, today);
  const weeks: ForecastWeek[] = Array.from({ length: nWeeks }, (_, i) => ({
    start: addDaysIso(today, i * 7),
    end: addDaysIso(today, i * 7 + 6),
    expected: 0,
    fromInvoices: 0,
    fromSubscriptions: 0,
    items: [],
  }));
  const place = (
    date: string,
    amount: number,
    label: string,
    kind: ForecastWeek['items'][number]['kind'],
  ) => {
    const idx = Math.floor(Math.max(0, daysBetween(today, date)) / 7);
    const w = weeks[idx];
    if (!w || amount <= 0) return;
    w.expected = round2(w.expected + amount);
    if (kind === 'subscription') w.fromSubscriptions = round2(w.fromSubscriptions + amount);
    else w.fromInvoices = round2(w.fromInvoices + amount);
    w.items.push({ label, amount: round2(amount), date, kind });
  };

  for (const r of risks) {
    const conf = CONFIDENCE[r.band];
    const planRec = r.plan ? rf.state.getPlan(r.legacyPk) : undefined;
    if (planRec && r.plan) {
      const paidSoFar = planRec.total - r.amountDue;
      let cum = 0;
      for (const s of planRec.schedule) {
        cum = round2(cum + s.amount);
        const owed = round2(Math.min(s.amount, cum - paidSoFar));
        if (owed > 0)
          place(s.due < today ? today : s.due, owed * conf, `${r.number} instalment ${s.n}`, 'instalment');
      }
    } else place(r.expectedPayDate, r.amountDue * conf, r.number, 'invoice');
  }

  const sm = rf.mapping.entities.subscription;
  if (sm) {
    const step = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 }[sm.interval];
    for (const s of await loadSubscriptions(rf.source, rf.mapping)) {
      if (s.state !== 'active' || !s.startedAt) continue;
      let d = s.startedAt.slice(0, 10);
      while (d <= today) d = addDaysIso(d, step);
      for (; daysBetween(today, d) < nWeeks * 7; d = addDaysIso(d, step))
        place(d, s.amount * 0.95, s.title, 'subscription');
    }
  }

  const within = (days: number) =>
    round2(
      weeks
        .flatMap((w) => w.items)
        .filter((i) => daysBetween(today, i.date) < days)
        .reduce((a, i) => a + i.amount, 0),
    );
  return {
    generatedAt: new Date().toISOString(),
    currency: rf.mapping.currency,
    weeks,
    next30: within(30),
    next60: within(60),
    atRisk: round2(risks.filter((r) => r.band === 'high').reduce((a, r) => a + r.amountDue, 0)),
    overdueTotal: round2(risks.filter((r) => r.daysOverdue > 0).reduce((a, r) => a + r.amountDue, 0)),
    assumptions: [
      'Each customer is expected to pay as late as they usually do (blended with the business-wide median when history is thin).',
      `Amounts are weighted by risk: low ${CONFIDENCE.low * 100}%, medium ${CONFIDENCE.medium * 100}%, high ${CONFIDENCE.high * 100}%.`,
      'Payment plans contribute on their instalment dates; active retainers on their billing dates at 95%.',
    ],
  };
}

// ---------------------------------------------------------------- books

export interface JournalRow {
  date: string;
  invoice: string;
  customer: string;
  kind: PaymentRecord['kind'];
  gross: number;
  fee: number | null;
  net: number | null;
  currency: string;
  transactionId: string;
  method: string;
}

export async function journal(rf: Retrofit, from?: string, to?: string): Promise<JournalRow[]> {
  const invoices = new Map((await loadInvoices(rf.source, rf.mapping)).map((i) => [i.pk, i]));
  return rf.state.listPayments(from, to).map((p) => {
    const inv = invoices.get(p.legacyPk);
    return {
      date: p.occurredAt.slice(0, 10),
      invoice: inv?.number ?? p.legacyPk,
      customer: inv?.customer?.name ?? '',
      kind: p.kind,
      gross: p.gross,
      fee: p.fee,
      net: p.net,
      currency: p.currency,
      transactionId: p.id,
      method: p.method ?? '',
    };
  });
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { from: `${month}-01`, to: `${next}-01` };
}

export async function monthSummary(rf: Retrofit, month: string) {
  const { from, to } = monthRange(month);
  const rows = await journal(rf, from, to);
  const sum = (f: (r: JournalRow) => number) => round2(rows.reduce((a, r) => a + f(r), 0));
  const paypal = rows.filter((r) => r.kind === 'payment');
  const gross = sum((r) => (r.kind === 'payment' ? r.gross : 0));
  const fees = sum((r) => (r.kind === 'payment' ? (r.fee ?? 0) : 0));
  return {
    month,
    currency: rf.mapping.currency,
    paypalPayments: paypal.length,
    grossCollected: gross,
    fees,
    feesMissing: paypal.filter((r) => r.fee === null).length,
    net: round2(gross - fees),
    refunds: sum((r) => (r.kind === 'refund' || r.kind === 'external_refund' ? r.gross : 0)),
    paidOutsidePayPal: sum((r) => (r.kind === 'external_payment' ? r.gross : 0)),
    effectiveFeeRate: gross > 0 ? round2((fees / gross) * 100) : null,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/**
 * CSV for accountants. "generic" keeps every column; "xero" and "quickbooks" are bank-statement imports
 * where each PayPal fee becomes its own negative line so the books reconcile to the net payout.
 */
export function journalCsv(
  rows: JournalRow[],
  format: 'generic' | 'xero' | 'quickbooks' = 'generic',
): string {
  const lines: unknown[][] = [];
  if (format === 'generic') {
    lines.push([
      'Date',
      'Invoice',
      'Customer',
      'Type',
      'Gross',
      'Fee',
      'Net',
      'Currency',
      'Transaction ID',
      'Method',
    ]);
    for (const r of rows)
      lines.push([
        r.date,
        r.invoice,
        r.customer,
        r.kind,
        r.gross.toFixed(2),
        r.fee?.toFixed(2) ?? '',
        r.net?.toFixed(2) ?? '',
        r.currency,
        r.transactionId,
        r.method,
      ]);
  } else if (format === 'xero') {
    lines.push(['Date', 'Amount', 'Payee', 'Description', 'Reference']);
    for (const r of rows) {
      if (r.kind === 'external_payment' || r.kind === 'external_refund') continue; // not money through PayPal
      lines.push([
        dmy(r.date),
        r.gross.toFixed(2),
        r.customer,
        `${r.kind === 'refund' ? 'Refund' : 'Payment'} ${r.invoice}`,
        r.transactionId,
      ]);
      if (r.fee)
        lines.push([dmy(r.date), (-r.fee).toFixed(2), 'PayPal', `PayPal fee ${r.invoice}`, r.transactionId]);
    }
  } else {
    lines.push(['Date', 'Description', 'Amount']);
    for (const r of rows) {
      if (r.kind === 'external_payment' || r.kind === 'external_refund') continue;
      lines.push([
        mdy(r.date),
        `${r.kind === 'refund' ? 'Refund' : 'Payment'} ${r.invoice} ${r.customer}`.trim(),
        r.gross.toFixed(2),
      ]);
      if (r.fee) lines.push([mdy(r.date), `PayPal fee ${r.invoice}`, (-r.fee).toFixed(2)]);
    }
  }
  return lines.map((l) => l.map(csvCell).join(',')).join('\n') + '\n';
}
