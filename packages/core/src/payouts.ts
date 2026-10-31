import type { Retrofit } from './engine.ts';
import type { PayoutRecord } from './state/store.ts';
import type { ActionOrigin, ActionRecord, Row } from './types.ts';
import { daysBetween, round2, todayIso, toMoney } from './util.ts';

/**
 * Paying suppliers. Bills in the business's own system (contractors, labs, rentals) are paid to each payee's
 * PayPal email with PayPal Payouts, one approval per bill. The amount always comes from the bill, never from
 * whoever proposed it; PayPal refuses a second batch with the same sender_batch_id; a first payment to a
 * payee, or one to a PayPal email that changed since the last payment, always waits for the owner; and the
 * bill is marked paid in the business's system only when PayPal reports the money arrived.
 */

export interface LegacyBill {
  pk: string;
  number: string;
  payee: string;
  email: string;
  amount: number;
  due: string | null;
  description: string | null;
  status: string;
  state: 'open' | 'paid' | 'cancelled' | 'unknown';
  paidOn: string | null;
}

export interface PayeeCheck {
  /** Paid before, in the business's records or through retrofit. */
  known: boolean;
  /** The email the payee was last paid at, when this bill names a different one. */
  previousEmail: string | null;
  lastPaidOn: string | null;
  /** Why paying this bill must wait for the owner, whatever the rules say; null when nothing stands out. */
  hold: string | null;
}

