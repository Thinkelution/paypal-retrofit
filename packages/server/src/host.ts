import { loadConfig, Retrofit, summary } from '@paypal-retrofit/core';
import express from 'express';
import fs from 'node:fs';
import { basicAuth, createServer, serveDashboard, type ServerOptions } from './index.ts';
import { setupRouter, type SetupOptions } from './setup.ts';

export interface Workspace {
  id: string;
  rf: Retrofit;
  configPath: string;
  /** Where its console lives: '' for the default workspace, otherwise /c/<id>. */
  path: string;
  app: express.Express;
  stop: () => void;
}

export type HostMode = 'single' | 'practice' | 'demo';

export interface HostOptions {
  /**
   * single: one business at the root (`serve`); finishing setup replaces it.
   * practice: a bookkeeper's clients, each at /c/<id>, with an overview at the root; setup adds a client.
   * demo: Fernhill at the root plus more clients at /c/<id>; setup adds a client.
   */
  mode?: HostMode;
  /** The default workspace (shown at the root), if its config exists. */
  configPath?: string;
  defaultId?: string;
  /** More workspaces to open at start (practice and demo). */
  workspaces?: Array<{ id: string; configPath: string }>;
  server:
    ServerOptions | ((rf: Retrofit, configPath: string, ws: { id: string; path: string }) => ServerOptions);
  setup: Omit<SetupOptions, 'activate' | 'isConfigured'>;
  dashboardDir?: string;
  /** Called after a workspace becomes active (the demo registers the mock webhook here). */
  onActivate?: (rf: Retrofit, ws: { id: string; path: string }) => Promise<void> | void;
}

/**
 * Hosts one or more retrofit workspaces in one process. Before any config exists it serves only the
 * setup wizard; finishing the wizard activates the new workspace without a restart. In practice mode a
 * bookkeeper sees every client on one overview, and each client's console lives at /c/<id>.
 */
