import {
  actionLinkSecret,
  buildStatement,
  createCheckout,
  finalizeCheckout,
  formatMoney,
  loadCatalog,
  renderStatement,
  signPortalToken,
  verifyPortalToken,
  type Retrofit,
  type Statement,
} from '@paypal-retrofit/core';
import express, { type Request, type Response } from 'express';

/**
 * Public, customer-facing pages: the customer portal (one signed link per customer) and the shop.
 * Both are plain server-rendered HTML so they work in any mail client's browser and need no login.
 */

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const CSS = `:root{--bg:#eef1f5;--card:#fff;--ink:#14171f;--muted:#5b6475;--line:#e3e6ec;--soft:#f5f7fa;--accent:#2a78d6;--ok:#1d7a4a;--bad:#b42318;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--ink:#e8ebf1;--muted:#9aa3b5;--line:#2a303c;--soft:#1e2430;--accent:#3987e5;--ok:#4cc38a;--bad:#f97066;--warn:#e3b341}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px 16px}
main{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:var(--card);border-radius:12px;padding:20px;border:1px solid var(--line)}
.top{border-top:4px solid var(--accent)}h1{font-size:24px;margin:4px 0 6px}h2{font-size:15px;margin:0 0 10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.muted{color:var(--muted)}.small{font-size:13px}.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:14px}
.kpi{background:var(--soft);border-radius:8px;padding:10px 12px}.kpi b{display:block;font-size:20px}.bad{color:var(--bad)}.ok{color:var(--ok)}
.inv{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 12px;align-items:start;padding:12px 0;border-top:1px solid var(--line)}
.inv:first-of-type{border-top:0}.inv input[type=checkbox]{width:18px;height:18px;margin-top:3px}.amt{font-weight:700;text-align:right;white-space:nowrap}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--soft);color:var(--muted);margin-left:6px}.tag.bad{color:var(--bad)}
details{grid-column:2 / 4;font-size:14px}summary{cursor:pointer;color:var(--accent)}details form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
input,select,textarea{font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 10px;min-width:0}textarea{width:100%;min-height:70px}
button,.btn{font:inherit;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer;text-decoration:none;display:inline-block}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.spacer{flex:1}
.banner{padding:10px 12px;border-radius:8px;background:var(--soft)}.banner.ok{color:var(--ok)}.banner.bad{color:var(--bad)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}.prod{border:1px solid var(--line);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:6px}
.prod b{font-size:16px}.prod .price{font-size:18px;font-weight:700}a{color:var(--accent)}footer{text-align:center;font-size:12px;color:var(--muted)}
@media (max-width:560px){.kpis{grid-template-columns:minmax(0,1fr)}}`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main>${body}<footer>Payments are processed by PayPal. Powered by paypal-retrofit.</footer></main></body></html>`;

export interface PublicContext {
  /** Absolute base URL of this workspace (for PayPal return URLs). */
  base: (req: Request) => string;
}

const FLASH: Record<string, [string, string]> = {
  promise: ['ok', 'Thank you. We have noted the date and will not chase you before then.'],
  plan: ['ok', 'Thank you. We will look at your request and send you a payment plan.'],
  question: ['ok', 'Thank you. Your question is with us; we will reply by email.'],
  paid: ['ok', 'Payment received. Thank you!'],
  cancelled: ['', 'Payment cancelled. Nothing was charged.'],
};

function portalHtml(rf: Retrofit, s: Statement, token: string, flash?: string, error?: string) {
  const m = (n: number) => formatMoney(n, s.currency);
  const requests = rf.state.listRequests({ status: 'open', customerPk: s.customer.pk });
  const pending = (pk: string) => requests.filter((r) => r.legacyPk === pk);
  const banner = error
    ? `<div class="banner bad">${esc(error)}</div>`
    : flash && FLASH[flash]
      ? `<div class="banner ${FLASH[flash]![0]}">${esc(FLASH[flash]![1])}</div>`
      : '';
  const payable = s.lines.filter((l) => l.inPayPal);
  const today = s.asOf;
  const rows = s.lines
    .map((l) => {
      const reqs = pending(l.legacyPk);
      const tags = [
        l.daysOverdue
          ? `<span class="tag bad">${l.daysOverdue} days overdue</span>`
          : '<span class="tag">not due yet</span>',
        l.onPlan ? '<span class="tag">payment plan</span>' : '',
        ...reqs.map(
          (r) =>
            `<span class="tag">${r.kind === 'promise' ? `you said you'd pay by ${esc(r.until)}` : r.kind === 'plan' ? 'plan requested' : 'question sent'}</span>`,
        ),
      ].join('');
      return `<div class="inv">