/** Payout statuses that mean money is on its way or arrived: the bill must not be paid again. */
const LIVE = ['PENDING', 'PROCESSING', 'SUCCESS', 'UNCLAIMED', 'ONHOLD'];
const FAILED = ['FAILED', 'RETURNED', 'BLOCKED', 'DENIED', 'REFUNDED', 'REVERSED', 'CANCELED'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function loadBills(rf: Retrofit, pks?: string[]): Promise<LegacyBill[]> {
  const bm = rf.mapping.entities.payable;
  if (!bm) return [];
  const rows = pks
    ? await rf.source.readTable(bm.table, { column: bm.pk, in: pks })
    : await rf.source.readTable(bm.table);
  const text = (c: string | undefined, r: Row) => (c && r[c] != null && r[c] !== '' ? String(r[c]) : null);
  return rows.map((r) => {
    const status = String(r[bm.fields.status] ?? '');
    const sm = bm.statusMap;
    return {
      pk: String(r[bm.pk]),
      number: text(bm.fields.number, r) ?? String(r[bm.pk]),
      payee: String(r[bm.fields.payee] ?? '').trim() || 'Payee',
      email: String(r[bm.fields.email] ?? '').trim(),
      amount: round2(Number(r[bm.fields.amount] ?? 0)),
      due: text(bm.fields.due, r)?.slice(0, 10) ?? null,
      description: text(bm.fields.description, r),
      status,
      state: sm.paid.includes(status)
        ? 'paid'
        : sm.cancelled.includes(status)
          ? 'cancelled'
          : sm.open.includes(status)
            ? 'open'
            : 'unknown',
      paidOn: text(bm.writeBack.paidAt, r)?.slice(0, 10) ?? null,
    };
  });
}

/** What the records say about paying this payee at this email. */
export function payeeCheck(rf: Retrofit, bill: LegacyBill, all: LegacyBill[]): PayeeCheck {
  const history = [
    ...all
      .filter((b) => b.pk !== bill.pk && b.state === 'paid' && norm(b.payee) === norm(bill.payee))
      .map((b) => ({ email: b.email, on: b.paidOn ?? b.due ?? '' })),
    ...rf.state
      .listPayouts()
      .filter(
        (p) => p.status === 'SUCCESS' && p.legacyPk !== bill.pk && norm(p.payee ?? '') === norm(bill.payee),
      )
      .map((p) => ({ email: p.receiver, on: p.updatedAt.slice(0, 10) })),
  ].sort((a, b) => b.on.localeCompare(a.on));
  const last = history[0];
  const base = { known: Boolean(last), previousEmail: null, lastPaidOn: last?.on || null };
  if (!EMAIL.test(bill.email)) return { ...base, hold: `"${bill.email}" is not an email address` };
  if (!last) return { ...base, hold: `First payment to ${bill.payee}` };
  if (norm(last.email) !== norm(bill.email))
    return {
      ...base,
      previousEmail: last.email,
      hold: `${bill.payee}'s PayPal email changed (last paid at ${last.email}${last.on ? ` on ${last.on}` : ''})`,
    };
  return { ...base, hold: null };
}

/** The engine's check before a pay_supplier action may run on its own. */
export async function supplierHold(rf: Retrofit, pk: string): Promise<string | null> {
  const all = await loadBills(rf);
  const bill = all.find((b) => b.pk === pk);
  return bill ? payeeCheck(rf, bill, all).hold : 'The bill was not found';
}

/** The amount a pay_supplier action moves: the bill's, from the business's records. */
export async function billAmount(rf: Retrofit, pk: string): Promise<number | null> {
  const [bill] = await loadBills(rf, [pk]);
  return bill ? bill.amount : null;
}

export async function payablesView(rf: Retrofit, today = todayIso()) {
  const bm = rf.mapping.entities.payable;
  const cur = rf.mapping.currency;
  if (!bm) return { enabled: false as const, currency: cur, table: null, bills: [], totals: null };
  const all = await loadBills(rf);
  const actions = rf.state.listActions(undefined, 2000).filter((a) => a.kind === 'pay_supplier');
  const bills = all
    .filter((b) => b.state !== 'unknown')
    .map((b) => {
      const payout = rf.state.listPayouts(b.pk)[0] ?? null;
      const a = actions.find((x) => x.target.legacyPk === b.pk);
      return {
        ...b,
        check: payeeCheck(rf, b, all),
        payout,
        action: a ? { id: a.id, status: a.status, policyReason: a.policyReason, result: a.result } : null,
        daysToDue: b.due ? daysBetween(today, b.due) : null,
      };
    })
    .sort((x, y) => {
      const rank = (b: { state: string }) => (b.state === 'open' ? 0 : b.state === 'paid' ? 1 : 2);
      return (
        rank(x) - rank(y) ||
        (x.state === 'open'
          ? (x.due ?? '').localeCompare(y.due ?? '')
          : (y.due ?? '').localeCompare(x.due ?? ''))
      );
    });
  const open = bills.filter((b) => b.state === 'open' && !(b.payout && LIVE.includes(b.payout.status)));
  const sum = (xs: typeof bills) => round2(xs.reduce((s, b) => s + b.amount, 0));
  return {
    enabled: true as const,
    currency: cur,
    table: bm.table,
    bills,
    totals: {
      open: sum(open),
      dueThisWeek: sum(open.filter((b) => b.daysToDue != null && b.daysToDue <= 7)),
      overdue: sum(open.filter((b) => b.daysToDue != null && b.daysToDue < 0)),
      paidThroughPayPal: round2(
        rf.state
          .listPayouts()
          .filter((p) => p.status === 'SUCCESS')
          .reduce((s, p) => s + p.amount, 0),
      ),
    },
  };
}

/** Proposes paying each bill. Bills that are not open, or already have a payout on its way, are refused. */
export async function proposeBillPayments(rf: Retrofit, pks: string[], origin: ActionOrigin = 'dashboard') {
  const all = await loadBills(rf);
  const cur = rf.mapping.currency;
  const out: Array<{ pk: string; number?: string; action?: ActionRecord; error?: string }> = [];
  for (const pk of [...new Set(pks)]) {
    const b = all.find((x) => x.pk === pk);
    if (!b) {
      out.push({ pk, error: 'No such bill' });
      continue;
    }
    if (b.state !== 'open') {
      out.push({ pk, number: b.number, error: `${b.number} is ${b.status}` });
      continue;
    }
    const live = rf.state.listPayouts(pk).find((p) => LIVE.includes(p.status));
    if (live) {
      out.push({
        pk,
        number: b.number,
        error: `${b.number} already has a PayPal payout (${live.status.toLowerCase()})`,
      });
      continue;
    }
    const action = await rf.propose({
      origin,
      kind: 'pay_supplier',
      target: { entity: 'payable', legacyPk: pk, label: `${b.number} · ${b.payee}` },
      // What the owner approves; the payment is refused if the bill says otherwise when it runs.
      payload: { email: b.email, amount: b.amount },
      reason: `Pay ${b.payee} ${toMoney(b.amount)} ${cur} at ${b.email} for ${b.number}${b.description ? ` (${b.description})` : ''}${b.due ? `, due ${b.due}` : ''}`,
    });
    out.push({ pk, number: b.number, action });
  }
  return out;
}

/**
 * Runs an approved pay_supplier action: one PayPal Payouts batch with one item, to the bill's payee. The
 * bill must still say what was approved: an email or amount edited after approval stops the payment.
 */
export async function paySupplier(
  rf: Retrofit,
  actionId: number,
  pk: string,
  approved: Record<string, unknown> = {},
) {
  const [bill] = await loadBills(rf, [pk]);
  if (!bill) throw new Error('The bill was not found in your system');
  if (bill.state !== 'open') throw new Error(`${bill.number} is ${bill.status}, not open`);
  if (norm(String(approved.email ?? '')) !== norm(bill.email) || Number(approved.amount) !== bill.amount)
    throw new Error(
      `${bill.number} changed since it was approved (now ${toMoney(bill.amount)} to ${bill.email}); propose it again`,
    );
  if (!(bill.amount > 0)) throw new Error(`${bill.number} has nothing to pay`);
  if (!EMAIL.test(bill.email)) throw new Error(`"${bill.email}" is not an email address`);
  const live = rf.state.listPayouts(pk).find((p) => LIVE.includes(p.status));
  if (live)
    throw new Error(
      `${bill.number} already has a PayPal payout (${live.batchId}, ${live.status.toLowerCase()})`,
    );
  const cur = rf.mapping.currency;
  const note = `${bill.number}${bill.description ? `: ${bill.description}` : ''}`;
  const r = await rf.paypal.createPayout(
    {
      sender_batch_header: {
        sender_batch_id: `retrofit-${pk}-${actionId}`,
        recipient_type: 'EMAIL',
        email_subject: `${rf.config.business.name} sent you a payment`.slice(0, 255),
        email_message: `Payment for ${note}`.slice(0, 1000),
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: bill.amount.toFixed(2), currency: cur },
          receiver: bill.email,
          note: note.slice(0, 4000),
          sender_item_id: bill.number.slice(0, 63),
        },
      ],
    },
    `payout-${pk}-${actionId}`,
  );
  const batchId = r.batch_header.payout_batch_id;
  rf.state.savePayout({
    batchId,
    legacyPk: pk,
    actionId,
    receiver: bill.email,
    payee: bill.payee,
    amount: bill.amount,
    currency: cur,
    status: r.batch_header.batch_status ?? 'PENDING',
  });
  rf.emit('payout', { batchId, pk });
  return {
    batchId,
    status: r.batch_header.batch_status,
    amount: bill.amount,
    receiver: bill.email,
    payee: bill.payee,
  };
}

