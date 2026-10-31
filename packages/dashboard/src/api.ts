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
  riskBand: 'low' | 'medium' | 'high' | null;
  riskScore: number | null;
  riskFactors: string[];
  expectedPayDate: string | null;
  plan: { installments: number; covered: number; nextDue: string | null; behind: number } | null;
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
  scheduledActions: number;
  activePlans: number;
  expectedNext30: number;
  atRisk: number;
  lastCollectionsAt: string | null;
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
  policyReason: string | null;
  amount: number | null;
  runAfter: string | null;
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
  demo: { legacyAppPath: string; mockPath: string; custom: boolean } | null;
  mcpPath: string;
  webhookConfigured: boolean;
  controls: {
    rules: Array<{ kind: string; mode: string; maxAmount?: number; minAmount?: number; note?: string }>;
    limits: Array<{ kind: string; perDay?: number; amountPerDay?: number }>;
    quietHours: { start: string; end: string; timezone: string; weekends: boolean; kinds: string[] } | null;
    quietNow: boolean;
    collections: { steps: Array<{ afterDaysOverdue: number; tone: string }>; minDaysBetween: number };
  };
}

export interface CollectionItem {
  legacyPk: string;
  number: string;
  customer: string;
  amountDue: number;
  due: string | null;
  daysOverdue: number;
  remindersSent: number;
  lastReminderAt: string | null;
  decision: 'remind' | 'wait' | 'hold' | 'plan' | 'escalate';
  tone: string | null;
  step: number | null;
  reason: string;
  nextReminderOn: string | null;
  risk: 'low' | 'medium' | 'high' | null;
  score: number | null;
  instalment: { n: number; of: number; amount: number; due: string } | null;
}

export interface InvoiceRisk {
  legacyPk: string;
  number: string;
  customer: string;
  amountDue: number;
  daysOverdue: number;
  score: number;
  band: 'low' | 'medium' | 'high';
  expectedPayDate: string;
  factors: string[];
  plan: { installments: number; covered: number; nextDue: string | null; behind: number } | null;
}

export interface CustomerProfile {
  customerPk: string;
  name: string;
  invoices: number;
  averageInvoice: number;
  paidCount: number;
  onTimeRate: number | null;
  medianDaysLate: number | null;
  worstDaysLate: number | null;
  openCount: number;
  openAmount: number;
  overdueAmount: number;
  disputes: number;
  behaviour: string;
}

export interface Insights {
  forecast: {
    currency: string;
    weeks: Array<{
      start: string;
      end: string;
      expected: number;
      fromInvoices: number;
      fromSubscriptions: number;
      items: Array<{ label: string; amount: number; kind: string }>;
    }>;
    next30: number;
    next60: number;
    atRisk: number;
    overdueTotal: number;
    assumptions: string[];
  };
  risks: InvoiceRisk[];
  customers: CustomerProfile[];
  plans: Array<{
    legacyPk: string;
    installments: number;
    installmentAmount: number;
    total: number;
    status: string;
    schedule: Array<{ n: number; due: string; amount: number }>;
  }>;
}

export interface MonthSummary {
  month: string;
  currency: string;
  paypalPayments: number;
  grossCollected: number;
  fees: number;
  feesMissing: number;
  net: number;
  refunds: number;
  paidOutsidePayPal: number;
  effectiveFeeRate: number | null;
}

export interface SetupStatus {
  configured: boolean;
  canSetup: boolean;
  allowServerPaths: boolean;
  environment: string;
  paypalCredentials: boolean;
  claude: boolean;
  model: string;
  smtp: boolean;
  slack: boolean;
  samples: string[];
}

export interface SchemaView {
  source: string;
  tables: Array<{ name: string; rows: number; columns: string[]; enums: Record<string, string[]> }>;
}

export interface SetupControls {
  newInvoices: 'auto' | 'confirm';
  refundsAutoUpTo: number;
  refundsPerDay: number;
  remindersPerDay: number;
  quietHours: { enabled: boolean; start: string; end: string; weekends: boolean };
  timezone: string;
  collections: { friendly: number; firm: number; final: number };
}

