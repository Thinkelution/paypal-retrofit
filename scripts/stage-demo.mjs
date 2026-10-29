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
