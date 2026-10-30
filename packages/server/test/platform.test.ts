import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDigest,
  digestDue,
  nextDigestAt,
  renderDigest,
  signActionToken,
  verifyActionToken,
} from '../../core/src/index.ts';
import { harness, listen } from '../../core/test/helpers.ts';
import { applyControls, createHost, createServer, sendDigest } from '../src/index.ts';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('owner digest', () => {
  it('summarises payments, approvals and risk, and renders email, text and Slack', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const link = h.rf.state.listLinks().find((l) => l.entity === 'invoice')!;
    await h.mock.payInvoice(link.paypalId);
    const overdue = h.rf.state.listLinks().find((l) => l.entity === 'invoice' && l.paypalStatus === 'SENT')!;
    const reminder = await h.rf.propose({
      origin: 'cli',
      kind: 'send_reminder',
      target: { entity: 'invoice', legacyPk: overdue.legacyPk, paypalId: overdue.paypalId },
      payload: { note: 'A friendly nudge' },
      reason: 'Overdue',
    });
    expect(reminder.status).toBe('pending');

    const d = await buildDigest(h.rf, { since: '2000-01-01T00:00:00Z' });
    expect(d.money.count).toBeGreaterThanOrEqual(1);
    expect(d.money.gross).toBeGreaterThan(0);
    // Sync also queued the pending retainer subscription for approval.
    expect(d.approvalsTotal).toBe(h.rf.state.listActions('pending').length);
    expect(d.approvals.map((a) => a.kind)).toContain('send_reminder');
    expect(d.headline).toMatch(/came in from \d+ payments?; \d+ things? needs? you/);

    const secret = 'test-secret';
    const r = renderDigest(d, {
      baseUrl: 'https://retrofit.example',
      approveUrl: (id) => `https://retrofit.example/a/${signActionToken(secret, id)}`,
    });
    expect(r.subject).toContain('Fernhill Studio');
    expect(r.html).toContain(`Waiting for your OK (${d.approvalsTotal})`);
    expect(r.html).toContain('https://retrofit.example/a/');
    expect(r.text).toContain('Came in:');
    expect(JSON.stringify(r.slack.blocks)).toContain('Review');
  });

  it('signs approval links that expire and cannot be forged', () => {
    const t = signActionToken('s1', 42, 48, Date.parse('2026-10-29T08:00:00Z'));
    expect(verifyActionToken('s1', t, Date.parse('2026-10-30T08:00:00Z'))).toEqual({ actionId: 42 });
    expect(verifyActionToken('s1', t, Date.parse('2026-11-01T08:01:00Z'))).toMatchObject({
      error: /expired/,
    });
    expect(verifyActionToken('other', t)).toMatchObject({ error: /not valid/ });
    const [body] = t.split('.');
    const forged = `${Buffer.from('43.9999999999').toString('base64url')}.${t.split('.')[1]}`;
    expect(body).not.toBe(forged.split('.')[0]);
    expect(verifyActionToken('s1', forged)).toMatchObject({ error: /not valid/ });
  });

  it('is due once per local weekday within three hours of the chosen time', () => {
    const tz = 'America/Los_Angeles';
    // Thu 29 Oct 2026, 08:30 PDT = 15:30Z
    expect(digestDue('08:00', tz, true, undefined, new Date('2026-10-29T15:30:00Z'))).toBe(true);
    expect(digestDue('08:00', tz, true, '2026-10-29T15:01:00Z', new Date('2026-10-29T15:30:00Z'))).toBe(
      false,
    );
    expect(digestDue('08:00', tz, true, undefined, new Date('2026-10-29T14:30:00Z'))).toBe(false); // 07:30
    expect(digestDue('08:00', tz, true, undefined, new Date('2026-10-29T23:30:00Z'))).toBe(false); // 16:30
    expect(digestDue('08:00', tz, true, undefined, new Date('2026-10-31T15:30:00Z'))).toBe(false); // Saturday
    // After Friday's digest the next one is Monday 2 Nov 08:00 PST (after the DST change) = 16:00Z
    expect(nextDigestAt('08:00', tz, true, '2026-10-30T15:00:00Z', new Date('2026-10-30T16:00:00Z'))).toBe(
      '2026-11-02T16:00:00.000Z',
    );
  });

  it('delivers to Slack, keeps an outbox copy, and approves from the link page', async () => {
    const h = await harness();
    cleanups.push(h.close);
    await h.rf.sync();
    const target = h.rf.state.listLinks().find((l) => l.entity === 'invoice' && l.paypalStatus === 'SENT')!;
    const a = await h.rf.propose({
      origin: 'cli',
      kind: 'send_reminder',
      target: { entity: 'invoice', legacyPk: target.legacyPk, paypalId: target.paypalId },
      payload: {},
      reason: 'Overdue',
    });

    const posts: any[] = [];
    const slack = express();
    slack.post('/hook', express.json(), (req, res) => {
      posts.push(req.body);
      res.send('ok');
    });
    const slackServer = await listen(slack);
    cleanups.push(slackServer.close);
    h.rf.config.env.slackWebhookUrl = `${slackServer.url}/hook`;

    const { app, stop } = createServer(h.rf);
    const server = await listen(app);
    cleanups.push(async () => {
      stop();
      await server.close();
    });

    const sent = await sendDigest(h.rf, { ai: false, baseUrl: server.url });
    expect(sent.deliveries.map((d) => `${d.channel}:${d.status}`)).toEqual([
      'email:skipped',
      'slack:sent',
      'outbox:sent',
    ]);
    expect(posts).toHaveLength(1);
    expect(h.rf.state.listDigests()).toHaveLength(1);
    const reviewUrl = JSON.stringify(posts[0]).match(/"url":"([^"]+\/a\/[^"]+)"/)![1]!;
    expect(reviewUrl.startsWith(`${server.url}/a/`)).toBe(true);

    const page = await (await fetch(reviewUrl)).text();
    expect(page).toContain('Send reminder');
    expect(page).toContain('value="approve"');
    expect(h.rf.state.getAction(a.id)!.status).toBe('pending'); // GET changes nothing

    const done = await (
      await fetch(reviewUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'decision=approve',
      })
    ).text();
    expect(done).toMatch(/Approved/);
    expect(h.rf.state.getAction(a.id)!.status).toBe('executed');
    const again = await (await fetch(reviewUrl)).text();
    expect(again).toContain('no longer waiting');

    const bad = await fetch(`${server.url}/a/abc.def`);
    expect(await bad.text()).toContain('Link not valid');
  });
});

