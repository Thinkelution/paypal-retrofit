import 'dotenv/config';
import { Command } from 'commander';
import { demo } from './commands/demo.ts';
import { init } from './commands/init.ts';
import { actions, chat, doctor, registerWebhook, runReconcile, serve, status, sync } from './commands/run.ts';
import { c } from './ui.ts';

const program = new Command()
  .name('paypal-retrofit')
  .description(
    'Retrofit PayPal into an existing business database with an AI agent, and keep both sides reconciled.',
  )
  .version('0.1.0')
  .option('-c, --config <file>', 'config file', 'retrofit.config.yaml');

const cfg = () => program.opts().config as string;
const run =
  (fn: (...a: any[]) => Promise<unknown>) =>
  async (...a: any[]) => {
    try {
      await fn(...a);
    } catch (e) {
      console.error(c.red(`✘ ${(e as Error).message}`));
      process.exitCode = 1;
    }
  };

program
  .command('init')
  .description(
    'Inspect a database, let Claude map it to PayPal objects, and write retrofit.config.yaml + retrofit.map.json',
  )
  .option('-s, --source <conn>', 'sqlite:<file> | postgres://... | csv:<folder>')
  .option('-o, --out <file>', 'where to write the config', 'retrofit.config.yaml')
  .option('-b, --business <name>', 'business name shown on PayPal invoices')
  .option('--currency <code>', 'currency hint, e.g. USD')
  .option('--no-ai', 'use the deterministic mapper even if Claude is configured')
  .option('-y, --yes', 'accept the proposed mapping without prompting')
  .action(run((o) => init(o)));

program
  .command('sync')
  .description('Push open invoices and pending subscriptions to PayPal and write the links back')
  .option('--dry-run', 'show the plan only')
  .option('-y, --yes', 'do not ask before running')
  .option('-w, --watch', 'keep syncing every sync.intervalSeconds')
  .action(run((o) => sync({ ...o, config: cfg() })));

program
  .command('reconcile')
  .description('Compare every linked record with PayPal, repair missed payments, list discrepancies')
  .action(run(() => runReconcile({ config: cfg() })));

program
  .command('actions')
  .description('List pending actions, or approve/reject one')
  .option('--approve <id>')
  .option('--reject <id>')
  .option('--all', 'include finished actions')
  .action(run((o) => actions({ ...o, config: cfg() })));

program
  .command('serve')
  .description('Webhook receiver + API + dashboard, with background sync and reconciliation')
  .option('-p, --port <port>')
  .option('--no-watch', 'do not sync in the background')
  .action(run((o) => serve({ ...o, config: cfg() })));

program
  .command('chat')
  .description('Talk to the Ops agent in the terminal')
  .action(run(() => chat({ config: cfg() })));

program
  .command('webhooks')
  .description('Manage the PayPal webhook')
  .command('register')
  .requiredOption('--url <url>', 'public HTTPS URL ending in /webhooks/paypal')
  .action(run((o) => registerWebhook({ ...o, config: cfg() })));

program
  .command('status')
  .description('Totals: open, overdue, paid through PayPal, discrepancies')
  .action(run(() => status({ config: cfg() })));
program
  .command('doctor')
  .description('Check config, source, mapping, PayPal credentials, webhook and Claude')
  .action(run(() => doctor({ config: cfg() })));

program
  .command('demo')
  .description('Run the Fernhill Studio demo: legacy app + mock PayPal + dashboard in one process')
  .option('-p, --port <port>')
  .option('--dir <dir>', 'where demo data lives', '.retrofit/demo')
  .option('--public-url <url>', 'public base URL (for links and webhooks)')
  .option('--fresh', 'start from a clean database')
  .option('--sync', 'run a first sync on start')
  .option('--sandbox', 'use the real PayPal sandbox (needs PAYPAL_CLIENT_ID/SECRET) instead of the mock')
  .action(run((o) => demo(o)));

await program.parseAsync();
