# Architecture

## Components

| Package | Responsibility |
| --- | --- |
| `core/adapters` | `SourceAdapter` for SQLite (`better-sqlite3`, separate read-only connection), Postgres (`pg`, read-only transactions for agent SQL), MySQL / MariaDB (`mysql2`, `ANSI_QUOTES` sessions, read-only transactions) and spreadsheet sources. Spreadsheets (CSV folders, Excel workbooks via `exceljs`, Google Sheets read as `.xlsx` through their share link) share `TabularAdapter`: headers become safe columns ("Invoice #" → `Invoice_no`), a key column is inferred (or the row position), and the data is loaded into in-memory SQLite. The owner's files are never changed: write-backs and new rows are kept in a changes file, replayed over the latest data whenever `refresh()` sees the source has changed (called before every sync), and written into a copy (`*.retrofit.csv`, or the same workbook with formatting kept as `*.retrofit.xlsx`). Every adapter can `insert` (new invoices) as well as `update`. Introspection returns tables, columns, keys, defaults, row counts, enum-like distinct values and masked sample rows. |
| `core/mapping` | Zod schema for `retrofit.map.json`; `validateMapping` checks it against the real schema (missing write-back columns are dropped with a warning, missing required columns are errors); `heuristicMapping` is the deterministic fallback mapper. |
| `core/paypal` | Thin typed REST client (OAuth client credentials, cached token, `PayPal-Request-Id` idempotency, `Prefer: return=representation`), payload builders for invoices, products, plans and subscriptions. |
| `core/engine` | `Retrofit`: planning, the action/policy gate, execution, write-back, state application. |
| `core/webhooks` | Signature verification, idempotent event storage, event routing. |
| `core/reconcile` | Full comparison of linked records with PayPal; auto-repair of missed payments; fee back-fill from Transaction Search; discrepancy lifecycle. |
| `core/policy` | Decides each action's mode: amount rules, per-kind policy, defaults, daily limits, quiet hours (time-zone and DST aware). Returns a human-readable reason. |
| `core/collections` | The collections playbook: remind / wait / hold / plan / escalate per open invoice, tone-appropriate templates, and `runCollections` which proposes the actions. |
| `core/insights` | Customer payment profiles, late-payment risk with factors, expected pay dates, the 9-week cash forecast, the payments journal, month-end summary and CSV / Xero / QuickBooks exports. |
| `core/ledger` | Joined legacy ↔ PayPal view and totals used by the console and the agents. |
| `core/state` | SQLite state store: `links`, `events`, `actions`, `discrepancies`, `meta`. |
| `agents` | Mapper (structured outputs), Ops (SDK tool runner), Support (structured outputs); tools for the engine and the PayPal Agent Toolkit bridge. |
| `server` | Express: `/webhooks/paypal`, `/api/*`, SSE `/api/stream`, `/mcp`, `/a/:token` approval pages, static console, optional basic auth. `host` wraps it so the active workspace can change at runtime (setup wizard); `setup` is the wizard's API; `digest` delivers the owner's digest. |
| `mcp` | MCP server over the engine tools: stdio (`paypal-retrofit mcp`) and stateless Streamable HTTP, with prompts and resources. |
| `core/terms` | Late fees and early-payment discounts: what is due, proposals, and the expected PayPal total (legacy total + adjustments) used by collections, risk, statements and reconciliation. |
| `core/statements` | Customer balances, statements with aging, rendering as email. |
| `core/commerce` | PayPal Orders checkout for the customer portal (several invoices), the shop and buyer agents; capture and booking. |
| `mcp/shop` | The public MCP server: catalogue search and checkout links for AI shopping agents, and account tools (`my_invoices`, `pay_my_invoices`, `tell_the_business`) for a customer's own assistant, identified by their portal link. |
| `core/new-invoice` | New invoices into the legacy system: the business's usual terms, next key and invoice number in its own pattern, its "ready to send" status, required columns it does not map filled sensibly, a new customer row when needed (or the customer on the invoice row, for one-sheet spreadsheets), line items; then a sync. Also the rule-based sentence reader used without Claude. |
| `agents/invoice-draft` | The invoice reader: a sentence or a photo (base64 image block) plus the business's customers and catalogue → structured draft with questions for the owner. |
| `core/autopay` | PayPal Vault: setup token → customer approval → payment token; `charge_autopay` actions for due invoices, charged as Orders with `vault_id` and booked like portal payments; collections hold for covered invoices; `VAULT.PAYMENT-TOKEN.DELETED` turns it off. |
| `core/qr` | PayPal's `generate-qr-code` for an invoice (base64 PNG, parsed defensively), with a local QR of the same pay link as the fallback. |
| `core/requests` | Customer requests (promise, plan, question) from the portal or a customer's assistant. |
| `core/golive` | The go-live checklist, computed from observed state: verified webhook events, payments received and written back, credentials that authenticate. |
| `core/today` | The owner's home screen: needs (approvals, requests, disputes, mismatches, invoices ready, reminders and autopay due, set-up), money this week and recent activity. |
| `server/widget` | `/widget.js` for the business's own website (Shadow DOM; Pay a bill, Pay buttons, catalogue), `/widget/lookup` and `/pay` (number + email, rate limited, CORS for lookups), `/llms.txt`, pay slips and QR images, and the demo's `/site`. |
| `core/digest` | Builds the owner's digest, renders it as HTML email, text and Slack Block Kit, signs and verifies approval-link tokens, decides when the scheduled digest is due. |
| `cli` | Commander CLI; `demo` mounts mock PayPal and Fernhill next to the console. |
| `mock-paypal` | In-memory PayPal stand-in with signed webhooks and buyer pages; used by tests and the offline demo. |

