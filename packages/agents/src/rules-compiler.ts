import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  ACTION_KINDS,
  parseRulesWithPatterns,
  type RuleChange,
  type RulesContext,
} from '@paypal-retrofit/core';
import * as z from 'zod/v4';
import { claude, claudeConfigured, describeApiError, FALLBACK_BETA, model } from './client.ts';

const Change = z.object({
  type: z.enum([
    'approval',
    'limit',
    'quiet_hours',
    'customer',
    'late_fee',
    'discount',
    'plans',
    'reminder_days',
  ]),
  kind: z.enum(ACTION_KINDS).nullable().describe('For approval and limit: the kind of action'),
  mode: z.enum(['auto', 'confirm', 'never']).nullable().describe('For approval'),
  minAmount: z.number().nullable(),
  maxAmount: z.number().nullable(),
  perDay: z.number().int().nullable(),
  amountPerDay: z.number().nullable(),
  start: z.string().nullable().describe('For quiet_hours: HH:MM, 24-hour'),
  end: z.string().nullable(),
  weekends: z.boolean().nullable(),
  customerKeys: z
    .array(z.string())
    .nullable()
    .describe('For customer: keys of customers named, from the list'),
  nameContains: z
    .array(z.string())
    .nullable()
    .describe('For customer: words in customer names when no customer is named, singular, e.g. "school"'),
  noRemindersBeforeDay: z.number().int().nullable(),
  noReminders: z.boolean().nullable(),
  noLateFees: z.boolean().nullable(),
  feeKind: z.enum(['percent', 'flat']).nullable(),
  amount: z.number().nullable().describe('Late fee amount, or discount percent'),
  afterDays: z.number().int().nullable(),
  withinDays: z.number().int().nullable(),
  installments: z.number().int().nullable(),
  days: z.array(z.number().int()).nullable().describe('For reminder_days'),
  explanation: z.string().describe('The rule restated in plain words'),
});
const Compiled = z.object({
  changes: z.array(Change),
  unsupported: z
    .array(z.string())
    .describe('Parts of the text that cannot be expressed with these rule types'),
});

const SYSTEM = `You turn a small-business owner's instructions about getting paid into structured rules for their payment system. The rules decide what runs automatically and what waits for the owner.

Rule types:
- approval: when an action of a kind runs on its own (auto), waits for the owner (confirm) or is never done, optionally only between amounts. "Refunds over $200 need me" = approval create_refund confirm minAmount 200.
- limit: at most perDay actions, or amountPerDay of money, of a kind run on their own per day.
- quiet_hours: no messages to customers between start and end (24-hour HH:MM), optionally at weekends too.
- customer: for some customers (customerKeys from the list when named, else nameContains words): noRemindersBeforeDay (day of month), noReminders, noLateFees.
- late_fee: feeKind percent or flat, amount, afterDays overdue.
- discount: amount (percent) off for paying within withinDays.
- plans: payment plans up to maxAmount in up to installments payments are agreed without the owner.
- reminder_days: reminders at these days overdue.

Only express what the owner actually said. Put anything that does not fit these types in unsupported, in their words. Never loosen a safety rule the owner did not mention.`;

/** Compiles the owner's sentences into rule changes with Claude, or with patterns when Claude is not configured. */
export async function compileRules(
  text: string,
  ctx: RulesContext,
): Promise<{ changes: RuleChange[]; unsupported: string[]; engine: 'claude' | 'rules'; warning?: string }> {
  if (!claudeConfigured()) return { ...parseRulesWithPatterns(text, ctx), engine: 'rules' };
  try {
    const response = await claude().beta.messages.parse({
      model: model(),
      max_tokens: 8000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(Compiled) },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: `Currency: ${ctx.currency}. Customers: ${JSON.stringify(ctx.customers.slice(0, 300))}\n\nThe owner writes:\n${text.slice(0, 4000)}`,
        },
      ],
    });
    const o = response.parsed_output;
    if (response.stop_reason === 'refusal' || !o) throw new Error('Claude could not read the rules');
    const known = new Set(ctx.customers.map((c) => c.key));
    const changes: RuleChange[] = [];
    for (const c of o.changes) {
      const explanation = c.explanation;
      if (c.type === 'approval' && c.kind && c.mode)
        changes.push({
          type: 'approval',
          kind: c.kind,
          mode: c.mode,
          minAmount: c.minAmount ?? undefined,
          maxAmount: c.maxAmount ?? undefined,
          explanation,
        });
      else if (c.type === 'limit' && c.kind && (c.perDay || c.amountPerDay))
        changes.push({
          type: 'limit',
          kind: c.kind,
          perDay: c.perDay ?? undefined,
          amountPerDay: c.amountPerDay ?? undefined,
          explanation,
        });
      else if (
        c.type === 'quiet_hours' &&
        c.start &&
        c.end &&
        /^\d{2}:\d{2}$/.test(c.start) &&
        /^\d{2}:\d{2}$/.test(c.end)
      )
        changes.push({
          type: 'quiet_hours',
          start: c.start,
          end: c.end,
          weekends: Boolean(c.weekends),
          explanation,
        });
      else if (c.type === 'customer') {
        const customers = (c.customerKeys ?? []).filter((k) => known.has(k));
        const nameContains = (c.nameContains ?? []).filter((w) => w.trim().length >= 2);
        if (!customers.length && !nameContains.length) continue;
        changes.push({
          type: 'customer',
          rule: {
            match: customers.length ? { customers } : { nameContains },
            noRemindersBeforeDay: c.noRemindersBeforeDay
              ? Math.min(28, Math.max(2, c.noRemindersBeforeDay))
              : undefined,
            noReminders: c.noReminders ?? undefined,
            noLateFees: c.noLateFees ?? undefined,
            note: explanation,
          },
          explanation,
        });
      } else if (c.type === 'late_fee' && c.feeKind && c.amount && c.afterDays != null)
        changes.push({
          type: 'late_fee',
          kind: c.feeKind,
          amount: c.amount,
          afterDays: c.afterDays,
          explanation,
        });
      else if (c.type === 'discount' && c.amount && c.withinDays)
        changes.push({ type: 'discount', percent: c.amount, withinDays: c.withinDays, explanation });
      else if (c.type === 'plans' && (c.maxAmount != null || c.installments))
        changes.push({
          type: 'plans',
          maxAmount: c.maxAmount ?? undefined,
          maxInstallments: c.installments ?? undefined,
          explanation,
        });
      else if (c.type === 'reminder_days' && c.days?.length)
        changes.push({
          type: 'reminder_days',
          days: [...new Set(c.days)].sort((a, b) => a - b),
          explanation,
        });
    }
    return { changes, unsupported: o.unsupported, engine: 'claude' };
  } catch (e) {
    return {
      ...parseRulesWithPatterns(text, ctx),
      engine: 'rules',
      warning: `Claude was unavailable (${describeApiError(e)}); read with patterns.`,
    };
  }
}
