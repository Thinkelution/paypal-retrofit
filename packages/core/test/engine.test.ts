import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { handleWebhook, ledger, reconcile } from '../src/index.ts';
import { harness } from './helpers.ts';

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const legacyRow = (file: string, number: string) => {
  const db = new Database(file, { readonly: true });
  const r = db.prepare('SELECT * FROM invoices WHERE invoice_no=?').get(number) as any;
  db.close();
  return r;
};

describe('heuristic mapping on the Fernhill schema', () => {
  it('maps customers, invoices, lines and retainers without errors', async () => {
    h = await harness();
    expect(h.issues.filter((i) => i.level === 'error')).toEqual([]);
    const e = h.mapping.entities;
    expect(e.customer.table).toBe('customers');
    expect(e.customer.fields.name).toBe('full_name');
    expect(e.invoice.table).toBe('invoices');
    expect(e.invoice.fields.number).toBe('invoice_no');
    expect(e.invoice.lines?.table).toBe('invoice_items');
    expect(e.invoice.statusMap.paid).toEqual(['paid']);
    expect(e.invoice.statusMap.cancelled).toEqual(['void']);
    expect(e.invoice.push.sort()).toEqual(['overdue', 'sent']);
    expect(e.invoice.writeBack.paypalId).toBe('paypal_invoice_id');
    expect(e.subscription?.table).toBe('retainers');
  });
});

describe('sync → pay → webhook → write-back', () => {
  it('pushes open invoices once, writes back links, and records payments from webhooks', async () => {
    h = await harness();
    const first = await h.rf.sync();
    const created = first.results.filter((r) => r.item.kind === 'create_invoice');
    expect(created.length).toBe(22); // 17 overdue + 5 sent
    expect(created.every((r) => r.action.status === 'executed')).toBe(true);
    // Subscriptions need confirmation by default.
    expect(
      first.results
        .filter((r) => r.item.kind === 'create_subscription')
        .every((r) => r.action.status === 'pending'),
    ).toBe(true);

    // Idempotent: a second sync plans nothing new.
    const second = await h.rf.sync();
    expect(second.plan.filter((p) => p.kind === 'create_invoice')).toEqual([]);

    const target = created[0]!.item.target;
    const before = legacyRow(h.dbFile, target.label!);
    expect(before.paypal_invoice_id).toMatch(/^INV2-/);
    expect(before.paypal_link).toContain('/mock/invoice/');
    expect(before.status).not.toBe('paid');

    await h.mock.payInvoice(before.paypal_invoice_id);
    const after = legacyRow(h.dbFile, target.label!);
    expect(after.status).toBe('paid');
    expect(after.paid_amount).toBeCloseTo(before.total, 2);
    expect(after.paid_at).toMatch(/^\d{4}-\d{2}-\d{2}/);

    const events = h.rf.state.listEvents();
    expect(events.some((e) => e.type === 'INVOICING.INVOICE.PAID' && e.status === 'processed')).toBe(true);
  });

  it('rejects webhooks with a bad signature and ignores duplicates', async () => {
    h = await harness();
    await h.rf.sync();
    const body = JSON.stringify({
      id: 'WH-TEST',
      event_type: 'INVOICING.INVOICE.PAID',
      resource: { id: 'INV2-NOPE' },
    });
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://example.com/cert',
      'paypal-transmission-id': 'abc',
      'paypal-transmission-time': new Date().toISOString(),
      'paypal-transmission-sig': 'forged',
    };
    const r = await handleWebhook(h.rf, headers, body);
    expect(r.status).toBe('rejected');
    expect(h.rf.state.getEvent('WH-TEST')).toBeUndefined();
  });

  it('reconciliation repairs a payment whose webhook was lost', async () => {
    h = await harness();
    const report = await h.rf.sync();
    const target = report.results.find((r) => r.item.kind === 'create_invoice')!.item.target;
    const row = legacyRow(h.dbFile, target.label!);
    // Drop all webhooks so the payment is never delivered.
    for (const id of Object.keys(h.mock.state().webhooks)) delete h.mock.state().webhooks[id];
    await h.mock.payInvoice(row.paypal_invoice_id);
    expect(legacyRow(h.dbFile, target.label!).status).not.toBe('paid');

    const rec = await reconcile(h.rf);
    expect(rec.errors).toEqual([]);
    expect(rec.fixed.length).toBe(1);
    expect(legacyRow(h.dbFile, target.label!).status).toBe('paid');
  });

  it('flags invoices marked paid by hand while still open in PayPal, and fixes them on approval', async () => {
    h = await harness();
    const report = await h.rf.sync();
    const target = report.results.find((r) => r.item.kind === 'create_invoice')!.item.target;
    const db = new Database(h.dbFile);
    db.prepare(
      `UPDATE invoices SET status='paid', paid_at='2026-10-28', paid_amount=total WHERE invoice_no=?`,
    ).run(target.label);
    db.close();

    await reconcile(h.rf);
    const d = h.rf.state.listDiscrepancies().find((x) => x.legacyPk === target.legacyPk);
    expect(d?.kind).toBe('paid_in_legacy_not_paypal');

    const sync = await h.rf.sync();
    const rp = sync.results.find(
      (r) => r.item.kind === 'record_payment' && r.item.target.legacyPk === target.legacyPk,
    );
    expect(rp?.action.status).toBe('pending');
    const done = await h.rf.approve(rp!.action.id);
    expect(done.status).toBe('executed');
    expect(h.rf.state.getLink('invoice', target.legacyPk)?.paypalStatus).toBe('MARKED_AS_PAID');
    await reconcile(h.rf);
    expect(h.rf.state.listDiscrepancies().find((x) => x.legacyPk === target.legacyPk)).toBeUndefined();
  });

  it('creates subscriptions on approval and activates them from webhooks', async () => {
    h = await harness();
    const report = await h.rf.sync();
    const pending = report.results.find((r) => r.item.kind === 'create_subscription')!;
    const done = await h.rf.approve(pending.action.id);
    expect(done.status).toBe('executed');
    const link = h.rf.state.getLink('subscription', pending.item.target.legacyPk)!;
    expect(link.payLink).toContain('/approve');
    await h.mock.approveSubscription(link.paypalId);
    const db = new Database(h.dbFile, { readonly: true });
    const r = db.prepare('SELECT * FROM retainers WHERE id=?').get(pending.item.target.legacyPk) as any;
    db.close();
    expect(r.status).toBe('active');
    expect(r.paypal_subscription_id).toBe(link.paypalId);
  });

  it('never executes actions whose policy is "never"', async () => {
    h = await harness();
    const a = await h.rf.propose({
      origin: 'agent',
      kind: 'accept_dispute',
      target: { entity: 'invoice', legacyPk: '1' },
      payload: { disputeId: 'PP-D-1' },
      reason: 'test',
    });
    expect(a.status).toBe('rejected');
  });

  it('produces a ledger that reflects PayPal state', async () => {
    h = await harness();
    await h.rf.sync();
    const rows = await ledger(h.rf);
    const linked = rows.filter((r) => r.entity === 'invoice' && r.paypalId);
    expect(linked.length).toBe(22);
    expect(linked.every((r) => r.paypalStatus === 'SENT')).toBe(true);
  });
});
