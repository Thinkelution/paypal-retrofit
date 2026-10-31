import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { submitCustomerRequest } from './requests.ts';
import { buildStatement, formatMoney } from './statements.ts';
import { addDaysIso, round2, todayIso } from './util.ts';

/**
 * The inbox agent: customers email the business ("can I pay half now?", "I sent a cheque on Friday",
 * "is this right?"), and each email becomes what the owner would have done by hand: a promise that holds
 * reminders, a plan request, a question that pauses chasing, a payment to record, a statement to send.
 * Requests are filed straight away (they only hold reminders); anything that moves money or closes an
 * invoice is proposed as an action and, because an email can be forged, always waits for the owner.
 */

export type InboxIntent =
  'promise' | 'plan' | 'question' | 'dispute' | 'paid_elsewhere' | 'statement' | 'other';

export interface InboundEmail {
  from: string;
  name?: string;
  subject?: string;
  text: string;
}

export interface InboxReading {
  intent: InboxIntent;
  /** Invoice numbers the email is about; empty means the reader could not tell. */
  invoices: string[];
  /** Promise date (YYYY-MM-DD). */
  payBy?: string;
  installments?: number;
  /** Amount the customer says they paid outside PayPal. */
  amount?: number;
  method?: 'CHECK' | 'BANK_TRANSFER' | 'CASH' | 'OTHER';
  paidOn?: string;
  /** One line for the owner. */
  summary: string;
  /** A reply in the business's voice, for the owner to send. */
  reply: string;
  engine: 'claude' | 'rules';
}

export interface InboxContext {
  business: string;
  today: string;
  currency: string;
  customer: { key: string; name: string; email: string } | null;
  open: Array<{ legacyPk: string; number: string; amount: number; due: string | null; daysOverdue: number }>;
  /** Recently paid invoices: complaints and questions are often about these. */
  paid?: Array<{ legacyPk: string; number: string; amount: number; due: string | null; daysOverdue: number }>;
}

export async function inboxContext(
  rf: Retrofit,
  email: InboundEmail,
  today = todayIso(),
): Promise<InboxContext> {
  const cm = rf.mapping.entities.customer;
  const from = email.from.trim().toLowerCase();
  const row = (await rf.source.readTable(cm.table)).find(
    (r) =>
      String(r[cm.fields.email] ?? '')
        .trim()
        .toLowerCase() === from,
  );
  const customer = row
    ? {
        key: String(row[cm.pk]),
        name: String(row[cm.fields.name] ?? ''),
        email: String(row[cm.fields.email]),
      }
    : null;
  const open = customer
    ? (await buildStatement(rf, customer.key, today)).lines.map((l) => ({
        legacyPk: l.legacyPk,
        number: l.number,
        amount: l.balance,
        due: l.due,
        daysOverdue: l.daysOverdue,
      }))
    : [];
  const since = addDaysIso(today, -180);
  const paid = customer
    ? (await loadInvoices(rf.source, rf.mapping))
        .filter((i) => i.customerPk === customer.key && i.state === 'paid' && (i.issued ?? '') >= since)
        .sort((a, b) => (b.issued ?? '').localeCompare(a.issued ?? ''))
        .slice(0, 10)
        .map((i) => ({
          legacyPk: i.pk,
          number: i.number,
          amount: i.total,
          due: i.due ?? null,
          daysOverdue: 0,
        }))
    : [];
  return { business: rf.config.business.name, today, currency: rf.mapping.currency, customer, open, paid };
}

// ---------------------------------------------------------------- reading without Claude