/** Applies a payout item's PayPal status (webhook or refresh): marks the bill paid, or flags a problem. */
export async function applyPayoutItem(rf: Retrofit, item: any): Promise<string | null> {
  const p =
    (item?.payout_item_id && rf.state.findPayoutByItem(item.payout_item_id)) ||
    (item?.payout_batch_id && rf.state.getPayout(item.payout_batch_id)) ||
    null;
  if (!p) return null;
  const status = String(item.transaction_status ?? p.status);
  const errors = item.errors ? [item.errors.name, item.errors.message].filter(Boolean).join(': ') : null;
  rf.state.savePayout({
    batchId: p.batchId,
    itemId: item.payout_item_id ?? p.itemId,
    status,
    transactionId: item.transaction_id ?? p.transactionId,
    fee: item.payout_item_fee?.value != null ? Number(item.payout_item_fee.value) : p.fee,
    error: errors ?? p.error,
  });
  rf.emit('payout', { batchId: p.batchId, pk: p.legacyPk });
  const who = `${p.payee ?? p.receiver} ${toMoney(p.amount)} ${p.currency}`;
  if (status === 'SUCCESS') {
    if (p.status !== 'SUCCESS') await markBillPaid(rf, p, item);
    return `Paid ${who} (payout ${p.batchId})`;
  }
  if (status === 'UNCLAIMED') {
    rf.state.openDiscrepancy({
      entity: 'payable',
      legacyPk: p.legacyPk,
      paypalId: p.batchId,
      kind: 'payout_unclaimed',
      detail: `${p.payee ?? 'The payee'} has not claimed ${toMoney(p.amount)} ${p.currency} sent to ${p.receiver}`,
      suggestion: `PayPal emailed ${p.receiver} a link to claim it; unclaimed payouts come back after 30 days. Check the address with ${p.payee ?? 'them'}.`,
    });
    return `Payout to ${p.receiver} not claimed yet`;
  }
  if (FAILED.includes(status)) {
    rf.state.openDiscrepancy({
      entity: 'payable',
      legacyPk: p.legacyPk,
      paypalId: p.batchId,
      kind: 'payout_failed',
      detail: `Payout of ${who} ${status.toLowerCase()}${errors ? ` (${errors})` : ''}`,
      suggestion: 'The bill is still open in your system. Check the PayPal email, then pay it again.',
    });
    return `Payout ${p.batchId} ${status.toLowerCase()}`;
  }
  return `Payout ${p.batchId} ${status.toLowerCase()}`;
}

