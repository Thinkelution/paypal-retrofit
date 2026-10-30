import * as p from '@clack/prompts';
import { claudeConfigured, proposeMapping } from '@paypal-retrofit/agents';
import {
  DEFAULT_CONFIG_FILE,
  hasErrors,
  openSource,
  RetrofitMapping,
  writeConfig,
  type RetrofitConfigInput,
} from '@paypal-retrofit/core';
import fs from 'node:fs';
import path from 'node:path';
import { c, issuesSummary, mappingSummary, schemaSummary } from '../ui.ts';

export interface InitOptions {
  source?: string;
  out?: string;
  yes?: boolean;
  ai?: boolean;
  business?: string;
  currency?: string;
}

export async function init(opts: InitOptions) {
  p.intro(c.bgBlue(c.white(' paypal-retrofit init ')));
  const interactive = !opts.yes && process.stdin.isTTY;
  let source = opts.source;
  if (!source) {
    if (!interactive) throw new Error('--source is required with --yes');
    const v = await p.text({
      message: 'Where is the business data?',
      placeholder: 'sqlite:./app.db  |  postgres://user:pass@host/db  |  csv:./exports',
      validate: (s) => (s ? undefined : 'Required'),
    });
    if (p.isCancel(v)) return p.cancel('Cancelled');
    source = v;
  }

  const s = p.spinner();
  s.start(`Connecting to ${source.replace(/\/\/[^@]*@/, '//***@')}`);
  const adapter = openSource(source);
  const schema = await adapter.introspect();
  await adapter.close();
  s.stop(`Found ${schema.tables.length} tables`);
  p.note(schemaSummary(schema), 'Schema');

  const useClaude = opts.ai !== false && claudeConfigured();
  s.start(
    useClaude
      ? 'Claude is mapping your schema to PayPal objects'
      : 'Mapping your schema (heuristic; set ANTHROPIC_API_KEY to use Claude)',
  );
  const result = await proposeMapping(schema, { useClaude, currencyHint: opts.currency });
  s.stop(
    result.engine === 'claude'
      ? `Mapping proposed by ${result.mapping?.generatedBy}`
      : 'Mapping proposed by the heuristic mapper',
  );
  if (!result.mapping || hasErrors(result.issues)) {
    p.log.error(issuesSummary(result.issues));
    throw new Error(
      'Could not build a usable mapping. Check that the source has customer and invoice tables.',
    );
  }
  p.note(mappingSummary(result.mapping), 'Proposed mapping');
  if (result.issues.length) p.log.warn(`Checks:\n${issuesSummary(result.issues)}`);
  for (const w of result.warnings) p.log.warn(w);

  let business = opts.business;
  if (interactive) {
    const ok = await p.confirm({
      message: 'Use this mapping? (you can edit retrofit.map.json or the dashboard later)',
    });
    if (p.isCancel(ok) || !ok) return p.cancel('Nothing written.');
    if (!business) {
      const b = await p.text({
        message: 'Business name (shown on PayPal invoices)',
        placeholder: 'Fernhill Studio',
        validate: (v) => (v ? undefined : 'Required'),
      });
      if (p.isCancel(b)) return p.cancel('Cancelled');
      business = b;
    }
  }

  const configFile = path.resolve(opts.out ?? DEFAULT_CONFIG_FILE);
  const dir = path.dirname(configFile);
  const mapFile = path.join(dir, 'retrofit.map.json');
  const absSource =
    source.startsWith('sqlite:') || source.startsWith('csv:')
      ? `${source.split(':')[0]}:${path.relative(dir, path.resolve(source.slice(source.indexOf(':') + 1))) || '.'}`
      : source;
  const cfg: RetrofitConfigInput = {
    source: absSource.replace(/\\/g, '/'),
    mapping: './retrofit.map.json',
    state: './.retrofit/state.db',
    business: { name: business ?? 'My business' },
    paypal: { invoicePrefix: '' },
    webhook: {},
    sync: { intervalSeconds: 60 },
  };
  writeConfig(configFile, cfg);
  fs.writeFileSync(mapFile, JSON.stringify(RetrofitMapping.parse(result.mapping), null, 2) + '\n');
  const gi = path.join(dir, '.gitignore');
  if (fs.existsSync(gi) && !fs.readFileSync(gi, 'utf8').includes('.retrofit'))
    fs.appendFileSync(gi, '\n.retrofit/\n');

  p.outro(`Wrote ${c.cyan(path.relative(process.cwd(), configFile) || configFile)} and ${c.cyan(path.relative(process.cwd(), mapFile))}.
  Next:  ${c.bold('paypal-retrofit doctor')}  then  ${c.bold('paypal-retrofit sync --dry-run')}`);
}
