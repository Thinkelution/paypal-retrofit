import type { Retrofit } from './engine.ts';
import { buildStatement } from './statements.ts';

export type CustomerRequestKind = 'promise' | 'plan' | 'question';

/**
 * A customer tells the business something about an open invoice, in the portal or through their own AI
 * assistant: the date they will pay by, a request to pay in parts, or a question. Promises and questions
 * hold reminders and late fees; a plan request goes to the owner straight away as a payment-plan offer,
 * decided by their rules (confirm by default).
 */
export async function submitCustomerRequest(
  rf: Retrofit,
  input: {
    customerPk: string;
    legacyPk: string;
    kind: string;
    date?: string;
    installments?: number;
    message?: string;
    /** How it arrived, for the owner: "in the portal", "through their AI assistant". */
    via?: string;
    origin?: 'portal' | 'inbox' | 'assistant';
  },
): Promise<{ number: string; kind: CustomerRequestKind }> {
  const s = await buildStatement(rf, input.customerPk);
  const line = s.lines.find((l) => l.legacyPk === input.legacyPk);
  if (!line || !['promise', 'plan', 'question'].includes(input.kind))
    throw new Error('That invoice is not open');
  const kind = input.kind as CustomerRequestKind;
  const date = String(input.date ?? '');
  if (kind === 'promise' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Choose a date');
  const message = String(input.message ?? '').trim();
  if (kind === 'question' && !message) throw new Error('Write the question');
  const installments = Math.min(4, Math.max(2, Number(input.installments ?? 2) || 2));
  rf.state.addRequest({
    customerPk: input.customerPk,
    legacyPk: input.legacyPk,
    kind,
    detail: kind === 'question' ? message.slice(0, 1000) : null,
    until: kind === 'promise' ? date : null,
    installments: kind === 'plan' ? installments : null,
  });
  if (kind === 'plan' && line.inPayPal && !line.onPlan) {
    await rf
      .propose({
        origin: input.origin ?? 'portal',
        kind: 'offer_payment_plan',
        target: { entity: 'invoice', legacyPk: input.legacyPk, label: line.number },
        payload: { installments, intervalDays: 14, amount: line.balance },
        reason: `${s.customer.name} asked ${input.via ?? 'in the portal'} to pay ${line.number} in ${installments} parts`,
      })
      .catch((e) => rf.log.warn(`plan request: ${(e as Error).message}`));
  }
  rf.emit('request', { customerPk: input.customerPk, kind });
  return { number: line.number, kind };
}
