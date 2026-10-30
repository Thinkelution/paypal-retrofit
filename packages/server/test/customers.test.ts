import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actionLinkSecret,
  buildStatement,
  listCustomers,
  planCollections,
  planTerms,
  reconcile,
  runTerms,
  signPortalToken,
} from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { createHost, createServer } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('payment terms', () => {
  it('applies an early-payment discount on creation, ends it, and adds a late fee, all reconciled', async () => {
    const h = await harness({ autoApprove: true });
    cleanups.push(h.close);
    h.rf.mapping.terms = {
      lateFee: { kind: 'percent', amount: 2, afterDays: 30, label: 'Late payment fee (2%)' },
      earlyDiscount: { percent: 5, withinDays: 400 },
    };
    await h.rf.sync();
    const discounted = h.rf.state.listAdjustments().filter((a) => a.kind === 'early_discount');
    expect(discounted.length).toBeGreaterThan(5);
    const d = discounted.find((x) => x.until! < '2027-11-01')!; // one that has ended by then
    const inv = await h.rf.invoice(d.legacyPk);
    const pp = await h.rf.paypal.getInvoice(h.rf.state.getLink('invoice', d.legacyPk)!.paypalId);
    expect(Number(pp.amount?.value)).toBeCloseTo(inv.total * 0.95, 2);
    expect(pp.detail?.note).toMatch(/taken off/);
    await reconcile(h.rf);
    expect(h.rf.state.listDiscrepancies().filter((x) => x.kind === 'amount_mismatch')).toEqual([]);

    // A year later: discounts have ended and many invoices are past the late-fee threshold.
    const later = '2027-11-01';
    const due = await planTerms(h.rf, later);
    expect(due.filter((t) => t.kind === 'expire_discount').length).toBe(
      discounted.filter((x) => x.until! < later).length,
    );
    const fee = due.find((t) => t.kind === 'late_fee')!;
    expect(fee.reason).toMatch(/2% of/);
    const actions = await runTerms(h.rf, { today: later });
    expect(actions.every((a) => a.status === 'executed')).toBe(true);

    const link = h.rf.state.getLink('invoice', fee.legacyPk)!;
    const withFee = await h.rf.paypal.getInvoice(link.paypalId);
    expect(withFee.items?.some((i: any) => /Late payment fee/.test(i.name))).toBe(true);
    const ppAfter = await h.rf.paypal.getInvoice(h.rf.state.getLink('invoice', d.legacyPk)!.paypalId);
    expect(Number(ppAfter.amount?.value)).toBeCloseTo(
      inv.total + (fee.legacyPk === d.legacyPk ? fee.amount : 0),
      2,
    );
    // Fees and discounts are expected differences: no amount mismatches.
    await reconcile(h.rf);
    expect(h.rf.state.listDiscrepancies().filter((x) => x.kind === 'amount_mismatch')).toEqual([]);
    // The fee is part of what collections chases, and it is never added twice.
    const item = (await planCollections(h.rf, later)).find((i) => i.legacyPk === fee.legacyPk)!;
    expect(item.amountDue).toBeCloseTo((await h.rf.invoice(fee.legacyPk)).total + fee.amount, 2);
    expect((await planTerms(h.rf, later)).some((t) => t.legacyPk === fee.legacyPk)).toBe(false);
  });
});

