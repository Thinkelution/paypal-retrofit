export interface LedgerRow {
  key: string;
  entity: 'invoice' | 'subscription';
  legacyPk: string;
  number: string;
  customer: string;
  customerEmail: string;
  legacyStatus: string;
  legacyState: string;
  legacyTotal: number;
  issued: string | null;
  due: string | null;
  daysOverdue: number | null;
  paypalId: string | null;
  paypalStatus: string | null;
  paypalAmount: number | null;
  paypalPaid: number | null;
  paypalPaidAt: string | null;
  paypalTransactionId: string | null;
  payLink: string | null;
  lastSyncedAt: string | null;
  discrepancies: string[];
  pendingActions: number;
  inSync: boolean;
}

export interface Summary {
  business: string;
  currency: string;
  environment: string;
  invoices: number;
  linked: number;
  readyToSend: number;
  open: number;
  openAmount: number;
  overdue: number;
  overdueAmount: number;
  paidViaPayPal: number;
  paidViaPayPalAmount: number;
  subscriptions: number;
  discrepancies: number;
  pendingActions: number;
  lastSyncAt: string | null;
  lastReconcileAt: string | null;
  lastWebhookAt: string | null;
}

export interface Action {
  id: number;
  origin: string;
  kind: string;
  target: { entity: string; legacyPk: string; paypalId?: string; label?: string };
  payload: Record<string, unknown>;
  reason: string;
  policy: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
  result: any;
}

export interface Discrepancy {
  id: number;
  entity: string;
  legacyPk: string | null;
  paypalId: string | null;
  kind: string;
  detail: string;
  suggestion: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface EventRec {
  id: string;
  type: string;
  receivedAt: string;
  processedAt: string | null;
  status: string;
  summary: string | null;
  error: string | null;
}

export interface Config {
  business: { name: string; website?: string };
  currency: string;
  environment: string;
  agentAvailable: boolean;
  model: string;
  autoApprove: boolean;
  actionKinds: string[];
  policies: Record<string, string>;
  source: { kind: string };
  demo: { legacyAppPath: string; mockPath: string } | null;
  webhookConfigured: boolean;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw Object.assign(new Error(data?.error ?? `${r.status} ${r.statusText}`), { data });
  return data as T;
}

export const api = {
  config: () => req<Config>('GET', '/api/config'),
  summary: () => req<Summary>('GET', '/api/summary'),
  ledger: () => req<LedgerRow[]>('GET', '/api/ledger'),
  actions: (status?: string) => req<Action[]>('GET', `/api/actions${status ? `?status=${status}` : ''}`),
  approve: (id: number) => req<Action>('POST', `/api/actions/${id}/approve`),
  reject: (id: number) => req<Action>('POST', `/api/actions/${id}/reject`, {}),
  propose: (body: {
    kind: string;
    entity: string;
    legacyPks: string[];
    payload?: unknown;
    reason?: string;
  }) => req<Action[]>('POST', '/api/propose', body),
  discrepancies: (all = false) => req<Discrepancy[]>('GET', `/api/discrepancies${all ? '?all=1' : ''}`),
  resolve: (id: number, resolution: string) =>
    req('POST', `/api/discrepancies/${id}/resolve`, { resolution }),
  events: () => req<EventRec[]>('GET', '/api/events'),
  sync: (dryRun = false) => req<any>('POST', '/api/sync/run', { dryRun }),
  reconcile: () => req<any>('POST', '/api/reconcile/run'),
  schema: () => req<any>('GET', '/api/schema'),
  mapping: () => req<any>('GET', '/api/mapping'),
  saveMapping: (m: unknown) => req<any>('PUT', '/api/mapping', m),
  draftDispute: (id: string) => req<any>('POST', `/api/disputes/${encodeURIComponent(id)}/draft`),
  resetDemo: () => req('POST', '/api/demo/reset'),
  demoDispute: (legacyPk: string) => req<any>('POST', '/api/demo/dispute', { legacyPk }),
  resetAgent: (sessionId: string) => req('POST', '/api/agent/reset', { sessionId }),
};

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string }
  | { type: 'tool_call'; name: string; input?: unknown }
  | { type: 'tool_result'; name: string; output?: string }
  | { type: 'action_proposed'; name: string; action: Action };

/** POSTs a chat message and yields server-sent events as they arrive. */
export async function chat(sessionId: string, message: string, onEvent: (e: AgentEvent) => void) {
  const r = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
  if (!r.ok || !r.body) throw new Error(`Chat failed (${r.status})`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

export const fmtMoney = (n: number | null | undefined, currency = 'USD') =>
  n == null
    ? ''
    : new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);

export const ago = (iso: string | null | undefined) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export const KIND_LABEL: Record<string, string> = {
  create_invoice: 'Create invoice',
  send_invoice: 'Send invoice',
  update_invoice: 'Update invoice',
  send_reminder: 'Send reminder',
  cancel_invoice: 'Cancel invoice',
  record_payment: 'Record payment',
  create_refund: 'Refund',
  create_subscription: 'Create subscription',
  cancel_subscription: 'Cancel subscription',
  accept_dispute: 'Accept dispute',
};

export const DISCREPANCY_LABEL: Record<string, string> = {
  paid_in_legacy_not_paypal: 'Paid here, open in PayPal',
  cancelled_in_legacy_not_paypal: 'Void here, open in PayPal',
  amount_mismatch: 'Amount mismatch',
  not_in_paypal: 'Not in PayPal yet',
  invalid_source: 'Bad source record',
  missing_in_legacy: 'Missing in legacy',
  partial_payment: 'Partially paid',
  refunded_in_paypal: 'Refunded in PayPal',
  dispute: 'Dispute',
  payment_failed: 'Payment failed',
};
