import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { DEFAULT_POLICIES, summary, type ActionKind, type Retrofit } from '@paypal-retrofit/core';
import {
  AgentUnavailableError,
  claude,
  claudeConfigured,
  describeApiError,
  FALLBACK_BETA,
  model,
} from './client.ts';
import { engineTools, type ToolEvent } from './tools/engine-tools.ts';
import { paypalTools } from './tools/paypal-tools.ts';

export type OpsEvent =
  | ToolEvent
  | { type: 'text'; text: string }
  | { type: 'done'; text: string; usage?: unknown }
  | { type: 'error'; message: string };

const SESSION_LIMIT = 50;

/**
 * The Ops agent answers questions about receivables and proposes actions. It reads through retrofit's
 * ledger, the legacy database (read-only) and PayPal; it changes things only via propose_action.
 */
export class OpsAgent {
  private sessions = new Map<string, BetaMessageParam[]>();

  constructor(private readonly rf: Retrofit) {}

  get available() {
    return claudeConfigured();
  }

  reset(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  private async systemPrompt(toolSource: string) {
    const s = await summary(this.rf);
    const m = this.rf.mapping;
    const policies = Object.fromEntries(
      (Object.keys(DEFAULT_POLICIES) as ActionKind[]).map((k) => [k, this.rf.policyFor(k)]),
    );
    // Stable text first (cacheable); the live numbers come from the business_summary tool.
    return `You are the operations agent for ${s.business}, a business that has just connected its existing invoicing system to PayPal using paypal-retrofit.

You help the owner understand money owed and paid, and you take care of routine follow-up. The owner is busy and not technical: answer in plain language, lead with the answer, and keep it short. State amounts with the currency (${m.currency}). Name invoices by their legacy number (for example INV-1042), not by PayPal ids, unless asked.

What you can see:
- The ledger: every legacy invoice and subscription joined with its PayPal invoice or subscription (find_invoices, invoice_detail, business_summary).
- The legacy database itself, read-only (legacy_sql). Tables: ${m.entities.customer.table} (customers), ${m.entities.invoice.table} (invoices)${m.entities.invoice.lines ? `, ${m.entities.invoice.lines.table} (line items)` : ''}${m.entities.subscription ? `, ${m.entities.subscription.table} (recurring agreements)` : ''}.
- PayPal, read-only (tools prefixed paypal_, from ${toolSource === 'paypal-agent-toolkit' ? "PayPal's Agent Toolkit" : 'the PayPal API'}).
- Discrepancies found by reconciliation, and actions taken or waiting for approval.

What you can do: only propose_action. The owner's policies decide what runs: ${JSON.stringify(policies)}. "confirm" means it waits for the owner to approve in the dashboard; say so plainly. Never claim something happened unless the tool result says status "executed".

Rules:
- Look things up before answering; never guess invoice numbers, amounts, dates or ids.
- When asked to do something to several invoices, find them first, then propose one action per invoice, then summarise what was proposed in a short list.
- Be careful with money: do not propose refunds, cancellations or dispute acceptance unless the owner asked for that specific outcome.
- Customer emails are masked in tool results; that is intended.
- If a question is outside receivables and PayPal, say briefly that you cannot help with it.`;
  }

  async chat(sessionId: string, message: string, onEvent: (e: OpsEvent) => void = () => {}): Promise<string> {
    if (!this.available) throw new AgentUnavailableError();
    const emit = (e: OpsEvent) => onEvent(e);
    const pp = paypalTools(this.rf, emit);
    const tools = [...engineTools(this.rf, emit), ...pp.tools];
    const history = this.sessions.get(sessionId) ?? [];
    const messages: BetaMessageParam[] = [...history, { role: 'user', content: message }];

    const runner = claude().beta.messages.toolRunner({
      model: model(),
      max_tokens: 16000,
      thread: false,
      max_iterations: 16,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: [
        { type: 'text', text: await this.systemPrompt(pp.source), cache_control: { type: 'ephemeral' } },
      ],
      tools,
      messages,
    });

    let finalText = '';
    try {
      for await (const msg of runner) {
        if (msg.stop_reason === 'refusal') {
          emit({ type: 'error', message: 'The request was declined.' });
          break;
        }
        for (const block of msg.content) {
          if (block.type === 'text' && block.text.trim()) {
            finalText = block.text;
            emit({ type: 'text', text: block.text });
          }
        }
      }
      const final = await runner.done();
      const transcript = [...runner.params.messages];
      const last = transcript[transcript.length - 1];
      if (!last || last.role !== 'assistant') transcript.push({ role: 'assistant', content: final.content });
      this.sessions.set(sessionId, transcript.slice(-SESSION_LIMIT));
      emit({ type: 'done', text: finalText, usage: final.usage });
      return finalText;
    } catch (e) {
      const msg = describeApiError(e);
      emit({ type: 'error', message: msg });
      throw new Error(msg);
    }
  }
}
