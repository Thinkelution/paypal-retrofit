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
const mcp = async (name, args, path = '/mcp/shop') => {
  const r = await fetch(`${base}${path}`, {
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

// ---- a new invoice from one sentence, and a customer on autopay (PayPal Vault)
const draft = await post('/api/invoices/draft', {
  text: 'Invoice Maya Okafor 2 hours at $95 for retouching, due Friday',
});
const added = await post('/api/invoices', { ...draft, send: true });
console.log(`new invoice: ${added.number} for ${added.total} (${draft.engine}), PayPal ${added.paypal?.id}`);

const fern = await call('/api/customers');
const onAuto =
  fern.find((c) => c.name === 'Daniel Reyes') ?? fern.find((c) => c.openInvoices && !c.openRequests);
const autoPortal = new URL(onAuto.portalUrl).pathname;
const start = await fetch(base + autoPortal + '/autopay', {
  method: 'POST',
  body: new URLSearchParams({ max: '' }),
  redirect: 'manual',
});
const setup = start.headers.get('location').split('/').pop();
await post(`/mock-paypal/mock/api/vault/${setup}/approve`);
await fetch(`${base}${autoPortal}/autopay/return?approval_token_id=${setup}`, { redirect: 'manual' });
const charged = await post('/api/autopay/run');
console.log(
  `autopay: ${onAuto.name} saved PayPal; ${charged.filter((a) => a.status === 'executed').length} invoice(s) charged`,
);

// ---- a Brightside customer's own AI assistant pays two bills over MCP
if (bright) {
  const customers = await call(`${C}/api/customers`);
  const juniper =
    customers.find((c) => c.name === 'Juniper Street Bakery') ?? customers.find((c) => c.openInvoices >= 2);
  if (juniper?.portalUrl) {
    const mine = await mcp('my_invoices', { portal_link: juniper.portalUrl }, `${C}/mcp/shop`);
    const pick = mine.invoices
      .filter((i) => i.payableOnline)
      .slice(0, 2)
      .map((i) => i.number);
    if (pick.length) {
      const co = await mcp(
        'pay_my_invoices',
        { portal_link: juniper.portalUrl, invoices: pick, agent: 'Claude' },
        `${C}/mcp/shop`,
      );
      await post(`/mock-paypal/mock/api/orders/${co.approveUrl.split('/').pop()}/approve`);
      console.log(`brightside: ${juniper.name}'s assistant paid ${pick.join(', ')} (${co.total})`);
    }
  }
}

// ---- the sixth pass: a supplier paid with PayPal Payouts, a customer email, an assistant's plan
const bills = await call('/api/payables');
const jordan = bills.bills?.find((b) => b.number === 'B-204');
if (jordan) {
  const { results } = await post('/api/payables/pay', { pks: [jordan.pk] });
  const a = results[0]?.action;
  if (a?.status === 'pending') await post(`/api/actions/${a.id}/approve`);
  console.log(`payouts: ${jordan.number} to ${jordan.payee} (${jordan.amount}) sent through PayPal Payouts`);
}
const inbox = await call('/api/inbox');
const promise = inbox.samples.find((m) => /by Friday/.test(m.text)) ?? inbox.samples[0];
if (promise) {
  const read = await post('/api/inbox', promise);
  console.log(`inbox: ${promise.name ?? promise.from}: ${read.reading?.summary}`);
}
const fernCustomers = await call('/api/customers');
const planner = fernCustomers.find((c) => c.name === 'Hana Sato') ?? fernCustomers.find((c) => c.openInvoices);
if (planner?.portalUrl) {
  const mine = await mcp('my_invoices', { portal_link: planner.portalUrl });
  const inv = mine.invoices?.find((i) => i.payableOnline && !i.plan);
  if (inv) {
    const deal = await mcp('propose_payment_plan', {
      portal_link: planner.portalUrl,
      invoice: inv.number,
      installments: 5,
      agent: 'Claude',
    });
    console.log(`assistant plan: ${planner.name} asked 5 payments on ${inv.number}: ${deal.status}`);
  }
}
