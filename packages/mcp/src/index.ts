import { claudeConfigured, draftReminders, engineTools, paypalTools } from '@paypal-retrofit/agents';
import { buildDigest, KIND_LABEL, renderDigest, summary, type Retrofit } from '@paypal-retrofit/core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * paypal-retrofit as an MCP server. Claude Desktop, Claude Code or any MCP client gets the same tools
 * as the built-in Ops agent: reads are free, and the only way to change anything is propose_action /
 * run_collections, which go through the owner's policy engine (auto / confirm / never, amount rules,
 * daily limits, quiet hours). Approving from the client is off unless the server is started with
 * allowApprove, so a person still approves in the console, CLI or digest by default.
 */
export interface McpOptions {
  /** Expose approve_action / reject_action (the client's own tool confirmation becomes the approval). */
  allowApprove?: boolean;
  /** Show customer emails in tool results (masked by default). */
  revealPii?: boolean;
}

interface RunnableTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  run: (input: any) => Promise<unknown> | unknown;
  parse?: (input: unknown) => unknown;
}

const READ_ONLY = new Set([
  'business_summary',
  'customer_accounts',
  'customer_statement',
  'customer_requests',
  'sales_orders',
  'payment_terms',
  'collections_plan',
  'cash_forecast',
  'payment_risk',
  'customer_history',
  'month_end_summary',
  'find_invoices',
  'invoice_detail',
  'legacy_sql',
  'list_discrepancies',
  'list_actions',
  'owner_digest',
]);