const WORDS: Record<string, number> = { two: 2, three: 3, four: 4, 2: 2, 3: 3, 4: 4, half: 2 };
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "by Friday", "on the 20th", "by Nov 20", "2026-11-20", "end of the month", "next week", "in 10 days". */
export function dateFrom(text: string, today: string): string | undefined {
  const t = text.toLowerCase();
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const base = new Date(`${today}T12:00:00Z`);
  const wd = t.match(
    /\b(?:by|on|before|this|next|until)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  );
  if (wd) return addDaysIso(today, (WEEKDAYS.indexOf(wd[1]!) - base.getUTCDay() + 7) % 7 || 7);
  const md = t.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  if (md) return monthDay(base, MONTHS.indexOf(md[1]!), Number(md[2]));
  const dm = t.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/,
  );
  if (dm) return monthDay(base, MONTHS.indexOf(dm[2]!), Number(dm[1]));
  const th = t.match(/\b(?:by|on|before|until)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (th) {
    const d = Number(th[1]);
    const m = base.getUTCDate() <= d ? base.getUTCMonth() : base.getUTCMonth() + 1;
    return monthDay(base, m, d);
  }
  if (/\bend of (?:the |this )?month\b/.test(t))
    return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  if (/\bnext week\b/.test(t)) return addDaysIso(today, 7);
  if (/\btomorrow\b/.test(t)) return addDaysIso(today, 1);
  const inN = t.match(/\bin\s+(\d+|a|one|two|three)\s+(day|week)s?\b/);
  if (inN) {
    const n = /^\d+$/.test(inN[1]!) ? Number(inN[1]) : ({ a: 1, one: 1, two: 2, three: 3 } as any)[inN[1]!];
    return addDaysIso(today, n * (inN[2] === 'week' ? 7 : 1));
  }
  return undefined;
}

function monthDay(base: Date, month: number, day: number) {
  let y = base.getUTCFullYear();
  if (month < base.getUTCMonth() - 1) y++;
  const d = new Date(Date.UTC(y, ((month % 12) + 12) % 12, day));
  if (month > 11) d.setUTCFullYear(y + 1, month - 12, day);
  return d.toISOString().slice(0, 10);
}

