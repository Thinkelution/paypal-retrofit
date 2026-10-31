import { claudeConfigured, proposeMapping } from '@paypal-retrofit/agents';
import {
  openSource,
  RetrofitMapping,
  WEBHOOK_EVENTS,
  writeConfig,
  type Retrofit,
} from '@paypal-retrofit/core';
import { createMockPayPal } from '@paypal-retrofit/mock-paypal';
import { createHost, SAMPLES_DIR } from '@paypal-retrofit/server';
import { createFernhillApp, openDb, seed, seedInto } from 'fernhill-legacy-invoicer';
import fs from 'node:fs';
import path from 'node:path';
import { c } from '../ui.ts';

export interface DemoOptions {
  port?: string;
  dir?: string;
  publicUrl?: string;
  fresh?: boolean;
  sync?: boolean;
}

const TZ = () => process.env.RETROFIT_TIMEZONE ?? 'America/Los_Angeles';

/** In GitHub Codespaces the console is reached through the forwarded port's URL, not localhost. */
function codespacesUrl(port: number) {
  const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = process.env;
  return name && domain ? `https://${name}-${port}.${domain}` : undefined;
}

/**
 * Writes a workspace's config and mapping for a demo business. The mapping comes from the Mapper agent
 * (Claude when configured, otherwise the rule-based mapper), then `extra` adds demo settings.
 */
async function demoWorkspace(
  dir: string,
  source: string,
  config: Parameters<typeof writeConfig>[1],
  extra: (m: RetrofitMapping) => RetrofitMapping,
) {
  const src = openSource(source, dir);
  const schema = await src.introspect();
  await src.close();
  const r = await proposeMapping(schema, { timezone: TZ() });
  if (!r.mapping) throw new Error(`Could not map ${source}`);
  fs.writeFileSync(
    path.join(dir, 'retrofit.map.json'),
    JSON.stringify(extra(RetrofitMapping.parse(r.mapping)), null, 2),
  );
  writeConfig(path.join(dir, 'retrofit.config.yaml'), config);
}

/**
 * One process with everything: the Fernhill legacy app (/fernhill), a mock PayPal (/mock-paypal), a
 * second client (Brightside Plumbing, CSV exports, at /c/brightside), retrofit's console, portal, shop
 * and MCP endpoints, and webhooks flowing between them. No accounts needed. With PAYPAL_CLIENT_ID/SECRET
 * set and --sandbox it uses the real PayPal sandbox instead of the mock.
 */
