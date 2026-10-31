import {
  acpCancel,
  acpComplete,
  acpCreate,
  acpDiscovery,
  AcpError,
  acpGet,
  acpIdempotent,
  acpUpdate,
  checkAcpVersion,
  PAYPAL_HANDLER,
  paypalHandlerSchemas,
  toMoney,
  type AcpResult,
  type Retrofit,
} from '@paypal-retrofit/core';
import { acpMcpHttpHandler } from '@paypal-retrofit/mcp';
import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';

/**
 * Agentic Commerce Protocol endpoints: /.well-known/acp.json (public), the PayPal handler's spec and
 * schemas (public), and the checkout API at /acp/checkout_sessions plus its MCP binding at /acp/mcp
 * (Bearer token: RETROFIT_ACP_TOKEN; in the simulator any token is accepted, since no money moves).
 */
export function acpRouter(rf: Retrofit, baseFor: (req: Request) => string): express.Router {
  const r = express.Router();
  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#1d2433;line-height:1.5}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid #e5e9f0}td:last-child{text-align:right}.muted{color:#5b6475}</style></head><body>${body}</body></html>`;

  r.get('/.well-known/acp.json', (req, res) => {
    if (!rf.mapping.commerce.enabled)
      return res
        .status(404)
        .json({
          type: 'invalid_request',
          code: 'not_found',
          message: 'This business does not sell over ACP',
        });
    res.set('Cache-Control', 'public, max-age=3600').json(acpDiscovery(rf, baseFor(req)));
  });
  r.get('/acp/handlers/paypal_order', (req, res) =>
    res.type('text/markdown').send(handlerSpec(baseFor(req))),
  );
  r.get('/acp/handlers/paypal_order/config.json', (_req, res) => res.json(paypalHandlerSchemas().config));
  r.get('/acp/handlers/paypal_order/instrument.json', (_req, res) =>
    res.json(paypalHandlerSchemas().instrument),
  );
  // Where PayPal sends the buyer after they approve: the agent places the order.
  r.get('/acp/approved', (_req, res) =>
    res
      .type('html')
      .send(
        page(
          'Payment approved',
          `<h1>Payment approved</h1><p>Thank you. Go back to your assistant: it places the order with ${esc(rf.config.business.name)}.</p>`,
        ),
      ),
  );
  r.get('/acp/orders/:id', (req, res) => {
    const o = rf.state.getOrder(String(req.params.id));
    if (!o || o.channel !== 'agent')
      return res.status(404).type('html').send(page('Not found', '<h1>Order not found</h1>'));
    const rows = o.items
      .map(
        (i) =>
          `<tr><td>${esc(i.name)} × ${i.quantity}</td><td>${toMoney(i.unitPrice * i.quantity)} ${esc(o.currency)}</td></tr>`,
      )
      .join('');
    res
      .type('html')
      .send(
        page(
          `Order ${o.id}`,
          `<h1>${esc(rf.config.business.name)}</h1><p class="muted">Order ${esc(o.id)} · ${o.status === 'COMPLETED' ? 'paid with PayPal' : esc(o.status.toLowerCase())}</p><table>${rows}<tr><td><b>Total</b></td><td><b>${toMoney(o.total)} ${esc(o.currency)}</b></td></tr></table>`,
        ),
      );
  });

  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  const send = (res: Response, e: unknown) => {
    const err =
      e instanceof AcpError
        ? e
        : new AcpError(500, 'processing_error', 'internal_error', (e as Error).message);
    if (err.code === 'idempotency_in_flight') res.set('Retry-After', '1');
    res.status(err.status).json(err.toJSON());
  };
  api.use((req, res, next) => {
    const token = process.env.RETROFIT_ACP_TOKEN;
    if (!token && rf.paypal.environment !== 'MOCK')
      return send(
        res,
        new AcpError(
          503,
          'service_unavailable',
          'not_configured',
          'ACP is not set up: set RETROFIT_ACP_TOKEN',
        ),
      );
    const got = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    const ok =
      got &&
      (!token ||
        (got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token))));
    if (!ok)
      return send(
        res,
        new AcpError(401, 'invalid_request', 'unauthorized', 'Authorization: Bearer <token> is required'),
      );
    // Idempotency keys are scoped to the caller, so one agent can never replay another's responses.
    res.locals.caller = crypto.createHash('sha256').update(got).digest('hex').slice(0, 16);
    next();
  });
  api.post('/mcp', (req, res, next) => {
    void acpMcpHttpHandler(() => rf, {
      base: baseFor(req),
      agent: req.get('user-agent'),
      caller: res.locals.caller,
    })(req, res).catch(next);
  });
  // Stateless: no server-sent event stream and no sessions to end.
  api.all('/mcp', (_req, res) =>
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }),
  );
  api.use((req, res, next) => {
    try {
      checkAcpVersion(req.get('api-version'));
      next();
    } catch (e) {
      send(res, e);
    }
  });
  const handle = (fn: (req: Request) => Promise<AcpResult>) => async (req: Request, res: Response) => {
    const key = req.get('idempotency-key');
    if (req.get('request-id')) res.set('Request-Id', req.get('request-id'));
    if (req.method === 'POST' && key) res.set('Idempotency-Key', key);
    try {
      const out =
        req.method === 'POST'
          ? await acpIdempotent(
              rf,
              `${res.locals.caller}:POST ${req.baseUrl}${req.path}`,
              key,
              req.body ?? {},
              () => fn(req),
            )
          : { ...(await fn(req)), replayed: false };
      if (out.replayed) res.set('Idempotent-Replayed', 'true');
      res.status(out.status).json(out.body);
    } catch (e) {
      send(res, e);
    }
  };
  const ctx = (req: Request) => ({ base: baseFor(req), agent: req.get('user-agent') });
  api.post(
    '/checkout_sessions',
    handle((req) => acpCreate(rf, req.body, ctx(req))),
  );
  api.get(
    '/checkout_sessions/:id',
    handle((req) => acpGet(rf, req.params.id!, ctx(req))),
  );
  api.post(
    '/checkout_sessions/:id',
    handle((req) => acpUpdate(rf, req.params.id!, req.body ?? {}, ctx(req))),
  );
  api.post(
    '/checkout_sessions/:id/complete',
    handle((req) => acpComplete(rf, req.params.id!, req.body ?? {}, ctx(req))),
  );
  api.post(
    '/checkout_sessions/:id/cancel',
    handle((req) => acpCancel(rf, req.params.id!, req.body ?? {}, ctx(req))),
  );
  r.use('/acp', api);
  return r;
}

