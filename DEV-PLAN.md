# paypal-retrofit — Development Plan

**Audience:** an autonomous coding agent that will build this project end to end.
**Owner:** Vivek Nalliah (Thinkelution). **Status:** v0.1 built on 2026-10-29 (see section 0).
**Date written:** 2026-10-29. **Hard deadline:** Thursday 2026-11-12, 12:00 pm Pacific (= Friday 2026-11-13, 01:30 IST). Treat **Wednesday 2026-11-11 end of day IST** as the internal deadline.

Read this whole document before writing code. Sections 1 and 2 are non-negotiable constraints. Section 3 onward is the design; you may improve details that do not contradict sections 1, 2 and 12 (decisions already made).

---

## 0. Build status (2026-10-29)

**Done and verified offline** (18 tests passing; typecheck, lint and build green; full flow clicked through in a browser against the bundled mock):

- Monorepo, MIT licence, CI workflow, `.env.example`.
- `examples/legacy-invoicer` (Fernhill Studio), mountable at `/fernhill`, deterministic seed with in-place reseed.
- `core`: SQLite / Postgres / CSV adapters, mapping schema + validation + heuristic mapper, PayPal REST client, state store, sync planner + policy-gated executor, write-back, webhook verification and routing, reconciliation, ledger.
- `mock-paypal`: in-memory PayPal stand-in with idempotency, signed webhooks, buyer pay/approve pages, disputes. Added beyond the plan so the project runs and is tested without accounts.
- `agents`: Mapper (structured outputs, heuristic fallback), Ops (SDK tool runner; PayPal Agent Toolkit read tools in sandbox, equivalent tools on the mock), Support (dispute drafts).
- `server`, `cli` (`init`, `sync`, `reconcile`, `actions`, `serve`, `chat`, `webhooks register`, `status`, `doctor`, `demo`), `dashboard` (AG Grid ledger, approvals, discrepancies, editable mapping, webhook activity, agent panel, record drawer, dispute draft).
- README, JUDGES, ARCHITECTURE, render.yaml, docs/demo-script.md, docs/devpost.md, scripts/sandbox-smoke.ts.

**Advanced features (added 2026-10-29, second pass; 27 tests):** collections playbook with AI-written reminders; payment plans on PayPal partial payments; approval rules by amount, daily limits and quiet hours with scheduled actions; late-payment risk, customer payment profiles and a 9-week cash forecast; a payments ledger with PayPal fees and CSV / Xero / QuickBooks exports. Scenarios and logic: docs/use-cases.md.

**Beyond the SDK (added 2026-10-30, third pass; 37 tests):** a no-code setup wizard in the console (CSV upload or sample data, Claude mapping, plain-language rules, first-sync preview, go live without a restart; `serve` opens it when no config exists; the demo has "Try your own data"); the owner's daily digest (email via SMTP, Slack webhook, console outbox; signed one-click approval links; optional Claude-written opening; scheduled per business time zone); an MCP server package (`paypal-retrofit mcp` on stdio, `POST /mcp` Streamable HTTP) exposing the engine tools, prompts and resources under the same policy gate. Sample data: `packages/server/samples/brightside-plumbing`.

**Around the business (added 2026-10-30, fourth pass; 43 tests):** payment terms (late fees, early-payment discounts as adjustments on the PayPal invoice, reconciled); customer portal per customer (signed link; multi-invoice payment through PayPal Orders recorded on each invoice; statement; promise / plan / question requests feeding collections) and customer statements (`send_statement`, outbox or SMTP); agentic commerce (catalogue from the product table, `/shop`, `catalog.json`, buyer MCP at `/mcp/shop`, Orders checkout with approval links, capture by webhook into the payments ledger); multi-client host (`practice --dir`, `/c/<id>`, `/api/practice` overview; the demo runs Fernhill and Brightside side by side). Mock PayPal gained Orders v2 and invoice discounts.

**Plug and play (added 2026-10-31, fifth pass; 54 tests):** Dockerfile (CI builds it and checks it serves), GitHub Codespaces dev container, Deploy to Render button; MySQL, Excel and Google Sheets sources, spreadsheet sources re-read on every sync with changes replayed over the owner's latest data; new invoices written into the legacy system from a sentence (rules) or a photo of a job sheet (Claude vision); website widget (Pay a bill, Pay buttons, catalogue), pay slips with PayPal QR codes, `llms.txt`; autopay with PayPal Vault (`charge_autopay`, 19 webhook events); account tools for a customer's own assistant on the public MCP server; go-live checklist; console rework: Today home, grouped sidebar, Ctrl+K, first-run tour.

**Changes from the plan:** the CLI runs TypeScript through `tsx` (no `tsup` build step); the Ops agent gets PayPal Agent Toolkit **read** tools only, and every write goes through `propose_action`; `demo` serves console, Fernhill and mock PayPal from one process, which is also what Render runs; the Postgres adapter is implemented but only exercised by typecheck, not by a live database test.

**Not done / not verified (owner action needed):**