## Data flow

1. **init**: introspect → masked schema → Mapper agent (or heuristic) → validate → `retrofit.map.json`.
2. **sync**: read invoices whose legacy status is in `push`, plus already-linked ones → plan (`create_invoice`, `send_invoice`, `update_invoice`, `cancel_invoice`, `record_payment`, `create_subscription`) → each plan item becomes an action → policy decides → execute → write back.
3. **payment**: buyer pays → PayPal sends `PAYMENT.CAPTURE.COMPLETED` / `INVOICING.INVOICE.PAID` → verify signature → store event once → re-read the invoice from PayPal (never trust the payload alone) → write `status`, `paid_at`, `paid_amount` to the legacy row → 200.
4. **reconcile** (every 5 minutes in `serve`, on demand): re-read every linked invoice, apply its state (repairs missed webhooks), and open/close discrepancies.

## Setup wizard and workspaces

`createHost` holds the active `Retrofit` and its Express app. Before a config exists it serves only the console (which shows the wizard) and `/api/setup/*`. A setup session copies or receives CSVs into its own workspace folder (or records a SQLite path / Postgres URL when the server allows it), introspects it, asks the Mapper for a mapping, and previews `plan()` against an in-memory state store and a dummy PayPal client. `finish` writes the config and mapping and calls `activate`, which builds a new engine and server, stops the old one's timers and closes it. On `serve` the config goes where `-c` points and setup closes once configured; on the demo every wizard run gets its own workspace and invoice-number prefix, and **Reset demo** re-activates Fernhill.

## Customer portal, shop and buyer agents

Public, server-rendered routes in each workspace: `/p/:token` (portal), `/shop`, `/shop/catalog.json`, `/checkout/return` and `POST /mcp/shop`. A portal token is an HMAC-signed, 120-day link to one customer key. Paying several invoices creates one PayPal order whose items are the invoices; after capture, retrofit records a PayPal payment against each invoice (idempotency key per order and invoice), refreshes them (write-back follows) and splits the capture fee by amount in the payments ledger. Shop and agent orders take items and prices from the product table only, are capped by `commerce.maxOrderTotal`, and are booked as `order` payments. `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` (with `supplementary_data.related_ids.order_id`) finalize orders, so a buyer who closes the tab is still captured. Portal requests are stored in `requests`; collections holds on open promises and questions and queues a plan offer for plan requests; late fees skip any invoice with an open request.

## Payment terms

The early-payment discount is added to new PayPal invoices as a fixed `invoice_discount.amount` while its window is open, recorded as a negative adjustment, and removed by `expire_discount` (policy auto) when the window closes. A late fee (`apply_late_fee`, policy confirm) adds an item to the PayPal invoice with `send_to_recipient`. Every place that compares amounts uses `expectedTotal = legacy total + applied adjustments`.

## Multi-client host

`createHost` holds a map of workspaces. In `single` mode one business sits at the root; in `practice` mode the root is an overview and every client is at `/c/<id>`; the demo mode keeps Fernhill at the root and adds Brightside (and wizard-made clients) at `/c/<id>`. The console detects `/c/<id>` and prefixes its API calls; host-level APIs (`/api/setup`, `/api/host`, `/api/practice`) stay at the root.

## Owner's digest

`buildDigest` reads payments since the last digest (`meta.digest.lastSentAt`), pending and scheduled actions, the collections plan, risk, forecast and discrepancies. `renderDigest` produces the email (table layout, inline styles), text and Slack blocks. Approval links are `/a/<base64url(id.expiry)>.<HMAC-SHA256 prefix>` signed with `RETROFIT_LINK_SECRET` or a secret kept in the state store; GET shows the action, POST approves or rejects through `Retrofit.approve` / `reject`. Each send is recorded in the `digests` table with per-channel results. The server checks every minute whether the digest is due (business time zone, weekdays, at most once per local day, within three hours of the set time).

## New invoices, from a sentence or a photo

`POST /api/invoices/draft` sends the text or a downscaled JPEG (at most 1600 px, from the browser) to the invoice reader with the business's customers and catalogue; without Claude, sentences go to `parseInvoiceText`. The owner edits the draft in the console. `POST /api/invoices` calls `addInvoice`, which introspects the source for keys and defaults, inserts the customer (if new), the invoice in the business's own numbering and "ready to send" status (or its draft status), and the line items, then runs a sync: `create_invoice` and `send_invoice` go through the policy gate like any other action, and write-back follows.

## Autopay

