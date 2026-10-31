import {
  AgentUnavailableError,
  claudeConfigured,
  compileRules,
  draftDisputeEvidence,
  draftInvoice,
  draftReminders,
  OpsAgent,
  type OpsEvent,
} from '@paypal-retrofit/agents';
import {
  ACTION_KINDS,
  actionLinkSecret,
  businessTimezone,
  KIND_LABEL,
  publicBaseUrl,
  verifyActionToken,
  cashForecast,
  customerProfiles,
  handleWebhook,
  invoiceRisks,
  isQuiet,
  journal,
  journalCsv,
  monthRange,
  monthSummary,
  planCollections,
  runCollections,
  hasErrors,
  ledger,
  reconcile,
  saveMapping,
  summary,
  validateMapping,
  type ActionKind,
  type Retrofit,
  type SchemaDescription,
} from '@paypal-retrofit/core';
import { mcpHttpHandler, shopMcpHttpHandler } from '@paypal-retrofit/mcp';
import {
  buildStatement,
  listCustomers,
  loadCatalog,
  planTerms,
  renderStatement,
  runTerms,
  signPortalToken,
  Commerce,
  PaymentTerms,
  addInvoice,
  intakeContext,
  planAutopay,
  runAutopay,
  stopAutopay,
  goLiveChecks,
  moneyTrail,
  PlanPolicy,
  applyRuleChanges,
  shadowReplay,
  describeRules,
  previewRules,
  businessTimezone as tzOf,
  type RuleChange,
  todayView,
  WEBHOOK_EVENTS,
  disputeEvidencePack,
  evidencePdf,
  listDisputes,
  prepareDisputeCase,
  proposeEvidence,
  SELLER_EVIDENCE_TYPES,
  startDisputeAutopilot,
  type EvidencePack,
  payablesView,
  proposeBillPayments,
  refreshPayouts,
} from '@paypal-retrofit/core';
import nodemailer from 'nodemailer';
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalPage, type ApprovalPageInput } from './approval-page.ts';
import { portalRouter, shopRouter } from './portal.ts';
import { demoSitePage, qrRoutes, widgetRouter } from './widget.ts';
import { inboundRouter, inboxRoutes } from './inbox.ts';
import { acpRouter } from './acp.ts';
import { digestChannels, digestSchedule, prepareDigest, runScheduledDigest, sendDigest } from './digest.ts';

export * from './digest.ts';
export * from './setup.ts';
export * from './host.ts';

