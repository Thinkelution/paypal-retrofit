/**
 * Live PayPal sandbox smoke test. Creates a one-invoice legacy database, syncs it to the sandbox, records
 * an external payment, reconciles, and checks the legacy row is paid.
 *
 *   PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... SMOKE_RECIPIENT=<sandbox buyer email> pnpm smoke:sandbox
 */
import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  heuristicMapping,
  openSource,
  reconcile,
  resolveEnv,
  Retrofit,
  validateMapping,
  type ResolvedConfig,
} from '@paypal-retrofit/core';

const step = (m: string) => console.log(`\n▶ ${m}`);
const fail = (m: string) => {
  console.error(`✘ ${m}`);
  process.exit(1);
};

if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)
  fail('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app).');
process.env.PAYPAL_ENVIRONMENT = 'SANDBOX';
process.env.RETROFIT_AUTO_APPROVE = '1';
const recipient = process.env.SMOKE_RECIPIENT ?? 'sandbox-buyer@example.com';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-smoke-'));
const dbFile = path.join(dir, 'smoke.db');
const db = new Database(dbFile);
const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
db.exec(`
CREATE TABLE customers (id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, email TEXT NOT NULL);
CREATE TABLE invoices (id INTEGER PRIMARY KEY, invoice_no TEXT NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id), due_on TEXT, status TEXT NOT NULL, total REAL NOT NULL, paypal_invoice_id TEXT, paypal_link TEXT, paid_at TEXT, paid_amount REAL);
CREATE TABLE invoice_items (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id), description TEXT NOT NULL, quantity REAL NOT NULL, unit_price REAL NOT NULL);
`);
const number = `SMOKE-${Date.now().toString(36).toUpperCase()}`;
db.prepare(`INSERT INTO customers VALUES (1, 'Smoke Test Buyer', ?)`).run(recipient);
db.prepare(
  `INSERT INTO invoices (id, invoice_no, customer_id, due_on, status, total) VALUES (1, ?, 1, ?, 'sent', 12.5)`,
).run(number, due);
db.prepare(`INSERT INTO invoice_items VALUES (1, 1, 'paypal-retrofit smoke test', 1, 12.5)`).run();
db.close();

const source = openSource(`sqlite:${dbFile}`);
const schema = await source.introspect();
const { mapping, issues } = validateMapping(heuristicMapping(schema), schema);
if (issues.some((i) => i.level === 'error')) fail(`mapping: ${JSON.stringify(issues)}`);
const config: ResolvedConfig = {
  source: `sqlite:${dbFile}`,
  mapping: path.join(dir, 'map.json'),
  state: path.join(dir, 'state.db'),
  business: { name: 'paypal-retrofit smoke test' },
  paypal: { invoicePrefix: '' },
  webhook: {},
  sync: { intervalSeconds: 60 },
  baseDir: dir,
  configPath: path.join(dir, 'retrofit.config.yaml'),
  env: resolveEnv(),
};
const rf = new Retrofit(config, { source, mapping });

step('OAuth token');
await rf.paypal.accessToken();
console.log('  ok');

step(`sync ${number}`);
const report = await rf.sync();
for (const r of report.results)
  console.log(`  ${r.item.kind}: ${r.action.status} ${JSON.stringify(r.action.result)}`);
const link = rf.state.getLink('invoice', '1');
if (!link) fail('invoice was not created');
console.log(`  PayPal ${link!.paypalId} status ${link!.paypalStatus} pay link ${link!.payLink}`);

step('record external payment');
const pay = await rf.propose({
  origin: 'cli',
  kind: 'record_payment',
  target: { entity: 'invoice', legacyPk: '1', label: number },
  payload: { amount: 12.5, method: 'BANK_TRANSFER' },
  reason: 'smoke test',
});
console.log(`  ${pay.status} ${JSON.stringify(pay.result)}`);

step('reconcile');
const rec = await reconcile(rf);
console.log(`  checked ${rec.checked}, fixed ${rec.fixed.length}, errors ${rec.errors.length}`);
const row = (await rf.source.readTable('invoices'))[0]!;
console.log(
  `  legacy row: status=${row.status} paypal_invoice_id=${row.paypal_invoice_id} paid_amount=${row.paid_amount}`,
);
await rf.close();
if (row.status !== 'paid') fail('legacy invoice is not paid');
console.log('\n✔ sandbox smoke test passed');
