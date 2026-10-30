import type { PayPalEnvironment } from '../types.ts';
import { Logger } from '../util.ts';

export const PAYPAL_BASE_URLS: Record<Exclude<PayPalEnvironment, 'MOCK'>, string> = {
  SANDBOX: 'https://api-m.sandbox.paypal.com',
  PRODUCTION: 'https://api-m.paypal.com',
};

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: any,
  ) {
    const name = body?.name ?? body?.error ?? 'PAYPAL_ERROR';
    const detail =
      body?.details?.[0]?.description ??
      body?.details?.[0]?.issue ??
      body?.message ??
      body?.error_description ??
      '';
    super(`PayPal ${method} ${path} failed (${status} ${name})${detail ? `: ${detail}` : ''}`);
  }
  get debugId(): string | undefined {
    return this.body?.debug_id;
  }
}

export interface PayPalClientOptions {
  environment: PayPalEnvironment;
  clientId?: string;
  clientSecret?: string;
  /** Overrides the base URL (used for MOCK). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  idempotencyKey?: string;
  query?: Record<string, string | number | undefined>;
  representation?: boolean;
}

export interface Money {
  currency_code: string;
  value: string;
}

export interface PayPalInvoice {
  id: string;
  status: string;
  detail: {
    invoice_number?: string;
    currency_code: string;
    invoice_date?: string;
    note?: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: {
      recipient_view_url?: string;
      invoicer_view_url?: string;
      create_time?: string;
      last_update_time?: string;
    };
  };
  primary_recipients?: Array<{
    billing_info?: { email_address?: string; name?: { given_name?: string; surname?: string } };
  }>;
  items?: Array<{ name: string; quantity: string; unit_amount: Money }>;
  amount?: { currency_code: string; value: string };
  due_amount?: Money;
  payments?: {
    paid_amount?: Money;
    transactions?: Array<{
      payment_id?: string;
      transaction_id?: string;
      payment_date?: string;
      method?: string;
      type?: string;
      amount?: Money;
    }>;
  };
  refunds?: { refund_amount?: Money };
  links?: Array<{ href: string; rel: string; method?: string }>;
}

export class PayPalClient {
  readonly environment: PayPalEnvironment;
  readonly baseUrl: string;
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly log = new Logger('paypal');

  constructor(private readonly opts: PayPalClientOptions) {
    this.environment = opts.environment;
    this.baseUrl = (
      opts.baseUrl ??
      (opts.environment === 'MOCK' ? 'http://localhost:8788' : PAYPAL_BASE_URLS[opts.environment])
    ).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return this.environment === 'MOCK' || Boolean(this.opts.clientId && this.opts.clientSecret);
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const id = this.opts.clientId ?? (this.environment === 'MOCK' ? 'mock-client' : undefined);
    const secret = this.opts.clientSecret ?? (this.environment === 'MOCK' ? 'mock-secret' : undefined);
    if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set');
    const res = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError(res.status, 'POST', '/v1/oauth2/token', body);
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 60) * 1000,
    };
    return this.token.value;
  }

  async request<T = any>(method: string, path: string, body?: unknown, o: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (o.idempotencyKey) headers['PayPal-Request-Id'] = o.idempotencyKey.slice(0, 108);
    if (o.representation) headers.Prefer = 'return=representation';
    const started = Date.now();
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    this.log.info(`${method} ${path} -> ${res.status} (${Date.now() - started}ms)`);
    if (!res.ok) throw new PayPalError(res.status, method, path, parsed ?? text);
    return parsed as T;
  }

  // ---- Invoicing v2 ----
  async createInvoice(draft: unknown, idempotencyKey: string): Promise<PayPalInvoice> {
    const r = await this.request<any>('POST', '/v2/invoicing/invoices', draft, {
      idempotencyKey,
      representation: true,
    });
    if (r?.id) return r as PayPalInvoice;
    const href: string | undefined = r?.href ?? r?.links?.find((l: any) => l.rel === 'self')?.href;
    const id = href?.split('/').pop();
    if (!id) throw new Error('PayPal did not return an invoice id');
    return this.getInvoice(id);
  }
  getInvoice(id: string) {
    return this.request<PayPalInvoice>('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  }
  updateInvoice(id: string, invoice: unknown, notifyRecipient = false) {
    return this.request<PayPalInvoice>('PUT', `/v2/invoicing/invoices/${encodeURIComponent(id)}`, invoice, {
      query: { send_to_recipient: notifyRecipient ? 'true' : 'false' },
      representation: true,
    });
  }
  sendInvoice(id: string, opts: { subject?: string; note?: string } = {}, idempotencyKey?: string) {
    return this.request<any>(
      'POST',
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/send`,
      { send_to_invoicer: false, send_to_recipient: true, ...opts },
      { idempotencyKey },
    );
  }
  remindInvoice(id: string, opts: { subject?: string; note?: string } = {}) {
    return this.request<void>('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, opts);
  }
  cancelInvoice(id: string, opts: { subject?: string; note?: string; send_to_recipient?: boolean } = {}) {
    return this.request<void>('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
      send_to_recipient: true,
      send_to_invoicer: false,
      ...opts,
    });
  }
  recordInvoicePayment(
    id: string,
    payment: { method: string; payment_date: string; amount: Money; note?: string },
    idempotencyKey?: string,
  ) {
    return this.request<{ payment_id: string }>(
      'POST',
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`,
      payment,
      { idempotencyKey },
    );
  }
  searchInvoices(criteria: Record<string, unknown>, page = 1, pageSize = 100) {
    return this.request<{ items?: PayPalInvoice[]; total_items?: number }>(
      'POST',
      '/v2/invoicing/search-invoices',
      criteria,
      {
        query: { page, page_size: pageSize, total_required: 'true' },
      },
    );
  }

  recordInvoiceRefund(id: string, refund: { method: string; refund_date: string; amount: Money }) {
    return this.request<{ refund_id: string }>(
      'POST',
      `/v2/invoicing/invoices/${encodeURIComponent(id)}/refunds`,
      refund,
    );
  }
  refundCapture(
    captureId: string,
    body: { amount?: Money; note_to_payer?: string },
    idempotencyKey?: string,
  ) {
    return this.request<{ id: string; status: string }>(
      'POST',
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      body,
      {
        idempotencyKey,
        representation: true,
      },
    );
  }

  // ---- Catalog + Subscriptions ----
  createProduct(
    p: { name: string; description?: string; type?: string; category?: string },
    idempotencyKey?: string,
  ) {
    return this.request<{ id: string; name: string }>(
      'POST',
      '/v1/catalogs/products',
      { type: 'SERVICE', ...p },
      { idempotencyKey, representation: true },
    );
  }
  createPlan(plan: unknown, idempotencyKey?: string) {
    return this.request<{ id: string; status: string }>('POST', '/v1/billing/plans', plan, {
      idempotencyKey,
      representation: true,
    });
  }
  createSubscription(sub: unknown, idempotencyKey?: string) {
    return this.request<{ id: string; status: string; links?: Array<{ href: string; rel: string }> }>(
      'POST',
      '/v1/billing/subscriptions',
      sub,
      { idempotencyKey, representation: true },
    );
  }
  getSubscription(id: string) {
    return this.request<{ id: string; status: string; plan_id?: string; billing_info?: any }>(
      'GET',
      `/v1/billing/subscriptions/${encodeURIComponent(id)}`,
    );
  }
  cancelSubscription(id: string, reason: string) {
    return this.request<void>('POST', `/v1/billing/subscriptions/${encodeURIComponent(id)}/cancel`, {
      reason,
    });
  }

  // ---- Webhooks ----
  // ---- Orders v2 (portal payments, shop and agent checkouts)
  createOrder(body: unknown, idempotencyKey: string) {
    return this.request<PayPalOrder>('POST', '/v2/checkout/orders', body, {
      idempotencyKey,
      representation: true,
    });
  }
  getOrder(id: string) {
    return this.request<PayPalOrder>('GET', `/v2/checkout/orders/${encodeURIComponent(id)}`);
  }
  captureOrder(id: string, idempotencyKey: string) {
    return this.request<PayPalOrder>(
      'POST',
      `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
      {},
      {
        idempotencyKey,
        representation: true,
      },
    );
  }

  createWebhook(url: string, eventTypes: string[]) {
    return this.request<{ id: string; url: string }>('POST', '/v1/notifications/webhooks', {
      url,
      event_types: eventTypes.map((name) => ({ name })),
    });
  }
  listWebhooks() {
    return this.request<{
      webhooks: Array<{ id: string; url: string; event_types: Array<{ name: string }> }>;
    }>('GET', '/v1/notifications/webhooks');
  }
  verifyWebhookSignature(body: {
    auth_algo: string;
    cert_url: string;
    transmission_id: string;
    transmission_sig: string;
    transmission_time: string;
    webhook_id: string;
    webhook_event: unknown;
  }) {
    return this.request<{ verification_status: 'SUCCESS' | 'FAILURE' }>(
      'POST',
      '/v1/notifications/verify-webhook-signature',
      body,
    );
  }

  // ---- Disputes + reporting ----
  listDisputes(query: Record<string, string | undefined> = {}) {
    return this.request<{ items?: any[] }>('GET', '/v1/customer/disputes', undefined, { query });
  }
  getDispute(id: string) {
    return this.request<any>('GET', `/v1/customer/disputes/${encodeURIComponent(id)}`);
  }
  acceptDisputeClaim(id: string, note: string) {
    return this.request<any>('POST', `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, {
      note,
    });
  }
  listTransactions(start: Date, end: Date) {
    return this.request<{ transaction_details?: any[] }>('GET', '/v1/reporting/transactions', undefined, {
      query: {
        start_date: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        end_date: end.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        fields: 'all',
        page_size: 100,
      },
    });
  }
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
}

export function payerViewUrl(inv: PayPalInvoice): string | undefined {
  return inv.detail?.metadata?.recipient_view_url ?? inv.links?.find((l) => l.rel === 'payer-view')?.href;
}

export const PAID_STATUSES = ['PAID', 'MARKED_AS_PAID'];
export const CANCELLED_STATUSES = ['CANCELLED'];
export const REFUNDED_STATUSES = ['REFUNDED', 'MARKED_AS_REFUNDED', 'PARTIALLY_REFUNDED'];
export const OPEN_STATUSES = ['DRAFT', 'SENT', 'SCHEDULED', 'UNPAID', 'PAYMENT_PENDING', 'PARTIALLY_PAID'];

export interface PayPalOrder {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  links?: Array<{ href: string; rel: string; method?: string }>;
  purchase_units?: Array<{
    reference_id?: string;
    custom_id?: string;
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        create_time?: string;
        amount?: Money;
        seller_receivable_breakdown?: { paypal_fee?: Money };
      }>;
    };
  }>;
}

export const WEBHOOK_EVENTS = [
  'INVOICING.INVOICE.PAID',
  'INVOICING.INVOICE.CANCELLED',
  'INVOICING.INVOICE.REFUNDED',
  'INVOICING.INVOICE.UPDATED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.CAPTURE.DENIED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
  'CHECKOUT.ORDER.APPROVED',
  'CHECKOUT.ORDER.COMPLETED',
];
