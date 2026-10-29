import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cashForecast,
  customerProfiles,
  decidePolicy,
  invoiceRisks,
  isQuiet,
  journal,
  journalCsv,
  monthSummary,
  nextBusinessTime,
  planCollections,
  reconcile,
  runCollections,
  type QuietHours,
} from '../src/index.ts';
import { harness } from './helpers.ts';

const TODAY = '2026-10-29';
let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const legacy = (file: string, number: string) => {
  const db = new Database(file, { readonly: true });
  const r = db.prepare('SELECT * FROM invoices WHERE invoice_no=?').get(number) as any;
  db.close();
  return r;
};
const linkOf = (number: string) => {
  const row = legacy(h!.dbFile, number);
  return { row, link: h!.rf.state.getLink('invoice', String(row.id))! };
};

describe('approval rules, limits and quiet hours', () => {
  it('decides by amount, then by daily limit, and explains why', async () => {
    h = await harness();
    const { mapping, state } = h.rf;
    const small = decidePolicy(mapping, state, 'create_refund', { amount: 40 });
    expect(small.mode).toBe('auto');
    expect(small.reason).toMatch(/refunds up to 100\.00 USD are "auto"/);
    const big = decidePolicy(mapping, state, 'create_refund', { amount: 400 });
    expect(big.mode).toBe('confirm');
    expect(big.reason).toMatch(/Default policy for refunds is "confirm"/);

    // 480 already refunded automatically today: the next 40 would cross the 500/day cap.
    for (const amount of [90, 95, 99, 98, 98]) {
      const a = state.createAction({
        origin: 'agent',
        kind: 'create_refund',
        target: { entity: 'invoice', legacyPk: `x${amount}${Math.random()}` },
        payload: {},
        reason: 't',
        policy: 'auto',
        status: 'pending',
        amount,
      });
      state.finishAction(a.id, 'executed', {});
    }
    const capped = decidePolicy(mapping, state, 'create_refund', { amount: 40 });
    expect(capped.mode).toBe('confirm');
    expect(capped.reason).toMatch(/Daily limit: 480\.00 of 500\.00 USD/);

    expect(decidePolicy(mapping, state, 'accept_dispute', { amount: 1 }).mode).toBe('never');
  });

  it('knows business hours across time zones, weekends and daylight saving', () => {
    const qh: QuietHours = {
      start: '20:00',
      end: '08:00',
      timezone: 'America/Los_Angeles',
      weekends: true,
      kinds: ['send_reminder'],
    };
    expect(isQuiet(qh, new Date('2026-10-29T05:00:00Z'))).toBe(true); // Wed 22:00 PDT
    expect(isQuiet(qh, new Date('2026-10-29T18:00:00Z'))).toBe(false); // Thu 11:00 PDT
    expect(nextBusinessTime(qh, new Date('2026-10-29T05:00:00Z')).toISOString()).toBe(
      '2026-10-29T15:00:00.000Z',
    );
    // Saturday morning waits for Monday 08:00, which is PST after the clocks change on Nov 1.
    expect(nextBusinessTime(qh, new Date('2026-10-31T18:00:00Z')).toISOString()).toBe(
      '2026-11-02T16:00:00.000Z',
    );
  });

  it('holds customer-facing actions for quiet hours and runs them when due', async () => {
    h = await harness();
    // Quiet from the start of this hour for two hours, so anything approved now is held.
    const hh = (n: number) => `${String((new Date().getUTCHours() + n) % 24).padStart(2, '0')}:00`;
    h.rf.mapping.quietHours = {
      start: hh(0),
      end: hh(2),
      timezone: 'UTC',
      weekends: false,
      kinds: ['send_reminder'],
    };
    await h.rf.sync();
    const { row } = linkOf('INV-1012');
    const a = await h.rf.propose({
      origin: 'dashboard',
      kind: 'send_reminder',
      target: { entity: 'invoice', legacyPk: String(row.id), label: 'INV-1012' },
      reason: 'test',
    });
    expect(a.status).toBe('pending');
    const approved = await h.rf.approve(a.id);
    expect(approved.status).toBe('scheduled');
    expect(approved.policyReason).toMatch(/Held for quiet hours/);
    expect(await h.rf.runDue(new Date())).toEqual([]);
    const ran = await h.rf.runDue(new Date(Date.now() + 2 * 86400000));
    expect(ran.map((x) => x.status)).toEqual(['executed']);
    expect(
      h.mock.state().invoices[ran[0]!.result && (ran[0]!.result as any).reminded]?.reminders,
    ).toHaveLength(1);
  });
});

