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

---

## 13. "Can I see everything I owe you?"

**Real life.** A property manager has three open invoices from the plumber and wants to pay them together, not click three PayPal emails.

**Logic.** Each customer has a private portal link (in statements and the console). It lists every issued, open invoice with fees and discounts, and pays any selection in one PayPal checkout (Orders API). After capture retrofit records a PayPal payment on each invoice, writes them back as paid, and splits PayPal's fee across them in the books.

**See it.** Brightside Plumbing → **Customers** → **Portal ↗** → tick two invoices → **Pay selected with PayPal**.

---

## 14. "I'll pay on the 20th" / "Can I split it?" / "I think this is wrong"

**Real life.** Customers tell you things, by phone or email, and the reminders keep going anyway.

**Logic.** In the portal a customer can promise a date, ask for 2–4 instalments, or ask a question about an invoice. Promises hold reminders until the date; questions hold them until the owner marks them answered; plan requests queue an `offer_payment_plan` for the owner's approval. None of them gets a late fee. All of them show in the digest.

**See it.** Open a customer's portal → **Need more time…** → any of the three. Then look at **Collections** and **Approvals**.

---

## 15. Late fees and early-payment discounts

**Real life.** "2% off if you pay within 10 days; 2% added after 30 days late."

**Logic.** Owner rules on the Customers tab. New invoices get the discount on the PayPal invoice while the window is open, and it comes off by itself after. The late fee is a line added to the PayPal invoice once it is far enough overdue, proposed by the collections run and approved like any action. Reconciliation, statements, risk and the forecast all use the adjusted amount.

**See it.** Brightside Plumbing: BP-2427 and BP-2428 carry the discount; **Collections → Run playbook** proposes late fees for the oldest bills.

---

## 16. A buyer's AI agent books a session

**Real life.** Someone asks their assistant to "book a portrait session with Fernhill Studio".

**Logic.** The shop's buyer MCP server lists and searches the catalogue (from the business's own product table) and creates a PayPal checkout. The agent cannot pay; it hands the person a PayPal approval link. Prices are the business's, orders over the owner's cap are refused, and the paid order is captured by webhook and booked with its fee.

**See it.** `claude mcp add --transport http fernhill-shop http://localhost:8787/mcp/shop`, then ask. Or open `/shop` yourself.

---

## 17. The bookkeeper with twenty clients

**Real life.** An accountant looks after many small businesses and wants to know, each morning, which ones need them.

**Logic.** `paypal-retrofit practice --dir clients` runs every client folder as its own workspace (own data, PayPal account, rules, digest, portal) and shows one overview sorted by approvals waiting, customer requests and mismatches. **Add a client** runs the setup wizard.

**See it.** Client picker → **All clients…** in the demo.

---

## 18. The plumber in the van

**Real life.** The job is done, the job sheet is handwritten on a clipboard, and the invoice usually gets typed up on Sunday night.

**Logic.** **+ New invoice → Snap a job sheet**: the photo goes to Claude with the business's customers and catalogue. It returns a draft (customer, lines, due date, a note) and lists anything it could not read for certain. The owner checks it; retrofit writes it into the business's own system with the next invoice number and the "ready to send" status, then sends it through PayPal. Typing works too: "Invoice Harbor View Apartments $420 for the boiler service, due in 14 days".

**See it.** Today → **+ New invoice**. Photos need `ANTHROPIC_API_KEY`; sentences work without it.

---

## 19. "Our books are a spreadsheet"

**Real life.** A tutor keeps every invoice in one Google Sheet: date, client, email, amount, due date, status.

**Logic.** Paste the share link in the setup wizard. retrofit reads the whole spreadsheet, makes "Invoice #" and "Due Date" usable, recognises that each row carries the customer, and re-reads the sheet on every sync, so a new row becomes a PayPal invoice. An Excel workbook works the same, and retrofit writes a copy of it with PayPal ids, pay links and payments filled in, formatting kept.

**See it.** **⋯ → Try your own data → Connect a Google Sheet** (or upload a workbook).

---

## 20. "Can I pay on your website?"

**Real life.** Customers look for a Pay button on the business's site, which was built years ago and nobody wants to touch.

**Logic.** One line, `<script src=".../widget.js" data-float="pay-bill" async></script>`, adds **Pay a bill**: the customer types the invoice number and their email, and goes straight to PayPal. The same script can show Pay buttons on invoice pages and the catalogue with **Book and pay**. Lookups need the number and the email together and are rate limited.

**See it.** **⋯ → Business website ↗**.

---

## 21. Paper invoices still exist

**Real life.** Some customers get a printed invoice, or the owner hands one over at the door.

**Logic.** Every invoice in PayPal has a printable **pay slip** with PayPal's own QR code: scanning it opens the pay page on the customer's phone. Printed statements carry a QR code for the customer's portal.

**See it.** Invoices → open an invoice → **Pay slip with QR**.

---

## 22. "Just take it when it's due"

**Real life.** A regular customer would rather not be reminded at all.

**Logic.** In their portal the customer chooses **Set up autopay with PayPal**, optionally capped per invoice, and approves at PayPal (PayPal Vault). On the due date the collections run charges their saved PayPal for each invoice, books it like any PayPal payment, and never sends them a reminder. A declined charge is not retried: reminders take over. If the customer removes the business in their PayPal account, autopay turns off by webhook.

**See it.** Customers → **Portal ↗** → **Set up autopay**; then **Run collections**.

---

## 23. "My assistant pays my bills"

**Real life.** A customer asks their AI assistant to deal with what they owe a supplier.

**Logic.** With the customer's portal link, the assistant uses the business's public MCP endpoint: `my_invoices` (what is open, overdue, on a plan), `pay_my_invoices` (one PayPal checkout for some or all of it) and `tell_the_business` (a date they will pay by, a request for a plan, a question). The assistant only ever hands back a PayPal link; the person approves.

**See it.** `claude mcp add --transport http fernhill http://localhost:8787/mcp/shop`, then "here is my portal link: what do I owe Fernhill? Pay the two oldest."

---

## 24. "Is it safe to switch this on for real?"

**Real life.** The owner tried the demo and wants to know what is left before real customers pay.

**Logic.** **Go live** lists ten steps from the built-in simulator to the PayPal sandbox to live, each checked against what retrofit has actually seen: credentials that authenticate, a verified webhook event, a test payment that came back, the paid status written into their own system, their rules, the digest, Claude. One-click fixes where possible (register the webhook, sync, reconcile).

**See it.** Sidebar → **Go live**.

