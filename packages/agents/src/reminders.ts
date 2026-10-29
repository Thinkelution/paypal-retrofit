import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  customerProfiles,
  type CollectionItem,
  type ReminderText,
  type Retrofit,
} from '@paypal-retrofit/core';
import * as z from 'zod/v4';
import {
  AgentUnavailableError,
  claude,
  claudeConfigured,
  describeApiError,
  FALLBACK_BETA,
  model,
} from './client.ts';

const Drafts = z.object({
  reminders: z.array(
    z.object({
      legacyPk: z.string(),
      subject: z.string().describe('Under 90 characters'),
      note: z.string().describe('2 to 4 sentences, under 600 characters'),
    }),
  ),
});

const SYSTEM = `You write payment reminders for a small business. Each reminder goes out inside a PayPal invoice reminder email, which already contains the pay button, so never paste links.

Write like the owner: warm, plain and brief. Match the requested tone exactly:
- friendly: assume it was missed; no pressure.
- firm: state how overdue it is and ask for payment this week; offer to talk if something is wrong.
- final: say it is the last reminder and ask for payment within 7 days or a reply to agree a payment plan.
- instalment: a reminder about one instalment of an agreed payment plan.

Use the customer's first name and the exact amounts and dates given. Use the history only to adjust warmth (thank long-standing, reliable customers; be clearer with habitual late payers). Never threaten, never mention fees, interest, legal action, credit scores or collections agencies, and never invent facts. Sign off with the business name.`;

/** Personalised reminder text for a batch of collection items (one structured call). */
export async function draftReminders(
  rf: Retrofit,
  items: CollectionItem[],
): Promise<Map<string, ReminderText>> {
  if (!claudeConfigured()) throw new AgentUnavailableError();
  const profiles = await customerProfiles(rf);
  const byNumber = new Map<string, string>();
  const invoices = await rf.source.readTable(rf.mapping.entities.invoice.table);
  for (const r of invoices)
    byNumber.set(
      String(r[rf.mapping.entities.invoice.pk]),
      String(r[rf.mapping.entities.invoice.fields.customer]),
    );
  const facts = items.map((i) => {
    const p = profiles.get(byNumber.get(i.legacyPk) ?? '');
    return {
      legacyPk: i.legacyPk,
      tone: i.tone,
      invoice: i.number,
      firstName: i.customerFirstName,
      amountDue: i.amountDue,
      currency: rf.mapping.currency,
      dueDate: i.due,
      daysOverdue: i.daysOverdue,
      remindersAlreadySent: i.remindersSent,
      instalment: i.instalment,
      history: p
        ? {
            invoices: p.invoices,
            paidOnTimeRate: p.onTimeRate,
            usualDaysLate: p.medianDaysLate,
            behaviour: p.behaviour,
          }
        : null,
    };
  });
  try {
    const r = await claude().beta.messages.parse({
      model: model(),
      max_tokens: 8000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(Drafts) },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `Business: ${rf.config.business.name}\nReminders to write:\n${JSON.stringify(facts, null, 1)}`,
        },
      ],
    });
    if (r.stop_reason === 'refusal' || !r.parsed_output) throw new Error('No drafts returned');
    const out = new Map<string, ReminderText>();
    for (const d of r.parsed_output.reminders) {
      if (items.some((i) => i.legacyPk === d.legacyPk))
        out.set(d.legacyPk, { subject: d.subject.slice(0, 200), note: d.note.slice(0, 4000) });
    }
    return out;
  } catch (e) {
    throw new Error(describeApiError(e));
  }
}
