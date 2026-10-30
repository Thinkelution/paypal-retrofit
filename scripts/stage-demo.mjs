#!/usr/bin/env node
/**
 * Puts a running mock demo into a lived-in state for screenshots and video takes:
 * reset → sync → three customers pay → collections playbook queued → INV-1038 on a 2-part plan with
 * the first instalment paid → a buyer dispute on INV-1020.
 *
 *   pnpm retrofit demo --fresh        # in another terminal
 *   node scripts/stage-demo.mjs [baseUrl]
 */
const before = process.argv.includes('--before-collections');
const base = (process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'http://localhost:8787').replace(
  /\/$/,
  '',
);
const J = { 'content-type': 'application/json' };
const call = async (path, init) => {
  const r = await fetch(base + path, init);
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
};
const post = (path, body = {}) => call(path, { method: 'POST', headers: J, body: JSON.stringify(body) });

await post('/api/demo/reset');
await post('/api/sync/run');
let ledger = await call('/api/ledger');
const id = (n) => ledger.find((r) => r.number === n);
for (const n of ['INV-1020', 'INV-1031', 'INV-1044'])
  await post(`/mock-paypal/mock/api/invoices/${id(n).paypalId}/pay`);

if (before) {
  console.log('staged up to the collections run');
  process.exit(0);
}
const run = await post('/api/collections/run', { ai: true });
console.log(`collections: ${run.proposed.length} proposed (${run.writer} text)`);
const offer = run.proposed.find((p) => p.action.kind === 'offer_payment_plan');
if (offer) {
  const a = await post(`/api/actions/${offer.action.id}/approve`);
  if (a.status === 'scheduled') await post(`/api/actions/${offer.action.id}/run-now`);
  ledger = await call('/api/ledger');
  const plan = id('INV-1038');
  await post(`/mock-paypal/mock/api/invoices/${plan.paypalId}/pay?amount=290`);
}
await post('/api/demo/dispute', { legacyPk: id('INV-1020').legacyPk });
const s = await call('/api/summary');
console.log(
  `staged: ${s.paidViaPayPal} paid via PayPal, ${s.pendingActions} awaiting approval, ${s.activePlans} plan, ${s.discrepancies} discrepancy, ${s.expectedNext30} expected in 30 days`,
);

// ---- the rest of the platform: a buyer agent's order, and the second client (Brightside Plumbing)
const mcp = async (name, args) => {
  const r = await fetch(`${base}/mcp/shop`, {
    method: 'POST',
    headers: { ...J, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return JSON.parse((await r.json()).result.content[0].text);
};
const found = await mcp('search_catalog', { query: 'portrait' });
if (found.products?.length) {
  const co = await mcp('create_checkout', {
    items: [{ productId: found.products[0].id, quantity: 1 }],
    buyer: { name: 'Ana Ruiz', email: 'ana@example.com' },
    agent: 'Claude',
  });
  await post(`/mock-paypal/mock/api/orders/${co.approveUrl.split('/').pop()}/approve`);
  console.log(`buyer agent: ${co.checkoutId} for ${co.total} approved at PayPal`);
}

const C = '/c/brightside';
const bright = await call(`${C}/api/collections/run`, {
  method: 'POST',
  headers: J,
  body: JSON.stringify({ ai: false }),
}).catch(() => null);
if (bright) {
  console.log(
    `brightside: ${bright.proposed.length} collections actions, ${bright.terms.length} late fees / discount changes`,
  );
  const customers = await call(`${C}/api/customers`);
  const portal = (name) => new URL(customers.find((c) => c.name === name).portalUrl).pathname;
  // One customer pays two invoices at once from their portal.
  const payer = portal('Grand Lake Theater Cafe');
  const html = await (await fetch(base + payer)).text();
  const ids = [...html.matchAll(/name="invoice" value="([^"]+)" data-amount/g)].map((m) => m[1]);
  const pay = await fetch(base + payer + '/pay', {
    method: 'POST',
    body: new URLSearchParams(ids.map((i) => ['invoice', i])),
    redirect: 'manual',
  });
  const order = pay.headers.get('location').split('/').pop();
  await post(`/mock-paypal/mock/api/orders/${order}/approve`);
  // Another promises a date and asks to split a bill.
  const asker = portal('Rockridge Florist');
  const first = (await (await fetch(base + asker)).text()).match(/name="invoice" value="([^"]+)"/)[1];
  const req = (body) =>
    fetch(base + asker + '/request', {
      method: 'POST',
      body: new URLSearchParams({ invoice: first, ...body }),
      redirect: 'manual',
    });
  await req({ kind: 'promise', date: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10) });
  await req({ kind: 'question', message: 'Was the second visit included in the quote?' });
  console.log('brightside: one portal payment for two invoices, a promise and a question');
}
