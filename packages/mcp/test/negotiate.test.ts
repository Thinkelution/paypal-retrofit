import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actionLinkSecret,
  buildStatement,
  customerProfiles,
  listCustomers,
  signPortalToken,
} from '../../core/src/index.ts';
import { harness } from '../../core/test/helpers.ts';
import { createShopMcpServer } from '../src/shop.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('agent-to-agent payment plans', () => {
  it("lets a customer's assistant agree a plan inside the owner's limits, counter-offers outside them", async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const server = createShopMcpServer(h.rf, { baseUrl: 'https://studio.example' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'assistant', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanups.push(() => client.close());
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      if (r.isError) throw new Error(text);
      return JSON.parse(text);
    };

    // A reliable customer with an open invoice in PayPal, and one we know nothing about.
    const profiles = await customerProfiles(h.rf);
    const customers = (await listCustomers(h.rf)).filter((c) => c.openInvoices > 0);
    const reliable = customers.find((c) => (profiles.get(c.pk)?.onTimeRate ?? 0) >= 0.5)!;
    expect(reliable).toBeTruthy();
    const linkOf = (pk: string) => `https://studio.example/p/${signPortalToken(actionLinkSecret(h.rf), pk)}`;
    const firstOpen = async (pk: string) =>
      (await buildStatement(h.rf, pk)).lines.find((l) => l.inPayPal && !l.onPlan)!;

    // Inside autoAccept: agreed on the spot, and the PayPal invoice now takes instalments.
    h.rf.mapping.plans = {
      ...h.rf.mapping.plans,
      autoAccept: { maxAmount: 100000, maxInstallments: 3, minOnTimeRate: 0.5 },
    };
    const inv = await firstOpen(reliable.pk);
    const agreed = await call('propose_payment_plan', {
      portal_link: linkOf(reliable.pk),
      invoice: inv.number,
      installments: 3,
      agent: 'Claude',
    });
    expect(agreed).toMatchObject({ status: 'agreed', offer: { installments: 3 } });
    expect(agreed.offer.amounts.reduce((s: number, x: number) => s + x, 0)).toBeCloseTo(inv.balance, 2);
    expect(h.rf.state.getPlan(inv.legacyPk)?.status).toBe('active');
    const pp: any = await h.rf.paypal.getInvoice(h.rf.state.getLink('invoice', inv.legacyPk)!.paypalId);
    expect(pp.configuration?.partial_payment?.allow_partial_payment).toBe(true);

    // Asking for too much gets the closest offer; taking it goes to the owner (4 parts is above autoAccept).
    const other = customers.find((c) => c.pk !== reliable.pk)!;
    const inv2 = await firstOpen(other.pk);
    const counter = await call('propose_payment_plan', {
      portal_link: linkOf(other.pk),
      invoice: inv2.number,
      installments: 8,
      interval_days: 60,
    });
    expect(counter).toMatchObject({ status: 'counter', offer: { installments: 4, intervalDays: 30 } });
    expect(counter.next).toMatch(/accept_plan_offer/);
    await expect(
      call('accept_plan_offer', { portal_link: linkOf(reliable.pk), offer_id: counter.id }),
    ).rejects.toThrow(/No such offer/);
    const taken = await call('accept_plan_offer', { portal_link: linkOf(other.pk), offer_id: counter.id });
    expect(taken).toMatchObject({ status: 'owner' });
    const pending = h.rf.state.listActions('pending').find((x) => x.target.legacyPk === inv2.legacyPk)!;
    expect(pending).toMatchObject({
      kind: 'offer_payment_plan',
      origin: 'assistant',
      payload: { installments: 4 },
    });

    // The same invoice cannot be negotiated twice once it is on a plan.
    const again = await call('propose_payment_plan', {
      portal_link: linkOf(reliable.pk),
      invoice: inv.number,
      installments: 2,
    });
    expect(again).toMatchObject({ status: 'declined' });
    expect(
      h.rf.state
        .listNegotiations()
        .map((n) => n.status)
        .sort(),
    ).toEqual(['agreed', 'declined', 'owner']);
  });
});