<input type="checkbox" name="invoice" value="${esc(l.legacyPk)}" data-amount="${l.balance}" form="payform" ${l.inPayPal ? 'checked' : 'disabled'} aria-label="Pay ${esc(l.number)}">
<div><b>${esc(l.number)}</b>${tags}<div class="muted small">${l.issued ? `Issued ${esc(l.issued)} · ` : ''}due ${esc(l.due ?? '—')}${l.adjustments ? ` · includes ${esc(m(l.adjustments))} ${l.adjustments > 0 ? 'late fee' : 'early-payment discount'}` : ''}${l.payLink ? ` · <a href="${esc(l.payLink)}">pay just this one</a>` : ''}</div></div>
<div class="amt">${esc(m(l.balance))}</div>
<details><summary>Need more time, want to pay in parts, or have a question?</summary>
<form method="post" action="request"><input type="hidden" name="invoice" value="${esc(l.legacyPk)}"><input type="hidden" name="kind" value="promise"><label>I'll pay by <input type="date" name="date" min="${esc(today)}" required></label><button>Tell ${esc(s.business)}</button></form>
<form method="post" action="request"><input type="hidden" name="invoice" value="${esc(l.legacyPk)}"><input type="hidden" name="kind" value="plan"><label>Pay in <select name="installments"><option>2</option><option>3</option><option>4</option></select> parts</label><button>Ask for a payment plan</button></form>
<form method="post" action="request" style="display:block"><input type="hidden" name="invoice" value="${esc(l.legacyPk)}"><input type="hidden" name="kind" value="question"><textarea name="message" maxlength="1000" placeholder="Something wrong with this invoice? Tell us." required></textarea><button style="margin-top:6px">Send question</button></form>
</details></div>`;
    })
    .join('');
  const payments = s.payments
    .slice(0, 8)
    .map(
      (p) =>
        `<div class="row small"><span>${esc(p.date)} · ${esc(p.number)} · ${esc(p.method)}</span><span class="spacer"></span><b>${esc(m(p.amount))}</b></div>`,
    )
    .join('');
  return page(
    `${s.business} · your invoices`,
    `${banner}<section class="card top"><div class="muted small">${esc(s.business)}</div><h1>Hi ${esc(s.customer.name)}</h1>
