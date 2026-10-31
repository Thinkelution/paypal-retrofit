import { planCollections } from './collections.ts';
import { ordinal } from './customer-rules.ts';
import type { Retrofit } from './engine.ts';
import { RetrofitMapping, type CustomerRule } from './mapping/schema.ts';
import { decidePolicy } from './policy.ts';
import { formatMoney } from './statements.ts';
import { planTerms } from './terms.ts';
import { ACTION_KINDS, type ActionKind, type PolicyMode } from './types.ts';
import { todayIso } from './util.ts';

/**
 * The owner's rules in plain English. A sentence such as "refunds over $200 need me; never chase schools before
 * the 20th" is compiled (by Claude, or by patterns for common sentences) into structured changes. Nothing is
 * saved until the owner has seen a preview of exactly what would change today: which reminders would be held,
 * which late fees added or dropped, which waiting actions would now run on their own.
 */

export type RuleChange =
  | {
      type: 'approval';
      kind: ActionKind;
      mode: PolicyMode;
      minAmount?: number;
      maxAmount?: number;
      explanation: string;
    }
  | { type: 'limit'; kind: ActionKind; perDay?: number; amountPerDay?: number; explanation: string }
  | { type: 'quiet_hours'; start: string; end: string; weekends: boolean; explanation: string }
  | { type: 'customer'; rule: CustomerRule; explanation: string }
  | { type: 'late_fee'; kind: 'percent' | 'flat'; amount: number; afterDays: number; explanation: string }
  | { type: 'discount'; percent: number; withinDays: number; explanation: string }
  | { type: 'plans'; maxAmount?: number; maxInstallments?: number; explanation: string }
  | { type: 'reminder_days'; days: number[]; explanation: string };

export interface RulesContext {
  currency: string;
  customers: Array<{ key: string; name: string }>;
}

const KIND_WORDS: Array<[RegExp, ActionKind, string]> = [
  [/refunds?/, 'create_refund', 'refunds'],
  [/reminders?/, 'send_reminder', 'reminders'],
  [/(payment )?plans?|instal+ments?/, 'offer_payment_plan', 'payment plans'],
  [/late fees?/, 'apply_late_fee', 'late fees'],
  [/statements?/, 'send_statement', 'statements'],
  [/cancel+(ations?|ing)?/, 'cancel_invoice', 'cancellations'],
  [/bills?|suppliers?|contractors?|vendors?|payouts?/, 'pay_supplier', 'supplier payments'],
  [
    /(recorded |cash |cheque |check )?payments?( outside paypal)?/,
    'record_payment',
    'payments recorded outside PayPal',
  ],
  [/autopay( charges)?/, 'charge_autopay', 'autopay charges'],
];
const kindIn = (s: string) => KIND_WORDS.find(([re]) => re.test(s));
const num = (s: string) => Number(s.replace(/[$,]/g, ''));
const clock = (h: string, m: string | undefined, ap: string | undefined) => {
  let hour = Number(h) % 12;
  if (ap?.toLowerCase() === 'pm') hour += 12;
  if (!ap && Number(h) >= 13) hour = Number(h);
  return `${String(hour).padStart(2, '0')}:${m ?? '00'}`;
};

/** Customers named in a phrase: by full name if they exist, else words such as "schools" → "school". */
function matchFor(phrase: string, ctx: RulesContext): CustomerRule['match'] {
  const p = phrase
    .toLowerCase()
    .replace(/\b(the|our|any|all|customers?|clients?|accounts?)\b/g, ' ')
    .trim();
  const named = ctx.customers.filter((c) => c.name && p.includes(c.name.toLowerCase()));
  if (named.length) return { customers: named.map((c) => c.key) };
  const words = p
    .split(/\s*(?:,|\band\b|\bor\b)\s*/)
    .map((w) =>
      w
        .trim()
        .replace(/ies$/, 'y')
        .replace(/(?<=[a-z]{3})s$/, ''),
    )
    .filter((w) => w.length >= 3);
  return { nameContains: words };
}

/** Who a customer rule is about, for the explanation: the customers' own names when they were named. */
const whoOf = (match: CustomerRule['match'], phrase: string, ctx: RulesContext) =>
  match.customers?.length
    ? match.customers.map((k) => ctx.customers.find((c) => c.key === k)?.name ?? k).join(', ')
    : phrase;

