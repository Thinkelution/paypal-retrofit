import { DEFAULT_POLICIES, type QuietHours, type RetrofitMapping } from './mapping/schema.ts';
import type { StateStore } from './state/store.ts';
import type { ActionKind, PolicyMode } from './types.ts';
import { toMoney } from './util.ts';

export interface PolicyDecision {
  mode: PolicyMode;
  /** One sentence a person can read: which rule, limit or default applied. */
  reason: string;
  /** Set when the action must wait for business hours. ISO timestamp. */
  holdUntil?: string;
}

const LABEL: Record<ActionKind, string> = {
  create_invoice: 'creating invoices',
  send_invoice: 'sending invoices',
  update_invoice: 'updating invoices',
  send_reminder: 'reminders',
  cancel_invoice: 'cancellations',
  record_payment: 'recording payments received outside PayPal',
  create_refund: 'refunds',
  create_subscription: 'new subscriptions',
  cancel_subscription: 'cancelling subscriptions',
  accept_dispute: 'accepting dispute claims',
  offer_payment_plan: 'payment plans',
  apply_late_fee: 'late fees',
  expire_discount: 'ending early-payment discounts',
  send_statement: 'customer statements',
};

/**
 * Decides how an action may run. Order: conditional rules (by amount), then the per-kind policy, then
 * the default. "auto" is downgraded to "confirm" when today's limit would be exceeded. Customer-facing
 * actions that would run during quiet hours are held until the window ends.
 */
export function decidePolicy(
  mapping: RetrofitMapping,
  state: StateStore,
  kind: ActionKind,
  ctx: { amount?: number | null; now?: Date; autoApprove?: boolean; currency?: string },
): PolicyDecision {
  const now = ctx.now ?? new Date();
  const cur = ctx.currency ?? mapping.currency;
  const amount = ctx.amount ?? null;
  let mode: PolicyMode;
  let reason: string;

  const rule = mapping.rules.find(
    (r) =>
      r.kind === kind &&
      (r.maxAmount === undefined || (amount !== null && amount <= r.maxAmount)) &&
      (r.minAmount === undefined || (amount !== null && amount >= r.minAmount)),
  );
  if (rule) {
    mode = rule.mode;
    const range =
      rule.maxAmount !== undefined && rule.minAmount !== undefined
        ? ` between ${toMoney(rule.minAmount)} and ${toMoney(rule.maxAmount)} ${cur}`
        : rule.maxAmount !== undefined
          ? ` up to ${toMoney(rule.maxAmount)} ${cur}`
          : rule.minAmount !== undefined
            ? ` of ${toMoney(rule.minAmount)} ${cur} or more`
            : '';
    reason = `Rule: ${LABEL[kind]}${range} are "${rule.mode}"${rule.note ? ` (${rule.note})` : ''}`;
  } else if (mapping.policies[kind]) {
    mode = mapping.policies[kind]!;
    reason = `Policy for ${LABEL[kind]} is "${mode}"`;
  } else {
    mode = DEFAULT_POLICIES[kind];
    reason = `Default policy for ${LABEL[kind]} is "${mode}"`;
    // Large amounts never run on a default "auto" without a rule saying so.
  }

  if (mode === 'confirm' && ctx.autoApprove) {
    mode = 'auto';
    reason += '; demo auto-approve is on';
  }

  if (mode === 'auto') {
    const limit = mapping.limits.find((l) => l.kind === kind);
    if (limit) {
      const since = startOfDay(now, mapping.quietHours?.timezone ?? 'UTC');
      const used = state.executedSince(kind, since.toISOString());
      if (limit.perDay !== undefined && used.count + 1 > limit.perDay) {
        mode = 'confirm';
        reason = `Daily limit reached: ${used.count} of ${limit.perDay} ${LABEL[kind]} already ran today, so this one needs approval`;
      } else if (
        limit.amountPerDay !== undefined &&
        amount !== null &&
        used.amount + amount > limit.amountPerDay
      ) {
        mode = 'confirm';
        reason = `Daily limit: ${toMoney(used.amount)} of ${toMoney(limit.amountPerDay)} ${cur} in ${LABEL[kind]} already ran today; this ${toMoney(amount)} needs approval`;
      }
    }
  }

  const decision: PolicyDecision = { mode, reason };
  const qh = mapping.quietHours;
  if (mode !== 'never' && qh && qh.kinds.includes(kind) && isQuiet(qh, now)) {
    decision.holdUntil = nextBusinessTime(qh, now).toISOString();
  }
  return decision;
}

// ---------------------------------------------------------------- time helpers

export function localParts(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  return {
    weekday: get('weekday'),
    minutes: hour * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function isQuiet(qh: QuietHours, d: Date): boolean {
  const { weekday, minutes } = localParts(d, qh.timezone);
  if (qh.weekends && (weekday === 'Sat' || weekday === 'Sun')) return true;
  const s = toMin(qh.start);
  const e = toMin(qh.end);
  return s > e ? minutes >= s || minutes < e : minutes >= s && minutes < e;
}

/** The first moment after `d` that is outside quiet hours (to the next 5 minutes). */
export function nextBusinessTime(qh: QuietHours, d: Date): Date {
  let t = new Date(Math.ceil(d.getTime() / 300000) * 300000);
  for (let i = 0; i < 12 * 24 * 4 && isQuiet(qh, t); i++) t = new Date(t.getTime() + 300000);
  return t;
}

/** Midnight today in a time zone, as a Date. */
export function startOfDay(d: Date, timeZone: string): Date {
  const { minutes } = localParts(d, timeZone);
  const seconds = d.getUTCSeconds();
  return new Date(d.getTime() - minutes * 60000 - seconds * 1000 - d.getUTCMilliseconds());
}

export function describeLocal(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}
