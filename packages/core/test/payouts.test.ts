import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRuleChanges,
  loadBills,
  moneyTrail,
  parseRulesWithPatterns,
  payablesView,
  proposeBillPayments,
} from '../src/index.ts';
import { harness } from './helpers.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  ms = 4000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

describe('paying suppliers with PayPal Payouts', () => {
  it('finds the bills, holds risky payees, pays the rest and marks them paid when PayPal confirms', async () => {
    const h = await harness();
    cleanups.push(h.close);
    expect(h.mapping.entities.payable).toMatchObject({
      table: 'bills',
      fields: { number: 'bill_no', payee: 'payee', email: 'payee_email', amount: 'amount', due: 'due_on' },
      statusMap: { open: ['open'], paid: ['paid'], cancelled: ['void'] },
      writeBack: { status: 'status', paidAt: 'paid_on', reference: 'payout_ref' },
    });

    const view = await payablesView(h.rf, '2026-10-29');
    const bill = (n: string) => view.bills.find((b) => b.number === n)!;
    expect(bill('B-203').check.hold).toBeNull(); // paid before at the same email
    expect(bill('B-205').check).toMatchObject({ previousEmail: 'studio@pixelpine.example.com' });
    expect(bill('B-205').check.hold).toMatch(/PayPal email changed/);
    expect(bill('B-206').check.hold).toBe('First payment to Sam Rivera');
    expect(view.totals).toMatchObject({ open: 910, dueThisWeek: 790 });

    // Under the default policy every payment waits, and the approver sees the risk.
    const first = (await proposeBillPayments(h.rf, [bill('B-206').pk]))[0]!.action!;
    expect(first).toMatchObject({ status: 'pending' });
    expect(first.policyReason).toMatch(/Check first: First payment to Sam Rivera/);
    expect(first.reason).toMatch(/at sam\.rivera@example\.com/);
    h.rf.reject(first.id);

    // The owner's rule: bills up to $500 are paid on their own. Risky payees still wait.
    const rule = parseRulesWithPatterns('Bills up to $500 run on their own.', {
      currency: 'USD',
      customers: [],
    });
    expect(rule.changes[0]).toMatchObject({
      type: 'approval',
      kind: 'pay_supplier',
      mode: 'auto',
      maxAmount: 500,
    });
    h.rf.mapping = applyRuleChanges(h.rf.mapping, rule.changes);
    const pks = (await loadBills(h.rf)).filter((b) => b.state === 'open').map((b) => b.pk);
    const results = await proposeBillPayments(h.rf, pks);
    const by = (n: string) => results.find((r) => r.number === n)!.action!;
    expect(by('B-203').status).toBe('executed');
    expect(by('B-204').status).toBe('executed');
    expect(by('B-205')).toMatchObject({ status: 'pending' });
    expect(by('B-205').policyReason).toMatch(/PayPal email changed .* so it waits for you/);
    expect(by('B-206').policyReason).toMatch(/First payment to Sam Rivera, so it waits for you/);
    expect(by('B-204').amount).toBe(175); // from the bill

    // PayPal processes the batch; the webhook marks the bill paid in the business's own table.
    const b204 = results.find((r) => r.number === 'B-204')!.pk;
    const row = await until(async () => {
      const [r] = await h.rf.source.readTable('bills', { column: 'id', in: [b204] });
      return r?.status === 'paid' && r;
    });
    const payout = h.rf.state.listPayouts(b204)[0]!;
    expect(payout).toMatchObject({
      status: 'SUCCESS',
      receiver: 'jordan.avery@example.com',
      amount: 175,
      fee: 3.5,
    });
    expect(row.payout_ref).toBe(payout.transactionId);
    expect(String(row.paid_on)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // A bill already paid cannot be paid again, and PayPal itself refuses the same batch twice.
    expect((await proposeBillPayments(h.rf, [b204]))[0]!.error).toMatch(/is paid/);
    await expect(
      h.rf.paypal.createPayout(
        {
          sender_batch_header: { sender_batch_id: `retrofit-${b204}-${by('B-204').id}` },
          items: [
            {
              recipient_type: 'EMAIL',
              amount: { value: '175.00', currency: 'USD' },
              receiver: 'jordan.avery@example.com',
            },
          ],
        },
        'retry',
      ),
    ).rejects.toThrow(/sender_batch_id already exists/);

    const trail = await moneyTrail(h.rf, 'payable', b204);
    expect(trail.number).toBe('B-204');
    expect(trail.steps.map((s) => s.title)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Payout .*175\.00 USD to jordan\.avery/),
        'PAYMENT.PAYOUTSBATCH.SUCCESS',
      ]),
    );
    expect(trail.steps.find((s) => s.kind === 'writeback')!.detail).toMatch(/status = paid/);

    // The bill is edited after the owner saw it: the approved payment refuses to run.
    const b205 = results.find((r) => r.number === 'B-205')!.pk;
    await h.rf.source.update('bills', 'id', b205, { payee_email: 'pixelpine.unclaimed@example.net' });
    const refused = await h.rf.approve(by('B-205').id);
    expect(refused.status).toBe('failed');
    expect(JSON.stringify(refused.result)).toMatch(/changed since it was approved/);

    // Proposed again and approved: the payee has no PayPal account yet, so the money waits for them.
    const again = (await proposeBillPayments(h.rf, [b205]))[0]!.action!;
    expect(again.status).toBe('pending');
    await h.rf.approve(again.id);
    const unclaimed = await until(() =>
      h.rf.state.listDiscrepancies().find((d) => d.kind === 'payout_unclaimed'),
    );
    expect(unclaimed.detail).toMatch(/has not claimed 135\.00 USD/);
    const [still] = await h.rf.source.readTable('bills', { column: 'id', in: [b205] });
    expect(still!.status).toBe('open');
    const item = h.rf.state.listPayouts(b205)[0]!.itemId!;
    await fetch(`${h.mockUrl}/mock/api/payouts-item/${item}/claim`, { method: 'POST' });
    await until(
      async () => (await h.rf.source.readTable('bills', { column: 'id', in: [b205] }))[0]?.status === 'paid',
    );
    expect(h.rf.state.listDiscrepancies().some((d) => d.kind === 'payout_unclaimed')).toBe(false);
  });
});
