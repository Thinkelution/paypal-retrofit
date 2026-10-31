import crypto from 'node:crypto';
import { createCheckout, finalizeCheckout, loadCatalog } from './commerce.ts';
import type { Retrofit } from './engine.ts';
import type { AcpSessionRecord } from './state/store.ts';
import { cents } from './util.ts';

/**
 * The Agentic Commerce Protocol (ACP) checkout API, so any ACP agent can buy from the business's catalogue:
 * create, update, retrieve, complete and cancel checkout sessions, with ACP's idempotency rules, integer
 * minor units and flat errors. Payment uses a PayPal handler: each session carries a PayPal order that the
 * buyer approves in PayPal (no card data passes through the agent), and completing the session captures it
 * and books the sale like any other PayPal order. Prices come only from the business's own data.
 */

export const ACP_VERSIONS = ['2026-01-16', '2026-04-17'];
export const ACP_VERSION = ACP_VERSIONS[ACP_VERSIONS.length - 1]!;
export const PAYPAL_HANDLER = {
  id: 'paypal',
  name: 'io.github.thinkelution.retrofit.paypal_order',
  version: '2026-10-31',
};
const SESSION_HOURS = 6;

export class AcpError extends Error {
  constructor(
    readonly status: number,
    readonly type: 'invalid_request' | 'processing_error' | 'service_unavailable',
    readonly code: string,
    message: string,
    readonly param?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toJSON() {
    return {
      type: this.type,
      code: this.code,
      message: this.message,
      ...(this.param ? { param: this.param } : {}),
      ...this.extra,
    };
  }
}

export interface AcpContext {
  /** Absolute base URL of the workspace, for links in responses. */
  base: string;
  /** The calling agent (User-Agent), kept on the order for the owner. */
  agent?: string;
}

export interface AcpResult {
  status: number;
  body: unknown;
}

export function checkAcpVersion(v: string | undefined) {
  if (!v)
    throw new AcpError(
      400,
      'invalid_request',
      'missing_api_version',
      'The API-Version header is required',
      undefined,
      {
        supported_versions: ACP_VERSIONS,
      },
    );
  if (!ACP_VERSIONS.includes(v))
    throw new AcpError(
      400,
      'invalid_request',
      'unsupported_api_version',
      `API-Version ${v} is not supported`,
      undefined,
      {
        supported_versions: ACP_VERSIONS,
      },
    );
}

function ensureSelling(rf: Retrofit) {
  if (!rf.mapping.commerce.enabled)
    throw new AcpError(
      400,
      'invalid_request',
      'unsupported',
      `${rf.config.business.name} does not sell online`,
    );
}

/** The seller's discovery document, served at /.well-known/acp.json. */
export function acpDiscovery(rf: Retrofit, base: string) {
  return {
    protocol: {
      name: 'acp',
      version: ACP_VERSION,
      supported_versions: ACP_VERSIONS,
      documentation_url: 'https://github.com/Thinkelution/paypal-retrofit/blob/main/docs/ACP.md',
    },
    api_base_url: `${base}/acp`,
    transports: ['rest', 'mcp'],
    capabilities: {
      services: ['checkout'],
      supported_currencies: [rf.mapping.currency.toLowerCase()],
      supported_locales: ['en-US'],
    },
  };
}

/** JSON Schemas for the PayPal handler's config and instrument, published next to the API. */
export function paypalHandlerSchemas() {
  return {
    config: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'PayPal order handler config',
      type: 'object',
      required: ['environment', 'merchant_name'],
      properties: {
        environment: { enum: ['mock', 'sandbox', 'production'] },
        merchant_name: { type: 'string' },
        order_id: { type: 'string', description: "The PayPal order for this session's cart" },
        approve_url: {
          type: 'string',
          format: 'uri',
          description: 'Where the buyer reviews and approves the payment in PayPal',
        },
      },
    },
    instrument: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'PayPal order instrument',
      type: 'object',
      required: ['type', 'credential'],
      properties: {
        type: { const: 'paypal_order' },
        credential: {
          type: 'object',
          required: ['type', 'order_id'],
          properties: { type: { const: 'paypal_order_id' }, order_id: { type: 'string' } },
        },
      },
    },
  };
}

