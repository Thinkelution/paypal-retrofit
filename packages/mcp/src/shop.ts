import {
  acceptPlanOffer,
  actionLinkSecret,
  buildStatement,
  negotiatePlan,
  createCheckout,
  loadCatalog,
  searchCatalog,
  submitCustomerRequest,
  verifyPortalToken,
  type Retrofit,
} from '@paypal-retrofit/core';
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
 * The business's public MCP server, for other people's AI assistants:
 *  - shopping agents browse the catalogue and start a PayPal checkout for their user (when the shop is on);
 *  - an existing customer's assistant sees what they owe, pays several invoices in one checkout, and tells
 *    the business things (a date they will pay by, a request to pay in parts, a question). It identifies
 *    the customer by their private portal link, from any statement or invoice email.
 * No assistant can pay: every payment is a PayPal approval link the person opens and approves. Prices and
 * amounts come only from the business's own data, and orders are capped by the owner's settings.
 */

const INSTRUCTIONS = `You are talking to a small business, connected through paypal-retrofit.

Shopping: use search_catalog or list_products to find what the user wants, then create_checkout with product ids and quantities. Checkout returns a PayPal link: give it to the user and tell them to open it to review and pay. Use get_checkout_status to see whether they have paid.

Existing customers: ask the user for their portal link (in any statement or invoice email from the business), then use my_invoices to see what they owe, pay_my_invoices to pay some or all of it in one PayPal checkout, propose_payment_plan to agree a plan within the business's rules (it may come back with a counter-offer to accept with accept_plan_offer), and tell_the_business to promise a date or ask a question.

You can never pay on the user's behalf: always hand them the PayPal link. Prices and amounts are fixed by the business.`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export interface ShopMcpOptions {
  /** Absolute base URL of the workspace, for PayPal return links. */
  baseUrl: string;
}

