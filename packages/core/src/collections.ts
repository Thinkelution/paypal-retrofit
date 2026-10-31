/**
 * Collections playbook: what a careful bookkeeper does every morning, as code.
 *
 * For each open PayPal invoice it decides one of:
 *   remind    send the next reminder in the sequence (friendly, firm, final) or for a missed instalment
 *   wait      too early, too soon after the last reminder, or a reminder is already queued
 *   hold      open dispute, or the customer promised to pay and the grace period is still running
 *   plan      a note says the customer asked to pay in parts: offer a payment plan instead of chasing
 *   escalate  every reminder has been sent: a person should call
 *
 * The decision is deterministic and explained in one sentence. Sending still goes through the policy
 * engine, so reminders follow the owner's rules, daily limits and quiet hours.
 */
import { autopayCovers, runAutopay } from './autopay.ts';
import type { ActionRecord } from './types.ts';
import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { invoiceRisks, type InvoiceRisk } from './insights.ts';
import { expectedTotal, runTerms } from './terms.ts';
import { addDaysIso, daysBetween, round2, splitName, toMoney, todayIso } from './util.ts';

export type CollectionDecision = 'remind' | 'wait' | 'hold' | 'plan' | 'escalate';
export type Tone = 'friendly' | 'firm' | 'final' | 'instalment';

export interface CollectionItem {
  legacyPk: string;
  number: string;
  customer: string;
  customerFirstName: string;
  amountDue: number;
  due: string | null;
  daysOverdue: number;
  remindersSent: number;
  lastReminderAt: string | null;
  decision: CollectionDecision;
  tone: Tone | null;
  step: number | null;
  reason: string;
  nextReminderOn: string | null;
  risk: InvoiceRisk['band'] | null;
  score: number | null;
  notes: string | null;
  instalment: { n: number; of: number; amount: number; due: string } | null;
}

const OPEN_FOR_REMINDERS = ['SENT', 'UNPAID', 'PARTIALLY_PAID'];

function snippet(notes: string, keywords: string[]) {
  const lower = notes.toLowerCase();
  const k = keywords.find((x) => lower.includes(x));
  return k ? notes.trim().slice(0, 80) : null;
}

const COMPANY_WORDS =
  /\b(inc|llc|ltd|limited|co|corp|company|group|studio|apartments?|residence|school|cafe|bakery|brewing|dental|fitness|florist|spa|yoga|theater|management|mgmt|property|services?|partners|associates|hub|clinic|shop|store|restaurant|hotel|agency)\b|[&()]/i;

/** "Hi Maya," for a person; "Hi there," when the customer name is a business. */
export function greetingName(name: string): string {
  if (!name || COMPANY_WORDS.test(name)) return 'there';
  return splitName(name).given_name.split(' ')[0] || 'there';
}

