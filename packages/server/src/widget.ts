import {
  actionLinkSecret,
  expectedTotal,
  formatMoney,
  invoiceQr,
  loadCatalog,
  loadInvoices,
  signPortalToken,
  type LegacyInvoice,
  type Retrofit,
} from '@paypal-retrofit/core';
import express, { type Request, type Response } from 'express';
import { esc, page, type PublicContext } from './portal.ts';

/**
 * PayPal on the business's existing website with one line:
 *   <script src="https://<retrofit>/widget.js" data-float="pay-bill" async></script>
 * adds a "Pay a bill" button (invoice number + email -> PayPal), and these work anywhere on the page:
 *   <div data-retrofit="pay-bill"></div>        the same form, inline
 *   <div data-retrofit="shop"></div>            the catalogue with Buy buttons (when the shop is on)
 *   <span data-retrofit-pay="INV-1043" data-email="customer@example.com"></span>   a Pay button for one invoice
 * Lookups need the invoice number and the customer's email together, and are rate limited.
 */
export function widgetRouter(rf: Retrofit, ctx: PublicContext) {
  const r = express.Router();
  const form = express.urlencoded({ extended: false, limit: '8kb' });
  const cors = (_req: Request, res: Response, next: () => void) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  };
  const limited = rateLimit(20, 10 * 60_000);

  const find = async (number: string, email: string): Promise<LegacyInvoice | null> => {
    const im = rf.mapping.entities.invoice;
    const n = number.trim().replace(/^#/, '');
    if (!n || !email.trim()) return null;
    const rows = await rf.source.readTable(im.table, { column: im.fields.number, in: [n] });
    if (!rows.length) return null;
    const [inv] = await loadInvoices(rf.source, rf.mapping, { pks: [String(rows[0]![im.pk])] });
    const ok = inv?.customer?.email && inv.customer.email.toLowerCase() === email.trim().toLowerCase();
    return ok ? inv : null;
  };
  const describe = async (inv: LegacyInvoice) => {
    const link = rf.state.getLink('invoice', inv.pk);
    const paid = inv.state === 'paid' || ['PAID', 'MARKED_AS_PAID'].includes(link?.paypalStatus ?? '');
    const due = (await expectedTotal(rf, inv.pk, inv.total)) - (link?.paypalPaid ?? 0);
    return {
      number: inv.number,
      amount: Math.max(0, Math.round(due * 100) / 100),
      currency: rf.mapping.currency,
      due: inv.due ?? null,
      paid,
      cancelled: inv.state === 'cancelled',
      payLink: !paid && inv.state === 'open' ? (link?.payLink ?? null) : null,
    };
  };

  r.get('/widget.js', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res
      .type('application/javascript')
      .send(widgetScript(ctx.base(req), rf.config.business.name, rf.mapping.currency));
  });

  // For AI assistants that visit the business's site: what it sells and how agents can buy or pay bills.
  r.get('/llms.txt', async (req, res) => {
    const base = ctx.base(req);
    const name = rf.config.business.name;
    const shop = rf.mapping.commerce.enabled;
    const items = shop ? (await loadCatalog(rf)).slice(0, 30) : [];
    res.setHeader('Access-Control-Allow-Origin', '*');
    res
      .type('text/plain')
      .send(
        [
          `# ${name}`,
          '',
          `> ${rf.mapping.commerce.description ?? `${name} takes payments online with PayPal.`}`,
          '',
          `AI assistants can work with ${name} through MCP (Model Context Protocol) at ${base}/mcp/shop (Streamable HTTP, no sign-in). Payments always need the person to approve them at PayPal; an assistant only ever hands over a PayPal link.`,
          '',
          '## For assistants',
          '',
          ...(shop
            ? [
                `- [MCP endpoint](${base}/mcp/shop): list_products, search_catalog, create_checkout, get_checkout_status`,
                `- [Catalogue](${base}/shop/catalog.json): products and prices as JSON`,
              ]
            : []),
          `- [MCP endpoint](${base}/mcp/shop): for existing customers, who give their portal link: my_invoices, pay_my_invoices, tell_the_business (a date they will pay by, a request to pay in parts, a question)`,
          '',
          '## For people',
          '',
          ...(shop ? [`- [Shop](${base}/shop)`] : []),
          `- Pay a bill: use the link in your latest statement or invoice email, or "Pay a bill" on ${name}'s website`,
          ...(items.length
            ? [
                '',
                '## Catalogue',
                '',
                ...items.map((p) => `- ${p.name}: ${formatMoney(p.price, p.currency)}`),
              ]
            : []),
          '',
        ].join('\n'),
      );
  });

  r.post('/widget/lookup', cors, limited, form, async (req, res) => {
    const inv = await find(String(req.body?.number ?? ''), String(req.body?.email ?? ''));
    if (!inv)
      return res.status(404).json({
        error: 'No invoice matches that number and email. Check both, or contact us.',
      });
    const base = ctx.base(req);
    res.json({
      business: rf.config.business.name,
      invoice: await describe(inv),
      portalUrl: `${base}/p/${signPortalToken(actionLinkSecret(rf), inv.customerPk)}`,
    });
  });

  r.get('/widget/catalog', cors, async (_req, res) => {
    const on = rf.mapping.commerce.enabled;
    res.json({
      business: rf.config.business.name,
      currency: rf.mapping.currency,
      enabled: on,
      items: on ? await loadCatalog(rf) : [],
    });
  });

  // A Pay button for one invoice: verified with the email, then straight to PayPal.
  r.post('/pay', limited, form, async (req, res) => {
    const inv = await find(String(req.body?.number ?? ''), String(req.body?.email ?? ''));
    const msg = (title: string, text: string) =>
      res
        .status(inv ? 200 : 404)
        .type('html')
        .send(
          page(
            title,
            `<section class="card top"><div class="muted small">${esc(rf.config.business.name)}</div><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p></section>`,
          ),
        );
    if (!inv) return msg('Invoice not found', 'No invoice matches that number and email.');
    const d = await describe(inv);
    if (d.paid) return msg(`${d.number} is paid`, 'Thank you! Nothing is owed on this invoice.');
    if (d.cancelled) return msg(`${d.number} was cancelled`, 'Nothing is owed on this invoice.');
    if (!d.payLink)
      return msg(`${d.number} isn't ready to pay online yet`, 'It will be shortly. Please try again later.');
    res.redirect(303, d.payLink);
  });

  return r;
}

