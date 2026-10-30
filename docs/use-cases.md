# Real-world use cases

paypal-retrofit is built around the situations a small business actually hits when money is owed. Each one below says what happens in real life, the logic retrofit applies, which PayPal capabilities it uses, and how to see it in the Fernhill demo.

All of them share one rule: **the engine moves money, the agents propose and explain, and the owner's policies decide.** Every side effect is an action with an amount, a reason, and a `policyReason` that says which rule applied.

---

## 1. The Monday-morning collections run

**Real life.** Fernhill has 17 overdue invoices worth over $10,000. Someone has to decide who gets a gentle nudge, who gets a firmer one, who promised to pay on the phone, and who needs a call. In practice nobody does it consistently, so money arrives late.

**Logic** (`packages/core/src/collections.ts`). For every open PayPal invoice the playbook decides one of five things, with a one-sentence reason:

| Decision | When |
| --- | --- |
| **Remind** | The next step in the sequence is due: friendly at day 3, firm at day 14, final at day 30 (configurable), and the last reminder was at least 5 days ago |
| **Wait** | Too early, too soon after the last reminder, or a reminder is already waiting for approval or scheduled |
| **Hold** | A buyer dispute is open, or a note says the customer promised to pay and the grace period (10 days) is still running |
| **Offer plan** | A note says the customer asked to split the payment: offer instalments instead of chasing |
| **Call them** | Every reminder in the sequence has been sent |

Reminder text matches the tone. With Claude configured, the reminder writer personalises each one from the customer's history (warmer for reliable customers, clearer for habitual late payers) and is told never to threaten or invent facts. Without Claude, polite templates are used.

**PayPal.** Invoicing v2 `remind` with subject and note; the email carries PayPal's own pay button.

**See it.** Console → **Collections** → **Run playbook**. INV-1042 is on hold because its note says "Promised to pay by the end of the week". INV-1038 gets a payment-plan offer. Everything else gets a friendly first reminder, which waits in **Approvals**. CLI: `pnpm retrofit collections --run`. Agent: "Chase everything that's overdue."

---

## 2. "Can I pay this in two parts?"

**Real life.** A customer phones and asks to split a $580 invoice. The owner says yes, writes it on the invoice ("Customer asked to split payment; agreed by phone") and then has to remember to chase each half.

**Logic** (`offer_payment_plan` in `packages/core/src/engine.ts`). The invoice stays one PayPal invoice. Retrofit turns on PayPal's native partial payments with a minimum equal to one instalment, adds the agreed schedule to the invoice note, and notifies the customer. It stores the schedule, then:

- writes the running total back to the legacy invoice after each instalment, without marking it paid;
- reports "instalment 1 of 2 received" instead of raising a partial-payment problem;
- makes collections remind per instalment ("Instalment 2 of 2 was due on 19 Nov") instead of the overdue sequence;
- marks the plan completed and the legacy invoice paid when the last instalment lands;
- feeds instalments into the cash forecast on their due dates.

**PayPal.** Invoicing v2 update with `configuration.partial_payment` (`allow_partial_payment`, `minimum_amount_due`), `PARTIALLY_PAID` status, invoice and capture webhooks.

**See it.** Collections offers it for INV-1038; approve it in **Approvals**. Or open any sent invoice, choose the number of instalments and press **Offer payment plan**. Then **Pay as customer**: the mock pay page now has a **Pay instalment** button.

---

## 3. A refund requested on the phone

**Real life.** A customer wants $40 back for a missing print. That should take seconds. A $900 refund, or the fifth refund today, should not happen without the owner looking.

**Logic** (`packages/core/src/policy.ts`). Policies are rules, not switches:

