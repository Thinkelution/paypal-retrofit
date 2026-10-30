import { createCheckout, loadCatalog, searchCatalog, type Retrofit } from '@paypal-retrofit/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The buyer-facing MCP server: lets an AI shopping agent browse a retrofitted business's catalogue and
 * start a PayPal checkout for its user. The agent never pays: create_checkout returns a PayPal approval
 * link that the person opens and approves. Prices come only from the business's own data, and orders
 * are capped by the owner's commerce settings.
 */

const INSTRUCTIONS = `You are talking to a small business's shop, connected through paypal-retrofit.

Use search_catalog or list_products to find what the user wants, then create_checkout with product ids and quantities. Checkout returns a PayPal link: give it to the user and tell them to open it to review and pay. You cannot pay on their behalf, and prices are fixed by the business. Use get_checkout_status to see whether they have paid.`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export interface ShopMcpOptions {
  /** Absolute base URL of the workspace, for PayPal return links. */
  baseUrl: string;
}

export function createShopMcpServer(rf: Retrofit, opts: ShopMcpOptions) {
  const server = new Server(
    {
      name: `${rf.config.business.name} shop`,
      version: '0.1.0',
      title: `${rf.config.business.name} (via paypal-retrofit)`,
    },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const cur = rf.mapping.currency;
  const tools: Array<Tool & { run: (a: any) => Promise<unknown> }> = [
    {
      name: 'list_products',
      description: `Everything ${rf.config.business.name} sells online, with prices in ${cur}.`,
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async () => ({
        business: rf.config.business.name,
        description: rf.mapping.commerce.description ?? null,
        products: await loadCatalog(rf),
      }),
    },
    {
      name: 'search_catalog',
      description: 'Find products by words in their name or description.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async ({ query }: { query: string }) => ({
        products: searchCatalog(await loadCatalog(rf), query),
      }),
    },
    {
      name: 'create_checkout',
      description: `Start a PayPal checkout for the user. Returns an approval link the user must open to pay; nothing is charged until they approve it at PayPal. Orders above ${rf.mapping.commerce.maxOrderTotal} ${cur} are refused.`,
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: { productId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
              required: ['productId', 'quantity'],
            },
          },
          buyer: {
            type: 'object',
            properties: { name: { type: 'string' }, email: { type: 'string' } },
            description: 'Who the order is for, so the business can follow up',
          },
          agent: { type: 'string', description: 'Name of the shopping assistant placing the order' },
        },
        required: ['items'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: async (a: {
        items: Array<{ productId: string; quantity: number }>;
        buyer?: { name?: string; email?: string };
        agent?: string;
      }) => {
        const o = await createCheckout(rf, {
          channel: 'agent',
          items: a.items ?? [],
          buyer: {
            name: a.buyer?.name?.slice(0, 120),
            email: a.buyer?.email?.slice(0, 200),
            agent: (a.agent ?? 'an AI agent').slice(0, 80),
          },
          returnUrl: `${opts.baseUrl}/checkout/return`,
          cancelUrl: `${opts.baseUrl}/shop`,
        });
        return {
          checkoutId: o.id,
          total: o.total,
          currency: o.currency,
          items: o.items.map(({ name, quantity, unitPrice }) => ({ name, quantity, unitPrice })),
          approveUrl: o.approveUrl,
          next: 'Give approveUrl to the user. They review and pay at PayPal; nothing is charged before that.',
        };
      },
    },
    {
      name: 'get_checkout_status',
      description: 'Whether a checkout has been paid.',
      inputSchema: {
        type: 'object',
        properties: { checkoutId: { type: 'string' } },
        required: ['checkoutId'],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async ({ checkoutId }: { checkoutId: string }) => {
        const o = rf.state.getOrder(String(checkoutId));
        if (!o || o.channel === 'portal') return { error: 'No such checkout' };
        return {
          checkoutId: o.id,
          status: o.status,
          total: o.total,
          currency: o.currency,
          paid: o.status === 'COMPLETED',
        };
      },
    },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: rf.mapping.commerce.enabled ? tools.map(({ run: _r, ...t }) => t) : [],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (!rf.mapping.commerce.enabled)
      return { ...text(`${rf.config.business.name} does not sell online.`), isError: true };
    const t = byName.get(req.params.name);
    if (!t) return { ...text(`Unknown tool ${req.params.name}`), isError: true };
    try {
      return text(JSON.stringify(await t.run(req.params.arguments ?? {}), null, 1));
    } catch (e) {
      return { ...text(`Error: ${(e as Error).message}`), isError: true };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: rf.mapping.commerce.enabled
      ? [
          {
            uri: 'shop://catalog',
            name: 'Catalogue',
            mimeType: 'application/json',
            description: 'Products and prices',
          },
        ]
      : [],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== 'shop://catalog') throw new Error(`Unknown resource ${req.params.uri}`);
    return {
      contents: [
        {
          uri: 'shop://catalog',
          mimeType: 'application/json',
          text: JSON.stringify(await loadCatalog(rf), null, 1),
        },
      ],
    };
  });
  return server;
}

export async function serveShopStdio(rf: Retrofit, opts: ShopMcpOptions) {
  const server = createShopMcpServer(rf, opts);
  await server.connect(new StdioServerTransport());
  return server;
}

/** Stateless Streamable HTTP handler for /mcp/shop. Public: it is meant for buyers' agents. */
export function shopMcpHttpHandler(getRf: () => Retrofit, baseUrl: (req: IncomingMessage) => string) {
  return async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }),
      );
      return;
    }
    const server = createShopMcpServer(getRf(), { baseUrl: baseUrl(req) });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
