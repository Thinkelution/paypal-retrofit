import crypto from 'node:crypto';
import { planCollections } from './collections.ts';
import type { Retrofit } from './engine.ts';
import { cashForecast, invoiceRisks } from './insights.ts';
import { ledger, summary } from './ledger.ts';
import { localParts } from './policy.ts';
import type { ActionRecord } from './types.ts';
import { round2 } from './util.ts';

/**
 * The owner's morning digest: what came in, what needs a decision, what is at risk and what the
 * collections playbook will do today. Built from the same engine data as the console, rendered as an
 * email (HTML + text) and a Slack message with one-click approval links.
 */
export interface DigestData {
  business: string;
  currency: string;
  generatedAt: string;
  since: string;
  timezone: string;
  greeting: string;
  headline: string;
  /** Optional short note written by Claude; the headline is the deterministic fallback. */
  note?: string;
  money: {
    gross: number;
    fees: number;
    net: number;
    refunds: number;
    count: number;
    items: Array<{
      number: string;
      customer: string;
      amount: number;
      kind: string;
      method: string | null;
      at: string;
    }>;
  };
  totals: {
    open: number;
    openAmount: number;
    overdue: number;
    overdueAmount: number;
    expected7: number;
    expected30: number;
    atRisk: number;
    activePlans: number;
  };
  approvals: Array<{
    id: number;
    kind: string;
    label: string;
    customer: string;
    amount: number | null;
    reason: string;
    policyReason: string | null;
    createdAt: string;
  }>;
  approvalsTotal: number;
  scheduled: Array<{ id: number; kind: string; label: string; runAfter: string | null }>;
  playbook: { remind: number; wait: number; hold: number; plan: number; escalate: number };
  escalate: Array<{ number: string; customer: string; amountDue: number; reason: string }>;
  risks: Array<{
    number: string;
    customer: string;
    amountDue: number;
    daysOverdue: number;
    band: string;
    expectedPayDate: string;
    factors: string[];
  }>;
  attention: Array<{ kind: string; label: string; detail: string; suggestion: string | null }>;
  /** What customers asked for in the portal (still open). */
  requests: Array<{ customer: string; number: string; kind: string; detail: string }>;
  /** Shop and buyer-agent sales completed since the last digest. */
  sales: {
    count: number;
    total: number;
    items: Array<{ id: string; channel: string; total: number; buyer: string }>;
  };
}

export const KIND_LABEL: Record<string, string> = {
  create_invoice: 'Create invoice',
  send_invoice: 'Send invoice',
  update_invoice: 'Update invoice',
  cancel_invoice: 'Cancel invoice',
  send_reminder: 'Send reminder',
  record_payment: 'Record payment',
  create_refund: 'Refund',
  create_subscription: 'Start subscription',
  cancel_subscription: 'Cancel subscription',
  accept_dispute: 'Accept dispute',
  offer_payment_plan: 'Offer payment plan',
};

export function businessTimezone(rf: Retrofit): string {
  return rf.mapping.quietHours?.timezone ?? process.env.RETROFIT_TIMEZONE ?? 'UTC';
}