export async function planCollections(rf: Retrofit, today = todayIso()): Promise<CollectionItem[]> {
  const cfg = rf.mapping.collections;
  const steps = [...cfg.steps].sort((a, b) => a.afterDaysOverdue - b.afterDaysOverdue);
  const risks = new Map((await invoiceRisks(rf, today)).map((r) => [r.legacyPk, r]));
  const disputes = new Set(
    rf.state
      .listDiscrepancies()
      .filter((d) => d.kind === 'dispute')
      .map((d) => d.legacyPk),
  );
  const items: CollectionItem[] = [];

  for (const inv of await loadInvoices(rf.source, rf.mapping)) {
    if (inv.state !== 'open') continue;
    const link = rf.state.getLink('invoice', inv.pk);
    if (!link || !OPEN_FOR_REMINDERS.includes(link.paypalStatus ?? '')) continue;
    const paid = link.paypalPaid ?? 0;
    const amountDue = round2(expectedTotal(rf, inv.pk, inv.total) - paid);
    if (amountDue <= 0) continue;
    const daysOverdue = inv.due ? Math.max(0, daysBetween(inv.due, today)) : 0;
    const history = rf.state.actionsFor('send_reminder', 'invoice', inv.pk);
    const sent = history.filter((a) => a.status === 'executed');
    const queued = history.find((a) => a.status === 'pending' || a.status === 'scheduled');
    const last = sent[0]?.decidedAt?.slice(0, 10) ?? null;
    const risk = risks.get(inv.pk);
    const notes = inv.notes ?? '';
    const base = {
      legacyPk: inv.pk,
      number: inv.number,
      customer: inv.customer?.name ?? `#${inv.customerPk}`,
      customerFirstName: greetingName(inv.customer?.name ?? ''),
      amountDue,
      due: inv.due ?? null,
      daysOverdue,
      remindersSent: sent.length,
      lastReminderAt: last,
      risk: risk?.band ?? null,
      score: risk?.score ?? null,
      notes: notes || null,
      instalment: null,
    };
    const push = (decision: CollectionDecision, reason: string, extra: Partial<CollectionItem> = {}) =>
      items.push({ ...base, decision, reason, tone: null, step: null, nextReminderOn: null, ...extra });
    const tooSoon = last && daysBetween(last, today) < cfg.minDaysBetween;

    if (disputes.has(inv.pk)) {
      push('hold', 'Open buyer dispute: reminders paused until it is resolved');
      continue;
    }
    if (autopayCovers(rf, inv.customerPk, inv.pk, amountDue)) {
      push(
        'hold',
        inv.due && inv.due > today
          ? `On autopay: their saved PayPal is charged on the due date (${inv.due})`
          : 'On autopay: their saved PayPal is charged in this run',
      );
      continue;
    }
    if (queued) {
      push(
        'wait',
        queued.status === 'scheduled'
          ? `A reminder is scheduled for ${queued.runAfter?.slice(0, 16).replace('T', ' ')} UTC`
          : 'A reminder is already waiting for approval',
      );
      continue;
    }

    const plan = rf.state.getPlan(inv.pk);
    if (plan?.status === 'active') {
      const prog = rf.planProgress(plan, paid - (inv.total - plan.total), today);
      const overdueInstalment = plan.schedule.find((s) => s.due < today && s.n > prog.covered);
      if (overdueInstalment && prog.behind > 0) {
        if (tooSoon) {
          push('wait', `Instalment ${overdueInstalment.n} is late, but a reminder went out on ${last}`, {
            nextReminderOn: addDaysIso(last!, cfg.minDaysBetween),
          });
        } else {
          push(
            'remind',
            `Instalment ${overdueInstalment.n} of ${plan.installments} (${toMoney(overdueInstalment.amount)}) was due on ${overdueInstalment.due}`,
            {
              tone: 'instalment',
              instalment: {
                n: overdueInstalment.n,
                of: plan.installments,
                amount: overdueInstalment.amount,
                due: overdueInstalment.due,
              },
            },
          );
        }
      } else {
        push(
          'wait',
          `On a payment plan: ${prog.covered} of ${plan.installments} paid; next instalment ${prog.nextDue?.due ?? 'none'}`,
          {
            nextReminderOn: prog.nextDue ? addDaysIso(prog.nextDue.due, 1) : null,
          },
        );
      }
      continue;
    }

    // What the customer told us in the portal outranks notes in the legacy system.
    const requests = rf.state.listRequests({ status: 'open', legacyPk: inv.pk });
    const offers = rf.state.actionsFor('offer_payment_plan', 'invoice', inv.pk);
    const question = requests.find((r) => r.kind === 'question');
    if (question) {
      push(
        'hold',
        `Customer asked in the portal: “${(question.detail ?? '').slice(0, 80)}”. Reply before chasing`,
      );
      continue;
    }
    const promised = requests.find((r) => r.kind === 'promise' && r.until && r.until >= today);
    if (promised) {
      push('hold', `Customer promised in the portal to pay by ${promised.until}`, {
        nextReminderOn: addDaysIso(promised.until!, 1),
      });
      continue;
    }
    const asked = requests.find((r) => r.kind === 'plan');
    if (asked) {
      if (offers.some((a) => a.status === 'pending' || a.status === 'scheduled'))
        push(
          'wait',
          `The ${asked.installments ?? 2}-part plan the customer asked for is waiting for your approval`,
        );
      else push('plan', `Customer asked in the portal to pay in ${asked.installments ?? 2} parts`);
      continue;
    }

    const planNote = snippet(notes, cfg.planKeywords);
    if (planNote && offers.some((a) => a.status === 'pending' || a.status === 'scheduled')) {
      push('wait', 'A payment-plan offer is waiting for approval');
      continue;
    }
    if (planNote && !offers.some((a) => a.status === 'rejected' || a.status === 'failed')) {
      push('plan', `Note says “${planNote}”: offer a payment plan instead of chasing`);
      continue;
    }
    const promise = snippet(notes, cfg.promiseKeywords);
    if (promise && daysOverdue <= cfg.promiseGraceDays) {
      push(
        'hold',
        `Customer promised to pay (“${promise}”); holding until ${inv.due ? addDaysIso(inv.due, cfg.promiseGraceDays + 1) : 'later'}`,
        {
          nextReminderOn: inv.due ? addDaysIso(inv.due, cfg.promiseGraceDays + 1) : null,
        },
      );
      continue;
    }

    const stage = sent.length;
    if (stage >= steps.length) {
      push(
        'escalate',
        `All ${steps.length} reminders sent (last on ${last}). Call ${base.customerFirstName} or offer a payment plan`,
      );
      continue;
    }
    const next = steps[stage]!;
    const prefix = promise ? 'Promise date passed. ' : '';
    if (!inv.due || daysOverdue < next.afterDaysOverdue) {
      const on = inv.due ? addDaysIso(inv.due, next.afterDaysOverdue) : null;
      push(
        'wait',
        `${prefix}${daysOverdue === 0 ? 'Not overdue yet' : `${daysOverdue} days overdue`}; ${next.tone} reminder due ${on ?? 'later'}`,
        { nextReminderOn: on },
      );
      continue;
    }
    if (tooSoon) {
      push(
        'wait',
        `${prefix}Last reminder went out on ${last}; next ${next.tone} reminder from ${addDaysIso(last!, cfg.minDaysBetween)}`,
        {
          nextReminderOn: addDaysIso(last!, cfg.minDaysBetween),
        },
      );
      continue;
    }
    push(
      'remind',
      `${prefix}${daysOverdue} days overdue: reminder ${stage + 1} of ${steps.length} (${next.tone})`,
      { tone: next.tone, step: stage + 1 },
    );
  }

  const order: Record<CollectionDecision, number> = { remind: 0, plan: 1, escalate: 2, hold: 3, wait: 4 };
  return items.sort((a, b) => order[a.decision] - order[b.decision] || b.daysOverdue - a.daysOverdue);
}