/** Reads the common customer emails with patterns: promises, plans, payments made another way, statements, questions. */
export function readEmailWithRules(email: InboundEmail, ctx: InboxContext): InboxReading {
  const text = `${email.subject ?? ''}\n${email.text}`;
  const t = text.toLowerCase();
  const first = (ctx.customer?.name || email.name || '').split(/\s+/)[0] || 'there';
  const m = (n: number) => formatMoney(n, ctx.currency);

  const named = (o: InboxContext['open'][number]) => {
    const digits = o.number.match(/\d{3,}/)?.[0];
    return t.includes(o.number.toLowerCase()) || Boolean(digits && new RegExp(`\\b${digits}\\b`).test(t));
  };
  const mentioned = ctx.open.filter(named);
  const amountMatch = text.match(
    /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?|\b(\d+(?:\.\d{2})?)\s?(?:dollars|usd)\b/i,
  );
  const amount = amountMatch
    ? Number((amountMatch[1] ?? amountMatch[3])!.replace(/,/g, '')) +
      (amountMatch[2] ? Number(`0.${amountMatch[2]}`) : 0)
    : undefined;

  let intent: InboxIntent = 'other';
  let installments: number | undefined;
  let method: InboxReading['method'];
  const date = dateFrom(text, ctx.today);
  if (
    /\b(paid|sent|mailed|posted|transferred|dropped off)\b[^.]*\b(cheque|check|bank transfer|transfer|wire|ach|cash|zelle)\b|\b(cheque|check)\b[^.]*\b(in the post|in the mail|sent|posted|mailed)\b/.test(
      t,
    )
  ) {
    intent = 'paid_elsewhere';
    method = /cheque|check/.test(t)
      ? 'CHECK'
      : /cash/.test(t)
        ? 'CASH'
        : /transfer|wire|ach/.test(t)
          ? 'BANK_TRANSFER'
          : 'OTHER';
  } else if (
    /\b(instal+ments?|payment plan|in(?:to)? (two|three|four|2|3|4) (parts|payments|instal+ments)|split|half now)\b/.test(
      t,
    )
  ) {
    intent = 'plan';
    const n =
      t.match(/\bin(?:to)? (two|three|four|2|3|4) (?:parts|payments|instal+ments)\b/)?.[1] ??
      (/half now/.test(t) ? 'half' : '2');
    installments = WORDS[n] ?? 2;
  } else if (date && /\b(pay|payment|settle|transfer|send)\b/.test(t)) {
    intent = 'promise';
  } else if (
    /\b(statement|copy of (the |my )?invoice|what do (i|we) owe|current balance|outstanding balance)\b/.test(
      t,
    )
  ) {
    intent = 'statement';
  } else if (
    /\b(dispute|wrong|incorrect|overcharged|charged twice|double charged|not happy|never (received|got)|didn'?t (do|finish|receive))\b/.test(
      t,
    )
  ) {
    intent = 'dispute';
  } else if (/\?/.test(text)) {
    intent = 'question';
  }

  // A payment the customer says they made is in the past: "posted it on Monday" means last Monday.
  let paidOn = date;
  while (intent === 'paid_elsewhere' && paidOn && paidOn > ctx.today) paidOn = addDaysIso(paidOn, -7);
  // Which invoices: the ones named (a paid one only for a complaint or question), else by amount, else the
  // only (or oldest) open one.
  let targets = mentioned;
  if (!targets.length && (intent === 'dispute' || intent === 'question'))
    targets = (ctx.paid ?? []).filter(named);
  if (!targets.length && amount != null) targets = ctx.open.filter((o) => Math.abs(o.amount - amount) < 0.01);
  if (!targets.length && ctx.open.length)
    targets =
      intent === 'promise' || intent === 'statement'
        ? ctx.open
        : [[...ctx.open].sort((a, b) => b.daysOverdue - a.daysOverdue)[0]!];
  const numbers = targets.map((o) => o.number);
  const list = numbers.join(', ') || 'your invoice';

  const summary =
    intent === 'promise'
      ? `Promises to pay ${list} by ${date}`
      : intent === 'plan'
        ? `Asks to pay ${list} in ${installments} parts`
        : intent === 'paid_elsewhere'
          ? `Says they paid ${amount != null ? m(amount) : list} by ${method?.toLowerCase().replace('_', ' ')}${paidOn ? ` on ${paidOn}` : ''}`
          : intent === 'statement'
            ? 'Asks for a statement'
            : intent === 'dispute'
              ? `Disputes ${list}`
              : intent === 'question'
                ? `Asks about ${list}`
                : 'Nothing to act on';
  const reply =
    intent === 'promise'
      ? `Thanks, ${first}. We've noted that you'll pay ${list} by ${date}, and we won't send reminders before then.`
      : intent === 'plan'
        ? `Thanks, ${first}. We've asked for ${list} to be set up as ${installments} payments; you'll get the details by email shortly.`
        : intent === 'paid_elsewhere'
          ? `Thanks, ${first}. We'll check for your ${method?.toLowerCase().replace('_', ' ')} payment${amount != null ? ` of ${m(amount)}` : ''} and mark ${list} as paid once it's confirmed.`
          : intent === 'statement'
            ? `Hi ${first}, your statement is on its way by email, with a link to see and pay everything in one place.`
            : intent === 'dispute' || intent === 'question'
              ? `Thanks, ${first}. Your question about ${list} is with us and we'll reply shortly. We've paused any reminders until then.`
              : `Thanks, ${first}. We've got your email.`;
  return {
    intent,
    invoices: numbers,
    payBy: intent === 'promise' ? date : undefined,
    installments,
    amount: intent === 'paid_elsewhere' ? amount : undefined,
    method,
    paidOn: intent === 'paid_elsewhere' ? (paidOn ?? ctx.today) : undefined,
    summary,
    reply: `${reply}\n\n${ctx.business}`,
    engine: 'rules',
  };
}

// ---------------------------------------------------------------- acting on it