/** Common sentences, without Claude. Anything it cannot read comes back in `unsupported`. */
export function parseRulesWithPatterns(
  text: string,
  ctx: RulesContext,
): { changes: RuleChange[]; unsupported: string[] } {
  const changes: RuleChange[] = [];
  const unsupported: string[] = [];
  const m = (n: number) => formatMoney(n, ctx.currency);
  for (const raw of text.split(/[.;\n]+|\s+(?:and also|also)\s+/i)) {
    const s = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) continue;
    let hit = true;
    let x: RegExpMatchArray | null;
    if (
      (x = s.match(
        /^(?:please )?(?:never|don't|do not) (?:chase|remind|send (?:any )?reminders to) (.+?) before the (\d{1,2})(?:st|nd|rd|th)?\b/,
      ))
    ) {
      const rule: CustomerRule = {
        match: matchFor(x[1]!, ctx),
        noRemindersBeforeDay: Math.min(28, Math.max(2, Number(x[2]))),
        note: raw.trim(),
      };
      changes.push({
        type: 'customer',
        rule,
        explanation: `No reminders to ${whoOf(rule.match, x[1]!, ctx)} before the ${ordinal(Number(x[2]))} of the month`,
      });
    } else if ((x = s.match(/^no late fees? (?:for|to|on) (.+)$/))) {
      const match = matchFor(x[1]!, ctx);
      changes.push({
        type: 'customer',
        rule: { match, noLateFees: true, note: raw.trim() },
        explanation: `Never add late fees for ${whoOf(match, x[1]!, ctx)}`,
      });
    } else if (
      (x = s.match(/^(?:please )?(?:never|don't|do not) (?:chase|remind|send (?:any )?reminders to) (.+)$/))
    ) {
      const match = matchFor(x[1]!, ctx);
      changes.push({
        type: 'customer',
        rule: { match, noReminders: true, note: raw.trim() },
        explanation: `Never send reminders to ${whoOf(match, x[1]!, ctx)}`,
      });
    } else if (
      (x = s.match(
        /^(.+?) (?:over|above|more than|bigger than|of more than) \$?([\d,]+(?:\.\d+)?)\b.*\b(?:need|needs|require|requires|wait for|go to|come to) (?:me|my ok|my approval|approval)/,
      )) &&
      kindIn(x[1]!)
    ) {
      const [, kind, label] = kindIn(x[1]!)!;
      changes.push({
        type: 'approval',
        kind,
        mode: 'confirm',
        minAmount: num(x[2]!),
        explanation: `${cap(label)} of ${m(num(x[2]!))} or more wait for your OK`,
      });
    } else if (
      (x = s.match(
        /^(.+?) (?:up to|under|below|less than|of up to) \$?([\d,]+(?:\.\d+)?)\b.*\b(?:run|go|happen)?\s*(?:on their own|automatically|without me|auto)/,
      )) &&
      kindIn(x[1]!)
    ) {
      const [, kind, label] = kindIn(x[1]!)!;
      changes.push({
        type: 'approval',
        kind,
        mode: 'auto',
        maxAmount: num(x[2]!),
        explanation: `${cap(label)} up to ${m(num(x[2]!))} run on their own`,
      });
    } else if (
      (x = s.match(/^(?:never|don't ever|do not ever) (?:send |do |give |make |issue )?(.+)$/)) &&
      kindIn(x[1]!)
    ) {
      const [, kind, label] = kindIn(x[1]!)!;
      changes.push({ type: 'approval', kind, mode: 'never', explanation: `${cap(label)} are never done` });
    } else if (
      (x = s.match(
        /(?:no|don't send|never send|do not send) (?:reminders|messages|emails)(?: to customers)?\s*(?:after|past) (\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:.*?before (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/,
      ))
    ) {
      const start = clock(x[1]!, x[2], x[3] ?? 'pm');
      const end = x[4] ? clock(x[4], x[5], x[6] ?? 'am') : '08:00';
      const weekends = /weekend|saturday|sunday/.test(s);
      changes.push({
        type: 'quiet_hours',
        start,
        end,
        weekends,
        explanation: `No messages to customers between ${start} and ${end}${weekends ? ', or at weekends' : ''}`,
      });
    } else if (
      (x = s.match(
        /(\d+(?:\.\d+)?)\s?%\s*late fee after (\d+) days|late fee of (\d+(?:\.\d+)?)\s?(%|percent)? after (\d+) days|late fee of \$([\d.]+) after (\d+) days/,
      ))
    ) {
      const percent = x[1] ?? (x[3] && x[4] ? x[3] : undefined);
      const flat = x[6] ?? (x[3] && !x[4] ? x[3] : undefined);
      const after = Number(x[2] ?? x[5] ?? x[7]);
      if (percent)
        changes.push({
          type: 'late_fee',
          kind: 'percent',
          amount: Number(percent),
          afterDays: after,
          explanation: `A ${percent}% late fee once an invoice is ${after} days overdue`,
        });
      else
        changes.push({
          type: 'late_fee',
          kind: 'flat',
          amount: Number(flat),
          afterDays: after,
          explanation: `A ${m(Number(flat))} late fee once an invoice is ${after} days overdue`,
        });
    } else if (
      (x = s.match(
        /(\d+(?:\.\d+)?)\s?% (?:off|discount) (?:if|for|when) (?:they )?(?:paid|paying|pay) within (\d+) days/,
      ))
    ) {
      changes.push({
        type: 'discount',
        percent: Number(x[1]),
        withinDays: Number(x[2]),
        explanation: `${x[1]}% off for paying within ${x[2]} days`,
      });
    } else if (
      (x = s.match(
        /(?:agree|accept|allow|ok) (?:to )?(?:payment )?plans? (?:of |for )?(?:up to|under|below) \$?([\d,]+)(?:.*?(?:in|over) (?:up to )?(\d+) (?:payments|parts|instal+ments))?/,
      ))
    ) {
      const c: RuleChange = {
        type: 'plans',
        maxAmount: num(x[1]!),
        maxInstallments: x[2] ? Number(x[2]) : undefined,
        explanation: `Payment plans up to ${m(num(x[1]!))}${x[2] ? ` in up to ${x[2]} payments` : ''} are agreed without you`,
      };
      changes.push(c);
    } else if (
      (x = s.match(
        /remind(?:ers?)? (?:customers )?(?:at|after|on)\s+(?:days?\s+)?([\d,\sand]+?)\s*(?:days)?(?:\s+overdue)?$/,
      ))
    ) {
      const days = [...x[1]!.matchAll(/\d+/g)].map((d) => Number(d[0])).filter((d) => d >= 0 && d <= 180);
      if (days.length)
        changes.push({
          type: 'reminder_days',
          days: [...new Set(days)].sort((a, b) => a - b),
          explanation: `Reminders at ${days.join(', ')} days overdue`,
        });
      else hit = false;
    } else if ((x = s.match(/no more than (\d+) (.+?) (?:a|per) day/)) && kindIn(x[2]!)) {
      const [, kind, label] = kindIn(x[2]!)!;
      changes.push({
        type: 'limit',
        kind,
        perDay: Number(x[1]),
        explanation: `At most ${x[1]} ${label} run on their own each day`,
      });
    } else hit = false;
    if (!hit) unsupported.push(raw.trim());
  }
  return { changes, unsupported };
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** The mapping with the changes applied, validated. */
export function applyRuleChanges(
  mapping: RetrofitMapping,
  changes: RuleChange[],
  timezone = 'UTC',
): RetrofitMapping {
  const m = structuredClone(mapping);
  for (const c of changes) {
    switch (c.type) {
      case 'approval': {
        const same = (r: (typeof m.rules)[number]) =>
          r.kind === c.kind && r.minAmount === c.minAmount && r.maxAmount === c.maxAmount;
        // First matching rule wins, so new rules go in front.
        m.rules = [
          { kind: c.kind, mode: c.mode, minAmount: c.minAmount, maxAmount: c.maxAmount, note: c.explanation },
          ...m.rules.filter((r) => !same(r)),
        ];
        break;
      }
      case 'limit':
        m.limits = [
          ...m.limits.filter((l) => l.kind !== c.kind),
          { kind: c.kind, perDay: c.perDay, amountPerDay: c.amountPerDay },
        ];
        break;
      case 'quiet_hours':
        m.quietHours = {
          start: c.start,
          end: c.end,
          weekends: c.weekends,
          timezone: m.quietHours?.timezone ?? timezone,
          kinds: m.quietHours?.kinds ?? [
            'send_reminder',
            'offer_payment_plan',
            'apply_late_fee',
            'send_statement',
          ],
        };
        break;
      case 'customer':
        m.customerRules = [...m.customerRules, c.rule];
        break;
      case 'late_fee':
        m.terms = {
          ...m.terms,
          lateFee: {
            kind: c.kind,
            amount: c.amount,
            afterDays: c.afterDays,
            label: c.kind === 'percent' ? `Late payment fee (${c.amount}%)` : 'Late payment fee',
          },
        };
        break;
      case 'discount':
        m.terms = { ...m.terms, earlyDiscount: { percent: c.percent, withinDays: c.withinDays } };
        break;
      case 'plans':
        m.plans = {
          ...m.plans,
          autoAccept: {
            ...m.plans.autoAccept,
            ...(c.maxAmount != null ? { maxAmount: c.maxAmount } : {}),
            ...(c.maxInstallments ? { maxInstallments: c.maxInstallments } : {}),
          },
          maxInstallments: Math.max(m.plans.maxInstallments, c.maxInstallments ?? 0),
        };
        break;
      case 'reminder_days': {
        const tones = ['friendly', 'firm', 'final'] as const;
        m.collections = {
          ...m.collections,
          steps: c.days.map((d, i) => ({ afterDaysOverdue: d, tone: tones[Math.min(i, 2)]! })),
        };
        break;
      }
    }
  }
  return RetrofitMapping.parse(m);
}

export interface RulesPreview {
  collections: Array<{ number: string; customer: string; before: string; after: string; reason: string }>;
  lateFees: { added: string[]; dropped: string[] };
  waiting: Array<{ id: number; label: string; before: string; after: string; reason: string }>;
  summary: string;
}

/** What the changed rules would do today, compared with the current ones. Saves nothing. */
export async function previewRules(
  rf: Retrofit,
  candidate: RetrofitMapping,
  today = todayIso(),
): Promise<RulesPreview> {
  const current = rf.mapping;
  const [planBefore, feesBefore] = [await planCollections(rf, today), await planTerms(rf, today)];
  let planAfter: Awaited<ReturnType<typeof planCollections>>;
  let feesAfter: Awaited<ReturnType<typeof planTerms>>;
  try {
    rf.mapping = candidate;
    planAfter = await planCollections(rf, today);
    feesAfter = await planTerms(rf, today);
  } finally {
    rf.mapping = current;
  }
  const before = new Map(planBefore.map((i) => [i.legacyPk, i]));
  const collections = planAfter
    .filter((i) => before.get(i.legacyPk) && before.get(i.legacyPk)!.decision !== i.decision)
    .map((i) => ({
      number: i.number,
      customer: i.customer,
      before: before.get(i.legacyPk)!.decision,
      after: i.decision,
      reason: i.reason,
    }));
  const fee = (xs: typeof feesBefore) =>
    new Set(xs.filter((f) => f.kind === 'late_fee').map((f) => f.number));
  const fb = fee(feesBefore);
  const fa = fee(feesAfter);
  const waiting = [...rf.state.listActions('pending', 200), ...rf.state.listActions('scheduled', 200)]
    .map((a) => {
      const was = decidePolicy(current, rf.state, a.kind, { amount: a.amount, currency: current.currency });
      const now = decidePolicy(candidate, rf.state, a.kind, {
        amount: a.amount,
        currency: candidate.currency,
      });
      return {
        id: a.id,
        label: `${a.kind.replace(/_/g, ' ')} · ${a.target.label ?? a.target.legacyPk}`,
        before: was.mode,
        after: now.mode,
        reason: now.reason,
      };
    })
    .filter((x) => x.before !== x.after);
  const added = [...fa].filter((n) => !fb.has(n));
  const dropped = [...fb].filter((n) => !fa.has(n));
  const parts = [
    collections.length
      ? `${collections.length} reminder decision${collections.length === 1 ? '' : 's'} change`
      : '',
    added.length ? `${added.length} late fee${added.length === 1 ? '' : 's'} would be added` : '',
    dropped.length ? `${dropped.length} late fee${dropped.length === 1 ? '' : 's'} would be dropped` : '',
    waiting.length
      ? `${waiting.length} waiting action${waiting.length === 1 ? '' : 's'} would be decided differently`
      : '',
  ].filter(Boolean);
  return {
    collections,
    lateFees: { added, dropped },
    waiting,
    summary: parts.length
      ? `Today: ${parts.join('; ')}.`
      : 'Nothing changes today; the rules apply from now on.',
  };
}

/** The current rules, as sentences the owner would write. */
export function describeRules(
  m: RetrofitMapping,
  customers: Array<{ key: string; name: string }> = [],
): string[] {
  const money = (n: number) => formatMoney(n, m.currency);
  const label = (k: ActionKind) => KIND_WORDS.find(([, kind]) => kind === k)?.[2] ?? k.replace(/_/g, ' ');
  const out: string[] = [];
  for (const r of m.rules) {
    const range =
      r.minAmount != null && r.maxAmount != null
        ? ` between ${money(r.minAmount)} and ${money(r.maxAmount)}`
        : r.minAmount != null
          ? ` of ${money(r.minAmount)} or more`
          : r.maxAmount != null
            ? ` up to ${money(r.maxAmount)}`
            : '';
    out.push(
      `${cap(label(r.kind))}${range} ${r.mode === 'auto' ? 'run on their own' : r.mode === 'confirm' ? 'wait for your OK' : 'are never done'}.`,
    );
  }
  for (const k of ACTION_KINDS)
    if (m.policies[k])
      out.push(
        `${cap(label(k))} ${m.policies[k] === 'auto' ? 'run on their own' : m.policies[k] === 'confirm' ? 'wait for your OK' : 'are never done'} (unless a rule above says otherwise).`,
      );
  for (const l of m.limits)
    out.push(
      `At most ${l.perDay != null ? `${l.perDay} ${label(l.kind)}` : `${money(l.amountPerDay ?? 0)} in ${label(l.kind)}`} run on their own each day.`,
    );
  if (m.quietHours)
    out.push(
      `No messages to customers between ${m.quietHours.start} and ${m.quietHours.end}${m.quietHours.weekends ? ' or at weekends' : ''} (${m.quietHours.timezone}).`,
    );
  out.push(`Reminders at ${m.collections.steps.map((s) => s.afterDaysOverdue).join(', ')} days overdue.`);
  if (m.terms.lateFee)
    out.push(
      `A ${m.terms.lateFee.kind === 'percent' ? `${m.terms.lateFee.amount}%` : money(m.terms.lateFee.amount)} late fee once an invoice is ${m.terms.lateFee.afterDays} days overdue.`,
    );
  if (m.terms.earlyDiscount)
    out.push(
      `${m.terms.earlyDiscount.percent}% off for paying within ${m.terms.earlyDiscount.withinDays} days.`,
    );
  out.push(
    `Payment plans up to ${money(m.plans.autoAccept.maxAmount)} in up to ${m.plans.autoAccept.maxInstallments} payments are agreed without you; up to ${m.plans.maxInstallments} payments with your OK.`,
  );
  const names = new Map(customers.map((c) => [c.key, c.name]));
  for (const r of m.customerRules) {
    const who =
      r.match.customers?.map((k) => names.get(k) ?? k).join(', ') ??
      r.match.nameContains?.map((w) => `customers with "${w}" in their name`).join(', ') ??
      r.match.emailDomains?.map((d) => `@${d}`).join(', ');
    out.push(
      r.note
        ? `${r.note.replace(/\.$/, '')}.`
        : `${cap(who ?? 'Some customers')}: ${[r.noReminders ? 'no reminders' : null, r.noRemindersBeforeDay ? `no reminders before the ${ordinal(r.noRemindersBeforeDay)}` : null, r.noLateFees ? 'no late fees' : null].filter(Boolean).join(', ')}.`,
    );
  }
  return out;
}
