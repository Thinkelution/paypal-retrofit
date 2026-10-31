import { afterEach, describe, expect, it } from 'vitest';
import { ledger } from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { createServer } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(50);
  }
}

describe('dispute evidence autopilot', () => {
  it('drafts from the records, waits for the owner, then sends PayPal the evidence with a PDF', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const h = await harness();
    cleanups.push(h.close);
    // Even an owner who lets everything run on its own still approves dispute evidence.
    h.rf.mapping.policies = { ...h.rf.mapping.policies, submit_dispute_evidence: 'auto' };
    await h.rf.sync();
    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(server.url + p, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await r.json()) as any;
    };
    const mock = async (p: string, body: unknown = {}) =>
      (await (
        await fetch(h.mockUrl + p, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as any;

    const [row, other] = (await ledger(h.rf)).filter(
      (r) => r.entity === 'invoice' && r.paypalStatus === 'SENT',
    );
    await h.mock.payInvoice(row!.paypalId!);
    await h.mock.payInvoice(other!.paypalId!);
    await sleep(300);

    // 1. The buyer opens a dispute; the webhook starts the autopilot.
    const opened = await mock(`/mock/api/invoices/${row!.paypalId}/dispute`, {
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      message: 'I never got the photos.',
    });
    const id = opened.dispute_id as string;
    const c = await until(() => {
      const x = h.rf.state.getDisputeCase(id);
      return x?.status === 'proposed' && x;
    });
    expect(c).toMatchObject({ legacyPk: row!.legacyPk, engine: 'records' });
    expect(c.draft).toMatchObject({
      recommendation: 'contest',
      evidenceType: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED',
    });
    expect(c.draft!.response).toContain(row!.number);
    expect(c.draft!.response).not.toMatch(/delivered as agreed/i); // the records don't show delivery
    expect(c.draft!.missing.join(' ')).toMatch(/delivered/);
    const first = h.rf.state.getAction(c.actionId!)!;
    expect(first).toMatchObject({ kind: 'submit_dispute_evidence', status: 'pending', origin: 'sync' });
    expect(first.policyReason).toMatch(/always waits for your OK/);

    const list = await call('GET', '/api/disputes');
    expect(list.disputes.find((d: any) => d.disputeId === id)).toMatchObject({
      number: row!.number,
      case: { status: 'proposed' },
      action: { status: 'pending' },
    });
    const view = await call('GET', `/api/disputes/${id}`);
    expect(view.pack).toMatchObject({ channel: 'evidence', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED' });
    expect(view.pack.facts.map((f: any) => f.item)).toEqual(
      expect.arrayContaining([`Invoice ${row!.number} issued`, 'Paid through PayPal']),
    );
    expect(view.pack.buyerSays).toEqual(['I never got the photos.']);

    const pdf = Buffer.from(
      await (await fetch(`${server.url}/api/disputes/${id}/evidence.pdf`)).arrayBuffer(),
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain(`Invoice ${row!.number}`);

    // 2. The owner adds what the records lack; the edited response replaces the first proposal.
    const response = `${c.draft!.response}\nWe delivered the gallery link by email on the day of the shoot; a copy is attached.`;
    const edited = await call('POST', `/api/disputes/${id}/evidence`, { response });
    expect(edited).toMatchObject({ status: 'proposed', draft: { response } });
    expect(h.rf.state.getAction(c.actionId!)!.status).toBe('rejected');

    // 3. Approved: PayPal gets the notes and the PDF; the dispute moves to review.
    const approved = await h.rf.approve(edited.actionId);
    expect(approved.status).toBe('executed');
    expect(approved.result).toMatchObject({
      via: 'provide-evidence',
      document: { name: `${id}-evidence.pdf` },
    });
    const pp = h.mock.state().disputes[id];
    expect(pp.status).toBe('UNDER_REVIEW');
    expect(pp.evidences[0]).toMatchObject({
      evidence_type: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED',
      notes: response,
      source: 'SUBMITTED_BY_SELLER',
    });
    const sent = Buffer.from(await (await fetch(pp.evidences[0].documents[0].url)).arrayBuffer()).toString(
      'latin1',
    );
    expect(sent.startsWith('%PDF-')).toBe(true);
    expect(sent).toContain('gallery link');
    expect(h.rf.state.getDisputeCase(id)!.status).toBe('submitted');
    await until(() =>
      h.rf.state.listDiscrepancies().find((d) => d.paypalId === id && /under review/.test(d.detail)),
    );

    // 4. PayPal decides for the seller; the dispute closes in retrofit.
    await mock(`/mock/api/disputes/${id}/resolve`, { outcome: 'seller' });
    const closed = await until(() =>
      h.rf.state.listDiscrepancies(true).find((d) => d.paypalId === id && d.resolvedAt),
    );
    expect(closed.resolution).toMatch(/RESOLVED_SELLER_FAVOUR/);

    // A customer who complained by email first gets a suggestion to settle, not a contest.
    await call('POST', '/api/inbox', {
      from: other!.customerEmail,
      subject: `Problem with ${other!.number}`,
      text: `Half of the edited images for ${other!.number} are missing and two are wrong.`,
    });
    const second = (await mock(`/mock/api/invoices/${other!.paypalId}/dispute`)).dispute_id as string;
    const settle = await until(() => {
      const x = h.rf.state.getDisputeCase(second);
      return x?.status === 'ready' && x;
    });
    expect(settle.draft).toMatchObject({ recommendation: 'offer_partial_refund' });
    expect(settle.actionId).toBeNull();
    expect(settle.draft!.reasoning).toMatch(/raised a problem by email/);
  });
});
