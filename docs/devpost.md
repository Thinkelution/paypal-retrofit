# Devpost submission text

**Project name:** paypal-retrofit

**Tagline:** Give any existing business a PayPal brain: an open-source agent that retrofits PayPal into legacy systems and keeps them reconciled.

## Inspiration

Most small businesses already run on something: an old invoicing app, a booking tool, a spreadsheet, a homegrown ERP. PayPal's Agent Toolkit lets AI agents call PayPal, but nothing helps an agent connect PayPal to a system that was never built for it. So invoices get re-typed, payments get marked by hand, and the two sets of books drift apart.

## What it does

paypal-retrofit is an SDK, CLI and web console. Point it at a SQLite or Postgres database, or a folder of CSV exports. Claude maps the schema to PayPal objects (customers, catalog products, invoices with line items, recurring agreements) and explains every choice. One sync sends open invoices through PayPal Invoicing with the business's own invoice numbers and writes the pay links back. Verified webhooks write payments back into the legacy system; a reconciler repairs anything a lost webhook missed and flags mismatches such as invoices marked paid by hand but still open in PayPal. An Ops agent answers receivables questions and proposes reminders, recorded payments, refunds and subscriptions, and a Support agent drafts dispute responses from the invoice records. Every side effect passes through a policy the owner sets: auto, confirm or never.

## How we built it

- TypeScript monorepo: engine (`core`), agents, Express server, React console, CLI, and a local PayPal mock for offline tests.
- PayPal: Invoicing v2 (create, send, remind, cancel, record payment/refund, search), Payments v2 capture refunds, Catalog Products, Billing Plans and Subscriptions, Webhooks (create, verify signature, 15 event types), Disputes, Transaction Search, and the **PayPal Agent Toolkit**, whose read tools are bridged into Claude's tool runner.
- AI: Claude (`claude-opus-5-5`) through the official Anthropic SDK. Structured outputs for the Mapper and Support agents; the SDK tool runner for the Ops agent; server-side refusal fallback; masked personal data; read-only SQL.
- AG Grid Community for every table in the console, including editable mapping grids. Render Blueprint for hosting.

## Challenges

Making an agent useful with money without letting it move money. The answer was a deterministic engine with an action log and a policy gate: the agent's only write tool is `propose_action`. Idempotency everywhere (PayPal request ids, one link per legacy record, one application per webhook event) so reruns and retries never double-charge or double-send.

## What we learned

Retrofitting is mostly about state: what the old system believes, what PayPal believes, and what to do when they disagree. Reconciliation turned out to be the feature small businesses need most.

## What's next

More sources (MySQL, Google Sheets, QuickBooks exports), Orders-based checkout links for one-off sales, an MCP server so buyer agents can discover a retrofitted catalogue, and a hosted multi-tenant version.

## Built with

TypeScript, Node.js, Express, React, Vite, AG Grid, SQLite, PostgreSQL, PayPal REST APIs, PayPal Agent Toolkit, Anthropic Claude, Render.

## Tools used (AI)

Anthropic Claude (`claude-opus-5-5`) via the official `@anthropic-ai/sdk`: (1) the Mapper agent turns a database schema into a typed PayPal mapping with structured outputs; (2) the Ops agent uses the SDK tool runner with retrofit's engine tools and PayPal Agent Toolkit read tools; (3) the Support agent drafts dispute responses with structured outputs. Claude Code was used as a development assistant.

## Links

- Repository: https://github.com/Thinkelution/paypal-retrofit
- Website: https://thinkelution.github.io/paypal-retrofit/
- Hosted demo: TODO
- Video: TODO