const items = (body: any): AcpSessionRecord['items'] | undefined => {
  const raw = body?.line_items ?? body?.items;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length)
    throw new AcpError(400, 'invalid_request', 'missing', 'Add at least one item', '$.line_items');
  return raw.map((it: any, i: number) => {
    const id = String(it?.id ?? '').trim();
    const quantity = it?.quantity === undefined ? 1 : Number(it.quantity);
    if (!id)
      throw new AcpError(400, 'invalid_request', 'missing', 'Each item needs an id', `$.line_items[${i}].id`);
    if (!Number.isInteger(quantity) || quantity < 1)
      throw new AcpError(
        400,
        'invalid_request',
        'invalid',
        'Quantity must be a whole number, at least 1',
        `$.line_items[${i}].quantity`,
      );
    return { id, quantity };
  });
};

const load = (rf: Retrofit, id: string) => {
  const s = rf.state.getAcpSession(id);
  if (!s) throw new AcpError(404, 'invalid_request', 'not_found', 'Checkout session not found', 'id');
  return s;
};
const expired = (s: AcpSessionRecord) =>
  s.status === 'ready_for_payment' && Date.now() > Date.parse(s.expiresAt);
const assertOpen = (s: AcpSessionRecord) => {
  if (s.status !== 'ready_for_payment')
    throw new AcpError(400, 'invalid_request', 'conflict', `The checkout session is ${s.status}`);
  if (expired(s)) throw new AcpError(400, 'invalid_request', 'expired', 'The checkout session has expired');
};

/** Creates the PayPal order for the session's cart (replacing any earlier one, which can then never be captured). */
async function placeOrder(rf: Retrofit, s: AcpSessionRecord, ctx: AcpContext) {
  const previous = s.orderId ? rf.state.getOrder(s.orderId) : undefined;
  const name =
    [s.buyer?.first_name, s.buyer?.last_name].filter(Boolean).join(' ') ||
    (s.buyer?.full_name as string | undefined);
  try {
    const order = await createCheckout(rf, {
      channel: 'agent',
      items: s.items.map((i) => ({ productId: i.id, quantity: i.quantity })),
      buyer: {
        name: name || undefined,
        email: typeof s.buyer?.email === 'string' ? s.buyer.email : undefined,
        agent: `${(ctx.agent ?? s.agent ?? 'agent').slice(0, 60)} (ACP)`,
      },
      returnUrl: `${ctx.base}/acp/approved?session=${encodeURIComponent(s.id)}`,
      cancelUrl: `${ctx.base}/shop`,
    });
    if (previous && previous.status !== 'COMPLETED') rf.state.saveOrder({ ...previous, status: 'CANCELLED' });
    return order;
  } catch (e) {
    const m = (e as Error).message;
    const at = (id: string) => s.items.findIndex((i) => i.id === id);
    const unknown = /^Unknown product (.+)$/.exec(m);
    if (unknown)
      throw new AcpError(
        400,
        'invalid_request',
        'not_found',
        m,
        `$.line_items[${Math.max(0, at(unknown[1]!))}].id`,
      );
    if (/^Quantity must be/.test(m))
      throw new AcpError(400, 'invalid_request', 'quantity_exceeded', m, '$.line_items');
    if (/need to be arranged/.test(m))
      throw new AcpError(400, 'invalid_request', 'maximum_exceeded', m, '$.line_items');
    if (/does not sell online/.test(m)) throw new AcpError(400, 'invalid_request', 'unsupported', m);
    throw new AcpError(
      503,
      'service_unavailable',
      'paypal_unavailable',
      `PayPal did not take the order: ${m}`,
    );
  }
}