function handlerSpec(base: string) {
  return `# PayPal order payment handler

\`${PAYPAL_HANDLER.name}\`, version ${PAYPAL_HANDLER.version}. Published by paypal-retrofit (open source, MIT).

A seller-backed handler for the Agentic Commerce Protocol. The seller creates a PayPal order for the
session's cart; the buyer reviews and approves it in PayPal; the agent completes the session with the
order id. No card or account data passes through the agent, and nothing is charged until the buyer
approves in PayPal.

## Handler declaration (in capabilities.payment.handlers)

- id: \`${PAYPAL_HANDLER.id}\`
- psp: \`paypal\`, requires_delegate_payment: false, requires_pci_compliance: false
- config: \`environment\` (mock, sandbox or production), \`merchant_name\`, \`order_id\` (the PayPal order for
  this cart), \`approve_url\` (where the buyer approves). Schema: ${base}/acp/handlers/paypal_order/config.json

## Flow

1. The agent creates or updates the session. The response carries \`order_id\` and \`approve_url\` in the
   handler config, and the same link as \`continue_url\`. A changed cart gets a new order and link.
2. The buyer opens the link and approves the payment in PayPal.
3. The agent completes the session:

\`\`\`json
{
  "payment_data": {
    "handler_id": "${PAYPAL_HANDLER.id}",
    "instrument": { "type": "paypal_order", "credential": { "type": "paypal_order_id", "order_id": "<order_id>" } }
  }
}
\`\`\`

Instrument schema: ${base}/acp/handlers/paypal_order/instrument.json

The seller captures the order and returns the session with \`status: completed\` and the \`order\`.
Completing before the buyer approves fails with \`approval_required\`; an order id from another session
fails with \`invalid\`. A cancelled session's order is never captured, even if the buyer approves it later.
`;
}