/** A batch event: a denied batch fails its bill; otherwise each item is applied. */
export async function applyPayoutBatch(rf: Retrofit, batch: any): Promise<string | null> {
  const id = batch?.batch_header?.payout_batch_id;
  const p = id ? rf.state.getPayout(id) : null;
  if (!p) return null;
  if (batch.batch_header.batch_status === 'DENIED')
    return applyPayoutItem(rf, {
      payout_batch_id: id,
      transaction_status: 'DENIED',
      errors: batch.batch_header.errors,
    });
  const items =
    Array.isArray(batch.items) && batch.items.length
      ? batch.items
      : ((await rf.paypal.getPayoutBatch(id)).items ?? []);
  const out: string[] = [];
  for (const item of items) {
    const s = await applyPayoutItem(rf, { ...item, payout_batch_id: id });
    if (s) out.push(s);
  }
  return out.join('; ') || `Payout batch ${id} ${String(batch.batch_header.batch_status).toLowerCase()}`;
}

/** Asks PayPal about payouts still on their way, in case a webhook was missed. */
export async function refreshPayouts(rf: Retrofit): Promise<number> {
  let changed = 0;
  for (const p of rf.state
    .listPayouts()
    .filter((x) => ['PENDING', 'PROCESSING', 'UNCLAIMED', 'ONHOLD'].includes(x.status))) {
    try {
      const b = await rf.paypal.getPayoutBatch(p.batchId);
      const before = p.status;
      await applyPayoutBatch(rf, b);
      if (rf.state.getPayout(p.batchId)?.status !== before) changed++;
    } catch (e) {
      rf.log.warn(`payout ${p.batchId}: ${(e as Error).message}`);
    }
  }
  return changed;
}

async function markBillPaid(rf: Retrofit, p: PayoutRecord, item: any) {
  const bm = rf.mapping.entities.payable;
  if (bm) {
    const wb = bm.writeBack;
    const patch: Row = {};
    if (wb.status && bm.statusMap.paid[0]) patch[wb.status] = bm.statusMap.paid[0];
    if (wb.paidAt) patch[wb.paidAt] = String(item.time_processed ?? new Date().toISOString()).slice(0, 10);
    if (wb.reference) patch[wb.reference] = item.transaction_id ?? p.batchId;
    if (Object.keys(patch).length) {
      await rf.source.update(bm.table, bm.pk, p.legacyPk, patch);
      rf.state.addWriteback('payable', p.legacyPk, 'update', patch);
      rf.emit('writeback', { entity: 'payable', pk: p.legacyPk, patch });
    }
  }
  rf.state.resolveDiscrepanciesFor(
    'payable',
    p.legacyPk,
    ['payout_unclaimed', 'payout_failed'],
    'Paid through PayPal',
  );
}