The portal's **Set up autopay** creates a Vault setup token (`usage_type: MERCHANT`, `customer_type: CONSUMER`, the customer's cap stored with it) and sends the customer to PayPal's approval link; the return URL exchanges it for a payment token. `runCollections` first calls `runAutopay`: for each customer on autopay, invoices that are due, open in PayPal, within the cap, not disputed, not on a plan and without an open request become `charge_autopay` actions (default policy `auto`; the owner's amount rules and daily limits apply). Execution creates an Order with `payment_source.paypal.vault_id` (PayPal completes it without the buyer) and books it like a portal payment: a PayPal payment recorded on the invoice, write-back, fee in the ledger. A failed charge is not retried; collections stop holding that invoice and remind as usual.

## Website and paper

`widget.js` is generated per workspace with its base URL. It mounts into Shadow DOM so the host site's CSS cannot break it. Lookups need both the invoice number and the customer's email and are limited to 20 per IP per 10 minutes; the response holds only that invoice's amount and status, its PayPal pay link and the customer's signed portal link. Pay slips and printed statements embed QR codes: PayPal's own for an invoice, a local one for the portal link.

## Payment plans

`offer_payment_plan` keeps the PayPal invoice as one invoice and turns on `configuration.partial_payment` with a minimum of one instalment, appending the schedule to the invoice note (customer notified). The schedule lives in the `plans` table. `PARTIALLY_PAID` updates write the running total back and report "instalment k of n"; `PAID` completes the plan. Collections reminds per instalment, and the forecast places instalments on their dates.

## Payments ledger

Every payment, refund and payment recorded outside PayPal is mirrored into the `payments` table from the invoice's `payments` and `refunds` transactions, keyed by the PayPal payment id. Fees come from `PAYMENT.CAPTURE.COMPLETED` (`seller_receivable_breakdown.paypal_fee`) and, if missing, from Transaction Search during reconciliation.

## Actions and policies

Every side effect is an `ActionRecord` with an origin (`sync`, `agent`, `dashboard`, `cli`, `reconcile`), a target, a payload, a human-readable reason and the policy that applied.

| Policy | Effect |
| --- | --- |
| `auto` | Executes immediately. Defaults: create, send and update invoices. |
| `confirm` | Stored as `pending` until approved in the console, CLI or chat. Defaults: reminders, cancellations, recorded payments, refunds, subscriptions. |
| `never` | Recorded as rejected. Default: accepting disputes. |

On top of the per-kind policy:

- **Rules** (`rules` in the mapping) pick a mode by amount, for example refunds up to 100 run automatically. The first matching rule wins.
- **Limits** (`limits`) cap what runs automatically per day in the business time zone, by count or amount; over the cap, "auto" becomes "confirm".
- **Quiet hours** (`quietHours`) hold customer-facing kinds (reminders, payment-plan offers) until business hours: the action becomes `scheduled` with `run_after`, and the server runs due actions every minute. `approve --force` (Send now) skips the hold.

Each action stores its `amount` and a `policy_reason` such as "Daily limit: 480.00 of 500.00 USD in refunds already ran today; this 40.00 needs approval".

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
actions(id, origin, kind, target, payload, reason, policy, status, created_at, decided_at, result, dedupe_key,
        policy_reason, amount, run_after)
discrepancies(id, entity, legacy_pk, paypal_id, kind, detail, suggestion, detected_at, resolved_at, resolution)
meta(key, value)
plans(legacy_pk, paypal_id, installments, installment_amount, total, schedule, status, created_at, updated_at)
payments(id, entity, legacy_pk, paypal_id, kind, gross, fee, net, currency, method, occurred_at, recorded_at)
digests(id, created_at, trigger, subject, deliveries, html, text)
adjustments(id, legacy_pk, kind, amount, status, detail, until, created_at, updated_at)
requests(id, customer_pk, legacy_pk, kind, detail, until, installments, status, created_at, resolved_at)
orders(id, paypal_order_id, channel, status, items, invoices, total, currency, buyer, approve_url, capture_id, fee, created_at, updated_at)
outbox(id, kind, customer_pk, recipient, subject, html, text, status, detail, created_at)
autopay(customer_pk, status, setup_token_id, payment_token_id, paypal_customer_id, payer_email, max_amount, last_error, last_charge_at, created_at, updated_at)
```

## Security notes

- Secrets come only from the environment; the YAML config never holds them. Logs redact tokens, secrets and emails.
- Personal data sent to Claude is masked (emails, phone digits, street numbers) in schema samples and tool results.
- Agent SQL is checked to be a single SELECT/WITH and runs on a read-only connection or read-only transaction.
- The console can be protected with HTTP basic auth (`RETROFIT_DASHBOARD_PASSWORD`); the webhook and health endpoints stay public.
- `PRODUCTION` is refused unless `RETROFIT_ALLOW_LIVE=1`.
- The setup wizard never accepts PayPal or Anthropic secrets; on the public demo it accepts only CSV uploads (5 MB, 12 files) and the sample, never server paths.
- Approval links expire after 48 hours, are bound to one action, and do nothing on GET. `/mcp` requires `RETROFIT_MCP_TOKEN` when the console has a password; MCP approvals are off unless enabled.