/** The authoritative session, as ACP returns it on every call. Amounts in minor units. */
async function view(
  rf: Retrofit,
  s: AcpSessionRecord,
  ctx: AcpContext,
  note?: { approved?: boolean; message?: string },
) {
  const order = s.orderId ? rf.state.getOrder(s.orderId) : undefined;
  const catalog = new Map((await loadCatalog(rf)).map((p) => [p.id, p]));
  const business = rf.config.business.name;
  const status = expired(s) ? 'expired' : s.status;
  const lines = (
    order?.items.length
      ? order.items
      : s.items.map((i) => ({
          productId: i.id,
          name: catalog.get(i.id)?.name ?? i.id,
          quantity: i.quantity,
          unitPrice: catalog.get(i.id)?.price ?? 0,
        }))
  ).map((l) => {
    const unit = cents(l.unitPrice);
    const amount = unit * l.quantity;
    const p = catalog.get(String(l.productId));
    return {
      id: `li_${l.productId}`,
      item: { id: String(l.productId) },
      quantity: l.quantity,
      name: l.name,
      ...(p?.description ? { description: p.description } : {}),
      unit_amount: unit,
      totals: [
        { type: 'subtotal', display_text: 'Subtotal', amount },
        { type: 'total', display_text: 'Total', amount },
      ],
    };
  });
  const sum = lines.reduce((t, l) => t + l.unit_amount * l.quantity, 0);
  const messages: Array<Record<string, unknown>> = [];
  if (note?.message) messages.push({ type: 'info', content_type: 'plain', content: note.message });
  else if (status === 'ready_for_payment')
    messages.push(
      note?.approved
        ? {
            type: 'info',
            content_type: 'plain',
            content: 'The buyer approved the payment in PayPal. Complete the session to place the order.',
          }
        : {
            type: 'info',
            resolution: 'requires_buyer_review',
            content_type: 'plain',
            content: `The buyer reviews and approves this payment in PayPal at continue_url. Then complete the session with handler "paypal" and the order_id from its config.`,
          },
    );
  return {
    id: s.id,
    protocol: { version: ACP_VERSION },
    capabilities: {
      payment: {
        handlers: [
          {
            ...PAYPAL_HANDLER,
            display_name: 'PayPal',
            spec: `${ctx.base}/acp/handlers/paypal_order`,
            requires_delegate_payment: false,
            requires_pci_compliance: false,
            psp: 'paypal',
            config_schema: `${ctx.base}/acp/handlers/paypal_order/config.json`,
            instrument_schemas: [`${ctx.base}/acp/handlers/paypal_order/instrument.json`],
            config: {
              environment: rf.paypal.environment.toLowerCase(),
              merchant_name: business,
              ...(order?.paypalOrderId ? { order_id: order.paypalOrderId } : {}),
              ...(order?.approveUrl ? { approve_url: order.approveUrl } : {}),
            },
          },
        ],
      },
    },
    ...(s.buyer ? { buyer: s.buyer } : {}),
    status,
    currency: s.currency,
    line_items: lines,
    ...(s.fulfillment ? { fulfillment_details: s.fulfillment } : {}),
    fulfillment_options: [
      {
        type: 'digital',
        id: 'service',
        title: `Arranged with ${business}`,
        description: 'A service or digital delivery: nothing is shipped.',
        totals: [{ type: 'total', display_text: 'Delivery', amount: 0 }],
      },
    ],
    selected_fulfillment_options: [
      { type: 'digital', option_id: 'service', item_ids: lines.map((l) => l.item.id) },
    ],
    totals: [
      { type: 'items_base_amount', display_text: 'Item(s) total', amount: sum },
      { type: 'subtotal', display_text: 'Subtotal', amount: sum },
      { type: 'fulfillment', display_text: 'Delivery', amount: 0 },
      { type: 'total', display_text: 'Total', amount: sum },
    ],
    messages,
    links: [{ type: 'support', title: `${business} shop`, url: `${ctx.base}/shop` }],
    ...(status === 'ready_for_payment' && order?.approveUrl ? { continue_url: order.approveUrl } : {}),
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    expires_at: s.expiresAt,
    ...(s.status === 'completed' && order
      ? {
          order: {
            type: 'order',
            id: order.id,
            checkout_session_id: s.id,
            permalink_url: `${ctx.base}/acp/orders/${order.id}`,
            status: 'confirmed',
          },
        }
      : {}),
  };
}