export async function demo(opts: DemoOptions & { sandbox?: boolean }) {
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const dir = path.resolve(opts.dir ?? process.env.RETROFIT_DEMO_DIR ?? '.retrofit/demo');
  const publicUrl = (
    opts.publicUrl ??
    process.env.RETROFIT_PUBLIC_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    codespacesUrl(port) ??
    `http://localhost:${port}`
  ).replace(/\/$/, '');
  const internal = `http://127.0.0.1:${port}`;
  const useMock = !opts.sandbox;
  if (opts.fresh && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  if (useMock) {
    process.env.PAYPAL_ENVIRONMENT = 'MOCK';
    process.env.PAYPAL_MOCK_URL = `${internal}/mock-paypal`;
  } else {
    process.env.PAYPAL_ENVIRONMENT = 'SANDBOX';
  }
  const prefix = (p: string) => (useMock ? '' : `${p}${Date.now().toString(36).slice(-4).toUpperCase()}-`);

  // ---- Fernhill Studio: the legacy app's SQLite database, at the root
  const dbFile = path.join(dir, 'fernhill.db');
  if (!fs.existsSync(dbFile)) seed({ file: dbFile, buyerEmail: process.env.FERNHILL_BUYER_EMAIL });
  const fernhillConfig = path.join(dir, 'retrofit.config.yaml');
  if (!fs.existsSync(fernhillConfig)) {
    console.log(
      c.dim(
        claudeConfigured()
          ? 'Asking Claude to map the demo data…'
          : 'Mapping the demo data with the rule-based mapper…',
      ),
    );
    await demoWorkspace(
      dir,
      'sqlite:./fernhill.db',
      {
        source: 'sqlite:./fernhill.db',
        mapping: './retrofit.map.json',
        state: './state.db',
        business: { name: 'Fernhill Studio', website: `${publicUrl}/fernhill` },
        paypal: { invoicePrefix: prefix('FH'), returnUrl: `${publicUrl}/fernhill/retainers` },
        webhook: { publicUrl: `${publicUrl}/webhooks/paypal` },
        sync: { intervalSeconds: 60 },
      },
      // Fernhill sells its services online too: the shop and the buyer-agent MCP endpoint.
      (m) => ({
        ...m,
        commerce: {
          enabled: true,
          maxOrderTotal: 2500,
          maxQuantity: 10,
          description: 'Portrait, product and event photography in Portland, Oregon.',
        },
      }),
    );
  }

  // ---- Brightside Plumbing: CSV exports, a second client at /c/brightside, with payment terms
  const brightDir = path.join(dir, 'brightside');
  const brightConfig = path.join(brightDir, 'retrofit.config.yaml');
  const createBrightside = async () => {
    fs.rmSync(brightDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(brightDir, 'data'), { recursive: true });
    for (const f of fs.readdirSync(SAMPLES_DIR).filter((x) => x.endsWith('.csv')))
      fs.copyFileSync(path.join(SAMPLES_DIR, f), path.join(brightDir, 'data', f));
    await demoWorkspace(
      brightDir,
      'csv:./data',
      {
        source: 'csv:./data',
        mapping: './retrofit.map.json',
        state: './state.db',
        business: { name: 'Brightside Plumbing' },
        paypal: { invoicePrefix: prefix('BP') },
        webhook: { publicUrl: `${publicUrl}/c/brightside/webhooks/paypal` },
        sync: { intervalSeconds: 60 },
      },
      (m) => ({
        ...m,
        terms: {
          lateFee: { kind: 'percent', amount: 2, afterDays: 30, label: 'Late payment fee (2%)' },
          earlyDiscount: { percent: 2, withinDays: 10 },
        },
      }),
    );
  };
  if (!fs.existsSync(brightConfig)) await createBrightside();

  const log = (m: string) => console.error(`[mock-paypal] ${m}`);
  const mock = useMock
    ? createMockPayPal({
        publicUrl: `${publicUrl}/mock-paypal`,
        dataFile: path.join(dir, 'mock-paypal.json'),
        log,
      })
    : null;
  const fernDb = openDb(dbFile);
  const fernApp = createFernhillApp(() => fernDb, '/fernhill');

  const ensureWebhook = async (rf: Retrofit, ws: { path: string }) => {
    const url = useMock ? `${internal}${ws.path}/webhooks/paypal` : `${publicUrl}${ws.path}/webhooks/paypal`;
    if (!useMock && !/^https:/.test(url)) {
      console.log(
        c.yellow(
          `  Sandbox webhooks need a public HTTPS URL; set RETROFIT_PUBLIC_URL. Reconcile will still pick up payments.`,
        ),
      );
      return;
    }
    const existing = (await rf.paypal.listWebhooks()).webhooks?.find((w) => w.url === url);
    const wh = existing ?? (await rf.paypal.createWebhook(url, WEBHOOK_EVENTS));
    rf.state.setMeta('paypal.webhookId', wh.id);
  };

  const host = createHost({
    mode: 'demo',
    configPath: fernhillConfig,
    defaultId: 'fernhill',
    workspaces: [{ id: 'brightside', configPath: brightConfig }],
    server: (_rf, _configPath, ws) => ({
      watch: false,
      reconcileEverySeconds: 120,
      mounts: [
        ...(mock ? [{ path: '/mock-paypal', router: mock.app, public: true }] : []),
        ...(ws.path === '' ? [{ path: '/fernhill', router: fernApp }] : []),
      ],
      demo: {
        legacyAppPath: ws.path === '' ? '/fernhill' : '',
        mockPath: mock ? '/mock-paypal' : '',
        custom: ws.path !== '',
        reset: async () => {
          if (!mock) throw new Error('Reset is only available with the mock');
          mock.reset();
          // Clients added with the setup wizard go; Fernhill and Brightside start again.
          for (const id of [...host.workspaces.keys()])
            if (id !== 'fernhill' && id !== 'brightside') await host.remove(id);
          const rf = host.workspaces.get('fernhill')!.rf;
          seedInto(fernDb);
          rf.state.db.exec(
            'DELETE FROM links; DELETE FROM events; DELETE FROM actions; DELETE FROM discrepancies; DELETE FROM meta; DELETE FROM plans; DELETE FROM payments; DELETE FROM digests; DELETE FROM adjustments; DELETE FROM requests; DELETE FROM orders; DELETE FROM outbox; DELETE FROM autopay;',
          );
          await ensureWebhook(rf, { path: '' });
          await host.remove('brightside');
          await createBrightside();
          const b = await host.activate(brightConfig, { id: 'brightside' });
          await b.sync();
          rf.emit('reset');
        },
        dispute: async (paypalInvoiceId: string) => {
          if (!mock) throw new Error('Disputes are opened by buyers in the PayPal sandbox');
          const r = await fetch(
            `${internal}/mock-paypal/mock/api/invoices/${encodeURIComponent(paypalInvoiceId)}/dispute`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '{}',
            },
          );
          const body: any = await r.json();
          if (!r.ok) throw new Error(body?.message ?? 'Could not open a dispute');
          return body;
        },
      },
    }),
    setup: {
      workspaceRoot: path.join(dir, 'workspaces'),
      // The hosted demo is public: only CSV uploads and the sample data, never server paths.
      allowServerPaths: process.env.RETROFIT_SETUP_ALLOW_PATHS === '1',
      allowReconfigure: true,
      invoicePrefix: () => `W${Date.now().toString(36).slice(-4).toUpperCase()}-`,
    },
    onActivate: ensureWebhook,
  });
  const { app } = host;

  // Listen first: activating registers webhooks with the mock PayPal served by this same process.
  await new Promise<void>((resolve) => app.listen(port, resolve));
  await host.start();
  const bright = host.workspaces.get('brightside')?.rf;
  if (bright && bright.state.listLinks().length === 0) await bright.sync();
  if (opts.sync) await host.rf!.sync();
  console.log(`
${c.bold('paypal-retrofit demo')} ${c.dim(useMock ? '(mock PayPal, no account needed)' : '(PayPal sandbox)')}
  Console (Fernhill)   ${c.cyan(publicUrl + '/')}
  Second client        ${c.cyan(publicUrl + '/c/brightside/')}
  All clients          ${c.cyan(publicUrl + '/#practice')}
  Legacy app           ${c.cyan(publicUrl + '/fernhill')}
  Shop (buyers)        ${c.cyan(publicUrl + '/shop')}
  Your own data        ${c.cyan(publicUrl + '/#setup')}
  MCP (owner / buyer)  ${c.cyan(publicUrl + '/mcp')}  ${c.cyan(publicUrl + '/mcp/shop')}
  ${useMock ? `Mock PayPal          ${c.cyan(publicUrl + '/mock-paypal/mock/state')}` : ''}
  Ops agent            ${claudeConfigured() ? c.green('on') : c.yellow('off (set ANTHROPIC_API_KEY)')}
  Data                 ${c.dim(dir)}
`);
}
