import { afterEach, describe, expect, it } from 'vitest';
import { applyRuleChanges, ledger, moneyTrail, parseRulesWithPatterns, shadowReplay } from '../src/index.ts';
import { harness } from './helpers.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('money trail', () => {
  it('shows every step of an invoice in order: link, actions with their rule, webhooks, payment and write-backs', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const row = (await ledger(h.rf)).find((r) => r.entity === 'invoice' && r.paypalStatus === 'SENT')!;
    await h.mock.payInvoice(row.paypalId!);
    await sleep(300);

    const t = await moneyTrail(h.rf, 'invoice', row.legacyPk);
    expect(t.number).toBe(row.number);
    const kinds = t.steps.map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['link', 'action', 'webhook', 'payment', 'writeback']));
    const created = t.steps.find((s) => s.kind === 'action' && /Create invoice proposed/.test(s.title))!;
    expect(created.by).toBe('sync');
    expect(created.detail).toMatch(/Rule: |Policy for/);
    const paidHook = t.steps.find((s) => s.kind === 'webhook' && /PAID|CAPTURE/.test(s.title))!;
    expect(paidHook.by).toMatch(/PayPal/);
    const wrote = t.steps
      .filter((s) => s.kind === 'writeback')
      .map((s) => s.detail)
      .join(' ');
    expect(wrote).toMatch(/paypal_invoice_id = /);
    expect(wrote).toMatch(/status = paid/);
    // In time order.
    expect([...t.steps].map((s) => s.at)).toEqual([...t.steps].map((s) => s.at).sort());
  });
});

describe('shadow mode', () => {
  it('replays the last 90 days through the current rules without touching PayPal or the data', async () => {
    const h = await harness();
    cleanups.push(h.close);
    const linksBefore = h.rf.state.listLinks().length;
    const r = await shadowReplay(h.rf, { today: '2026-10-29', days: 90 });
    expect(h.rf.state.listLinks().length).toBe(linksBefore); // nothing sent
    expect(h.rf.state.listActions().length).toBe(0); // nothing proposed
    expect(r.window).toEqual({ from: '2026-07-31', to: '2026-10-29', days: 90 });
    expect(r.invoices).toBeGreaterThan(20);
    expect(r.sent).toBeGreaterThan(10);
    expect(r.reminders.total).toBeGreaterThan(5);
    expect(r.reminders.onTheirOwn + r.reminders.needYou).toBe(r.reminders.total);
    expect(r.estimate.overdueInvoices).toBeGreaterThan(0);
    expect(r.estimate.avgDaysSooner).toBeGreaterThan(0);
    expect(r.assumption).toMatch(/Estimate only/);
    expect(r.weeks.length).toBeGreaterThan(8);
    expect(r.examples[0]!.steps.length).toBeGreaterThan(0);

    // Changing the rules changes the replay: reminders on their own up to $1,000, and a rule for one customer.
    const someone = r.examples[0]!.customer;
    const { changes } = parseRulesWithPatterns(
      `Reminders up to $1000 run on their own. Never chase ${someone}`,
      {
        currency: 'USD',
        customers: [],
      },
    );
    h.rf.mapping = applyRuleChanges(h.rf.mapping, changes);
    const r2 = await shadowReplay(h.rf, { today: '2026-10-29', days: 90 });
    expect(r2.reminders.onTheirOwn).toBeGreaterThan(r.reminders.onTheirOwn);
    expect(r2.reminders.heldByRules).toBeGreaterThan(0);
  });
});