export async function buildDigest(
  rf: Retrofit,
  opts: { now?: Date; since?: string } = {},
): Promise<DigestData> {
  const now = opts.now ?? new Date();
  const tz = businessTimezone(rf);
  const since =
    opts.since ?? rf.state.getMeta('digest.lastSentAt') ?? new Date(now.getTime() - 86400000).toISOString();
  const [rows, sum, forecast, risks, plan] = await Promise.all([
    ledger(rf),
    summary(rf),
    cashForecast(rf),
    invoiceRisks(rf),
    planCollections(rf),
  ]);
  const byPk = new Map(rows.filter((r) => r.entity === 'invoice').map((r) => [r.legacyPk, r]));
  const label = (pk: string) => byPk.get(pk)?.number ?? `#${pk}`;
  const who = (pk: string) => byPk.get(pk)?.customer ?? '';

  const payments = rf.state.listPayments(since, now.toISOString());
  const incoming = payments.filter((p) => p.kind === 'payment' || p.kind === 'external_payment');
  const refunds = payments.filter((p) => p.kind === 'refund' || p.kind === 'external_refund');
  const gross = round2(incoming.reduce((s, p) => s + p.gross, 0));
  const fees = round2(incoming.reduce((s, p) => s + (p.fee ?? 0), 0));

  const pending = rf.state.listActions('pending', 500);
  const scheduled = rf.state.listActions('scheduled', 500);
  const target = (a: ActionRecord) => a.target.label ?? label(a.target.legacyPk);

  const playbook = { remind: 0, wait: 0, hold: 0, plan: 0, escalate: 0 };
  for (const i of plan) playbook[i.decision]++;

  const local = localParts(now, tz);
  const hour = Math.floor(local.minutes / 60);
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const expected7 = round2(forecast.weeks[0]?.expected ?? 0);

  const data: DigestData = {
    business: rf.config.business.name,
    currency: rf.mapping.currency,
    generatedAt: now.toISOString(),
    since,
    timezone: tz,
    greeting,
    headline: '',
    money: {
      gross,
      fees,
      net: round2(gross - fees),
      refunds: round2(refunds.reduce((s, p) => s + Math.abs(p.gross), 0)),
      count: incoming.length,
      items: payments
        .slice(-12)
        .reverse()
        .map((p) => {
          const order = p.entity === 'order' ? rf.state.getOrder(p.legacyPk) : undefined;
          return { p, order };
        })
        .map(({ p, order }) => ({
          number: order ? `Order ${order.id}` : label(p.legacyPk),
          customer: order ? (order.buyer?.name ?? order.buyer?.email ?? '') : who(p.legacyPk),
          amount: p.gross,
          kind: p.kind,
          method: p.method,
          at: p.occurredAt,
        })),
    },
    totals: {
      open: sum.open,
      openAmount: sum.openAmount,
      overdue: sum.overdue,
      overdueAmount: sum.overdueAmount,
      expected7,
      expected30: forecast.next30,
      atRisk: forecast.atRisk,
      activePlans: sum.activePlans,
    },
    approvals: pending.slice(0, 8).map((a) => ({
      id: a.id,
      kind: a.kind,
      label: target(a),
      customer: who(a.target.legacyPk),
      amount: a.amount,
      reason: a.reason,
      policyReason: a.policyReason,
      createdAt: a.createdAt,
    })),
    approvalsTotal: pending.length,
    scheduled: scheduled
      .slice(0, 8)
      .map((a) => ({ id: a.id, kind: a.kind, label: target(a), runAfter: a.runAfter })),
    playbook,
    escalate: plan
      .filter((i) => i.decision === 'escalate')
      .slice(0, 5)
      .map((i) => ({ number: i.number, customer: i.customer, amountDue: i.amountDue, reason: i.reason })),
    risks: risks
      .filter((r) => r.band !== 'low')
      .slice(0, 3)
      .map((r) => ({
        number: r.number,
        customer: r.customer,
        amountDue: r.amountDue,
        daysOverdue: r.daysOverdue,
        band: r.band,
        expectedPayDate: r.expectedPayDate,
        factors: r.factors.slice(0, 2),
      })),
    attention: rf.state
      .listDiscrepancies()
      .slice(0, 6)
      .map((d) => ({
        kind: d.kind,
        label: d.legacyPk ? label(d.legacyPk) : (d.paypalId ?? d.entity),
        detail: d.detail,
        suggestion: d.suggestion,
      })),
    requests: rf.state
      .listRequests({ status: 'open' })
      .slice(0, 8)
      .map((r) => ({
        customer: rows.find((x) => x.entity === 'invoice' && x.legacyPk === r.legacyPk)?.customer ?? '',
        number: r.legacyPk ? label(r.legacyPk) : '',
        kind: r.kind,
        detail:
          r.kind === 'promise'
            ? `Promised to pay by ${r.until}`
            : r.kind === 'plan'
              ? `Asked to pay in ${r.installments ?? 2} parts`
              : `Asked: “${(r.detail ?? '').slice(0, 140)}”`,
      })),
    sales: (() => {
      const done = rf.state
        .listOrders(500)
        .filter((o) => o.status === 'COMPLETED' && !o.invoices?.length && o.updatedAt >= since);
      return {
        count: done.length,
        total: round2(done.reduce((s, o) => s + o.total, 0)),
        items: done.slice(0, 6).map((o) => ({
          id: o.id,
          channel: o.channel,
          total: o.total,
          buyer: o.buyer?.agent
            ? `${o.buyer.name ?? o.buyer.email ?? 'a buyer'} via ${o.buyer.agent}`
            : (o.buyer?.name ?? o.buyer?.email ?? ''),
        })),
      };
    })(),
  };
  data.headline = digestHeadline(data);
  return data;
}