export interface ReminderText {
  subject: string;
  note: string;
}

/** Plain, polite reminder text by tone. The AI writer personalises these when Claude is configured. */
export function reminderTemplate(item: CollectionItem, business: string, currency: string): ReminderText {
  const amt = `${toMoney(item.amountDue)} ${currency}`;
  const hi = `Hi ${item.customerFirstName},`;
  switch (item.tone) {
    case 'instalment':
      return {
        subject: `Instalment ${item.instalment?.n} of ${item.instalment?.of} for invoice ${item.number}`,
        note: `${hi} a quick reminder that instalment ${item.instalment?.n} of your payment plan (${toMoney(item.instalment?.amount ?? 0)} ${currency}) was due on ${item.instalment?.due}. You can pay it from the PayPal link in this email. Thank you, ${business}`,
      };
    case 'firm':
      return {
        subject: `Invoice ${item.number} is ${item.daysOverdue} days overdue`,
        note: `${hi} invoice ${item.number} for ${amt} was due on ${item.due} and is now ${item.daysOverdue} days overdue. Please arrange payment this week using the PayPal link in this email. If something is holding it up, reply and we can work out a plan. Thank you, ${business}`,
      };
    case 'final':
      return {
        subject: `Final reminder: invoice ${item.number}`,
        note: `${hi} this is our final reminder for invoice ${item.number} (${amt}, due ${item.due}). Please pay within 7 days using the PayPal link in this email, or reply so we can agree a payment plan. Thank you, ${business}`,
      };
    default:
      return {
        subject: `Friendly reminder: invoice ${item.number} from ${business}`,
        note: `${hi} just a friendly reminder that invoice ${item.number} for ${amt} was due on ${item.due}. You can pay securely from the PayPal link in this email. If you've already paid, thank you and please ignore this. ${business}`,
      };
  }
}

