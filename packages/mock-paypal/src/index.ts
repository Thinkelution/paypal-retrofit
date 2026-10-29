/**
 * mock-paypal: an in-memory stand-in for the PayPal REST endpoints paypal-retrofit uses, so the project
 * can be developed, tested and demoed without a PayPal account. It is NOT PayPal and does not try to be
 * complete. Behaviour follows the public API reference closely enough for retrofit's flows:
 * invoices (create/send/remind/cancel/pay/record payment/refund), catalog products, plans, subscriptions,
 * webhooks with verifiable signatures, disputes and transaction search.
 *
 * Buyer-facing pages (/mock/...) let a person "pay" an invoice or approve a subscription in a browser,
 * which fires the same webhook events PayPal would.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';

export interface MockOptions {
  /** Public base URL of this mock, used in payer-view links. */
  publicUrl: string;
  /** Persist state to this JSON file. */
  dataFile?: string;
  /** Secret used to sign webhooks. */
  signingSecret?: string;
  log?: (msg: string) => void;
}

interface Webhook {
  id: string;
  url: string;
  event_types: Array<{ name: string }>;
}

interface State {
  invoices: Record<string, any>;
  products: Record<string, any>;
  plans: Record<string, any>;
  subscriptions: Record<string, any>;
  webhooks: Record<string, Webhook>;
  disputes: Record<string, any>;
  transactions: any[];
  idempotency: Record<string, { status: number; body: unknown }>;
  deliveries: Array<{ at: string; event: string; url: string; status: number | string }>;
}

const empty = (): State => ({
  invoices: {},
  products: {},
  plans: {},
  subscriptions: {},
  webhooks: {},
  disputes: {},
  transactions: [],
  idempotency: {},
  deliveries: [],
});

const rid = (prefix: string, groups = 4) =>
  `${prefix}${Array.from({ length: groups }, () => crypto.randomBytes(2).toString('hex').toUpperCase()).join('-')}`;
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const money = (v: number, c = 'USD') => ({ currency_code: c, value: v.toFixed(2) });

export function signWebhook(
  secret: string,
  transmissionId: string,
  time: string,
  webhookId: string,
  body: string,
) {
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  return crypto
    .createHmac('sha256', secret)
    .update(`${transmissionId}|${time}|${webhookId}|${digest}`)
    .digest('base64');
}