export async function acpCreate(rf: Retrofit, body: any, ctx: AcpContext): Promise<AcpResult> {
  ensureSelling(rf);
  const list = items(body);
  if (!list) throw new AcpError(400, 'invalid_request', 'missing', 'line_items is required', '$.line_items');
  const cur = rf.mapping.currency.toLowerCase();
  if (body?.currency !== undefined && String(body.currency).toLowerCase() !== cur)
    throw new AcpError(
      400,
      'invalid_request',
      'invalid',
      `${rf.config.business.name} sells in ${cur}`,
      '$.currency',
    );
  const now = new Date();
  const s: AcpSessionRecord = {
    id: `cs_${crypto.randomBytes(9).toString('hex')}`,
    status: 'ready_for_payment',
    currency: cur,
    items: list,
    buyer: body?.buyer && typeof body.buyer === 'object' ? body.buyer : null,
    fulfillment:
      body?.fulfillment_details && typeof body.fulfillment_details === 'object'
        ? body.fulfillment_details
        : null,
    orderId: null,
    agent: ctx.agent?.slice(0, 120) ?? null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_HOURS * 3600_000).toISOString(),
  };
  s.orderId = (await placeOrder(rf, s, ctx)).id;
  return { status: 201, body: await view(rf, rf.state.saveAcpSession(s), ctx) };
}

export async function acpUpdate(rf: Retrofit, id: string, body: any, ctx: AcpContext): Promise<AcpResult> {
  ensureSelling(rf);
  const s = load(rf, id);
  assertOpen(s);
  for (const [i, o] of (Array.isArray(body?.selected_fulfillment_options)
    ? body.selected_fulfillment_options
    : []
  ).entries())
    if (o?.option_id !== 'service')
      throw new AcpError(
        400,
        'invalid_request',
        'invalid',
        'The only fulfillment option is "service"',
        `$.selected_fulfillment_options[${i}].option_id`,
      );
  if (body?.buyer !== undefined) s.buyer = body.buyer === null ? null : { ...(s.buyer ?? {}), ...body.buyer };
  if (body?.fulfillment_details !== undefined) s.fulfillment = body.fulfillment_details;
  const list = items(body);
  if (list) {
    s.items = list;
    s.orderId = (await placeOrder(rf, s, ctx)).id;
  }
  return { status: 200, body: await view(rf, rf.state.saveAcpSession(s), ctx) };
}

/** The latest state, including whether the buyer has approved the payment in PayPal yet. */
export async function acpGet(rf: Retrofit, id: string, ctx: AcpContext): Promise<AcpResult> {
  let s = load(rf, id);
  let approved = false;
  const order = s.orderId ? rf.state.getOrder(s.orderId) : undefined;
  if (s.status === 'ready_for_payment' && order?.paypalOrderId && !expired(s)) {
    const pp = await rf.paypal.getOrder(order.paypalOrderId).catch(() => null);
    approved = pp?.status === 'APPROVED';
    // Captured already (the approval webhook books PayPal orders straight away): the session is done.
    if (pp?.status === 'COMPLETED' || order.status === 'COMPLETED') {
      await finalizeCheckout(rf, order.id);
      s = rf.state.saveAcpSession({ ...s, status: 'completed' });
    }
  }
  return { status: 200, body: await view(rf, s, ctx, { approved }) };
}