export interface ServerOptions {
  /** Directory with the built dashboard (index.html). */
  dashboardDir?: string;
  /** Run sync every config.sync.intervalSeconds. */
  watch?: boolean;
  /** Reconcile every N seconds (0 = never). */
  reconcileEverySeconds?: number;
  /** Public base URL of this workspace when it is mounted under a path (multi-client mode), e.g. https://host/c/acme. */
  baseUrl?: string;
  /** Extra routers to mount (the embedded demo uses this for mock PayPal and the Fernhill app). */
  mounts?: Array<{ path: string; router: express.RequestHandler; public?: boolean }>;
  /** Called by POST /api/demo/reset when the embedded demo is running. */
  demo?: {
    reset: () => Promise<void>;
    dispute: (paypalInvoiceId: string) => Promise<unknown>;
    legacyAppPath: string;
    mockPath: string;
    /** The demo is running on a workspace made with the setup wizard instead of Fernhill. */
    custom?: boolean;
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DASHBOARD_DIR = path.resolve(here, '..', '..', 'dashboard', 'dist');

export function createServer(rf: Retrofit, opts: ServerOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const ops = new OpsAgent(rf);
  // New disputes get a drafted response and a proposal to send the evidence (Claude when configured).
  const disputeDrafter = (pack: EvidencePack) => draftDisputeEvidence(pack, rf.config.business.name);
  const stopAutopilot = startDisputeAutopilot(rf, () => (claudeConfigured() ? disputeDrafter : undefined));
  let schemaCache: SchemaDescription | null = null;
  const timers: NodeJS.Timeout[] = [];

  // Where this workspace is reachable: configured public URL, the host's mount, or the last request's origin.
  let seenBase: string | undefined;
  app.use((req, res, next) => {
    // req.baseUrl here is where the host mounted this workspace ('' or /c/<client>).
    res.locals.base = seenBase = `${req.protocol}://${req.get('host')}${req.baseUrl}`;
    next();
  });
  const baseFor = (req?: Request) =>
    (
      publicBaseUrl(rf.config) ??
      opts.baseUrl ??
      (req?.res?.locals.base as string | undefined) ??
      seenBase ??
      ''
    ).replace(/\/$/, '');
  rf.portalUrl = (customerPk) => {
    const b = baseFor();
    return b ? `${b}/p/${signPortalToken(actionLinkSecret(rf), customerPk)}` : undefined;
  };
  if (rf.config.env.smtpUrl) {
    const transport = nodemailer.createTransport(rf.config.env.smtpUrl);
    const from =
      rf.config.env.digestFrom ?? rf.config.business.email ?? 'paypal-retrofit <no-reply@localhost>';
    rf.mailer = async (m) => {
      const info = await transport.sendMail({ from, ...m });
      return { id: String(info.messageId) };
    };
  }

  // ---- public routes (no auth): PayPal must reach the webhook; Render probes health
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.post('/webhooks/paypal', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const result = await handleWebhook(
      rf,
      req.headers as Record<string, string>,
      typeof req.body === 'string' ? req.body : '',
    );
    res.status(result.httpStatus).json({ status: result.status, summary: result.summary });
  });
  for (const m of opts.mounts ?? []) if (m.public) app.use(m.path, m.router);

  // ---- MCP over Streamable HTTP: bearer token if RETROFIT_MCP_TOKEN is set; closed when the console has a password but MCP has no token
  app.all('/mcp', express.json({ limit: '1mb' }), (req, res, next) => {
    const token = process.env.RETROFIT_MCP_TOKEN;
    const given = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (token ? !safeEqual(given, token) : Boolean(process.env.RETROFIT_DASHBOARD_PASSWORD)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="paypal-retrofit"');
      return res.status(401).json({
        error: token ? 'Invalid token' : 'Set RETROFIT_MCP_TOKEN to use MCP on a password-protected console',
      });
    }
    void mcpHttpHandler(() => rf, { allowApprove: process.env.RETROFIT_MCP_ALLOW_APPROVE === '1' })(
      req,
      res,
    ).catch(next);
  });

  // ---- one-click approval links from the digest (the signed token is the credential; GET never changes anything)
  const approval = express.Router();
  approval.use(express.urlencoded({ extended: false }));
  const fromToken = (token: string) => {
    const v = verifyActionToken(actionLinkSecret(rf), token);
    if ('error' in v) return { error: v.error };
    const a = rf.state.getAction(v.actionId);
    return a ? { action: a } : { error: 'This action no longer exists.' };
  };
  const page = (extra: Partial<ApprovalPageInput>) =>
    approvalPage({
      business: rf.config.business.name,
      currency: rf.mapping.currency,
      consoleUrl: '/#approvals',
      timezone: businessTimezone(rf),
      kindLabel: KIND_LABEL,
      ...extra,
    });
  approval.get('/:token', (req, res) => {
    res.type('html').send(page(fromToken(req.params.token!)));
  });
  approval.post('/:token', async (req, res) => {
    const r = fromToken(req.params.token!);
    if (!r.action) return res.status(400).type('html').send(page(r));
    if (r.action.status !== 'pending') return res.type('html').send(page({ action: r.action }));
    const decision = req.body?.decision === 'reject' ? 'reject' : 'approve';
    try {
      const after =
        decision === 'reject'
          ? rf.reject(r.action.id, 'Rejected from the digest link')
          : await rf.approve(r.action.id);
      rf.emit('action', { id: after.id });
      res.type('html').send(page({ action: after, done: decision }));
    } catch (e) {
      res
        .status(500)
        .type('html')
        .send(page({ action: r.action, error: (e as Error).message }));
    }
  });
  app.use('/a', approval);

  // ---- customer-facing: portal (signed link per customer), shop, PayPal return URLs, buyer MCP
  const publicCtx = { base: (req: Request) => baseFor(req) };
  app.use('/p', portalRouter(rf, publicCtx));
  app.use(shopRouter(rf, publicCtx));
  // The business's own website: one script tag adds "Pay a bill", Pay buttons and the shop.
  app.use(widgetRouter(rf, publicCtx));
  app.use(inboundRouter(rf));
  if (opts.demo && !opts.demo.custom)
    app.get('/site', (_req, res) =>
      res.type('html').send(demoSitePage(rf.config.business.name, opts.demo?.legacyAppPath)),
    );
  // Agentic Commerce Protocol: discovery, the checkout API and its MCP binding (Bearer token of its own).
  app.use(acpRouter(rf, (req) => baseFor(req)));
  app.post('/mcp/shop', express.json({ limit: '256kb' }), (req, res, next) => {
    void shopMcpHttpHandler(
      () => rf,
      () => baseFor(req),
    )(req, res).catch(next);
  });

  // ---- everything else behind optional basic auth
  const auth = basicAuth();
  if (auth) app.use(auth);
  for (const m of opts.mounts ?? []) if (!m.public) app.use(m.path, m.router);

  const api = express.Router();
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
    fn(req, res).catch((e) =>
      res.status(e instanceof AgentUnavailableError ? 503 : 500).json({ error: (e as Error).message }),
    );

  // ---- new invoices: a sentence, a photo of a paper job sheet, or a form -> the business's system -> PayPal
  api.get(
    '/invoices/new',
    wrap(async (_req, res) => {
      const ctx = await intakeContext(rf);
      res.json({ ...ctx, claude: claudeConfigured(), source: rf.source.kind });
    }),
  );
  // Before the 1 MB body limit below: photos are bigger.
  api.post(
    '/invoices/draft',
    express.json({ limit: '8mb' }),
    wrap(async (req, res) => {
      const b = req.body ?? {};
      const image =
        typeof b.image?.data === 'string'
          ? {
              data: String(b.image.data).replace(/^data:[^,]+,/, ''),
              mediaType: /^image\/(jpeg|png|webp|gif)$/.test(b.image.mediaType)
                ? b.image.mediaType
                : 'image/jpeg',
            }
          : undefined;
      try {
        res.json(
          await draftInvoice(
            { text: typeof b.text === 'string' ? b.text : undefined, image },
            await intakeContext(rf),
          ),
        );
      } catch (e) {
        res.status(422).json({ error: (e as Error).message });
      }
    }),
  );
  api.use(express.json({ limit: '1mb' }));
  api.use(qrRoutes(rf));
  api.use(inboxRoutes(rf));
  api.post(
    '/invoices',
    wrap(async (req, res) => {
      try {
        res.json(await addInvoice(rf, req.body ?? {}));
      } catch (e) {
        res.status(422).json({ error: (e as Error).message });
      }
    }),
  );

  api.get('/config', (_req, res) =>
    res.json({
      business: rf.config.business,
      currency: rf.mapping.currency,
      environment: rf.config.env.paypalEnvironment,
      agentAvailable: claudeConfigured(),
      model: rf.config.env.model,
      autoApprove: rf.config.env.autoApprove,
      actionKinds: ACTION_KINDS,
      policies: Object.fromEntries(ACTION_KINDS.map((k) => [k, rf.policyFor(k)])),
      source: { kind: rf.source.kind },
      demo: opts.demo
        ? {
            legacyAppPath: opts.demo.legacyAppPath,
            mockPath: opts.demo.mockPath,
            custom: Boolean(opts.demo.custom),
          }
        : null,
      mcpPath: '/mcp',
      webhookConfigured: Boolean(rf.config.env.paypalWebhookId ?? rf.state.getMeta('paypal.webhookId')),
      controls: {
        rules: rf.mapping.rules,
        limits: rf.mapping.limits,
        quietHours: rf.mapping.quietHours ?? null,
        quietNow: rf.mapping.quietHours ? isQuiet(rf.mapping.quietHours, new Date()) : false,
        collections: rf.mapping.collections,
      },
    }),
  );
  api.get(
    '/summary',
    wrap(async (_req, res) => res.json(await summary(rf))),
  );
  api.get(
    '/ledger',
    wrap(async (_req, res) => res.json(await ledger(rf))),
  );
  api.get('/discrepancies', (req, res) => res.json(rf.state.listDiscrepancies(req.query.all === '1')));
  api.post('/discrepancies/:id/resolve', (req, res) => {
    rf.state.resolveDiscrepancy(
      Number(req.params.id),
      String(req.body?.resolution ?? 'Resolved by a person'),
    );
    rf.emit('discrepancy', { id: req.params.id });
    res.json({ ok: true });
  });
  api.get('/actions', (req, res) => res.json(rf.state.listActions(req.query.status as any, 200)));
  api.get('/events', (_req, res) => res.json(rf.state.listEvents(100)));
  api.post(
    '/actions/:id/approve',
    wrap(async (req, res) => res.json(await rf.approve(Number(req.params.id)))),
  );
  api.post('/actions/:id/reject', (req, res) => {
    try {
      res.json(rf.reject(Number(req.params.id), req.body?.reason));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
  api.post(
    '/propose',
    wrap(async (req, res) => {
      const { kind, entity, legacyPks, payload, reason } = req.body ?? {};
      if (!ACTION_KINDS.includes(kind)) return res.status(400).json({ error: `Unknown kind ${kind}` });
      const rows = await ledger(rf);
      const out = [];
      for (const pk of (legacyPks ?? []) as string[]) {
        const row = rows.find((r) => r.entity === (entity ?? 'invoice') && r.legacyPk === String(pk));
        if (!row) continue;
        out.push(
          await rf.propose({
            origin: 'dashboard',
            kind: kind as ActionKind,
            target: {
              entity: row.entity,
              legacyPk: row.legacyPk,
              paypalId: row.paypalId ?? undefined,
              label: row.number,
            },
            payload: payload ?? {},
            reason: reason ?? `Requested from the dashboard`,
          }),
        );
      }
      res.json(out);
    }),
  );
  api.post(
    '/sync/run',
    wrap(async (req, res) =>
      res.json(await rf.sync({ dryRun: Boolean(req.body?.dryRun), origin: 'dashboard' })),
    ),
  );
  api.post(
    '/reconcile/run',
    wrap(async (_req, res) => res.json(await reconcile(rf))),
  );

  api.get(
    '/schema',
    wrap(async (_req, res) => res.json((schemaCache ??= await rf.source.introspect()))),
  );
  api.get('/mapping', (_req, res) => res.json(rf.mapping));
  api.put(
    '/mapping',
    wrap(async (req, res) => {
      schemaCache ??= await rf.source.introspect();
      const { mapping, issues } = validateMapping(req.body, schemaCache);
      if (hasErrors(issues)) return res.status(422).json({ issues });
      rf.mapping = mapping;
      saveMapping(rf.config, mapping);
      rf.emit('mapping', {});
      res.json({ mapping, issues });
    }),
  );

  api.post('/agent/chat', async (req, res) => {
    const { sessionId, message } = req.body ?? {};
    if (!message) return res.status(400).json({ error: 'message is required' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (e: OpsEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    try {
      await ops.chat(String(sessionId ?? 'default'), String(message), send);
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
    }
    res.end();
  });
  api.post('/agent/reset', (req, res) => {
    ops.reset(String(req.body?.sessionId ?? 'default'));
    res.json({ ok: true });
  });
  // ---- bills to pay: PayPal Payouts to suppliers and contractors
  api.get(
    '/payables',
    wrap(async (_req, res) => {
      await refreshPayouts(rf);
      res.json(await payablesView(rf));
    }),
  );
  api.post(
    '/payables/pay',
    wrap(async (req, res) => {
      const pks = Array.isArray(req.body?.pks) ? req.body.pks.map(String) : [];
      if (!pks.length) return res.status(400).json({ error: 'Choose at least one bill' });
      res.json({ results: await proposeBillPayments(rf, pks, 'dashboard') });
    }),
  );

  // ---- disputes: the evidence autopilot's cases
  api.get(
    '/disputes',
    wrap(async (_req, res) =>
      res.json({ disputes: await listDisputes(rf), evidenceTypes: SELLER_EVIDENCE_TYPES }),
    ),
  );
  api.get(
    '/disputes/:id',
    wrap(async (req, res) => {
      const id = req.params.id!;
      const c = rf.state.getDisputeCase(id);
      res.json({
        pack: await disputeEvidencePack(rf, id),
        case: c,
        action: (c?.actionId && rf.state.getAction(c.actionId)) || null,
      });
    }),
  );
  api.post(
    '/disputes/:id/prepare',
    wrap(async (req, res) =>
      res.json(
        await prepareDisputeCase(rf, req.params.id!, {
          drafter: claudeConfigured() ? disputeDrafter : undefined,
          origin: 'dashboard',
          redraft: true,
        }),
      ),
    ),
  );
  api.post(
    '/disputes/:id/evidence',
    wrap(async (req, res) => {
      try {
        res.json(
          await proposeEvidence(rf, req.params.id!, {
            origin: 'dashboard',
            response: req.body?.response != null ? String(req.body.response) : undefined,
            evidenceType: req.body?.evidenceType ? String(req.body.evidenceType) : undefined,
          }),
        );
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    }),
  );
  // The document PayPal would get with the current response.
  api.get(
    '/disputes/:id/evidence.pdf',
    wrap(async (req, res) => {
      const id = req.params.id!;
      const pack = await disputeEvidencePack(rf, id);
      const response = rf.state.getDisputeCase(id)?.draft?.response ?? '';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${id.replace(/[^\w-]/g, '_')}-evidence.pdf"`);
      res.send(evidencePdf(pack, response, rf.config.business.name));
    }),
  );

  // Live updates for the dashboard.
  api.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    const off = rf.on((e) => res.write(`data: ${JSON.stringify({ type: e.type })}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

  if (opts.demo) {
    api.post(
      '/demo/reset',
      wrap(async (_req, res) => {
        await opts.demo!.reset();
        schemaCache = null;
        res.json({ ok: true });
      }),
    );
    api.post(
      '/demo/dispute',
      wrap(async (req, res) => {
        const link = rf.state.getLink('invoice', String(req.body?.legacyPk));
        if (!link) return res.status(400).json({ error: 'Invoice is not linked to PayPal' });
        res.json(await opts.demo!.dispute(link.paypalId));
      }),
    );
  }

  // ---- advanced: collections, insights, plans, books
  api.get(
    '/collections',
    wrap(async (_req, res) => res.json(await planCollections(rf))),
  );
  api.post(
    '/collections/run',
    wrap(async (req, res) => {
      const useAi = req.body?.ai !== false && claudeConfigured();
      const run = await runCollections(rf, {
        origin: 'dashboard',
        only: Array.isArray(req.body?.only) ? req.body.only.map(String) : undefined,
        writer: useAi ? (items) => draftReminders(rf, items) : undefined,
      });
      res.json(run);
    }),
  );
  api.get(
    '/insights',
    wrap(async (_req, res) =>
      res.json({
        forecast: await cashForecast(rf),
        risks: await invoiceRisks(rf),
        customers: [...(await customerProfiles(rf)).values()],
        plans: rf.state.listPlans(),
      }),
    ),
  );
  api.get('/plans', (_req, res) => res.json(rf.state.listPlans()));
  api.post(
    '/actions/:id/run-now',
    wrap(async (req, res) => res.json(await rf.approve(Number(req.params.id), { force: true }))),
  );
  api.get(
    '/month-summary',
    wrap(async (req, res) =>
      res.json(await monthSummary(rf, String(req.query.month ?? new Date().toISOString().slice(0, 7)))),
    ),
  );
  api.get(
    '/export/journal.csv',
    wrap(async (req, res) => {
      const month = req.query.month ? String(req.query.month) : undefined;
      const range = month
        ? monthRange(month)
        : { from: req.query.from as string | undefined, to: req.query.to as string | undefined };
      const format = (
        ['generic', 'xero', 'quickbooks'].includes(String(req.query.format)) ? req.query.format : 'generic'
      ) as 'generic' | 'xero' | 'quickbooks';
      const csv = journalCsv(await journal(rf, range.from, range.to), format);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="paypal-journal-${month ?? 'all'}-${format}.csv"`,
      );
      res.send(csv);
    }),
  );

  // ---- customers: balances, statements, portal links, requests
  api.get(
    '/customers',
    wrap(async (_req, res) =>
      res.json(
        (await listCustomers(rf)).map((c) => ({
          ...c,
          portalUrl: rf.portalUrl?.(c.pk) ?? null,
          lastStatement: rf.state.listOutbox(500).find((o) => o.customerPk === c.pk)?.createdAt ?? null,
        })),
      ),
    ),
  );
  api.get(
    '/customers/:pk/statement',
    wrap(async (req, res) => {
      const s = await buildStatement(rf, req.params.pk!);
      const r = renderStatement(s, { portalUrl: rf.portalUrl?.(req.params.pk!) });
      res.json({ statement: s, subject: r.subject, html: r.html });
    }),
  );
  api.post(
    '/customers/:pk/statement/send',
    wrap(async (req, res) => {
      const s = await buildStatement(rf, req.params.pk!);
      res.json(
        await rf.propose({
          origin: 'dashboard',
          kind: 'send_statement',
          target: { entity: 'customer', legacyPk: s.customer.pk, label: s.customer.name },
          payload: { balance: s.totals.balance },
          reason: `Statement for ${s.customer.name}: ${s.totals.balance.toFixed(2)} ${s.currency} open`,
        }),
      );
    }),
  );
  api.post(
    '/statements/run',
    wrap(async (_req, res) => {
      const out = [];
      for (const c of (await listCustomers(rf)).filter((x) => x.balance > 0))
        out.push(
          await rf.propose({
            origin: 'dashboard',
            kind: 'send_statement',
            target: { entity: 'customer', legacyPk: c.pk, label: c.name },
            payload: { balance: c.balance },
            reason: `Monthly statement for ${c.name}: ${c.balance.toFixed(2)} ${rf.mapping.currency} open`,
          }),
        );
      res.json(out);
    }),
  );
  api.get('/requests', (req, res) =>
    res.json(rf.state.listRequests(req.query.all === '1' ? {} : { status: 'open' })),
  );
  api.post('/requests/:id/resolve', (req, res) => {
    rf.state.resolveRequest(Number(req.params.id));
    rf.emit('request', { id: req.params.id });
    res.json({ ok: true });
  });
  api.get('/outbox', (_req, res) => res.json(rf.state.listOutbox(100)));
  api.get('/outbox/:id/html', (req, res) => {
    const html = rf.state.getOutboxHtml(Number(req.params.id));
    if (!html) return res.status(404).end();
    res.type('html').send(html);
  });

  // ---- payment terms (late fees, early-payment discounts)
  api.get(
    '/terms',
    wrap(async (_req, res) =>
      res.json({ terms: rf.mapping.terms, applied: rf.state.listAdjustments(), due: await planTerms(rf) }),
    ),
  );
  api.put(
    '/terms',
    wrap(async (req, res) => {
      const parsed = PaymentTerms.safeParse(req.body ?? {});
      if (!parsed.success)
        return res.status(422).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      rf.mapping = { ...rf.mapping, terms: parsed.data };
      saveMapping(rf.config, rf.mapping);
      rf.emit('mapping', {});
      res.json(rf.mapping.terms);
    }),
  );
  // ---- the owner's home screen
  api.get(
    '/today',
    wrap(async (_req, res) => res.json(await todayView(rf, { claude: claudeConfigured() }))),
  );

  // ---- payment plans the business agrees to, and negotiations with customers' assistants
  api.get('/plans/policy', (_req, res) => res.json(rf.mapping.plans));
  api.put('/plans/policy', (req, res) => {
    const parsed = PlanPolicy.safeParse({ ...rf.mapping.plans, ...(req.body ?? {}) });
    if (!parsed.success)
      return res.status(422).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
    rf.mapping = { ...rf.mapping, plans: parsed.data };
    saveMapping(rf.config, rf.mapping);
    rf.emit('mapping', {});
    res.json(rf.mapping.plans);
  });
  api.get(
    '/negotiations',
    wrap(async (_req, res) => {
      const names = new Map((await listCustomers(rf)).map((c) => [c.pk, c.name]));
      const numbers = new Map((await ledger(rf)).map((r) => [r.legacyPk, r.number]));
      res.json(
        rf.state.listNegotiations(100).map((n) => ({
          ...n,
          customer: names.get(n.customerPk) ?? n.customerPk,
          invoice: numbers.get(n.legacyPk) ?? n.legacyPk,
        })),
      );
    }),
  );

  // ---- the owner's rules in plain English: compile, preview what changes today, then apply
  const ruleCustomers = async () => (await listCustomers(rf)).map((c) => ({ key: c.pk, name: c.name }));
  api.get(
    '/rules',
    wrap(async (_req, res) => res.json({ sentences: describeRules(rf.mapping, await ruleCustomers()) })),
  );
  api.post(
    '/rules/preview',
    wrap(async (req, res) => {
      const text = String(req.body?.text ?? '').trim();
      if (!text) return res.status(422).json({ error: 'Write what you want, in your own words.' });
      const compiled = await compileRules(text, {
        currency: rf.mapping.currency,
        customers: await ruleCustomers(),
      });
      let candidate;
      try {
        candidate = applyRuleChanges(rf.mapping, compiled.changes, tzOf(rf));
      } catch (e) {
        return res
          .status(422)
          .json({ ...compiled, error: `Those rules don't fit together: ${(e as Error).message}` });
      }
      res.json({ ...compiled, preview: await previewRules(rf, candidate) });
    }),
  );
  api.post(
    '/rules/apply',
    wrap(async (req, res) => {
      const changes = (req.body?.changes ?? []) as RuleChange[];
      if (!Array.isArray(changes) || !changes.length)
        return res.status(422).json({ error: 'Nothing to apply' });
      try {
        rf.mapping = applyRuleChanges(rf.mapping, changes, tzOf(rf));
      } catch (e) {
        return res.status(422).json({ error: (e as Error).message });
      }
      saveMapping(rf.config, rf.mapping);
      rf.emit('mapping', {});
      res.json({ sentences: describeRules(rf.mapping, await ruleCustomers()) });
    }),
  );

  // ---- shadow mode: what the current rules would have done over the last N days, without touching anything
  api.get(
    '/shadow',
    wrap(async (req, res) =>
      res.json(
        await shadowReplay(rf, {
          days: Number(req.query.days ?? 90),
          daysAfterReminder: Number(req.query.after ?? 7),
        }),
      ),
    ),
  );

  // ---- the money trail for one invoice or subscription
  api.get(
    '/trail/:entity/:pk',
    wrap(async (req, res) =>
      res.json(
        await moneyTrail(
          rf,
          req.params.entity === 'subscription' || req.params.entity === 'payable'
            ? req.params.entity
            : 'invoice',
          String(req.params.pk),
        ),
      ),
    ),
  );

  // ---- go-live checklist
  api.get(
    '/golive',
    wrap(async (_req, res) => res.json(await goLiveChecks(rf, { claude: claudeConfigured() }))),
  );
  api.post(
    '/golive/webhook',
    wrap(async (req, res) => {
      const url = `${publicBaseUrl(rf.config) ?? baseFor(req)}/webhooks/paypal`;
      if (rf.config.env.paypalEnvironment !== 'MOCK' && !/^https:/.test(url))
        return res.status(422).json({
          error: `PayPal needs a public HTTPS address; this console is at ${url}. Set RETROFIT_PUBLIC_URL.`,
        });
      const existing = (await rf.paypal.listWebhooks()).webhooks?.find((w: any) => w.url === url);
      const wh = existing ?? (await rf.paypal.createWebhook(url, WEBHOOK_EVENTS));
      rf.state.setMeta('paypal.webhookId', wh.id);
      res.json({ id: wh.id, url, events: WEBHOOK_EVENTS.length });
    }),
  );

  // ---- autopay: customers' saved PayPal
  api.get(
    '/autopay',
    wrap(async (_req, res) => {
      const names = new Map((await listCustomers(rf)).map((c) => [c.pk, c.name]));
      res.json({
        customers: rf.state
          .listAutopay()
          .map((a) => ({ ...a, name: names.get(a.customerPk) ?? a.customerPk })),
        due: await planAutopay(rf),
      });
    }),
  );
  api.post(
    '/autopay/run',
    wrap(async (_req, res) => res.json(await runAutopay(rf, { origin: 'dashboard' }))),
  );
  api.post(
    '/autopay/:pk/off',
    wrap(async (req, res) =>
      res.json(await stopAutopay(rf, String(req.params.pk), 'Turned off by the business')),
    ),
  );
  api.post(
    '/terms/run',
    wrap(async (_req, res) => res.json(await runTerms(rf, { origin: 'dashboard' }))),
  );

  // ---- shop: catalogue, orders, buyer-agent access
  api.get(
    '/shop',
    wrap(async (req, res) =>
      res.json({
        settings: rf.mapping.commerce,
        hasCatalog: Boolean(rf.mapping.entities.product?.fields.price),
        catalog: await loadCatalog(rf),
        orders: rf.state.listOrders(200),
        shopUrl: `${baseFor(req)}/shop`,
        mcpUrl: `${baseFor(req)}/mcp/shop`,
      }),
    ),
  );
  api.put(
    '/shop',
    wrap(async (req, res) => {
      const parsed = Commerce.safeParse({ ...rf.mapping.commerce, ...(req.body ?? {}) });
      if (!parsed.success)
        return res.status(422).json({ error: parsed.error.issues.map((i) => i.message).join('; ') });
      rf.mapping = { ...rf.mapping, commerce: parsed.data };
      saveMapping(rf.config, rf.mapping);
      rf.emit('mapping', {});
      res.json(rf.mapping.commerce);
    }),
  );

  // ---- the owner's digest
  const origin = (req: Request) => publicBaseUrl(rf.config) ?? `${req.protocol}://${req.get('host')}`;
  api.get('/digest', (_req, res) =>
    res.json({
      schedule: digestSchedule(rf),
      channels: digestChannels(rf),
      history: rf.state.listDigests(20),
    }),
  );
  api.get(
    '/digest/preview',
    wrap(async (req, res) => {
      const p = await prepareDigest(rf, { ai: req.query.ai === '1', baseUrl: origin(req) });
      res.json({ subject: p.rendered.subject, html: p.rendered.html, text: p.rendered.text, data: p.data });
    }),
  );
  api.post(
    '/digest/send',
    wrap(async (req, res) =>
      res.json(await sendDigest(rf, { trigger: 'manual', ai: req.body?.ai !== false, baseUrl: origin(req) })),
    ),
  );
  api.get('/digest/:id/html', (req, res) => {
    const html = rf.state.getDigestHtml(Number(req.params.id));
    if (!html) return res.status(404).end();
    res.type('html').send(html);
  });

  app.use('/api', api);
  serveDashboard(app, opts.dashboardDir);

  // Scheduled actions (held for quiet hours) run when their time comes; the digest goes out once a day.
  timers.push(
    setInterval(() => {
      void rf.runDue().catch((e) => rf.log.warn(`scheduled actions failed: ${(e as Error).message}`));
      void runScheduledDigest(rf).catch((e) => rf.log.warn(`digest failed: ${(e as Error).message}`));
    }, 60000),
  );

  if (opts.watch) {
    const every = Math.max(10, rf.config.sync.intervalSeconds) * 1000;
    timers.push(
      setInterval(
        () => void rf.sync().catch((e) => rf.log.warn(`sync failed: ${(e as Error).message}`)),
        every,
      ),
    );
  }
  if (opts.reconcileEverySeconds) {
    timers.push(
      setInterval(
        () => void reconcile(rf).catch((e) => rf.log.warn(`reconcile failed: ${(e as Error).message}`)),
        opts.reconcileEverySeconds * 1000,
      ),
    );
  }

  return {
    app,
    stop() {
      for (const t of timers) clearInterval(t);
      stopAutopilot();
    },
  };
}

function safeEqual(a: string, b: string) {
  return a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** HTTP basic auth for the console when RETROFIT_DASHBOARD_PASSWORD is set (any user name). */
export function basicAuth(): express.RequestHandler | null {
  const password = process.env.RETROFIT_DASHBOARD_PASSWORD;
  if (!password) return null;
  return (req: Request, res: Response, next: NextFunction) => {
    const [scheme, value] = (req.header('authorization') ?? '').split(' ');
    const [, given] = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString().split(':') : [];
    if (given !== undefined && safeEqual(given, password)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="paypal-retrofit", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}

/** Serves the built console (single-page app), or a hint to build it. */
export function serveDashboard(app: express.Express, dir = DEFAULT_DASHBOARD_DIR) {
  if (fs.existsSync(path.join(dir, 'index.html'))) {
    app.use(express.static(dir, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) =>
      req.path.startsWith('/api') ? next() : res.sendFile(path.join(dir, 'index.html')),
    );
  } else {
    app.get('/', (_req, res) =>
      res
        .type('text/plain')
        .send('paypal-retrofit API is running. Build the dashboard with "pnpm build" to get the UI.'),
    );
  }
}
