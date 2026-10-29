import * as p from '@clack/prompts';
import { claudeConfigured, OpsAgent } from '@paypal-retrofit/agents';
import {
  hasErrors,
  loadConfig,
  reconcile,
  Retrofit,
  summary,
  validateMapping,
  WEBHOOK_EVENTS,
  type ResolvedConfig,
} from '@paypal-retrofit/core';
import { createServer } from '@paypal-retrofit/server';
import readline from 'node:readline/promises';
import { c, issuesSummary, planSummary, resultSummary, table } from '../ui.ts';

export function open(configPath?: string) {
  return Retrofit.open(configPath);
}

export async function sync(opts: { config?: string; dryRun?: boolean; yes?: boolean; watch?: boolean }) {
  const rf = open(opts.config);
  try {
    const once = async () => {
      const { plan, skipped } = await rf.plan();
      console.log(c.bold(`\nPlan (${plan.length})`));
      console.log(planSummary(plan));
      if (skipped.length) {
        console.log(c.yellow(`\nSkipped (${skipped.length})`));
        console.log(
          table(skipped.map((s) => ({ target: s.target.label ?? s.target.legacyPk, reason: s.reason }))),
        );
      }
      if (opts.dryRun || plan.length === 0) return;
      if (!opts.yes && process.stdin.isTTY) {
        const ok = await p.confirm({
          message: `Run ${plan.length} action(s)? Actions with policy "confirm" will wait for approval.`,
        });
        if (p.isCancel(ok) || !ok) return;
      }
      const report = await rf.sync({ origin: 'cli' });
      console.log(c.bold('\nResult'));
      console.log(resultSummary(report));
      const pending = report.results.filter((r) => r.action.status === 'pending').length;
      if (pending)
        console.log(
          c.yellow(
            `\n${pending} action(s) need approval: open the dashboard (paypal-retrofit serve) or run "paypal-retrofit actions".`,
          ),
        );
    };
    await once();
    if (opts.watch) {
      console.log(c.dim(`\nWatching every ${rf.config.sync.intervalSeconds}s. Ctrl+C to stop.`));
      setInterval(
        () => void once().catch((e) => console.error(c.red((e as Error).message))),
        rf.config.sync.intervalSeconds * 1000,
      );
      await new Promise(() => {});
    }
  } finally {
    if (!opts.watch) await rf.close();
  }
}

export async function runReconcile(opts: { config?: string }) {
  const rf = open(opts.config);
  try {
    const r = await reconcile(rf);
    console.log(`Checked ${r.checked} linked invoices.`);
    for (const f of r.fixed) console.log(c.green(`  fixed: ${f}`));
    for (const e of r.errors) console.log(c.red(`  error: ${e}`));
    const d = rf.state.listDiscrepancies();
    console.log(c.bold(`\nOpen discrepancies (${d.length})`));
    console.log(
      table(d.map((x) => ({ id: x.id, kind: x.kind, detail: x.detail, suggestion: x.suggestion }))),
    );
  } finally {
    await rf.close();
  }
}

export async function actions(opts: { config?: string; approve?: string; reject?: string; all?: boolean }) {
  const rf = open(opts.config);
  try {
    if (opts.approve) {
      const a = await rf.approve(Number(opts.approve));
      console.log(`Action ${a.id} ${a.status}`, a.result ? JSON.stringify(a.result) : '');
      return;
    }
    if (opts.reject) {
      const a = rf.reject(Number(opts.reject));
      console.log(`Action ${a.id} ${a.status}`);
      return;
    }
    const list = rf.state.listActions(opts.all ? undefined : 'pending', 100);
    console.log(
      table(
        list.map((a) => ({
          id: a.id,
          kind: a.kind,
          target: a.target.label ?? a.target.legacyPk,
          status: a.status,
          origin: a.origin,
          reason: a.reason,
        })),
      ),
    );
  } finally {
    await rf.close();
  }
}

export async function serve(opts: { config?: string; port?: string; watch?: boolean }) {
  const rf = open(opts.config);
  const port = Number(opts.port ?? process.env.PORT ?? 8787);
  const { app } = createServer(rf, { watch: opts.watch !== false, reconcileEverySeconds: 300 });
  app.listen(port, () => {
    console.log(
      `${c.bold('paypal-retrofit')} serving ${c.cyan(`http://localhost:${port}`)}  (${rf.config.env.paypalEnvironment}, ${rf.config.business.name})`,
    );
    console.log(
      c.dim(
        `  webhook endpoint: POST /webhooks/paypal   agents: ${claudeConfigured() ? 'on' : 'off (no ANTHROPIC_API_KEY)'}`,
      ),
    );
  });
}