export async function acpComplete(rf: Retrofit, id: string, body: any, ctx: AcpContext): Promise<AcpResult> {
  const s = load(rf, id);
  assertOpen(s);
  const pd = body?.payment_data;
  if (!pd || typeof pd !== 'object')
    throw new AcpError(400, 'invalid_request', 'missing', 'payment_data is required', '$.payment_data');
  if (pd.handler_id !== PAYPAL_HANDLER.id)
    throw new AcpError(
      400,
      'invalid_request',
      'invalid',
      'This seller takes the "paypal" handler only',
      '$.payment_data.handler_id',
    );
  const order = s.orderId ? rf.state.getOrder(s.orderId) : undefined;
  const given = pd.instrument?.credential?.order_id;
  if (!order?.paypalOrderId || given !== order.paypalOrderId)
    throw new AcpError(
      400,
      'invalid_request',
      'invalid',
      "That PayPal order is not this session's",
      '$.payment_data.instrument.credential.order_id',
    );
  if (body?.buyer && typeof body.buyer === 'object') s.buyer = { ...(s.buyer ?? {}), ...body.buyer };
  const pp = await rf.paypal.getOrder(order.paypalOrderId);
  if (pp.status !== 'APPROVED' && pp.status !== 'COMPLETED')
    throw new AcpError(
      400,
      'invalid_request',
      'approval_required',
      'The buyer has not approved this payment in PayPal yet: send them to continue_url, then complete again',
      '$.payment_data',
    );
  const done = await finalizeCheckout(rf, order.id);
  if (done?.order.status !== 'COMPLETED')
    throw new AcpError(
      400,
      'invalid_request',
      'payment_declined',
      `PayPal did not capture the payment (${done?.summary ?? pp.status})`,
      '$.payment_data',
    );
  return { status: 200, body: await view(rf, rf.state.saveAcpSession({ ...s, status: 'completed' }), ctx) };
}

export async function acpCancel(rf: Retrofit, id: string, _body: any, ctx: AcpContext): Promise<AcpResult> {
  const s = load(rf, id);
  if (s.status === 'completed' || s.status === 'canceled')
    throw new AcpError(405, 'invalid_request', 'invalid', `The checkout session is already ${s.status}`);
  const order = s.orderId ? rf.state.getOrder(s.orderId) : undefined;
  // Approving the PayPal link later must not charge the buyer for a cancelled session.
  if (order && order.status !== 'COMPLETED') rf.state.saveOrder({ ...order, status: 'CANCELLED' });
  const saved = rf.state.saveAcpSession({ ...s, status: 'canceled' });
  return {
    status: 200,
    body: await view(rf, saved, ctx, { message: 'Checkout session has been canceled.' }),
  };
}

const canon = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);

/**
 * ACP idempotency: a key is scoped to the caller and endpoint; the same key and body replays the stored
 * response (with its status) without running anything again; a different body is a 422; a request still
 * running is a 409; 5xx responses are never stored. Keys are kept for 48 hours.
 */
export async function acpIdempotent(
  rf: Retrofit,
  scope: string,
  key: string | undefined,
  body: unknown,
  run: () => Promise<AcpResult>,
): Promise<AcpResult & { replayed: boolean }> {
  if (!key)
    throw new AcpError(
      400,
      'invalid_request',
      'idempotency_key_required',
      'Idempotency-Key header is required on all POST requests',
    );
  if (key.length > 255)
    throw new AcpError(400, 'invalid_request', 'invalid', 'Idempotency-Key is longer than 255 characters');
  const fingerprint = crypto
    .createHash('sha256')
    .update(canon(body ?? {}))
    .digest('hex');
  rf.state.purgeAcpIdempotency(new Date(Date.now() - 48 * 3600_000).toISOString());
  const prior = rf.state.getAcpIdempotency(scope, key);
  if (prior && prior.fingerprint !== fingerprint)
    throw new AcpError(
      422,
      'invalid_request',
      'idempotency_conflict',
      'Idempotency-Key has already been used with a different request body',
    );
  if (prior?.inFlight || (!prior && !rf.state.beginAcpIdempotency(scope, key, fingerprint)))
    throw new AcpError(
      409,
      'invalid_request',
      'idempotency_in_flight',
      'A request with this Idempotency-Key is currently being processed',
    );
  if (prior) return { status: prior.status!, body: prior.body, replayed: true };
  let out: AcpResult;
  try {
    out = await run();
  } catch (e) {
    const err =
      e instanceof AcpError
        ? e
        : new AcpError(500, 'processing_error', 'internal_error', (e as Error).message);
    out = { status: err.status, body: err.toJSON() };
  }
  if (out.status >= 500) rf.state.dropAcpIdempotency(scope, key);
  else rf.state.finishAcpIdempotency(scope, key, out.status, out.body);
  return { ...out, replayed: false };
}