/** Console-side: PayPal's QR code for an invoice, and a printable pay slip to go with a paper invoice. */
export function qrRoutes(rf: Retrofit) {
  const r = express.Router();
  r.get('/invoices/:pk/qr.png', async (req, res) => {
    try {
      const { png, source } = await invoiceQr(rf, String(req.params.pk), Number(req.query.size ?? 300));
      res.setHeader('X-QR-Source', source);
      res.type('png').send(png);
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });
  r.get('/invoices/:pk/slip', async (req, res) => {
    const pk = String(req.params.pk);
    const [inv] = await loadInvoices(rf.source, rf.mapping, { pks: [pk] });
    const link = rf.state.getLink('invoice', pk);
    if (!inv || !link)
      return res
        .status(404)
        .type('html')
        .send(
          page('Not in PayPal', '<section class="card"><h1>This invoice is not in PayPal yet</h1></section>'),
        );
    const amount = (await expectedTotal(rf, pk, inv.total)) - (link.paypalPaid ?? 0);
    res.type('html').send(
      page(
        `Pay slip ${inv.number}`,
        `<section class="card top slip"><div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center"><div><div class="muted small">${esc(rf.config.business.name)}</div><h1>Invoice ${esc(inv.number)}</h1>
<p>${esc(inv.customer?.name ?? '')}<br><span class="muted">${inv.due ? `Due ${esc(inv.due)}` : ''}</span></p>
<p style="font-size:28px;font-weight:700;margin:6px 0">${esc(formatMoney(Math.max(0, amount), rf.mapping.currency))}</p>
<p class="muted small">Scan with your phone camera to pay with PayPal, Venmo or a card.<br>${link.payLink ? `Or open <span style="word-break:break-all">${esc(link.payLink)}</span>` : ''}</p></div>
<img src="qr.png?size=300" width="220" height="220" alt="QR code that opens PayPal's pay page for invoice ${esc(inv.number)}"></div></section>
<p class="row noprint"><button class="primary" onclick="print()">Print</button><span class="muted small">Print it with the paper invoice or job sheet, or hand it over at the door.</span></p>
<style>@media print{.noprint,footer{display:none}body{background:#fff;padding:0}.card{border:1px solid #999}}</style>`,
      ),
    );
  });
  return r;
}

/** A stand-in for a small business's own website, with the one line added. Demo only. */
export function demoSitePage(business: string, legacyApp?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(business)}</title><link rel="help" type="text/plain" href="llms.txt" title="For AI assistants">
<style>:root{--ink:#1d1a16;--muted:#6a645b;--bg:#faf7f2;--line:#e7e0d4;--accent:#7a4b2a}@media (prefers-color-scheme:dark){:root{--ink:#efe9df;--muted:#b3aa9c;--bg:#171512;--line:#33302a;--accent:#d49a6a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 Georgia,'Times New Roman',serif}
.note{background:#1d4ed8;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center}.note code{background:rgb(255 255 255 / 18%);padding:1px 6px;border-radius:4px}
header{display:flex;gap:16px;align-items:center;padding:20px 24px;border-bottom:1px solid var(--line)}header b{font-size:22px;letter-spacing:.02em}header nav{margin-left:auto;display:flex;gap:16px;font:15px system-ui,sans-serif}header a{color:var(--ink)}
.hero{padding:56px 24px 40px;max-width:900px;margin:0 auto}.hero h1{font-size:clamp(30px,5vw,46px);line-height:1.15;margin:0 0 12px}.hero p{color:var(--muted);font-size:18px;max-width:640px}
section{max-width:900px;margin:0 auto;padding:24px}h2{font-size:26px;margin:0 0 6px}.sub{color:var(--muted);margin:0 0 16px}footer{max-width:900px;margin:0 auto;padding:32px 24px;color:var(--muted);font:14px system-ui,sans-serif}</style></head>
<body><div class="note">This stands in for ${esc(business)}'s own website. The only change for PayPal is one line: <code>&lt;script src="/widget.js" data-float="pay-bill" async&gt;&lt;/script&gt;</code>${legacyApp ? ` · <a style="color:#fff" href="${esc(legacyApp)}">their back-office app</a>` : ''}</div>
<header><b>${esc(business)}</b><nav><a href="#book">Book</a><a href="#pay">Pay a bill</a><a href="#contact">Contact</a></nav></header>
<div class="hero"><h1>Portraits, products and events, photographed with care.</h1><p>A small studio in Portland, Oregon. Book a session online, or pay an invoice in a few taps.</p></div>
<section id="book"><h2>Book a session</h2><p class="sub">Prices include editing and an online gallery.</p><div data-retrofit="shop"></div></section>
<section id="pay"><h2>Pay a bill</h2><p class="sub">Your invoice number is at the top of your invoice.</p><div data-retrofit="pay-bill"></div></section>
<footer id="contact">${esc(business)} · hello@example.com · (503) 555-0142</footer>
<script src="widget.js" data-float="pay-bill" async></script></body></html>`;
}

function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (req: Request, res: Response, next: () => void) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++h.n > max)
      return res.status(429).json({ error: 'Too many tries. Please wait a few minutes.' });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

function widgetScript(base: string, business: string, currency: string) {
  return `/* paypal-retrofit website widget for ${business.replace(/\*\//g, '')} */
(function () {
  var BASE = ${JSON.stringify(base)}, BUSINESS = ${JSON.stringify(business)}, CURRENCY = ${JSON.stringify(currency)};
  if (window.__retrofitWidget) return;
  window.__retrofitWidget = true;
  var me = document.currentScript;
  var CSS = ':host{all:initial;display:block;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#14171f}' +
    '*{box-sizing:border-box}.card{background:#fff;border:1px solid #e3e6ec;border-radius:12px;padding:16px;max-width:460px;color:#14171f}' +
    'label{display:block;font-size:13px;color:#5b6475;margin:0 0 10px}input{display:block;width:100%;font:inherit;padding:9px 11px;border:1px solid #cfd5df;border-radius:8px;margin-top:4px;color:#14171f;background:#fff}' +
    'button,a.btn{font:inherit;font-weight:600;padding:10px 16px;border-radius:999px;border:0;background:#0070e0;color:#fff;cursor:pointer;text-decoration:none;display:inline-block}' +
    'button.ghost{background:transparent;color:#0070e0;padding:6px 0;margin-left:14px}.head{font-weight:700;font-size:17px;margin:0 0 2px}.muted{color:#5b6475;font-size:13px}.err{color:#b42318;font-size:14px;margin:8px 0 0}' +
    '.inv{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:4px 0 12px}.inv b{font-size:22px}.ok{color:#1d7a4a;font-weight:600}' +
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}.prod{background:#fff;border:1px solid #e3e6ec;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:6px;color:#14171f}' +
    '.prod b{font-size:16px}.price{font-size:18px;font-weight:700}.pp{font-size:12px;color:#5b6475}' +
    '.fab{position:fixed;right:20px;bottom:20px;z-index:2147483000;box-shadow:0 6px 20px rgb(0 0 0 / 22%)}' +
    '.back{position:fixed;inset:0;background:rgb(10 14 20 / 45%);z-index:2147483001;display:flex;align-items:flex-end;justify-content:center;padding:16px}' +
    '@media (min-width:600px){.back{align-items:center}}.back .card{width:100%;box-shadow:0 12px 40px rgb(0 0 0 / 30%)}';
  function fmt(n) { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY }).format(n); } catch (e) { return n.toFixed(2); } }
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === 'text') e.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function shadow(host) {
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(h('style', { text: CSS }));
    return root;
  }
  function payBill(root, onClose) {
    var card = h('div', { class: 'card' });
    function ask(error) {
      card.innerHTML = '';
      var num = h('input', { name: 'number', required: '', autocomplete: 'off', placeholder: 'e.g. INV-1043' });
      var email = h('input', { name: 'email', type: 'email', required: '', autocomplete: 'email' });
      var f = h('form', { onsubmit: function (ev) {
        ev.preventDefault();
        var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = 'Looking…';
        fetch(BASE + '/widget/lookup', { method: 'POST', body: new URLSearchParams({ number: num.value, email: email.value }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (x) { x.ok ? show(x.j) : ask(x.j.error || 'Something went wrong.'); })
          .catch(function () { ask('Could not reach ' + BUSINESS + '. Please try again.'); });
      } }, [
        h('div', { class: 'head', text: 'Pay a bill' }),
        h('p', { class: 'muted', text: 'Pay ' + BUSINESS + ' securely with PayPal, Venmo or a card.' }),
        h('label', { text: 'Invoice number' }, [num]),
        h('label', { text: 'Email the invoice was sent to' }, [email]),
        h('button', { type: 'submit', text: 'Find my bill' }),
        error ? h('p', { class: 'err', text: error }) : null,
        onClose ? h('button', { type: 'button', class: 'ghost', text: ' Close', onclick: onClose }) : null,
      ]);
      card.appendChild(f);
    }
    function show(j) {
      var i = j.invoice;
      card.innerHTML = '';
      card.appendChild(h('div', { class: 'muted', text: j.business }));
      card.appendChild(h('div', { class: 'inv' }, [h('span', { text: 'Invoice ' + i.number + (i.due && !i.paid ? ' · due ' + i.due : '') }), h('b', { text: fmt(i.amount) })]));
      if (i.paid) card.appendChild(h('p', { class: 'ok', text: 'Paid. Thank you!' }));
      else if (i.payLink) card.appendChild(h('a', { class: 'btn', href: i.payLink, target: '_top', text: 'Pay ' + fmt(i.amount) + ' with PayPal' }));
      else card.appendChild(h('p', { class: 'muted', text: i.cancelled ? 'This invoice was cancelled.' : 'This invoice is not ready to pay online yet.' }));
      card.appendChild(h('p', {}, [h('a', { href: j.portalUrl, target: '_top', text: 'See all your invoices, or ask for more time' })]));
      if (onClose) card.appendChild(h('button', { type: 'button', class: 'ghost', text: 'Close', onclick: onClose }));
    }
    ask();
    root.appendChild(card);
  }
  function payButton(host) {
    var root = shadow(host);
    var f = h('form', { method: 'post', action: BASE + '/pay', target: '_top' }, [
      h('input', { type: 'hidden', name: 'number', value: host.getAttribute('data-retrofit-pay') }),
      h('input', { type: 'hidden', name: 'email', value: host.getAttribute('data-email') || '' }),
      h('button', { type: 'submit', text: host.getAttribute('data-label') || 'Pay with PayPal' }),
    ]);
    root.appendChild(f);
  }
  function shop(root) {
    fetch(BASE + '/widget/catalog').then(function (r) { return r.json(); }).then(function (j) {
      if (!j.enabled || !j.items.length) return;
      var grid = h('div', { class: 'grid' });
      j.items.forEach(function (p) {
        grid.appendChild(h('form', { class: 'prod', method: 'post', action: BASE + '/shop/checkout', target: '_top' }, [
          h('b', { text: p.name }),
          p.description ? h('span', { class: 'muted', text: p.description }) : null,
          h('span', { class: 'price', text: fmt(p.price) }),
          h('input', { type: 'hidden', name: 'qty_' + p.id, value: '1' }),
          h('button', { type: 'submit', text: 'Book and pay' }),
          h('span', { class: 'pp', text: 'Pay with PayPal, Venmo or card' }),
        ]));
      });
      root.appendChild(grid);
    });
  }
  function floating() {
    var host = h('div');
    document.body.appendChild(host);
    var root = shadow(host);
    var fab = h('button', { class: 'fab', text: 'Pay a bill', onclick: function () {
      var back = h('div', { class: 'back', onclick: function (e) { if (e.target === back) back.remove(); } });
      payBill(back, function () { back.remove(); });
      root.appendChild(back);
    } });
    root.appendChild(fab);
  }
  function start() {
    document.querySelectorAll('[data-retrofit="pay-bill"]').forEach(function (el) { payBill(shadow(el)); });
    document.querySelectorAll('[data-retrofit="shop"]').forEach(function (el) { shop(shadow(el)); });
    document.querySelectorAll('[data-retrofit-pay]').forEach(payButton);
    if (me && me.getAttribute('data-float') === 'pay-bill') floating();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
`;
}
