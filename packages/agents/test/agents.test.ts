import express from 'express';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { harness, listen } from '../../core/test/helpers.ts';
import { engineTools, OpsAgent, paypalTools, proposeMapping } from '../src/index.ts';
import { json } from '../src/tools/engine-tools.ts';

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A stand-in for the Messages API: first asks for find_invoices, then answers using the tool result. */
async function fakeClaude() {
  const app = express();
  const requests: any[] = [];
  app.post('/v1/messages', express.json({ limit: '5mb' }), (req, res) => {
    requests.push({ body: req.body, beta: req.header('anthropic-beta') });
    const last = req.body.messages[req.body.messages.length - 1];
    const toolResult = Array.isArray(last.content)
      ? last.content.find((b: any) => b.type === 'tool_result')
      : null;
    const base = {
      id: `msg_${requests.length}`,
      type: 'message',
      role: 'assistant',
      model: req.body.model,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    if (!toolResult) {
      return res.json({
        ...base,
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'find_invoices',
            input: { minDaysOverdue: 14, legacyState: 'open' },
          },
        ],
      });
    }
    const text = typeof toolResult.content === 'string' ? toolResult.content : toolResult.content?.[0]?.text;
    const count = JSON.parse(text).count;
    return res.json({
      ...base,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: `${count} invoices are more than 14 days overdue.` }],
    });
  });
  const server = await listen(app);
  return { ...server, requests };
}

describe('engine tools', () => {
  it('keeps long tool results valid JSON by dropping rows, not cutting text', () => {
    const rows = Array.from({ length: 400 }, (_, i) => ({ number: `INV-${1000 + i}`, note: 'x'.repeat(60) }));
    const out = JSON.parse(json({ count: rows.length, rows }));
    expect(out.count).toBe(400);
    expect(out.rows.length).toBeLessThan(400);
    expect(out.rows.length + out.omitted.rows).toBe(400);
    expect(out.rows[0].number).toBe('INV-1000');
  });

  it('find_invoices and propose_action go through the ledger and the policy gate', async () => {
    h = await harness();
    await h.rf.sync();
    const events: any[] = [];
    const tools = engineTools(h.rf, (e) => events.push(e)) as any[];
    const find = tools.find((t) => t.name === 'find_invoices')!;
    const out = JSON.parse(String(await find.run({ minDaysOverdue: 14, legacyState: 'open' })));
    expect(out.count).toBeGreaterThan(5);
    expect(out.rows[0].customerEmail).toMatch(/\*\*\*@/);

    const propose = tools.find((t) => t.name === 'propose_action')!;
    const r = JSON.parse(
      String(
        await propose.run({
          kind: 'send_reminder',
          entity: 'invoice',
          number: out.rows[0].number,
          reason: 'Overdue',
        }),
      ),
    );
    expect(r.status).toBe('pending');
    expect(events.some((e) => e.type === 'action_proposed')).toBe(true);

    const sql = tools.find((t) => t.name === 'legacy_sql')!;
    expect(String(await sql.run({ sql: 'DELETE FROM invoices' }))).toMatch(/^Error/);
  });
});

describe('PayPal Agent Toolkit bridge', () => {
  it('exposes only read tools with valid object schemas', async () => {
    h = await harness();
    const rf = h.rf;
    (rf.config.env as any).paypalEnvironment = 'SANDBOX';
    (rf.config.env as any).paypalClientId = 'id';
    (rf.config.env as any).paypalClientSecret = 'secret';
    const { tools, source } = paypalTools(rf, () => {});
    expect(source).toBe('paypal-agent-toolkit');
    const names = tools.map((t) => t.name);
    expect(names).toContain('paypal_get_invoice');
    expect(names).toContain('paypal_list_disputes');
    expect(names.some((n) => /send|cancel|refund|accept|create/.test(n))).toBe(false);
    for (const t of tools) expect((t as any).input_schema.type).toBe('object');
    (rf.config.env as any).paypalEnvironment = 'MOCK';
  });
});

describe('Ops agent loop', () => {
  let claude: Awaited<ReturnType<typeof fakeClaude>>;
  beforeAll(async () => {
    claude = await fakeClaude();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = claude.url;
  });

  it('runs tools and keeps the conversation', async () => {
    h = await harness();
    await h.rf.sync();
    const agent = new OpsAgent(h.rf);
    const events: any[] = [];
    const answer = await agent.chat('s1', 'Which invoices are more than two weeks overdue?', (e) =>
      events.push(e),
    );
    expect(answer).toMatch(/\d+ invoices are more than 14 days overdue/);
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'find_invoices')).toBe(true);
    const first = claude.requests[0];
    expect(first.body.model).toBe('claude-opus-5-5');
    expect(first.body.fallbacks).toBe('default');
    expect(first.beta).toContain('server-side-fallback-2026-07-01');
    expect(first.body.output_config.effort).toBe('medium');
    expect(first.body.tool_choice).toBeUndefined();
    expect(first.body.tools.map((t: any) => t.name)).toEqual(
      expect.arrayContaining(['find_invoices', 'propose_action', 'paypal_get_invoice']),
    );
  });

  it('mapper falls back to the heuristic when Claude fails', async () => {
    h = await harness();
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:9';
    const r = await proposeMapping(h.schema);
    process.env.ANTHROPIC_BASE_URL = claude.url;
    expect(r.engine).toBe('heuristic');
    expect(r.mapping?.entities.invoice.table).toBe('invoices');
    expect(r.warnings[0]).toMatch(/Claude was not used/);
  }, 60000);
});
