import { claudeConfigured, proposeMapping } from '@paypal-retrofit/agents';
import {
  hasErrors,
  loadInvoices,
  openSource,
  PayPalClient,
  resolveEnv,
  Retrofit,
  RetrofitConfig,
  RetrofitMapping,
  StateStore,
  validateMapping,
  writeConfig,
  type ActionKind,
  type ResolvedConfig,
  type SchemaDescription,
} from '@paypal-retrofit/core';
import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The no-code setup wizard's API: connect data (CSV upload, sample data, or a SQLite file / Postgres URL
 * when the server allows it), let the Mapper agent propose a mapping, adjust it, choose the owner's rules
 * in plain language, preview what the first sync would do, then write the config and go live.
 */
export interface SetupOptions {
  /** Folder where each setup session gets its own workspace. */
  workspaceRoot: string;
  /** Write the final config here (serve mode). Without it the config goes into the session's workspace. */
  configPath?: string;
  /** Accept SQLite paths and Postgres URLs typed in the browser (local use only, never on a public demo). */
  allowServerPaths: boolean;
  /** Setup can run again after the server is configured (the hosted demo). */
  allowReconfigure: boolean;
  /** Prefix for PayPal invoice numbers of new workspaces (keeps a shared sandbox or mock tidy). */
  invoicePrefix?: () => string;
  isConfigured: () => boolean;
  /** Switch the running server to a new config. */
  activate: (configPath: string) => Promise<Retrofit>;
}

interface Session {
  id: string;
  dir: string;
  configDir: string;
  /** Connection string relative to configDir. */
  source: string;
  label: string;
  schema: SchemaDescription;
  mapping?: RetrofitMapping;
  engine?: 'claude' | 'heuristic';
  createdAt: number;
}

