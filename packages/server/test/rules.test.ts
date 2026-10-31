import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRuleChanges,
  describeRules,
  listCustomers,
  parseRulesWithPatterns,
  planCollections,
  previewRules,
} from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { createServer } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('rules in plain English', () => {
  it('compiles common sentences, previews what changes today, and only then applies them', async () => {
    const ctx = { currency: 'USD', customers: [{ key: '7', name: 'Elmwood Day School' }] };
    const { changes, unsupported } = parseRulesWithPatterns(
      `Refunds over $200 need me. Never chase schools before the 20th. No reminders after 7pm or at weekends.
       2% late fee after 30 days; 3% off if paid within 7 days. Agree plans up to $800 in 3 payments.
       Remind at 5, 15 and 40 days. No late fees for Elmwood Day School. Paint the office blue.`,
      ctx,
    );
    expect(changes.map((c) => c.type)).toEqual([
      'approval',
      'customer',
      'quiet_hours',
      'late_fee',
      'discount',
      'plans',
      'reminder_days',
      'customer',
    ]);
    expect(changes[0]).toMatchObject({ kind: 'create_refund', mode: 'confirm', minAmount: 200 });
    expect(changes[1]).toMatchObject({
      rule: { match: { nameContains: ['school'] }, noRemindersBeforeDay: 20 },
    });
    expect(changes[2]).toMatchObject({ start: '19:00', end: '08:00', weekends: true });
    expect(changes[7]).toMatchObject({ rule: { match: { customers: ['7'] }, noLateFees: true } });
    expect(unsupported).toEqual(['Paint the office blue']);

    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const target = (await planCollections(h.rf, '2026-11-05')).find((i) => i.decision === 'remind')!;
    const customers = (await listCustomers(h.rf)).map((c) => ({ key: c.pk, name: c.name }));
    const rule = parseRulesWithPatterns(`Never chase ${target.customer} before the 25th`, {
      currency: 'USD',
      customers,
    });
    expect(rule.changes[0]).toMatchObject({ type: 'customer', rule: { noRemindersBeforeDay: 25 } });
    const candidate = applyRuleChanges(h.rf.mapping, rule.changes);
    const preview = await previewRules(h.rf, candidate, '2026-11-05');
    expect(preview.collections.find((c) => c.number === target.number)).toMatchObject({
      before: 'remind',
      after: 'hold',
    });
    expect(preview.summary).toMatch(/reminder decision/);
    expect(h.rf.mapping.customerRules).toEqual([]); // nothing saved by a preview
    expect(describeRules(candidate, customers).join(' ')).toMatch(
      new RegExp(`Never chase ${target.customer} before the 25th`, 'i'),
    );

    // Over HTTP: preview, then apply, and the rule now holds that customer's reminders.
    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });
    const post = async (p: string, body: unknown) =>
      (await (
        await fetch(server.url + p, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as any;
    const pv = await post('/api/rules/preview', {
      text: 'Refunds over $150 need me. No more than 10 reminders a day.',
    });
    expect(pv).toMatchObject({ engine: 'rules', unsupported: [] });
    expect(pv.changes).toHaveLength(2);
    const applied = await post('/api/rules/apply', { changes: pv.changes });
    expect(applied.sentences.join(' ')).toMatch(/Refunds of \$150\.00 or more wait for your OK/);
    expect(h.rf.mapping.limits.find((l) => l.kind === 'send_reminder')?.perDay).toBe(10);
  });
});
