import { afterEach, describe, expect, it } from 'vitest';
import { actionLinkSecret, ledger, signPortalToken } from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { createServer } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const h = await harness();
  cleanups.push(h.close);
  await h.rf.sync();
  const { app, stop } = createServer(h.rf);
  const server = await listen(app);
  cleanups.push(async () => {
    stop();
    await server.close();
  });
  const row = (await ledger(h.rf)).find(
    (r) => r.entity === 'invoice' && r.payLink && r.legacyState === 'open',
  )!;
  return { h, url: server.url, row };
}

describe('website widget and paper', () => {
  it('lets a customer find and pay a bill from the business website with number and email', async () => {
    const { url, row } = await setup();
    const js = await fetch(`${url}/widget.js`);
    expect(js.headers.get('access-control-allow-origin')).toBe('*');
    const src = await js.text();
    expect(src).toContain(JSON.stringify(url));
    expect(src).toContain('Pay a bill');
    const llms = await (await fetch(`${url}/llms.txt`)).text();
    expect(llms).toMatch(/^# Fernhill Studio/);
    expect(llms).toContain(`${url}/mcp/shop`);
    expect(llms).toContain('pay_my_invoices');

    const lookup = (number: string, email: string) =>
      fetch(`${url}/widget/lookup`, { method: 'POST', body: new URLSearchParams({ number, email }) });
    expect((await lookup(row.number, 'someone.else@example.com')).status).toBe(404);
    const ok = await lookup(row.number, row.customerEmail.toUpperCase());
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    const body: any = await ok.json();
    expect(body.invoice).toMatchObject({ number: row.number, paid: false, payLink: row.payLink });
    expect(body.portalUrl).toMatch(/\/p\/.+/);

    const pay = await fetch(`${url}/pay`, {
      method: 'POST',
      body: new URLSearchParams({ number: row.number, email: row.customerEmail }),
      redirect: 'manual',
    });
    expect(pay.status).toBe(303);
    expect(pay.headers.get('location')).toBe(row.payLink);

    const catalog: any = await (await fetch(`${url}/widget/catalog`)).json();
    expect(catalog).toMatchObject({ enabled: false, items: [] });

    // Guessing is rate limited.
    let last = 0;
    for (let i = 0; i < 20; i++) last = (await lookup(`INV-${9000 + i}`, 'x@example.com')).status;
    expect(last).toBe(429);
  });

  it('walks the owner from the simulator towards live with a checklist that checks what really happened', async () => {
    const { h, url, row } = await setup();
    const get = async () => (await (await fetch(`${url}/api/golive`)).json()) as any;
    const before = await get();
    const by = (g: any, id: string) => g.checks.find((c: any) => c.id === id);
    expect(before.stage).toBe('simulator');
    expect(by(before, 'data').status).toBe('done');
    expect(by(before, 'paypal')).toMatchObject({ status: 'todo' });
    expect(by(before, 'sync').status).toBe('done');
    expect(by(before, 'payment')).toMatchObject({
      status: 'todo',
      fix: { how: [expect.stringContaining('/mock/invoice/')] },
    });

    await h.mock.payInvoice(row.paypalId!);
    await new Promise((r) => setTimeout(r, 300));
    const after = await get();
    expect(by(after, 'payment').status).toBe('done');
    expect(by(after, 'webhooks').status).toBe('done');
    expect(by(after, 'writeback')).toMatchObject({ status: 'done' });
    expect(after.done).toBeGreaterThan(before.done);
    const reg = await fetch(`${url}/api/golive/webhook`, { method: 'POST' });
    expect(((await reg.json()) as any).events).toBe(19);
  });

  it('prints PayPal QR codes on pay slips and statements', async () => {
    const { h, url, row } = await setup();
    const qr = await fetch(`${url}/api/invoices/${row.legacyPk}/qr.png`);
    expect(qr.headers.get('x-qr-source')).toBe('paypal');
    const png = Buffer.from(await qr.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const slip = await (await fetch(`${url}/api/invoices/${row.legacyPk}/slip`)).text();
    expect(slip).toContain(`Invoice ${row.number}`);
    expect(slip).toContain('qr.png');

    const customer = (await h.rf.invoice(row.legacyPk)).customerPk;
    const token = signPortalToken(actionLinkSecret(h.rf), customer);
    const statement = await (await fetch(`${url}/p/${token}/statement`)).text();
    expect(statement).toContain('data:image/png;base64,');
  });
});
