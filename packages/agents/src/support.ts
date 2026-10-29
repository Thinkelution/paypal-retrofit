import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { redact, type Retrofit } from '@paypal-retrofit/core';
import * as z from 'zod/v4';
import {
  AgentUnavailableError,
  claude,
  claudeConfigured,
  describeApiError,
  FALLBACK_BETA,
  model,
} from './client.ts';

const DisputeDraft = z.object({
  summary: z.string().describe('Two sentences: what the buyer claims and what the records show'),
  recommendation: z.enum(['contest', 'offer_partial_refund', 'accept']),
  reasoning: z.string(),
  response: z
    .string()
    .describe('The message to the buyer and PayPal, ready to paste. Polite, factual, under 1500 characters.'),
  evidence: z.array(z.object({ item: z.string(), source: z.string(), available: z.boolean() })),
  missing: z.array(z.string()).describe('What the owner should gather before responding'),
});
export type DisputeDraft = z.infer<typeof DisputeDraft>;

/**
 * Drafts a dispute response from the PayPal dispute and the legacy invoice it relates to. Text only:
 * the owner reviews it and submits it in PayPal; nothing is sent from here.
 */
export async function draftDisputeResponse(
  rf: Retrofit,
  disputeId: string,
): Promise<{ draft: DisputeDraft; invoiceNumber: string | null }> {
  if (!claudeConfigured()) throw new AgentUnavailableError();
  const dispute = await rf.paypal.getDispute(disputeId);
  const d = rf.state.listDiscrepancies(true).find((x) => x.kind === 'dispute' && x.paypalId === disputeId);
  const inv = d?.legacyPk ? await rf.invoice(d.legacyPk) : null;
  const link = inv ? rf.state.getLink('invoice', inv.pk) : undefined;
  const context = {
    business: rf.config.business.name,
    dispute,
    legacyInvoice: inv && {
      number: inv.number,
      status: inv.status,
      issued: inv.issued,
      due: inv.due,
      total: inv.total,
      notes: inv.notes,
      lines: inv.lines,
      customer: inv.customer?.name,
    },
    paypalInvoice: link && {
      id: link.paypalId,
      status: link.paypalStatus,
      paid: link.paypalPaid,
      paidAt: link.paypalPaidAt,
      transactionId: link.paypalTransactionId,
    },
  };
  try {
    const r = await claude().beta.messages.parse({
      model: model(),
      max_tokens: 8000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(DisputeDraft) },
      system: `You help a small business respond to a PayPal buyer dispute. Use only the facts in the records provided; never invent delivery dates, messages or evidence. If the records do not support contesting, say so and recommend a fair resolution. Write the response in the business's voice, first person plural.`,
      messages: [{ role: 'user', content: `Records:\n${JSON.stringify(redact(context), null, 1)}` }],
    });
    if (r.stop_reason === 'refusal') throw new Error('The request was declined.');
    if (!r.parsed_output) throw new Error('The draft could not be parsed.');
    return { draft: r.parsed_output, invoiceNumber: inv?.number ?? null };
  } catch (e) {
    throw new Error(describeApiError(e));
  }
}
