import { afterEach, describe, expect, it } from 'vitest';
import {
  actionLinkSecret,
  listCustomers,
  planCollections,
  runAutopay,
  signPortalToken,
} from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { createServer } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('autopay with a saved PayPal', () => {
  it('lets a customer save PayPal in the portal, then pays their invoices on the due date', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });
    const mock = (path: string, body?: unknown) =>
      fetch(`${h.mockUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });

    // Opt in from the portal: PayPal Vault setup token, approved by the customer, saved as a payment token.
    const optIn = async (pk: string) => {
      const token = signPortalToken(actionLinkSecret(h.rf), pk);
      const start = await fetch(`${server.url}/p/${token}/autopay`, {
        method: 'POST',
        body: new URLSearchParams({ max: '' }),
        redirect: 'manual',
      });
      expect(start.status).toBe(303);
      const setupId = start.headers.get('location')!.match(/\/mock\/vault\/([^/?]+)/)![1]!;
      expect((await mock(`/mock/api/vault/${setupId}/approve`)).status).toBe(200);
      const back = await fetch(`${server.url}/p/${token}/autopay/return?approval_token_id=${setupId}`, {
        redirect: 'manual',
      });
      expect(back.headers.get('location')).toMatch(/done=autopay-on$/);
      return token;
    };

    const customers = (await listCustomers(h.rf)).filter((c) => c.openInvoices > 0);
    const [payer, decliner] = customers;
    const token = await optIn(payer!.pk);
    expect(h.rf.state.getAutopay(payer!.pk)).toMatchObject({
      status: 'active',
      payerEmail: 'buyer@example.com',
    });
    expect(await (await fetch(`${server.url}/p/${token}`)).text()).toContain('On with PayPal');
    expect((await listCustomers(h.rf)).find((c) => c.pk === payer!.pk)?.autopay).toBe('active');

    // Collections leave autopay customers alone.
    const held = (await planCollections(h.rf)).filter((i) => i.reason.startsWith('On autopay'));
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((i) => i.customer === payer!.name && i.decision === 'hold')).toBe(true);

    // On the due date (here: well after it), the saved PayPal is charged and each invoice is booked.
    const before = (await listCustomers(h.rf)).find((c) => c.pk === payer!.pk)!.balance;
    const charged = await runAutopay(h.rf, { today: '2030-01-01' });
    const mine = charged.filter((a) => a.status === 'executed');
    expect(mine.length).toBe(payer!.openInvoices);
    await sleep(300);
    expect((await listCustomers(h.rf)).find((c) => c.pk === payer!.pk)?.balance ?? 0).toBe(0);
    expect(before).toBeGreaterThan(0);
    const orders = h.rf.state.listOrders().filter((o) => o.channel === 'autopay');
    expect(orders.every((o) => o.status === 'COMPLETED' && o.fee! > 0)).toBe(true);
    for (const a of mine) {
      const link = h.rf.state.getLink('invoice', a.target.legacyPk)!;
      expect(link.paypalStatus).toBe('MARKED_AS_PAID');
      expect((await h.rf.invoice(a.target.legacyPk)).state).toBe('paid');
    }
    // Nothing is charged twice.
    const again = await runAutopay(h.rf, { today: '2030-01-01' });
    expect(again.some((a) => mine.some((m) => m.target.legacyPk === a.target.legacyPk))).toBe(false);

    // A declined charge is not retried: reminders take over.
    await optIn(decliner!.pk);
    const pt = h.rf.state.getAutopay(decliner!.pk)!.paymentTokenId!;
    await mock(`/mock/api/vault/payment-tokens/${pt}/decline`);
    const failed = (await runAutopay(h.rf, { today: '2030-01-01' })).filter((a) => a.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(
      String((failed[0]!.result as any)?.error ?? h.rf.state.getAutopay(decliner!.pk)!.lastError),
    ).toMatch(/INSTRUMENT_DECLINED|declined/i);
    const plan = await planCollections(h.rf, '2030-01-01');
    const theirs = plan.filter((i) => failed.some((f) => f.target.legacyPk === i.legacyPk));
    expect(theirs.every((i) => !i.reason.startsWith('On autopay'))).toBe(true);
    expect((await runAutopay(h.rf, { today: '2030-01-01' })).length).toBe(0);

    // The customer removes the business in their PayPal account: autopay stops.
    await mock(`/mock/api/vault/payment-tokens/${pt}/revoke`);
    await sleep(300);
    expect(h.rf.state.getAutopay(decliner!.pk)?.status).toBe('off');
  });
});
