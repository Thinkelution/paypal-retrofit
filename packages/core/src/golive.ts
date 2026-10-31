import { publicBaseUrl } from './config.ts';
import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { hasErrors, validateMapping } from './mapping/validate.ts';
import { PAID_STATUSES } from './paypal/client.ts';

/**
 * The go-live checklist: from "connected to the simulator" to "taking real payments", one plain-language
 * step at a time, each checked against what retrofit can see (not just what is configured).
 */

export type CheckStatus = 'done' | 'todo' | 'warn' | 'info';

export interface GoLiveCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** What to do next: a console action, a page, or a command / setting. */
  fix?: { label: string; action?: 'sync' | 'register_webhook' | 'reconcile'; tab?: string; how?: string[] };
}

export interface GoLive {
  environment: string;
  stage: 'simulator' | 'sandbox' | 'live';
  done: number;
  total: number;
  checks: GoLiveCheck[];
}

export async function goLiveChecks(rf: Retrofit, opts: { claude: boolean }): Promise<GoLive> {
  const env = rf.config.env.paypalEnvironment;
  const stage = env === 'MOCK' ? 'simulator' : env === 'SANDBOX' ? 'sandbox' : 'live';
  const checks: GoLiveCheck[] = [];
  const add = (c: GoLiveCheck) => checks.push(c);

  // 1. The business's own data
  try {
    const schema = await rf.source.introspect(0);
    const { issues } = validateMapping(rf.mapping, schema);
    const errors = hasErrors(issues);
    add({
      id: 'data',
      title: 'Your data is connected',
      status: errors ? 'todo' : 'done',
      detail: errors
        ? `The mapping has problems: ${issues
            .filter((i) => i.level === 'error')
            .map((i) => i.message)
            .join('; ')}`
        : `Reading ${schema.tables.length} table${schema.tables.length === 1 ? '' : 's'} from your ${rf.source.kind} source; invoices come from "${rf.mapping.entities.invoice.table}".`,
      fix: errors ? { label: 'Fix the mapping', tab: 'mapping' } : undefined,
    });
  } catch (e) {
    add({ id: 'data', title: 'Your data is connected', status: 'todo', detail: (e as Error).message });
  }

  // 2. PayPal credentials
  if (env === 'MOCK')
    add({
      id: 'paypal',
      title: 'Connect your PayPal account',
      status: 'todo',
      detail:
        'You are using the built-in PayPal simulator: nothing reaches PayPal. Connect a PayPal sandbox app to test with real PayPal pages and emails.',
      fix: {
        label: 'Connect the PayPal sandbox',
        how: [
          'developer.paypal.com → Apps & Credentials → Sandbox → Create App',
          'Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, and PAYPAL_ENVIRONMENT=SANDBOX',
          'Restart retrofit',
        ],
      },
    });
  else {
    let ok = false;
    let why = '';
    try {
      await rf.paypal.accessToken();
      ok = true;
    } catch (e) {
      why = (e as Error).message;
    }
    add({
      id: 'paypal',
      title: env === 'PRODUCTION' ? 'Live PayPal account connected' : 'PayPal sandbox connected',
      status: ok ? 'done' : 'todo',
      detail: ok ? `Signed in to ${rf.paypal.baseUrl}.` : `PayPal refused the credentials: ${why}`,
      fix: ok ? undefined : { label: 'Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET' },
    });
  }

  // 3. Webhooks: registered, and actually arriving
  const webhookId = rf.config.env.paypalWebhookId ?? rf.state.getMeta('paypal.webhookId');
  const events = rf.state.listEvents(200);
  const processed = events.find((e) => e.status === 'processed');
  const base = publicBaseUrl(rf.config);
  add({
    id: 'webhooks',
    title: 'PayPal tells retrofit about payments',
    status: processed ? 'done' : webhookId ? 'warn' : 'todo',
    detail: processed
      ? `Webhook ${webhookId ?? ''} is working: last event ${processed.type} at ${processed.receivedAt.slice(0, 16).replace('T', ' ')} UTC.`
      : webhookId
        ? 'The webhook is registered but no verified event has arrived yet. A test payment (below) will send one.'
        : env !== 'MOCK' && !/^https:/.test(base ?? '')
          ? 'PayPal can only call a public HTTPS address. Until then, payments are picked up by reconciling every few minutes.'
          : 'No webhook is registered with PayPal yet.',
    fix:
      processed || (env !== 'MOCK' && !/^https:/.test(base ?? ''))
        ? !processed
          ? {
              label: 'Set RETROFIT_PUBLIC_URL',
              how: [
                'Deploy retrofit (Render, Docker) or use a tunnel, then set RETROFIT_PUBLIC_URL to its https:// address',
              ],
            }
          : undefined
        : webhookId
          ? undefined
          : { label: 'Register the webhook', action: 'register_webhook' },
  });

  // 4. Invoices in PayPal
  const links = rf.state.listLinks().filter((l) => l.entity === 'invoice');
  add({
    id: 'sync',
    title: 'Your invoices are in PayPal',
    status: links.length ? 'done' : 'todo',
    detail: links.length
      ? `${links.length} invoice${links.length === 1 ? '' : 's'} in PayPal; new ones follow on every sync.`
      : 'Nothing has been sent yet. Sync creates a PayPal invoice for each open invoice that is ready.',
    fix: links.length ? undefined : { label: 'Sync now', action: 'sync' },
  });

  // 5. A payment that went all the way round
  const paid = links.filter((l) => PAID_STATUSES.includes(l.paypalStatus ?? '') && (l.paypalPaid ?? 0) > 0);
  const orders = rf.state.listOrders(50).filter((o) => o.status === 'COMPLETED');
  const sample = links.find((l) => l.payLink && !PAID_STATUSES.includes(l.paypalStatus ?? ''));
  add({
    id: 'payment',
    title: 'A test payment came back',
    status: paid.length || orders.length ? 'done' : 'todo',
    detail:
      paid.length || orders.length
        ? `${paid.length + orders.length} payment${paid.length + orders.length === 1 ? '' : 's'} received through PayPal and recorded.`
        : env === 'MOCK'
          ? "Pay one invoice on the simulator's pay page and watch it arrive here."
          : 'Pay one invoice with a sandbox buyer account (developer.paypal.com → Sandbox → Accounts) and watch it arrive here.',
    fix:
      paid.length || orders.length || !sample?.payLink
        ? undefined
        : { label: 'Open a pay page', how: [sample.payLink] },
  });

  // 6. The payment written back into the business's own system
  const wb = rf.mapping.entities.invoice.writeBack;
  if (!wb.status && !wb.paypalId)
    add({
      id: 'writeback',
      title: 'Payments show in your own system',
      status: 'info',
      detail:
        'Your data has no columns for PayPal ids or payment status, so retrofit keeps them in its own records (and the exports). Add columns such as paypal_invoice_id and paid_at, then map them, to see payments in your old system too.',
      fix: { label: 'Map write-back columns', tab: 'mapping' },
    });
  else {
    const pks = paid.map((l) => l.legacyPk).slice(0, 20);
    const back = pks.length
      ? (await loadInvoices(rf.source, rf.mapping, { pks })).filter((i) => i.state === 'paid')
      : [];
    add({
      id: 'writeback',
      title: 'Payments show in your own system',
      status: back.length ? 'done' : pks.length ? 'warn' : 'todo',
      detail: back.length
        ? `${back.length} paid invoice${back.length === 1 ? '' : 's'} marked paid in your ${rf.source.kind} data automatically.`
        : pks.length
          ? 'PayPal shows payments that are not marked paid in your data yet. Reconcile to repair them.'
          : 'Checked after the first payment.',
      fix: pks.length && !back.length ? { label: 'Reconcile', action: 'reconcile' } : undefined,
    });
  }

  // 7. Owner's rules
  const auto = rf.config.env.autoApprove;
  add({
    id: 'rules',
    title: 'You decide what runs on its own',
    status: auto ? 'warn' : 'done',
    detail: auto
      ? 'RETROFIT_AUTO_APPROVE=1 lets everything run without your OK. Fine for a demo; turn it off before going live.'
      : `Reminders, refunds and plan offers wait for your OK unless a rule says otherwise (${rf.mapping.rules.length} rule${rf.mapping.rules.length === 1 ? '' : 's'}${rf.mapping.quietHours ? `, quiet hours ${rf.mapping.quietHours.start}–${rf.mapping.quietHours.end}` : ''}).`,
    fix: auto ? { label: 'Unset RETROFIT_AUTO_APPROVE' } : undefined,
  });

  // 8. Morning digest
  const channel = rf.config.env.smtpUrl ? 'email' : rf.config.env.slackWebhookUrl ? 'Slack' : null;
  add({
    id: 'digest',
    title: 'Your morning digest arrives',
    status: channel && rf.config.digest.enabled ? 'done' : 'info',
    detail: channel
      ? `Sent by ${channel} at ${rf.config.digest.time}${rf.config.digest.weekdaysOnly ? ' on weekdays' : ''}, with one-click approvals.`
      : 'Set RETROFIT_SMTP_URL (email) or RETROFIT_SLACK_WEBHOOK_URL (Slack) to get the morning summary and approve from your phone.',
    fix: channel ? undefined : { label: 'Preview the digest', tab: 'digest' },
  });

  // 9. Claude
  add({
    id: 'claude',
    title: 'Claude is switched on',
    status: opts.claude ? 'done' : 'info',
    detail: opts.claude
      ? `Mapping, reminders, invoice photos and the Ops agent use ${rf.config.env.model}.`
      : 'Everything works without it, but Claude reads job-sheet photos, writes reminders in your voice and answers questions. Set ANTHROPIC_API_KEY.',
  });

  // 10. Live
  add({
    id: 'live',
    title: 'Take real payments',
    status: env === 'PRODUCTION' ? 'done' : 'todo',
    detail:
      env === 'PRODUCTION'
        ? 'Live: customers pay real money into your PayPal account.'
        : 'When the sandbox steps above are done, switch to your live PayPal app.',
    fix:
      env === 'PRODUCTION'
        ? undefined
        : {
            label: 'Switch to live',
            how: [
              'developer.paypal.com → Apps & Credentials → Live → Create App',
              'Set the live PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET, PAYPAL_ENVIRONMENT=PRODUCTION and RETROFIT_ALLOW_LIVE=1',
              'Restart, then register the webhook again',
            ],
          },
  });

  return {
    environment: env,
    stage,
    done: checks.filter((c) => c.status === 'done').length,
    total: checks.length,
    checks,
  };
}
