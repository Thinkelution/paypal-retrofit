import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  ACTION_KINDS,
  buildStatement,
  listCustomers,
  planTerms,
  cashForecast,
  customerProfiles,
  invoiceRisks,
  ledger,
  listDisputes,
  loadBills,
  moneyTrail,
  payablesView,
  proposeBillPayments,
  monthSummary,
  shadowReplay,
  planCollections,
  redact,
  runCollections,
  summary,
  type CollectionItem,
  type ReminderText,
  type Retrofit,
} from '@paypal-retrofit/core';
import * as z from 'zod/v4';

export interface ToolEvent {
  type: 'tool_call' | 'tool_result' | 'action_proposed';
  name: string;
  input?: unknown;
  output?: string;
  action?: unknown;
}

const MAX = 12000;
export const clip = (s: string) =>
  s.length > MAX ? `${s.slice(0, MAX)}\n…(truncated ${s.length - MAX} chars)` : s;
/**
 * Tool results stay valid JSON (MCP clients parse them): long lists lose rows from the end, and `omitted`
 * says how many, instead of the text being cut mid-way.
 */
export const json = (v: unknown, revealPii = false) => {
  const data = redact(v, { emails: !revealPii }) as any;
  const text = (x: unknown) => JSON.stringify(x, null, 1);
  let s = text(data);
  if (s.length <= MAX || !data || typeof data !== 'object' || Array.isArray(data)) return clip(s);
  const out = { ...data };
  const lists = Object.keys(out).filter((k) => Array.isArray(out[k]));
  const omitted: Record<string, number> = {};
  while (s.length > MAX) {
    const k = lists
      .filter((x) => out[x].length > 1)
      .sort((a, b) => text(out[b]).length - text(out[a]).length)[0];
    if (!k) break;
    const keep = Math.max(1, Math.floor(out[k].length * 0.8));
    omitted[k] = (omitted[k] ?? 0) + out[k].length - keep;
    out[k] = out[k].slice(0, keep);
    s = text({ ...out, omitted });
  }
  return clip(s);
};