/** Files the email's requests and proposes its actions. Returns what was done, for the owner. */
export async function actOnEmail(rf: Retrofit, id: number, reading: InboxReading, ctx: InboxContext) {
  const outcome: { requests: string[]; actions: number[]; notes: string[] } = {
    requests: [],
    actions: [],
    notes: [],
  };
  const byNumber = new Map(ctx.open.map((o) => [o.number.toLowerCase(), o]));
  const targets = reading.invoices
    .map((n) => byNumber.get(n.toLowerCase()))
    .filter(Boolean) as InboxContext['open'];
  if (!ctx.customer) {
    rf.state.updateInbox(id, {
      reading: reading as any,
      status: 'unknown_sender',
      outcome: { ...outcome, notes: ['The sender is not a known customer'] },
    });
    return rf.state.getInbox(id)!;
  }
  const customerPk = ctx.customer.key;
  const file = async (legacyPk: string, kind: string, extra: Record<string, unknown>) => {
    try {
      const r = await submitCustomerRequest(rf, {
        customerPk,
        legacyPk,
        kind,
        via: 'by email',
        origin: 'inbox',
        ...extra,
      });
      outcome.requests.push(`${r.kind} on ${r.number}`);
    } catch (e) {
      outcome.notes.push((e as Error).message);
    }
  };
  switch (reading.intent) {
    case 'promise':
      if (reading.payBy) for (const t of targets) await file(t.legacyPk, 'promise', { date: reading.payBy });
      else outcome.notes.push('No date found in the promise');
      break;
    case 'plan':
      if (targets[0]) await file(targets[0].legacyPk, 'plan', { installments: reading.installments ?? 2 });
      break;
    case 'question':
    case 'dispute': {
      if (targets[0])
        await file(targets[0].legacyPk, 'question', {
          message: `${reading.intent === 'dispute' ? 'Disputes the invoice (email): ' : 'Email: '}${reading.summary}`,
        });
      const paid = (ctx.paid ?? []).filter((p) =>
        reading.invoices.some((n) => n.toLowerCase() === p.number.toLowerCase()),
      );
      if (!targets.length && paid.length)
        outcome.notes.push(`${paid.map((p) => p.number).join(', ')} is already paid; kept for you to read`);
      break;
    }
    case 'paid_elsewhere': {
      const t = targets[0];
      if (!t) {
        outcome.notes.push('Could not tell which invoice the payment was for');
        break;
      }
      const a = await rf.propose({
        origin: 'inbox',
        kind: 'record_payment',
        target: { entity: 'invoice', legacyPk: t.legacyPk, label: t.number },
        payload: {
          amount: round2(reading.amount ?? t.amount),
          method: reading.method ?? 'OTHER',
          date: reading.paidOn ?? ctx.today,
          note: `Customer says by email: ${reading.summary}`,
        },
        reason: `${ctx.customer.name} emailed: ${reading.summary}`,
      });
      outcome.actions.push(a.id);
      break;
    }
    case 'statement': {
      const a = await rf.propose({
        origin: 'inbox',
        kind: 'send_statement',
        target: { entity: 'customer', legacyPk: customerPk, label: ctx.customer.name },
        payload: {},
        reason: `${ctx.customer.name} asked for a statement by email`,
      });
      outcome.actions.push(a.id);
      break;
    }
    default:
      outcome.notes.push('Nothing to act on; kept for you to read');
  }
  const waiting = outcome.actions.some((x) => rf.state.getAction(x)?.status === 'pending');
  rf.state.updateInbox(id, {
    customerPk,
    reading: reading as any,
    status: waiting || reading.intent === 'other' || reading.intent === 'dispute' ? 'needs_owner' : 'done',
    outcome,
    reply: reading.reply,
  });
  rf.emit('inbox', { id });
  return rf.state.getInbox(id)!;
}

/** Sends the drafted (or edited) reply by email, or keeps it in the outbox when no mail server is set. */
export async function sendInboxReply(rf: Retrofit, id: number, text?: string) {
  const m = rf.state.getInbox(id);
  if (!m) throw new Error('No such email');
  const body = (text ?? m.reply ?? '').trim();
  if (!body) throw new Error('Write a reply first');
  const subject = `Re: ${m.subject ?? 'your email'}`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${body
    .split('\n')
    .map((l) => l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!))
    .join('<br>')}</div>`;
  let status: 'sent' | 'outbox' = 'outbox';
  let detail = 'No email server configured (RETROFIT_SMTP_URL); kept in the outbox';
  if (rf.mailer) {
    const r = await rf.mailer({ to: m.sender, subject, html, text: body });
    status = 'sent';
    detail = `Emailed (${r.id})`;
  }
  rf.state.addOutbox({
    kind: 'reply',
    customerPk: m.customerPk,
    recipient: m.sender,
    subject,
    html,
    text: body,
    status,
    detail,
  });
  rf.state.updateInbox(id, { reply: body, repliedAt: new Date().toISOString() });
  rf.emit('inbox', { id });
  return { status, detail };
}
