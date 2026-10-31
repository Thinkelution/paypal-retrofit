import { rulesFor } from './customer-rules.ts';
import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { decidePolicy, isQuiet } from './policy.ts';
import { addDaysIso, daysBetween, round2, todayIso } from './util.ts';

/**
 * Shadow mode: replays the last N days of the business's own invoices through retrofit's current rules,
 * without touching PayPal or the business's data. The first half is exact: which invoices would have gone
 * out with a pay link, which reminders and late fees the rules would have produced, and which of those would
 * have run on their own or waited for the owner. The second half is an estimate, and says so: if a reminder
 * gets an overdue invoice paid within `daysAfterReminder` days, how much sooner the money would have arrived.
 */

export interface ShadowOptions {
  days?: number;
  today?: string;
  /** Assumption for the estimate: a reminder gets an overdue invoice paid within this many days. */
  daysAfterReminder?: number;
}

export interface ShadowExample {
  number: string;
  customer: string;
  amount: number;
  due: string;
  actualPaid: string | null;
  estimatedPaid: string | null;
  daysSooner: number;
  steps: Array<{ on: string; what: string; runs: 'on its own' | 'waits for you' | 'held' }>;
}

export interface ShadowReport {
  window: { from: string; to: string; days: number };
  assumption: string;
  invoices: number;
  sent: number;
  reminders: {
    total: number;
    onTheirOwn: number;
    needYou: number;
    heldByRules: number;
    quietHoursShifted: number;
  };
  lateFees: { count: number; amount: number };
  estimate: {
    overdueInvoices: number;
    /** Amount-weighted average days the money would have arrived sooner. */
    avgDaysSooner: number;
    amountSooner: number;
    /** Still unpaid today, but estimated to have been paid by now. */
    amountByToday: number;
    paidDateUnknown: number;
  };
  weeks: Array<{ week: string; sent: number; reminders: number; lateFees: number }>;
  examples: ShadowExample[];
}

