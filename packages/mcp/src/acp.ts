import {
  acpCancel,
  acpComplete,
  acpCreate,
  AcpError,
  acpGet,
  acpIdempotent,
  acpUpdate,
  checkAcpVersion,
  type AcpContext,
  type AcpResult,
  type Retrofit,
} from '@paypal-retrofit/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * ACP's MCP transport binding: the five checkout operations as MCP tools taking {meta, id, payload}, where
 * meta carries what REST sends as headers (api_version, idempotency_key, ...). Results are the same session
 * objects as the REST API; errors are JSON-RPC errors with code -32000 and the ACP error in `data`.
 */

const meta = {
  type: 'object',
  description: 'Protocol metadata (the REST headers)',
  properties: {
    api_version: { type: 'string', description: 'e.g. 2026-04-17' },
    idempotency_key: { type: 'string' },
    request_id: { type: 'string' },
    user_agent: { type: 'string' },
    accept_language: { type: 'string' },
  },
  required: ['api_version'],
  additionalProperties: true,
};
const id = { type: 'string', description: 'Checkout session id' };
const payload = (description: string) => ({ type: 'object', description, additionalProperties: true });

export const ACP_TOOLS: Tool[] = [
  {
    name: 'create_checkout_session',
    description:
      'Create a checkout session for items from the catalogue. Returns the authoritative cart (amounts in minor units) and a PayPal approval link (continue_url) for the buyer.',
    inputSchema: {
      type: 'object',
      properties: {
        meta,
        payload: payload(
          'CheckoutSessionCreateRequest: line_items [{id, quantity}], currency, buyer, capabilities',
        ),
      },
      required: ['meta', 'payload'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'get_checkout_session',
    description:
      'The current state of a checkout session, including whether the buyer has approved the payment in PayPal.',
    inputSchema: { type: 'object', properties: { meta, id }, required: ['meta', 'id'] },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'update_checkout_session',
    description:
      'Change the items, buyer or fulfillment details. A new cart gets a new PayPal approval link.',
    inputSchema: {
      type: 'object',
      properties: { meta, id, payload: payload('CheckoutSessionUpdateRequest') },
      required: ['meta', 'id', 'payload'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'complete_checkout_session',
    description:
      'Place the order after the buyer approved the payment in PayPal. payment_data: {handler_id "paypal", instrument {type "paypal_order", credential {type "paypal_order_id", order_id}}}, with order_id from the handler config.',
    inputSchema: {
      type: 'object',
      properties: { meta, id, payload: payload('CheckoutSessionCompleteRequest') },
      required: ['meta', 'id', 'payload'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: 'cancel_checkout_session',
    description: 'Cancel a session that is not completed. Its PayPal link can then never be charged.',
    inputSchema: {
      type: 'object',
      properties: { meta, id, payload: payload('CancelSessionRequest') },
      required: ['meta', 'id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

export function createAcpMcpServer(rf: Retrofit, ctx: AcpContext & { caller: string }) {
  const server = new Server(
    { name: `${rf.config.business.name} checkout (ACP)`, version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions:
        'Agentic Commerce Protocol checkout. Create a session, send the buyer to continue_url to approve the payment in PayPal, then complete the session with the "paypal" handler.',
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ACP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const a = (req.params.arguments ?? {}) as { meta?: Record<string, any>; id?: string; payload?: any };
    const c: AcpContext = { base: ctx.base, agent: a.meta?.user_agent ?? ctx.agent };
    const run = (): Promise<AcpResult> => {
      if (name !== 'create_checkout_session' && !a.id)
        throw new AcpError(400, 'invalid_request', 'missing', 'id is required', 'id');
      switch (name) {
        case 'create_checkout_session':
          return acpCreate(rf, a.payload, c);
        case 'get_checkout_session':
          return acpGet(rf, a.id!, c);
        case 'update_checkout_session':
          return acpUpdate(rf, a.id!, a.payload ?? {}, c);
        case 'complete_checkout_session':
          return acpComplete(rf, a.id!, a.payload ?? {}, c);
        case 'cancel_checkout_session':
          return acpCancel(rf, a.id!, a.payload ?? {}, c);
        default:
          throw new AcpError(400, 'invalid_request', 'not_found', `Unknown tool ${name}`);
      }
    };
    let out: AcpResult;
    try {
      checkAcpVersion(a.meta?.api_version);
      const key = a.meta?.idempotency_key;
      out =
        key && name !== 'get_checkout_session'
          ? await acpIdempotent(
              rf,
              `${ctx.caller}:mcp:${name}:${a.id ?? ''}`,
              String(key),
              a.payload ?? {},
              run,
            )
          : await run();
    } catch (e) {
      const err =
        e instanceof AcpError
          ? e
          : new AcpError(500, 'processing_error', 'internal_error', (e as Error).message);
      out = { status: err.status, body: err.toJSON() };
    }
    if (out.status >= 400)
      throw new McpError(-32000, String((out.body as any)?.message ?? 'Error'), out.body);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out.body) }],
      structuredContent: out.body as Record<string, unknown>,
    };
  });
  return server;
}

/** Stateless Streamable HTTP handler for /acp/mcp. The caller has already been authenticated. */
export function acpMcpHttpHandler(getRf: () => Retrofit, ctx: AcpContext & { caller: string }) {
  return async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    const server = createAcpMcpServer(getRf(), ctx);
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
