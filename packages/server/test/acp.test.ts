import { afterEach, describe, expect, it } from 'vitest';
import { loadCatalog } from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { createServer } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Agentic Commerce Protocol checkout', () => {
  it('sells to any ACP agent: discovery, sessions, idempotency, PayPal approval and the MCP binding', async () => {
    const h = await harness();
    cleanups.push(h.close);
    h.rf.mapping.commerce = { enabled: true, maxOrderTotal: 2000, maxQuantity: 5 };
    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });
    const headers = (key?: string) => ({
      'content-type': 'application/json',
      authorization: 'Bearer agent-token-1',
      'api-version': '2026-04-17',
      'user-agent': 'TestAgent/1.0',
      ...(key ? { 'idempotency-key': key } : {}),
    });
    const call = async (
      method: string,
      p: string,
      body?: unknown,
      h2: Record<string, string> = headers(crypto.randomUUID()),
    ) => {
      const r = await fetch(`${server.url}/acp${p}`, {
        method,
        headers: h2,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, headers: r.headers, body: (await r.json()) as any };
    };

    // Discovery: public, cacheable, pointing at the API.
    const d = await fetch(`${server.url}/.well-known/acp.json`);
    expect(d.headers.get('cache-control')).toMatch(/public, max-age=3600/);
    expect(await d.json()).toMatchObject({
      protocol: { name: 'acp', version: '2026-04-17', supported_versions: ['2026-01-16', '2026-04-17'] },
      api_base_url: `${server.url}/acp`,
      transports: ['rest', 'mcp'],
      capabilities: { services: ['checkout'], supported_currencies: ['usd'] },
    });

    // The protocol's own rules: a token, a version, and an idempotency key on every POST.
    const [portrait] = await loadCatalog(h.rf);
    const create = {
      line_items: [{ id: portrait!.id, quantity: 2 }],
      currency: 'usd',
      capabilities: {},
      buyer: { email: 'ada@example.com', first_name: 'Ada' },
    };
    expect(
      (await call('POST', '/checkout_sessions', create, { ...headers('k'), authorization: '' })).status,
    ).toBe(401);
    const noVersion = await call('POST', '/checkout_sessions', create, {
      ...headers('k'),
      'api-version': '',
    });
    expect(noVersion).toMatchObject({
      status: 400,
      body: { code: 'missing_api_version', supported_versions: ['2026-01-16', '2026-04-17'] },
    });
    expect((await call('POST', '/checkout_sessions', create, headers())).body.code).toBe(
      'idempotency_key_required',
    );

    const first = await call('POST', '/checkout_sessions', create, headers('create-1'));
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotency-key')).toBe('create-1');
    const s = first.body;
    const unit = Math.round(portrait!.price * 100);
    expect(s).toMatchObject({
      status: 'ready_for_payment',
      currency: 'usd',
      line_items: [{ item: { id: portrait!.id }, quantity: 2, unit_amount: unit }],
      selected_fulfillment_options: [{ type: 'digital', option_id: 'service' }],
    });
    expect(s.totals.find((t: any) => t.type === 'total').amount).toBe(unit * 2);
    const handler = s.capabilities.payment.handlers[0];
    expect(handler).toMatchObject({ id: 'paypal', psp: 'paypal', requires_delegate_payment: false });
    expect(handler.config.approve_url).toBe(s.continue_url);
    expect(s.messages[0]).toMatchObject({ type: 'info', resolution: 'requires_buyer_review' });

    // Same key and body: the stored response, nothing created twice. Same key, other body: refused.
    const again = await call('POST', '/checkout_sessions', create, headers('create-1'));
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(again.body.id).toBe(s.id);
    const conflict = await call(
      'POST',
      '/checkout_sessions',
      { ...create, line_items: [{ id: portrait!.id, quantity: 1 }] },
      headers('create-1'),
    );
    expect(conflict).toMatchObject({
      status: 422,
      body: { type: 'invalid_request', code: 'idempotency_conflict' },
    });
    expect((await call('POST', '/checkout_sessions', { ...create, currency: 'eur' })).body).toMatchObject({
      code: 'invalid',
      param: '$.currency',
    });
    expect(
      (await call('POST', '/checkout_sessions', { ...create, line_items: [{ id: 'nope', quantity: 1 }] }))
        .body,
    ).toMatchObject({
      code: 'not_found',
      param: '$.line_items[0].id',
    });

    // A smaller cart: a new PayPal order; the old link can never be charged.
    const updated = (
      await call('POST', `/checkout_sessions/${s.id}`, { line_items: [{ id: portrait!.id, quantity: 1 }] })
    ).body;
    expect(updated.totals.find((t: any) => t.type === 'total').amount).toBe(unit);
    const orderId = updated.capabilities.payment.handlers[0].config.order_id as string;
    expect(orderId).not.toBe(handler.config.order_id);

    const pay = {
      payment_data: {
        handler_id: 'paypal',
        instrument: { type: 'paypal_order', credential: { type: 'paypal_order_id', order_id: orderId } },
      },
    };
    const early = await call('POST', `/checkout_sessions/${s.id}/complete`, pay);
    expect(early).toMatchObject({
      status: 400,
      body: { code: 'approval_required', param: '$.payment_data' },
    });
    const wrong = {
      payment_data: {
        ...pay.payment_data,
        instrument: {
          type: 'paypal_order',
          credential: { type: 'paypal_order_id', order_id: handler.config.order_id },
        },
      },
    };
    expect((await call('POST', `/checkout_sessions/${s.id}/complete`, wrong)).body.code).toBe('invalid');

    // The buyer approves in PayPal; the agent completes and gets the order.
    await h.mock.approveOrder(orderId);
    await sleep(200);
    const done = await call('POST', `/checkout_sessions/${s.id}/complete`, pay);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'completed', order: { checkout_session_id: s.id } });
    expect(done.body.order.permalink_url).toMatch(/\/acp\/orders\/ord_/);
    expect(h.rf.state.getOrder(done.body.order.id)).toMatchObject({
      status: 'COMPLETED',
      channel: 'agent',
      buyer: { agent: 'TestAgent/1.0 (ACP)' },
    });
    expect(
      h.rf.state.listPayments().some((p) => p.entity === 'order' && p.legacyPk === done.body.order.id),
    ).toBe(true);
    expect((await call('POST', `/checkout_sessions/${s.id}/cancel`, {})).status).toBe(405);
    const receipt = await fetch(done.body.order.permalink_url);
    expect(await receipt.text()).toMatch(/paid with PayPal/);

    // Cancelled before payment: approving its PayPal link later charges nothing.
    const other = (await call('POST', '/checkout_sessions', create)).body;
    const cancelled = await call('POST', `/checkout_sessions/${other.id}/cancel`, {});
    expect(cancelled.body).toMatchObject({
      status: 'canceled',
      messages: [{ content: 'Checkout session has been canceled.' }],
    });
    const otherOrder = other.capabilities.payment.handlers[0].config.order_id as string;
    await h.mock.approveOrder(otherOrder);
    await sleep(200);
    expect(h.mock.state().orders[otherOrder].status).toBe('APPROVED'); // never captured

    // The same checkout over MCP (JSON-RPC on the wire): {meta, id, payload}, ACP errors in JSON-RPC data.
    let rpcId = 0;
    const rpc = async (method: string, params: unknown) =>
      (await (
        await fetch(`${server.url}/acp/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer agent-token-1',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        })
      ).json()) as any;
    expect((await fetch(`${server.url}/acp/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    const listed = await rpc('tools/list', {});
    expect(listed.result.tools.map((t: any) => t.name)).toEqual([
      'create_checkout_session',
      'get_checkout_session',
      'update_checkout_session',
      'complete_checkout_session',
      'cancel_checkout_session',
    ]);
    const meta = { api_version: '2026-04-17', idempotency_key: 'mcp-1' };
    const viaMcp = (
      await rpc('tools/call', { name: 'create_checkout_session', arguments: { meta, payload: create } })
    ).result;
    expect(viaMcp.structuredContent.status).toBe('ready_for_payment');
    const replay = (
      await rpc('tools/call', { name: 'create_checkout_session', arguments: { meta, payload: create } })
    ).result;
    expect(replay.structuredContent.id).toBe(viaMcp.structuredContent.id);
    const missing = await rpc('tools/call', {
      name: 'get_checkout_session',
      arguments: { meta, id: 'cs_missing' },
    });
    expect(missing.error).toMatchObject({
      code: -32000,
      data: { type: 'invalid_request', code: 'not_found' },
    });
    const noVersionMcp = await rpc('tools/call', {
      name: 'get_checkout_session',
      arguments: { meta: {}, id: 'cs_missing' },
    });
    expect(noVersionMcp.error.data.code).toBe('missing_api_version');
  });
});