describe('customer portal and statements', () => {
  it('lets a customer pay several invoices in one PayPal checkout and books each one', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });

    const customer = (await listCustomers(h.rf)).find((c) => c.openInvoices >= 2)!;
    const statement = await buildStatement(h.rf, customer.pk);
    expect(statement.lines.length).toBe(customer.openInvoices);
    expect(statement.totals.balance).toBeCloseTo(customer.balance, 2);
    const token = signPortalToken(actionLinkSecret(h.rf), customer.pk);
    const page = await (await fetch(`${server.url}/p/${token}`)).text();
    expect(page).toContain(`Hi ${customer.name}`);
    expect(page).toContain('Pay selected with PayPal');
    expect((await fetch(`${server.url}/p/${token.slice(0, -2)}xx`)).status).toBe(400);

    const ids = statement.lines.filter((l) => l.inPayPal).map((l) => l.legacyPk);
    const pay = await fetch(`${server.url}/p/${token}/pay`, {
      method: 'POST',
      body: new URLSearchParams(ids.map((i): [string, string] => ['invoice', i])),
      redirect: 'manual',
    });
    expect(pay.status).toBe(303);
    const orderId = pay.headers.get('location')!.split('/').pop()!;
    await h.mock.approveOrder(orderId);
    const back = await fetch(`${server.url}/checkout/return?token=${orderId}`, { redirect: 'manual' });
    expect(back.headers.get('location')).toMatch(/\/p\/.+\?done=paid$/);
    await sleep(300);

    for (const pk of ids) {
      expect(h.rf.state.getLink('invoice', pk)!.paypalStatus).toBe('MARKED_AS_PAID');
      expect((await h.rf.invoice(pk)).state).toBe('paid');
    }
    const order = h.rf.state.listOrders()[0]!;
    expect(order).toMatchObject({ channel: 'portal', status: 'COMPLETED' });
    const rows = h.rf.state.listPayments().filter((p) => ids.includes(p.legacyPk));
    expect(rows.every((r) => r.kind === 'payment' && r.method === 'PAYPAL')).toBe(true);
    expect(rows.reduce((s, r) => s + (r.fee ?? 0), 0)).toBeCloseTo(order.fee!, 1);
    expect((await listCustomers(h.rf)).find((c) => c.pk === customer.pk)!.balance).toBe(0);
  });

  it('turns promises, plan requests and questions into collections decisions', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });
    const overdue = (await planCollections(h.rf)).filter((i) => i.decision === 'remind').slice(0, 3);
    const send = async (pk: string, body: Record<string, string>) => {
      const inv = await h.rf.invoice(pk);
      const token = signPortalToken(actionLinkSecret(h.rf), inv.customerPk);
      const r = await fetch(`${server.url}/p/${token}/request`, {
        method: 'POST',
        body: new URLSearchParams({ invoice: pk, ...body }),
        redirect: 'manual',
      });
      expect(r.headers.get('location')).toMatch(/done=/);
    };
    await send(overdue[0]!.legacyPk, { kind: 'promise', date: '2099-01-01' });
    await send(overdue[1]!.legacyPk, {
      kind: 'question',
      message: 'I think this was already paid by cheque',
    });
    await send(overdue[2]!.legacyPk, { kind: 'plan', installments: '3' });

    const plan = await planCollections(h.rf);
    const by = (pk: string) => plan.find((i) => i.legacyPk === pk)!;
    expect(by(overdue[0]!.legacyPk)).toMatchObject({ decision: 'hold' });
    expect(by(overdue[0]!.legacyPk).reason).toMatch(/promised in the portal to pay by 2099-01-01/);
    expect(by(overdue[1]!.legacyPk).reason).toMatch(/already paid by cheque/);
    expect(by(overdue[2]!.legacyPk).decision).toBe('wait'); // the plan offer is already queued
    const offer = h.rf.state.listActions('pending').find((a) => a.origin === 'portal')!;
    expect(offer).toMatchObject({ kind: 'offer_payment_plan', payload: { installments: 3 } });
    // No late fee for anyone who has asked for something.
    h.rf.mapping.terms = { lateFee: { kind: 'flat', amount: 25, afterDays: 1, label: 'Late fee' } };
    const fees = await planTerms(h.rf);
    expect(fees.some((f) => overdue.some((o) => o.legacyPk === f.legacyPk))).toBe(false);
  });

  it('sends statements through the mailer, or keeps them in the outbox', async () => {
    const h = await harness({ autoApprove: true });
    cleanups.push(h.close);
    await h.rf.sync();
    h.rf.portalUrl = (pk) => `https://example.test/p/${pk}`;
    const customer = (await listCustomers(h.rf)).find((c) => c.balance > 0)!;
    const target = { entity: 'customer' as const, legacyPk: customer.pk, label: customer.name };
    const kept = await h.rf.propose({
      origin: 'cli',
      kind: 'send_statement',
      target,
      payload: {},
      reason: 'test',
    });
    expect(kept.result).toMatchObject({ status: 'outbox' });
    const sent: any[] = [];
    h.rf.mailer = async (m) => (sent.push(m), { id: 'msg-1' });
    const mailed = await h.rf.propose({
      origin: 'cli',
      kind: 'send_statement',
      target,
      payload: {},
      reason: 'test 2',
    });
    expect(mailed.result).toMatchObject({ status: 'sent' });
    expect(sent[0].to).toBe(customer.email);
    expect(sent[0].html).toContain('https://example.test/p/');
    expect(sent[0].subject).toMatch(/Statement from Fernhill Studio/);
    expect(h.rf.state.listOutbox().map((o) => o.status)).toEqual(['sent', 'outbox']);
  });
});

describe('multi-client practice', () => {
  it('hosts several clients at /c/<id> with one overview', async () => {
    await harness().then((h) => cleanups.push(h.close)); // MOCK env + mock PayPal
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-practice-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const host = createHost({
      mode: 'practice',
      server: { watch: false },
      setup: {
        workspaceRoot: dir,
        allowServerPaths: false,
        allowReconfigure: true,
        invoicePrefix: () => `P${Math.random().toString(36).slice(2, 6)}-`,
      },
    });
    await host.start();
    const server = await listen(host.app);
    cleanups.push(async () => {
      for (const id of [...host.workspaces.keys()]) await host.remove(id);
      await server.close();
    });
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(server.url + p, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    for (const name of ['Brightside Plumbing', 'Brightside North']) {
      const src = await call('POST', '/api/setup/sources', { kind: 'sample' });
      await call('POST', `/api/setup/sources/${src.body.id}/map`, { ai: false });
      const fin = await call('POST', `/api/setup/sources/${src.body.id}/finish`, {
        business: { name },
        syncNow: true,
      });
      expect(fin.body.consoleUrl).toMatch(/^\/c\/brightside-/);
    }
    expect((await call('GET', '/api/summary')).status).toBe(409); // no business at the root
    const host1 = await call('GET', '/api/host');
    expect(host1.body.mode).toBe('practice');
    expect(host1.body.workspaces.map((w: any) => w.id).sort()).toEqual([
      'brightside-north',
      'brightside-plumbing',
    ]);
    const overview = await call('GET', '/api/practice');
    expect(overview.body).toHaveLength(2);
    expect(overview.body[0]).toMatchObject({ linked: 15, invoices: 30 });
    const one = await call('GET', '/c/brightside-north/api/summary');
    expect(one.body.business).toBe('Brightside North');
  });
});