export async function shadowReplay(rf: Retrofit, opts: ShadowOptions = {}): Promise<ShadowReport> {
  const today = opts.today ?? todayIso();
  const days = Math.min(365, Math.max(14, opts.days ?? 90));
  const from = addDaysIso(today, -days);
  const after = Math.min(30, Math.max(1, opts.daysAfterReminder ?? 7));
  const m = rf.mapping;
  const im = m.entities.invoice;
  const paidCol = im.writeBack.paidAt;
  const steps = [...m.collections.steps].sort((a, b) => a.afterDaysOverdue - b.afterDaysOverdue);

  const report: ShadowReport = {
    window: { from, to: today, days },
    assumption: `Estimate only: assumes an overdue invoice is paid within ${after} days of the first reminder (or when it was actually paid, if sooner). Everything else is what your current rules would have done.`,
    invoices: 0,
    sent: 0,
    reminders: { total: 0, onTheirOwn: 0, needYou: 0, heldByRules: 0, quietHoursShifted: 0 },
    lateFees: { count: 0, amount: 0 },
    estimate: { overdueInvoices: 0, avgDaysSooner: 0, amountSooner: 0, amountByToday: 0, paidDateUnknown: 0 },
    weeks: [],
    examples: [],
  };
  const weeks = new Map<string, { sent: number; reminders: number; lateFees: number }>();
  const week = (d: string) => {
    const dt = new Date(`${d}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const k = dt.toISOString().slice(0, 10);
    if (!weeks.has(k)) weeks.set(k, { sent: 0, reminders: 0, lateFees: 0 });
    return weeks.get(k)!;
  };
  const inWindow = (d: string) => d >= from && d <= today;
  // Messages go out at 10:00 business time on the day; quiet hours can still push them (weekends).
  const at10 = (d: string) => new Date(`${d}T10:00:00Z`);
  let weighted = 0;
  let sooner = 0;

  for (const inv of await loadInvoices(rf.source, m)) {
    if (!inv.issued || !inv.due || inv.state === 'cancelled') continue;
    const paidRaw = paidCol ? String(inv.raw[paidCol] ?? '').slice(0, 10) : '';
    const paid = /^\d{4}-\d{2}-\d{2}$/.test(paidRaw) ? paidRaw : null;
    const paidUnknown = inv.state === 'paid' && !paid;
    // In play during the window: issued in it, or still unpaid when it began.
    if (
      inv.issued > today ||
      (inv.issued < from && paid && paid < from) ||
      (inv.issued < from && inv.state === 'paid' && !paid)
    )
      continue;
    const ready = im.push.includes(inv.status) || inv.state === 'paid';
    if (!ready) continue;
    report.invoices++;
    const ex: ShadowExample = {
      number: inv.number,
      customer: inv.customer?.name ?? inv.customerPk,
      amount: inv.total,
      due: inv.due,
      actualPaid: paid,
      estimatedPaid: paid,
      daysSooner: 0,
      steps: [],
    };
    if (inWindow(inv.issued)) {
      report.sent++;
      week(inv.issued).sent++;
      ex.steps.push({ on: inv.issued, what: 'Sent through PayPal with a pay link', runs: 'on its own' });
    }
    const unpaidOn = (d: string) => !(paid && paid <= d) && !(paidUnknown && d >= inv.due!);
    let firstReminder: string | null = null;
    const own = rulesFor(m, inv);
    for (const s of steps) {
      let on = addDaysIso(inv.due, s.afterDaysOverdue);
      if (!inWindow(on) || !unpaidOn(on)) continue;
      if (own.some((r) => r.noReminders)) {
        report.reminders.heldByRules++;
        ex.steps.push({ on, what: `${s.tone} reminder held by your customer rule`, runs: 'held' });
        continue;
      }
      const before = own.find(
        (r) => r.noRemindersBeforeDay && Number(on.slice(8, 10)) < r.noRemindersBeforeDay,
      );
      if (before) on = `${on.slice(0, 8)}${String(before.noRemindersBeforeDay).padStart(2, '0')}`;
      const d = decidePolicy(m, rf.state, 'send_reminder', {
        amount: inv.total,
        now: at10(on),
        currency: m.currency,
      });
      if (d.mode === 'never') continue;
      if (m.quietHours && m.quietHours.kinds.includes('send_reminder') && isQuiet(m.quietHours, at10(on)))
        report.reminders.quietHoursShifted++;
      report.reminders.total++;
      if (d.mode === 'auto') report.reminders.onTheirOwn++;
      else report.reminders.needYou++;
      week(on).reminders++;
      firstReminder ??= on;
      ex.steps.push({
        on,
        what: `${s.tone[0]!.toUpperCase()}${s.tone.slice(1)} reminder`,
        runs: d.mode === 'auto' ? 'on its own' : 'waits for you',
      });
    }
    const fee = m.terms.lateFee;
    if (fee) {
      const on = addDaysIso(inv.due, fee.afterDays);
      if (inWindow(on) && unpaidOn(on) && !own.some((r) => r.noLateFees)) {
        const amount = round2(fee.kind === 'percent' ? (inv.total * fee.amount) / 100 : fee.amount);
        report.lateFees.count++;
        report.lateFees.amount = round2(report.lateFees.amount + amount);
        week(on).lateFees++;
        const d = decidePolicy(m, rf.state, 'apply_late_fee', {
          amount,
          now: at10(on),
          currency: m.currency,
        });
        ex.steps.push({
          on,
          what: `Late fee ${amount.toFixed(2)} ${m.currency}`,
          runs: d.mode === 'auto' ? 'on its own' : 'waits for you',
        });
      }
    }
    // The estimate, for invoices that were (or are) overdue and got a reminder.
    if (paidUnknown) {
      report.estimate.paidDateUnknown++;
    } else if (firstReminder) {
      const actual = paid ?? null;
      const est = addDaysIso(firstReminder, after);
      const estimated = actual && actual < est ? actual : est;
      report.estimate.overdueInvoices++;
      ex.estimatedPaid = estimated;
      if (actual) {
        ex.daysSooner = Math.max(0, daysBetween(estimated, actual));
      } else if (estimated <= today) {
        ex.daysSooner = Math.max(0, daysBetween(estimated, today));
        report.estimate.amountByToday = round2(report.estimate.amountByToday + inv.total);
      }
      if (ex.daysSooner > 0) {
        weighted += ex.daysSooner * inv.total;
        sooner += inv.total;
      }
    }
    if (ex.steps.length) report.examples.push(ex);
  }
  report.estimate.amountSooner = round2(sooner);
  report.estimate.avgDaysSooner = sooner ? Math.round((weighted / sooner) * 10) / 10 : 0;
  report.weeks = [...weeks.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([w, v]) => ({ week: w, ...v }));
  report.examples = report.examples
    .sort((a, b) => b.daysSooner * b.amount - a.daysSooner * a.amount)
    .slice(0, 8);
  return report;
}
