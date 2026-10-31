import type { Retrofit } from './engine.ts';
import { loadInvoices, type LegacyInvoice } from './entities.ts';
import { customerProfiles } from './insights.ts';
import { PAID_STATUSES } from './paypal/client.ts';
import { expectedTotal } from './terms.ts';
import { addDaysIso, daysBetween, round2, todayIso } from './util.ts';

/** One customer's position: what they owe, how late, and what they have asked for in the portal. */
export interface CustomerSummary {
  pk: string;
  name: string;
  email: string;
  openInvoices: number;
  balance: number;
  overdue: number;
  oldestDaysOverdue: number;
  lastPaymentAt: string | null;
  openRequests: number;
  behaviour: string | null;
  onTimeRate: number | null;
  /** Autopay with a saved PayPal: on, being set up, or none. */
  autopay: 'active' | 'pending' | null;
}

export interface StatementLine {
  legacyPk: string;
  number: string;
  issued: string | null;
  due: string | null;
  daysOverdue: number;
  total: number;
  adjustments: number;
  paid: number;
  balance: number;
  payLink: string | null;
  inPayPal: boolean;
  onPlan: boolean;
}

export interface Statement {
  business: string;
  currency: string;
  asOf: string;
  customer: { pk: string; name: string; email: string };
  lines: StatementLine[];
  payments: Array<{ date: string; number: string; amount: number; method: string }>;
  totals: { balance: number; overdue: number; current: number };
  aging: { current: number; d1_30: number; d31_60: number; d61_90: number; d90plus: number };
}

function lineFor(rf: Retrofit, inv: LegacyInvoice, today: string): StatementLine | null {
  if (inv.state !== 'open') return null;
  const link = rf.state.getLink('invoice', inv.pk);
  // Drafts and other statuses that are never sent were not issued to the customer.
  if (!link && !rf.mapping.entities.invoice.push.includes(inv.status)) return null;
  if (link?.paypalStatus && PAID_STATUSES.includes(link.paypalStatus)) return null;
  const adjustments = rf.state.adjustmentTotal(inv.pk);
  const total = expectedTotal(rf, inv.pk, inv.total);
  const paid = link?.paypalPaid ?? 0;
  const balance = round2(total - paid);
  if (balance <= 0) return null;
  return {
    legacyPk: inv.pk,
    number: inv.number,
    issued: inv.issued ?? null,
    due: inv.due ?? null,
    daysOverdue: inv.due && inv.due < today ? daysBetween(inv.due, today) : 0,
    total,
    adjustments,
    paid,
    balance,
    payLink: link?.payLink ?? null,
    inPayPal: Boolean(link),
    onPlan: rf.state.getPlan(inv.pk)?.status === 'active',
  };
}

export async function listCustomers(rf: Retrofit, today = todayIso()): Promise<CustomerSummary[]> {
  const invoices = await loadInvoices(rf.source, rf.mapping);
  const profiles = await customerProfiles(rf, today);
  const payments = rf.state.listPayments();
  const byInvoice = new Map(invoices.map((i) => [i.pk, i]));
  const requests = rf.state.listRequests({ status: 'open' });
  const out = new Map<string, CustomerSummary>();
  for (const inv of invoices) {
    if (!inv.customer) continue;
    const c =
      out.get(inv.customerPk) ??
      out
        .set(inv.customerPk, {
          pk: inv.customerPk,
          name: inv.customer.name,
          email: inv.customer.email,
          openInvoices: 0,
          balance: 0,
          overdue: 0,
          oldestDaysOverdue: 0,
          lastPaymentAt: null,
          openRequests: requests.filter((r) => r.customerPk === inv.customerPk).length,
          behaviour: profiles.get(inv.customerPk)?.behaviour ?? null,
          onTimeRate: profiles.get(inv.customerPk)?.onTimeRate ?? null,
          autopay: autopayStatus(rf, inv.customerPk),
        })
        .get(inv.customerPk)!;
    const line = lineFor(rf, inv, today);
    if (!line) continue;
    c.openInvoices++;
    c.balance = round2(c.balance + line.balance);
    if (line.daysOverdue > 0) c.overdue = round2(c.overdue + line.balance);
    c.oldestDaysOverdue = Math.max(c.oldestDaysOverdue, line.daysOverdue);
  }
  for (const p of payments) {
    const inv = byInvoice.get(p.legacyPk);
    const c = inv ? out.get(inv.customerPk) : undefined;
    if (c && p.gross > 0 && (!c.lastPaymentAt || p.occurredAt > c.lastPaymentAt))
      c.lastPaymentAt = p.occurredAt;
  }
  return [...out.values()].sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);
}

