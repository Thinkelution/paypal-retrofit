import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ACTION_KINDS, ledger, redact, summary, type Retrofit } from '@paypal-retrofit/core';
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
export const json = (v: unknown, revealPii = false) =>
  clip(JSON.stringify(redact(v, { emails: !revealPii }), null, 1));

/** Tools backed by retrofit's own engine. Reads are free; the only write is propose_action, which goes through the policy gate. */
export function engineTools(rf: Retrofit, emit: (e: ToolEvent) => void, opts: { revealPii?: boolean } = {}) {
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
Call it once per target. Always tell the user what you proposed and whether it ran or is waiting for approval.`,
    inputSchema: z.object({
      kind: z.enum(ACTION_KINDS),
      entity: z.enum(['invoice', 'subscription']),
      number: z
        .string()
        .describe('Legacy invoice number (for invoices) or subscription id/title (for subscriptions)'),
      payload: z.record(z.string(), z.unknown()).optional(),
      reason: z.string().describe('One sentence a person will read when approving'),
    }),
    run: wrap('propose_action', async ({ kind, entity, number, payload, reason }) => {
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
        result: action.result,
      };
    }),
  });

  return [
    businessSummary,
    findInvoices,
    invoiceDetail,
    legacySql,
    listDiscrepancies,
    listActions,
    proposeAction,
  ];
}