<div class="muted">Everything open with us as of ${esc(s.asOf)}.</div>
<div class="kpis"><div class="kpi"><span class="muted small">Open balance</span><b>${esc(m(s.totals.balance))}</b></div><div class="kpi"><span class="muted small">Overdue</span><b class="${s.totals.overdue ? 'bad' : ''}">${esc(m(s.totals.overdue))}</b></div><div class="kpi"><span class="muted small">Invoices</span><b>${s.lines.length}</b></div></div></section>
<section class="card"><h2>Open invoices</h2>${rows || '<p class="ok">Nothing is open. Thank you!</p>'}
${payable.length ? `<form id="payform" method="post" action="pay" class="row" style="margin-top:14px"><span class="muted">Selected: <b id="sel">${esc(m(payable.reduce((t, l) => t + l.balance, 0)))}</b></span><span class="spacer"></span><a class="btn" href="statement">Statement</a><button class="primary">Pay selected with PayPal</button></form>` : `<div class="row" style="margin-top:14px"><span class="spacer"></span><a class="btn" href="statement">Statement</a></div>`}</section>
${payments ? `<section class="card"><h2>Received, thank you</h2>${payments}</section>` : ''}
<script>(()=>{const f=new Intl.NumberFormat('en-US',{style:'currency',currency:${JSON.stringify(s.currency)}});const boxes=[...document.querySelectorAll('input[name=invoice][type=checkbox]')];const out=document.getElementById('sel');const upd=()=>{if(out)out.textContent=f.format(boxes.filter(b=>b.checked).reduce((t,b)=>t+Number(b.dataset.amount),0))};boxes.forEach(b=>b.addEventListener('change',upd));})();</script>`,
  )
    .replace(/action="(request|pay)"/g, `action="${esc(token)}/$1"`)
    .replace(/href="statement"/g, `href="${esc(token)}/statement"`);
}

/** /p/:token — the customer portal. */
export function portalRouter(rf: Retrofit, ctx: PublicContext) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));
  // Redirects are absolute: the router may be mounted under /c/<client>.
  const who = (token: string) => verifyPortalToken(actionLinkSecret(rf), token);
  const fail = (res: Response, msg: string, status = 400) =>
    res
      .status(status)
      .type('html')
      .send(
        page(
          'Link not valid',
          `<section class="card top"><h1>Link not valid</h1><p class="muted">${esc(msg)}</p></section>`,
        ),
      );

  r.get('/:token', async (req, res) => {
    const v = who(req.params.token!);
    if ('error' in v) return fail(res, v.error);
    try {
      const s = await buildStatement(rf, v.customerPk);
      res
        .type('html')
        .send(
          portalHtml(
            rf,
            s,
            req.params.token!,
            String(req.query.done ?? ''),
            req.query.error ? String(req.query.error) : undefined,
          ),
        );
    } catch (e) {
      fail(res, (e as Error).message, 404);
    }
  });

  r.get('/:token/statement', async (req, res) => {
    const v = who(req.params.token!);
    if ('error' in v) return fail(res, v.error);
    const s = await buildStatement(rf, v.customerPk);
    res.type('html').send(renderStatement(s, { portalUrl: `${ctx.base(req)}/p/${req.params.token}` }).html);
  });

  r.post('/:token/pay', async (req, res) => {
    const v = who(req.params.token!);
    if ('error' in v) return fail(res, v.error);
    const invoices = ([] as string[]).concat(req.body?.invoice ?? []).map(String);
    try {
      const base = ctx.base(req);
      const order = await createCheckout(rf, {
        channel: 'portal',
        invoices,
        customerPk: v.customerPk,
        returnUrl: `${base}/checkout/return`,
        cancelUrl: `${base}/p/${req.params.token}?done=cancelled`,
      });
      if (!order.approveUrl) throw new Error('PayPal did not return an approval link');
      res.redirect(303, order.approveUrl);
    } catch (e) {
      res.redirect(
        303,
        `${req.baseUrl}/${req.params.token}?error=${encodeURIComponent((e as Error).message)}`,
      );
    }
  });

  r.post('/:token/request', async (req, res) => {
    const v = who(req.params.token!);
    if ('error' in v) return fail(res, v.error);
    const kind = String(req.body?.kind);
    const legacyPk = String(req.body?.invoice ?? '');
    const s = await buildStatement(rf, v.customerPk);
    const line = s.lines.find((l) => l.legacyPk === legacyPk);
    if (!line || !['promise', 'plan', 'question'].includes(kind))
      return res.redirect(
        303,
        `${req.baseUrl}/${req.params.token}?error=${encodeURIComponent('That invoice is not open')}`,
      );
    const date = String(req.body?.date ?? '');
    if (kind === 'promise' && !/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.redirect(
        303,
        `${req.baseUrl}/${req.params.token}?error=${encodeURIComponent('Choose a date')}`,
      );
    const installments = Math.min(4, Math.max(2, Number(req.body?.installments ?? 2) || 2));
    rf.state.addRequest({
      customerPk: v.customerPk,
      legacyPk,
      kind: kind as 'promise' | 'plan' | 'question',
      detail: kind === 'question' ? String(req.body?.message ?? '').slice(0, 1000) : null,
      until: kind === 'promise' ? date : null,
      installments: kind === 'plan' ? installments : null,
    });
    if (kind === 'plan' && line.inPayPal && !line.onPlan) {
      // Put it in front of the owner straight away; their policy decides (confirm by default).
      await rf
        .propose({
          origin: 'portal',
          kind: 'offer_payment_plan',
          target: { entity: 'invoice', legacyPk, label: line.number },
          payload: { installments, intervalDays: 14, amount: line.balance },
          reason: `${s.customer.name} asked in the portal to pay ${line.number} in ${installments} parts`,
        })
        .catch((e) => rf.log.warn(`portal plan request: ${(e as Error).message}`));
    }
    rf.emit('request', { customerPk: v.customerPk, kind });
    res.redirect(303, `${req.baseUrl}/${req.params.token}?done=${kind}`);
  });

  return r;
}

/** /shop — catalogue page and checkout for new buyers; /checkout/* — PayPal return URLs. */
export function shopRouter(rf: Retrofit, ctx: PublicContext) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  r.get('/shop/catalog.json', async (req, res) => {
    const c = rf.mapping.commerce;
    res.json({
      business: rf.config.business.name,
      description: c.description ?? null,
      enabled: c.enabled,
      currency: rf.mapping.currency,
      maxOrderTotal: c.maxOrderTotal,
      products: c.enabled ? await loadCatalog(rf) : [],
      checkout: c.enabled ? `${ctx.base(req)}/shop/checkout` : null,
      mcp: c.enabled ? `${ctx.base(req)}/mcp/shop` : null,
    });
  });

  r.get('/shop', async (req, res) => {
    const c = rf.mapping.commerce;
    if (!c.enabled)
      return res
        .status(404)
        .type('html')
        .send(
          page(
            'Shop closed',
            `<section class="card top"><h1>${esc(rf.config.business.name)}</h1><p class="muted">Online ordering is not open.</p></section>`,
          ),
        );
    const items = await loadCatalog(rf);
    const m = (n: number) => formatMoney(n, rf.mapping.currency);
    const err = req.query.error ? `<div class="banner bad">${esc(req.query.error)}</div>` : '';
    res.type('html').send(
      page(
        `${rf.config.business.name} · shop`,
        `${err}<section class="card top"><div class="muted small">Order online</div><h1>${esc(rf.config.business.name)}</h1>${c.description ? `<p class="muted">${esc(c.description)}</p>` : ''}
