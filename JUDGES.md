# For judges

## Fastest path: the hosted demo

- URL: **TODO (Render URL)**
- Console login: user `retrofit`, password **TODO**
- Everything runs against a bundled mock of the PayPal endpoints, so you can pay invoices and approve subscriptions as a customer without a PayPal account. **Reset demo** (top bar) restores the starting state.

What to try (about 3 minutes):

1. Open **Legacy app ↗**. This is Fernhill Studio's existing invoicing system: 17 overdue invoices, all chased and marked paid by hand.
2. Back in the console, press **Send 22 invoices through PayPal**. Each open invoice becomes a PayPal invoice with Fernhill's own number; the legacy app now shows PayPal ids.
3. Click any invoice row → **Pay as customer ↗** → pay. Return to the console: the row shows *Paid*, *Collected via PayPal* goes up, and the **Webhooks** tab shows the two verified events. Refresh the legacy app: the invoice is `paid`, with the amount and date written back.
4. **Approvals** has one item: the new “Social content package” retainer as a PayPal subscription. Approve it, open its row, **Approve as customer**, and the retainer turns `active` in the legacy app.
5. On the paid invoice, press **Simulate buyer dispute**. It appears under **Discrepancies**; **Draft response** asks the Support agent for a reply built from the invoice records.
6. **Ask the agent**: “Send reminders for everything more than 14 days overdue.” It finds the invoices, proposes one reminder each, and they wait in Approvals until you approve.
7. **Mapping** shows how Claude mapped Fernhill's tables, with its reasons. Change a policy (for example reminders to `auto`) and save.
8. **Collections** shows the playbook's decision for every overdue invoice. INV-1042 is on **Hold** (its note says the customer promised to pay), INV-1038 gets **Offer plan** (the customer asked to split it), the rest get a friendly first reminder. Press **Run playbook**; the reminders wait in Approvals. If it is evening or the weekend in Pacific time, approved reminders show as **Scheduled** for 08:00 with a **Send now** button.
9. Approve the INV-1038 payment plan, open INV-1038 → **Pay as customer** → **Pay instalment**. The legacy app shows the running total, the drawer shows "1 of 2 instalments paid", and nothing is flagged as a problem.
10. **Insights** shows the 9-week cash forecast, late-payment risk with reasons (Tom Whitaker and Daniel Reyes habitually pay late), and how each customer pays. Under **Month-end books**, download the Xero or QuickBooks file: each PayPal fee is its own line.

Shortcut: `node scripts/stage-demo.mjs` puts a fresh demo into this lived-in state in a few seconds.

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
pnpm test         # engine, webhooks, reconcile, CSV, agents; all offline
pnpm smoke:sandbox   # live sandbox: create, send and record one invoice (needs credentials)
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `better-sqlite3` fails to install | Use Node 20 or 22 LTS; prebuilt binaries exist for both. |
| Port 8787 in use | `pnpm retrofit demo --port 8800` |
| Agent says it is off | Add `ANTHROPIC_API_KEY` to `.env` and restart. |
| Sandbox webhook never arrives | Check the URL is public HTTPS; run `pnpm retrofit doctor`; press **Reconcile**. |