export function createHost(opts: HostOptions) {
  const mode = opts.mode ?? 'single';
  const app = express();
  app.disable('x-powered-by');
  const workspaces = new Map<string, Workspace>();
  let defaultId: string | null = null;

  const auth = basicAuth();
  const guard: express.RequestHandler = auth ?? ((_req, _res, next) => next());
  const serverOpts = (rf: Retrofit, configPath: string, ws: { id: string; path: string }) =>
    typeof opts.server === 'function' ? opts.server(rf, configPath, ws) : opts.server;

  // The root when no default workspace is active: the console (wizard or practice overview) and a 409 API.
  const rootOnly = express();
  rootOnly.get('/healthz', (_req, res) => res.json({ ok: true, setup: workspaces.size === 0 }));
  if (auth) rootOnly.use(auth);
  rootOnly.use('/api', (_req, res) =>
    res.status(409).json({
      error: workspaces.size
        ? 'Open a client from the overview.'
        : 'Not set up yet: finish the setup wizard first.',
      setup: workspaces.size === 0,
    }),
  );
  serveDashboard(rootOnly, opts.dashboardDir);

  async function activate(configPath: string, o: { id: string; makeDefault?: boolean }) {
    const rf = new Retrofit(loadConfig(configPath));
    const isDefault = Boolean(o.makeDefault);
    const ws = { id: o.id, path: isDefault ? '' : `/c/${o.id}` };
    const next = createServer(rf, { dashboardDir: opts.dashboardDir, ...serverOpts(rf, configPath, ws) });
    const prev = workspaces.get(o.id);
    workspaces.set(o.id, { id: o.id, rf, configPath, path: ws.path, app: next.app, stop: next.stop });
    if (isDefault) defaultId = o.id;
    if (prev) {
      prev.stop();
      await prev.rf.close().catch(() => {});
    }
    await opts.onActivate?.(rf, ws);
    rf.emit('reset');
    return rf;
  }

  async function remove(id: string) {
    const ws = workspaces.get(id);
    if (!ws) return;
    workspaces.delete(id);
    if (defaultId === id) defaultId = null;
    ws.stop();
    await ws.rf.close().catch(() => {});
  }

  const consoleUrl = (id: string) => (id === defaultId ? '/' : `/c/${id}/`);
  const newId = (configPath: string) => {
    const base =
      loadConfig(configPath)
        .business.name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 24) || 'client';
    let id = base;
    for (let n = 2; workspaces.has(id); n++) id = `${base}-${n}`;
    return id;
  };

  app.use(
    '/api/setup',
    guard,
    setupRouter({
      ...opts.setup,
      isConfigured: () => workspaces.size > 0,
      activate: async (configPath) => {
        if (mode === 'single') {
          const rf = await activate(configPath, { id: 'main', makeDefault: true });
          return { rf, consoleUrl: '/' };
        }
        const id = newId(configPath);
        const rf = await activate(configPath, { id });
        return { rf, consoleUrl: consoleUrl(id) };
      },
    }),
  );
  app.get('/api/host', guard, (_req, res) =>
    res.json({
      mode,
      workspaces: [...workspaces.values()].map((w) => ({
        id: w.id,
        business: w.rf.config.business.name,
        consoleUrl: consoleUrl(w.id),
        default: w.id === defaultId,
      })),
    }),
  );
  // The bookkeeper's overview: every client's position, sorted by what needs attention.
  app.get('/api/practice', guard, async (_req, res) => {
    const rows = await Promise.all(
      [...workspaces.values()].map(async (w) => {
        try {
          const s = await summary(w.rf);
          const requests = w.rf.state.listRequests({ status: 'open' }).length;
          const orders = w.rf.state
            .listOrders(500)
            .filter((o) => o.status === 'COMPLETED' && !o.invoices?.length);
          const attention = s.pendingActions + s.discrepancies + requests;
          return {
            id: w.id,
            business: s.business,
            consoleUrl: consoleUrl(w.id),
            environment: s.environment,
            currency: s.currency,
            source: w.rf.source.kind,
            openAmount: s.openAmount,
            overdue: s.overdue,
            overdueAmount: s.overdueAmount,
            paidViaPayPalAmount: s.paidViaPayPalAmount,
            expectedNext30: s.expectedNext30,
            atRisk: s.atRisk,
            pendingActions: s.pendingActions,
            scheduledActions: s.scheduledActions,
            discrepancies: s.discrepancies,
            requests,
            sales: orders.reduce((t, o) => t + o.total, 0),
            attention,
            linked: s.linked,
            invoices: s.invoices,
            lastSyncAt: s.lastSyncAt,
            lastDigestAt: w.rf.state.getMeta('digest.lastSentAt') ?? null,
          };
        } catch (e) {
          return {
            id: w.id,
            business: w.rf.config.business.name,
            consoleUrl: consoleUrl(w.id),
            error: (e as Error).message,
          };
        }
      }),
    );
    res.json(
      rows.sort(
        (a: any, b: any) =>
          (b.attention ?? 0) - (a.attention ?? 0) || (b.overdueAmount ?? 0) - (a.overdueAmount ?? 0),
      ),
    );
  });

  app.use('/c/:id', (req, res, next) => {
    const ws = workspaces.get(String(req.params.id));
    if (!ws) return res.status(404).json({ error: `No client "${req.params.id}"` });
    ws.app(req, res, next);
  });
  app.use((req, res, next) => {
    const ws = defaultId ? workspaces.get(defaultId) : undefined;
    return ws ? ws.app(req, res, next) : rootOnly(req, res, next);
  });

  return {
    app,
    mode,
    activate,
    remove,
    workspaces,
    get rf() {
      return defaultId ? (workspaces.get(defaultId)?.rf ?? null) : null;
    },
    get configPath() {
      return defaultId ? (workspaces.get(defaultId)?.configPath ?? null) : null;
    },
    async start() {
      if (opts.configPath && fs.existsSync(opts.configPath))
        await activate(opts.configPath, { id: opts.defaultId ?? 'main', makeDefault: true });
      for (const w of opts.workspaces ?? [])
        if (fs.existsSync(w.configPath)) await activate(w.configPath, { id: w.id });
      return defaultId ? (workspaces.get(defaultId)?.rf ?? null) : null;
    },
  };
}