function money(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function digestHeadline(d: DigestData): string {
  const m = (n: number) => money(n, d.currency);
  const parts: string[] = [];
  parts.push(
    d.money.count
      ? `${m(d.money.gross)} came in from ${plural(d.money.count, 'payment')}`
      : 'No new payments since the last digest',
  );
  const decide = d.approvalsTotal + d.escalate.length + d.attention.length + d.requests.length;
  parts.push(
    decide ? `${plural(decide, 'thing')} need${decide === 1 ? 's' : ''} you` : 'nothing needs you today',
  );
  return `${parts.join('; ')}.`;
}

// ---------------------------------------------------------------- approval links

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Signed, expiring link token for approving one action from an email or Slack. */
export function signActionToken(secret: string, actionId: number, ttlHours = 48, now = Date.now()): string {
  const body = `${actionId}.${Math.floor(now / 1000) + ttlHours * 3600}`;
  const sig = crypto.createHmac('sha256', secret).update(`action:${body}`).digest();
  return `${b64(body)}.${b64(sig.subarray(0, 18))}`;
}

export function verifyActionToken(
  secret: string,
  token: string,
  now = Date.now(),
): { actionId: number } | { error: string } {
  const [bodyPart, sigPart] = token.split('.');
  if (!bodyPart || !sigPart) return { error: 'This link is not valid.' };
  const body = Buffer.from(bodyPart, 'base64url').toString();
  const expected = crypto.createHmac('sha256', secret).update(`action:${body}`).digest().subarray(0, 18);
  const given = Buffer.from(sigPart, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return { error: 'This link is not valid.' };
  const [id, exp] = body.split('.').map(Number);
  if (!id || !exp) return { error: 'This link is not valid.' };
  if (exp * 1000 < now) return { error: 'This link has expired. Open the console to review the action.' };
  return { actionId: id };
}

/** Signed link to one customer's portal. Long-lived (statements and reminders carry it), still expiring. */
export function signPortalToken(secret: string, customerPk: string, ttlDays = 120, now = Date.now()): string {
  const body = `${b64(customerPk)}.${Math.floor(now / 1000) + ttlDays * 86400}`;
  const sig = crypto.createHmac('sha256', secret).update(`portal:${body}`).digest();
  return `${b64(body)}.${b64(sig.subarray(0, 18))}`;
}

export function verifyPortalToken(
  secret: string,
  token: string,
  now = Date.now(),
): { customerPk: string } | { error: string } {
  const [bodyPart, sigPart] = token.split('.');
  if (!bodyPart || !sigPart) return { error: 'This link is not valid.' };
  const body = Buffer.from(bodyPart, 'base64url').toString();
  const expected = crypto.createHmac('sha256', secret).update(`portal:${body}`).digest().subarray(0, 18);
  const given = Buffer.from(sigPart, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return { error: 'This link is not valid.' };
  const [pk, exp] = body.split('.');
  if (!pk || !Number(exp)) return { error: 'This link is not valid.' };
  if (Number(exp) * 1000 < now) return { error: 'This link has expired. Ask for a new statement.' };
  return { customerPk: Buffer.from(pk, 'base64url').toString() };
}

/** The secret behind approval links: RETROFIT_LINK_SECRET, or one generated once and kept in the state store. */
export function actionLinkSecret(rf: Retrofit): string {
  const env = process.env.RETROFIT_LINK_SECRET;
  if (env) return env;
  let s = rf.state.getMeta('links.secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    rf.state.setMeta('links.secret', s);
  }
  return s;
}

// ---------------------------------------------------------------- rendering

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
  slack: { text: string; blocks: unknown[] };
}

export interface RenderOptions {
  /** Base URL of the console; without it the digest has no links. */
  baseUrl?: string;
  /** Builds the one-click approval URL for an action. */
  approveUrl?: (actionId: number) => string;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function localTime(iso: string | null, tz: string) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

function dateLine(d: DigestData) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: d.timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(d.generatedAt));
}

const KIND_ITEM: Record<string, string> = {
  payment: 'PayPal payment',
  external_payment: 'Paid outside PayPal',
  refund: 'Refund',
  external_refund: 'Refund outside PayPal',
};

export function renderDigest(d: DigestData, opts: RenderOptions = {}): RenderedDigest {
  const m = (n: number) => money(n, d.currency);
  const base = opts.baseUrl?.replace(/\/$/, '');
  const link = (hash: string) => (base ? `${base}/#${hash}` : '');
  const subject = `${d.business}: ${d.headline.replace(/\.$/, '')}`;

  // ---- plain text
  const t: string[] = [];
  t.push(`${d.greeting}, ${d.business}. ${dateLine(d)}`, '', d.note ?? d.headline, '');
  t.push(
    `Came in: ${m(d.money.gross)} (${plural(d.money.count, 'payment')}), PayPal fees ${m(d.money.fees)}, net ${m(d.money.net)}`,
    `Overdue: ${m(d.totals.overdueAmount)} across ${plural(d.totals.overdue, 'invoice')}`,
    `Expected this week: ${m(d.totals.expected7)} · next 30 days: ${m(d.totals.expected30)}`,
    '',
  );
  if (d.approvals.length) {
    t.push(`Waiting for your OK (${d.approvalsTotal}):`);
    for (const a of d.approvals)
      t.push(
        `- ${KIND_LABEL[a.kind] ?? a.kind} · ${a.label}${a.customer ? ` · ${a.customer}` : ''}${a.amount != null ? ` · ${m(a.amount)}` : ''}${opts.approveUrl ? `\n  Review: ${opts.approveUrl(a.id)}` : ''}`,
      );
    t.push('');
  }
  if (d.scheduled.length) {
    t.push(`Held for business hours (${d.scheduled.length}):`);
    for (const s of d.scheduled)
      t.push(`- ${KIND_LABEL[s.kind] ?? s.kind} · ${s.label} · ${localTime(s.runAfter, d.timezone)}`);
    t.push('');
  }
  if (d.escalate.length) {
    t.push('Call these customers:');
    for (const e of d.escalate) t.push(`- ${e.customer} about ${e.number} (${m(e.amountDue)}): ${e.reason}`);
    t.push('');
  }
  if (d.risks.length) {
    t.push('At risk:');
    for (const r of d.risks)
      t.push(`- ${r.number} · ${r.customer} · ${m(r.amountDue)} · ${r.band} risk · ${r.factors.join('; ')}`);
    t.push('');
  }
  if (d.requests.length) {
    t.push('Customers asked (portal):');
    for (const r of d.requests) t.push(`- ${r.customer}${r.number ? ` · ${r.number}` : ''}: ${r.detail}`);
    t.push('');
  }
  if (d.sales.count) {
    t.push(`Sold online: ${m(d.sales.total)} in ${plural(d.sales.count, 'order')}`);
    for (const s of d.sales.items)
      t.push(`- ${s.id} · ${m(s.total)} · ${s.channel}${s.buyer ? ` · ${s.buyer}` : ''}`);
    t.push('');
  }
  if (d.attention.length) {
    t.push('Needs a look:');
    for (const a of d.attention)
      t.push(`- ${a.label}: ${a.detail}${a.suggestion ? ` (${a.suggestion})` : ''}`);
    t.push('');
  }
  if (d.money.items.length) {
    t.push('Payments:');
    for (const p of d.money.items)
      t.push(`- ${p.number} · ${p.customer} · ${m(p.amount)} · ${KIND_ITEM[p.kind] ?? p.kind}`);
    t.push('');
  }
  t.push(
    `Playbook today: ${d.playbook.remind} to remind, ${d.playbook.hold} on hold, ${d.playbook.plan} payment-plan offers, ${d.playbook.escalate} to call.`,
  );
  if (base) t.push('', `Open the console: ${base}/`);
  t.push('', '— paypal-retrofit');
  const text = t.join('\n');

  // ---- HTML email (table layout, inline styles: works in mail clients)
  const ink = '#14171f';
  const muted = '#5b6475';
  const line = '#e3e6ec';
  const accent = '#2a78d6';
  const td = `style="padding:10px 0;border-top:1px solid ${line};font-size:14px;color:${ink};vertical-align:top"`;
  const section = (title: string, body: string, href?: string) =>
    `<tr><td style="padding:22px 28px 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${muted};font-weight:600">${esc(title)}</td>${href ? `<td align="right" style="font-size:12px"><a href="${esc(href)}" style="color:${accent};text-decoration:none">Open in console</a></td>` : ''}</tr></table>${body}</td></tr>`;
  const rowsTable = (rows: string[]) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px">${rows.join('')}</table>`;
  const kpi = (labelText: string, value: string, sub: string) =>
    `<td width="33%" style="padding:14px 12px;background:#f5f7fa;border-radius:8px;vertical-align:top"><div style="font-size:12px;color:${muted}">${esc(labelText)}</div><div style="font-size:20px;font-weight:700;color:${ink};margin-top:4px">${esc(value)}</div><div style="font-size:12px;color:${muted};margin-top:2px">${esc(sub)}</div></td>`;
  const button = (href: string, text: string, primary = true) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:7px 14px;border-radius:6px;font-size:13px;font-weight:600;text-decoration:none;${primary ? `background:${accent};color:#ffffff` : `border:1px solid ${line};color:${ink}`}">${esc(text)}</a>`;

  const parts: string[] = [];
  parts.push(
    `<tr><td style="padding:26px 28px 4px"><div style="font-size:13px;color:${muted}">${esc(dateLine(d))}</div><div style="font-size:22px;font-weight:700;color:${ink};margin-top:6px">${esc(d.greeting)}, ${esc(d.business)}</div><div style="font-size:15px;line-height:1.5;color:${ink};margin-top:10px">${esc(d.note ?? d.headline)}</div></td></tr>`,
  );
  parts.push(
    `<tr><td style="padding:16px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>${kpi('Came in', m(d.money.gross), `${plural(d.money.count, 'payment')} · net ${m(d.money.net)}`)}${kpi('Overdue', m(d.totals.overdueAmount), plural(d.totals.overdue, 'invoice'))}${kpi('Expected this week', m(d.totals.expected7), `${m(d.totals.expected30)} in 30 days`)}</tr></table></td></tr>`,
  );
  if (d.approvals.length)
    parts.push(
      section(
        `Waiting for your OK (${d.approvalsTotal})`,
        rowsTable(
          d.approvals.map(
            (a) =>
              `<tr><td ${td}><div style="font-weight:600">${esc(KIND_LABEL[a.kind] ?? a.kind)} · ${esc(a.label)}${a.amount != null ? ` · ${esc(m(a.amount))}` : ''}</div><div style="color:${muted};font-size:13px;margin-top:2px">${esc(a.customer)}${a.customer ? ' · ' : ''}${esc(a.policyReason ?? a.reason)}</div></td><td ${td} align="right" width="120">${opts.approveUrl ? button(opts.approveUrl(a.id), 'Review') : ''}</td></tr>`,
          ),
        ),
        link('approvals'),
      ),
    );
  if (d.scheduled.length)
    parts.push(
      section(
        'Held for business hours',
        rowsTable(
          d.scheduled.map(
            (s) =>
              `<tr><td ${td}>${esc(KIND_LABEL[s.kind] ?? s.kind)} · ${esc(s.label)}</td><td ${td} align="right" style="padding:10px 0;border-top:1px solid ${line};font-size:13px;color:${muted}">${esc(localTime(s.runAfter, d.timezone))}</td></tr>`,
          ),
        ),
      ),
    );
  if (d.escalate.length)
    parts.push(
      section(
        'Call these customers',
        rowsTable(
          d.escalate.map(
            (e) =>
              `<tr><td ${td}><div style="font-weight:600">${esc(e.customer)} · ${esc(e.number)} · ${esc(m(e.amountDue))}</div><div style="color:${muted};font-size:13px;margin-top:2px">${esc(e.reason)}</div></td></tr>`,
          ),
        ),
        link('collections'),
      ),
    );
  if (d.risks.length)
    parts.push(
      section(
        'At risk',
        rowsTable(
          d.risks.map(
            (r) =>
              `<tr><td ${td}><div style="font-weight:600">${esc(r.number)} · ${esc(r.customer)} · ${esc(m(r.amountDue))}</div><div style="color:${muted};font-size:13px;margin-top:2px">${esc(r.band === 'high' ? 'High' : 'Medium')} risk · expected ${esc(r.expectedPayDate)} · ${esc(r.factors.join('; '))}</div></td></tr>`,
          ),
        ),
        link('insights'),
      ),
    );
  if (d.requests.length)
    parts.push(
      section(
        'Customers asked in the portal',
        rowsTable(
          d.requests.map(
            (r) =>
              `<tr><td ${td}><div style="font-weight:600">${esc(r.customer)}${r.number ? ` · ${esc(r.number)}` : ''}</div><div style="color:${muted};font-size:13px;margin-top:2px">${esc(r.detail)}</div></td></tr>`,
          ),
        ),
        link('customers'),
      ),
    );
  if (d.sales.count)
    parts.push(
      section(
        `Sold online · ${m(d.sales.total)}`,
        rowsTable(
          d.sales.items.map(
            (s) =>
              `<tr><td ${td}>${esc(s.id)}<div style="color:${muted};font-size:13px;margin-top:2px">${esc(s.channel === 'agent' ? 'Bought by an AI shopping agent' : 'Shop page')}${s.buyer ? ` · ${esc(s.buyer)}` : ''}</div></td><td ${td} align="right" style="padding:10px 0;border-top:1px solid ${line};font-size:14px;font-weight:600;color:${ink}">${esc(m(s.total))}</td></tr>`,
          ),
        ),
        link('shop'),
      ),
    );
  if (d.attention.length)
    parts.push(
      section(
        'Needs a look',
        rowsTable(
          d.attention.map(
            (a) =>
              `<tr><td ${td}><div style="font-weight:600">${esc(a.label)}</div><div style="color:${muted};font-size:13px;margin-top:2px">${esc(a.detail)}${a.suggestion ? ` · ${esc(a.suggestion)}` : ''}</div></td></tr>`,
          ),
        ),
        link('discrepancies'),
      ),
    );
  if (d.money.items.length)
    parts.push(
      section(
        'Payments',
        rowsTable(
          d.money.items.map(
            (p) =>
              `<tr><td ${td}>${esc(p.number)} · ${esc(p.customer)}<div style="color:${muted};font-size:13px;margin-top:2px">${esc(KIND_ITEM[p.kind] ?? p.kind)}${p.method ? ` · ${esc(p.method)}` : ''}</div></td><td ${td} align="right" style="padding:10px 0;border-top:1px solid ${line};font-size:14px;font-weight:600;color:${ink}">${esc(m(p.amount))}</td></tr>`,
          ),
        ),
      ),
    );
  parts.push(
    section(
      'Collections playbook today',
      `<div style="font-size:14px;color:${ink};margin-top:8px;line-height:1.6">${d.playbook.remind} to remind · ${d.playbook.hold} on hold · ${d.playbook.plan} payment-plan offers · ${d.playbook.escalate} to call · ${d.playbook.wait} waiting</div>`,
      link('collections'),
    ),
  );
  parts.push(
    `<tr><td style="padding:24px 28px 28px">${base ? button(`${base}/`, 'Open the console') : ''}<div style="font-size:12px;color:${muted};margin-top:18px;line-height:1.5">Sent by paypal-retrofit. Approval links expire after 48 hours and only work for actions that are still waiting. Every action still follows the rules you set.</div></td></tr>`,
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head><body style="margin:0;padding:0;background:#eef1f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border-radius:12px;overflow:hidden"><tr><td style="height:4px;background:${accent}"></td></tr>${parts.join('')}</table></td></tr></table></body></html>`;

  // ---- Slack (Block Kit)
  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: `${d.greeting}, ${d.business}` } },
    { type: 'section', text: { type: 'mrkdwn', text: d.note ?? d.headline } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Came in*\n${m(d.money.gross)} (${plural(d.money.count, 'payment')})` },
        {
          type: 'mrkdwn',
          text: `*Overdue*\n${m(d.totals.overdueAmount)} · ${plural(d.totals.overdue, 'invoice')}`,
        },
        { type: 'mrkdwn', text: `*Expected this week*\n${m(d.totals.expected7)}` },
        { type: 'mrkdwn', text: `*Waiting for you*\n${d.approvalsTotal}` },
      ],
    },
  ];
  for (const a of d.approvals.slice(0, 5))
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${KIND_LABEL[a.kind] ?? a.kind} · ${a.label}*${a.amount != null ? ` · ${m(a.amount)}` : ''}\n${a.policyReason ?? a.reason}`,
      },
      ...(opts.approveUrl
        ? {
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Review' },
              url: opts.approveUrl(a.id),
            },
          }
        : {}),
    });
  if (d.escalate.length)
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Call these customers*\n${d.escalate.map((e) => `• ${e.customer} about ${e.number} (${m(e.amountDue)})`).join('\n')}`,
      },
    });
  if (d.requests.length)
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Customers asked (portal)*\n${d.requests.map((r) => `• ${r.customer}${r.number ? ` ${r.number}` : ''}: ${r.detail}`).join('\n')}`,
      },
    });
  if (d.sales.count)
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Sold online*\n${m(d.sales.total)} in ${plural(d.sales.count, 'order')}`,
      },
    });
  if (d.attention.length)
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Needs a look*\n${d.attention.map((a) => `• ${a.label}: ${a.detail}`).join('\n')}`,
      },
    });
  if (base)
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open the console' }, url: `${base}/` }],
    });

  return { subject, html, text, slack: { text: subject, blocks } };
}

/** When the next scheduled digest is due, in UTC ISO, given the local time and weekday rule. */
export function nextDigestAt(
  time: string,
  timezone: string,
  weekdaysOnly: boolean,
  lastSentAt: string | undefined,
  now = new Date(),
): string {
  const target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const lastDate = lastSentAt ? localParts(new Date(lastSentAt), timezone).date : null;
  // Walk forward in 5-minute steps (at most 8 days) until the local time reaches the target on a valid day.
  let t = new Date(Math.ceil(now.getTime() / 300000) * 300000);
  for (let i = 0; i < 8 * 24 * 12; i++, t = new Date(t.getTime() + 300000)) {
    const p = localParts(t, timezone);
    if (weekdaysOnly && (p.weekday === 'Sat' || p.weekday === 'Sun')) continue;
    if (p.date === lastDate) continue;
    if (p.minutes >= target && p.minutes < target + 5) return t.toISOString();
  }
  return t.toISOString();
}

/** True when a scheduled digest should go out now. */
export function digestDue(
  time: string,
  timezone: string,
  weekdaysOnly: boolean,
  lastSentAt: string | undefined,
  now = new Date(),
): boolean {
  const p = localParts(now, timezone);
  if (weekdaysOnly && (p.weekday === 'Sat' || p.weekday === 'Sun')) return false;
  const target = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  // Within three hours of the target time, so a server that was down at 08:00 still sends at 09:30 but not at 17:00.
  if (p.minutes < target || p.minutes > target + 180) return false;
  if (lastSentAt && localParts(new Date(lastSentAt), timezone).date === p.date) return false;
  return true;
}
