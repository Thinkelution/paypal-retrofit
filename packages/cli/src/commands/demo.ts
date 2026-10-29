import { claudeConfigured, proposeMapping } from '@paypal-retrofit/agents';
import {
  loadConfig,
  openSource,
  RetrofitMapping,
  Retrofit,
  WEBHOOK_EVENTS,
  writeConfig,
} from '@paypal-retrofit/core';
import { createMockPayPal } from '@paypal-retrofit/mock-paypal';
import { createServer } from '@paypal-retrofit/server';
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

/**
 * One process with everything: the Fernhill legacy app (/fernhill), a mock PayPal (/mock-paypal),
 * retrofit's API + dashboard (/), and webhooks flowing between them. No accounts needed.
 * With PAYPAL_CLIENT_ID/SECRET set and --sandbox it uses the real PayPal sandbox instead of the mock.
 */
export async function demo(opts: DemoOptions & { sandbox?: boolean }) {
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const dir = path.resolve(opts.dir ?? process.env.RETROFIT_DEMO_DIR ?? '.retrofit/demo');
  const publicUrl = (
    opts.publicUrl ??
    process.env.RETROFIT_PUBLIC_URL ??
    process.env.RENDER_EXTERNAL_URL ??
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

  const dbFile = path.join(dir, 'fernhill.db');
  if (!fs.existsSync(dbFile)) seed({ file: dbFile, buyerEmail: process.env.FERNHILL_BUYER_EMAIL });

  const configFile = path.join(dir, 'retrofit.config.yaml');
  if (!fs.existsSync(configFile)) {
    const src = openSource(`sqlite:${dbFile}`);
    const schema = await src.introspect();
    await src.close();
    console.log(
      c.dim(
        claudeConfigured()
          ? 'Asking Claude to map the Fernhill schema…'
          : 'Mapping the Fernhill schema with the heuristic mapper…',
      ),
    );
    const r = await proposeMapping(schema);
    if (!r.mapping) throw new Error('Could not map the demo schema');
    fs.writeFileSync(
      path.join(dir, 'retrofit.map.json'),
      JSON.stringify(RetrofitMapping.parse(r.mapping), null, 2),
    );
    writeConfig(configFile, {
      source: 'sqlite:./fernhill.db',
      mapping: './retrofit.map.json',
      state: './state.db',
      business: { name: 'Fernhill Studio', website: `${publicUrl}/fernhill` },
      paypal: {
        invoicePrefix: useMock ? '' : `FH${Date.now().toString(36).slice(-4).toUpperCase()}-`,
        returnUrl: `${publicUrl}/fernhill/retainers`,
      },
      webhook: { publicUrl: `${publicUrl}/webhooks/paypal` },
      sync: { intervalSeconds: 60 },
    });
  }

  const rf = new Retrofit(loadConfig(configFile));
  const mock = useMock
    ? createMockPayPal({
        publicUrl: `${publicUrl}/mock-paypal`,
        dataFile: path.join(dir, 'mock-paypal.json'),
        log: (m) => rf.log.info(m),
      })
    : null;
  const fernDb = openDb(dbFile);

  const ensureWebhook = async () => {
    const url = useMock ? `${internal}/webhooks/paypal` : `${publicUrl}/webhooks/paypal`;
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

  const { app } = createServer(rf, {
    watch: false,
    reconcileEverySeconds: 120,
    mounts: [
      ...(mock ? [{ path: '/mock-paypal', router: mock.app, public: true }] : []),
      { path: '/fernhill', router: createFernhillApp(() => fernDb, '/fernhill') },
    ],
    demo: mock
      ? {
          legacyAppPath: '/fernhill',
          mockPath: '/mock-paypal',
          reset: async () => {
            seedInto(fernDb);
            rf.state.db.exec(
              'DELETE FROM links; DELETE FROM events; DELETE FROM actions; DELETE FROM discrepancies; DELETE FROM meta;',
            );
            mock.reset();
            await ensureWebhook();
            rf.emit('reset');
          },
          dispute: async (paypalInvoiceId) => {
            const r = await fetch(
              `${internal}/mock-paypal/mock/api/invoices/${encodeURIComponent(paypalInvoiceId)}/dispute`,
              { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
            );
            const body: any = await r.json();
            if (!r.ok) throw new Error(body?.message ?? 'Could not open a dispute');
            return body;
          },
        }
      : {
          legacyAppPath: '/fernhill',
          mockPath: '',
          reset: async () => {
            throw new Error('Reset is only available with the mock');
          },
          dispute: async () => {
            throw new Error('Disputes are opened by buyers in the PayPal sandbox');
          },
        },
  });

  await new Promise<void>((resolve) => app.listen(port, resolve));
  await ensureWebhook();
  if (opts.sync) await rf.sync();
  console.log(`
${c.bold('paypal-retrofit demo')} ${c.dim(useMock ? '(mock PayPal, no account needed)' : '(PayPal sandbox)')}
  Dashboard          ${c.cyan(publicUrl + '/')}
  Legacy app         ${c.cyan(publicUrl + '/fernhill')}
  ${useMock ? `Mock PayPal        ${c.cyan(publicUrl + '/mock-paypal/mock/state')}` : ''}
  Ops agent          ${claudeConfigured() ? c.green('on') : c.yellow('off (set ANTHROPIC_API_KEY)')}
  Data               ${c.dim(dir)}
`);
}