/** Plain-language rules chosen in the wizard; translated into policies, rules, limits and quiet hours. */
export interface SetupControls {
  newInvoices: 'auto' | 'confirm';
  refundsAutoUpTo: number;
  refundsPerDay: number;
  remindersPerDay: number;
  quietHours: { enabled: boolean; start: string; end: string; weekends: boolean };
  timezone: string;
  collections: { friendly: number; firm: number; final: number };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = path.resolve(here, '..', 'samples', 'brightside-plumbing');
const MAX_FILES = 12;
const MAX_BYTES = 5 * 1024 * 1024;

export function applyControls(mapping: RetrofitMapping, c: SetupControls): RetrofitMapping {
  const m = structuredClone(mapping);
  const policies = { ...m.policies } as Record<string, string>;
  for (const k of ['create_invoice', 'send_invoice', 'update_invoice']) policies[k] = c.newInvoices;
  m.policies = policies as RetrofitMapping['policies'];
  const other = (kinds: ActionKind[]) => m.rules.filter((r) => !kinds.includes(r.kind));
  m.rules = [
    ...other(['create_refund']),
    ...(c.refundsAutoUpTo > 0
      ? [
          {
            kind: 'create_refund' as const,
            mode: 'auto' as const,
            maxAmount: c.refundsAutoUpTo,
            note: `Refunds up to ${c.refundsAutoUpTo} run automatically`,
          },
        ]
      : []),
  ];
  m.limits = [
    ...m.limits.filter((l) => l.kind !== 'create_refund' && l.kind !== 'send_reminder'),
    ...(c.refundsPerDay > 0 ? [{ kind: 'create_refund' as const, amountPerDay: c.refundsPerDay }] : []),
    ...(c.remindersPerDay > 0 ? [{ kind: 'send_reminder' as const, perDay: c.remindersPerDay }] : []),
  ];
  m.quietHours = c.quietHours.enabled
    ? {
        start: c.quietHours.start,
        end: c.quietHours.end,
        weekends: c.quietHours.weekends,
        timezone: c.timezone,
        kinds: ['send_reminder', 'offer_payment_plan'],
      }
    : undefined;
  const days = [c.collections.friendly, c.collections.firm, c.collections.final];
  if (days.every((d, i) => Number.isFinite(d) && d >= 0 && (i === 0 || d > days[i - 1]!)))
    m.collections.steps = [
      { afterDaysOverdue: days[0]!, tone: 'friendly' },
      { afterDaysOverdue: days[1]!, tone: 'firm' },
      { afterDaysOverdue: days[2]!, tone: 'final' },
    ];
  return m;
}

function schemaView(s: SchemaDescription) {
  return {
    source: s.source,
    tables: s.tables.map((t) => ({
      name: t.name,
      rows: t.rowCount,
      columns: t.columns.map((c) => c.name),
      enums: t.enums,
    })),
  };
}

const safeName = (n: string) =>
  path
    .basename(String(n))
    .replace(/\.csv$/i, '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 60) || 'table';

export function setupRouter(opts: SetupOptions) {
  const r = express.Router();
  r.use(express.json({ limit: '8mb' }));
  const sessions = new Map<string, Session>();
  const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
    fn(req, res).catch((e) => res.status(400).json({ error: (e as Error).message }));
  const canSetup = () => !opts.isConfigured() || opts.allowReconfigure;
  const guard = (_req: Request, res: Response, next: express.NextFunction) =>
    canSetup()
      ? next()
      : res
          .status(403)
          .json({ error: 'This server is already set up. Edit the mapping in the console instead.' });
  const session = (req: Request) => {
    const s = sessions.get(String(req.params.id));
    if (!s) throw new Error('Setup session not found; start again.');
    return s;
  };

  r.get('/status', (_req, res) => {
    const env = resolveEnv();
    res.json({
      configured: opts.isConfigured(),
      canSetup: canSetup(),
      allowServerPaths: opts.allowServerPaths,
      environment: env.paypalEnvironment,
      paypalCredentials:
        env.paypalEnvironment === 'MOCK' || Boolean(env.paypalClientId && env.paypalClientSecret),
      claude: claudeConfigured(),
      model: env.model,
      smtp: Boolean(env.smtpUrl),
      slack: Boolean(env.slackWebhookUrl),
      samples: fs.existsSync(SAMPLES_DIR)
        ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.csv'))
        : [],
    });
  });

  r.get('/samples/:file', (req, res) => {
    const f = path.basename(String(req.params.file));
    const p = path.join(SAMPLES_DIR, f);
    if (!f.endsWith('.csv') || !fs.existsSync(p)) return res.status(404).end();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${f}"`);
    res.send(fs.readFileSync(p));
  });

  r.post(
    '/sources',
    guard,
    wrap(async (req, res) => {
      const body = req.body ?? {};
      const id = crypto.randomBytes(5).toString('hex');
      const dir = path.join(opts.workspaceRoot, id);
      const configDir = opts.configPath ? path.dirname(path.resolve(opts.configPath)) : dir;
      const rel = (p: string) => path.relative(configDir, p).replace(/\\/g, '/') || '.';
      let source: string;
      let label: string;
      if (body.kind === 'csv' || body.kind === 'sample') {
        const data = path.join(dir, 'data');
        if (body.kind === 'sample') {
          fs.mkdirSync(data, { recursive: true });
          for (const f of fs.readdirSync(SAMPLES_DIR).filter((x) => x.endsWith('.csv')))
            fs.copyFileSync(path.join(SAMPLES_DIR, f), path.join(data, f));
          label = 'Brightside Plumbing sample (CSV)';
        } else {
          const files = (Array.isArray(body.files) ? body.files : []) as Array<{
            name: string;
            content: string;
          }>;
          if (!files.length) throw new Error('Add at least one CSV file.');
          if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files.`);
          const bytes = files.reduce((s, f) => s + String(f.content ?? '').length, 0);
          if (bytes > MAX_BYTES) throw new Error('The files are larger than 5 MB together.');
          fs.mkdirSync(data, { recursive: true });
          for (const f of files)
            fs.writeFileSync(path.join(data, `${safeName(f.name)}.csv`), String(f.content ?? ''));
          label = `${files.length} CSV file${files.length === 1 ? '' : 's'}`;
        }
        source = `csv:${rel(data)}`;
      } else if (body.kind === 'sqlite' || body.kind === 'postgres') {
        if (!opts.allowServerPaths)
          throw new Error(
            'This server only accepts CSV uploads. Run paypal-retrofit locally to connect a database.',
          );
        if (body.kind === 'sqlite') {
          const file = path.resolve(String(body.path ?? ''));
          if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
          source = `sqlite:${rel(file)}`;
          label = path.basename(file);
        } else {
          const url = String(body.url ?? '');
          if (!/^postgres(ql)?:\/\//.test(url)) throw new Error('A Postgres URL starts with postgres://');
          source = url;
          label = url.replace(/\/\/[^@]*@/, '//***@');
        }
      } else throw new Error('Choose CSV files, the sample data, a SQLite file or a Postgres URL.');

      let schema: SchemaDescription;
      try {
        const adapter = openSource(source, configDir);
        try {
          schema = await adapter.introspect();
        } finally {
          await adapter.close();
        }
        if (!schema.tables.length) throw new Error('No tables found.');
      } catch (e) {
        // Leave no half-made workspace behind.
        fs.rmSync(dir, { recursive: true, force: true });
        throw e;
      }
      sessions.set(id, { id, dir, configDir, source, label, schema, createdAt: Date.now() });
      // Keep memory bounded on a shared demo.
      for (const [k] of [...sessions.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt).slice(20))
        sessions.delete(k);
      res.json({ id, label, schema: schemaView(schema) });
    }),
  );

  r.post(
    '/sources/:id/map',
    guard,
    wrap(async (req, res) => {
      const s = session(req);
      const result = await proposeMapping(s.schema, {
        useClaude: req.body?.ai !== false,
        currencyHint: req.body?.currency || undefined,
        timezone: req.body?.timezone || 'UTC',
      });
      if (!result.mapping || hasErrors(result.issues))
        return res.status(422).json({
          error:
            'Could not find a customer table with emails and an invoice table. Check the files and try again.',
          issues: result.issues,
          warnings: result.warnings,
        });
      s.mapping = result.mapping;
      s.engine = result.engine;
      res.json({
        mapping: s.mapping,
        issues: result.issues,
        warnings: result.warnings,
        engine: result.engine,
      });
    }),
  );

  r.get('/sources/:id/mapping', (req, res) => {
    const s = sessions.get(String(req.params.id));
    if (!s?.mapping) return res.status(404).json({ error: 'No mapping yet' });
    res.json({ mapping: s.mapping, schema: s.schema });
  });

  r.put(
    '/sources/:id/mapping',
    guard,
    wrap(async (req, res) => {
      const s = session(req);
      const { mapping, issues } = validateMapping(req.body, s.schema);
      if (hasErrors(issues)) return res.status(422).json({ issues });
      s.mapping = mapping;
      res.json({ mapping, issues });
    }),
  );

  const tempRetrofit = (s: Session, mapping: RetrofitMapping) => {
    const cfg: ResolvedConfig = {
      ...RetrofitConfig.parse({ source: s.source }),
      baseDir: s.configDir,
      configPath: '',
      env: resolveEnv(),
    };
    return new Retrofit(cfg, {
      mapping,
      state: new StateStore(':memory:'),
      paypal: new PayPalClient({ environment: 'MOCK', baseUrl: 'http://127.0.0.1:9' }),
    });
  };

  r.post(
    '/sources/:id/preview',
    guard,
    wrap(async (req, res) => {
      const s = session(req);
      if (!s.mapping) throw new Error('Map the data first.');
      const mapping = req.body?.controls ? applyControls(s.mapping, req.body.controls) : s.mapping;
      const rf = tempRetrofit(s, mapping);
      try {
        const { plan, skipped } = await rf.plan();
        const invoices = await loadInvoices(rf.source, mapping);
        const byKind: Record<string, number> = {};
        for (const p of plan) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
        const open = invoices.filter((i) => i.state === 'open');
        const toSend = new Set(
          plan.filter((p) => p.target.entity === 'invoice').map((p) => p.target.legacyPk),
        );
        // Open invoices whose status is never sent to PayPal (drafts) are left alone too.
        const notSent = [
          ...skipped.map((x) => ({ label: x.target.label ?? x.target.legacyPk, reason: x.reason })),
          ...open
            .filter((i) => !toSend.has(i.pk) && !mapping.entities.invoice.push.includes(i.status))
            .map((i) => ({ label: i.number, reason: `status "${i.status}" is not sent to PayPal` })),
        ];
        res.json({
          byKind,
          items: plan.slice(0, 40).map((p) => ({
            kind: p.kind,
            label: p.target.label ?? p.target.legacyPk,
            reason: p.reason,
            policy: p.policy,
          })),
          skipped: notSent.slice(0, 30),
          skippedTotal: notSent.length,
          invoices: {
            total: invoices.length,
            open: open.length,
            openAmount: Math.round(open.reduce((t, i) => t + i.total, 0) * 100) / 100,
            toSend: toSend.size,
            toSendAmount:
              Math.round(open.filter((i) => toSend.has(i.pk)).reduce((t, i) => t + i.total, 0) * 100) / 100,
            sample: open.slice(0, 6).map((i) => ({
              number: i.number,
              customer: i.customer?.name ?? '',
              email: i.customer?.email ? i.customer.email.replace(/^(.).*(@.*)$/, '$1***$2') : '',
              total: i.total,
              due: i.due ?? null,
              status: i.status,
              lines: i.lines.length,
            })),
          },
          currency: mapping.currency,
        });
      } finally {
        await rf.close();
      }
    }),
  );

  r.post(
    '/sources/:id/finish',
    guard,
    wrap(async (req, res) => {
      const s = session(req);
      if (!s.mapping) throw new Error('Map the data first.');
      const b = req.body ?? {};
      const name = String(b.business?.name ?? '').trim();
      if (!name) throw new Error('Add the business name customers will see on invoices.');
      const mapping = RetrofitMapping.parse(
        b.controls ? applyControls(s.mapping, b.controls as SetupControls) : s.mapping,
      );
      const configPath = opts.configPath
        ? path.resolve(opts.configPath)
        : path.join(s.dir, 'retrofit.config.yaml');
      const to = (Array.isArray(b.digest?.to) ? b.digest.to : String(b.digest?.to ?? '').split(','))
        .map((x: string) => String(x).trim())
        .filter((x: string) => /.+@.+\..+/.test(x));
      const cfg = RetrofitConfig.parse({
        source: s.source,
        mapping: './retrofit.map.json',
        state: opts.configPath ? './.retrofit/state.db' : './state.db',
        business: {
          name,
          ...(b.business?.email ? { email: String(b.business.email) } : {}),
          ...(b.business?.website ? { website: String(b.business.website) } : {}),
        },
        paypal: { invoicePrefix: opts.invoicePrefix?.() ?? '' },
        webhook: b.publicUrl
          ? { publicUrl: `${String(b.publicUrl).replace(/\/$/, '')}/webhooks/paypal` }
          : {},
        digest: {
          enabled: b.digest?.enabled !== false,
          time: /^\d{2}:\d{2}$/.test(String(b.digest?.time)) ? String(b.digest.time) : '08:00',
          to,
        },
      });
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      writeConfig(configPath, cfg);
      fs.writeFileSync(
        path.join(path.dirname(configPath), 'retrofit.map.json'),
        JSON.stringify(mapping, null, 2) + '\n',
      );
      const rf = await opts.activate(configPath);
      let synced: { executed: number; pending: number } | null = null;
      if (b.syncNow) {
        const report = await rf.sync({ origin: 'dashboard' });
        synced = {
          executed: report.results.filter((x) => x.action.status === 'executed').length,
          pending: report.results.filter((x) => x.action.status === 'pending').length,
        };
      }
      sessions.delete(s.id);
      res.json({ ok: true, configPath: path.relative(process.cwd(), configPath), synced });
    }),
  );

  return r;
}