function autopayStatus(rf: Retrofit, customerPk: string): CustomerSummary['autopay'] {
  const s = rf.state.getAutopay(customerPk)?.status;
  return s === 'active' || s === 'pending' ? s : null;
}

export async function buildStatement(
  rf: Retrofit,
  customerPk: string,
  asOf = todayIso(),
): Promise<Statement> {
  const invoices = (await loadInvoices(rf.source, rf.mapping)).filter((i) => i.customerPk === customerPk);
  const customer = invoices.find((i) => i.customer)?.customer;
  if (!customer) throw new Error(`No customer ${customerPk}`);
  const lines = invoices
    .map((i) => lineFor(rf, i, asOf))
    .filter((l): l is StatementLine => l !== null)
    .sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  const numbers = new Map(invoices.map((i) => [i.pk, i.number]));
  const payments = rf.state
    .listPayments(addDaysIso(asOf, -90))
    .filter((p) => numbers.has(p.legacyPk) && p.gross > 0)
    .map((p) => ({
      date: p.occurredAt.slice(0, 10),
      number: numbers.get(p.legacyPk)!,
      amount: p.gross,
      method: p.method === 'PAYPAL' ? 'PayPal' : (p.method ?? 'Other').replace(/_/g, ' ').toLowerCase(),
    }))
    .reverse();
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const l of lines) {
    const k =
      l.daysOverdue <= 0
        ? 'current'
        : l.daysOverdue <= 30
          ? 'd1_30'
          : l.daysOverdue <= 60
            ? 'd31_60'
            : l.daysOverdue <= 90
              ? 'd61_90'
              : 'd90plus';
    aging[k] = round2(aging[k] + l.balance);
  }
  const balance = round2(lines.reduce((s, l) => s + l.balance, 0));
  const overdue = round2(lines.filter((l) => l.daysOverdue > 0).reduce((s, l) => s + l.balance, 0));
  return {
    business: rf.config.business.name,
    currency: rf.mapping.currency,
    asOf,
    customer: { pk: customer.pk, name: customer.name, email: customer.email },
    lines,
    payments,
    totals: { balance, overdue, current: round2(balance - overdue) },
    aging,
  };
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export function formatMoney(n: number, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** Statement email: every open invoice with its pay link, recent payments, aging, and the portal link. */
export function renderStatement(s: Statement, opts: { portalUrl?: string; portalQr?: string } = {}) {
  const m = (n: number) => formatMoney(n, s.currency);
  const subject = `Statement from ${s.business}: ${m(s.totals.balance)} open${s.totals.overdue ? `, ${m(s.totals.overdue)} overdue` : ''}`;
  const t: string[] = [`Statement for ${s.customer.name} · ${s.business} · as of ${s.asOf}`, ''];
  t.push(`Open balance: ${m(s.totals.balance)} (overdue ${m(s.totals.overdue)})`, '');
  for (const l of s.lines)
    t.push(
      `- ${l.number} · due ${l.due ?? '—'}${l.daysOverdue ? ` (${l.daysOverdue} days overdue)` : ''} · ${m(l.balance)}${l.payLink ? `\n  Pay: ${l.payLink}` : ''}`,
    );
  if (s.payments.length) {
    t.push('', 'Payments received in the last 90 days, thank you:');
    for (const p of s.payments) t.push(`- ${p.date} · ${p.number} · ${m(p.amount)} · ${p.method}`);
  }
  if (opts.portalUrl) t.push('', `See and pay everything in one place: ${opts.portalUrl}`);
  t.push('', s.business);

  const ink = '#14171f';
  const muted = '#5b6475';
  const line = '#e3e6ec';
  const accent = '#2a78d6';
  const cell = `style="padding:9px 6px;border-top:1px solid ${line};font-size:14px;color:${ink}"`;
  const num = `style="padding:9px 6px;border-top:1px solid ${line};font-size:14px;color:${ink};text-align:right;white-space:nowrap"`;
  const rows = s.lines
    .map(
      (l) =>
        `<tr><td ${cell}><b>${esc(l.number)}</b>${l.onPlan ? ` <span style="color:${muted}">(payment plan)</span>` : ''}<div style="color:${muted};font-size:12px">${l.issued ? `issued ${esc(l.issued)} · ` : ''}due ${esc(l.due ?? '—')}${l.daysOverdue ? ` · <span style="color:#b42318">${l.daysOverdue} days overdue</span>` : ''}${l.adjustments ? ` · includes ${esc(m(l.adjustments))} ${l.adjustments > 0 ? 'late fee' : 'discount'}` : ''}</div></td><td ${num}>${esc(m(l.balance))}</td><td ${num}>${l.payLink ? `<a href="${esc(l.payLink)}" style="color:${accent};font-weight:600;text-decoration:none">Pay</a>` : ''}</td></tr>`,
    )
    .join('');
  const aging = [
    ['Current', s.aging.current],
    ['1–30 days', s.aging.d1_30],
    ['31–60', s.aging.d31_60],
    ['61–90', s.aging.d61_90],
    ['90+', s.aging.d90plus],
  ]
    .map(
      ([k, v]) =>
        `<td style="padding:8px;background:#f5f7fa;border-radius:6px;font-size:12px;color:${muted}">${esc(k)}<div style="font-size:15px;font-weight:700;color:${ink}">${esc(m(v as number))}</div></td>`,
    )
    .join('');
  const pays = s.payments
    .map(
      (p) =>
        `<tr><td ${cell}>${esc(p.date)} · ${esc(p.number)} <span style="color:${muted}">· ${esc(p.method)}</span></td><td ${num}>${esc(m(p.amount))}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head><body style="margin:0;background:#eef1f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#fff;border-radius:12px;overflow:hidden"><tr><td style="height:4px;background:${accent}"></td></tr>
<tr><td style="padding:24px 26px 8px"><div style="font-size:13px;color:${muted}">${esc(s.business)} · statement as of ${esc(s.asOf)}</div><div style="font-size:22px;font-weight:700;color:${ink};margin-top:6px">${esc(s.customer.name)}</div><div style="font-size:15px;color:${ink};margin-top:10px">Open balance <b>${esc(m(s.totals.balance))}</b>${s.totals.overdue ? `, of which <b style="color:#b42318">${esc(m(s.totals.overdue))}</b> is overdue` : ''}.</div></td></tr>
<tr><td style="padding:10px 26px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="4"><tr>${aging}</tr></table></td></tr>
<tr><td style="padding:16px 26px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows || `<tr><td ${cell}>Nothing is open. Thank you.</td></tr>`}</table></td></tr>
${pays ? `<tr><td style="padding:18px 26px 0"><div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${muted};font-weight:600">Received in the last 90 days, thank you</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${pays}</table></td></tr>` : ''}
<tr><td style="padding:22px 26px 26px">${opts.portalQr ? `<img src="${esc(opts.portalQr)}" width="112" height="112" alt="QR code: scan to see and pay these invoices" style="float:right;margin:0 0 8px 12px"><div style="font-size:12px;color:${muted};margin-bottom:8px">On paper? Scan the code with a phone to pay.</div>` : ''}${opts.portalUrl ? `<a href="${esc(opts.portalUrl)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:${accent};color:#fff;font-weight:600;text-decoration:none">See and pay everything in one place</a>` : ''}<div style="font-size:12px;color:${muted};margin-top:16px">Payments are handled by PayPal. Questions about a charge? Reply to this email${opts.portalUrl ? ' or use the portal' : ''}.</div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text: t.join('\n') };
}