export async function chat(opts: { config?: string }) {
  const rf = open(opts.config);
  const agent = new OpsAgent(rf);
  if (!agent.available) throw new Error('Set ANTHROPIC_API_KEY to chat with the Ops agent.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    c.dim(
      `Ops agent for ${rf.config.business.name}. Ask about invoices, payments and disputes. Empty line to quit.`,
    ),
  );
  for (;;) {
    const q = (await rl.question(c.bold('\nyou › '))).trim();
    if (!q) break;
    await agent.chat('cli', q, (e) => {
      if (e.type === 'tool_call')
        console.log(c.dim(`  · ${e.name} ${JSON.stringify(e.input ?? {}).slice(0, 100)}`));
      if (e.type === 'action_proposed') {
        const a = e.action as any;
        console.log(
          c.yellow(
            `  ! proposed ${a.kind} for ${a.target.label}: ${a.status}${a.status === 'pending' ? ` (approve with: paypal-retrofit actions --approve ${a.id})` : ''}`,
          ),
        );
      }
      if (e.type === 'done') console.log(`\n${c.cyan('agent ›')} ${e.text}`);
      if (e.type === 'error') console.log(c.red(e.message));
    });
  }
  rl.close();
  await rf.close();
}

export async function registerWebhook(opts: { config?: string; url: string }) {
  const rf = open(opts.config);
  try {
    const existing = (await rf.paypal.listWebhooks()).webhooks?.find((w) => w.url === opts.url);
    const wh = existing ?? (await rf.paypal.createWebhook(opts.url, WEBHOOK_EVENTS));
    rf.state.setMeta('paypal.webhookId', wh.id);
    console.log(
      `${existing ? 'Webhook already registered' : 'Registered webhook'} ${c.bold(wh.id)} -> ${wh.url}`,
    );
    console.log(
      `Add this to your environment (Render dashboard or .env):\n  ${c.cyan(`PAYPAL_WEBHOOK_ID=${wh.id}`)}`,
    );
  } finally {
    await rf.close();
  }
}

export async function status(opts: { config?: string }) {
  const rf = open(opts.config);
  try {
    const s = await summary(rf);
    console.log(table(Object.entries(s).map(([k, v]) => ({ field: k, value: v ?? '—' }))));
  } finally {
    await rf.close();
  }
}

export async function doctor(opts: { config?: string }) {
  const ok = (m: string) => console.log(`${c.green('✔')} ${m}`);
  const bad = (m: string) => console.log(`${c.red('✘')} ${m}`);
  const warn = (m: string) => console.log(`${c.yellow('!')} ${m}`);
  let failures = 0;
  let cfg: ResolvedConfig;
  try {
    cfg = loadConfig(opts.config);
    ok(`Config ${cfg.configPath}`);
  } catch (e) {
    bad((e as Error).message);
    process.exitCode = 1;
    return;
  }
  let rf: Retrofit | undefined;
  try {
    rf = new Retrofit(cfg);
    const schema = await rf.source.introspect();
    ok(`Source ${rf.source.kind} (${schema.tables.length} tables)`);
    const { issues } = validateMapping(rf.mapping, schema);
    if (hasErrors(issues)) {
      failures++;
      bad(`Mapping has errors:\n${issuesSummary(issues)}`);
    } else ok(`Mapping valid${issues.length ? ` (${issues.length} warning(s))` : ''}`);
  } catch (e) {
    failures++;
    bad(`Source/mapping: ${(e as Error).message}`);
  }
  if (rf) {
    const env = cfg.env.paypalEnvironment;
    if (!rf.paypal.configured) {
      failures++;
      bad(`PayPal ${env}: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set`);
    } else {
      try {
        await rf.paypal.accessToken();
        ok(`PayPal ${env}: authenticated against ${rf.paypal.baseUrl}`);
      } catch (e) {
        failures++;
        bad(`PayPal ${env}: ${(e as Error).message}`);
      }
    }
    const webhookId = cfg.env.paypalWebhookId ?? rf.state.getMeta('paypal.webhookId');
    if (webhookId) ok(`Webhook id ${webhookId}`);
    else
      warn(
        'No PAYPAL_WEBHOOK_ID: payments will only be picked up by reconcile. Run "paypal-retrofit webhooks register --url https://<host>/webhooks/paypal".',
      );
    if (claudeConfigured()) ok(`Claude configured (model ${cfg.env.model})`);
    else warn('ANTHROPIC_API_KEY not set: init uses the heuristic mapper and the Ops agent is off.');
    if (cfg.env.autoApprove)
      warn('RETROFIT_AUTO_APPROVE=1: "confirm" policies run without approval (demo only).');
    await rf.close();
  }
  if (failures) process.exitCode = 1;
}
