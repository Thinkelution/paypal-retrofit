import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { harness } from '../../core/test/helpers.ts';
import { createShopMcpServer } from '../src/shop.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const textOf = (r: any) => (r.content as Array<{ text: string }>)[0]!.text;

describe('buyer-facing shop MCP', () => {
  it('lets a shopping agent find a service and start a PayPal checkout the buyer approves', async () => {
    const h = await harness();
    cleanups.push(h.close);
    h.rf.mapping.commerce = { enabled: true, maxOrderTotal: 1000, maxQuantity: 5 };
    const server = createShopMcpServer(h.rf, { baseUrl: 'https://shop.example' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'shopper', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    cleanups.push(() => client.close());

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'list_products',
      'search_catalog',
      'create_checkout',
      'get_checkout_status',
    ]);
    const found = JSON.parse(
      textOf(await client.callTool({ name: 'search_catalog', arguments: { query: 'portrait' } })),
    );
    const product = found.products[0];
    expect(product.price).toBeGreaterThan(0);

    const tooBig = await client.callTool({
      name: 'create_checkout',
      arguments: { items: [{ productId: product.id, quantity: 5 }] },
    });
    expect(product.price * 5 > 1000 ? tooBig.isError : true).toBe(true);
    const bad = await client.callTool({
      name: 'create_checkout',
      arguments: { items: [{ productId: 'nope', quantity: 1 }] },
    });
    expect(textOf(bad)).toMatch(/Unknown product/);

    const co = JSON.parse(
      textOf(
        await client.callTool({
          name: 'create_checkout',
          arguments: {
            items: [{ productId: product.id, quantity: 1 }],
            buyer: { name: 'Ana' },
            agent: 'Claude',
          },
        }),
      ),
    );
    expect(co.total).toBe(product.price);
    expect(co.approveUrl).toMatch(/\/mock\/checkout\//);
    expect(
      JSON.parse(
        textOf(
          await client.callTool({ name: 'get_checkout_status', arguments: { checkoutId: co.checkoutId } }),
        ),
      ).paid,
    ).toBe(false);

    // The buyer approves at PayPal; the webhook captures and books the sale.
    await h.mock.approveOrder(co.approveUrl.split('/').pop());
    await new Promise((r) => setTimeout(r, 400));
    const status = JSON.parse(
      textOf(
        await client.callTool({ name: 'get_checkout_status', arguments: { checkoutId: co.checkoutId } }),
      ),
    );
    expect(status).toMatchObject({ paid: true, status: 'COMPLETED' });
    const sale = h.rf.state.listPayments().find((p) => p.entity === 'order');
    expect(sale).toMatchObject({ legacyPk: co.checkoutId, gross: product.price, kind: 'payment' });
    expect(sale!.fee).toBeGreaterThan(0);

    h.rf.mapping.commerce = { ...h.rf.mapping.commerce, enabled: false };
    expect((await client.listTools()).tools).toEqual([]);
  });
});