describe('setup wizard', () => {
  it('maps the sample business, previews the first sync and goes live without a restart', async () => {
    const h = await harness(); // sets MOCK env + mock PayPal URL
    cleanups.push(h.close);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrofit-setup-'));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, 'retrofit.config.yaml');
    const host = createHost({
      configPath,
      server: { watch: false },
      setup: {
        workspaceRoot: path.join(dir, '.retrofit', 'workspaces'),
        configPath,
        allowServerPaths: false,
        allowReconfigure: false,
      },
    });
    expect(await host.start()).toBeNull();
    const server = await listen(host.app);
    cleanups.push(async () => {
      await host.rf?.close();
      await server.close();
    });
    const call = async (method: string, p: string, body?: unknown) => {
      const r = await fetch(server.url + p, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, body: (await r.json()) as any };
    };

    expect((await call('GET', '/api/summary')).status).toBe(409);
    const st = await call('GET', '/api/setup/status');
    expect(st.body).toMatchObject({ configured: false, canSetup: true, environment: 'MOCK' });
    expect(st.body.samples).toContain('bills.csv');

    expect((await call('POST', '/api/setup/sources', { kind: 'sqlite', path: '/etc/passwd' })).status).toBe(
      400,
    );
    const src = await call('POST', '/api/setup/sources', { kind: 'sample' });
    expect(src.status).toBe(200);
    expect(src.body.schema.tables.map((t: any) => t.name).sort()).toEqual(['bill_items', 'bills', 'clients']);

    const mapped = await call('POST', `/api/setup/sources/${src.body.id}/map`, {
      ai: false,
      timezone: 'America/Los_Angeles',
    });
    expect(mapped.status).toBe(200);
    expect(mapped.body.mapping.entities.invoice).toMatchObject({
      table: 'bills',
      fields: { number: 'reference', total: 'amount_due' },
    });
    expect(mapped.body.mapping.entities.invoice.lines.fk).toBe('bill_id');

    const controls = {
      newInvoices: 'auto',
      refundsAutoUpTo: 50,
      refundsPerDay: 200,
      remindersPerDay: 10,
      quietHours: { enabled: true, start: '19:00', end: '07:30', weekends: false },
      timezone: 'America/Los_Angeles',
      collections: { friendly: 2, firm: 10, final: 21 },
    };
    const preview = await call('POST', `/api/setup/sources/${src.body.id}/preview`, { controls });
    expect(preview.status).toBe(200);
    expect(preview.body.invoices.toSend).toBeGreaterThan(5);
    expect(preview.body.byKind.create_invoice).toBe(preview.body.invoices.toSend);
    expect(preview.body.skipped).toContainEqual({
      label: 'BP-2429',
      reason: 'status "draft" is not sent to PayPal',
    });

    const fin = await call('POST', `/api/setup/sources/${src.body.id}/finish`, {
      business: { name: 'Brightside Plumbing' },
      controls,
      digest: { to: 'owner@example.com', time: '07:45' },
      syncNow: true,
    });
    expect(fin.status).toBe(200);
    expect(fin.body.synced.executed).toBeGreaterThan(5);

    const sum = await call('GET', '/api/summary');
    expect(sum.status).toBe(200);
    expect(sum.body.business).toBe('Brightside Plumbing');
    expect(sum.body.linked).toBeGreaterThan(5);
    const cfg = await call('GET', '/api/config');
    expect(cfg.body.controls.quietHours).toMatchObject({ start: '19:00', end: '07:30', weekends: false });
    expect(cfg.body.controls.collections.steps.map((s: any) => s.afterDaysOverdue)).toEqual([2, 10, 21]);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('owner@example.com');
    // Write-back went to the sidecar CSV, never the original upload.
    expect(fs.readdirSync(path.join(dir, '.retrofit', 'workspaces'))).toHaveLength(1); // the refused request left nothing
    const data = path.join(
      dir,
      fs
        .readFileSync(configPath, 'utf8')
        .match(/source: csv:(.+)/)![1]!
        .trim(),
    );
    expect(fs.readFileSync(path.join(data, 'bills.retrofit.csv'), 'utf8')).toMatch(/INV2-/);
    expect(fs.readFileSync(path.join(data, 'bills.csv'), 'utf8')).not.toMatch(/INV2-/);

    // Configured now: setup is closed on a non-demo server.
    expect((await call('POST', '/api/setup/sources', { kind: 'sample' })).status).toBe(403);
  });

  it('turns plain-language controls into rules, limits and quiet hours', () => {
    const base = { ...JSON.parse(JSON.stringify(sampleMapping())) };
    const m = applyControls(base, {
      newInvoices: 'confirm',
      refundsAutoUpTo: 0,
      refundsPerDay: 0,
      remindersPerDay: 5,
      quietHours: { enabled: false, start: '20:00', end: '08:00', weekends: true },
      timezone: 'Europe/London',
      collections: { friendly: 5, firm: 3, final: 30 }, // not increasing: keep the old steps
    });
    expect(m.policies.create_invoice).toBe('confirm');
    expect(m.rules.some((r) => r.kind === 'create_refund')).toBe(false);
    expect(m.limits).toEqual([{ kind: 'send_reminder', perDay: 5 }]);
    expect(m.quietHours).toBeUndefined();
    expect(m.collections.steps.map((s) => s.afterDaysOverdue)).toEqual([3, 14, 30]);
  });
});

function sampleMapping(): any {
  return {
    version: 1,
    currency: 'USD',
    entities: {
      customer: { table: 'c', pk: 'id', fields: { name: 'n', email: 'e' } },
      invoice: {
        table: 'i',
        pk: 'id',
        fields: { number: 'n', customer: 'c', status: 's', total: 't' },
        statusMap: { open: ['o'], paid: ['p'], cancelled: ['x'] },
        push: ['o'],
        writeBack: {},
      },
    },
    policies: {},
    rules: [{ kind: 'create_refund', mode: 'auto', maxAmount: 100 }],
    limits: [
      { kind: 'create_refund', amountPerDay: 500 },
      { kind: 'send_reminder', perDay: 40 },
    ],
    collections: {
      steps: [
        { afterDaysOverdue: 3, tone: 'friendly' },
        { afterDaysOverdue: 14, tone: 'firm' },
        { afterDaysOverdue: 30, tone: 'final' },
      ],
      minDaysBetween: 5,
      promiseKeywords: [],
      planKeywords: [],
      promiseGraceDays: 10,
    },
    rationale: {},
    confidence: {},
    generatedBy: 'test',
  };
}
