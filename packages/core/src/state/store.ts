import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionKind, ActionOrigin, ActionRecord, ActionTarget, PolicyMode, Row } from '../types.ts';

export interface LinkRecord {
  entity: string;
  legacyPk: string;
  paypalId: string;
  paypalKind: string;
  payLink: string | null;
  paypalStatus: string | null;
  paypalAmount: number | null;
  paypalPaid: number | null;
  paypalPaidAt: string | null;
  paypalTransactionId: string | null;
  sourceHash: string;
  createdAt: string;
  lastSyncedAt: string;
}

export interface DiscrepancyRecord {
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

export interface EventRecord {
  id: string;
  type: string;
  receivedAt: string;
  processedAt: string | null;
  status: 'received' | 'processed' | 'ignored' | 'failed';
  summary: string | null;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS links (
  entity TEXT NOT NULL, legacy_pk TEXT NOT NULL, paypal_id TEXT NOT NULL, paypal_kind TEXT NOT NULL,
  pay_link TEXT, paypal_status TEXT, paypal_amount REAL, paypal_paid REAL, paypal_paid_at TEXT, paypal_transaction_id TEXT,
  source_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_synced_at TEXT NOT NULL,
  PRIMARY KEY (entity, legacy_pk)
);
CREATE INDEX IF NOT EXISTS links_paypal ON links (paypal_id);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at TEXT NOT NULL, processed_at TEXT,
  status TEXT NOT NULL, summary TEXT, error TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, origin TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL,
  payload TEXT NOT NULL, reason TEXT NOT NULL, policy TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, decided_at TEXT, result TEXT, dedupe_key TEXT
);
CREATE INDEX IF NOT EXISTS actions_status ON actions (status);
CREATE TABLE IF NOT EXISTS discrepancies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, legacy_pk TEXT, paypal_id TEXT, kind TEXT NOT NULL,
  detail TEXT NOT NULL, suggestion TEXT, detected_at TEXT NOT NULL, resolved_at TEXT, resolution TEXT,
  UNIQUE (entity, legacy_pk, kind, resolved_at)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans (
  legacy_pk TEXT PRIMARY KEY, paypal_id TEXT NOT NULL, installments INTEGER NOT NULL, installment_amount REAL NOT NULL,
  total REAL NOT NULL, schedule TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, entity TEXT NOT NULL, legacy_pk TEXT NOT NULL, paypal_id TEXT NOT NULL, kind TEXT NOT NULL,
  gross REAL NOT NULL, fee REAL, net REAL, currency TEXT NOT NULL, method TEXT, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_at ON payments (occurred_at);
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, legacy_pk TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL,
  status TEXT NOT NULL, detail TEXT, until TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS adjustments_pk ON adjustments (legacy_pk);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, customer_pk TEXT NOT NULL, legacy_pk TEXT, kind TEXT NOT NULL,
  detail TEXT, until TEXT, installments INTEGER, status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, paypal_order_id TEXT, channel TEXT NOT NULL, status TEXT NOT NULL, items TEXT NOT NULL,
  invoices TEXT, total REAL NOT NULL, currency TEXT NOT NULL, buyer TEXT, approve_url TEXT, capture_id TEXT,
  fee REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_paypal ON orders (paypal_order_id);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, customer_pk TEXT, recipient TEXT NOT NULL,
  subject TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS writebacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, legacy_pk TEXT NOT NULL, kind TEXT NOT NULL,
  patch TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS writebacks_pk ON writebacks (entity, legacy_pk);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT NOT NULL, sender_name TEXT, subject TEXT, body TEXT NOT NULL,
  received_at TEXT NOT NULL, customer_pk TEXT, reading TEXT, status TEXT NOT NULL, outcome TEXT, reply TEXT,
  replied_at TEXT
);
CREATE TABLE IF NOT EXISTS negotiations (
  id TEXT PRIMARY KEY, customer_pk TEXT NOT NULL, legacy_pk TEXT NOT NULL, ask TEXT NOT NULL, offer TEXT,
  status TEXT NOT NULL, reason TEXT NOT NULL, action_id INTEGER, via TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS autopay (
  customer_pk TEXT PRIMARY KEY, status TEXT NOT NULL, setup_token_id TEXT, payment_token_id TEXT,
  paypal_customer_id TEXT, payer_email TEXT, max_amount REAL, last_error TEXT, last_charge_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, trigger TEXT NOT NULL, subject TEXT NOT NULL,
  deliveries TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payouts (
  batch_id TEXT PRIMARY KEY, item_id TEXT, legacy_pk TEXT NOT NULL, action_id INTEGER, receiver TEXT NOT NULL,
  payee TEXT, amount REAL NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, transaction_id TEXT, fee REAL,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payouts_bill ON payouts (legacy_pk);
CREATE TABLE IF NOT EXISTS acp_sessions (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, currency TEXT NOT NULL, items TEXT NOT NULL, buyer TEXT, fulfillment TEXT,
  order_id TEXT, agent TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acp_idempotency (
  scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, status INTEGER, body TEXT,
  in_flight INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (scope, key)
);
CREATE TABLE IF NOT EXISTS dispute_cases (
  dispute_id TEXT PRIMARY KEY, legacy_pk TEXT, status TEXT NOT NULL, draft TEXT, engine TEXT, action_id INTEGER,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const MIGRATIONS: Array<[table: string, column: string, ddl: string]> = [
  ['actions', 'policy_reason', 'ALTER TABLE actions ADD COLUMN policy_reason TEXT'],
  ['actions', 'amount', 'ALTER TABLE actions ADD COLUMN amount REAL'],
  ['actions', 'run_after', 'ALTER TABLE actions ADD COLUMN run_after TEXT'],
];

export interface PlanRecord {
  legacyPk: string;
  paypalId: string;
  installments: number;
  installmentAmount: number;
  total: number;
  schedule: Array<{ n: number; due: string; amount: number }>;
  status: 'active' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface AdjustmentRecord {
  id: number;
  legacyPk: string;
  kind: 'late_fee' | 'early_discount';
  /** Positive for fees, negative for discounts. */
  amount: number;
  status: 'applied' | 'removed';
  detail: string | null;
  /** For discounts: the last day it applies (YYYY-MM-DD). */
  until: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerRequestRecord {
  id: number;
  customerPk: string;
  legacyPk: string | null;
  kind: 'promise' | 'plan' | 'question';
  detail: string | null;
  /** For promises: the date the customer promised to pay by. */
  until: string | null;
  installments: number | null;
  status: 'open' | 'done';
  createdAt: string;
  resolvedAt: string | null;
}

export interface OrderRecord {
  id: string;
  paypalOrderId: string | null;
  channel: 'shop' | 'agent' | 'portal' | 'autopay';
  status: 'CREATED' | 'APPROVED' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  items: Array<{ productId?: string; legacyPk?: string; name: string; quantity: number; unitPrice: number }>;
  /** Portal orders: the invoices this payment covers. */
  invoices: Array<{ legacyPk: string; number: string; amount: number }> | null;
  total: number;
  currency: string;
  buyer: { name?: string; email?: string; agent?: string; customerPk?: string } | null;
  approveUrl: string | null;
  captureId: string | null;
  fee: number | null;
  createdAt: string;
  updatedAt: string;
}

/** One write retrofit made into the business's own system: which row, which columns, which values. */
export interface WritebackRecord {
  id: number;
  entity: string;
  legacyPk: string;
  kind: 'update' | 'insert';
  patch: Row;
  createdAt: string;
}

/** A customer email read by the inbox agent, and what came of it. */
export interface InboxRecord {
  id: number;
  sender: string;
  senderName: string | null;
  subject: string | null;
  body: string;
  receivedAt: string;
  customerPk: string | null;
  /** The structured reading (intent, invoices, dates, amounts, the drafted reply). */
  reading: Record<string, any> | null;
  status: 'new' | 'done' | 'needs_owner' | 'unknown_sender';
  /** What retrofit did: requests filed, actions proposed. */
  outcome: Record<string, any> | null;
  reply: string | null;
  repliedAt: string | null;
}

export interface PlanTerms {
  installments: number;
  intervalDays: number;
  /** YYYY-MM-DD */
  firstDue: string;
  /** Equal parts of the balance; the last one takes the rounding. */
  amounts: number[];
}

/** One payment-plan negotiation with a customer or their AI assistant. */
export interface NegotiationRecord {
  id: string;
  customerPk: string;
  legacyPk: string;
  ask: { installments: number; intervalDays?: number; firstDue?: string };
  offer: PlanTerms | null;
  /** agreed: plan set up; owner: waits for the owner; counter: an offer back; declined; expired. */
  status: 'agreed' | 'owner' | 'counter' | 'declined' | 'taken';
  reason: string;
  actionId: number | null;
  via: string | null;
  createdAt: string;
  updatedAt: string;
}

/** An Agentic Commerce Protocol checkout session (a buyer's agent buying from the catalogue). */
export interface AcpSessionRecord {
  id: string;
  status: 'ready_for_payment' | 'completed' | 'canceled';
  /** Lowercase ISO 4217, as ACP writes it. */
  currency: string;
  items: Array<{ id: string; quantity: number }>;
  buyer: Record<string, unknown> | null;
  fulfillment: Record<string, unknown> | null;
  /** The retrofit order (and so the PayPal order) behind the session. */
  orderId: string | null;
  agent: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

/** A PayPal Payouts batch retrofit sent for one bill. */
export interface PayoutRecord {
  batchId: string;
  itemId: string | null;
  legacyPk: string;
  actionId: number | null;
  receiver: string;
  payee: string | null;
  amount: number;
  currency: string;
  /** The item's PayPal status once known (SUCCESS, UNCLAIMED, ...); the batch's before that (PENDING). */
  status: string;
  transactionId: string | null;
  fee: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A response to a PayPal buyer dispute, drafted from the business's own records. */
export interface EvidenceDraft {
  /** What the buyer claims and what the records show. */
  summary: string;
  recommendation: 'contest' | 'offer_partial_refund' | 'accept';
  reasoning: string;
  /** Sent to PayPal with the evidence (at most 2,000 characters). */
  response: string;
  /** PayPal evidence_type, e.g. PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED. */
  evidenceType: string;
  evidence: Array<{ item: string; source: string; available: boolean }>;
  missing: string[];
}

/** What retrofit prepared for one buyer dispute. */
export interface DisputeCaseRecord {
  disputeId: string;
  legacyPk: string | null;
  /** drafting; ready: drafted, not proposed (not contested or failed to propose); proposed: waits for the owner; submitted. */
  status: 'drafting' | 'ready' | 'proposed' | 'submitted' | 'failed';
  draft: EvidenceDraft | null;
  engine: 'claude' | 'records' | null;
  actionId: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A customer's saved PayPal (PayPal Vault payment token) for paying invoices automatically. */
export interface AutopayRecord {
  customerPk: string;
  status: 'pending' | 'active' | 'off';
  setupTokenId: string | null;
  paymentTokenId: string | null;
  paypalCustomerId: string | null;
  payerEmail: string | null;
  /** The customer's cap per invoice; larger invoices are left for them to pay. */
  maxAmount: number | null;
  lastError: string | null;
  lastChargeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxRecord {
  id: number;
  kind: 'statement' | 'reply';
  customerPk: string | null;
  recipient: string;
  subject: string;
  status: 'sent' | 'outbox' | 'failed';
  detail: string | null;
  createdAt: string;
}

export interface DigestDelivery {
  channel: 'email' | 'slack' | 'outbox';
  status: 'sent' | 'failed' | 'skipped';
  detail: string;
}

export interface DigestRecord {
  id: number;
  createdAt: string;
  trigger: 'schedule' | 'manual';
  subject: string;
  deliveries: DigestDelivery[];
}

export interface PaymentRecord {
  id: string;
  entity: string;
  legacyPk: string;
  paypalId: string;
  kind: 'payment' | 'refund' | 'external_payment' | 'external_refund';
  gross: number;
  fee: number | null;
  net: number | null;
  currency: string;
  method: string | null;
  occurredAt: string;
  recordedAt: string;
}

const now = () => new Date().toISOString();

export class StateStore {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    for (const [table, column, ddl] of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) this.db.exec(ddl);
    }
  }

  // ---- links ----
  getLink(entity: string, legacyPk: string): LinkRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM links WHERE entity=? AND legacy_pk=?`).get(entity, legacyPk);
    return r ? toLink(r) : undefined;
  }
  findLinkByPayPalId(paypalId: string): LinkRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM links WHERE paypal_id=?`).get(paypalId);
    return r ? toLink(r) : undefined;
  }
  listLinks(entity?: string): LinkRecord[] {
    const rows = entity
      ? this.db.prepare(`SELECT * FROM links WHERE entity=? ORDER BY created_at`).all(entity)
      : this.db.prepare(`SELECT * FROM links ORDER BY created_at`).all();
    return rows.map(toLink);
  }
  upsertLink(
    l: Partial<LinkRecord> &
      Pick<LinkRecord, 'entity' | 'legacyPk' | 'paypalId' | 'paypalKind' | 'sourceHash'>,
  ): LinkRecord {
    const existing = this.getLink(l.entity, l.legacyPk);
    const merged: LinkRecord = {
      payLink: null,
      paypalStatus: null,
      paypalAmount: null,
      paypalPaid: null,
      paypalPaidAt: null,
      paypalTransactionId: null,
      createdAt: now(),
      ...existing,
      ...stripUndefined(l),
      lastSyncedAt: now(),
    } as LinkRecord;
    this.db
      .prepare(
        `INSERT INTO links (entity, legacy_pk, paypal_id, paypal_kind, pay_link, paypal_status, paypal_amount, paypal_paid, paypal_paid_at, paypal_transaction_id, source_hash, created_at, last_synced_at)
         VALUES (@entity,@legacyPk,@paypalId,@paypalKind,@payLink,@paypalStatus,@paypalAmount,@paypalPaid,@paypalPaidAt,@paypalTransactionId,@sourceHash,@createdAt,@lastSyncedAt)
         ON CONFLICT(entity, legacy_pk) DO UPDATE SET paypal_id=excluded.paypal_id, paypal_kind=excluded.paypal_kind, pay_link=excluded.pay_link,
           paypal_status=excluded.paypal_status, paypal_amount=excluded.paypal_amount, paypal_paid=excluded.paypal_paid,
           paypal_paid_at=excluded.paypal_paid_at, paypal_transaction_id=excluded.paypal_transaction_id,
           source_hash=excluded.source_hash, last_synced_at=excluded.last_synced_at`,
      )
      .run(merged);
    return merged;
  }

  // ---- events ----
  recordEvent(id: string, type: string, payload: unknown): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO events (id, type, received_at, status, payload) VALUES (?,?,?,?,?)`)
      .run(id, type, now(), 'received', JSON.stringify(payload));
    return r.changes > 0;
  }
  getEvent(id: string): EventRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM events WHERE id=?`).get(id) as any;
    return r ? toEvent(r) : undefined;
  }
  finishEvent(id: string, status: EventRecord['status'], summary: string | null, error?: string) {
    this.db
      .prepare(`UPDATE events SET status=?, summary=?, error=?, processed_at=? WHERE id=?`)
      .run(status, summary, error ?? null, now(), id);
  }
  listEvents(limit = 50): EventRecord[] {
    return (
      this.db.prepare(`SELECT * FROM events ORDER BY received_at DESC LIMIT ?`).all(limit) as any[]
    ).map(toEvent);
  }

  // ---- actions ----
  createAction(a: {
    origin: ActionOrigin;
    kind: ActionKind;
    target: ActionTarget;
    payload: Record<string, unknown>;
    reason: string;
    policy: PolicyMode;
    status: ActionRecord['status'];
    policyReason?: string | null;
    amount?: number | null;
    runAfter?: string | null;
  }): ActionRecord {
    const dedupe = `${a.kind}:${a.target.entity}:${a.target.legacyPk}`;
    if (a.status === 'pending' || a.status === 'scheduled') {
      const existing = this.db
        .prepare(`SELECT * FROM actions WHERE dedupe_key=? AND status IN ('pending','scheduled')`)
        .get(dedupe);
      if (existing) return toAction(existing);
    }
    const r = this.db
      .prepare(
        `INSERT INTO actions (origin, kind, target, payload, reason, policy, status, created_at, dedupe_key, policy_reason, amount, run_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        a.origin,
        a.kind,
        JSON.stringify(a.target),
        JSON.stringify(a.payload),
        a.reason,
        a.policy,
        a.status,
        now(),
        dedupe,
        a.policyReason ?? null,
        a.amount ?? null,
        a.runAfter ?? null,
      );
    return this.getAction(Number(r.lastInsertRowid))!;
  }
  /** Moves an action to "scheduled" (held until runAfter). */
  scheduleAction(id: number, runAfter: string, policyReason: string) {
    this.db
      .prepare(`UPDATE actions SET status='scheduled', run_after=?, policy_reason=? WHERE id=?`)
      .run(runAfter, policyReason, id);
  }
  setPolicyReason(id: number, policy: PolicyMode, policyReason: string) {
    this.db.prepare(`UPDATE actions SET policy=?, policy_reason=? WHERE id=?`).run(policy, policyReason, id);
  }
  /** Scheduled actions whose time has come. */
  listDue(nowIso: string): ActionRecord[] {
    return this.db
      .prepare(`SELECT * FROM actions WHERE status='scheduled' AND run_after <= ? ORDER BY run_after`)
      .all(nowIso)
      .map(toAction);
  }
  /** Executed actions of a kind since a time: count and summed amount. Used for daily limits. */
  executedSince(kind: ActionKind, sinceIso: string): { count: number; amount: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS a FROM actions WHERE kind=? AND status='executed' AND decided_at >= ?`,
      )
      .get(kind, sinceIso) as { n: number; a: number };
    return { count: r.n, amount: r.a };
  }
  /** All actions of a kind for one target, newest first. */
  actionsFor(kind: ActionKind, entity: string, legacyPk: string): ActionRecord[] {
    return this.db
      .prepare(`SELECT * FROM actions WHERE kind=? AND dedupe_key=? ORDER BY id DESC`)
      .all(kind, `${kind}:${entity}:${legacyPk}`)
      .map(toAction);
  }

  // ---- payment plans ----
  upsertPlan(p: Omit<PlanRecord, 'createdAt' | 'updatedAt'>): PlanRecord {
    const existing = this.getPlan(p.legacyPk);
    this.db
      .prepare(
        `INSERT INTO plans (legacy_pk, paypal_id, installments, installment_amount, total, schedule, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(legacy_pk) DO UPDATE SET paypal_id=excluded.paypal_id, installments=excluded.installments,
           installment_amount=excluded.installment_amount, total=excluded.total, schedule=excluded.schedule,
           status=excluded.status, updated_at=excluded.updated_at`,
      )
      .run(
        p.legacyPk,
        p.paypalId,
        p.installments,
        p.installmentAmount,
        p.total,
        JSON.stringify(p.schedule),
        p.status,
        existing?.createdAt ?? now(),
        now(),
      );
    return this.getPlan(p.legacyPk)!;
  }
  getPlan(legacyPk: string): PlanRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM plans WHERE legacy_pk=?`).get(legacyPk);
    return r ? toPlan(r) : undefined;
  }
  listPlans(status?: PlanRecord['status']): PlanRecord[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM plans WHERE status=? ORDER BY created_at`).all(status)
      : this.db.prepare(`SELECT * FROM plans ORDER BY created_at`).all();
    return rows.map(toPlan);
  }
  setPlanStatus(legacyPk: string, status: PlanRecord['status']) {
    this.db.prepare(`UPDATE plans SET status=?, updated_at=? WHERE legacy_pk=?`).run(status, now(), legacyPk);
  }

  // ---- payments ledger (gross / fee / net) ----
  /** Inserts a payment once; later calls only fill in a missing fee. */
  recordPayment(p: Omit<PaymentRecord, 'recordedAt' | 'net'> & { net?: number | null }) {
    const net = p.net ?? (p.fee != null ? Math.round((p.gross - p.fee) * 100) / 100 : null);
    this.db
      .prepare(
        `INSERT INTO payments (id, entity, legacy_pk, paypal_id, kind, gross, fee, net, currency, method, occurred_at, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET fee=COALESCE(payments.fee, excluded.fee), net=COALESCE(payments.net, excluded.net)`,
      )
      .run(
        p.id,
        p.entity,
        p.legacyPk,
        p.paypalId,
        p.kind,
        p.gross,
        p.fee,
        net,
        p.currency,
        p.method,
        p.occurredAt,
        now(),
      );
  }
  setPaymentFee(id: string, fee: number) {
    this.db
      .prepare(`UPDATE payments SET fee=?, net=ROUND(gross-?, 2) WHERE id=? AND fee IS NULL`)
      .run(fee, fee, id);
  }
  // ---- payment terms
  addAdjustment(a: Omit<AdjustmentRecord, 'id' | 'createdAt' | 'updatedAt' | 'status'>): number {
    const r = this.db
      .prepare(
        `INSERT INTO adjustments (legacy_pk, kind, amount, status, detail, until, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(a.legacyPk, a.kind, a.amount, 'applied', a.detail, a.until, now(), now());
    return Number(r.lastInsertRowid);
  }
  listAdjustments(legacyPk?: string, onlyApplied = true): AdjustmentRecord[] {
    const where = [legacyPk ? 'legacy_pk = @pk' : '', onlyApplied ? "status = 'applied'" : '']
      .filter(Boolean)
      .join(' AND ');
    return (
      this.db
        .prepare(`SELECT * FROM adjustments ${where ? `WHERE ${where}` : ''} ORDER BY id`)
        .all(legacyPk ? { pk: legacyPk } : {}) as any[]
    ).map((r) => ({
      id: r.id,
      legacyPk: r.legacy_pk,
      kind: r.kind,
      amount: r.amount,
      status: r.status,
      detail: r.detail,
      until: r.until,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
  removeAdjustment(id: number) {
    this.db.prepare(`UPDATE adjustments SET status='removed', updated_at=? WHERE id=?`).run(now(), id);
  }
  /** Net of applied fees and discounts on one invoice. */
  adjustmentTotal(legacyPk: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM adjustments WHERE legacy_pk=? AND status='applied'`)
      .get(legacyPk) as { t: number };
    return Math.round(r.t * 100) / 100;
  }

  // ---- customer requests (portal)
  addRequest(r: Omit<CustomerRequestRecord, 'id' | 'createdAt' | 'resolvedAt' | 'status'>): number {
    const res = this.db
      .prepare(
        `INSERT INTO requests (customer_pk, legacy_pk, kind, detail, until, installments, status, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(r.customerPk, r.legacyPk, r.kind, r.detail, r.until, r.installments, 'open', now());
    return Number(res.lastInsertRowid);
  }
  listRequests(
    opts: { status?: 'open' | 'done'; customerPk?: string; legacyPk?: string } = {},
  ): CustomerRequestRecord[] {
    const where: string[] = [];
    if (opts.status) where.push('status = @status');
    if (opts.customerPk) where.push('customer_pk = @customerPk');
    if (opts.legacyPk) where.push('legacy_pk = @legacyPk');
    return (
      this.db
        .prepare(
          `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`,
        )
        .all(opts) as any[]
    ).map((r) => ({
      id: r.id,
      customerPk: r.customer_pk,
      legacyPk: r.legacy_pk,
      kind: r.kind,
      detail: r.detail,
      until: r.until,
      installments: r.installments,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));
  }
  resolveRequest(id: number) {
    this.db.prepare(`UPDATE requests SET status='done', resolved_at=? WHERE id=?`).run(now(), id);
  }

  // ---- orders (shop, buyer agents, portal payments)
  saveOrder(o: Omit<OrderRecord, 'createdAt' | 'updatedAt'> & { createdAt?: string }) {
    this.db
      .prepare(
        `INSERT INTO orders (id, paypal_order_id, channel, status, items, invoices, total, currency, buyer, approve_url, capture_id, fee, created_at, updated_at)
         VALUES (@id, @paypalOrderId, @channel, @status, @items, @invoices, @total, @currency, @buyer, @approveUrl, @captureId, @fee, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET paypal_order_id=excluded.paypal_order_id, status=excluded.status,
           approve_url=excluded.approve_url, capture_id=excluded.capture_id, fee=excluded.fee, updated_at=excluded.updated_at`,
      )
      .run({
        ...o,
        items: JSON.stringify(o.items),
        invoices: o.invoices ? JSON.stringify(o.invoices) : null,
        buyer: o.buyer ? JSON.stringify(o.buyer) : null,
        createdAt: o.createdAt ?? now(),
        updatedAt: now(),
      });
  }
  getOrder(id: string): OrderRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM orders WHERE id=? OR paypal_order_id=?`).get(id, id);
    return r ? toOrder(r) : undefined;
  }
  listOrders(limit = 200): OrderRecord[] {
    return this.db.prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`).all(limit).map(toOrder);
  }

  // ---- customer messages (statements)
  addWriteback(entity: string, legacyPk: string, kind: WritebackRecord['kind'], patch: Row) {
    this.db
      .prepare(`INSERT INTO writebacks (entity, legacy_pk, kind, patch, created_at) VALUES (?,?,?,?,?)`)
      .run(entity, legacyPk, kind, JSON.stringify(patch), now());
  }
  listWritebacks(entity: string, legacyPk: string): WritebackRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM writebacks WHERE entity = ? AND legacy_pk = ? ORDER BY id`)
        .all(entity, legacyPk) as any[]
    ).map((r) => ({
      id: r.id,
      entity: r.entity,
      legacyPk: r.legacy_pk,
      kind: r.kind,
      patch: JSON.parse(r.patch),
      createdAt: r.created_at,
    }));
  }
  /** Webhook events whose payload mentions any of these PayPal ids. */
  eventsMentioning(ids: string[]): EventRecord[] {
    const wanted = ids.filter(Boolean);
    if (!wanted.length) return [];
    return (
      this.db
        .prepare(
          `SELECT id, type, received_at, processed_at, status, summary, error FROM events WHERE ${wanted.map(() => 'payload LIKE ?').join(' OR ')} ORDER BY received_at`,
        )
        .all(...wanted.map((w) => `%${w}%`)) as any[]
    ).map((r) => ({
      id: r.id,
      type: r.type,
      receivedAt: r.received_at,
      processedAt: r.processed_at,
      status: r.status,
      summary: r.summary,
      error: r.error,
    }));
  }

  addInbox(m: {
    sender: string;
    senderName?: string | null;
    subject?: string | null;
    body: string;
    receivedAt?: string;
  }) {
    const r = this.db
      .prepare(
        `INSERT INTO inbox (sender, sender_name, subject, body, received_at, status) VALUES (?,?,?,?,?, 'new')`,
      )
      .run(m.sender, m.senderName ?? null, m.subject ?? null, m.body, m.receivedAt ?? now());
    return Number(r.lastInsertRowid);
  }
  updateInbox(
    id: number,
    patch: Partial<
      Pick<InboxRecord, 'customerPk' | 'reading' | 'status' | 'outcome' | 'reply' | 'repliedAt'>
    >,
  ) {
    const cur = this.getInbox(id);
    if (!cur) return null;
    const n = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE inbox SET customer_pk=?, reading=?, status=?, outcome=?, reply=?, replied_at=? WHERE id=?`,
      )
      .run(
        n.customerPk,
        n.reading ? JSON.stringify(n.reading) : null,
        n.status,
        n.outcome ? JSON.stringify(n.outcome) : null,
        n.reply,
        n.repliedAt,
        id,
      );
    return this.getInbox(id);
  }
  getInbox(id: number): InboxRecord | null {
    const r = this.db.prepare(`SELECT * FROM inbox WHERE id = ?`).get(id) as any;
    return r ? toInbox(r) : null;
  }
  listInbox(limit = 100): InboxRecord[] {
    return (this.db.prepare(`SELECT * FROM inbox ORDER BY id DESC LIMIT ?`).all(limit) as any[]).map(toInbox);
  }

  saveNegotiation(n: Omit<NegotiationRecord, 'createdAt' | 'updatedAt'>) {
    this.db
      .prepare(
        `INSERT INTO negotiations (id, customer_pk, legacy_pk, ask, offer, status, reason, action_id, via, created_at, updated_at)
         VALUES (@id, @customerPk, @legacyPk, @ask, @offer, @status, @reason, @actionId, @via, @now, @now)
         ON CONFLICT(id) DO UPDATE SET offer=excluded.offer, status=excluded.status, reason=excluded.reason,
           action_id=excluded.action_id, updated_at=excluded.updated_at`,
      )
      .run({ ...n, ask: JSON.stringify(n.ask), offer: n.offer ? JSON.stringify(n.offer) : null, now: now() });
    return this.getNegotiation(n.id)!;
  }
  getNegotiation(id: string): NegotiationRecord | null {
    const r = this.db.prepare(`SELECT * FROM negotiations WHERE id = ?`).get(id) as any;
    return r ? toNegotiation(r) : null;
  }
  listNegotiations(limit = 100): NegotiationRecord[] {
    return (
      this.db.prepare(`SELECT * FROM negotiations ORDER BY created_at DESC LIMIT ?`).all(limit) as any[]
    ).map(toNegotiation);
  }

  saveAcpSession(s: Omit<AcpSessionRecord, 'updatedAt'>) {
    this.db
      .prepare(
        `INSERT INTO acp_sessions (id, status, currency, items, buyer, fulfillment, order_id, agent, created_at, updated_at, expires_at)
         VALUES (@id, @status, @currency, @items, @buyer, @fulfillment, @orderId, @agent, @createdAt, @now, @expiresAt)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, items=excluded.items, buyer=excluded.buyer,
           fulfillment=excluded.fulfillment, order_id=excluded.order_id, updated_at=excluded.updated_at`,
      )
      .run({
        ...s,
        items: JSON.stringify(s.items),
        buyer: s.buyer ? JSON.stringify(s.buyer) : null,
        fulfillment: s.fulfillment ? JSON.stringify(s.fulfillment) : null,
        now: now(),
      });
    return this.getAcpSession(s.id)!;
  }
  getAcpSession(id: string): AcpSessionRecord | null {
    const r = this.db.prepare(`SELECT * FROM acp_sessions WHERE id = ?`).get(id) as any;
    return r
      ? {
          id: r.id,
          status: r.status,
          currency: r.currency,
          items: JSON.parse(r.items),
          buyer: r.buyer ? JSON.parse(r.buyer) : null,
          fulfillment: r.fulfillment ? JSON.parse(r.fulfillment) : null,
          orderId: r.order_id,
          agent: r.agent,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          expiresAt: r.expires_at,
        }
      : null;
  }
  /** ACP idempotency keys: one row per (caller and endpoint, key), with the response once there is one. */
  getAcpIdempotency(scope: string, key: string) {
    const r = this.db
      .prepare(`SELECT * FROM acp_idempotency WHERE scope = ? AND key = ?`)
      .get(scope, key) as any;
    return r
      ? {
          fingerprint: r.fingerprint as string,
          inFlight: Boolean(r.in_flight),
          status: r.status as number | null,
          body: r.body ? JSON.parse(r.body) : null,
          createdAt: r.created_at as string,
        }
      : null;
  }
  /** Claims a key for a request; false when another request holds it already. */
  beginAcpIdempotency(scope: string, key: string, fingerprint: string): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO acp_idempotency (scope, key, fingerprint, in_flight, created_at) VALUES (?, ?, ?, 1, ?)`,
      )
      .run(scope, key, fingerprint, now());
    return r.changes === 1;
  }
  finishAcpIdempotency(scope: string, key: string, status: number, body: unknown) {
    this.db
      .prepare(`UPDATE acp_idempotency SET status = ?, body = ?, in_flight = 0 WHERE scope = ? AND key = ?`)
      .run(status, JSON.stringify(body), scope, key);
  }
  dropAcpIdempotency(scope: string, key: string) {
    this.db.prepare(`DELETE FROM acp_idempotency WHERE scope = ? AND key = ?`).run(scope, key);
  }
  purgeAcpIdempotency(beforeIso: string) {
    this.db.prepare(`DELETE FROM acp_idempotency WHERE created_at < ? AND in_flight = 0`).run(beforeIso);
  }

  savePayout(p: Partial<Omit<PayoutRecord, 'createdAt' | 'updatedAt'>> & { batchId: string }) {
    const prior = this.getPayout(p.batchId);
    const next = {
      itemId: null,
      actionId: null,
      payee: null,
      transactionId: null,
      fee: null,
      error: null,
      ...prior,
      ...p,
    } as Omit<PayoutRecord, 'createdAt' | 'updatedAt'>;
    this.db
      .prepare(
        `INSERT INTO payouts (batch_id, item_id, legacy_pk, action_id, receiver, payee, amount, currency, status, transaction_id, fee, error, created_at, updated_at)
         VALUES (@batchId, @itemId, @legacyPk, @actionId, @receiver, @payee, @amount, @currency, @status, @transactionId, @fee, @error, @now, @now)
         ON CONFLICT(batch_id) DO UPDATE SET item_id=excluded.item_id, status=excluded.status, transaction_id=excluded.transaction_id,
           fee=excluded.fee, error=excluded.error, updated_at=excluded.updated_at`,
      )
      .run({ ...next, now: now() });
    return this.getPayout(p.batchId)!;
  }
  getPayout(batchId: string): PayoutRecord | null {
    const r = this.db.prepare(`SELECT * FROM payouts WHERE batch_id = ?`).get(batchId) as any;
    return r ? toPayout(r) : null;
  }
  findPayoutByItem(itemId: string): PayoutRecord | null {
    const r = this.db.prepare(`SELECT * FROM payouts WHERE item_id = ?`).get(itemId) as any;
    return r ? toPayout(r) : null;
  }
  listPayouts(legacyPk?: string): PayoutRecord[] {
    const rows = legacyPk
      ? this.db.prepare(`SELECT * FROM payouts WHERE legacy_pk = ? ORDER BY created_at DESC`).all(legacyPk)
      : this.db.prepare(`SELECT * FROM payouts ORDER BY created_at DESC LIMIT 500`).all();
    return (rows as any[]).map(toPayout);
  }

  saveDisputeCase(c: Partial<Omit<DisputeCaseRecord, 'createdAt' | 'updatedAt'>> & { disputeId: string }) {
    const prior = this.getDisputeCase(c.disputeId);
    const next = {
      legacyPk: null,
      status: 'drafting',
      draft: null,
      engine: null,
      actionId: null,
      error: null,
      ...prior,
      ...c,
    };
    this.db
      .prepare(
        `INSERT INTO dispute_cases (dispute_id, legacy_pk, status, draft, engine, action_id, error, created_at, updated_at)
         VALUES (@disputeId, @legacyPk, @status, @draft, @engine, @actionId, @error, @now, @now)
         ON CONFLICT(dispute_id) DO UPDATE SET legacy_pk=excluded.legacy_pk, status=excluded.status, draft=excluded.draft,
           engine=excluded.engine, action_id=excluded.action_id, error=excluded.error, updated_at=excluded.updated_at`,
      )
      .run({
        disputeId: next.disputeId,
        legacyPk: next.legacyPk,
        status: next.status,
        draft: next.draft ? JSON.stringify(next.draft) : null,
        engine: next.engine,
        actionId: next.actionId,
        error: next.error,
        now: now(),
      });
    return this.getDisputeCase(c.disputeId)!;
  }
  getDisputeCase(disputeId: string): DisputeCaseRecord | null {
    const r = this.db.prepare(`SELECT * FROM dispute_cases WHERE dispute_id = ?`).get(disputeId) as any;
    return r ? toDisputeCase(r) : null;
  }
  listDisputeCases(limit = 100): DisputeCaseRecord[] {
    return (
      this.db.prepare(`SELECT * FROM dispute_cases ORDER BY created_at DESC LIMIT ?`).all(limit) as any[]
    ).map(toDisputeCase);
  }

  getAutopay(customerPk: string): AutopayRecord | null {
    const r = this.db.prepare(`SELECT * FROM autopay WHERE customer_pk = ?`).get(customerPk) as any;
    return r ? toAutopay(r) : null;
  }
  getAutopayByToken(paymentTokenId: string): AutopayRecord | null {
    const r = this.db.prepare(`SELECT * FROM autopay WHERE payment_token_id = ?`).get(paymentTokenId) as any;
    return r ? toAutopay(r) : null;
  }
  listAutopay(status?: AutopayRecord['status']): AutopayRecord[] {
    return (
      (status
        ? this.db.prepare(`SELECT * FROM autopay WHERE status = ? ORDER BY updated_at DESC`).all(status)
        : this.db.prepare(`SELECT * FROM autopay ORDER BY updated_at DESC`).all()) as any[]
    ).map(toAutopay);
  }
  saveAutopay(a: Partial<AutopayRecord> & { customerPk: string; status: AutopayRecord['status'] }) {
    const prev = this.getAutopay(a.customerPk);
    const next = {
      setupTokenId: null,
      paymentTokenId: null,
      paypalCustomerId: null,
      payerEmail: null,
      maxAmount: null,
      lastError: null,
      lastChargeAt: null,
      ...prev,
      ...a,
    };
    this.db
      .prepare(
        `INSERT INTO autopay (customer_pk, status, setup_token_id, payment_token_id, paypal_customer_id, payer_email, max_amount, last_error, last_charge_at, created_at, updated_at)
         VALUES (@customerPk, @status, @setupTokenId, @paymentTokenId, @paypalCustomerId, @payerEmail, @maxAmount, @lastError, @lastChargeAt, @createdAt, @updatedAt)
         ON CONFLICT(customer_pk) DO UPDATE SET status=excluded.status, setup_token_id=excluded.setup_token_id,
           payment_token_id=excluded.payment_token_id, paypal_customer_id=excluded.paypal_customer_id,
           payer_email=excluded.payer_email, max_amount=excluded.max_amount, last_error=excluded.last_error,
           last_charge_at=excluded.last_charge_at, updated_at=excluded.updated_at`,
      )
      .run({ ...next, createdAt: prev?.createdAt ?? now(), updatedAt: now() });
    return this.getAutopay(a.customerPk)!;
  }

  addOutbox(m: Omit<OutboxRecord, 'id' | 'createdAt'> & { html: string; text: string }): number {
    const r = this.db
      .prepare(
        `INSERT INTO outbox (kind, customer_pk, recipient, subject, html, text, status, detail, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(m.kind, m.customerPk, m.recipient, m.subject, m.html, m.text, m.status, m.detail, now());
    return Number(r.lastInsertRowid);
  }
  listOutbox(limit = 50): OutboxRecord[] {
    return (
      this.db
        .prepare(
          `SELECT id, kind, customer_pk, recipient, subject, status, detail, created_at FROM outbox ORDER BY id DESC LIMIT ?`,
        )
        .all(limit) as any[]
    ).map((r) => ({
      id: r.id,
      kind: r.kind,
      customerPk: r.customer_pk,
      recipient: r.recipient,
      subject: r.subject,
      status: r.status,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }
  getOutboxHtml(id: number): string | undefined {
    return (this.db.prepare(`SELECT html FROM outbox WHERE id=?`).get(id) as { html: string } | undefined)
      ?.html;
  }

  addDigest(d: {
    trigger: DigestRecord['trigger'];
    subject: string;
    deliveries: DigestDelivery[];
    html: string;
    text: string;
  }): number {
    const r = this.db
      .prepare(
        `INSERT INTO digests (created_at, trigger, subject, deliveries, html, text) VALUES (?,?,?,?,?,?)`,
      )
      .run(now(), d.trigger, d.subject, JSON.stringify(d.deliveries), d.html, d.text);
    return Number(r.lastInsertRowid);
  }
  listDigests(limit = 20): DigestRecord[] {
    return (
      this.db
        .prepare(`SELECT id, created_at, trigger, subject, deliveries FROM digests ORDER BY id DESC LIMIT ?`)
        .all(limit) as any[]
    ).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      trigger: r.trigger,
      subject: r.subject,
      deliveries: JSON.parse(r.deliveries),
    }));
  }
  getDigestHtml(id: number): string | undefined {
    return (this.db.prepare(`SELECT html FROM digests WHERE id=?`).get(id) as { html: string } | undefined)
      ?.html;
  }
  listPayments(fromIso?: string, toIso?: string): PaymentRecord[] {
    return this.db
      .prepare(`SELECT * FROM payments WHERE occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id`)
      .all(fromIso ?? '0000', toIso ?? '9999')
      .map(toPayment);
  }
  getAction(id: number): ActionRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM actions WHERE id=?`).get(id);
    return r ? toAction(r) : undefined;
  }
  listActions(status?: ActionRecord['status'], limit = 100): ActionRecord[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM actions WHERE status=? ORDER BY id DESC LIMIT ?`).all(status, limit)
      : this.db.prepare(`SELECT * FROM actions ORDER BY id DESC LIMIT ?`).all(limit);
    return rows.map(toAction);
  }
  finishAction(id: number, status: ActionRecord['status'], result: unknown) {
    this.db
      .prepare(`UPDATE actions SET status=?, result=?, decided_at=? WHERE id=?`)
      .run(status, JSON.stringify(result ?? null), now(), id);
  }

  // ---- discrepancies ----
  openDiscrepancy(d: {
    entity: string;
    legacyPk: string | null;
    paypalId: string | null;
    kind: string;
    detail: string;
    suggestion?: string;
  }) {
    const existing = this.db
      .prepare(
        `SELECT id FROM discrepancies WHERE entity=? AND IFNULL(legacy_pk,'')=IFNULL(?, '') AND kind=? AND resolved_at IS NULL`,
      )
      .get(d.entity, d.legacyPk, d.kind) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare(`UPDATE discrepancies SET detail=?, suggestion=?, paypal_id=? WHERE id=?`)
        .run(d.detail, d.suggestion ?? null, d.paypalId, existing.id);
      return existing.id;
    }
    return Number(
      this.db
        .prepare(
          `INSERT INTO discrepancies (entity, legacy_pk, paypal_id, kind, detail, suggestion, detected_at) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(d.entity, d.legacyPk, d.paypalId, d.kind, d.detail, d.suggestion ?? null, now()).lastInsertRowid,
    );
  }
  resolveDiscrepancy(id: number, resolution: string) {
    this.db
      .prepare(`UPDATE discrepancies SET resolved_at=?, resolution=? WHERE id=? AND resolved_at IS NULL`)
      .run(now(), resolution, id);
  }
  resolveDiscrepanciesFor(entity: string, legacyPk: string, kinds: string[] | 'all', resolution: string) {
    const open = this.listDiscrepancies(false).filter(
      (d) => d.entity === entity && d.legacyPk === legacyPk && (kinds === 'all' || kinds.includes(d.kind)),
    );
    for (const d of open) this.resolveDiscrepancy(d.id, resolution);
  }
  listDiscrepancies(includeResolved = false): DiscrepancyRecord[] {
    const rows = includeResolved
      ? this.db.prepare(`SELECT * FROM discrepancies ORDER BY detected_at DESC`).all()
      : this.db
          .prepare(`SELECT * FROM discrepancies WHERE resolved_at IS NULL ORDER BY detected_at DESC`)
          .all();
    return (rows as any[]).map((r) => ({
      id: r.id,
      entity: r.entity,
      legacyPk: r.legacy_pk,
      paypalId: r.paypal_id,
      kind: r.kind,
      detail: r.detail,
      suggestion: r.suggestion,
      detectedAt: r.detected_at,
      resolvedAt: r.resolved_at,
      resolution: r.resolution,
    }));
  }

  // ---- meta ----
  getMeta(key: string): string | undefined {
    return (this.db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as { value: string } | undefined)
      ?.value;
  }
  setMeta(key: string, value: string) {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  close() {
    this.db.close();
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function toLink(r: any): LinkRecord {
  return {
    entity: r.entity,
    legacyPk: r.legacy_pk,
    paypalId: r.paypal_id,
    paypalKind: r.paypal_kind,
    payLink: r.pay_link,
    paypalStatus: r.paypal_status,
    paypalAmount: r.paypal_amount,
    paypalPaid: r.paypal_paid,
    paypalPaidAt: r.paypal_paid_at,
    paypalTransactionId: r.paypal_transaction_id,
    sourceHash: r.source_hash,
    createdAt: r.created_at,
    lastSyncedAt: r.last_synced_at,
  };
}

function toEvent(r: any): EventRecord {
  return {
    id: r.id,
    type: r.type,
    receivedAt: r.received_at,
    processedAt: r.processed_at,
    status: r.status,
    summary: r.summary,
    error: r.error,
  };
}

function toAction(r: any): ActionRecord {
  return {
    id: r.id,
    origin: r.origin,
    kind: r.kind,
    target: JSON.parse(r.target),
    payload: JSON.parse(r.payload),
    reason: r.reason,
    policy: r.policy,
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    result: r.result ? JSON.parse(r.result) : null,
    policyReason: r.policy_reason ?? null,
    amount: r.amount ?? null,
    runAfter: r.run_after ?? null,
  };
}

function toPlan(r: any): PlanRecord {
  return {
    legacyPk: r.legacy_pk,
    paypalId: r.paypal_id,
    installments: r.installments,
    installmentAmount: r.installment_amount,
    total: r.total,
    schedule: JSON.parse(r.schedule),
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toPayment(r: any): PaymentRecord {
  return {
    id: r.id,
    entity: r.entity,
    legacyPk: r.legacy_pk,
    paypalId: r.paypal_id,
    kind: r.kind,
    gross: r.gross,
    fee: r.fee,
    net: r.net,
    currency: r.currency,
    method: r.method,
    occurredAt: r.occurred_at,
    recordedAt: r.recorded_at,
  };
}

function toOrder(r: any): OrderRecord {
  return {
    id: r.id,
    paypalOrderId: r.paypal_order_id,
    channel: r.channel,
    status: r.status,
    items: JSON.parse(r.items),
    invoices: r.invoices ? JSON.parse(r.invoices) : null,
    total: r.total,
    currency: r.currency,
    buyer: r.buyer ? JSON.parse(r.buyer) : null,
    approveUrl: r.approve_url,
    captureId: r.capture_id,
    fee: r.fee,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toAutopay(r: any): AutopayRecord {
  return {
    customerPk: r.customer_pk,
    status: r.status,
    setupTokenId: r.setup_token_id,
    paymentTokenId: r.payment_token_id,
    paypalCustomerId: r.paypal_customer_id,
    payerEmail: r.payer_email,
    maxAmount: r.max_amount,
    lastError: r.last_error,
    lastChargeAt: r.last_charge_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toInbox(r: any): InboxRecord {
  return {
    id: r.id,
    sender: r.sender,
    senderName: r.sender_name,
    subject: r.subject,
    body: r.body,
    receivedAt: r.received_at,
    customerPk: r.customer_pk,
    reading: r.reading ? JSON.parse(r.reading) : null,
    status: r.status,
    outcome: r.outcome ? JSON.parse(r.outcome) : null,
    reply: r.reply,
    repliedAt: r.replied_at,
  };
}

function toPayout(r: any): PayoutRecord {
  return {
    batchId: r.batch_id,
    itemId: r.item_id,
    legacyPk: r.legacy_pk,
    actionId: r.action_id,
    receiver: r.receiver,
    payee: r.payee,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    transactionId: r.transaction_id,
    fee: r.fee,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toDisputeCase(r: any): DisputeCaseRecord {
  return {
    disputeId: r.dispute_id,
    legacyPk: r.legacy_pk,
    status: r.status,
    draft: r.draft ? JSON.parse(r.draft) : null,
    engine: r.engine,
    actionId: r.action_id,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toNegotiation(r: any): NegotiationRecord {
  return {
    id: r.id,
    customerPk: r.customer_pk,
    legacyPk: r.legacy_pk,
    ask: JSON.parse(r.ask),
    offer: r.offer ? JSON.parse(r.offer) : null,
    status: r.status,
    reason: r.reason,
    actionId: r.action_id,
    via: r.via,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
