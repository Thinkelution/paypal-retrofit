import { afterEach, describe, expect, it } from 'vitest';
import { dateFrom, ledger, readEmailWithRules, type InboxContext } from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { createServer } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  delete process.env.RETROFIT_INBOUND_TOKEN;
});

const ctx: InboxContext = {
  business: 'Fernhill Studio',
  today: '2026-10-30',
  currency: 'USD',
  customer: { key: '3', name: 'Maya Okafor', email: 'maya@example.com' },
  open: [
    { legacyPk: '22', number: 'INV-1022', amount: 85, due: '2026-09-12', daysOverdue: 48 },
    { legacyPk: '34', number: 'INV-1034', amount: 317, due: '2026-10-08', daysOverdue: 22 },
  ],
};

describe('inbox agent', () => {
  it('reads everyday customer emails without Claude', () => {
    expect(dateFrom('I will pay by Friday', '2026-10-30')).toBe('2026-11-06');
    expect(dateFrom('paying on the 20th', '2026-10-30')).toBe('2026-11-20');
    expect(dateFrom('by Nov 3rd at the latest', '2026-10-30')).toBe('2026-11-03');
    expect(dateFrom('end of the month', '2026-10-30')).toBe('2026-10-31');
    const read = (text: string, subject = '') =>
      readEmailWithRules({ from: 'maya@example.com', subject, text }, ctx);
    expect(read("Sorry! I'll pay INV-1034 by Friday.")).toMatchObject({
      intent: 'promise',
      invoices: ['INV-1034'],
      payBy: '2026-11-06',
    });
    expect(read('I posted a cheque for $85.00 on Monday.')).toMatchObject({
      intent: 'paid_elsewhere',
      invoices: ['INV-1022'],
      amount: 85,
      method: 'CHECK',
      paidOn: '2026-10-26', // last Monday, not next
    });
    expect(read('Could I split 1034 into three payments?')).toMatchObject({
      intent: 'plan',
      invoices: ['INV-1034'],
      installments: 3,
    });
    expect(read('Please send me a statement of what I owe')).toMatchObject({ intent: 'statement' });
    expect(read('I think INV-1022 is wrong, I was charged twice')).toMatchObject({
      intent: 'dispute',
      invoices: ['INV-1022'],
    });
    // A complaint can name an invoice that is already paid.
    const paid = [{ legacyPk: '9', number: 'INV-1009', amount: 250, due: null, daysOverdue: 0 }];
    expect(
      readEmailWithRules(
        { from: 'maya@example.com', text: 'Two photos from INV-1009 are wrong' },
        { ...ctx, paid },
      ),
    ).toMatchObject({
      intent: 'dispute',
      invoices: ['INV-1009'],
    });
    expect(read('Thanks for the lovely photos!').intent).toBe('other');
  });

  it('turns emails into requests and actions, and never lets an emailed payment claim run on its own', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });
    const post = async (path: string, body: unknown) => {
      const r = await fetch(server.url + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    const rows = (await ledger(h.rf)).filter((r) => r.entity === 'invoice' && r.paypalStatus === 'SENT');
    const small = rows.find((r) => r.legacyTotal <= 250)!; // a rule lets payments up to $250 record on their own
    const other = rows.find((r) => r.customerEmail !== small.customerEmail)!;

    const cheque = await post('/api/inbox', {
      from: `${small.customer} <${small.customerEmail}>`,
      subject: `Payment for ${small.number}`,
      text: `Hello, I posted a cheque for $${small.legacyTotal.toFixed(2)} on Monday for ${small.number}.`,
    });
    expect(cheque.body).toMatchObject({ status: 'needs_owner', reading: { intent: 'paid_elsewhere' } });
    const action = h.rf.state.getAction(cheque.body.outcome.actions[0])!;
    expect(action).toMatchObject({ kind: 'record_payment', status: 'pending', origin: 'inbox' });
    expect(action.policyReason).toMatch(/came from an email/);

    const promise = await post('/api/inbox', {
      from: other.customerEmail,
      subject: `Re: ${other.number}`,
      text: `Sorry, I'll pay ${other.number} by the end of the month.`,
    });
    expect(promise.body.status).toBe('done');
    expect(h.rf.state.listRequests({ status: 'open', legacyPk: other.legacyPk })[0]).toMatchObject({
      kind: 'promise',
    });
    expect(promise.body.reply).toMatch(/won't send reminders/);

    const stranger = await post('/api/inbox', { from: 'someone@else.example', text: 'I paid by cheque' });
    expect(stranger.body.status).toBe('unknown_sender');

    const reply = await post(`/api/inbox/${promise.body.id}/reply`, {});
    expect(reply.body.status).toBe('outbox');
    expect(h.rf.state.listOutbox()[0]).toMatchObject({ recipient: other.customerEmail, status: 'outbox' });

    const samples = (await (await fetch(`${server.url}/api/inbox`)).json()) as any;
    expect(samples.samples.length).toBeGreaterThan(2);
    expect(samples.emails.length).toBe(3);

    // A mail provider's inbound webhook: off without a token, Postmark's format with one.
    expect((await post('/inbound/email', { From: other.customerEmail, TextBody: 'hi' })).status).toBe(404);
    process.env.RETROFIT_INBOUND_TOKEN = 'tok_inbound_test';
    const inbound = await post('/inbound/email?token=tok_inbound_test', {
      From: `Someone <${other.customerEmail}>`,
      Subject: 'Statement please',
      TextBody: 'Could you send me a statement of everything I owe?',
    });
    expect(inbound.body).toMatchObject({ intent: 'statement' });
  });
});
