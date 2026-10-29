# Architecture

## Components

| Package | Responsibility |
| --- | --- |
| `core/adapters` | `SourceAdapter` for SQLite (`better-sqlite3`, separate read-only connection), Postgres (`pg`, read-only transactions for agent SQL) and CSV folders (loaded into in-memory SQLite; write-backs go to `<table>.retrofit.csv` sidecars). Introspection returns tables, columns, keys, row counts, enum-like distinct values and masked sample rows. |
| `core/mapping` | Zod schema for `retrofit.map.json`; `validateMapping` checks it against the real schema (missing write-back columns are dropped with a warning, missing required columns are errors); `heuristicMapping` is the deterministic fallback mapper. |
| `core/paypal` | Thin typed REST client (OAuth client credentials, cached token, `PayPal-Request-Id` idempotency, `Prefer: return=representation`), payload builders for invoices, products, plans and subscriptions. |
| `core/engine` | `Retrofit`: planning, the action/policy gate, execution, write-back, state application. |
| `core/webhooks` | Signature verification, idempotent event storage, event routing. |
| `core/reconcile` | Full comparison of linked records with PayPal; auto-repair of missed payments; discrepancy lifecycle. |
| `core/ledger` | Joined legacy ↔ PayPal view and totals used by the console and the agents. |
| `core/state` | SQLite state store: `links`, `events`, `actions`, `discrepancies`, `meta`. |
| `agents` | Mapper (structured outputs), Ops (SDK tool runner), Support (structured outputs); tools for the engine and the PayPal Agent Toolkit bridge. |
| `server` | Express: `/webhooks/paypal`, `/api/*`, SSE `/api/stream`, static console, optional basic auth. |
| `cli` | Commander CLI; `demo` mounts mock PayPal and Fernhill next to the console. |
| `mock-paypal` | In-memory PayPal stand-in with signed webhooks and buyer pages; used by tests and the offline demo. |

## Data flow

1. **init**: introspect → masked schema → Mapper agent (or heuristic) → validate → `retrofit.map.json`.
2. **sync**: read invoices whose legacy status is in `push`, plus already-linked ones → plan (`create_invoice`, `send_invoice`, `update_invoice`, `cancel_invoice`, `record_payment`, `create_subscription`) → each plan item becomes an action → policy decides → execute → write back.
3. **payment**: buyer pays → PayPal sends `PAYMENT.CAPTURE.COMPLETED` / `INVOICING.INVOICE.PAID` → verify signature → store event once → re-read the invoice from PayPal (never trust the payload alone) → write `status`, `paid_at`, `paid_amount` to the legacy row → 200.
4. **reconcile** (every 5 minutes in `serve`, on demand): re-read every linked invoice, apply its state (repairs missed webhooks), and open/close discrepancies.

## Actions and policies

Every side effect is an `ActionRecord` with an origin (`sync`, `agent`, `dashboard`, `cli`, `reconcile`), a target, a payload, a human-readable reason and the policy that applied.

| Policy | Effect |
| --- | --- |
| `auto` | Executes immediately. Defaults: create, send and update invoices. |
| `confirm` | Stored as `pending` until approved in the console, CLI or chat. Defaults: reminders, cancellations, recorded payments, refunds, subscriptions. |
| `never` | Recorded as rejected. Default: accepting disputes. |

Pending actions are de-duplicated per kind and target. Approvals re-read the legacy record, so they act on current data.

## Idempotency

- PayPal writes carry `PayPal-Request-Id` derived from the entity, legacy key and content hash (`retrofit-inv-<pk>-<hash>`), so retries never duplicate.
- `links` is keyed by `(entity, legacy_pk)`; a record is created in PayPal at most once. If PayPal reports `DUPLICATE_INVOICE_NUMBER` (for example after the state store was deleted), retrofit searches for the existing invoice and adopts it.
- Webhook events are stored by event id; duplicates are acknowledged without effect.

## Why agents never move money directly

The Ops agent has read tools (ledger, read-only SQL, PayPal Agent Toolkit reads) and exactly one write tool, `propose_action`. The engine decides whether that runs, waits, or is refused, and reports the real status back. The PayPal Agent Toolkit is configured with read actions only. This keeps the agent useful for the work it is good at (finding, explaining, drafting, batching) while the money-moving path stays deterministic, logged and approvable.

## State store schema

```sql
links(entity, legacy_pk, paypal_id, paypal_kind, pay_link, paypal_status, paypal_amount, paypal_paid,
      paypal_paid_at, paypal_transaction_id, source_hash, created_at, last_synced_at)
events(id, type, received_at, processed_at, status, summary, error, payload)
actions(id, origin, kind, target, payload, reason, policy, status, created_at, decided_at, result, dedupe_key)
discrepancies(id, entity, legacy_pk, paypal_id, kind, detail, suggestion, detected_at, resolved_at, resolution)
meta(key, value)
```

## Security notes

- Secrets come only from the environment; the YAML config never holds them. Logs redact tokens, secrets and emails.
- Personal data sent to Claude is masked (emails, phone digits, street numbers) in schema samples and tool results.
- Agent SQL is checked to be a single SELECT/WITH and runs on a read-only connection or read-only transaction.
- The console can be protected with HTTP basic auth (`RETROFIT_DASHBOARD_PASSWORD`); the webhook and health endpoints stay public.
- `PRODUCTION` is refused unless `RETROFIT_ALLOW_LIVE=1`.