<p class="muted small">AI shopping agents can use <code>${esc(ctx.base(req))}/mcp/shop</code> (MCP) or <a href="shop/catalog.json">catalog.json</a>.</p></section>
<form method="post" action="shop/checkout" class="card"><h2>Services</h2><div class="grid">${items
          .map(
            (p) =>
              `<div class="prod"><b>${esc(p.name)}</b><span class="muted small">${esc(p.description ?? '')}</span><span class="price">${esc(m(p.price))}</span><label class="small">Quantity <input type="number" name="qty_${esc(p.id)}" min="0" max="${c.maxQuantity}" value="0" style="width:80px"></label></div>`,
          )
          .join('')}</div>
<div class="row" style="margin-top:16px"><input name="name" placeholder="Your name" required><input name="email" type="email" placeholder="Email for the receipt" required><span class="spacer"></span><button class="primary">Buy with PayPal</button></div></form>`,
      )
        .replace('href="shop/catalog.json"', `href="${esc(req.baseUrl)}/shop/catalog.json"`)
        .replace('action="shop/checkout"', `action="${esc(req.baseUrl)}/shop/checkout"`),
    );
  });

  r.post('/shop/checkout', async (req, res) => {
    const items = Object.entries(req.body ?? {})
      .filter(([k, v]) => k.startsWith('qty_') && Number(v) > 0)
      .map(([k, v]) => ({ productId: k.slice(4), quantity: Number(v) }));
    try {
      const base = ctx.base(req);
      const order = await createCheckout(rf, {
        channel: 'shop',
        items,
        buyer: {
          name: String(req.body?.name ?? '').slice(0, 120),
          email: String(req.body?.email ?? '').slice(0, 200),
        },
        returnUrl: `${base}/checkout/return`,
        cancelUrl: `${base}/shop`,
      });
      res.redirect(303, order.approveUrl!);
    } catch (e) {
      res.redirect(303, `${req.baseUrl}/shop?error=${encodeURIComponent((e as Error).message)}`);
    }
  });

  // PayPal sends the buyer back here with ?token=<PayPal order id>.
  r.get('/checkout/return', async (req, res) => {
    const id = String(req.query.token ?? '');
    try {
      const done = await finalizeCheckout(rf, id);
      if (!done) throw new Error('Unknown order');
      const o = done.order;
      if (o.channel === 'portal' && o.buyer?.customerPk)
        return res.redirect(
          303,
          `${req.baseUrl}/p/${signPortalToken(actionLinkSecret(rf), o.buyer.customerPk)}?done=paid`,
        );
      res.type('html').send(
        page(
          'Thank you',
          `<section class="card top"><div class="muted small">${esc(rf.config.business.name)}</div><h1>${o.status === 'COMPLETED' ? 'Thank you, payment received' : `Order ${esc(o.status.toLowerCase())}`}</h1>
<p>Order <b>${esc(o.id)}</b> · ${esc(formatMoney(o.total, o.currency))}</p><ul>${o.items.map((i) => `<li>${esc(i.name)} × ${i.quantity}</li>`).join('')}</ul>
<p class="muted">${esc(rf.config.business.name)} will be in touch${o.buyer?.email ? ` at ${esc(o.buyer.email)}` : ''}.</p></section>`,
        ),
      );
    } catch (e) {
      res
        .status(400)
        .type('html')
        .send(
          page(
            'Payment',
            `<section class="card top"><h1>We could not confirm this payment</h1><p class="muted">${esc((e as Error).message)}</p></section>`,
          ),
        );
    }
  });

  return r;
}