export interface SetupPreview {
  byKind: Record<string, number>;
  items: Array<{ kind: string; label: string; reason: string; policy: string }>;
  skipped: Array<{ label: string; reason: string }>;
  skippedTotal: number;
  invoices: {
    total: number;
    open: number;
    openAmount: number;
    toSend: number;
    toSendAmount: number;
    sample: Array<{
      number: string;
      customer: string;
      email: string;
      total: number;
      due: string | null;
      status: string;
      lines: number;
    }>;
  };
  currency: string;
}

export interface DigestDelivery {
  channel: string;
  status: 'sent' | 'failed' | 'skipped';
  detail: string;
}

export interface DigestInfo {
  schedule: {
    enabled: boolean;
    time: string;
    timezone: string;
    weekdaysOnly: boolean;
    lastSentAt: string | null;
    nextAt: string | null;
  };
  channels: {
    email: { configured: boolean; to: string[]; from: string | null; reason: string | null };
    slack: { configured: boolean };
  };
  history: Array<{
    id: number;
    createdAt: string;
    trigger: string;
    subject: string;
    deliveries: DigestDelivery[];
  }>;
}

export interface DigestPreview {
  subject: string;
  html: string;
  text: string;
  data: { note?: string; headline: string; approvalsTotal: number };
}

export interface CustomerRow {
  pk: string;
  name: string;
  email: string;
  openInvoices: number;
  balance: number;
  overdue: number;
  oldestDaysOverdue: number;
  lastPaymentAt: string | null;
  openRequests: number;
  behaviour: string | null;
  onTimeRate: number | null;
  portalUrl: string | null;
  lastStatement: string | null;
  autopay: 'active' | 'pending' | null;
}

export interface CustomerRequest {
  id: number;
  customerPk: string;
  legacyPk: string | null;
  kind: 'promise' | 'plan' | 'question';
  detail: string | null;
  until: string | null;
  installments: number | null;
  status: 'open' | 'done';
  createdAt: string;
}

export interface Terms {
  lateFee?: { kind: 'percent' | 'flat'; amount: number; afterDays: number; label: string };
  earlyDiscount?: { percent: number; withinDays: number };
}

export interface TermsInfo {
  terms: Terms;
  applied: Array<{
    id: number;
    legacyPk: string;
    kind: string;
    amount: number;
    until: string | null;
    detail: string | null;
  }>;
  due: Array<{
    legacyPk: string;
    number: string;
    customer: string;
    kind: string;
    amount: number;
    reason: string;
  }>;
}

export interface Order {
  id: string;
  paypalOrderId: string | null;
  channel: 'shop' | 'agent' | 'portal';
  status: string;
  items: Array<{ name: string; quantity: number; unitPrice: number }>;
  invoices: Array<{ legacyPk: string; number: string; amount: number }> | null;
  total: number;
  currency: string;
  buyer: { name?: string; email?: string; agent?: string; customerPk?: string } | null;
  fee: number | null;
  createdAt: string;
}

export interface ShopInfo {
  settings: { enabled: boolean; maxOrderTotal: number; maxQuantity: number; description?: string };
  hasCatalog: boolean;
  catalog: Array<{ id: string; name: string; description: string | null; price: number; currency: string }>;
  orders: Order[];
  shopUrl: string;
  mcpUrl: string;
}

export interface HostInfo {
  mode: 'single' | 'practice' | 'demo';
  workspaces: Array<{ id: string; business: string; consoleUrl: string; default: boolean }>;
}

export interface PracticeRow {
  id: string;
  business: string;
  consoleUrl: string;
  environment?: string;
  currency?: string;
  source?: string;
  openAmount?: number;
  overdue?: number;
  overdueAmount?: number;
  paidViaPayPalAmount?: number;
  expectedNext30?: number;
  atRisk?: number;
  pendingActions?: number;
  scheduledActions?: number;
  discrepancies?: number;
  requests?: number;
  sales?: number;
  attention?: number;
  linked?: number;
  invoices?: number;
  lastSyncAt?: string | null;
  lastDigestAt?: string | null;
  error?: string;
}

