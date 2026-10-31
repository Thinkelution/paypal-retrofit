import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  addDaysIso,
  parseInvoiceText,
  round2,
  type IntakeContext,
  type InvoiceDraft,
} from '@paypal-retrofit/core';
import * as z from 'zod/v4';
import { claude, claudeConfigured, describeApiError, FALLBACK_BETA, model } from './client.ts';

const DraftOutput = z.object({
  customer: z.object({
    knownKey: z
      .string()
      .nullable()
      .describe('The key of the known customer this invoice is for, or null if new or unsure'),
    name: z.string().describe('Customer or company name as written (or the known name)'),
    email: z.string().nullable().describe('Email if written, or the known customer email; else null'),
  }),
  lines: z.array(
    z.object({
      description: z
        .string()
        .describe('Short line the customer will read, e.g. "Replace water heater valve"'),
      qty: z.number(),
      unitPrice: z.number().describe('Price per unit before tax; 0 if no price can be read'),
    }),
  ),
  dueDate: z.string().nullable().describe('YYYY-MM-DD when a due date is written; else null'),
  dueInDays: z.number().int().nullable().describe('For "net 30", "due in 2 weeks" and similar; else null'),
  notes: z
    .string()
    .nullable()
    .describe('Job address, what was done, or anything else the customer should see; null if nothing'),
  questions: z
    .array(z.string())
    .describe(
      'What the owner should check before sending: unreadable amounts, a missing email; empty if none',
    ),
});
type DraftOutput = z.infer<typeof DraftOutput>;

const SYSTEM = `You turn what a small business owner says, or a photo of their paper job sheet, quote, receipt or invoice, into an invoice draft. The draft is shown to the owner to check before anything is sent.

- Customer: if it matches one of the known customers (by name, company or email), return that customer's key, name and email. Otherwise return the name and any email that is written, with knownKey null. Never invent an email address.
- Lines: one per item of work, labour or material. Quantity defaults to 1. Prices are per unit before tax; when only a line total is written, use it with quantity 1. Never invent a price: use a catalogue price only when the item clearly is that catalogue item, otherwise use 0 and ask about it. Ignore subtotals, tax and grand totals as lines, but if a written grand total disagrees with the lines, say so in questions.
- Dates: dueDate only if a date is written; dueInDays for terms like "net 30". Today's date is given so you can resolve words like "Friday".
- Handwriting can be hard to read. If a digit or word is uncertain, give your best reading and name it in questions.`;

export interface DraftRequest {
  text?: string;
  image?: { data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' };
}

/**
 * Reads a sentence, or a photo of a paper job sheet, into an invoice draft. With Claude it uses vision and
 * the business's own customers and catalogue; without Claude, sentences go through the rule-based reader
 * and photos are refused.
 */
export async function draftInvoice(
  req: DraftRequest,
  ctx: IntakeContext,
): Promise<InvoiceDraft & { warning?: string }> {
  const text = req.text?.trim();
  if (!text && !req.image) throw new Error('Type what the invoice is for, or add a photo.');
  if (!claudeConfigured()) {
    if (req.image)
      throw new Error('Reading photos needs Claude. Set ANTHROPIC_API_KEY, or type the invoice instead.');
    return parseInvoiceText(text!, ctx);
  }
  const known = {
    business: ctx.business,
    currency: ctx.currency,
    today: ctx.today,
    customers: ctx.customers.slice(0, 300),
    catalogue: ctx.products.slice(0, 100),
  };
  try {
    const response = await claude().beta.messages.parse({
      model: model(),
      max_tokens: 16000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'high', format: betaZodOutputFormat(DraftOutput) },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            ...(req.image
              ? [
                  {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: req.image.mediaType,
                      data: req.image.data,
                    },
                  },
                ]
              : []),
            {
              type: 'text' as const,
              text: `Business and known data:\n${JSON.stringify(known)}\n\n${
                text ? `The owner says: ${text}` : 'Read the attached photo.'
              }`,
            },
          ],
        },
      ],
    });
    const out = response.parsed_output;
    if (response.stop_reason === 'refusal' || !out) throw new Error('Claude could not read that.');
    return toDraft(out, ctx);
  } catch (e) {
    if (!text) throw new Error(describeApiError(e));
    return {
      ...parseInvoiceText(text, ctx),
      warning: `Claude was unavailable (${describeApiError(e)}); read with rules.`,
    };
  }
}

function toDraft(o: DraftOutput, ctx: IntakeContext): InvoiceDraft {
  const known = o.customer.knownKey ? ctx.customers.find((c) => c.key === o.customer.knownKey) : undefined;
  const due =
    o.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(o.dueDate)
      ? o.dueDate
      : o.dueInDays && o.dueInDays > 0
        ? addDaysIso(ctx.today, o.dueInDays)
        : undefined;
  return {
    customer: known
      ? { key: known.key, name: known.name, email: known.email }
      : { name: o.customer.name.trim(), email: o.customer.email?.trim() || undefined },
    lines: o.lines.map((l) => ({
      description: l.description.trim(),
      qty: l.qty > 0 ? l.qty : 1,
      unitPrice: round2(l.unitPrice),
    })),
    due,
    notes: o.notes?.trim() || undefined,
    questions: o.questions,
    engine: 'claude',
  };
}
