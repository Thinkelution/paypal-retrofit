# Devpost submission text

**Project name:** paypal-retrofit

**Tagline:** Give any existing business a PayPal brain: an open-source agent that retrofits PayPal into legacy systems and keeps them reconciled.

## Inspiration

Most small businesses already run on something: an old invoicing app, a booking tool, a spreadsheet, a homegrown ERP. PayPal's Agent Toolkit lets AI agents call PayPal, but nothing helps an agent connect PayPal to a system that was never built for it. So invoices get re-typed, payments get marked by hand, and the two sets of books drift apart.

## What it does

paypal-retrofit is an SDK, CLI and web console, plus a no-code setup wizard, an owner's morning digest and an MCP server. Point it at a SQLite or Postgres database, or a folder of CSV exports. Claude maps the schema to PayPal objects (customers, catalog products, invoices with line items, recurring agreements) and explains every choice. One sync sends open invoices through PayPal Invoicing with the business's own invoice numbers and writes the pay links back. Verified webhooks write payments back into the legacy system; a reconciler repairs anything a lost webhook missed and flags mismatches such as invoices marked paid by hand but still open in PayPal. An Ops agent answers receivables questions and proposes reminders, recorded payments, refunds and subscriptions, and a Support agent drafts dispute responses from the invoice records. Every side effect passes through a policy the owner sets: auto, confirm or never.

### Built for how small businesses actually get paid

- **Collections playbook.** Every morning each overdue invoice gets one decision with a reason: remind (friendly, firm, final), wait, hold (open dispute or a promise to pay), offer a payment plan, or call. Claude writes each reminder from the customer's history.
- **Payment plans on PayPal partial payments.** "Can I pay in two parts?" becomes instalments on the same PayPal invoice; retrofit tracks the schedule, reminds per instalment and writes the running total back.
- **Approval rules that think in money.** Small refunds run on their own, larger ones wait, daily caps stop runaway automation, and every action says which rule applied.
- **Quiet hours.** Reminders approved at night or at the weekend are scheduled for business hours in the business's time zone, daylight saving included.
- **Risk and cash forecast.** Late-payment risk per invoice and a 9-week forecast, learned from the business's own payment history and explained factor by factor.
- **Month-end close.** A payments ledger with gross, PayPal fee and net, exported for Xero or QuickBooks so the books match the payout.

### More than an SDK

- **No-code setup wizard.** Upload CSV exports (or connect SQLite / Postgres locally), let Claude map them, set the rules in plain words, preview exactly what the first sync will send, and go live. The running server switches to the new business without a restart.
- **Owner's morning digest.** Email or Slack every weekday: what came in (gross, fees, net), what is overdue, what waits for approval, who to call, what is at risk. Each waiting action has a signed, expiring Review link that opens an Approve / Reject page.
- **MCP server.** `paypal-retrofit mcp` (stdio) or `POST /mcp` (Streamable HTTP) gives Claude Desktop, Claude Code or any MCP client the same tools and the same policy gate as the built-in Ops agent, with prompts such as `morning_briefing` and `chase_overdue`.

### Around the business

- **Customer portal and statements.** Every customer gets a private link: all open invoices, pay several at once in one PayPal checkout (Orders API, recorded against each invoice), download a statement, promise a date, ask to pay in parts, or ask a question. Promises and questions hold reminders; plan requests queue a plan offer for the owner's approval.
- **Agentic commerce.** A shop page, a catalogue feed and a buyer-facing MCP server let new buyers, and their AI shopping agents, buy from the business's own catalogue. Prices come only from the business's data, orders are capped, and a person always approves the payment at PayPal; captured orders land in the books with their fees.
- **Late fees and early-payment discounts** as owner rules, applied to the PayPal invoice, explained to the customer, skipped for anyone on a plan, disputing or who promised a date, and understood by reconciliation.
- **Bookkeeper multi-client mode.** `paypal-retrofit practice` runs many client businesses in one process, with an overview of who needs attention and each client's console at `/c/<client>`.

## How we built it

- TypeScript monorepo: engine (`core`), agents, MCP server (official `@modelcontextprotocol/sdk`), Express server with the setup wizard API and digest delivery, React console, CLI, and a local PayPal mock for offline tests.
- PayPal: Invoicing v2 (create, send, remind, cancel, record payment/refund, search, invoice discounts), **Orders v2** (create, capture) for the portal, shop and agent checkouts, Payments v2 capture refunds, Catalog Products, Billing Plans and Subscriptions, Webhooks (create, verify signature, 17 event types), Disputes, Transaction Search, and the **PayPal Agent Toolkit**, whose read tools are bridged into Claude's tool runner.
- AI: Claude (`claude-opus-5-5`) through the official Anthropic SDK. Structured outputs for the Mapper and Support agents; the SDK tool runner for the Ops agent; server-side refusal fallback; masked personal data; read-only SQL.
- AG Grid Community for every table in the console, including editable mapping grids. Render Blueprint for hosting.

## Challenges

Making an agent useful with money without letting it move money. The answer was a deterministic engine with an action log and a policy gate: the agent's only write tool is `propose_action`. Idempotency everywhere (PayPal request ids, one link per legacy record, one application per webhook event) so reruns and retries never double-charge or double-send.

## What we learned

Retrofitting is mostly about state: what the old system believes, what PayPal believes, and what to do when they disagree. Reconciliation turned out to be the feature small businesses need most.

## What's next

Writing shop sales back into the legacy system as new invoices, multi-currency, a practice-wide digest for bookkeepers, and learning the best reminder timing per customer from what actually gets paid.

## Earlier ideas still on the list

More sources (MySQL, Google Sheets, QuickBooks exports), Orders-based checkout links for one-off sales, buyer-facing MCP tools so shoppers' agents can discover a retrofitted catalogue, and a hosted multi-tenant version.

## Built with

TypeScript, Node.js, Express, React, Vite, AG Grid, SQLite, PostgreSQL, PayPal REST APIs, PayPal Agent Toolkit, Anthropic Claude, Render.

## Tools used (AI)

Anthropic Claude (`claude-opus-5-5`) via the official `@anthropic-ai/sdk`: (1) the Mapper agent turns a database schema into a typed PayPal mapping with structured outputs; (2) the Ops agent uses the SDK tool runner with retrofit's engine tools and PayPal Agent Toolkit read tools; (3) the Support agent drafts dispute responses with structured outputs; (4) the reminder and digest writers draft customer reminders and the owner's morning note; (5) the MCP server lets the owner's own Claude (Desktop or Code) use the same tools under the same rules. Claude Code was used as a development assistant.

## Links

- Repository: https://github.com/Thinkelution/paypal-retrofit
- Website: https://thinkelution.github.io/paypal-retrofit/
- Hosted demo: TODO
- Video: TODO