export function createMockPayPal(opts: MockOptions) {
  const secret = opts.signingSecret ?? 'mock-paypal-signing-secret';
  const log = opts.log ?? ((m: string) => console.error(`[mock-paypal] ${m}`));
  let state: State = empty();
  if (opts.dataFile && fs.existsSync(opts.dataFile)) {
    try {
      state = { ...empty(), ...JSON.parse(fs.readFileSync(opts.dataFile, 'utf8')) };
    } catch {
      state = empty();
    }
  }
  const save = () => {
    if (!opts.dataFile) return;
    fs.mkdirSync(path.dirname(opts.dataFile), { recursive: true });
    fs.writeFileSync(opts.dataFile, JSON.stringify(state, null, 1));
  };
  const base = opts.publicUrl.replace(/\/$/, '');

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  const fail = (res: Response, status: number, name: string, description: string, issue = name) =>
    res.status(status).json({
      name,
      message: description,
      debug_id: crypto.randomBytes(6).toString('hex'),
      details: [{ issue, description }],
    });

  const auth = (req: Request, res: Response, next: () => void) => {
    if (!/^Bearer mock-/.test(req.header('authorization') ?? ''))
      return fail(res, 401, 'AUTHENTICATION_FAILURE', 'Missing or invalid bearer token');
    next();
  };

  /** Replays the first response for a repeated PayPal-Request-Id, like PayPal does. */
  const idem = (req: Request, res: Response, handler: () => { status: number; body: unknown }) => {
    const key = req.header('paypal-request-id');
    const scoped = key ? `${req.method} ${req.path} ${key}` : undefined;
    if (scoped && state.idempotency[scoped]) {
      const prior = state.idempotency[scoped]!;
      return res.status(prior.status).json(prior.body);
    }
    const out = handler();
    if (scoped && out.status < 400) state.idempotency[scoped] = out;
    save();
    return out.status === 204 ? res.status(204).end() : res.status(out.status).json(out.body);
  };

  // ---------------------------------------------------------------- webhooks out
  async function emit(eventType: string, resource: any, summary: string) {
    const event = {
      id: `WH-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      create_time: nowIso(),
      resource_type: eventType.split('.')[0]!.toLowerCase(),
      event_type: eventType,
      summary,
      resource,
      event_version: '1.0',
    };
    const body = JSON.stringify(event);
    for (const wh of Object.values(state.webhooks)) {
      if (!wh.event_types.some((e) => e.name === eventType || e.name === '*')) continue;
      const transmissionId = crypto.randomUUID();
      const time = nowIso();
      const headers = {
        'content-type': 'application/json',
        'paypal-auth-algo': 'SHA256withRSA',
        'paypal-cert-url': `${base}/mock/certs/CERT-mock`,
        'paypal-transmission-id': transmissionId,
        'paypal-transmission-time': time,
        'paypal-transmission-sig': signWebhook(secret, transmissionId, time, wh.id, body),
      };
      let status: number | string = 'error';
      try {
        const r = await fetch(wh.url, { method: 'POST', headers, body });
        status = r.status;
      } catch (e) {
        status = (e as Error).message;
      }
      state.deliveries.unshift({ at: time, event: eventType, url: wh.url, status });
      state.deliveries = state.deliveries.slice(0, 100);
      log(`webhook ${eventType} -> ${wh.url} (${status})`);
    }
    save();
    return event;
  }

  // ---------------------------------------------------------------- oauth
  app.post('/v1/oauth2/token', (req, res) => {
    const basic = req.header('authorization') ?? '';
    if (!basic.startsWith('Basic '))
      return res
        .status(401)
        .json({ error: 'invalid_client', error_description: 'Client Authentication failed' });
    res.json({
      scope: 'https://uri.paypal.com/services/invoicing',
      access_token: `mock-${crypto.randomBytes(12).toString('hex')}`,
      token_type: 'Bearer',
      app_id: 'APP-MOCK',
      expires_in: 32400,
      nonce: nowIso(),
    });
  });

  // ---------------------------------------------------------------- invoicing
  const invTotal = (inv: any) => {
    const items: any[] = inv.items ?? [];
    return (
      Math.round(
        items.reduce((s, i) => s + Number(i.quantity ?? 1) * Number(i.unit_amount?.value ?? 0), 0) * 100,
      ) / 100
    );
  };
  const decorate = (inv: any) => {
    const c = inv.detail?.currency_code ?? 'USD';
    const total = invTotal(inv);
    const paid = (inv.payments?.transactions ?? []).reduce(
      (s: number, t: any) => s + Number(t.amount?.value ?? 0),
      0,
    );
    const refunded = (inv.refunds?.transactions ?? []).reduce(
      (s: number, t: any) => s + Number(t.amount?.value ?? 0),
      0,
    );
    inv.amount = { ...money(total, c), breakdown: { item_total: money(total, c) } };
    inv.due_amount = money(Math.max(0, total - paid), c);
    if (paid > 0) inv.payments.paid_amount = money(paid, c);
    if (refunded > 0) inv.refunds.refund_amount = money(refunded, c);
    inv.links = [
      { href: `${base}/v2/invoicing/invoices/${inv.id}`, rel: 'self', method: 'GET' },
      ...(inv.status !== 'DRAFT'
        ? [{ href: `${base}/mock/invoice/${inv.id}`, rel: 'payer-view', method: 'GET' }]
        : []),
    ];
    return inv;
  };

  app.post('/v2/invoicing/invoices', auth, (req, res) =>
    idem(req, res, () => {
      const b = req.body ?? {};
      const number = b.detail?.invoice_number;
      if (!b.detail?.currency_code)
        return {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            details: [
              { issue: 'MISSING_REQUIRED_PARAMETER', description: 'detail.currency_code is required' },
            ],
          },
        };
      if (!b.primary_recipients?.[0]?.billing_info?.email_address)
        return {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ issue: 'MISSING_REQUIRED_PARAMETER', description: 'recipient email is required' }],
          },
        };
      if (number && Object.values(state.invoices).some((i: any) => i.detail?.invoice_number === number)) {
        return {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            message: 'Invoice number already exists',
            details: [{ issue: 'DUPLICATE_INVOICE_NUMBER', description: 'Invoice number must be unique.' }],
          },
        };
      }
      const id = rid('INV2-');
      const inv = decorate({
        ...b,
        id,
        status: 'DRAFT',
        detail: {
          ...b.detail,
          invoice_date: b.detail.invoice_date ?? nowIso().slice(0, 10),
          metadata: {
            create_time: nowIso(),
            last_update_time: nowIso(),
            invoicer_view_url: `${base}/mock/invoice/${id}?as=invoicer`,
          },
        },
      });
      state.invoices[id] = inv;
      log(`created invoice ${id} (${number ?? 'no number'})`);
      return {
        status: 201,
        body:
          req.header('prefer') === 'return=representation'
            ? inv
            : { rel: 'self', href: `${base}/v2/invoicing/invoices/${id}`, method: 'GET' },
      };
    }),
  );

  const getInv = (req: Request, res: Response) => {
    const inv = state.invoices[req.params.id!];
    if (!inv) {
      fail(res, 404, 'RESOURCE_NOT_FOUND', 'The specified resource does not exist.', 'INVALID_RESOURCE_ID');
      return null;
    }
    return inv;
  };

  app.get('/v2/invoicing/invoices/:id', auth, (req, res) => {
    const inv = getInv(req, res);
    if (inv) res.json(decorate(inv));
  });

  app.put('/v2/invoicing/invoices/:id', auth, (req, res) => {
    const inv = getInv(req, res);
    if (!inv) return;
    if (['PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED'].includes(inv.status))
      return fail(
        res,
        422,
        'UNPROCESSABLE_ENTITY',
        `Cannot update an invoice in ${inv.status}`,
        'CANNOT_UPDATE_INVOICE',
      );
    const b = req.body ?? {};
    Object.assign(inv, {
      items: b.items ?? inv.items,
      primary_recipients: b.primary_recipients ?? inv.primary_recipients,
      configuration: b.configuration ?? inv.configuration,
      detail: {
        ...inv.detail,
        ...b.detail,
        metadata: { ...inv.detail.metadata, last_update_time: nowIso() },
      },
    });
    save();
    res.json(decorate(inv));
  });

  app.post('/v2/invoicing/invoices/:id/send', auth, (req, res) => {
    const inv = getInv(req, res);
    if (!inv) return;
    return idem(req, res, () => {
      if (inv.status !== 'DRAFT')
        return {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ issue: 'INVALID_INVOICE_STATUS', description: `Invoice is ${inv.status}` }],
          },
        };
      inv.status = 'SENT';
      inv.detail.metadata.recipient_view_url = `${base}/mock/invoice/${inv.id}`;
      inv.detail.metadata.last_update_time = nowIso();
      log(`sent invoice ${inv.id} to ${inv.primary_recipients?.[0]?.billing_info?.email_address}`);
      return {
        status: 200,
        body: { rel: 'payer-view', href: inv.detail.metadata.recipient_view_url, method: 'GET' },
      };
    });
  });

  app.post('/v2/invoicing/invoices/:id/remind', auth, (req, res) => {
    const inv = getInv(req, res);
    if (!inv) return;
    if (!['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status))
      return fail(
        res,
        422,
        'UNPROCESSABLE_ENTITY',
        `Cannot remind an invoice in ${inv.status}`,
        'INVALID_INVOICE_STATUS',
      );
    inv.reminders = [
      ...(inv.reminders ?? []),
      { at: nowIso(), subject: req.body?.subject, note: req.body?.note },
    ];
    save();
    log(`reminder sent for ${inv.id}`);
    res.status(204).end();
  });

  app.post('/v2/invoicing/invoices/:id/cancel', auth, async (req, res) => {
    const inv = getInv(req, res);
    if (!inv) return;
    if (!['SENT', 'UNPAID', 'SCHEDULED'].includes(inv.status))
      return fail(
        res,
        422,
        'UNPROCESSABLE_ENTITY',
        `Cannot cancel an invoice in ${inv.status}`,
        'INVALID_INVOICE_STATUS',
      );
    inv.status = 'CANCELLED';
    save();
    res.status(204).end();
    await emit(
      'INVOICING.INVOICE.CANCELLED',
      decorate(inv),
      `Invoice ${inv.detail.invoice_number} cancelled`,
    );
  });

  app.post('/v2/invoicing/invoices/:id/payments', auth, (req, res) => {
    const inv = getInv(req, res);
    if (!inv) return;
    return idem(req, res, () => {
      const amount = Number(req.body?.amount?.value ?? invTotal(inv));
      const payment_id = `EXTR-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      inv.payments = inv.payments ?? { transactions: [] };
      inv.payments.transactions.push({
        payment_id,
        type: 'EXTERNAL',
        method: req.body?.method ?? 'OTHER',
        payment_date: req.body?.payment_date ?? nowIso().slice(0, 10),
        amount: money(amount, inv.detail.currency_code),
        note: req.body?.note,
      });
      const paid = inv.payments.transactions.reduce((s: number, t: any) => s + Number(t.amount.value), 0);
      inv.status = paid + 0.001 >= invTotal(inv) ? 'MARKED_AS_PAID' : 'PARTIALLY_PAID';
      decorate(inv);
      return { status: 200, body: { payment_id } };
    });
  });

  app.post('/v2/invoicing/invoices/:id/refunds', auth, (req, res) => {
    const inv = getInv(req, res);
    if (!inv) return;
    const amount = Number(req.body?.amount?.value ?? 0);
    const refund_id = `EXTR-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    inv.refunds = inv.refunds ?? { transactions: [] };
    inv.refunds.transactions.push({
      refund_id,
      type: 'EXTERNAL',
      method: req.body?.method ?? 'OTHER',
      refund_date: req.body?.refund_date,
      amount: money(amount, inv.detail.currency_code),
    });
    inv.status = 'MARKED_AS_REFUNDED';
    save();
    res.json({ refund_id });
  });

  app.post('/v2/invoicing/search-invoices', auth, (req, res) => {
    const c = req.body ?? {};
    let items = Object.values(state.invoices).map(decorate);
    if (c.invoice_number) items = items.filter((i: any) => i.detail?.invoice_number === c.invoice_number);
    if (c.status) items = items.filter((i: any) => c.status.includes(i.status));
    if (c.recipient_email)
      items = items.filter(
        (i: any) => i.primary_recipients?.[0]?.billing_info?.email_address === c.recipient_email,
      );
    const page = Number(req.query.page ?? 1);
    const size = Number(req.query.page_size ?? 20);
    res.json({
      total_items: items.length,
      total_pages: Math.ceil(items.length / size),
      items: items.slice((page - 1) * size, page * size),
    });
  });

  app.get('/v2/invoicing/invoices', auth, (req, res) => {
    const items = Object.values(state.invoices).map(decorate);
    const page = Number(req.query.page ?? 1);
    const size = Number(req.query.page_size ?? 20);
    res.json({ total_items: items.length, items: items.slice((page - 1) * size, page * size) });
  });

  app.post('/v2/payments/captures/:id/refund', auth, (req, res) => {
    const inv = Object.values(state.invoices).find((i: any) =>
      i.payments?.transactions?.some((t: any) => t.payment_id === req.params.id),
    );
    if (!inv) return fail(res, 404, 'RESOURCE_NOT_FOUND', 'Capture not found', 'INVALID_RESOURCE_ID');
    return idem(req, res, () => {
      const tx = inv.payments.transactions.find((t: any) => t.payment_id === req.params.id);
      const amount = Number(req.body?.amount?.value ?? tx.amount.value);
      const id = crypto.randomBytes(8).toString('hex').toUpperCase();
      inv.refunds = inv.refunds ?? { transactions: [] };
      inv.refunds.transactions.push({
        refund_id: id,
        type: 'PAYPAL',
        refund_date: nowIso().slice(0, 10),
        amount: money(amount, inv.detail.currency_code),
      });
      inv.status = amount + 0.001 >= Number(tx.amount.value) ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      decorate(inv);
      state.transactions.push({
        transaction_info: {
          transaction_id: id,
          transaction_event_code: 'T1107',
          transaction_initiation_date: nowIso(),
          transaction_amount: money(-amount, inv.detail.currency_code),
          invoice_id: inv.detail.invoice_number,
          transaction_status: 'S',
        },
      });
      setTimeout(
        () =>
          void emit(
            'PAYMENT.CAPTURE.REFUNDED',
            { id, status: 'COMPLETED', amount: money(amount), invoice_id: inv.detail.invoice_number },
            'A payment was refunded',
          ),
        10,
      );
      return {
        status: 201,
        body: { id, status: 'COMPLETED', amount: money(amount, inv.detail.currency_code) },
      };
    });
  });

  // ---------------------------------------------------------------- catalog + billing
  app.post('/v1/catalogs/products', auth, (req, res) =>
    idem(req, res, () => {
      const id = `PROD-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
      state.products[id] = { id, ...req.body, create_time: nowIso() };
      return { status: 201, body: state.products[id] };
    }),
  );
  app.get('/v1/catalogs/products', auth, (_req, res) =>
    res.json({ products: Object.values(state.products) }),
  );
  app.get('/v1/catalogs/products/:id', auth, (req, res) =>
    state.products[req.params.id!]
      ? res.json(state.products[req.params.id!])
      : fail(res, 404, 'RESOURCE_NOT_FOUND', 'Product not found'),
  );

  app.post('/v1/billing/plans', auth, (req, res) =>
    idem(req, res, () => {
      if (!state.products[req.body?.product_id])
        return {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ issue: 'INVALID_PRODUCT_ID', description: 'Product not found' }],
          },
        };
      const id = `P-${crypto.randomBytes(12).toString('hex').toUpperCase()}`;
      state.plans[id] = { id, ...req.body, status: req.body?.status ?? 'ACTIVE', create_time: nowIso() };
      return { status: 201, body: state.plans[id] };
    }),
  );
  app.get('/v1/billing/plans', auth, (_req, res) => res.json({ plans: Object.values(state.plans) }));
  app.get('/v1/billing/plans/:id', auth, (req, res) =>
    state.plans[req.params.id!]
      ? res.json(state.plans[req.params.id!])
      : fail(res, 404, 'RESOURCE_NOT_FOUND', 'Plan not found'),
  );

  app.post('/v1/billing/subscriptions', auth, (req, res) =>
    idem(req, res, () => {
      const plan = state.plans[req.body?.plan_id];
      if (!plan)
        return {
          status: 422,
          body: {
            name: 'UNPROCESSABLE_ENTITY',
            details: [{ issue: 'INVALID_PLAN_ID', description: 'Plan not found' }],
          },
        };
      const id = `I-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      state.subscriptions[id] = {
        id,
        plan_id: plan.id,
        status: 'APPROVAL_PENDING',
        custom_id: req.body?.custom_id,
        subscriber: req.body?.subscriber,
        create_time: nowIso(),
        links: [
          { href: `${base}/mock/subscription/${id}/approve`, rel: 'approve', method: 'GET' },
          { href: `${base}/v1/billing/subscriptions/${id}`, rel: 'self', method: 'GET' },
        ],
      };
      return { status: 201, body: state.subscriptions[id] };
    }),
  );
  app.get('/v1/billing/subscriptions/:id', auth, (req, res) =>
    state.subscriptions[req.params.id!]
      ? res.json(state.subscriptions[req.params.id!])
      : fail(res, 404, 'RESOURCE_NOT_FOUND', 'Subscription not found', 'INVALID_RESOURCE_ID'),
  );
  app.post('/v1/billing/subscriptions/:id/cancel', auth, async (req, res) => {
    const s = state.subscriptions[req.params.id!];
    if (!s) return fail(res, 404, 'RESOURCE_NOT_FOUND', 'Subscription not found', 'INVALID_RESOURCE_ID');
    s.status = 'CANCELLED';
    s.status_change_note = req.body?.reason;
    save();
    res.status(204).end();
    await emit('BILLING.SUBSCRIPTION.CANCELLED', s, 'Subscription cancelled');
  });

  // ---------------------------------------------------------------- webhooks admin + verify
  app.post('/v1/notifications/webhooks', auth, (req, res) => {
    const url = req.body?.url;
    if (!url) return fail(res, 400, 'INVALID_REQUEST', 'url is required');
    const existing = Object.values(state.webhooks).find((w) => w.url === url);
    if (existing) return fail(res, 400, 'WEBHOOK_URL_ALREADY_EXISTS', 'Webhook URL already exists');
    const id = crypto.randomBytes(8).toString('hex').toUpperCase();
    state.webhooks[id] = { id, url, event_types: req.body?.event_types ?? [] };
    save();
    res.status(201).json(state.webhooks[id]);
  });
  app.get('/v1/notifications/webhooks', auth, (_req, res) =>
    res.json({ webhooks: Object.values(state.webhooks) }),
  );
  app.delete('/v1/notifications/webhooks/:id', auth, (req, res) => {
    delete state.webhooks[req.params.id!];
    save();
    res.status(204).end();
  });
  app.post('/v1/notifications/verify-webhook-signature', auth, (req, res) => {
    const b = req.body ?? {};
    const body = JSON.stringify(b.webhook_event);
    const expected = signWebhook(
      secret,
      b.transmission_id ?? '',
      b.transmission_time ?? '',
      b.webhook_id ?? '',
      body,
    );
    const ok =
      !!b.transmission_sig &&
      b.transmission_sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(b.transmission_sig), Buffer.from(expected));
    res.json({ verification_status: ok && state.webhooks[b.webhook_id] ? 'SUCCESS' : 'FAILURE' });
  });

  // ---------------------------------------------------------------- disputes + reporting
  app.get('/v1/customer/disputes', auth, (_req, res) =>
    res.json({
      items: Object.values(state.disputes).map(
        ({
          dispute_id,
          reason,
          status,
          dispute_amount,
          create_time,
          update_time,
          dispute_life_cycle_stage,
        }) => ({
          dispute_id,
          reason,
          status,
          dispute_amount,
          create_time,
          update_time,
          dispute_life_cycle_stage,
        }),
      ),
    }),
  );
  app.get('/v1/customer/disputes/:id', auth, (req, res) =>
    state.disputes[req.params.id!]
      ? res.json(state.disputes[req.params.id!])
      : fail(res, 404, 'RESOURCE_NOT_FOUND', 'Dispute not found'),
  );
  app.post('/v1/customer/disputes/:id/accept-claim', auth, async (req, res) => {
    const d = state.disputes[req.params.id!];
    if (!d) return fail(res, 404, 'RESOURCE_NOT_FOUND', 'Dispute not found');
    d.status = 'RESOLVED';
    d.dispute_outcome = { outcome_code: 'RESOLVED_BUYER_FAVOUR', amount_refunded: d.dispute_amount };
    save();
    res.json({ links: [] });
    await emit('CUSTOMER.DISPUTE.RESOLVED', d, 'Dispute resolved');
  });

  app.get('/v1/reporting/transactions', auth, (req, res) => {
    const start = Date.parse(String(req.query.start_date ?? '1970-01-01'));
    const end = Date.parse(String(req.query.end_date ?? '2999-01-01'));
    const items = state.transactions.filter((t) => {
      const at = Date.parse(t.transaction_info.transaction_initiation_date);
      return at >= start && at <= end;
    });
    res.json({ transaction_details: items, total_items: items.length, page: 1, total_pages: 1 });
  });

  // ---------------------------------------------------------------- buyer pages (not PayPal)
  const page = (
    title: string,
    body: string,
  ) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f7fa;color:#1d2433;margin:0;padding:24px}main{max-width:520px;margin:0 auto;background:#fff;border:1px solid #dde3ec;border-radius:12px;padding:24px}
.tag{display:inline-block;font-size:12px;background:#fff3cd;color:#7a5b00;border-radius:999px;padding:2px 10px;margin-bottom:12px}table{width:100%;border-collapse:collapse;margin:12px 0}td{padding:6px 0;border-bottom:1px solid #eef1f5}
td:last-child{text-align:right}button{width:100%;padding:12px;font-size:16px;border:0;border-radius:8px;background:#1d4ed8;color:#fff;cursor:pointer}.muted{color:#5b6475;font-size:14px}.ok{color:#15803d;font-weight:600}</style></head>
<body><main><span class="tag">Mock PayPal · test payments only · no money moves</span>${body}</main></body></html>`;
  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );

  app.get('/mock/invoice/:id', (req, res) => {
    const inv = state.invoices[req.params.id!];
    if (!inv) return res.status(404).send(page('Not found', '<p>No such invoice.</p>'));
    decorate(inv);
    const rows = (inv.items ?? [])
      .map(
        (i: any) =>
          `<tr><td>${esc(i.name)} × ${esc(i.quantity)}</td><td>${esc(i.unit_amount.value)}</td></tr>`,
      )
      .join('');
    const payable = ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status);
    const pp = inv.configuration?.partial_payment;
    const partialMin =
      pp?.allow_partial_payment &&
      Number(pp.minimum_amount_due?.value ?? 0) < Number(inv.due_amount.value) - 0.005
        ? Number(pp.minimum_amount_due?.value ?? 0).toFixed(2)
        : null;
    res.send(
      page(
        `Invoice ${esc(inv.detail.invoice_number)}`,
        `<h2>${esc(inv.invoicer?.business_name ?? 'Merchant')}</h2><p class="muted">Invoice ${esc(inv.detail.invoice_number)} · ${esc(inv.status)}</p>
<table>${rows}<tr><td><b>Total</b></td><td><b>${esc(inv.amount.value)} ${esc(inv.amount.currency_code)}</b></td></tr></table>
${inv.detail.note ? `<p class="muted">${esc(inv.detail.note)}</p>` : ''}
${payable && partialMin ? `<form method="post" action="${esc(req.baseUrl)}/mock/invoice/${esc(inv.id)}/pay?amount=${esc(partialMin)}" style="margin-bottom:10px"><button>Pay instalment ${esc(partialMin)} ${esc(inv.amount.currency_code)}</button></form>` : ''}
${payable ? `<form method="post" action="${esc(req.baseUrl)}/mock/invoice/${esc(inv.id)}/pay"><button${partialMin ? ' style="background:#334155"' : ''}>Pay ${partialMin ? 'full balance ' : ''}${esc(inv.due_amount.value)} ${esc(inv.amount.currency_code)}</button></form>` : `<p class="ok">${esc(inv.status)}</p>`}
${inv.payments?.paid_amount ? `<p class="muted">Paid so far: ${esc(inv.payments.paid_amount.value)} ${esc(inv.amount.currency_code)}</p>` : ''}`,
      ),
    );
  });

  /** Pays an invoice in full, or by a partial amount when the invoice allows partial payments. */
  async function payInvoice(id: string, partial?: number) {
    const inv = state.invoices[id];
    if (!inv || !['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status)) return null;
    decorate(inv);
    const due = Number(inv.due_amount.value);
    const pp = inv.configuration?.partial_payment;
    let amount = due;
    if (partial !== undefined && Number.isFinite(partial) && partial < due) {
      if (!pp?.allow_partial_payment) return null;
      const min = Number(pp.minimum_amount_due?.value ?? 0);
      if (partial + 0.005 < min) return null;
      amount = Math.round(partial * 100) / 100;
    }
    const captureId = crypto.randomBytes(8).toString('hex').toUpperCase();
    const fee = Math.round((amount * 0.0349 + 0.49) * 100) / 100;
    inv.payments = inv.payments ?? { transactions: [] };
    inv.payments.transactions.push({
      payment_id: captureId,
      type: 'PAYPAL',
      payment_date: nowIso().slice(0, 10),
      amount: money(amount, inv.detail.currency_code),
    });
    inv.status = amount + 0.005 >= due ? 'PAID' : 'PARTIALLY_PAID';
    decorate(inv);
    state.transactions.push({
      transaction_info: {
        transaction_id: captureId,
        transaction_event_code: 'T0007',
        transaction_initiation_date: nowIso(),
        transaction_amount: money(amount, inv.detail.currency_code),
        fee_amount: money(-fee, inv.detail.currency_code),
        invoice_id: inv.detail.invoice_number,
        transaction_status: 'S',
      },
      payer_info: { email_address: inv.primary_recipients?.[0]?.billing_info?.email_address },
    });
    save();
    log(`invoice ${id} paid (${amount})`);
    await emit(
      'PAYMENT.CAPTURE.COMPLETED',
      {
        id: captureId,
        status: 'COMPLETED',
        amount: money(amount, inv.detail.currency_code),
        invoice_id: inv.detail.invoice_number,
        seller_receivable_breakdown: { paypal_fee: money(fee) },
      },
      `Payment completed for ${amount}`,
    );
    if (inv.status === 'PAID')
      await emit('INVOICING.INVOICE.PAID', inv, `Invoice ${inv.detail.invoice_number} paid`);
    else await emit('INVOICING.INVOICE.UPDATED', inv, `Invoice ${inv.detail.invoice_number} partially paid`);
    return inv;
  }

  app.post('/mock/invoice/:id/pay', async (req, res) => {
    const inv = await payInvoice(req.params.id, req.query.amount ? Number(req.query.amount) : undefined);
    res.redirect(303, `${req.baseUrl}/mock/invoice/${req.params.id}${inv ? '?paid=1' : ''}`);
  });

  app.get('/mock/subscription/:id/approve', (req, res) => {
    const s = state.subscriptions[req.params.id!];
    if (!s) return res.status(404).send(page('Not found', '<p>No such subscription.</p>'));
    const plan = state.plans[s.plan_id];
    const price = plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price;
    res.send(
      page(
        'Approve subscription',
        `<h2>${esc(plan?.name ?? 'Subscription')}</h2><p class="muted">${esc(price?.value)} ${esc(price?.currency_code)} every ${esc(plan?.billing_cycles?.[0]?.frequency?.interval_unit?.toLowerCase())} · ${esc(s.status)}</p>
${s.status === 'APPROVAL_PENDING' ? `<form method="post" action="${esc(req.baseUrl)}/mock/subscription/${esc(s.id)}/approve"><button>Agree &amp; subscribe</button></form>` : `<p class="ok">${esc(s.status)}</p>`}`,
      ),
    );
  });

  async function approveSubscription(id: string) {
    const s = state.subscriptions[id];
    if (!s || s.status !== 'APPROVAL_PENDING') return null;
    s.status = 'ACTIVE';
    s.status_update_time = nowIso();
    const plan = state.plans[s.plan_id];
    const price = plan?.billing_cycles?.[0]?.pricing_scheme?.fixed_price ?? money(0);
    s.billing_info = {
      last_payment: { amount: price, time: nowIso() },
      next_billing_time: new Date(Date.now() + 30 * 86400000).toISOString(),
    };
    save();
    await emit('BILLING.SUBSCRIPTION.ACTIVATED', s, 'Subscription activated');
    const saleId = crypto.randomBytes(8).toString('hex').toUpperCase();
    state.transactions.push({
      transaction_info: {
        transaction_id: saleId,
        transaction_event_code: 'T0002',
        transaction_initiation_date: nowIso(),
        transaction_amount: price,
        transaction_status: 'S',
        paypal_reference_id: id,
      },
    });
    await emit(
      'PAYMENT.SALE.COMPLETED',
      {
        id: saleId,
        state: 'completed',
        amount: { total: price.value, currency: price.currency_code },
        billing_agreement_id: id,
        create_time: nowIso(),
      },
      'Payment completed',
    );
    return s;
  }

  app.post('/mock/subscription/:id/approve', async (req, res) => {
    await approveSubscription(req.params.id);
    res.redirect(303, `${req.baseUrl}/mock/subscription/${req.params.id}/approve`);
  });

  // ---------------------------------------------------------------- test controls (not PayPal)
  app.get('/mock/state', (_req, res) =>
    res.json({ ...state, idempotency: Object.keys(state.idempotency).length }),
  );
  app.post('/mock/reset', (_req, res) => {
    state = empty();
    save();
    res.json({ ok: true });
  });
  app.post('/mock/api/invoices/:id/pay', async (req, res) => {
    const amount = req.query.amount ?? req.body?.amount;
    const inv = await payInvoice(req.params.id, amount !== undefined ? Number(amount) : undefined);
    return inv
      ? res.json(decorate(inv))
      : fail(res, 422, 'UNPROCESSABLE_ENTITY', 'Invoice cannot be paid in its current state');
  });
  app.post('/mock/api/subscriptions/:id/approve', async (req, res) => {
    const s = await approveSubscription(req.params.id);
    return s ? res.json(s) : fail(res, 422, 'UNPROCESSABLE_ENTITY', 'Subscription cannot be approved');
  });
  /** Opens a buyer dispute against a paid invoice, as a buyer would in their PayPal account. */
  app.post('/mock/api/invoices/:id/dispute', async (req, res) => {
    const inv = state.invoices[req.params.id!];
    const tx = inv?.payments?.transactions?.find((t: any) => t.type === 'PAYPAL');
    if (!tx)
      return fail(res, 422, 'UNPROCESSABLE_ENTITY', 'Only invoices paid through PayPal can be disputed');
    const id = `PP-D-${Math.floor(10000 + Math.random() * 89999)}`;
    const d = {
      dispute_id: id,
      create_time: nowIso(),
      update_time: nowIso(),
      reason: req.body?.reason ?? 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED',
      status: 'OPEN',
      dispute_state: 'REQUIRED_ACTION',
      dispute_life_cycle_stage: 'INQUIRY',
      dispute_channel: 'INTERNAL',
      dispute_amount: tx.amount,
      disputed_transactions: [
        {
          seller_transaction_id: tx.payment_id,
          invoice_number: inv.detail.invoice_number,
          gross_amount: tx.amount,
          buyer: { name: inv.primary_recipients?.[0]?.billing_info?.name },
        },
      ],
      messages: [
        {
          posted_by: 'BUYER',
          time_posted: nowIso(),
          content:
            req.body?.message ??
            'The photos delivered were not the ones agreed. Half of the edited images are missing.',
        },
      ],
      seller_response_due_date: new Date(Date.now() + 10 * 86400000).toISOString(),
    };
    state.disputes[id] = d;
    save();
    await emit('CUSTOMER.DISPUTE.CREATED', d, 'A new dispute opened');
    res.status(201).json(d);
  });

  const reset = () => {
    state = empty();
    save();
  };
  return { app, state: () => state, payInvoice, approveSubscription, reset };
}
