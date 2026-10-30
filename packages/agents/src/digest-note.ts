import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { redact, type DigestData } from '@paypal-retrofit/core';
import * as z from 'zod/v4';
import {
  AgentUnavailableError,
  claude,
  claudeConfigured,
  describeApiError,
  FALLBACK_BETA,
  model,
} from './client.ts';

const Note = z.object({
  note: z.string().describe('2 or 3 sentences, under 420 characters'),
});

const SYSTEM = `You write the opening lines of a small-business owner's morning email about getting paid. You receive the facts as JSON.

Write two or three plain sentences: what came in, then the one or two decisions that matter most today and why (name the customer and invoice). If nothing needs the owner, say so and stop. Use only the figures given; never invent or round differently. No greeting (it is added for you), no bullet points, no links, no exclamation marks.`;

/** A short, human opening for the owner's digest, written by Claude from the digest facts. */
export async function writeDigestNote(d: DigestData): Promise<string> {
  if (!claudeConfigured()) throw new AgentUnavailableError();
  const facts = redact({
    business: d.business,
    currency: d.currency,
    cameIn: d.money,
    totals: d.totals,
    waitingForApproval: d.approvals.map(({ id: _id, ...a }) => a),
    approvalsTotal: d.approvalsTotal,
    heldForBusinessHours: d.scheduled.length,
    callTheseCustomers: d.escalate,
    atRisk: d.risks,
    needsALook: d.attention,
    playbook: d.playbook,
  });
  try {
    const r = await claude().beta.messages.parse({
      model: model(),
      max_tokens: 2000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(Note) },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: JSON.stringify(facts, null, 1) }],
    });
    if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error('No note returned');
    return r.parsed_output.note.slice(0, 600);
  } catch (e) {
    throw new Error(describeApiError(e));
  }
}