export function createShopMcpServer(rf: Retrofit, opts: ShopMcpOptions) {
  const server = new Server(
    {
      name: `${rf.config.business.name} shop and accounts`,
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
  // ---- an existing customer's own assistant, identified by the customer's portal link
  const customerOf = (link: unknown) => {
    const token =
      String(link ?? '')
        .trim()
        .replace(/[?#].*$/, '')
        .split('/')
        .filter(Boolean)
        .pop() ?? '';
    const v = verifyPortalToken(actionLinkSecret(rf), token);
    if ('error' in v)
      throw new Error(
        'That portal link is not valid. Use the link from the latest statement or invoice email.',
      );
    return { customerPk: v.customerPk, token };
  };
  const portalLink = {
    type: 'string',
    description: "The customer's private portal link from a statement or invoice email (https://.../p/...)",
  };
  const accountTools: Array<Tool & { run: (a: any) => Promise<unknown> }> = [
    {
      name: 'my_invoices',
      description: `What the customer owes ${rf.config.business.name}: open invoices with amounts, due dates and pay links, recent payments, and whether autopay is on.`,
      inputSchema: { type: 'object', properties: { portal_link: portalLink }, required: ['portal_link'] },
      annotations: { readOnlyHint: true, openWorldHint: false },
      run: async (a: { portal_link: string }) => {
        const { customerPk } = customerOf(a.portal_link);
        const s = await buildStatement(rf, customerPk);
        const auto = rf.state.getAutopay(customerPk);
        return {
          business: s.business,
          customer: s.customer.name,
          currency: s.currency,
          balance: s.totals.balance,
          overdue: s.totals.overdue,
          invoices: s.lines.map((l) => ({
            number: l.number,
            amount: l.balance,
            due: l.due,
            daysOverdue: l.daysOverdue,
            onPaymentPlan: l.onPlan,
            payableOnline: l.inPayPal,
          })),
          recentPayments: s.payments.slice(0, 5),
          autopay:
            auto?.status === 'active' ? 'on: invoices are paid from saved PayPal on their due date' : 'off',
          openRequests: rf.state.listRequests({ status: 'open', customerPk }).map((r) => ({
            kind: r.kind,
            invoice: s.lines.find((l) => l.legacyPk === r.legacyPk)?.number,
            until: r.until,
          })),
        };
      },
    },
    {
      name: 'pay_my_invoices',
      description:
        "Start one PayPal checkout for some or all of the customer's open invoices. Returns a PayPal link the customer must open and approve; nothing is paid before that.",
      inputSchema: {
        type: 'object',
        properties: {
          portal_link: portalLink,
          invoices: {
            type: 'array',
            items: { type: 'string' },
            description: 'Invoice numbers to pay; leave out to pay everything open',
          },
          agent: { type: 'string', description: 'Name of the assistant' },
        },
        required: ['portal_link'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: async (a: { portal_link: string; invoices?: string[]; agent?: string }) => {
        const { customerPk, token } = customerOf(a.portal_link);
        const s = await buildStatement(rf, customerPk);
        const wanted = a.invoices?.length
          ? new Set(a.invoices.map((n) => String(n).trim().toLowerCase()))
          : null;
        const lines = s.lines.filter((l) => l.inPayPal && (!wanted || wanted.has(l.number.toLowerCase())));
        if (!lines.length)
          throw new Error(wanted ? 'None of those invoices can be paid online' : 'Nothing is open');
        const o = await createCheckout(rf, {
          channel: 'agent',
          invoices: lines.map((l) => l.legacyPk),
          customerPk,
          buyer: {
            name: s.customer.name,
            email: s.customer.email,
            agent: (a.agent ?? 'an AI assistant').slice(0, 80),
          },
          returnUrl: `${opts.baseUrl}/checkout/return`,
          cancelUrl: `${opts.baseUrl}/p/${token}`,
        });
        return {
          checkoutId: o.id,
          invoices: o.invoices,
          total: o.total,
          currency: o.currency,
          approveUrl: o.approveUrl,
          next: 'Give approveUrl to the customer. They review and pay at PayPal; nothing is charged before that.',
        };
      },
    },
    {
      name: 'tell_the_business',
      description:
        'Tell the business about one open invoice: "promise" (the date the customer will pay by; reminders pause until then), "plan" (pay in 2 to 4 parts; the owner is asked to offer a payment plan) or "question" (reminders pause until answered).',
      inputSchema: {
        type: 'object',
        properties: {
          portal_link: portalLink,
          invoice: { type: 'string', description: 'Invoice number' },
          kind: { type: 'string', enum: ['promise', 'plan', 'question'] },
          pay_by: { type: 'string', description: 'YYYY-MM-DD, for a promise' },
          installments: { type: 'integer', minimum: 2, maximum: 4, description: 'For a plan' },
          message: { type: 'string', description: 'For a question' },
        },
        required: ['portal_link', 'invoice', 'kind'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (a: {
        portal_link: string;
        invoice: string;
        kind: string;
        pay_by?: string;
        installments?: number;
        message?: string;
      }) => {
        const { customerPk } = customerOf(a.portal_link);
        const s = await buildStatement(rf, customerPk);
        const line = s.lines.find((l) => l.number.toLowerCase() === String(a.invoice).trim().toLowerCase());
        if (!line) throw new Error(`${a.invoice} is not one of the customer's open invoices`);
        const r = await submitCustomerRequest(rf, {
          customerPk,
          legacyPk: line.legacyPk,
          kind: a.kind,
          date: a.pay_by,
          installments: a.installments,
          message: a.message,
          via: 'through their AI assistant',
        });
        return {
          ok: true,
          invoice: r.number,
          kind: r.kind,
          next:
            r.kind === 'promise'
              ? `${s.business} will not send reminders before ${a.pay_by}.`
              : r.kind === 'plan'
                ? `${s.business} has been asked to offer a payment plan; it arrives by email.`
                : `${s.business} has the question and will reply by email.`,
        };
      },
    },
  ];
  accountTools.push(
    {
      name: 'propose_payment_plan',
      description:
        "Ask to pay one open invoice in parts. The business's own rules answer at once: agreed (the PayPal invoice now accepts the instalments), waiting for the owner, a counter-offer (accept it with accept_plan_offer), or declined, always with the reason.",
      inputSchema: {
        type: 'object',
        properties: {
          portal_link: portalLink,
          invoice: { type: 'string', description: 'Invoice number' },
          installments: { type: 'integer', minimum: 2, maximum: 12 },
          interval_days: {
            type: 'integer',
            minimum: 7,
            maximum: 92,
            description: 'Days between payments (default 14)',
          },
          first_payment_date: { type: 'string', description: 'YYYY-MM-DD (default in a week)' },
          agent: { type: 'string', description: 'Name of the assistant' },
        },
        required: ['portal_link', 'invoice', 'installments'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (a: {
        portal_link: string;
        invoice: string;
        installments: number;
        interval_days?: number;
        first_payment_date?: string;
        agent?: string;
      }) => {
        const { customerPk } = customerOf(a.portal_link);
        const s = await buildStatement(rf, customerPk);
        const line = s.lines.find((l) => l.number.toLowerCase() === String(a.invoice).trim().toLowerCase());
        if (!line) throw new Error(`${a.invoice} is not one of the customer's open invoices`);
        return negotiatePlan(rf, {
          customerPk,
          legacyPk: line.legacyPk,
          installments: a.installments,
          intervalDays: a.interval_days,
          firstDue: a.first_payment_date,
          via: `through their AI assistant${a.agent ? ` (${String(a.agent).slice(0, 60)})` : ''}`,
        });
      },
    },
    {
      name: 'accept_plan_offer',
      description: 'Accept a counter-offer from propose_payment_plan, after checking with the customer.',
      inputSchema: {
        type: 'object',
        properties: { portal_link: portalLink, offer_id: { type: 'string' } },
        required: ['portal_link', 'offer_id'],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (a: { portal_link: string; offer_id: string }) => {
        const { customerPk } = customerOf(a.portal_link);
        return acceptPlanOffer(rf, String(a.offer_id), customerPk);
      },
    },
  );
  const shopNames = new Set(tools.map((t) => t.name));
  const byName = new Map([...tools, ...accountTools].map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(rf.mapping.commerce.enabled ? tools : []), ...accountTools].map(({ run: _r, ...t }) => t),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (shopNames.has(req.params.name) && !rf.mapping.commerce.enabled)
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