1. Live PayPal sandbox: no credentials were available. Create the sandbox app (section 8), then run `pnpm smoke:sandbox` and `pnpm retrofit demo --sandbox` with a public HTTPS URL. Fix any request-body differences PayPal reports.
2. Live Claude calls: no `ANTHROPIC_API_KEY` was available. The agent loop is tested against a fake Messages API; run `init` and the agent panel with a real key and tune prompts.
3. Render deploy, `PAYPAL_WEBHOOK_ID`, JUDGES.md credentials, demo video, Devpost form (the TODO markers in JUDGES.md and docs/devpost.md). Done: public repo https://github.com/Thinkelution/paypal-retrofit (MIT detected) and landing page https://thinkelution.github.io/paypal-retrofit/ (GitHub Pages, deployed by .github/workflows/pages.yml).
4. APIMatic Context Plugin: not used yet; only claim it if it is used.
5. The owner-side MCP server is built (see above). The buyer-facing `expose` stretch (an MCP server so shoppers' agents can discover a catalogue) is not started.
6. Digest email and Slack delivery are tested against a local Slack stand-in only; send one real digest with `RETROFIT_SMTP_URL` / `RETROFIT_SLACK_WEBHOOK_URL` set, and connect Claude Code to `/mcp` on the hosted demo once it is deployed.

---

## 1. What we are entering and why

Hackathon: **PayPal AI Hackathon, "Build What's Next with PayPal and AI"** on Devpost.
URL: https://paypalaihackathon.devpost.com/ (rules: https://paypalaihackathon.devpost.com/rules)

**One-line pitch:** *paypal-retrofit* is an open-source SDK and CLI that lets an AI agent wire PayPal into a business that already exists (its own database, its own invoice numbers, its own customers) in minutes, and then keeps the two sides reconciled with an agent that never moves money without a human-approved rule.

**The gap we fill.** PayPal already ships the *Agent Toolkit* and an MCP server, which let an AI agent **call PayPal**. Nothing lets an agent **retrofit PayPal into an existing system**: discover the legacy data model, map it to PayPal objects, push invoices and subscriptions out, pull payments and disputes back in, and reconcile. That is the product.

**Target user:** a small or mid-size business (or the developer/agency serving it) with an existing invoicing, ERP, booking, LMS, CRM or custom app that has no PayPal integration yet, or only a manual one.

---

## 2. Hackathon requirements (must all be satisfied)

Everything below is copied from the Devpost page and official rules. Build to these; the judges check them.

### 2.1 Project requirements
- Build a **new** application that integrates the **PayPal developer platform using the free sandbox** together with an **AI tool, model or platform** of our choice. Our AI is Claude via the official Anthropic SDK (see section 12).
- The project must **meaningfully integrate at least one PayPal technology/API/SDK**, **meaningfully incorporate AI**, and **demonstrate a working prototype**. PayPal integration must be **central** to the project.
- Must be **sufficiently documented** for judges to understand and evaluate it.
- Any third-party SDK/API we use must be used within its licence terms.

### 2.2 Submission requirements (what goes on the Devpost form)
1. **Text description** of features and functionality.
2. **Functional demo** judges can actually run or interact with. Satisfy **both**:
   - clear, complete setup and run instructions in the repo, **and**
   - a hosted demo URL (we deploy on Render).
   A mockup, static prototype or non-functional demo fails.
3. **Tools section:** identify which AI model/service was used and explain how it was used.
4. **Public code repository** on GitHub, containing all source, assets and instructions. Must be **open source with a licence file detectable by GitHub** (shows in the About section). We use **MIT**, file name `LICENSE` at repo root.
5. **Demo video**: **under 3 minutes**, shows the project working on the platform it was built for (browser + terminal), uploaded to **YouTube, publicly visible**, link on the form. **No third-party trademarks, copyrighted music or material** we lack permission for. Do not present PayPal's logo as ours; showing the PayPal sandbox pages as part of the working flow is fine.
6. All materials in **English**.
7. Test access: include any sandbox logins/API keys needed to test in `JUDGES.md`. Judges may test, or may judge only from the description, images and video. The project must be free of charge and unrestricted for judges until the judging period ends (**2026-12-15**).

### 2.3 Dates
| Milestone | When |
|---|---|
| Submission period | 2026-10-01 09:15 PT to **2026-11-12 12:00 PT** |
| Judging | 2026-12-01 to 2026-12-15 |
| Winners announced | about 2026-12-21 |

Keep the hosted demo alive and the sandbox credentials valid until at least 2026-12-16.

### 2.4 Judging criteria (five, equally weighted)
Stage one is pass/fail: fits the theme and reasonably applies PayPal APIs/SDKs. Stage two:
1. **Technological implementation** – thorough, skilful use of PayPal platform and AI; genuine effort; working, non-trivial implementation.
2. **Design** – a complete, coherent product experience, not a technical proof of concept.
3. **Potential impact** – credible, specific case for solving a real problem for a real audience, and the demo actually addresses it.
4. **Innovation/idea** – creative, novel, different from existing concepts.
5. **Presentation** – video shows the project working end to end; pitch says what problem, for whom, why it matters; easy to follow.

Ties break in that order, so technological implementation matters most.

### 2.5 Prizes we target
- Grand prizes (1st $12k / 2nd $8k / 3rd $5k) and honourable mentions ($5k each): *Best Use of PayPal + AI*, *Most Impactful*, *Best Demo Delivery*, *Best Use of Agentic Commerce*, *Most Creative*.
- Sponsor prizes (a project may win one grand or one honourable mention **plus** one sponsor prize):
  - **AG Grid** (1st $5k, 2nd $2k, 3rd $1k ×3): we use **AG Grid Community (MIT)** for the reconciliation ledger and mapping review grid. Use it properly (sorting, filtering, cell renderers, row selection, editable cells for mapping overrides), not as a dumb table.
  - **Render** (credits): we deploy via a `render.yaml` Blueprint. Mention it in the README and video.
  - **APIMatic** ($1k ×3 + subscription): the APIMatic *Context Plugin* for PayPal is an MCP server for coding agents. Install it in the coding agent's environment while building (marketplace `apimatic/context-matic`, plugin `context-matic@apimatic`) and record in the README how it was used during development. If it cannot be installed, say so honestly in the README and do not claim it.
  - Postman is optional: if time permits, export a Postman collection for the retrofit HTTP API (section 6.6) into `docs/postman/`.

### 2.6 Eligibility notes
Individuals of legal age; teams; organisations. Not open to residents of sanctioned countries, PayPal/Devpost employees, judges. The entrant will be the owner above, entering as an individual or as Thinkelution. Prize payment may require a W-8BEN. Nothing here affects the build.

---

## 3. Product definition

### 3.1 Name and repo
- Product name: **paypal-retrofit**. Tagline: *"Give any existing business a PayPal brain."*
- Public GitHub repo: `paypal-retrofit` under the owner's account (create it as **public** from day one, MIT licence). The npm CLI name is `paypal-retrofit`; workspace packages are `@paypal-retrofit/*` (private, not published for the hackathon). Never use the `@paypal` npm scope or PayPal's logo/brand marks as our own.

### 3.2 User journey (this is also the video storyboard)
1. A business has a legacy app. For the demo: **Fernhill Studio**, a fictional small photography studio with an invoicing app (SQLite, Express, plain HTML). It has customers, services, invoices with line items, and recurring retainer agreements. Payment status is updated by hand.
2. The owner runs `npx paypal-retrofit init --source sqlite:./fernhill.db`.
3. The **Mapper agent** introspects the schema and sample rows, proposes a mapping to PayPal objects (customers → invoice recipients, services → catalog products, invoices → PayPal Invoices v2, retainers → subscription plans + subscriptions), explains each choice, and asks the owner to confirm or edit in the terminal. Result: `retrofit.config.yaml` plus `retrofit.map.json`.
4. `paypal-retrofit sync --once` pushes open invoices to PayPal (sandbox), sends them, and writes PayPal invoice IDs and pay links back to the legacy DB (only the columns the mapping allows).
5. A customer pays via the PayPal invoice link (sandbox buyer). PayPal sends a webhook → `paypal-retrofit serve` verifies it → the legacy invoice flips to `paid` with amount, fee, PayPal transaction ID and paid-at timestamp.
6. The **Retrofit dashboard** (AG Grid) shows the ledger: legacy record vs PayPal record, status, discrepancies, with filters and an "explain" action.
7. The **Ops agent** chat answers "Why is INV-1042 still unpaid?", "Send reminders for everything over 14 days overdue", "Draft a response to the dispute on INV-1038", using the PayPal Agent Toolkit tools plus read-only access to the legacy DB. Actions that move money or message customers require a confirmation (CLI prompt or dashboard button), or an explicit policy in `retrofit.config.yaml`.
8. Stretch: `paypal-retrofit expose` generates an MCP server from the mapping so buyer agents can discover the business's catalogue and create PayPal orders (the "agentic commerce" angle).

### 3.3 What "done" means (acceptance checklist)
- [ ] `npx paypal-retrofit init` works against the example SQLite app, against a Postgres database with the same schema, and against a CSV folder.
- [ ] Mapping proposal is produced by Claude with structured output, shown with rationale, editable, saved.
- [ ] `sync` creates and sends PayPal invoices in sandbox, idempotently (re-running does not duplicate), and writes back IDs/links.
- [ ] Webhook endpoint verifies signatures via PayPal's verify endpoint, is idempotent on event ID, and updates legacy records for invoice paid/cancelled/refunded, capture completed/refunded, subscription activated/cancelled/payment failed, dispute created/resolved.
- [ ] Reconciliation job lists discrepancies (in legacy not in PayPal, paid in PayPal not in legacy, amount mismatch) and they appear in the dashboard.
- [ ] Ops agent answers the three demo questions correctly against the seeded data, with the confirmation gate working.
- [ ] Dashboard: AG Grid ledger with filtering, sorting, status cell renderer, row detail, discrepancy highlighting; mapping review page with editable grid; agent chat panel.
- [ ] Hosted on Render: dashboard + API + the example legacy app, with the public webhook URL registered in the PayPal sandbox app.
- [ ] Tests pass in CI (GitHub Actions): unit tests for mapping schema, sync planner, webhook verification (mocked), reconciliation; one gated live sandbox smoke test.
- [ ] README, JUDGES.md, ARCHITECTURE.md, LICENSE (MIT), demo video script, Devpost text, all in the repo.
- [ ] Demo video recorded, under 3 minutes, on YouTube (public), link in README.
- [ ] Devpost submission form filled (section 11).

---

## 4. Architecture

```
+-------------------+         +-----------------------------+         +------------------+
| Legacy business   |  read   |  paypal-retrofit            |  REST   |  PayPal sandbox  |
| DB / CSV          | <-----> |  core engine (TypeScript)   | <-----> |  Invoicing v2    |
| (SQLite/Postgres) |  write- |  - adapters (source)        |         |  Catalog v1      |
|                   |  back   |  - mapping (map.json)       |         |  Subscriptions v1|
+-------------------+         |  - sync planner + executor  |         |  Orders v2       |
                              |  - webhook receiver         | <------ |  Webhooks v1     |
                              |  - reconciler               |         +------------------+
                              |  - state store (SQLite)     |
                              |  - agents (Claude)          |
                              |    * Mapper  * Ops          |
                              |    * Support (disputes)     |
                              +------+----------------+-----+
                                     |                |
                        CLI (init/sync/serve)   HTTP API + Dashboard (Vite+React+AG Grid)
```

Principles:
- **Deterministic engine moves money; agents propose and explain.** Every PayPal write goes through the engine with idempotency keys. Agents call engine tools or PayPal Agent Toolkit tools, and the side-effecting ones are gated (section 7.4).
- **Minimal intrusion.** We never alter the legacy schema. Write-backs are limited to columns named in the mapping (for example `invoices.status`, `invoices.paypal_invoice_id`, `invoices.paid_at`). If the legacy table lacks a column for an ID, we keep the link in our own state store and still work.
- **Sandbox only in v1.** `PAYPAL_ENVIRONMENT=PRODUCTION` is refused unless `RETROFIT_ALLOW_LIVE=1` is also set, and the README says live mode is untested.
- **Secrets never logged.** Redact tokens, client secrets and emails in logs.

---

## 5. Repository layout (pnpm workspaces, TypeScript, Node 20, ESM)

```
paypal-retrofit/
  LICENSE                      MIT
  README.md                    product README (section 10)
  JUDGES.md                    how to run + sandbox test accounts
  ARCHITECTURE.md
  DEV-PLAN.md                  this file (copy it in)
  render.yaml                  Render Blueprint (web service + example app)
  .github/workflows/ci.yml     lint, typecheck, test
  package.json                 workspaces, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    core/                      @paypal-retrofit/core
      src/paypal/              thin REST client + webhook verify + types
      src/mapping/             map.json zod schema, validation, defaults
      src/adapters/            SourceAdapter interface; sqlite, postgres, csv
      src/sync/                planner (diff legacy vs state) + executor
      src/webhooks/            event router → handlers → write-back
      src/reconcile/           periodic comparison, discrepancy model
      src/state/               SQLite state store (better-sqlite3)
      src/policy/              action policy (auto / confirm / never)
    agents/                    @paypal-retrofit/agents
      src/client.ts            Anthropic client factory
      src/mapper/              schema → mapping proposal (structured output)
      src/ops/                 tool-runner agent (PayPal toolkit + engine tools)
      src/support/             dispute response drafting
      src/tools/               engine tools exposed to agents; PayPal toolkit bridge
    cli/                       paypal-retrofit (bin)
      src/commands/            init, sync, serve, reconcile, chat, doctor, webhooks, expose (stretch)
    server/                    @paypal-retrofit/server (Express)
      src/routes/              /webhooks/paypal, /api/*, serves dashboard build
    dashboard/                 @paypal-retrofit/dashboard (Vite + React + AG Grid Community)
      src/pages/               Ledger, Mapping, Discrepancies, Agent
  examples/
    legacy-invoicer/           "Fernhill Studio" Express + SQLite app, seed script
    legacy-invoicer-postgres/  same schema for Postgres (seed.sql), optional
  docs/
    demo-script.md             3-minute video script
    devpost.md                 submission text, tools section, tagline
    postman/                   optional collection
  scripts/
    sandbox-smoke.ts           live sandbox end-to-end check (gated by env)
```

Tooling: `pnpm`, `typescript` strict, `tsup` for builds, `vitest`, `eslint` + `prettier`, `zod`, `commander` for the CLI, `@clack/prompts` for interactive prompts, `pino` for logging, `better-sqlite3`, `pg`, `csv-parse`, `express`, `yaml`, `dotenv`.

---

## 6. Component specifications

### 6.1 Source adapters (`core/src/adapters`)
```ts
interface SourceAdapter {
  kind: 'sqlite' | 'postgres' | 'csv';
  introspect(): Promise<SchemaDescription>;          // tables, columns, types, PK/FK, row counts, 5 sample rows per table (PII masked)
  query(sql: string, params?: unknown[]): Promise<Row[]>;   // read-only; reject non-SELECT
  readEntities(entity: EntityMapping, since?: Watermark): Promise<Row[]>;
  writeBack(entity: EntityMapping, pk: unknown, patch: Record<string, unknown>): Promise<void>;  // only allowed columns
  close(): Promise<void>;
}
```
- SQLite: `PRAGMA table_info`, `sqlite_master`, `PRAGMA foreign_key_list`.
- Postgres: `information_schema.columns`, `table_constraints`, `key_column_usage`.
- CSV: a folder of `*.csv`; headers → columns; types inferred; write-back writes a sidecar `*.retrofit.csv` rather than mutating the source.
- Connection string parsing: `sqlite:path`, `postgres://...`, `csv:folder`.
- PII masking for samples sent to the LLM: emails → `a***@domain`, phone → last 2 digits, names kept (needed for mapping), free text truncated to 60 chars.

### 6.2 Mapping (`core/src/mapping`)
`retrofit.map.json` (zod-validated):
```jsonc
{
  "version": 1,
  "currency": "USD",
  "entities": {
    "customer": { "table": "customers", "pk": "id",
      "fields": { "email": "email", "name": "full_name", "phone": "phone",
                  "address": { "line1": "addr1", "city": "city", "state": "state", "postal": "zip", "country": "country" } } },
    "product":  { "table": "services", "pk": "id",
      "fields": { "name": "name", "description": "description", "price": "unit_price" },
      "paypal": "catalog_product" },
    "invoice":  { "table": "invoices", "pk": "id",
      "fields": { "number": "invoice_no", "customer": "customer_id", "issued": "issued_on", "due": "due_on", "status": "status", "total": "total" },
      "lines": { "table": "invoice_items", "fk": "invoice_id",
                 "fields": { "product": "service_id", "description": "description", "qty": "quantity", "unitPrice": "unit_price" } },
      "statusMap": { "open": ["draft", "sent", "overdue"], "paid": ["paid"], "cancelled": ["void"] },
      "paypal": "invoice",
      "writeBack": { "paypalId": "paypal_invoice_id", "payLink": "paypal_link", "status": "status", "paidAt": "paid_at", "paidAmount": "paid_amount" },
      "filter": "status IN ('sent','overdue')" },
    "subscription": { "table": "retainers", "pk": "id",
      "fields": { "customer": "customer_id", "amount": "monthly_fee", "interval": "MONTH", "startedAt": "start_date", "status": "status" },
      "paypal": "subscription",
      "writeBack": { "paypalId": "paypal_subscription_id", "status": "status" } }
  },
  "policies": { "send_invoice": "auto", "send_reminder": "confirm", "create_refund": "confirm", "cancel_invoice": "confirm", "accept_dispute": "never" },
  "rationale": { "invoice.table": "invoices has invoice_no, due_on, total and a status enum; invoice_items references it via invoice_id" }
}
```
`retrofit.config.yaml` holds the source connection string, PayPal environment, webhook public URL, poll interval, and policy overrides. Secrets come only from env (`.env` supported via `dotenv`), never from the YAML.

### 6.3 PayPal client (`core/src/paypal`)
A small typed client over `fetch` against `https://api-m.sandbox.paypal.com` (or live), OAuth client-credentials token cached until `expires_in - 60s`. Endpoints used:
- **Invoicing v2:** `POST /v2/invoicing/invoices`, `POST /v2/invoicing/invoices/{id}/send`, `GET /v2/invoicing/invoices/{id}`, `POST /v2/invoicing/search-invoices`, `POST /v2/invoicing/invoices/{id}/remind`, `POST /v2/invoicing/invoices/{id}/cancel`, `POST /v2/invoicing/invoices/{id}/payments` (record external payment). We keep the legacy number in `detail.invoice_number`.
- **Catalog v1:** `POST /v1/catalogs/products`, `GET /v1/catalogs/products`.
- **Subscriptions v1:** `POST /v1/billing/plans`, `POST /v1/billing/subscriptions`, `GET /v1/billing/subscriptions/{id}`, `POST /v1/billing/subscriptions/{id}/cancel`.
- **Orders v2 (stretch, for `expose`):** `POST /v2/checkout/orders`, `POST /v2/checkout/orders/{id}/capture`.
- **Webhooks v1:** `POST /v1/notifications/verify-webhook-signature`, `POST /v1/notifications/webhooks` (used by `paypal-retrofit webhooks register --url ...` to create the webhook with the needed event list), `GET /v1/notifications/webhooks-events` (reconciler back-fill).
- **Reporting:** `GET /v1/reporting/transactions` (reconciler).

Use a `PayPal-Request-Id` header carrying our idempotency key on every POST that creates something. Verify every path and body against the official reference at https://developer.paypal.com/api/rest/ before coding; do not trust memory for request bodies.

Webhook verification request body: `auth_algo` (header `paypal-auth-algo`), `cert_url` (`paypal-cert-url`), `transmission_id` (`paypal-transmission-id`), `transmission_sig` (`paypal-transmission-sig`), `transmission_time` (`paypal-transmission-time`), `webhook_id` (env `PAYPAL_WEBHOOK_ID`), `webhook_event` (the raw JSON body, re-sent exactly). Only accept `verification_status === "SUCCESS"`. Keep the raw body (use `express.raw` for this route).

Events to subscribe and handle (verify names against https://developer.paypal.com/api/rest/webhooks/event-names/):
`INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.CANCELLED`, `INVOICING.INVOICE.REFUNDED`, `INVOICING.INVOICE.UPDATED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.DENIED`, `BILLING.SUBSCRIPTION.ACTIVATED`, `BILLING.SUBSCRIPTION.CANCELLED`, `BILLING.SUBSCRIPTION.SUSPENDED`, `BILLING.SUBSCRIPTION.PAYMENT.FAILED`, `PAYMENT.SALE.COMPLETED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`.

### 6.4 State store (`core/src/state`)
SQLite file at `.retrofit/state.db` (configurable). Tables:
- `links` (entity, legacy_pk, paypal_id, paypal_kind, pay_link, created_at, last_synced_at, hash_of_source_row)
- `events` (paypal_event_id PK, type, received_at, processed_at, status, error)
- `actions` (id, origin agent/cli/dashboard, kind, payload, policy, status pending/approved/executed/rejected, created_at, executed_at, result)
- `discrepancies` (id, entity, legacy_pk, paypal_id, kind, detail, detected_at, resolved_at)
- `watermarks` (entity, value)

### 6.5 Sync engine (`core/src/sync`)
- **Planner:** reads rows via adapter (respecting `filter` and watermark), computes a content hash, compares to `links`. Produces a plan: `create_invoice`, `send_invoice`, `update_invoice` (if hash changed and the PayPal invoice is still DRAFT/SENT and unpaid), `create_product`, `create_plan`, `create_subscription`, `noop`. Prints the plan as a table before executing (`--dry-run` prints only).
- **Executor:** runs plan items through the policy layer; `auto` executes, `confirm` creates a pending action (the CLI prompts inline when interactive, the dashboard shows an Approve button otherwise), `never` skips with a reason. Each PayPal write uses idempotency key `retrofit:{entity}:{legacy_pk}:{hash}`.
- **Write-back:** after success, writes PayPal ID, pay link and status to the legacy row via `writeBack` columns that exist; otherwise only to `links`.
- Invoice payload mapping: legacy number → `detail.invoice_number`; customer → `primary_recipients[0].billing_info`; lines → `items[]` with `unit_amount`; totals validated against legacy `total` (mismatch → discrepancy, not sent).

### 6.6 Server (`packages/server`)
Express app:
- `POST /webhooks/paypal`: verify, store event, route to handler, respond 200 only after processing (handlers must be fast; heavy work is queued in-process).
- `GET /api/ledger`: joined view legacy ↔ links ↔ latest PayPal status for the grid.
- `GET /api/discrepancies`, `POST /api/discrepancies/:id/resolve`.
- `GET /api/mapping`, `PUT /api/mapping` (edits from the dashboard grid; re-validated with zod).
- `GET /api/actions`, `POST /api/actions/:id/approve`, `POST /api/actions/:id/reject`.
- `POST /api/agent/chat`: streams the Ops agent response (SSE) and records proposed actions.
- `POST /api/sync/run`, `POST /api/reconcile/run`.
- Serves `dashboard/dist` statically. Basic auth via `RETROFIT_DASHBOARD_PASSWORD` for the hosted demo (credentials in JUDGES.md).

### 6.7 Dashboard (`packages/dashboard`)
Vite + React + TypeScript + **AG Grid Community** (`ag-grid-community`, `ag-grid-react`, MIT). Pages:
- **Ledger:** one row per legacy invoice/subscription. Columns: legacy number, customer, legacy status, legacy total, PayPal ID (link), PayPal status, PayPal paid amount, fee, paid at, last synced, discrepancy badge. Grid features used: column filters, quick filter, sorting, status cell renderer (coloured pills), row selection → detail drawer with raw legacy row and raw PayPal object side by side, "Explain with agent" button, bulk action "Send reminder" (goes through policy).
- **Mapping:** editable grid of entity/field → legacy column, with the rationale column from the Mapper agent; Save re-validates and writes `retrofit.map.json`.
- **Discrepancies:** grid with kind, detail, suggested fix (from agent), Resolve.
- **Agent:** chat panel with streaming replies, tool-call trace (collapsed), pending actions list with Approve/Reject.
Visual: clean, light/dark aware, no PayPal branding. Must look like a product, not a demo page (judging criterion "Design").

### 6.8 Example legacy app (`examples/legacy-invoicer`)
"Fernhill Studio" invoicing app: Express + SQLite + server-rendered HTML (plain CSS). Tables: `customers`, `services`, `invoices`, `invoice_items`, `retainers`. Seed: 12 customers, 8 services, 40 invoices (mix of draft/sent/overdue/paid/void across the last 90 days), 4 retainers. Pages: invoice list, invoice detail with a "Mark as paid" button (the manual process we replace). Includes `paypal_invoice_id`, `paypal_link`, `paid_at`, `paid_amount` columns **already present but empty** so write-back can be shown (and a README note that retrofit also works without them). Seed emails use the sandbox buyer's email for 3 invoices so a demo payment is possible.

### 6.9 CLI (`packages/cli`)
```
paypal-retrofit init --source <conn> [--yes] [--out retrofit.config.yaml]
paypal-retrofit sync [--once|--watch] [--dry-run] [--yes]
paypal-retrofit serve [--port 8787]            # webhooks + API + dashboard + watch sync
paypal-retrofit reconcile [--since 30d]
paypal-retrofit webhooks register --url https://.../webhooks/paypal
paypal-retrofit chat                           # Ops agent in the terminal
paypal-retrofit doctor                         # checks env, PayPal auth, source connection, webhook reachability
paypal-retrofit expose [--port 8790]           # stretch: MCP server for buyer agents
```
`init` flow: connect → introspect → Mapper agent proposes → render proposal as a table with rationale → interactive confirm/edit (or `--yes`) → write files → run `doctor`.

---

## 7. AI design (Claude via the official Anthropic SDK)

Before writing any LLM code, the coding agent must load the `claude-api` skill (`/claude-api`) and read its TypeScript README and tool-use docs. Rules that follow from it:
- Package: `@anthropic-ai/sdk`. Never use a Vercel AI SDK or OpenAI-compatible shim for Claude calls.
- Model: `claude-opus-5-5` by default, overridable with `RETROFIT_MODEL`. Thinking is adaptive by default; do not pass `budget_tokens`. Set `output_config.effort` explicitly (`"medium"` for ops chat, `"high"` for mapping).
- Enable server-side refusal fallbacks (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`).
- No forced `tool_choice`; use `auto` plus instructions. Always check `stop_reason` (`refusal`, `max_tokens`) before reading content.
- Stream long responses; use `finalMessage()` where events are not needed.
- Auth: `ANTHROPIC_API_KEY` env, or an active `ant auth login` profile; never prompt for a key in code.

### 7.1 Mapper agent (`agents/src/mapper`)
- Input: `SchemaDescription` (masked samples), the target entity catalogue (customer, product, invoice, invoice line, subscription), currency hints.
- Output: a `retrofit.map.json` candidate via **structured outputs** (`output_config.format` with the zod schema converted to JSON schema) plus a `rationale` map and a `confidence` per entity. Low-confidence entities are flagged for the user.
- One call, `effort: "high"`, `max_tokens` 16000. Cached, stable system prompt with the mapping rules and 2 worked examples; the schema goes in the user turn.
- Deterministic post-validation: tables/columns must exist; `pk` must be the real PK; `writeBack` columns must exist or be dropped with a warning; status values must appear in sample data.

### 7.2 Ops agent (`agents/src/ops`)
- Uses the SDK **tool runner** (`client.beta.messages.toolRunner` with `betaZodTool`).
- Tools:
  - **PayPal Agent Toolkit bridge:** import `PayPalAgentToolkit` from `@paypal/agent-toolkit/ai-sdk`, call `getTools()`, and convert each tool (`description`, zod `parameters`, `execute`) into a `betaZodTool`. This is the official PayPal toolkit doing the PayPal calls; keep the bridge in `agents/src/tools/paypal-toolkit.ts`. Enable invoices (list/get/search/send/sendReminder/cancel/recordPayment), disputes (list/get), subscriptions (list/show), reporting (list_transactions, get_merchant_insights). The toolkit takes `clientId`/`clientSecret` and a sandbox flag in its context; read its installed type definitions on day 1 and adapt the bridge.
  - **Engine tools (read):** `ledger.lookup(invoiceNumber | customer)`, `legacy.query(sql SELECT only, row cap 200)`, `discrepancies.list`, `links.get`.
  - **Engine tools (write, policy-gated):** `actions.propose({ kind, target, payload, reason })` is the only way the agent causes a side effect. The policy layer decides auto/confirm/never. The agent must say what it proposed and whether it needs approval.
- Side-effecting PayPal toolkit tools (send_invoice, send_invoice_reminder, cancel_sent_invoice, create_refund, accept_dispute_claim, cancel_subscription) are **wrapped** so they go through `actions.propose` instead of executing directly. Read-only toolkit tools execute directly.
- System prompt: role, the business context (name, currency, counts), the mapping summary, the policy table, "never invent IDs; look them up", "state amounts with currency", "summarise tool results, do not dump JSON".
- Chat history per session kept in memory on the server; prompt-caching breakpoint after the system prompt and tool list.

### 7.3 Support agent (`agents/src/support`)
Given a dispute (from `list_disputes`/`get_dispute`) and the linked legacy invoice, line items and any delivery notes, draft a dispute response and an evidence checklist. Pure text output; the human submits in PayPal. Shown in the dashboard dispute drawer.

### 7.4 Safety and policy
- Policy values: `auto`, `confirm`, `never`. Defaults in 6.2. `--yes` on the CLI and `RETROFIT_AUTO_APPROVE=1` on the demo server turn `confirm` into `auto` **only for the demo**; the README explains this.
- Agents never see secrets. Tool results are redacted (customer emails masked unless the policy `reveal_pii: true`).
- Every agent action is logged in `actions` with the model, prompt hash and tool trace.

### 7.5 Cost control
- Mapper: one call per `init`. Ops: `effort: "medium"`, `max_tokens` 8000, tool result rows capped. Cache the system prompt. Record `usage` per call in logs.

---

## 8. PayPal sandbox setup (do this on day 1 and document in JUDGES.md)
1. Log in at https://developer.paypal.com/ (owner's account). Under **Apps & Credentials → Sandbox**, create REST app `paypal-retrofit-sandbox`; copy Client ID and Secret to `.env` (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENVIRONMENT=SANDBOX`). The owner performs this step and supplies the values; the coding agent never pastes credentials into chat or into committed files.
2. Under **Testing Tools → Sandbox Accounts**, note the default business (seller) and personal (buyer) accounts; create one extra personal buyer named for the demo customer. Record emails and passwords in `JUDGES.md` (these are sandbox-only test accounts; the rules expect test credentials to be shared with judges).
3. Webhooks: once the Render URL exists, run `paypal-retrofit webhooks register --url https://<render-host>/webhooks/paypal` (creates the webhook via API with the event list in 6.3) and store the returned `PAYPAL_WEBHOOK_ID`. For local development use the dashboard **Webhook simulator** (Testing Tools) or an ngrok/cloudflared tunnel; document both.
4. Access token: `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` with Basic auth (client ID:secret) and body `grant_type=client_credentials`. The PayPal MCP server needs `PAYPAL_ACCESS_TOKEN`; our bridge uses client ID/secret directly.
5. Sandbox invoices: send with `send_to_recipient: true`; the buyer pays at the returned link by logging in with the sandbox personal account. Confirm this works manually before building the webhook path.

---

## 9. Timeline (14 days, IST). Each day ends with a commit on `main` and CI green.

| Day | Date | Deliverable |
|---|---|---|
| 1 | Thu 30 Oct | Repo public with MIT, monorepo scaffold, CI, PayPal sandbox app + accounts, thin PayPal client with OAuth + create/send invoice proven by a script. Example legacy app with seed running. |
| 2 | Fri 31 Oct | Adapters: sqlite + postgres introspection and read; CSV read. Mapping schema + validation. State store. |
| 3 | Sat 1 Nov | Mapper agent (structured output) + `init` command with interactive review. Works on the example DB. |
| 4 | Sun 2 Nov | Sync planner + executor for invoices (create/send/update), idempotency, write-back. `sync --dry-run` and `--once`. |
| 5 | Mon 3 Nov | Webhook receiver with signature verification, idempotent events, handlers for invoice/capture events → write-back. Local test via simulator + unit tests with recorded payloads. |
| 6 | Tue 4 Nov | `serve` command; Render deploy (web service + example app) via `render.yaml`; webhook registered; first end-to-end sandbox payment reflected in the legacy DB. |
| 7 | Wed 5 Nov | Reconciler + discrepancies. Subscriptions (plan + subscription create, activation/cancel events). |
| 8 | Thu 6 Nov | Ops agent with toolkit bridge, engine tools, policy gate, `chat` command. |
| 9 | Fri 7 Nov | Dashboard: Ledger + Mapping grids (AG Grid), detail drawer. API routes. |
| 10 | Sat 8 Nov | Dashboard: Discrepancies + Agent chat with streaming and approvals. Support agent dispute drafts. |
| 11 | Sun 9 Nov | Polish: `doctor`, error messages, README, JUDGES.md, ARCHITECTURE.md, docs/devpost.md. Stretch `expose` only if everything above is green. |
| 12 | Mon 10 Nov | Freeze features. Full fresh-clone run-through of JUDGES.md on a clean machine. Fix. Record video takes. |
| 13 | Tue 11 Nov | Final video edit + YouTube upload; Devpost submission filled and **submitted** (it can be edited until the deadline). |
| 14 | Wed 12 Nov | Buffer. Re-verify hosted demo and webhook. Do not start new work. |

If behind schedule at day 7, cut in this order: `expose` → Postgres adapter (keep SQLite + CSV) → Support agent → Discrepancies page (keep the API) → subscriptions.

---

## 10. Documentation deliverables

**README.md** sections: hero line + short GIF; problem; what it does (3 bullets); 2-minute quick start against the example app; how it works (diagram from section 4); CLI reference; mapping file reference; policies and safety; PayPal features used (list every API and toolkit feature, judges look for this); AI used (Claude model, where, and the guardrails); sponsor tools used (AG Grid, Render, APIMatic context plugin during development if actually used); hosted demo link + video link; limitations (sandbox only; not a compliance statement); licence.

**JUDGES.md:** exact steps to run locally in under 10 minutes, hosted URL + dashboard password, sandbox buyer login for paying a demo invoice, what to click to see the write-back, troubleshooting.

**ARCHITECTURE.md:** components, data flow, idempotency, policy layer, state store schema, why agents never move money directly.

**docs/demo-script.md** (target 2:40):
- 0:00–0:20 Problem: "Fernhill Studio sends invoices from a 2016 app and marks them paid by hand." Show the legacy UI.
- 0:20–0:50 `npx paypal-retrofit init`: schema discovered, Mapper proposes mapping with rationale, confirm.
- 0:50–1:20 `sync --once`: plan table, invoices created and sent in the PayPal sandbox, legacy rows now carry PayPal links.
- 1:20–1:50 Pay one invoice as the sandbox buyer; webhook arrives; legacy invoice flips to paid; ledger grid updates with fee and transaction ID.
- 1:50–2:20 Ops agent: "Why is INV-1042 unpaid?" → answer; "Send reminders for >14 days overdue" → proposed actions, approve in dashboard, reminders sent.
- 2:20–2:40 What it is (open source, MIT, works with SQLite/Postgres/CSV, built on the PayPal Agent Toolkit + Claude), where to get it. End card with repo URL.
Record at 1080p, terminal font at least 16pt, no music or royalty-free only, no third-party logos besides what the PayPal sandbox pages show as part of the flow.

---

## 11. Devpost submission (fill from `docs/devpost.md`)
- **Project name:** paypal-retrofit
- **Tagline:** Give any existing business a PayPal brain: an open-source agent that retrofits PayPal into legacy systems and keeps them reconciled.
- **Description:** problem, solution, how PayPal is used (Invoicing v2, Catalog, Subscriptions, Webhooks, Agent Toolkit, Reporting), how AI is used (Mapper, Ops, Support agents; policy gate), what we built during the period (everything; new project), challenges, what's next.
- **Built with:** TypeScript, Node, Express, React, Vite, AG Grid, SQLite, PostgreSQL, PayPal REST APIs, PayPal Agent Toolkit, Anthropic Claude, Render.
- **Tools used (required field):** "Anthropic Claude (claude-opus-5-5) via the official SDK for schema-to-PayPal mapping with structured outputs, and an operations agent using the SDK tool runner with PayPal Agent Toolkit tools. APIMatic Context Plugin used during development for PayPal SDK context (only if true). AG Grid Community for the ledger. Render for hosting."
- **Video link:** YouTube URL. **Repo link:** GitHub URL. **Hosted demo:** Render URL.
- Opt in to sponsor prizes: AG Grid, Render, and APIMatic if actually used.

---

## 12. Decisions already made (do not re-open)
1. Language/runtime: TypeScript, Node 20, pnpm workspaces, ESM.
2. AI: Claude through `@anthropic-ai/sdk`; default model `claude-opus-5-5`; PayPal Agent Toolkit tools bridged into the SDK tool runner.
3. PayPal surface for v1: Invoicing v2 (core), Webhooks, Catalog, Subscriptions, Reporting; Orders v2 only in the stretch `expose` command.
4. Sources for v1: SQLite, Postgres, CSV. No ORM; raw introspection queries.
5. Dashboard: Vite + React + AG Grid Community. Plain CSS modules, no UI framework.
6. Hosting: Render via Blueprint. Dashboard protected by basic auth for the hosted demo.
7. Licence: MIT. Repo public from day one. Conventional commits. Commit messages end with the `Co-Authored-By` line the coding agent's harness specifies.
8. Sandbox only; live mode gated and documented as untested.
9. Demo business: "Fernhill Studio" (fictional). No real customer data anywhere in the repo or video.
10. Scope cuts follow the order in section 9.
11. This is a fresh, standalone open-source project. Do not import code or data from the owner's other projects.

---

## 13. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Sandbox invoice send/pay flow flaky or slow | Prove it with a script on day 1; keep a recorded webhook payload set for tests and as video backup. |
| Webhook delivery to Render delayed during recording | Record the payment segment with the live webhook; keep `reconcile` as the visible fallback ("retrofit noticed it anyway"). |
| PayPal Agent Toolkit API shape differs from docs | Read `node_modules/@paypal/agent-toolkit` types on install; the bridge isolates differences. |
| Claude mapping wrong on odd schemas | Deterministic validation + interactive review; ship the example schema as the happy path. |
| Time | Daily cut list in section 9; feature freeze on day 12. |
| Licence detection on GitHub | Use the standard MIT text verbatim; check the About panel shows "MIT license". |

---

## 14. Reference links
- Hackathon: https://paypalaihackathon.devpost.com/ and https://paypalaihackathon.devpost.com/rules
- PayPal blog on the hackathon: https://developer.paypal.com/community/blog/PayPal_AI_Hackathon
- PayPal Agent Toolkit: https://github.com/paypal/agent-toolkit (TypeScript README under `typescript/`)
- PayPal MCP: https://mcp.paypal.com and https://developer.paypal.com/community/blog/paypal-model-context-protocol/
- PayPal REST reference: https://developer.paypal.com/api/rest/ (Invoicing v2, Catalog Products v1, Subscriptions v1, Orders v2, Webhooks v1, Transaction Search)
- Webhook verification: https://developer.paypal.com/api/rest/webhooks/rest/ ; event names: https://developer.paypal.com/api/rest/webhooks/event-names/
- Sandbox accounts: Developer Dashboard → Testing Tools → Sandbox Accounts
- APIMatic Context Plugin: https://www.apimatic.io/product/context-plugins (marketplace `apimatic/context-matic`)
- AG Grid Community (MIT): https://www.ag-grid.com/javascript-data-grid/licensing/
- Render Blueprints: https://render.com/docs/blueprint-spec
- Anthropic SDK: load the `claude-api` skill; docs at https://docs.anthropic.com