/** Tools backed by retrofit's own engine. Reads are free; the only write is propose_action, which goes through the policy gate. */
export function engineTools(
  rf: Retrofit,
  emit: (e: ToolEvent) => void,
  opts: {
    revealPii?: boolean;
    reminderWriter?: (items: CollectionItem[]) => Promise<Map<string, ReminderText>>;
  } = {},
) {
  const wrap =
    <T>(name: string, fn: (input: T) => Promise<unknown>) =>
    async (input: T) => {
      emit({ type: 'tool_call', name, input });
      try {
        const out = json(await fn(input), opts.revealPii);
        emit({ type: 'tool_result', name, output: out.slice(0, 400) });
        return out;
      } catch (e) {
        const msg = `Error: ${(e as Error).message}`;
        emit({ type: 'tool_result', name, output: msg });
        return msg;
      }
    };

  const businessSummary = betaZodTool({
    name: 'business_summary',
    description:
      'Totals for the business: open and overdue invoices and amounts, how many are linked to PayPal, payments received through PayPal, open discrepancies and pending actions.',
    inputSchema: z.object({}),
    run: wrap('business_summary', () => summary(rf)),
  });

  const findInvoices = betaZodTool({
    name: 'find_invoices',
    description:
      'Search the ledger (legacy invoices and subscriptions joined with their PayPal state). Use it to answer questions about specific invoices or customers, overdue lists, and what is or is not in PayPal. Returns at most 60 rows.',
    inputSchema: z.object({
      number: z.string().optional().describe('Exact legacy invoice number, e.g. INV-1042'),
      customer: z.string().optional().describe('Case-insensitive part of the customer name'),
      legacyState: z.enum(['open', 'paid', 'cancelled']).optional(),
      paypalStatus: z
        .string()
        .optional()
        .describe('PayPal status such as SENT, PAID, MARKED_AS_PAID, CANCELLED'),
      minDaysOverdue: z.number().int().optional(),
      entity: z.enum(['invoice', 'subscription']).optional(),
      onlyWithDiscrepancies: z.boolean().optional(),
    }),
    run: wrap('find_invoices', async (q) => {
      let rows = await ledger(rf);
      if (q.entity) rows = rows.filter((r) => r.entity === q.entity);
      if (q.number) rows = rows.filter((r) => r.number.toLowerCase() === q.number!.toLowerCase());
      if (q.customer) rows = rows.filter((r) => r.customer.toLowerCase().includes(q.customer!.toLowerCase()));
      if (q.legacyState) rows = rows.filter((r) => r.legacyState === q.legacyState);
      if (q.paypalStatus) rows = rows.filter((r) => r.paypalStatus === q.paypalStatus!.toUpperCase());
      if (q.minDaysOverdue !== undefined)
        rows = rows.filter((r) => (r.daysOverdue ?? -1) >= q.minDaysOverdue!);
      if (q.onlyWithDiscrepancies) rows = rows.filter((r) => r.discrepancies.length > 0);
      return { count: rows.length, rows: rows.slice(0, 60) };
    }),
  });

  const invoiceDetail = betaZodTool({
    name: 'invoice_detail',
    description:
      'Everything about one legacy invoice: its line items, notes, customer, the linked PayPal invoice (fetched live), retrofit events and actions for it.',
    inputSchema: z.object({ number: z.string().describe('Legacy invoice number, e.g. INV-1042') }),
    run: wrap('invoice_detail', async ({ number }) => {
      const row = (await ledger(rf)).find(
        (r) => r.entity === 'invoice' && r.number.toLowerCase() === number.toLowerCase(),
      );
      if (!row) return { error: `No invoice numbered ${number}` };
      const inv = await rf.invoice(row.legacyPk);
      const link = rf.state.getLink('invoice', row.legacyPk);
      const paypal = link
        ? await rf.paypal.getInvoice(link.paypalId).catch((e) => ({ error: (e as Error).message }))
        : null;
      const actions = rf.state
        .listActions(undefined, 500)
        .filter((a) => a.target.entity === 'invoice' && a.target.legacyPk === row.legacyPk);
      return {
        legacy: {
          number: inv.number,
          status: inv.status,
          total: inv.total,
          issued: inv.issued,
          due: inv.due,
          notes: inv.notes,
          customer: inv.customer,
          lines: inv.lines,
        },
        ledger: row,
        paypal,
        discrepancies: rf.state.listDiscrepancies(true).filter((d) => d.legacyPk === row.legacyPk),
        actions: actions.map((a) => ({
          id: a.id,
          kind: a.kind,
          status: a.status,
          createdAt: a.createdAt,
          reason: a.reason,
        })),
      };
    }),
  });

  const legacySql = betaZodTool({
    name: 'legacy_sql',
    description:
      'Run one read-only SQL SELECT against the legacy business database (the real tables, before any PayPal join). Use for questions the ledger cannot answer. Writes are impossible: the connection is read-only. Returns at most 200 rows.',
    inputSchema: z.object({ sql: z.string().describe('A single SELECT or WITH query') }),
    run: wrap('legacy_sql', async ({ sql }) => {
      const rows = await rf.source.select(sql);
      return { count: rows.length, rows: rows.slice(0, 200) };
    }),
  });

  const listDiscrepancies = betaZodTool({
    name: 'list_discrepancies',
    description:
      'Open mismatches between the legacy system and PayPal found by reconciliation and webhooks, with a suggested fix for each.',
    inputSchema: z.object({ includeResolved: z.boolean().optional() }),
    run: wrap('list_discrepancies', async ({ includeResolved }) =>
      rf.state.listDiscrepancies(includeResolved ?? false),
    ),
  });

  const listActions = betaZodTool({
    name: 'list_actions',
    description:
      'Actions retrofit has taken or is waiting to take (pending ones need a person to approve them in the dashboard).',
    inputSchema: z.object({
      status: z.enum(['pending', 'executed', 'rejected', 'failed', 'skipped']).optional(),
    }),
    run: wrap('list_actions', async ({ status }) => rf.state.listActions(status, 60)),
  });

  const proposeAction = betaZodTool({
    name: 'propose_action',
    description: `Ask retrofit to do something with a side effect in PayPal. This is the ONLY way to change anything. Each kind has a policy set by the business owner: "auto" runs now, "confirm" waits for a person to approve it in the dashboard, "never" is refused. Kinds: ${ACTION_KINDS.join(', ')}.
- send_reminder: payload {subject?, note?} for a sent, unpaid invoice.
- cancel_invoice: payload {note?}.
- record_payment: payload {amount, method: BANK_TRANSFER|CASH|CHECK|OTHER, date?} when the customer paid outside PayPal.
- create_refund: payload {amount?, note?}; omit amount for a full refund.
- create_invoice / send_invoice / update_invoice: no payload; usually done by sync.
- create_subscription / cancel_subscription: target entity "subscription"; cancel takes {reason}.
- accept_dispute: payload {disputeId, note}.
- pay_supplier: entity "payable", number = the bill number from bills_to_pay; no payload (the amount is always the bill's). Pays the payee's PayPal email with PayPal Payouts. A first payment to a payee, or one to a changed PayPal email, always waits for the owner.
- submit_dispute_evidence: payload {disputeId, response, evidenceType?}. Sends PayPal the response with a PDF of the business's records; usually prepared by the dispute autopilot. Always waits for the owner.
- offer_payment_plan: payload {installments: 2-12, intervalDays?: 7-92, firstDue?: YYYY-MM-DD}. Uses PayPal partial payments on the same invoice; use it when a customer asked to pay in parts.
- apply_late_fee: payload {amount}. Adds the owner's late fee to the PayPal invoice; usually proposed by run_collections under the owner's terms.
- send_statement: target entity "customer", number = the customer key from customer_accounts. Emails the customer their statement with pay links and their portal link.
- charge_autopay: no payload. Charges the saved PayPal of a customer on autopay for that invoice; usually proposed by run_collections on the due date.
Results include "status": "executed", "pending" (needs approval), "scheduled" (held for quiet hours; see runAfter) or "rejected", plus "policyReason" explaining which rule applied.
Call it once per target. Always tell the user what you proposed and whether it ran or is waiting for approval.`,
    inputSchema: z.object({
      kind: z.enum(ACTION_KINDS),
      entity: z.enum(['invoice', 'subscription', 'customer', 'payable']),
      number: z
        .string()
        .describe(
          'Legacy invoice number (for invoices), subscription id/title (for subscriptions), or bill number (for payables)',
        ),
      payload: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().describe('One sentence a person will read when approving'),
    }),
    run: wrap('propose_action', async ({ kind, entity, number, payload, reason }) => {
      if (entity === 'payable') {
        if (kind !== 'pay_supplier') return { error: 'Bills can only be paid (pay_supplier)' };
        const bill = (await loadBills(rf)).find(
          (b) => b.number.toLowerCase() === number.toLowerCase() || b.pk === number,
        );
        if (!bill) return { error: `No bill matching "${number}"` };
        const [r] = await proposeBillPayments(rf, [bill.pk], 'agent');
        if (!r?.action) return { error: r?.error ?? 'Could not propose the payment' };
        emit({ type: 'action_proposed', name: 'propose_action', action: r.action });
        return {
          id: r.action.id,
          kind: r.action.kind,
          status: r.action.status,
          policyReason: r.action.policyReason,
        };
      }
      if (entity === 'customer') {
        const c = (await listCustomers(rf)).find(
          (x) => x.pk === number || x.name.toLowerCase() === number.toLowerCase(),
        );
        if (!c) return { error: `No customer matching "${number}"` };
        const action = await rf.propose({
          origin: 'agent',
          kind,
          target: { entity: 'customer', legacyPk: c.pk, label: c.name },
          payload: payload ?? {},
          reason,
        });
        emit({ type: 'action_proposed', name: 'propose_action', action });
        return { id: action.id, kind: action.kind, status: action.status, policyReason: action.policyReason };
      }
      const row = (await ledger(rf)).find(
        (r) =>
          r.entity === entity && (r.number.toLowerCase() === number.toLowerCase() || r.legacyPk === number),
      );
      if (!row) return { error: `No ${entity} matching "${number}"` };
      const action = await rf.propose({
        origin: 'agent',
        kind,
        target: { entity, legacyPk: row.legacyPk, paypalId: row.paypalId ?? undefined, label: row.number },
        payload: payload ?? {},
        reason,
      });
      emit({ type: 'action_proposed', name: 'propose_action', action });
      return {
        id: action.id,
        kind: action.kind,
        status: action.status,
        policy: action.policy,
        policyReason: action.policyReason,
        runAfter: action.runAfter,
        result: action.result,
      };
    }),
  });

  const collectionsPlan = betaZodTool({
    name: 'collections_plan',
    description:
      "The collections playbook's decision for every open PayPal invoice: remind (next reminder in the friendly/firm/final sequence or a missed instalment), wait (too early or too soon), hold (dispute, or a promise to pay), plan (the customer asked to pay in parts), or escalate (all reminders sent; call them). Each has a one-sentence reason. Read-only.",
    inputSchema: z.object({ decision: z.enum(['remind', 'wait', 'hold', 'plan', 'escalate']).optional() }),
    run: wrap('collections_plan', async ({ decision }) => {
      const items = await planCollections(rf);
      const rows = decision ? items.filter((i) => i.decision === decision) : items;
      return { count: rows.length, items: rows.map(({ notes: _n, ...i }) => i) };
    }),
  });

  const collectionsRun = betaZodTool({
    name: 'run_collections',
    description:
      'Runs the collections playbook: proposes every reminder and payment-plan offer the plan calls for (optionally only for some invoice numbers), with reminder text written for the tone. Everything goes through the policy engine, so most will wait for approval or be held for quiet hours. Use when the owner asks to chase overdue invoices.',
    inputSchema: z.object({
      numbers: z.array(z.string()).optional().describe('Limit to these invoice numbers'),
    }),
    run: wrap('run_collections', async ({ numbers }) => {
      let only: string[] | undefined;
      if (numbers?.length) {
        const rows = await ledger(rf);
        only = rows
          .filter((r) => numbers.some((n) => n.toLowerCase() === r.number.toLowerCase()))
          .map((r) => r.legacyPk);
      }
      const run = await runCollections(rf, { origin: 'agent', only, writer: opts.reminderWriter });
      for (const p of run.proposed)
        emit({ type: 'action_proposed', name: 'run_collections', action: p.action });
      return {
        writer: run.writer,
        proposed: run.proposed.map((p) => ({
          invoice: p.item.number,
          kind: p.action.kind,
          tone: p.item.tone,
          status: p.action.status,
          policyReason: p.action.policyReason,
          runAfter: p.action.runAfter,
        })),
      };
    }),
  });

  const forecast = betaZodTool({
    name: 'cash_forecast',
    description:
      "Expected cash over the next 9 weeks from open invoices (weighted by late-payment risk and each customer's history), payment-plan instalments and active retainers, with the amount at high risk and the assumptions used.",
    inputSchema: z.object({}),
    run: wrap('cash_forecast', async () => cashForecast(rf)),
  });

  const risk = betaZodTool({
    name: 'payment_risk',
    description:
      'Late-payment risk for open invoices: score 1-99, band (low/medium/high), expected pay date, and the factors behind it (days overdue, customer history, disputes, promises, payment plans).',
    inputSchema: z.object({
      band: z.enum(['low', 'medium', 'high']).optional(),
      limit: z.number().int().optional(),
    }),
    run: wrap('payment_risk', async ({ band, limit }) => {
      const rows = (await invoiceRisks(rf)).filter((r) => !band || r.band === band);
      return { count: rows.length, invoices: rows.slice(0, limit ?? 40) };
    }),
  });

  const customerHistory = betaZodTool({
    name: 'customer_history',
    description:
      'How customers pay: invoices, average invoice, on-time rate, usual days late, open and overdue amounts, disputes and a behaviour label. Optionally filter by part of a name.',
    inputSchema: z.object({ customer: z.string().optional() }),
    run: wrap('customer_history', async ({ customer }) => {
      const all = [...(await customerProfiles(rf)).values()];
      return all.filter((p) => !customer || p.name.toLowerCase().includes(customer.toLowerCase()));
    }),
  });

  const monthEnd = betaZodTool({
    name: 'month_end_summary',
    description:
      'Month-end figures from the payments ledger: PayPal gross collected, PayPal fees, net, refunds, payments recorded outside PayPal and the effective fee rate. Month as YYYY-MM (defaults to this month).',
    inputSchema: z.object({
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional(),
    }),
    run: wrap('month_end_summary', async ({ month }) =>
      monthSummary(rf, month ?? new Date().toISOString().slice(0, 7)),
    ),
  });

  const customers = betaZodTool({
    name: 'customer_accounts',
    description:
      'Every customer with an open balance: what they owe, how much is overdue, the oldest overdue days, last payment, open portal requests and how they usually pay.',
    inputSchema: z.object({ customer: z.string().optional().describe('Part of a customer name') }),
    run: wrap('customer_accounts', async ({ customer }) =>
      (await listCustomers(rf)).filter(
        (c) => c.balance > 0 && (!customer || c.name.toLowerCase().includes(customer.toLowerCase())),
      ),
    ),
  });

  const trail = betaZodTool({
    name: 'money_trail',
    description:
      'Everything that happened to one invoice, in order: who proposed each action and which rule let it run, what PayPal reported by verified webhook, payments and fees, customer requests, and exactly which columns retrofit wrote into the business system. Use it for "why" and "who did this" questions.',
    inputSchema: z.object({ number: z.string().describe('Invoice number, e.g. INV-1042, or a bill number') }),
    run: wrap('money_trail', async ({ number }) => {
      const row = (await ledger(rf)).find((r) => r.number.toLowerCase() === number.toLowerCase());
      if (row) return moneyTrail(rf, row.entity, row.legacyPk);
      const bill = (await loadBills(rf)).find((b) => b.number.toLowerCase() === number.toLowerCase());
      if (bill) return moneyTrail(rf, 'payable', bill.pk);
      return { error: `No invoice or bill ${number}` };
    }),
  });

  const bills = betaZodTool({
    name: 'bills_to_pay',
    description:
      'What the business owes its suppliers and contractors, from its own system: each bill with payee, PayPal email, amount, due date, and any PayPal payout already sent. check.hold says why paying it must wait for the owner (a first payment to that payee, or a PayPal email that changed since the last payment: a common fraud). Pay with propose_action kind pay_supplier.',
    inputSchema: z.object({ open: z.boolean().optional().describe('Only bills still to pay') }),
    run: wrap('bills_to_pay', async ({ open }) => {
      const v = await payablesView(rf);
      if (!v.enabled) return { error: 'This business has no bills table mapped' };
      return { ...v, bills: open ? v.bills.filter((b) => b.state === 'open') : v.bills };
    }),
  });

  const disputes = betaZodTool({
    name: 'dispute_cases',
    description:
      'Buyer disputes PayPal reported, with the response retrofit drafted from the business records (summary, recommendation, the response text, the evidence it has and what is missing) and whether sending it waits for the owner. Read-only.',
    inputSchema: z.object({}),
    run: wrap('dispute_cases', async () => listDisputes(rf)),
  });

  const shadow = betaZodTool({
    name: 'shadow_mode',
    description:
      'Replays the last N days of the business\'s invoices through retrofit\'s current rules without touching anything: invoices it would have sent with pay links, reminders (and which would have run on their own or waited for the owner), late fees, and an estimate of how much sooner money would have arrived, with the assumption stated. Use it for "what would retrofit have done" or "is it worth switching on" questions.',
    inputSchema: z.object({
      days: z.number().int().min(14).max(365).optional(),
      daysAfterReminder: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe('Assumption for the estimate (default 7)'),
    }),
    run: wrap('shadow_mode', async ({ days, daysAfterReminder }) =>
      shadowReplay(rf, { days, daysAfterReminder }),
    ),
  });

  const statement = betaZodTool({
    name: 'customer_statement',
    description:
      "One customer's statement: open invoices with balances, fees and discounts, aging buckets and payments in the last 90 days. Use the customer key from customer_accounts.",
    inputSchema: z.object({ customerPk: z.string() }),
    run: wrap('customer_statement', async ({ customerPk }) => buildStatement(rf, customerPk)),
  });

  const requests = betaZodTool({
    name: 'customer_requests',
    description:
      'What customers told the business in the self-service portal: promises to pay by a date, requests to pay in parts, and questions about invoices.',
    inputSchema: z.object({ includeDone: z.boolean().optional() }),
    run: wrap('customer_requests', async ({ includeDone }) =>
      rf.state.listRequests(includeDone ? {} : { status: 'open' }),
    ),
  });

  const orders = betaZodTool({
    name: 'sales_orders',
    description:
      'Orders paid through PayPal checkout: shop and AI-shopping-agent sales from the catalogue, and portal payments covering several invoices.',
    inputSchema: z.object({ channel: z.enum(['shop', 'agent', 'portal']).optional() }),
    run: wrap('sales_orders', async ({ channel }) =>
      rf.state.listOrders(100).filter((o) => !channel || o.channel === channel),
    ),
  });

  const termsPlan = betaZodTool({
    name: 'payment_terms',
    description:
      "The owner's payment terms (late fee, early-payment discount), the fees and discounts already applied, and the late fees or discount expiries due today. Read-only; run_collections proposes them.",
    inputSchema: z.object({}),
    run: wrap('payment_terms', async () => ({
      terms: rf.mapping.terms,
      applied: rf.state.listAdjustments(),
      dueToday: await planTerms(rf),
    })),
  });

  return [
    businessSummary,
    customers,
    statement,
    requests,
    orders,
    termsPlan,
    collectionsPlan,
    collectionsRun,
    forecast,
    risk,
    customerHistory,
    monthEnd,
    findInvoices,
    invoiceDetail,
    trail,
    shadow,
    bills,
    disputes,
    legacySql,
    listDiscrepancies,
    listActions,
    proposeAction,
  ];
}
