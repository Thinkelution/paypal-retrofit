/**
 * Fernhill Studio: the "legacy" app. Server-rendered, no JavaScript, payments marked by hand.
 * paypal-retrofit never changes this code; it only reads the database and writes back the
 * columns its mapping allows.
 */
import type Database from 'better-sqlite3';
import express from 'express';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const money = (n: number | null) => (n == null ? '' : `$${Number(n).toFixed(2)}`);

/** @param base path prefix when mounted inside another app, e.g. "/fernhill" */
export function createFernhillApp(getDb: () => Database.Database, base = '') {
  const app = express.Router();
  const u = (p: string) => `${base}${p}`;

  function page(title: string, body: string) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Fernhill Studio</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;background:#f4f1ea;color:#2b2b2b;margin:0}
  header{background:#3d4a3a;color:#f4f1ea;padding:14px 16px;display:flex;flex-wrap:wrap;gap:8px 24px;align-items:baseline}
  header h1{font-size:20px;margin:0;font-weight:normal;letter-spacing:.5px}
  header a{color:#d9e0c8}
  main{max-width:1000px;margin:0 auto;padding:16px}
  .wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;background:#fff;font-size:14px}
  th,td{border:1px solid #c9c2b2;padding:6px 8px;text-align:left}
  th{background:#e7e1d3}
  .s-paid{color:#2f6b2f}.s-overdue{color:#a33}.s-void{color:#888;text-decoration:line-through}.s-draft{color:#777}
  .pp{font-family:monospace;font-size:12px;color:#335;word-break:break-all}
  button{font-family:inherit}
  .note{background:#fff8dc;border:1px solid #e0d6a8;padding:8px 12px;margin:12px 0;font-size:14px}
  @media (max-width:640px){.hide-sm{display:none}}
</style></head><body>
<header><h1>Fernhill Studio · Invoicing</h1><a href="${u('/')}">Invoices</a><a href="${u('/retainers')}">Retainers</a><a href="${u('/bills')}">Bills</a><a href="${u('/customers')}">Customers</a></header>
<main>${body}</main></body></html>`;
  }

  app.get('/', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT i.*, c.full_name FROM invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.issued_on DESC`,
      )
      .all() as any[];
    const tr = rows
      .map(
        (
          r,
        ) => `<tr><td><a href="${u(`/invoices/${r.id}`)}">${esc(r.invoice_no)}</a></td><td>${esc(r.full_name)}</td>
<td class="hide-sm">${esc(r.issued_on)}</td><td>${esc(r.due_on)}</td><td>${money(r.total)}</td>
<td class="s-${esc(r.status)}">${esc(r.status)}</td><td class="pp hide-sm">${r.paypal_invoice_id ? esc(r.paypal_invoice_id) : '—'}</td></tr>`,
      )
      .join('');
    res.send(
      page(
        'Invoices',
        `<div class="note">Payments are recorded by hand: open an invoice and press “Mark as paid” when money arrives.</div>
<div class="wrap"><table><thead><tr><th>No.</th><th>Customer</th><th class="hide-sm">Issued</th><th>Due</th><th>Total</th><th>Status</th><th class="hide-sm">PayPal</th></tr></thead><tbody>${tr}</tbody></table></div>`,
      ),
    );
  });

  app.get('/invoices/:id', (req, res) => {
    const db = getDb();
    const inv = db
      .prepare(
        `SELECT i.*, c.full_name, c.email FROM invoices i JOIN customers c ON c.id=i.customer_id WHERE i.id=?`,
      )
      .get(req.params.id) as any;
    if (!inv) return res.status(404).send(page('Not found', '<p>No such invoice.</p>'));
    const items = db.prepare(`SELECT * FROM invoice_items WHERE invoice_id=?`).all(inv.id) as any[];
    const lines = items
      .map(
        (it) =>
          `<tr><td>${esc(it.description)}</td><td>${it.quantity}</td><td>${money(it.unit_price)}</td><td>${money(it.quantity * it.unit_price)}</td></tr>`,
      )
      .join('');
    const paypal = inv.paypal_invoice_id
      ? `<p>PayPal invoice: <span class="pp">${esc(inv.paypal_invoice_id)}</span>${inv.paypal_link ? ` · <a href="${esc(inv.paypal_link)}">pay link</a>` : ''}</p>`
      : '';
    const paid = inv.paid_at ? `<p>Paid ${money(inv.paid_amount)} on ${esc(inv.paid_at)}</p>` : '';
    const action =
      inv.status === 'paid' || inv.status === 'void'
        ? ''
        : `<form method="post" action="${u(`/invoices/${inv.id}/mark-paid`)}"><button>Mark as paid</button></form>`;
    res.send(
      page(
        inv.invoice_no,
        `<h2>${esc(inv.invoice_no)} <small class="s-${esc(inv.status)}">${esc(inv.status)}</small></h2>
<p>${esc(inv.full_name)} &lt;${esc(inv.email)}&gt;<br>Issued ${esc(inv.issued_on)} · due ${esc(inv.due_on)}</p>
<div class="wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead><tbody>${lines}
<tr><th colspan="3">Total</th><th>${money(inv.total)}</th></tr></tbody></table></div>
${inv.notes ? `<p><em>${esc(inv.notes)}</em></p>` : ''}${paypal}${paid}${action}`,
      ),
    );
  });

  app.post('/invoices/:id/mark-paid', express.urlencoded({ extended: false }), (req, res) => {
    getDb()
      .prepare(`UPDATE invoices SET status='paid', paid_at=date('now'), paid_amount=total WHERE id=?`)
      .run(req.params.id);
    res.redirect(u(`/invoices/${req.params.id}`));
  });

  app.get('/retainers', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT r.*, c.full_name FROM retainers r JOIN customers c ON c.id=r.customer_id ORDER BY r.id`,
      )
      .all() as any[];
    const tr = rows
      .map(
        (r) =>
          `<tr><td>${esc(r.title)}</td><td>${esc(r.full_name)}</td><td>${money(r.monthly_fee)}/mo</td><td>${esc(r.start_date)}</td><td>${esc(r.status)}</td><td class="pp">${esc(r.paypal_subscription_id ?? '—')}</td></tr>`,
      )
      .join('');
    res.send(
      page(
        'Retainers',
        `<div class="wrap"><table><thead><tr><th>Retainer</th><th>Customer</th><th>Fee</th><th>Start</th><th>Status</th><th>PayPal</th></tr></thead><tbody>${tr}</tbody></table></div>`,
      ),
    );
  });

  app.get('/bills', (_req, res) => {
    const rows = getDb().prepare(`SELECT * FROM bills ORDER BY due_on DESC`).all() as any[];
    const tr = rows
      .map(
        (r) =>
          `<tr><td>${esc(r.bill_no)}</td><td>${esc(r.payee)}<div class="hide-sm" style="color:#777;font-size:12px">${esc(r.payee_email)}</div></td><td class="hide-sm">${esc(r.description ?? '')}</td><td>${money(r.amount)}</td><td>${esc(r.due_on ?? '')}</td><td>${esc(r.status)}${r.paid_on ? ` ${esc(r.paid_on)}` : ''}</td><td class="pp">${esc(r.payout_ref ?? '—')}</td></tr>`,
      )
      .join('');
    res.send(
      page(
        'Bills',
        `<div class="wrap"><table><thead><tr><th>Bill</th><th>Payee</th><th class="hide-sm">For</th><th>Amount</th><th>Due</th><th>Status</th><th>PayPal</th></tr></thead><tbody>${tr}</tbody></table></div>`,
      ),
    );
  });

  app.get('/customers', (_req, res) => {
    const rows = getDb().prepare(`SELECT * FROM customers ORDER BY full_name`).all() as any[];
    const tr = rows
      .map(
        (r) =>
          `<tr><td>${esc(r.full_name)}</td><td>${esc(r.email)}</td><td>${esc(r.city)}, ${esc(r.state)}</td></tr>`,
      )
      .join('');
    res.send(
      page(
        'Customers',
        `<div class="wrap"><table><thead><tr><th>Name</th><th>Email</th><th>City</th></tr></thead><tbody>${tr}</tbody></table></div>`,
      ),
    );
  });

  return app;
}
