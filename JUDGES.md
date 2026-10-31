# For judges

## Fastest path: the hosted demo

- URL: **TODO (Render URL)**
- Console login: user `retrofit`, password **TODO**
- Everything runs against a bundled simulator of the PayPal endpoints, so you can pay invoices, save PayPal for autopay and approve subscriptions as a customer without a PayPal account. **⋯ → Reset demo** restores the starting state.
- No hosted demo handy? **[Open in GitHub Codespaces](https://codespaces.new/Thinkelution/paypal-retrofit?quickstart=1)** builds and starts the same demo in your browser in a few minutes, or run `docker run` (see below).

What to try (about 5 minutes). The console opens on **Today**; the left sidebar groups everything else, and **Ctrl+K** jumps anywhere.

1. **⋯ → Legacy app ↗** is Fernhill Studio's existing invoicing system: 17 overdue invoices, all chased and marked paid by hand. **⋯ → Business website ↗** is their website, with one line added.
2. On **Today**, "22 new invoices ready to send" → **Send now**. Each open invoice becomes a PayPal invoice with Fernhill's own number; the legacy app now shows PayPal ids. The cards update: approvals waiting, reminders due.
3. **+ New invoice** → type "Invoice Maya Okafor 2 hours at $95 for retouching, due Friday" → **Read it** → **Add and send**. The invoice is written into Fernhill's own database (next number, its statuses, line items) and sent through PayPal. With `ANTHROPIC_API_KEY`, **Snap a job sheet** reads a photo of a handwritten job sheet the same way.
4. **Invoices**: click any row → **Pay as customer ↗** → pay. The row shows *Paid*, **Webhooks** shows the verified events, and the legacy app's invoice is `paid` with the amount and date. **Pay slip with QR** prints PayPal's QR code for a paper invoice.
5. **Business website** (step 1): **Pay a bill** at the bottom right → the invoice number from step 3 and `maya.okafor@example.com` → **Pay with PayPal**. The same site lists the catalogue with **Book and pay**. **Website & QR** in the console has the one-line snippets.
6. **Customers** → **Portal ↗** for any customer: the private page they get. Tick invoices and **Pay selected with PayPal**, or **Set up autopay with PayPal**: approve on the simulator's PayPal page, and from then on their invoices are paid on the due date (Run collections charges any that are due; collections stop chasing them).
7. **Approvals**: approve the "Social content package" retainer as a PayPal subscription, open its row, **Approve as customer**, and the retainer turns `active` in the legacy app.
8. **Collections** shows the playbook's decision for every overdue invoice: INV-1042 on **Hold** (the customer promised to pay), INV-1038 **Offer plan** (they asked to split it), the rest a friendly first reminder. **Run playbook**; reminders wait in Approvals, or are **Scheduled** for 08:00 in the evening (Pacific time).
9. **Ask the agent**: "Send reminders for everything more than 14 days overdue." It proposes one reminder each; they wait for approval. On a paid invoice, **Simulate buyer dispute**: it appears under **Mismatches**, and **Draft response** asks the Support agent for a reply built from the invoice records.
10. **Cash & risk**: the 9-week forecast, late-payment risk with reasons, and how each customer pays. Download the Xero or QuickBooks file: each PayPal fee is its own line.
11. **Morning digest**: the owner's daily email or Slack post, with a signed **Review** link per waiting action.
12. **Go live**: ten checked steps from the simulator to the PayPal sandbox to live, each checked against what retrofit actually sees.
13. **Shop**: buy a portrait session on the **Shop page ↗**, or let an AI agent do it: `claude mcp add --transport http fernhill-shop <demo-url>/mcp/shop`, then "book me a portrait session with Fernhill Studio". A customer's own assistant uses the same endpoint with their portal link: "what do I owe Fernhill, and pay the two oldest". The agent only ever gets a PayPal link; a person approves.
14. Switch to **Brightside Plumbing** (client picker, sidebar), a second business that runs on CSV exports, with a 2% late fee after 30 days and 2% off for paying within 10 days. **All clients…** is the bookkeeper's view of every client.
15. **⋯ → Try your own data** opens the no-code setup wizard: upload an **Excel workbook** or CSV exports (one sheet with everything works), paste a **Google Sheet** link, or pick the Brightside sample. Check the mapping, set the rules in plain words, preview, **Go live**.
16. **Connect Claude (MCP)** (sidebar) plugs Claude Code or Claude Desktop into the owner's side: `claude mcp add --transport http paypal-retrofit <demo-url>/mcp`, then "give me my morning briefing".

Shortcut: `node scripts/stage-demo.mjs` puts a fresh demo into a lived-in state in a few seconds: payments, a plan, a dispute, an agent's order, an invoice added from a sentence, a customer on autopay, and Brightside's portal and assistant activity.

## Run it locally (under 10 minutes)

Requirements: Node 20 or newer, `corepack` (ships with Node).

```bash
git clone https://github.com/Thinkelution/paypal-retrofit.git
cd paypal-retrofit
corepack enable
pnpm install
pnpm build
cp .env.example .env    # optional: add ANTHROPIC_API_KEY to enable the agents
pnpm retrofit demo --fresh
```

Open <http://localhost:8787> and follow the steps above.

Or with Docker, no Node needed:

```bash
docker build -t paypal-retrofit https://github.com/Thinkelution/paypal-retrofit.git
docker run --rm -p 8787:8787 paypal-retrofit
```

Without `ANTHROPIC_API_KEY` the demo still runs; the Mapper falls back to a deterministic mapper and the agent panel says it is off.

## Against the real PayPal sandbox

Sandbox test accounts for this project:

| Role | Email | Password |
| --- | --- | --- |
| Business (seller) | TODO | TODO |
| Personal (buyer) | TODO | TODO |

```bash
# .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT=SANDBOX, ANTHROPIC_API_KEY
pnpm fernhill:seed -- --buyer <buyer-email>       # three customers use the sandbox buyer
RETROFIT_PUBLIC_URL=https://<public-https-url> pnpm retrofit demo --sandbox
```

Log in to <https://www.sandbox.paypal.com> as the buyer to pay an invoice. PayPal needs a public HTTPS URL to deliver webhooks; without one, press **Reconcile** after paying and the payment is picked up anyway.

## Checks

```bash
pnpm test         # 55 tests: engine, webhooks, reconcile, CSV, Excel, Google Sheets, agents (incl. photo reading), digest, setup wizard, MCP, terms, portal, autopay, website widget, QR, go-live, shop, multi-client; all offline
pnpm smoke:sandbox   # live sandbox: create, send and record one invoice (needs credentials)
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `better-sqlite3` fails to install | Use Node 20 or 22 LTS; prebuilt binaries exist for both. |
| Port 8787 in use | `pnpm retrofit demo --port 8800` |
| Agent says it is off | Add `ANTHROPIC_API_KEY` to `.env` and restart. |
| Sandbox webhook never arrives | Check the URL is public HTTPS; run `pnpm retrofit doctor`; press **Reconcile**. |
