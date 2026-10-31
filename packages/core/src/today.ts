import { planAutopay } from './autopay.ts';
import { planCollections } from './collections.ts';
import { KIND_LABEL } from './digest.ts';
import type { Retrofit } from './engine.ts';
import { goLiveChecks } from './golive.ts';
import { ledger, summary } from './ledger.ts';
import { listCustomers } from './statements.ts';
import { addDaysIso, round2, todayIso } from './util.ts';

/**
 * The owner's home screen: what needs them today, in plain language, each with the one button that deals
 * with it; how the money stands this week; and what happened recently.
 */

export interface TodayNeed {
  id: string;
  tone: 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
  /** Console page that deals with it. */
  go?: string;
  /** Or something to run from the home screen. */
  run?: 'sync' | 'collections';
  label: string;
  items?: Array<{ label: string; sub?: string; amount?: number | null }>;
}

export interface TodayView {
  business: string;
  currency: string;
  environment: string;
  money: {
    owed: number;
    open: number;
    overdue: number;
    overdueCount: number;
    collected7d: number;
    collected7dCount: number;
    expected30: number;
    atRisk: number;
  };
  needs: TodayNeed[];
  recent: Array<{ at: string; text: string; kind: 'payment' | 'action' | 'customer' | 'order' }>;
  setup: { stage: string; done: number; total: number; next: string | null };
  autopay: { active: number };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export async function todayView(rf: Retrofit, opts: { claude: boolean; today?: string }): Promise<TodayView> {
  const today = opts.today ?? todayIso();
  const s = await summary(rf);
  const rows = await ledger(rf);
  const byPk = new Map(rows.filter((r) => r.entity === 'invoice').map((r) => [r.legacyPk, r]));
  const needs: TodayNeed[] = [];

  const pending = rf.state.listActions('pending', 100);
  if (pending.length)
    needs.push({
      id: 'approvals',
      tone: 'warn',
      title: `${plural(pending.length, 'action')} ${pending.length === 1 ? 'waits' : 'wait'} for your OK`,
      detail: 'Reminders, refunds, plan offers and fees that your rules send to you first.',
      go: 'approvals',
      label: 'Review',
      items: pending.slice(0, 3).map((a) => ({
        label: `${KIND_LABEL[a.kind] ?? a.kind} · ${a.target.label ?? a.target.legacyPk}`,
        sub: byPk.get(a.target.legacyPk)?.customer,
        amount: a.amount,
      })),
    });

  const requests = rf.state.listRequests({ status: 'open' });
  if (requests.length)
    needs.push({
      id: 'requests',
      tone: 'warn',
      title: `${plural(requests.length, 'customer request')} from the portal`,
      detail: 'Promises to pay, plan requests and questions. Reminders pause while they are open.',
      go: 'customers',
      label: 'Answer',
      items: requests.slice(0, 3).map((r) => {
        const inv = r.legacyPk ? byPk.get(r.legacyPk) : undefined;
        return {
          label: `${inv?.customer ?? `Customer ${r.customerPk}`}: ${
            r.kind === 'promise'
              ? `will pay by ${r.until}`
              : r.kind === 'plan'
                ? `asks to pay in ${r.installments} parts`
                : `"${(r.detail ?? '').slice(0, 80)}"`
          }`,
          sub: inv?.number,
        };
      }),
    });

  const discrepancies = rf.state.listDiscrepancies();
  const disputes = discrepancies.filter((d) => d.kind === 'dispute');
  if (disputes.length)
    needs.push({
      id: 'disputes',
      tone: 'bad',
      title: `${plural(disputes.length, 'customer')} opened a PayPal dispute`,
      detail:
        'Respond in time or PayPal may decide for the buyer. Claude can draft the response from your records.',
      go: 'discrepancies',
      label: 'Respond',
    });
  // Invoices not sent yet are the "ready to send" card, not a mismatch.
  const mismatches = discrepancies.filter((d) => d.kind !== 'dispute' && d.kind !== 'not_in_paypal').length;
  if (mismatches)
    needs.push({
      id: 'mismatches',
      tone: 'warn',
      title: `${plural(mismatches, 'record')} ${mismatches === 1 ? "doesn't" : "don't"} match PayPal`,
      detail: 'Each one comes with a suggested fix.',
      go: 'discrepancies',
      label: 'Look',
    });

  if (s.readyToSend)
    needs.push({
      id: 'send',
      tone: 'info',
      title: `${plural(s.readyToSend, 'new invoice')} ready to send`,
      detail:
        'Sync creates the PayPal invoices, emails each customer a pay link and writes it back into your system.',
      run: 'sync',
      label: 'Send now',
    });

  const plan = await planCollections(rf, today);
  const due = plan.filter((i) => i.decision === 'remind' || i.decision === 'plan');
  const autopayDue = await planAutopay(rf, today);
  if (due.length || autopayDue.length)
    needs.push({
      id: 'collections',
      tone: 'info',
      title: [
        due.length ? `${plural(due.length, 'reminder')} due` : '',
        autopayDue.length ? `${plural(autopayDue.length, 'autopay charge')} due` : '',
      ]
        .filter(Boolean)
        .join(' and '),
      detail: 'Your collections playbook decides the tone; anything your rules hold back comes to you first.',
      run: 'collections',
      label: 'Run collections',
      items: [
        ...autopayDue
          .slice(0, 2)
          .map((a) => ({ label: `${a.number} · ${a.customer}`, sub: 'autopay', amount: a.amount })),
        ...due
          .slice(0, 3)
          .map((i) => ({ label: `${i.number} · ${i.customer}`, sub: i.reason, amount: i.amountDue })),
      ],
    });

  const scheduled = rf.state.listActions('scheduled', 100);
  if (scheduled.length)
    needs.push({
      id: 'scheduled',
      tone: 'info',
      title: `${plural(scheduled.length, 'message')} held for business hours`,
      detail: `Quiet hours: they go out at ${rf.mapping.quietHours?.end ?? 'the start of the day'}.`,
      go: 'approvals',
      label: 'See them',
    });

  const golive = await goLiveChecks(rf, { claude: opts.claude });
  const next = golive.checks.find((c) => c.status === 'todo');
  if (golive.stage !== 'live' && next)
    needs.push({
      id: 'golive',
      tone: 'info',
      title: `Set-up: ${golive.done} of ${golive.total} steps done`,
      detail: `Next: ${next.title[0]!.toLowerCase()}${next.title.slice(1)}.`,
      go: 'golive',
      label: 'Continue',
    });

  // ---- money
  const since = addDaysIso(today, -7);
  const payments = rf.state
    .listPayments(since)
    .filter((p) => p.kind === 'payment' || p.kind === 'external_payment');

  // ---- recent activity
  const recent: TodayView['recent'] = [];
  const money = (n: number) => `${n.toFixed(2)} ${rf.mapping.currency}`;
  for (const p of rf.state.listPayments(addDaysIso(today, -30)).slice(-12))
    recent.push({
      at: p.occurredAt,
      kind: p.entity === 'order' ? 'order' : 'payment',
      text:
        p.entity === 'order'
          ? `Online sale paid: ${money(p.gross)}`
          : `${p.kind === 'payment' ? 'Paid through PayPal' : p.kind === 'external_payment' ? 'Paid outside PayPal' : 'Refund'}: ${money(Math.abs(p.gross))} for ${byPk.get(p.legacyPk)?.number ?? p.legacyPk}${byPk.get(p.legacyPk) ? ` (${byPk.get(p.legacyPk)!.customer})` : ''}`,
    });
  for (const a of rf.state.listActions('executed', 30)) {
    if (['update_invoice', 'expire_discount', 'create_invoice', 'record_payment'].includes(a.kind)) continue;
    recent.push({
      at: a.decidedAt ?? a.createdAt,
      kind: 'action',
      text: `${KIND_LABEL[a.kind] ?? a.kind}: ${a.target.label ?? a.target.legacyPk}${byPk.get(a.target.legacyPk) ? ` (${byPk.get(a.target.legacyPk)!.customer})` : ''}`,
    });
  }
  for (const r of rf.state.listRequests().slice(0, 10)) {
    const inv = r.legacyPk ? byPk.get(r.legacyPk) : undefined;
    recent.push({
      at: r.createdAt,
      kind: 'customer',
      text: `${inv?.customer ?? `Customer ${r.customerPk}`} ${r.kind === 'promise' ? `promised to pay ${inv?.number ?? ''} by ${r.until}` : r.kind === 'plan' ? `asked to pay ${inv?.number ?? ''} in ${r.installments} parts` : `asked about ${inv?.number ?? 'an invoice'}`}`,
    });
  }
  const autopay = rf.state.listAutopay('active');
  const names = autopay.length
    ? new Map((await listCustomers(rf, today)).map((c) => [c.pk, c.name]))
    : new Map();
  for (const a of autopay)
    recent.push({
      at: a.updatedAt,
      kind: 'customer',
      text: `${names.get(a.customerPk) ?? `Customer ${a.customerPk}`} turned on autopay`,
    });
  recent.sort((x, y) => (x.at < y.at ? 1 : -1));

  return {
    business: rf.config.business.name,
    currency: rf.mapping.currency,
    environment: rf.config.env.paypalEnvironment,
    money: {
      owed: s.openAmount,
      open: s.open,
      overdue: s.overdueAmount,
      overdueCount: s.overdue,
      collected7d: round2(payments.reduce((t, p) => t + p.gross, 0)),
      collected7dCount: payments.length,
      expected30: s.expectedNext30,
      atRisk: s.atRisk,
    },
    needs,
    recent: recent.slice(0, 10),
    setup: { stage: golive.stage, done: golive.done, total: golive.total, next: next?.title ?? null },
    autopay: { active: autopay.length },
  };
}
