# Devpost submission text

**Project name:** paypal-retrofit

**Tagline:** Give any existing business a PayPal brain: an open-source agent that retrofits PayPal into legacy systems and keeps them reconciled.

## Inspiration

Most small businesses already run on something: an old invoicing app, a booking tool, a spreadsheet, a homegrown ERP. PayPal's Agent Toolkit lets AI agents call PayPal, but nothing helps an agent connect PayPal to a system that was never built for it. So invoices get re-typed, payments get marked by hand, and the two sets of books drift apart.

## What it does

paypal-retrofit is an SDK, CLI and web console, plus a no-code setup wizard, an owner's morning digest and an MCP server. Point it at what the business already has: a SQLite, Postgres or MySQL database, CSV exports, an Excel workbook or a Google Sheet. Claude maps the schema to PayPal objects (customers, catalog products, invoices with line items, recurring agreements) and explains every choice. One sync sends open invoices through PayPal Invoicing with the business's own invoice numbers and writes the pay links back. Verified webhooks write payments back into the legacy system; a reconciler repairs anything a lost webhook missed and flags mismatches such as invoices marked paid by hand but still open in PayPal. An Ops agent answers receivables questions and proposes reminders, recorded payments, refunds and subscriptions, and a Support agent drafts dispute responses from the invoice records. Every side effect passes through a policy the owner sets: auto, confirm or never.

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

### Plug and play, easy to use