export interface DraftLine {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface InvoiceDraft {
  customer: { key?: string; name: string; email?: string };
  lines: DraftLine[];
  due?: string;
  notes?: string;
  questions: string[];
  engine: 'claude' | 'rules' | 'manual';
  warning?: string;
}

export interface NewInvoiceContext {
  business: string;
  currency: string;
  today: string;
  usualTermsDays: number;
  customers: Array<{ key: string; name: string; email: string }>;
  products: Array<{ name: string; price: number }>;
  claude: boolean;
  source: string;
}

export interface AddedInvoice {
  legacyPk: string;
  number: string;
  customerKey: string;
  newCustomer: boolean;
  total: number;
  status: string;
  due: string;
  actions: Action[];
  paypal?: { id: string; link?: string; status?: string };
}

export interface TodayNeed {
  id: string;
  tone: 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
  go?: string;
  run?: 'sync' | 'collections';
  label: string;
  items?: Array<{ label: string; sub?: string; amount?: number | null }>;
}

export interface TodayView {
  business: string;
  currency: string;
  environment: string;
  money: {
    owed: number;
    open: number;
    overdue: number;
    overdueCount: number;
    collected7d: number;
    collected7dCount: number;
    expected30: number;
    atRisk: number;
  };
  needs: TodayNeed[];
  recent: Array<{ at: string; text: string; kind: 'payment' | 'action' | 'customer' | 'order' }>;
  setup: { stage: string; done: number; total: number; next: string | null };
  autopay: { active: number };
}

export interface GoLiveCheck {
  id: string;
  title: string;
  status: 'done' | 'todo' | 'warn' | 'info';
  detail: string;
  fix?: { label: string; action?: 'sync' | 'register_webhook' | 'reconcile'; tab?: string; how?: string[] };
}

export interface GoLive {
  environment: string;
  stage: 'simulator' | 'sandbox' | 'live';
  done: number;
  total: number;
  checks: GoLiveCheck[];
}

export interface AutopayInfo {
  customers: Array<{
    customerPk: string;
    name: string;
    status: 'pending' | 'active' | 'off';
    payerEmail: string | null;
    maxAmount: number | null;
    lastError: string | null;
    lastChargeAt: string | null;
    updatedAt: string;
  }>;
  due: Array<{ legacyPk: string; number: string; customer: string; amount: number; due: string }>;
}

export interface InboxEmail {
  id: number;
  sender: string;
  senderName: string | null;
  subject: string | null;
  body: string;
  receivedAt: string;
  customerPk: string | null;
  reading: {
    intent: string;
    invoices: string[];
    summary: string;
    reply: string;
    engine: 'claude' | 'rules';
    payBy?: string;
    installments?: number;
    amount?: number;
    method?: string;
    warning?: string;
  } | null;
  status: 'new' | 'done' | 'needs_owner' | 'unknown_sender';
  outcome: { requests: string[]; actions: number[]; notes: string[] } | null;
  reply: string | null;
  repliedAt: string | null;
}

export interface Negotiation {
  id: string;
  customer: string;
  invoice: string;
  ask: { installments: number; intervalDays?: number; firstDue?: string };
  offer: { installments: number; intervalDays: number; firstDue: string; amounts: number[] } | null;
  status: 'agreed' | 'owner' | 'counter' | 'declined' | 'taken';
  reason: string;
  via: string | null;
  createdAt: string;
}

export interface RuleChange {
  type: string;
  explanation: string;
  [k: string]: unknown;
}

export interface RulesPreview {
  collections: Array<{ number: string; customer: string; before: string; after: string; reason: string }>;
  lateFees: { added: string[]; dropped: string[] };
  waiting: Array<{ id: number; label: string; before: string; after: string; reason: string }>;
  summary: string;
}

export interface ShadowReport {
  window: { from: string; to: string; days: number };
  assumption: string;
  invoices: number;
  sent: number;
  reminders: {
    total: number;
    onTheirOwn: number;
    needYou: number;
    heldByRules: number;
    quietHoursShifted: number;
  };
  lateFees: { count: number; amount: number };
  estimate: {
    overdueInvoices: number;
    avgDaysSooner: number;
    amountSooner: number;
    amountByToday: number;
    paidDateUnknown: number;
  };
  weeks: Array<{ week: string; sent: number; reminders: number; lateFees: number }>;
  examples: Array<{
    number: string;
    customer: string;
    amount: number;
    due: string;
    actualPaid: string | null;
    estimatedPaid: string | null;
    daysSooner: number;
    steps: Array<{ on: string; what: string; runs: string }>;
  }>;
}

export interface TrailStep {
  at: string;
  kind: string;
  by: string;
  title: string;
  detail?: string;
  status?: string;
}

export interface Bill {
  pk: string;
  number: string;
  payee: string;
  email: string;
  amount: number;
  due: string | null;
  description: string | null;
  status: string;
  state: 'open' | 'paid' | 'cancelled' | 'unknown';
  paidOn: string | null;
  daysToDue: number | null;
  check: { known: boolean; previousEmail: string | null; lastPaidOn: string | null; hold: string | null };
  payout: {
    batchId: string;
    status: string;
    receiver: string;
    transactionId: string | null;
    fee: number | null;
    error: string | null;
  } | null;
  action: { id: number; status: string; policyReason: string | null; result: any } | null;
}

export interface PayablesView {
  enabled: boolean;
  currency: string;
  table: string | null;
  bills: Bill[];
  totals: { open: number; dueThisWeek: number; overdue: number; paidThroughPayPal: number } | null;
}

export interface EvidenceDraft {
  summary: string;
  recommendation: 'contest' | 'offer_partial_refund' | 'accept';
  reasoning: string;
  response: string;
  evidenceType: string;
  evidence: Array<{ item: string; source: string; available: boolean }>;
  missing: string[];
}

export interface DisputeCase {
  disputeId: string;
  legacyPk: string | null;
  status: 'drafting' | 'ready' | 'proposed' | 'submitted' | 'failed';
  draft: EvidenceDraft | null;
  engine: 'claude' | 'records' | null;
  actionId: number | null;
  error: string | null;
  updatedAt: string;
}

export interface DisputeListItem {
  disputeId: string;
  legacyPk: string | null;
  number: string | null;
  customer: string | null;
  detail: string;
  openedAt: string;
  resolvedAt: string | null;
  resolution: string | null;
  case: DisputeCase | null;
  action: { id: number; status: string; policyReason: string | null; result: any } | null;
}

export interface EvidencePack {
  disputeId: string;
  status: string;
  stage: string | null;
  reasonText: string;
  amount: number;
  currency: string;
  openedAt: string | null;
  respondBy: string | null;
  buyerSays: string[];
  invoice: { number: string; issued: string | null; total: number } | null;
  customer: { name: string; paidBefore: number } | null;
  facts: Array<{ at: string | null; item: string; detail: string; source: string }>;
  channel: 'evidence' | 'message' | 'none';
}

/** Set when this console is one client of several, served under /c/<id> (multi-client mode and the demo). */
export const BASE = (window.location.pathname.match(/^\/c\/[^/]+/) ?? [''])[0];
/** Host-level APIs live at the root; everything else belongs to this workspace. */
const HOST_API = /^\/api\/(setup|host|practice)(\/|$)/;
export const u = (p: string) => (HOST_API.test(p) ? p : `${BASE}${p}`);

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(u(url), {
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
  resetDemo: () => req('POST', '/api/demo/reset'),
  demoDispute: (legacyPk: string) => req<any>('POST', '/api/demo/dispute', { legacyPk }),
  resetAgent: (sessionId: string) => req('POST', '/api/agent/reset', { sessionId }),
  runNow: (id: number) => req<Action>('POST', `/api/actions/${id}/run-now`),
  collections: () => req<CollectionItem[]>('GET', '/api/collections'),
  runCollections: (body: { ai?: boolean; only?: string[] }) =>
    req<{
      items: CollectionItem[];
      proposed: Array<{ item: CollectionItem; action: Action }>;
      writer: string;
    }>('POST', '/api/collections/run', body),
  insights: () => req<Insights>('GET', '/api/insights'),
  monthSummary: (month: string) => req<MonthSummary>('GET', `/api/month-summary?month=${month}`),
  journalUrl: (month: string, format: string) => u(`/api/export/journal.csv?month=${month}&format=${format}`),
  digest: () => req<DigestInfo>('GET', '/api/digest'),
  digestPreview: (ai: boolean) => req<DigestPreview>('GET', `/api/digest/preview${ai ? '?ai=1' : ''}`),
  sendDigest: (ai: boolean) =>
    req<{ id: number; subject: string; deliveries: DigestDelivery[] }>('POST', '/api/digest/send', { ai }),
  digestHtmlUrl: (id: number) => u(`/api/digest/${id}/html`),
  customers: () => req<CustomerRow[]>('GET', '/api/customers'),
  statement: (pk: string) =>
    req<{ statement: any; subject: string; html: string }>(
      'GET',
      `/api/customers/${encodeURIComponent(pk)}/statement`,
    ),
  sendStatement: (pk: string) =>
    req<Action>('POST', `/api/customers/${encodeURIComponent(pk)}/statement/send`),
  runStatements: () => req<Action[]>('POST', '/api/statements/run'),
  requests: () => req<CustomerRequest[]>('GET', '/api/requests'),
  resolveRequest: (id: number) => req('POST', `/api/requests/${id}/resolve`),
  outbox: () =>
    req<
      Array<{
        id: number;
        recipient: string;
        subject: string;
        status: string;
        detail: string | null;
        createdAt: string;
        customerPk: string | null;
      }>
    >('GET', '/api/outbox'),
  outboxHtmlUrl: (id: number) => u(`/api/outbox/${id}/html`),
  terms: () => req<TermsInfo>('GET', '/api/terms'),
  saveTerms: (t: Terms) => req<Terms>('PUT', '/api/terms', t),
  runTerms: () => req<Action[]>('POST', '/api/terms/run'),
  shop: () => req<ShopInfo>('GET', '/api/shop'),
  saveShop: (s: Partial<ShopInfo['settings']>) => req<ShopInfo['settings']>('PUT', '/api/shop', s),
  invoices: {
    context: () => req<NewInvoiceContext>('GET', '/api/invoices/new'),
    draft: (body: { text?: string; image?: { data: string; mediaType: string } }) =>
      req<InvoiceDraft>('POST', '/api/invoices/draft', body),
    add: (body: {
      customer: { key?: string; name: string; email?: string };
      lines: DraftLine[];
      due?: string;
      notes?: string;
      send?: boolean;
    }) => req<AddedInvoice>('POST', '/api/invoices', body),
  },
  today: () => req<TodayView>('GET', '/api/today'),
  inbox: () =>
    req<{
      emails: InboxEmail[];
      samples: Array<{ from: string; name?: string; subject?: string; text: string }>;
    }>('GET', '/api/inbox'),
  takeEmail: (e: { from: string; name?: string; subject?: string; text: string }) =>
    req<InboxEmail>('POST', '/api/inbox', e),
  replyEmail: (id: number, text?: string) =>
    req<{ status: string; detail: string }>('POST', `/api/inbox/${id}/reply`, { text }),
  negotiations: () => req<Negotiation[]>('GET', '/api/negotiations'),
  rules: () => req<{ sentences: string[] }>('GET', '/api/rules'),
  previewRules: (text: string) =>
    req<{
      changes: RuleChange[];
      unsupported: string[];
      engine: string;
      warning?: string;
      preview: RulesPreview;
    }>('POST', '/api/rules/preview', { text }),
  applyRules: (changes: RuleChange[]) =>
    req<{ sentences: string[] }>('POST', '/api/rules/apply', { changes }),
  shadow: (days: number, after: number) =>
    req<ShadowReport>('GET', `/api/shadow?days=${days}&after=${after}`),
  trail: (entity: string, pk: string) =>
    req<{ number: string | null; steps: TrailStep[] }>(
      'GET',
      `/api/trail/${entity}/${encodeURIComponent(pk)}`,
    ),
  payables: () => req<PayablesView>('GET', '/api/payables'),
  payBills: (pks: string[]) =>
    req<{ results: Array<{ pk: string; number?: string; action?: Action; error?: string }> }>(
      'POST',
      '/api/payables/pay',
      { pks },
    ),
  disputes: () => req<{ disputes: DisputeListItem[]; evidenceTypes: string[] }>('GET', '/api/disputes'),
  dispute: (id: string) =>
    req<{ pack: EvidencePack; case: DisputeCase | null; action: Action | null }>(
      'GET',
      `/api/disputes/${encodeURIComponent(id)}`,
    ),
  prepareDispute: (id: string) => req<DisputeCase>('POST', `/api/disputes/${encodeURIComponent(id)}/prepare`),
  proposeEvidence: (id: string, body: { response: string; evidenceType: string }) =>
    req<DisputeCase>('POST', `/api/disputes/${encodeURIComponent(id)}/evidence`, body),
  disputePdfUrl: (id: string) => u(`/api/disputes/${encodeURIComponent(id)}/evidence.pdf`),
  golive: () => req<GoLive>('GET', '/api/golive'),
  registerWebhook: () => req<{ id: string; url: string; events: number }>('POST', '/api/golive/webhook'),
  autopay: () => req<AutopayInfo>('GET', '/api/autopay'),
  runAutopay: () => req<Action[]>('POST', '/api/autopay/run'),
  autopayOff: (pk: string) => req('POST', `/api/autopay/${encodeURIComponent(pk)}/off`),
  slipUrl: (pk: string) => u(`/api/invoices/${encodeURIComponent(pk)}/slip`),
  qrUrl: (pk: string) => u(`/api/invoices/${encodeURIComponent(pk)}/qr.png`),
  host: () => req<HostInfo>('GET', '/api/host'),
  practice: () => req<PracticeRow[]>('GET', '/api/practice'),
  setup: {
    status: () => req<SetupStatus>('GET', '/api/setup/status'),
    source: (body: unknown) =>
      req<{ id: string; label: string; schema: SchemaView }>('POST', '/api/setup/sources', body),
    map: (id: string, body: { ai: boolean; currency?: string; timezone: string }) =>
      req<{ mapping: any; issues: any[]; warnings: string[]; engine: string }>(
        'POST',
        `/api/setup/sources/${id}/map`,
        body,
      ),
    mapping: (id: string) => req<{ mapping: any; schema: any }>('GET', `/api/setup/sources/${id}/mapping`),
    saveMapping: (id: string, m: unknown) => req<any>('PUT', `/api/setup/sources/${id}/mapping`, m),
    preview: (id: string, controls: SetupControls) =>
      req<SetupPreview>('POST', `/api/setup/sources/${id}/preview`, { controls }),
    finish: (id: string, body: unknown) =>
      req<{
        ok: boolean;
        configPath: string;
        consoleUrl: string;
        synced: { executed: number; pending: number } | null;
      }>('POST', `/api/setup/sources/${id}/finish`, body),
    sampleUrl: (f: string) => `/api/setup/samples/${encodeURIComponent(f)}`,
  },
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
  const r = await fetch(u('/api/agent/chat'), {
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
  submit_dispute_evidence: 'Submit dispute evidence',
  pay_supplier: 'Pay supplier',
  offer_payment_plan: 'Offer payment plan',
  apply_late_fee: 'Add late fee',
  expire_discount: 'End early-payment discount',
  send_statement: 'Send statement',
  charge_autopay: 'Charge autopay',
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
  payout_unclaimed: 'Payout not claimed yet',
  payout_failed: 'Payout failed',
};
