import { loadConfig, Retrofit } from '@paypal-retrofit/core';
import express from 'express';
import fs from 'node:fs';
import { basicAuth, createServer, serveDashboard, type ServerOptions } from './index.ts';
import { setupRouter, type SetupOptions } from './setup.ts';

export interface HostOptions {
  /** Start with this config if it exists; otherwise the console opens the setup wizard. */
  configPath?: string;
  server: ServerOptions | ((rf: Retrofit, configPath: string) => ServerOptions);
  setup: Omit<SetupOptions, 'activate' | 'isConfigured'>;
  dashboardDir?: string;
  /** Called after a workspace becomes active (the demo registers the mock webhook here). */
  onActivate?: (rf: Retrofit) => Promise<void> | void;
}

/**
 * Wraps the retrofit server so the active workspace can change at runtime: before any config exists it
 * serves only the setup wizard, and finishing the wizard switches the running server to the new config.
 */
export function createHost(opts: HostOptions) {
  const app = express();
  app.disable('x-powered-by');
  let current: { rf: Retrofit; configPath: string; app: express.Express; stop: () => void } | null = null;

  const setupOnly = express();
  setupOnly.get('/healthz', (_req, res) => res.json({ ok: true, setup: true }));
  const auth = basicAuth();
  if (auth) setupOnly.use(auth);
  setupOnly.use('/api', (_req, res) =>
    res.status(409).json({ error: 'Not set up yet: finish the setup wizard first.', setup: true }),
  );
  const serverOpts = (rf: Retrofit, configPath: string) =>
    typeof opts.server === 'function' ? opts.server(rf, configPath) : opts.server;
  serveDashboard(setupOnly, opts.dashboardDir);

  async function activate(configPath: string) {
    const rf = new Retrofit(loadConfig(configPath));
    const next = createServer(rf, { dashboardDir: opts.dashboardDir, ...serverOpts(rf, configPath) });
    const prev = current;
    current = { rf, configPath, app: next.app, stop: next.stop };
    if (prev) {
      prev.stop();
      await prev.rf.close().catch(() => {});
    }
    await opts.onActivate?.(rf);
    rf.emit('reset');
    return rf;
  }

  const setupAuth: express.RequestHandler = auth ?? ((_req, _res, next) => next());
  app.use(
    '/api/setup',
    setupAuth,
    setupRouter({ ...opts.setup, isConfigured: () => current !== null, activate }),
  );
  app.use((req, res, next) => (current ? current.app(req, res, next) : setupOnly(req, res, next)));

  return {
    app,
    activate,
    get rf() {
      return current?.rf ?? null;
    },
    get configPath() {
      return current?.configPath ?? null;
    },
    async start() {
      if (opts.configPath && fs.existsSync(opts.configPath)) await activate(opts.configPath);
      return current?.rf ?? null;
    },
  };
}