const INSTRUCTIONS = `paypal-retrofit connects an existing business database to PayPal (invoices, subscriptions, payments) and keeps both sides reconciled.

Use the read tools freely: business_summary, owner_digest, collections_plan, cash_forecast, payment_risk, customer_history, month_end_summary, find_invoices, invoice_detail, legacy_sql (read-only SELECT), list_discrepancies, list_actions, and the paypal_* reads.

Changes only happen through propose_action or run_collections. The owner's rules decide what happens next: "executed" ran now, "pending" waits for the owner's approval, "scheduled" is held for business hours (quiet hours), "rejected" is not allowed. Always tell the user which one happened and why (policyReason). Never claim money moved unless the status is "executed".`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function extraTools(rf: Retrofit, opts: McpOptions): RunnableTool[] {
  const tools: RunnableTool[] = [
    {
      name: 'owner_digest',
      description:
        "The owner's morning briefing: money that came in since the last digest (gross, PayPal fees, net), overdue totals, what is waiting for approval, what is held for business hours, customers to call, invoices at risk, open discrepancies and what the collections playbook will do today. Returns Markdown-friendly text.",
      input_schema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => renderDigest(await buildDigest(rf)).text,
    },
  ];
  if (opts.allowApprove) {
    tools.push(
      {
        name: 'approve_action',
        description:
          'Approve one pending action by id (from list_actions or owner_digest). It then runs, or is scheduled if quiet hours apply. Only call this when the user has clearly said to approve that specific action.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
          additionalProperties: false,
        },
        run: async ({ id }: { id: number }) => {
          const a = await rf.approve(Number(id));
          return JSON.stringify({
            id: a.id,
            kind: a.kind,
            status: a.status,
            runAfter: a.runAfter,
            result: a.result,
          });
        },
      },
      {
        name: 'reject_action',
        description: 'Reject one pending or scheduled action by id, with a short reason.',
        input_schema: {
          type: 'object',
          properties: { id: { type: 'integer' }, reason: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        run: async ({ id, reason }: { id: number; reason?: string }) => {
          const a = rf.reject(Number(id), reason ?? 'Rejected from an MCP client');
          return JSON.stringify({ id: a.id, kind: a.kind, status: a.status });
        },
      },
    );
  }
  return tools;
}

function toolList(rf: Retrofit, opts: McpOptions): RunnableTool[] {
  const noop = () => {};
  const engine = engineTools(rf, noop, {
    revealPii: opts.revealPii,
    reminderWriter: claudeConfigured() ? (items) => draftReminders(rf, items) : undefined,
  }) as unknown as RunnableTool[];
  const pp = paypalTools(rf, noop).tools as unknown as RunnableTool[];
  return [...extraTools(rf, opts), ...engine, ...pp];
}

function annotations(name: string): Tool['annotations'] {
  if (READ_ONLY.has(name) || name.startsWith('paypal_'))
    return { readOnlyHint: true, openWorldHint: name.startsWith('paypal_') };
  if (name === 'approve_action') return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  if (name === 'reject_action') return { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
  return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
}

const PROMPTS = [
  {
    name: 'morning_briefing',
    description: 'What came in, what needs me, and what to do first today.',
    text: 'Give me my morning briefing. Start with owner_digest, then tell me the three things I should do first today and why. If something is waiting for my approval, list it with its id.',
  },
  {
    name: 'chase_overdue',
    description: 'Run the collections playbook for overdue invoices.',
    text: 'Look at collections_plan. Explain who you would remind, who is on hold and why, and who asked for a payment plan. Then run the playbook with run_collections and tell me what ran, what waits for my approval and what is held for business hours.',
  },
  {
    name: 'month_end',
    description: 'Month-end figures and anything that stops the books from closing.',
    text: 'Prepare my month-end: use month_end_summary for this month, list open discrepancies that would make the books disagree with PayPal, and tell me which export (Xero or QuickBooks) to download from the console.',
  },
];

/** A fresh MCP server bound to one Retrofit instance. */
export function createMcpServer(rf: Retrofit, opts: McpOptions = {}) {
  const server = new Server(
    { name: 'paypal-retrofit', version: '0.1.0', title: 'paypal-retrofit' },
    { capabilities: { tools: {}, prompts: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const tools = toolList(rf, opts);
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', ...t.input_schema } as Tool['inputSchema'],
      annotations: annotations(t.name),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) return { ...text(`Unknown tool ${req.params.name}`), isError: true };
    try {
      const input = tool.parse ? tool.parse(req.params.arguments ?? {}) : (req.params.arguments ?? {});
      const out = await tool.run(input);
      const s = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
      return { ...text(s), isError: s.startsWith('Error:') };
    } catch (e) {
      return { ...text(`Error: ${(e as Error).message}`), isError: true };
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, description }) => ({ name, description })),
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = PROMPTS.find((x) => x.name === req.params.name);
    if (!p) throw new Error(`Unknown prompt ${req.params.name}`);
    return {
      description: p.description,
      messages: [{ role: 'user', content: { type: 'text', text: p.text } }],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: 'retrofit://summary',
        name: 'Business summary',
        description: 'Open, overdue, paid via PayPal, pending actions, forecast totals.',
        mimeType: 'application/json',
      },
      {
        uri: 'retrofit://digest',
        name: "Owner's digest",
        description: "Today's briefing as text.",
        mimeType: 'text/plain',
      },
      {
        uri: 'retrofit://pending-actions',
        name: 'Waiting for approval',
        description: 'Actions the owner still has to approve.',
        mimeType: 'text/plain',
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === 'retrofit://summary')
      return {
        contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await summary(rf), null, 1) }],
      };
    if (uri === 'retrofit://digest')
      return { contents: [{ uri, mimeType: 'text/plain', text: renderDigest(await buildDigest(rf)).text }] };
    if (uri === 'retrofit://pending-actions') {
      const rows = rf.state
        .listActions('pending', 100)
        .map(
          (a) =>
            `#${a.id} ${KIND_LABEL[a.kind] ?? a.kind} · ${a.target.label ?? a.target.legacyPk}${a.amount != null ? ` · ${a.amount}` : ''} · ${a.policyReason ?? a.reason}`,
        );
      return { contents: [{ uri, mimeType: 'text/plain', text: rows.join('\n') || 'Nothing is waiting.' }] };
    }
    throw new Error(`Unknown resource ${uri}`);
  });

  return server;
}

/** Serve over stdio (Claude Desktop, Claude Code "command" servers). Logs go to stderr. */
export async function serveStdio(rf: Retrofit, opts: McpOptions = {}) {
  const server = createMcpServer(rf, opts);
  await server.connect(new StdioServerTransport());
  return server;
}

/**
 * Stateless Streamable HTTP handler, mounted by the retrofit server at /mcp. Each POST gets its own
 * server and transport; no sessions to keep.
 */
export function mcpHttpHandler(getRf: () => Retrofit, opts: McpOptions = {}) {
  return async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }),
      );
      return;
    }
    const server = createMcpServer(getRf(), opts);
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
export * from './shop.ts';