describe('payment plans on PayPal partial payments', () => {
  it('splits an invoice, accepts instalments, and completes the plan', async () => {
    h = await harness();
    await h.rf.sync();
    const { row, link } = linkOf('INV-1038');
    expect(row.total).toBe(580);
    const offer = await h.rf.propose({
      origin: 'agent',
      kind: 'offer_payment_plan',
      target: { entity: 'invoice', legacyPk: String(row.id), label: 'INV-1038' },
      payload: { installments: 2, intervalDays: 14, firstDue: '2026-10-20' },
      reason: 'asked to split',
    });
    expect(offer.status).toBe('pending');
    const done = await h.rf.approve(offer.id);
    expect(done.status).toBe('executed');
    const plan = h.rf.state.getPlan(String(row.id))!;
    expect(plan.schedule.map((s) => [s.due, s.amount])).toEqual([
      ['2026-10-20', 290],
      ['2026-11-03', 290],
    ]);
    expect(
      h.mock.state().invoices[link.paypalId].configuration.partial_payment.minimum_amount_due.value,
    ).toBe('290.00');

    await h.mock.payInvoice(link.paypalId, 290);
    let r = legacy(h.dbFile, 'INV-1038');
    expect(r.status).toBe('overdue');
    expect(r.paid_amount).toBe(290);
    expect(h.rf.state.listDiscrepancies().some((d) => d.kind === 'partial_payment')).toBe(false);
    expect(h.rf.state.listEvents().find((e) => e.summary?.includes('instalment'))?.summary).toMatch(
      /instalment 1 of 2/,
    );

    // Instalment 1 is covered, instalment 2 is not yet due: collections waits.
    const item = (await planCollections(h.rf, TODAY)).find((i) => i.number === 'INV-1038')!;
    expect(item.decision).toBe('wait');
    expect(item.reason).toMatch(/1 of 2 paid; next instalment 2026-11-03/);

    await h.mock.payInvoice(link.paypalId);
    r = legacy(h.dbFile, 'INV-1038');
    expect(r.status).toBe('paid');
    expect(h.rf.state.getPlan(String(row.id))!.status).toBe('completed');
  });
});

describe('collections playbook', () => {
  it('reminds, holds promises, offers plans, and does not double-send', async () => {
    h = await harness();
    await h.rf.sync();
    const items = await planCollections(h.rf, TODAY);
    const by = (n: string) => items.find((i) => i.number === n)!;
    expect(by('INV-1038').decision).toBe('plan');
    expect(by('INV-1042').decision).toBe('hold');
    expect(by('INV-1042').reason).toMatch(/promised to pay/);
    expect(by('INV-1012')).toMatchObject({ decision: 'remind', tone: 'friendly', step: 1 });
    expect(items.filter((i) => i.decision === 'wait').every((i) => i.daysOverdue < 3)).toBe(true);

    const run = await runCollections(h.rf, { today: TODAY, origin: 'cli' });
    const reminders = run.proposed.filter((p) => p.action.kind === 'send_reminder');
    expect(reminders.length).toBe(items.filter((i) => i.decision === 'remind').length);
    expect(reminders.every((p) => p.action.status === 'pending')).toBe(true);
    expect(String(reminders[0]!.action.payload.note)).toMatch(/^Hi \w+, just a friendly reminder/);
    expect(run.proposed.find((p) => p.item.number === 'INV-1038')!.action.kind).toBe('offer_payment_plan');

    const again = await planCollections(h.rf, TODAY);
    expect(again.find((i) => i.number === 'INV-1012')!.reason).toMatch(/waiting for approval/);

    const first = reminders.find((p) => p.item.number === 'INV-1012')!;
    expect((await h.rf.approve(first.action.id)).status).toBe('executed');
    const after = (await planCollections(h.rf, TODAY)).find((i) => i.number === 'INV-1012')!;
    expect(after.decision).toBe('wait');
    expect(after.remindersSent).toBe(1);
    // Five days later the firm reminder is due.
    const later = (await planCollections(h.rf, '2026-11-05')).find((i) => i.number === 'INV-1012')!;
    expect(later).toMatchObject({ decision: 'remind', tone: 'firm', step: 2 });
  });

  it('holds reminders while a dispute is open', async () => {
    h = await harness();
    await h.rf.sync();
    const { row } = linkOf('INV-1020');
    h.rf.state.openDiscrepancy({
      entity: 'invoice',
      legacyPk: String(row.id),
      paypalId: 'PP-D-1',
      kind: 'dispute',
      detail: 'test',
    });
    const item = (await planCollections(h.rf, TODAY)).find((i) => i.number === 'INV-1020')!;
    expect(item.decision).toBe('hold');
  });
});