- **Amount rules.** "Refunds up to $100 run automatically"; "payments received outside PayPal up to $250 are recorded automatically". Anything larger falls back to "confirm".
- **Daily limits.** At most $500 of automatic refunds and 40 automatic reminders per day (in the business's time zone). Past the cap, "auto" becomes "confirm" and the reason says so: "Daily limit: 480.00 of 500.00 USD in refunds already ran today; this 40.00 needs approval".
- **Never.** Accepting dispute claims is refused outright.

The Ops agent can only *propose* the refund; the result tells it, and the owner, which rule applied.

**PayPal.** Payments v2 capture refund (or recorded refund for payments made outside PayPal).

**See it.** Approvals shows a **Why it waits** column for every pending action. Rules and limits live in `retrofit.map.json` under `rules` and `limits`.

---

## 4. Reminders that don't land at 2 a.m.

**Real life.** The owner clears the approval queue at 11 p.m. A customer getting a payment reminder at 11:04 p.m. on a Saturday is a bad look, and it gets ignored.

**Logic.** Quiet hours (default 20:00–08:00 plus weekends, in the business's time zone) apply to customer-facing actions: reminders and payment-plan offers. An approved action during quiet hours becomes **scheduled** with a run time ("Held for quiet hours until Mon 08:00 PST") and is sent by the server's scheduler when business hours start. Daylight-saving changes are handled; there is a test for the November clock change. **Send now** overrides it when the owner really means it.

**See it.** Approve a reminder in the evening, Pacific time. It shows as *Scheduled* with its time; the Collections page shows "quiet now: reminders wait".

---

## 5. "Will we make payroll on the 15th?"

**Real life.** The owner knows the total owed but not when it will actually arrive. Some customers always pay on time; others are always two weeks late.

**Logic** (`packages/core/src/insights.ts`). Everything is learned from the business's own paid invoices:

- **Customer profiles.** On-time rate, usual days late, average invoice, behaviour label (reliable, sometimes late, usually late, new).
- **Late-payment risk** for each open invoice, scored 1–99 with the reasons listed: days overdue, the customer's history, open disputes, promise-to-pay notes, partial payments, payment plans, unusually large amounts.
- **Expected pay date** is the due date plus the customer's usual lateness, blended with the business-wide median when history is thin. Invoices that are already late are pushed out further the riskier they are.
- **Cash forecast** for 9 weeks: each invoice weighted by its risk band (95% / 75% / 45%), plan instalments on their own dates, and active retainers on their billing dates. It gives 30- and 60-day totals and the amount at high risk, and states its assumptions.

It is deterministic and explainable by design; the Ops agent quotes it rather than guessing.

**See it.** Console → **Insights**. The ledger gains a **Risk** column; each invoice drawer lists the risk factors. CLI: `pnpm retrofit forecast`. Agent: "What money can we expect before the 15th?"

---

## 6. Month-end close

**Real life.** The accountant needs every payment with PayPal's fee split out, so the books match the payout that reached the bank. Today that means exporting PayPal activity and matching it by hand to invoice numbers.

**Logic.** Retrofit keeps a **payments ledger**: every PayPal payment, refund and payment recorded outside PayPal, tied to the legacy invoice, with gross, fee and net. Fees come from the capture webhook (`seller_receivable_breakdown.paypal_fee`); if that was missed, reconciliation fills them in from Transaction Search. The month-end summary shows gross collected, fees, net, refunds, money received outside PayPal and the effective fee rate.

Exports:

- **CSV** with every column;
- **Xero bank statement** (Date, Amount, Payee, Description, Reference);
- **QuickBooks bank upload** (Date, Description, Amount).

In the Xero and QuickBooks exports each fee is its own negative line, so they reconcile to the net payout.

**PayPal.** Capture webhooks, Transaction Search (`/v1/reporting/transactions`), invoice payment and refund records.

**See it.** Insights → **Month-end books** → download. CLI: `pnpm retrofit export journal --month 2026-10 --format xero`. Agent: "How much did PayPal cost us in October?"

---

## 7. Paid by bank transfer, still open in PayPal

**Real life.** A customer pays by bank transfer; the owner marks the invoice paid in the old app. The PayPal invoice is still open, so the customer can still pay twice and keeps getting reminders.

**Logic.** Sync and reconciliation spot "paid here, open in PayPal" and propose **record payment** (automatic up to $250 under the default rules). The PayPal invoice becomes *Marked as paid*, the payments ledger records it as received outside PayPal, and collections stops.

**See it.** In the legacy app press **Mark as paid** on a sent invoice, then **Reconcile** in the console.

---

## 8. The webhook that never arrived

**Real life.** Hosting hiccups, a deploy restarts the server, PayPal's retry window passes. The payment happened, but the old system never heard about it.

**Logic.** Webhooks return 500 on failure so PayPal retries. The reconciler re-reads every linked invoice every 5 minutes, writes back any payment it finds, and fills missing fees from Transaction Search.

**See it.** There is a test for exactly this (`reconciliation repairs a payment whose webhook was lost`). In the demo, stop the server, pay an invoice on the mock page, start the server and press **Reconcile**.

---

## 9. A buyer dispute

**Real life.** A buyer opens a dispute saying half the edited photos are missing. The owner needs to stop chasing them, gather evidence and reply within the deadline.

**Logic.** The dispute webhook opens a discrepancy on the invoice. Collections holds reminders for it. The Support agent drafts a response from the dispute and the legacy invoice, with a recommendation (contest, partial refund or accept), an evidence checklist and what is still missing. Accepting the claim is policy "never" by default; the owner replies in PayPal.

**See it.** Open a paid invoice → **Simulate buyer dispute** → Discrepancies → **Draft response**. The draft needs `ANTHROPIC_API_KEY`.

---

## 10. "I don't have a developer"

**Real life.** A plumbing business keeps its jobs in an invoicing tool that can export CSV, and nobody there will ever open a terminal.

**Logic.** `paypal-retrofit serve` with no config opens the setup wizard. The owner uploads the exports; the Mapper agent (or the rule-based mapper) proposes how `clients`, `bills` and `bill_items` become PayPal customers, invoices and line items, and the owner adjusts any column in a grid. Rules are chosen in plain words and translated into policies, amount rules, daily limits, quiet hours and the reminder schedule. The preview runs the real sync planner against an in-memory state store, so it shows exactly which invoices go to PayPal and which are left alone (drafts, missing emails) before anything is sent. **Go live** writes `retrofit.config.yaml` and `retrofit.map.json` and switches the running server to them. Uploaded files are never modified: write-backs go to `*.retrofit.csv` sidecars.

**See it.** In the demo, **Try your own data** → **Try the sample business** → follow the four steps. **Back to Fernhill** returns to the demo.

---

## 11. The owner reads email, not dashboards

**Real life.** The owner checks their phone at breakfast and wants to know three things: did money come in, does anything need me, who should I call.

**Logic.** Every weekday at 08:00 in the business's time zone (configurable; within three hours if the server was down), retrofit builds a digest from the same engine data as the console: payments since the last digest with fees and net, overdue totals, expected cash this week, actions waiting for approval with the rule that held them, actions held for quiet hours, customers the playbook says to call, the riskiest invoices and open discrepancies. Each waiting action gets a signed link that expires after 48 hours; opening it never changes anything, and the Approve / Reject buttons only work while the action is still pending. Approving goes through the same engine call as the console, so quiet hours and limits still apply. Claude can write the opening lines; the facts are always computed.

**See it.** Console → **Digest** → **Review** on any item. `pnpm retrofit digest` prints it; `--send` delivers it.

---

## 12. "Ask Claude what's going on with my money"

**Real life.** The owner already uses Claude Desktop or Claude Code and would rather ask there than open another app.

**Logic.** retrofit is an MCP server. The tools are the Ops agent's own (reads marked read-only, writes limited to `propose_action` and `run_collections`), so an MCP client gets the same answers and the same policy gate. Approving from the client is off unless the server is started with `--allow-approve` / `RETROFIT_MCP_ALLOW_APPROVE=1`; on a password-protected console the HTTP endpoint needs `RETROFIT_MCP_TOKEN` as a bearer token.

**See it.** `claude mcp add --transport http paypal-retrofit http://localhost:8787/mcp`, then ask "give me my morning briefing" or use the `chase_overdue` prompt.
