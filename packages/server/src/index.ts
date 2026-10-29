import {
  AgentUnavailableError,
  claudeConfigured,
  draftDisputeResponse,
  draftReminders,
  OpsAgent,
  type OpsEvent,
} from '@paypal-retrofit/agents';
import {
  ACTION_KINDS,
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
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerOptions {
  /** Directory with the built dashboard (index.html). */
  dashboardDir?: string;
  /** Run sync every config.sync.intervalSeconds. */
  watch?: boolean;
  /** Reconcile every N seconds (0 = never). */
  reconcileEverySeconds?: number;
  /** Extra routers to mount (the embedded demo uses this for mock PayPal and the Fernhill app). */
  mounts?: Array<{ path: string; router: express.RequestHandler; public?: boolean }>;
  /** Called by POST /api/demo/reset when the embedded demo is running. */
  demo?: {
    reset: () => Promise<void>;
    dispute: (paypalInvoiceId: string) => Promise<unknown>;
    legacyAppPath: string;
    mockPath: string;
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DASHBOARD_DIR = path.resolve(here, '..', '..', 'dashboard', 'dist');

export function createServer(rf: Retrofit, opts: ServerOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  const ops = new OpsAgent(rf);
  let schemaCache: SchemaDescription | null = null;
  const timers: NodeJS.Timeout[] = [];

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

  // ---- everything else behind optional basic auth
  const password = process.env.RETROFIT_DASHBOARD_PASSWORD;
  if (password) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const [scheme, value] = (req.header('authorization') ?? '').split(' ');
      const [, given] = scheme === 'Basic' && value ? Buffer.from(value, 'base64').toString().split(':') : [];
      const ok =
        given !== undefined &&
        given.length === password.length &&
        crypto.timingSafeEqual(Buffer.from(given), Buffer.from(password));
      if (ok) return next();
      res.setHeader('WWW-Authenticate', 'Basic realm="paypal-retrofit", charset="UTF-8"');
      res.status(401).send('Authentication required');
    });
  }
  for (const m of opts.mounts ?? []) if (!m.public) app.use(m.path, m.router);

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
    fn(req, res).catch((e) =>
      res.status(e instanceof AgentUnavailableError ? 503 : 500).json({ error: (e as Error).message }),
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
      demo: opts.demo ? { legacyAppPath: opts.demo.legacyAppPath, mockPath: opts.demo.mockPath } : null,
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
  api.post(
    '/disputes/:id/draft',
    wrap(async (req, res) => res.json(await draftDisputeResponse(rf, req.params.id!))),
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

  app.use('/api', api);

  const dist = opts.dashboardDir ?? DEFAULT_DASHBOARD_DIR;
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (req, res, next) =>
      req.path.startsWith('/api') ? next() : res.sendFile(path.join(dist, 'index.html')),
    );
  } else {
    app.get('/', (_req, res) =>
      res
        .type('text/plain')
        .send('paypal-retrofit API is running. Build the dashboard with "pnpm build" to get the UI.'),
    );
  }

  // Scheduled actions (held for quiet hours) run when their time comes.
  timers.push(
    setInterval(
      () => void rf.runDue().catch((e) => rf.log.warn(`scheduled actions failed: ${(e as Error).message}`)),
      60000,
    ),
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
    },
  };
}
