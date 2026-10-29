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
`;

const now = () => new Date().toISOString();

export class StateStore {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
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
  }): ActionRecord {
    const dedupe = `${a.kind}:${a.target.entity}:${a.target.legacyPk}`;
    if (a.status === 'pending') {
      const existing = this.db
        .prepare(`SELECT * FROM actions WHERE dedupe_key=? AND status='pending'`)
        .get(dedupe);
      if (existing) return toAction(existing);
    }
    const r = this.db
      .prepare(
        `INSERT INTO actions (origin, kind, target, payload, reason, policy, status, created_at, dedupe_key) VALUES (?,?,?,?,?,?,?,?,?)`,
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
      );
    return this.getAction(Number(r.lastInsertRowid))!;
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
  };
}