export interface CollectionsRun {
  items: CollectionItem[];
  proposed: Array<{ item: CollectionItem; action: ActionRecord }>;
  /** Late fees and discount expiries proposed under the owner's payment terms. */
  terms: ActionRecord[];
  /** Charges on customers' saved PayPal for invoices that are due. */
  autopay: ActionRecord[];
  writer: 'template' | 'ai';
}

/**
 * Proposes the actions the plan calls for: reminders (with tone-appropriate text) and payment-plan
 * offers. Each goes through the policy engine, so nothing bypasses the owner's rules.
 */
export async function runCollections(
  rf: Retrofit,
  opts: {
    today?: string;
    only?: string[];
    origin?: 'cli' | 'agent' | 'dashboard' | 'sync' | 'portal';
    writer?: (items: CollectionItem[]) => Promise<Map<string, ReminderText>>;
  } = {},
): Promise<CollectionsRun> {
  // Customers on autopay are charged first, so they never get a reminder for an invoice that is paid.
  const autopay = opts.only ? [] : await runAutopay(rf, { today: opts.today, origin: opts.origin });
  const items = await planCollections(rf, opts.today);
  const todo = items.filter(
    (i) =>
      (i.decision === 'remind' || i.decision === 'plan') && (!opts.only || opts.only.includes(i.legacyPk)),
  );
  const reminders = todo.filter((i) => i.decision === 'remind');
  let texts = new Map<string, ReminderText>();
  let writer: CollectionsRun['writer'] = 'template';
  if (opts.writer && reminders.length) {
    try {
      texts = await opts.writer(reminders);
      writer = 'ai';
    } catch (e) {
      rf.log.warn(`AI reminder writer failed, using templates: ${(e as Error).message}`);
    }
  }
  const proposed: CollectionsRun['proposed'] = [];
  for (const item of todo) {
    const target = { entity: 'invoice' as const, legacyPk: item.legacyPk, label: item.number };
    if (item.decision === 'remind') {
      const t =
        texts.get(item.legacyPk) ?? reminderTemplate(item, rf.config.business.name, rf.mapping.currency);
      const action = await rf.propose({
        origin: opts.origin ?? 'cli',
        kind: 'send_reminder',
        target,
        payload: {
          subject: t.subject,
          note: t.note,
          tone: item.tone,
          step: item.step,
          amount: item.amountDue,
        },
        reason: `Collections: ${item.reason}`,
      });
      proposed.push({ item, action });
    } else {
      const asked = rf.state
        .listRequests({ status: 'open', legacyPk: item.legacyPk })
        .find((r) => r.kind === 'plan');
      const action = await rf.propose({
        origin: opts.origin ?? 'cli',
        kind: 'offer_payment_plan',
        target,
        payload: {
          installments: asked?.installments ?? (item.amountDue >= 1000 ? 3 : 2),
          intervalDays: 14,
          amount: item.amountDue,
        },
        reason: `Collections: ${item.reason}`,
      });
      proposed.push({ item, action });
    }
  }
  const terms = opts.only ? [] : await runTerms(rf, { today: opts.today, origin: opts.origin });
  rf.state.setMeta('lastCollectionsAt', new Date().toISOString());
  rf.emit('collections', { proposed: proposed.length + terms.length + autopay.length });
  return { items: await planCollections(rf, opts.today), proposed, terms, autopay, writer };
}
