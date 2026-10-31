# Demo video script (2:54, limit under 3:00)

The draft video is recorded from the running demo, with on-screen captions and no voice:

```bash
pnpm retrofit demo --fresh                 # in one terminal
node scripts/record-demo.mjs               # in another: about 3 minutes, then ffmpeg
```

It writes `video/out/paypal-retrofit-demo.mp4` (1920×1080, H.264) and `video/out/paypal-retrofit-demo.srt` (the same captions as a subtitle file). The run is deterministic: it resets the demo, then drives the console, the legacy app, the business website, a customer's portal and the PayPal simulator with a visible cursor. Re-record after any UI change.

To finish it: record the voice-over below over the draft (any editor; keep the captions, they also help judges watching without sound), upload to YouTube as **Public**, add the `.srt` as English subtitles, and put the link in `README.md`, `JUDGES.md` and the Devpost form. If PayPal sandbox credentials and an Anthropic key are available, a second take with `pnpm retrofit demo --sandbox` and a real photo of a job sheet is stronger; say on screen which one is shown.

| Time | Screen | On-screen caption | Voice-over |
| --- | --- | --- | --- |
| 0:00 | Title card | — | "Most small businesses already run on something: an old invoicing app, a spreadsheet, a paper job sheet. paypal-retrofit connects PayPal to that, without rebuilding anything." |
| 0:06 | Fernhill's legacy app | Fernhill Studio runs on an old invoicing app. 17 invoices are overdue, and every payment is marked paid by hand. | "Fernhill Studio is a photography studio. Seventeen invoices are overdue, and every payment is typed in by hand." |
| 0:15 | Setup wizard: connect, then mapping | retrofit connects to what the business already has… / Claude maps their tables to PayPal and explains each choice… | "retrofit connects to the database, the CSV exports, an Excel file or a Google Sheet. Claude maps it to PayPal and explains every choice; nothing changes until the owner goes live." |
| 0:34 | Today → Send now | The console opens on Today… / One click sends every open invoice through PayPal… | "The owner opens one screen: what needs them today, one button each. One click sends every open invoice through PayPal, with Fernhill's own invoice numbers." |
| 0:45 | New invoice from one sentence | New invoices: type a sentence, or snap a photo of a paper job sheet… / The owner checks the draft… | "New work? Type a sentence, or take a photo of the handwritten job sheet and Claude reads it. The invoice goes into Fernhill's own database, then out through PayPal." |
| 1:00 | PayPal pay page → legacy app row turns paid | The customer pays on PayPal (here, the built-in simulator). / PayPal's signed webhook comes back… | "The customer pays. PayPal's signed webhook comes back, and the old app marks the invoice paid by itself." |
| 1:14 | Fernhill's website, Pay a bill | One line of script adds "Pay a bill"… / Invoice number and email, then straight to PayPal… | "One line on their existing website adds Pay a bill. Paper invoices get a pay slip with PayPal's QR code." |
| 1:29 | Customer portal → autopay → PayPal approval | Every customer gets a private portal… / Autopay uses PayPal Vault… / From now on their invoices are paid on the due date… | "Customers get a private portal: pay several invoices at once, ask for more time, or turn on autopay. They save PayPal once, and invoices are paid on the due date." |
| 1:48 | MCP calls from a customer's assistant | A customer's own assistant can check and pay their bills… | "AI assistants work on both sides. A customer's assistant can check and pay their bills, a shopper's agent can buy, but only ever with a PayPal link a person approves." |
| 1:55 | Inbox: a customer's cheque email | Customer emails become promises, plan requests and drafted replies… | "Customers email back. 'I posted a cheque on Monday' is read, a reply is drafted, and the payment waits for the owner, because an email can be forged." |
| 2:01 | Collections → Run playbook → Approvals | Collections decides who to remind… / Reminders and plan offers wait for the owner's OK… | "Collections decides who to remind and who to leave alone. The agent proposes; the owner's rules decide." |
| 2:14 | Rules in plain English → Shadow mode | The owner writes the rules in plain English… / Shadow mode replays the last 90 days… | "The owner writes those rules in plain English and sees what they change before saving. Shadow mode replays the last ninety days through them, touching nothing." |
| 2:30 | Disputes: evidence → Approve and send | A buyer disputes INV-1050… / Once the owner approves, PayPal gets the response and a PDF… | "When a buyer disputes a payment, retrofit drafts the response from the records and says what is missing, instead of inventing it. Once the owner approves, PayPal gets it with a PDF of the records." |
| 2:42 | Bills to pay | Bills are paid with PayPal Payouts… | "Money goes out too: suppliers are paid with PayPal Payouts, and a new payee or a changed PayPal email always waits for the owner." |
| 2:50 | Go live | Go live walks from the simulator to the PayPal sandbox to real payments… | "And Go live walks the owner from this simulator to real payments, checking every step." |
| 2:54 | End card | — | "paypal-retrofit. Open source, on PayPal and Claude." |

PayPal surfaces shown: Invoicing (create, send, pay, QR), Orders (multi-invoice and agent checkout), Vault (autopay), Disputes (evidence with a PDF), Payouts (supplier bills), signed webhooks. AI shown: Claude mapping, invoice reading, the inbox, rules in plain English, dispute drafts, agents over MCP. Not shown on screen: the money trail and the Agentic Commerce Protocol (both in the README and the screenshots).
