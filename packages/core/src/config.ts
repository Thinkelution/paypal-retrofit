import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { RetrofitMapping } from './mapping/schema.ts';
import type { PayPalEnvironment } from './types.ts';

export const RetrofitConfig = z.object({
  source: z.string(),
  mapping: z.string().default('./retrofit.map.json'),
  state: z.string().default('./.retrofit/state.db'),
  business: z
    .object({
      name: z.string().default('My business'),
      email: z.string().optional(),
      website: z.string().optional(),
    })
    .default({}),
  paypal: z
    .object({
      environment: z.enum(['SANDBOX', 'PRODUCTION', 'MOCK']).optional(),
      /** Where PayPal sends subscribers after approving a subscription. */
      returnUrl: z.string().optional(),
      /** Prepended to legacy invoice numbers in PayPal, e.g. "FH-". Useful when one sandbox account serves several demos. */
      invoicePrefix: z.string().default(''),
    })
    .default({}),
  webhook: z.object({ publicUrl: z.string().optional() }).default({}),
  sync: z.object({ intervalSeconds: z.number().int().min(10).default(60) }).default({}),
  /** Public base URL of the console, used for links in digests (defaults from webhook.publicUrl). */
  publicUrl: z.string().optional(),
  /** The owner's morning digest. Delivery secrets (SMTP, Slack webhook) live in the environment. */
  digest: z
    .object({
      enabled: z.boolean().default(true),
      /** Local time in the business time zone. */
      time: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .default('08:00'),
      weekdaysOnly: z.boolean().default(true),
      /** Email recipients; needs RETROFIT_SMTP_URL. */
      to: z.array(z.string()).default([]),
    })
    .default({}),
});
export type RetrofitConfig = z.infer<typeof RetrofitConfig>;
export type RetrofitConfigInput = z.input<typeof RetrofitConfig>;

export interface ResolvedConfig extends RetrofitConfig {
  /** Directory that relative paths in the config resolve against. */
  baseDir: string;
  configPath: string;
  env: {
    paypalEnvironment: PayPalEnvironment;
    paypalClientId?: string;
    paypalClientSecret?: string;
    paypalWebhookId?: string;
    paypalMockUrl: string;
    anthropicConfigured: boolean;
    model: string;
    autoApprove: boolean;
    smtpUrl?: string;
    digestFrom?: string;
    slackWebhookUrl?: string;
    publicUrl?: string;
  };
}

export const DEFAULT_CONFIG_FILE = 'retrofit.config.yaml';

export function resolveEnv(cfg?: RetrofitConfig): ResolvedConfig['env'] {
  const e = process.env;
  const env = (
    e.PAYPAL_ENVIRONMENT ??
    cfg?.paypal.environment ??
    'SANDBOX'
  ).toUpperCase() as PayPalEnvironment;
  if (!['SANDBOX', 'PRODUCTION', 'MOCK'].includes(env))
    throw new Error(`PAYPAL_ENVIRONMENT must be SANDBOX, PRODUCTION or MOCK`);
  if (env === 'PRODUCTION' && e.RETROFIT_ALLOW_LIVE !== '1') {
    throw new Error(
      'PRODUCTION is disabled. paypal-retrofit is sandbox-only; set RETROFIT_ALLOW_LIVE=1 to override at your own risk.',
    );
  }
  return {
    paypalEnvironment: env,
    paypalClientId: e.PAYPAL_CLIENT_ID || undefined,
    paypalClientSecret: e.PAYPAL_CLIENT_SECRET || undefined,
    paypalWebhookId: e.PAYPAL_WEBHOOK_ID || undefined,
    paypalMockUrl: e.PAYPAL_MOCK_URL || 'http://localhost:8788',
    anthropicConfigured: Boolean(e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN),
    model: e.RETROFIT_MODEL || 'claude-opus-5-5',
    autoApprove: e.RETROFIT_AUTO_APPROVE === '1',
    smtpUrl: e.RETROFIT_SMTP_URL || undefined,
    digestFrom: e.RETROFIT_DIGEST_FROM || undefined,
    slackWebhookUrl: e.RETROFIT_SLACK_WEBHOOK_URL || undefined,
    publicUrl: e.RETROFIT_PUBLIC_URL || undefined,
  };
}

export function loadConfig(configPath = DEFAULT_CONFIG_FILE): ResolvedConfig {
  const abs = path.resolve(configPath);
  if (!fs.existsSync(abs))
    throw new Error(`No ${path.basename(abs)} found. Run "paypal-retrofit init" first.`);
  const raw = YAML.parse(fs.readFileSync(abs, 'utf8'));
  const cfg = RetrofitConfig.parse(raw);
  return { ...cfg, baseDir: path.dirname(abs), configPath: abs, env: resolveEnv(cfg) };
}

export function writeConfig(file: string, input: RetrofitConfigInput): void {
  const doc = new YAML.Document(RetrofitConfig.parse(input));
  doc.commentBefore =
    ' paypal-retrofit configuration. Secrets (PayPal client secret, Anthropic key) live in .env, never here.';
  fs.writeFileSync(file, doc.toString());
}

export function resolvePath(cfg: ResolvedConfig, p: string): string {
  return path.resolve(cfg.baseDir, p);
}

export function loadMapping(cfg: ResolvedConfig): RetrofitMapping {
  const file = resolvePath(cfg, cfg.mapping);
  if (!fs.existsSync(file)) throw new Error(`Mapping file ${file} not found. Run "paypal-retrofit init".`);
  return RetrofitMapping.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function saveMapping(cfg: ResolvedConfig, mapping: RetrofitMapping): void {
  fs.writeFileSync(resolvePath(cfg, cfg.mapping), JSON.stringify(mapping, null, 2) + '\n');
}

/** Where people reach the console, for links in digests and approval pages. */
export function publicBaseUrl(cfg: ResolvedConfig): string | undefined {
  const u =
    cfg.env.publicUrl ?? cfg.publicUrl ?? cfg.webhook.publicUrl?.replace(/\/webhooks\/paypal\/?$/, '');
  return u?.replace(/\/$/, '');
}
