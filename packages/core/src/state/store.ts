import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionKind, ActionOrigin, ActionRecord, ActionTarget, PolicyMode } from '../types.ts';

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
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, trigger TEXT NOT NULL, subject TEXT NOT NULL,
  deliveries TEXT NOT NULL, html TEXT NOT NULL, text TEXT NOT NULL
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
  channel: 'shop' | 'agent' | 'portal';
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

export interface OutboxRecord {
  id: number;
  kind: 'statement';
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