- **One click to run.** Open in GitHub Codespaces, Deploy to Render, or `docker run`. CI builds the container and checks it serves the console.
- **Any back office.** SQLite, Postgres, MySQL, CSV exports (a fresh export is picked up on the next sync), an Excel workbook (the owner's file is never changed; retrofit writes a copy with PayPal columns, formatting kept), or a Google Sheet share link. One sheet with everything works.
- **Today.** The console opens on the owner's day: what is owed, what came in, and each thing that needs them as one card with one button. A short tour on first visit, and Ctrl+K to jump, run or ask anything.
- **New invoices by sentence or photo.** "Invoice Maya Okafor 2 hours at $95 for retouching, due Friday", or a photo of a handwritten job sheet: Claude reads it (vision, structured output) against the business's own customers and catalogue and lists anything unclear. The owner checks the draft; retrofit writes it into their own system with their numbering and sends it through PayPal.
- **PayPal on their existing website.** One script tag adds Pay a bill (invoice number + email, then PayPal), Pay buttons and the catalogue. Pay slips and printed statements carry PayPal QR codes for paper invoices. `llms.txt` tells visiting AI assistants how to buy and pay.
- **Autopay.** Customers save PayPal once in their portal (PayPal Vault, optional cap per invoice); invoices are then paid on the due date under the owner's rules, collections stop chasing them, and a declined charge falls back to reminders.
- **The customer's own assistant.** With their portal link, a customer's Claude (or any MCP client) sees what they owe, pays several invoices in one PayPal checkout, or promises a date, asks for a plan or asks a question. A person approves every payment.
- **Go-live checklist.** Ten steps from the built-in simulator to the PayPal sandbox to live, each checked against what retrofit actually sees: a verified webhook event, a test payment, the paid status written back.

### An agent you can trust with more

- **Money trail.** Every invoice shows its whole story: who proposed each action and which rule let it run, each verified PayPal webhook, payments and fees, and exactly which columns retrofit wrote into the business's own system.
- **Rules in plain English, previewed.** "Refunds over $200 need me. Never chase schools before the 20th." Claude turns sentences into rules, says what it cannot do, and shows what changes today before anything is saved.
- **Shadow mode.** Replays the last 90 days of the business's own invoices through the rules, touching nothing: what would have been sent, every reminder and late fee, which would have waited for the owner, and an estimate of how much sooner money would have arrived, with the assumption stated.
- **Inbox agent.** Customer emails ("I'll pay Friday", "I posted a cheque", "can I split it?") become promises, plan requests, questions and drafted replies; anything that moves money waits for the owner, because an email can be forged.
- **Assistant-to-assistant payment plans.** A customer's AI assistant asks for a plan over MCP; inside the owner's limits it is agreed on the spot and the PayPal invoice takes instalments, outside them it gets a counter-offer.
- **Dispute evidence autopilot.** When a buyer opens a dispute, retrofit builds the evidence from the records, Claude drafts the response, and once the owner approves, PayPal receives the notes and a PDF of the records through the Disputes API.
- **Pay suppliers with PayPal Payouts.** Bills in the business's own system are paid to each payee's PayPal email. A new payee or a changed PayPal email (how invoice-redirect fraud works) always waits for the owner, and the bill is marked paid only when PayPal confirms.
- **Open checkout standard.** Any agent that speaks the Agentic Commerce Protocol can buy from the catalogue: discovery, checkout sessions with the protocol's idempotency rules, and its MCP binding, paid with a PayPal order the buyer approves.

## How we built it

- TypeScript monorepo: engine (`core`), agents, MCP server (official `@modelcontextprotocol/sdk`), Express server with the setup wizard API and digest delivery, React console, CLI, and a local PayPal mock for offline tests.
- PayPal: Invoicing v2 (create, send, remind, cancel, record payment/refund, search, invoice discounts, **QR codes**), **Orders v2** (create, capture, and charges on a saved PayPal with `vault_id`) for the portal, shop, agent and autopay checkouts, **Vault v3** (setup tokens, payment tokens) for autopay, Payments v2 capture refunds, Catalog Products, Billing Plans and Subscriptions, Webhooks (create, verify signature, 29 event types), Disputes (including provide-evidence with a PDF and send-message), **Payouts** for supplier bills, Transaction Search, and the **PayPal Agent Toolkit**, whose read tools are bridged into Claude's tool runner.
- The Agentic Commerce Protocol (checkout sessions, discovery, MCP binding) on top of PayPal Orders.
- AI: Claude (`claude-opus-5-5`) through the official Anthropic SDK. Structured outputs for the Mapper, Support, invoice-reader, inbox-reader and rules-compiler agents (the reader with an image block for photos of job sheets); the SDK tool runner for the Ops agent; server-side refusal fallback; masked personal data; read-only SQL.
- AG Grid Community for every table in the console, including editable mapping grids. Render Blueprint, a Dockerfile and a Codespaces dev container for one-click runs. exceljs and mysql2 for the new sources.

## Challenges

Making an agent useful with money without letting it move money. The answer was a deterministic engine with an action log and a policy gate: the agent's only write tool is `propose_action`. Idempotency everywhere (PayPal request ids, one link per legacy record, one application per webhook event) so reruns and retries never double-charge or double-send.

## What we learned

Retrofitting is mostly about state: what the old system believes, what PayPal believes, and what to do when they disagree. Reconciliation turned out to be the feature small businesses need most.

## What's next

Two-way Google Sheets (write-back into the sheet itself), writing shop sales back into the legacy system as new invoices, multi-currency, a practice-wide digest for bookkeepers, and learning the best reminder timing per customer from what actually gets paid.

## Earlier ideas still on the list

QuickBooks and Xero as live sources, Pay Later messaging on the portal and shop, and a hosted multi-tenant version where an owner signs in, connects PayPal and a Google Sheet, and never sees a terminal.

## Built with

TypeScript, Node.js, Express, React, Vite, AG Grid, SQLite, PostgreSQL, MySQL, Excel (exceljs), Google Sheets, PayPal REST APIs (Invoicing, Orders, Vault, Webhooks, Subscriptions, Disputes, Payouts), PayPal Agent Toolkit, Model Context Protocol, Agentic Commerce Protocol, Anthropic Claude, Docker, GitHub Codespaces, Render.

## Tools used (AI)

Anthropic Claude (`claude-opus-5-5`) via the official `@anthropic-ai/sdk`: (1) the Mapper agent turns a database schema into a typed PayPal mapping with structured outputs; (2) the Ops agent uses the SDK tool runner with retrofit's engine tools and PayPal Agent Toolkit read tools; (3) the Support agent drafts dispute responses and picks the evidence from the business's records with structured outputs, and retrofit sends them to PayPal once the owner approves; the inbox reader reads customer emails and the rules compiler turns the owner's sentences into rules; (4) the reminder and digest writers draft customer reminders and the owner's morning note; (5) the invoice reader turns a sentence or a photo of a paper job sheet into an invoice draft (vision + structured outputs); (6) the MCP servers let the owner's own Claude use the same tools under the same rules, and let customers' and shoppers' assistants pay and buy, with a person approving every payment. Claude Code was used as a development assistant.

## Links

- Repository: https://github.com/Thinkelution/paypal-retrofit
- Website: https://thinkelution.github.io/paypal-retrofit/
- Hosted demo: TODO
- Video: TODO
