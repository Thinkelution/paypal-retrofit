import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { harness, listen } from '../../core/test/helpers.ts';
import { createMcpServer, mcpHttpHandler } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(rf: Parameters<typeof createMcpServer>[0], opts = {}) {
  const server = createMcpServer(rf, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  cleanups.push(() => client.close());
  return client;
}
const textOf = (r: any) => (r.content as Array<{ type: string; text: string }>)[0]!.text;

describe('MCP server', () => {
  it('lists the engine tools with read-only hints, prompts and resources', async () => {
    const h = await harness();
    cleanups.push(h.close);
    const client = await connect(h.rf);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'owner_digest',
      'business_summary',
      'collections_plan',
      'propose_action',
      'cash_forecast',
    ])
      expect(names).toContain(n);
    expect(names).not.toContain('approve_action');
    expect(tools.find((t) => t.name === 'business_summary')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'propose_action')!.annotations?.readOnlyHint).toBe(false);
    expect(client.getInstructions()).toMatch(/policy|pending/);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toEqual(['morning_briefing', 'chase_overdue', 'month_end']);
    const res = await client.readResource({ uri: 'retrofit://summary' });
    expect(JSON.parse((res.contents[0] as any).text).business).toBe('Fernhill Studio');
  });

  it('answers questions and queues actions through the policy gate', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const client = await connect(h.rf);

    const sum = JSON.parse(textOf(await client.callTool({ name: 'business_summary', arguments: {} })));
    expect(sum.linked).toBeGreaterThan(10);

    const overdue = JSON.parse(
      textOf(
        await client.callTool({
          name: 'find_invoices',
          arguments: { minDaysOverdue: 10, paypalStatus: 'SENT' },
        }),
      ),
    );
    const number = overdue.rows[0].number;
    const proposed = JSON.parse(
      textOf(
        await client.callTool({
          name: 'propose_action',
          arguments: {
            kind: 'send_reminder',
            entity: 'invoice',
            number,
            reason: 'Asked from Claude Desktop',
          },
        }),
      ),
    );
    expect(proposed.status).toBe('pending');
    expect(h.rf.state.listActions('pending').map((a) => a.target.label)).toContain(number);

    const digest = textOf(await client.callTool({ name: 'owner_digest', arguments: {} }));
    expect(digest).toMatch(/Waiting for your OK \(\d+\)/);
    expect(digest).toContain(`Send reminder · ${number}`);

    const bad = await client.callTool({ name: 'propose_action', arguments: { kind: 'nope' } });
    expect(bad.isError).toBe(true);
  });

  it('approves only when allowed, and serves Streamable HTTP', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const target = h.rf.state.listLinks().find((l) => l.entity === 'invoice' && l.paypalStatus === 'SENT')!;
    const a = await h.rf.propose({
      origin: 'cli',
      kind: 'send_reminder',
      target: { entity: 'invoice', legacyPk: target.legacyPk, paypalId: target.paypalId },
      payload: {},
      reason: 'Overdue',
    });
    const client = await connect(h.rf, { allowApprove: true });
    const r = JSON.parse(textOf(await client.callTool({ name: 'approve_action', arguments: { id: a.id } })));
    expect(r.status).toBe('executed');

    const app = express();
    app.post('/mcp', express.json(), (req, res) => void mcpHttpHandler(() => h.rf)(req, res));
    const server = await listen(app);
    cleanups.push(server.close);
    const http = new Client({ name: 'http-test', version: '1.0.0' });
    await http.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    cleanups.push(() => http.close());
    const { tools } = await http.listTools();
    expect(tools.length).toBeGreaterThan(12);
    const res = await http.callTool({ name: 'list_actions', arguments: { status: 'executed' } });
    expect(textOf(res)).toContain('send_reminder');
  });
});
