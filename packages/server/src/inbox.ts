import { readCustomerEmail } from '@paypal-retrofit/agents';
import {
  actOnEmail,
  buildStatement,
  inboxContext,
  listCustomers,
  sendInboxReply,
  type InboundEmail,
  type Retrofit,
} from '@paypal-retrofit/core';
import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';

/** Reads one customer email and acts on it: requests filed, money actions proposed for the owner. */
export async function takeEmail(rf: Retrofit, email: InboundEmail) {
  const id = rf.state.addInbox({
    sender: email.from,
    senderName: email.name ?? null,
    subject: email.subject ?? null,
    body: email.text,
  });
  const ctx = await inboxContext(rf, email);
  const reading = await readCustomerEmail(email, ctx);
  return actOnEmail(rf, id, reading, ctx);
}

/** "Maya Okafor <maya@example.com>" → { name, email }. */
function address(v: unknown) {
  const s = String(v ?? '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1]!.trim() || undefined, email: m[2]!.trim() } : { name: undefined, email: s };
}

/** Console routes under /api/inbox. */
export function inboxRoutes(rf: Retrofit) {
  const r = express.Router();
  r.get('/inbox', async (_req, res) => {
    // Sample emails from real customers with open invoices, so the inbox can be tried in the demo.
    const customers = (await listCustomers(rf)).filter((c) => c.openInvoices > 0).slice(0, 4);
    const samples = [];
    for (const [i, c] of customers.entries()) {
      const s = await buildStatement(rf, c.pk);
      const inv = s.lines[0];
      if (!inv) continue;
      const first = c.name.split(/\s+/)[0];
      samples.push(
        [
          {
            subject: `Re: Invoice ${inv.number}`,
            text: `Hi, sorry for the delay on ${inv.number}. Things have been hectic; I'll pay it by Friday.\n\n${first}`,
          },
          {
            subject: `Payment for ${inv.number}`,
            text: `Hello, just to let you know I posted a cheque for $${inv.balance.toFixed(2)} on Monday for invoice ${inv.number}.\n\nThanks, ${first}`,
          },
          {
            subject: `Question about ${inv.number}`,
            text: `Hi there, could I split ${inv.number} into three payments? Money is a bit tight this month.\n\n${first}`,
          },
          {
            subject: 'Statement please',
            text: `Hi, could you send me a statement of everything I owe at the moment? Thanks, ${first}`,
          },
        ][i % 4]!,
      );
      samples[samples.length - 1] = { from: c.email, name: c.name, ...samples[samples.length - 1]! } as any;
    }
    res.json({ emails: rf.state.listInbox(100), samples });
  });
  r.post('/inbox', async (req: Request, res: Response) => {
    const b = req.body ?? {};
    const from = address(b.from);
    const text = String(b.text ?? '').trim();
    if (!from.email || !text)
      return res.status(422).json({ error: 'An email needs a sender and some text.' });
    try {
      res.json(
        await takeEmail(rf, {
          from: from.email,
          name: b.name ?? from.name,
          subject: b.subject ? String(b.subject).slice(0, 300) : undefined,
          text: text.slice(0, 20000),
        }),
      );
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  r.post('/inbox/:id/reply', async (req, res) => {
    try {
      res.json(await sendInboxReply(rf, Number(req.params.id), req.body?.text));
    } catch (e) {
      res.status(422).json({ error: (e as Error).message });
    }
  });
  return r;
}

/**
 * Public inbound-email webhook, for a mail provider's "inbound parse" (Postmark, Mailgun or any JSON with
 * from / subject / text). Off unless RETROFIT_INBOUND_TOKEN is set; the token goes in ?token=.
 */
export function inboundRouter(rf: Retrofit) {
  const r = express.Router();
  r.post(
    '/inbound/email',
    express.json({ limit: '2mb' }),
    express.urlencoded({ extended: false, limit: '2mb' }),
    async (req, res) => {
      const token = process.env.RETROFIT_INBOUND_TOKEN;
      const given = String(req.query.token ?? '');
      if (
        !token ||
        given.length !== token.length ||
        !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token))
      )
        return res.status(404).json({ error: 'Not found' });
      const b = req.body ?? {};
      const from = address(b.From ?? b.from ?? b.sender);
      const text = String(b.TextBody ?? b['stripped-text'] ?? b['body-plain'] ?? b.text ?? '').trim();
      if (!from.email || !text) return res.status(422).json({ error: 'No sender or text' });
      const done = await takeEmail(rf, {
        from: from.email,
        name: b.FromName ?? from.name,
        subject: String(b.Subject ?? b.subject ?? '').slice(0, 300) || undefined,
        text: text.slice(0, 20000),
      });
      res.json({ id: done.id, status: done.status, intent: done.reading?.intent });
    },
  );
  return r;
}
