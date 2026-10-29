import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema.mjs';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { Retrofit } from '@paypal-retrofit/core';
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/openai';
import { json, type ToolEvent } from './engine-tools.ts';

/**
 * Read-only PayPal tools for the Ops agent.
 *
 * In SANDBOX/PRODUCTION these come from PayPal's official Agent Toolkit (@paypal/agent-toolkit), which
 * provides the schemas and makes the API calls. Writes are deliberately NOT exposed: every side effect goes
 * through retrofit's propose_action and the owner's policies.
 *
 * In MOCK mode the toolkit cannot be pointed at the local mock (its base URL is fixed), so equivalent
 * tools with the same names are served by retrofit's own PayPal client.
 */
export const TOOLKIT_READ_ACTIONS = {
  invoices: { list: true, get: true, search: true },
  disputes: { list: true, get: true },
  transactions: { list: true },
  insights: { get: true },
  subscriptions: { show: true },
  subscriptionPlans: { list: true, show: true },
  products: { list: true, show: true },
};

export function paypalTools(
  rf: Retrofit,
  emit: (e: ToolEvent) => void,
): { tools: BetaRunnableTool<any>[]; source: 'paypal-agent-toolkit' | 'retrofit-mock' } {
  if (
    rf.config.env.paypalEnvironment === 'MOCK' ||
    !rf.config.env.paypalClientId ||
    !rf.config.env.paypalClientSecret
  ) {
    return { tools: mockTools(rf, emit), source: 'retrofit-mock' };
  }
  const toolkit = new PayPalAgentToolkit({
    clientId: rf.config.env.paypalClientId,
    clientSecret: rf.config.env.paypalClientSecret,
    configuration: {
      actions: TOOLKIT_READ_ACTIONS,
      context: { sandbox: rf.config.env.paypalEnvironment !== 'PRODUCTION' },
    },
  });
  const tools = toolkit.getTools().map((t) => {
    const { $schema: _ignored, ...schema } = (t.function.parameters ?? {
      type: 'object',
      properties: {},
    }) as Record<string, unknown>;
    return betaTool({
      name: `paypal_${t.function.name}`,
      description: `[PayPal Agent Toolkit] ${(t.function.description ?? '').trim()}`,
      inputSchema: { type: 'object', ...schema } as any,
      run: async (input: unknown) => {
        emit({ type: 'tool_call', name: `paypal_${t.function.name}`, input });
        const res = await toolkit.handleToolCall({
          id: `call_${Date.now()}`,
          type: 'function',
          function: { name: t.function.name, arguments: JSON.stringify(input ?? {}) },
        });
        const content = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
        const out = json(safeParse(content));
        emit({ type: 'tool_result', name: `paypal_${t.function.name}`, output: out.slice(0, 400) });
        return out;
      },
    });
  });
  return { tools, source: 'paypal-agent-toolkit' };
}

function safeParse(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function mockTools(rf: Retrofit, emit: (e: ToolEvent) => void): BetaRunnableTool<any>[] {
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    fn: (i: any) => Promise<unknown>,
  ) =>
    betaTool({
      name: `paypal_${name}`,
      description: `[PayPal] ${description}`,
      inputSchema: { type: 'object', properties, required, additionalProperties: false } as any,
      run: async (input: any) => {
        emit({ type: 'tool_call', name: `paypal_${name}`, input });
        try {
          const out = json(await fn(input ?? {}));
          emit({ type: 'tool_result', name: `paypal_${name}`, output: out.slice(0, 400) });
          return out;
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    });
  return [
    tool(
      'get_invoice',
      'Get a PayPal invoice by its PayPal id (INV2-...).',
      { invoice_id: { type: 'string' } },
      ['invoice_id'],
      (i) => rf.paypal.getInvoice(i.invoice_id),
    ),
    tool(
      'search_invoicing',
      'Search PayPal invoices by invoice number, recipient email or statuses.',
      {
        invoice_number: { type: 'string' },
        recipient_email: { type: 'string' },
        status: { type: 'array', items: { type: 'string' } },
      },
      [],
      async (i) => {
        const r = await rf.paypal.searchInvoices(i);
        return {
          total_items: r.total_items,
          items: (r.items ?? []).map((x) => ({
            id: x.id,
            status: x.status,
            number: x.detail?.invoice_number,
            amount: x.amount,
            due_amount: x.due_amount,
          })),
        };
      },
    ),
    tool('list_disputes', 'List PayPal disputes.', {}, [], () => rf.paypal.listDisputes()),
    tool(
      'get_dispute',
      'Get a PayPal dispute with its messages and disputed transactions.',
      { dispute_id: { type: 'string' } },
      ['dispute_id'],
      (i) => rf.paypal.getDispute(i.dispute_id),
    ),
    tool(
      'list_transactions',
      'List PayPal transactions in the last N days (default 31), including fees.',
      { days: { type: 'integer' } },
      [],
      (i) => rf.paypal.listTransactions(new Date(Date.now() - (i.days ?? 31) * 86400000), new Date()),
    ),
    tool(
      'show_subscription_details',
      'Get a PayPal subscription by id (I-...).',
      { subscription_id: { type: 'string' } },
      ['subscription_id'],
      (i) => rf.paypal.getSubscription(i.subscription_id),
    ),
  ];
}