describe('risk, forecast and books', () => {
  it('learns how each customer pays and explains the risk', async () => {
    h = await harness();
    await h.rf.sync();
    const profiles = [...(await customerProfiles(h.rf, TODAY)).values()];
    const tom = profiles.find((p) => p.name === 'Tom Whitaker')!;
    expect(tom.medianDaysLate).toBeGreaterThan(7);
    expect(tom.behaviour).toBe('usually late');
    const risks = await invoiceRisks(h.rf, TODAY);
    const tomInv = risks.find((r) => r.customer === 'Tom Whitaker' && r.daysOverdue > 0)!;
    expect(tomInv.factors.join(' ')).toMatch(/usually pays \d+ days late/);
    const old = risks.find((r) => r.number === 'INV-1012')!;
    expect(old.band).toBe('high');
    expect(risks.every((r) => r.expectedPayDate > TODAY)).toBe(true);

    const f = await cashForecast(h.rf, { today: TODAY });
    expect(f.weeks).toHaveLength(9);
    expect(f.next30).toBeGreaterThan(0);
    expect(f.next60).toBeGreaterThanOrEqual(f.next30);
    expect(f.weeks.some((w) => w.fromSubscriptions > 0)).toBe(true);
    expect(f.atRisk).toBeGreaterThan(0);
  });

  it('keeps gross, fee and net for every PayPal payment and exports them', async () => {
    h = await harness();
    await h.rf.sync();
    const { link } = linkOf('INV-1012');
    await h.mock.payInvoice(link.paypalId);
    const rows = await journal(h.rf);
    expect(rows).toHaveLength(1);
    const p = rows[0]!;
    expect(p.gross).toBe(1450);
    expect(p.fee).toBeCloseTo(1450 * 0.0349 + 0.49, 2);
    expect(p.net).toBeCloseTo(p.gross - p.fee!, 2);
    const xero = journalCsv(rows, 'xero').trim().split('\n');
    expect(xero[0]).toBe('Date,Amount,Payee,Description,Reference');
    expect(xero[2]).toMatch(/^\d{2}\/\d{2}\/\d{4},-51\.10,PayPal,PayPal fee INV-1012,/);
    const s = await monthSummary(h.rf, p.date.slice(0, 7));
    expect(s).toMatchObject({ grossCollected: 1450, paypalPayments: 1, feesMissing: 0 });
    expect(s.net).toBeCloseTo(1450 - p.fee!, 2);
  });

  it('fills fees from transaction search when the capture webhook was missed', async () => {
    h = await harness();
    await h.rf.sync();
    const { link } = linkOf('INV-1020');
    for (const id of Object.keys(h.mock.state().webhooks)) delete h.mock.state().webhooks[id];
    await h.mock.payInvoice(link.paypalId);
    const rep = await reconcile(h.rf);
    expect(rep.feesFilled).toBe(1);
    expect((await journal(h.rf))[0]!.fee).toBeGreaterThan(0);
  });
});
