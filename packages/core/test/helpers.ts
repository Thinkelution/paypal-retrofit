import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { seed } from '../../../examples/legacy-invoicer/src/seed.ts';
import { createMockPayPal } from '../../mock-paypal/src/index.ts';
import {
  handleWebhook,
  heuristicMapping,
  openSource,
  resolveEnv,
  Retrofit,
  validateMapping,
  WEBHOOK_EVENTS,
  type ResolvedConfig,
} from '../src/index.ts';

export async function listen(app: express.Express) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

/** Fernhill DB + mock PayPal + a webhook receiver wired to a Retrofit engine. */
export async function harness(opts: { autoApprove?: boolean; quietHours?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-test-'));
  const dbFile = seed({ file: path.join(dir, 'fernhill.db'), today: new Date('2026-10-29T12:00:00Z') });

  // Mock PayPal on an ephemeral port (public URL patched after listen).
  const holder: { url: string } = { url: '' };
  const mockApp = express();
  const mockServer = await listen(mockApp);
  holder.url = mockServer.url;
  const mock = createMockPayPal({ publicUrl: holder.url, log: () => {} });
  mockApp.use(mock.app);

  process.env.PAYPAL_ENVIRONMENT = 'MOCK';
  process.env.PAYPAL_MOCK_URL = holder.url;
  process.env.RETROFIT_AUTO_APPROVE = opts.autoApprove ? '1' : '0';
  process.env.RETROFIT_QUIET = '1';
  delete process.env.PAYPAL_WEBHOOK_ID;

  const source = openSource(`sqlite:${dbFile}`);
  const schema = await source.introspect();
  const proposal = heuristicMapping(schema)!;
  const { mapping, issues } = validateMapping(proposal, schema);
  // Quiet hours depend on the wall clock; tests that need them set them explicitly.
  if (!opts.quietHours) mapping.quietHours = undefined;

  const config: ResolvedConfig = {
    source: `sqlite:${dbFile}`,
    mapping: path.join(dir, 'retrofit.map.json'),
    state: path.join(dir, 'state.db'),
    business: { name: 'Fernhill Studio' },
    paypal: { invoicePrefix: '' },
    webhook: {},
    sync: { intervalSeconds: 60 },
    digest: { enabled: false, time: '08:00', weekdaysOnly: true, to: [] },
    baseDir: dir,
    configPath: path.join(dir, 'retrofit.config.yaml'),
    env: resolveEnv(),
  };
  const rf = new Retrofit(config, { source, mapping });

  // Webhook receiver
  const hookApp = express();
  hookApp.post('/webhooks/paypal', express.text({ type: '*/*' }), async (req, res) => {
    const r = await handleWebhook(rf, req.headers as any, req.body);
    res.status(r.httpStatus).json(r);
  });
  const hookServer = await listen(hookApp);
  const wh = await rf.paypal.createWebhook(`${hookServer.url}/webhooks/paypal`, WEBHOOK_EVENTS);
  rf.state.setMeta('paypal.webhookId', wh.id);

  return {
    rf,
    mock,
    mockUrl: holder.url,
    schema,
    mapping,
    issues,
    dbFile,
    async close() {
      await rf.close();
      await mockServer.close();
      await hookServer.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
