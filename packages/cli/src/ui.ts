import type {
  MappingIssue,
  PlanItem,
  RetrofitMapping,
  SchemaDescription,
  SyncReport,
} from '@paypal-retrofit/core';
import pc from 'picocolors';

export const c = pc;

export function table(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return c.dim('  (none)');
  const cols = columns ?? Object.keys(rows[0]!);
  const width = (k: string) =>
    Math.min(48, Math.max(k.length, ...rows.map((r) => String(r[k] ?? '').length)));
  const w = Object.fromEntries(cols.map((k) => [k, width(k)]));
  const cell = (k: string, v: unknown) => {
    const s = String(v ?? '');
    return (s.length > w[k]! ? s.slice(0, w[k]! - 1) + '…' : s).padEnd(w[k]!);
  };
  const head = cols.map((k) => c.bold(cell(k, k))).join('  ');
  const body = rows.map((r) => cols.map((k) => cell(k, r[k])).join('  ')).join('\n');
  return `${head}\n${body}`;
}

export function schemaSummary(s: SchemaDescription): string {
  return table(
    s.tables.map((t) => ({
      table: t.name,
      rows: t.rowCount,
      columns: t.columns.length,
      'foreign keys': t.foreignKeys.map((f) => `${f.column}→${f.refTable}`).join(', '),
    })),
  );
}

export function mappingSummary(m: RetrofitMapping): string {
  const rows: Array<Record<string, unknown>> = [];
  const why = (p: string) => m.rationale[p] ?? '';
  const e = m.entities;
  rows.push({
    object: 'Customer',
    from: `${e.customer.table}`,
    detail: `name=${e.customer.fields.name}, email=${e.customer.fields.email}`,
    why: why('customer.table'),
  });
  if (e.product)
    rows.push({
      object: 'Catalog product',
      from: e.product.table,
      detail: `name=${e.product.fields.name}${e.product.fields.price ? `, price=${e.product.fields.price}` : ''}`,
      why: why('product.table'),
    });
  rows.push({
    object: 'Invoice',
    from: e.invoice.table,
    detail: `number=${e.invoice.fields.number}, total=${e.invoice.fields.total}, status=${e.invoice.fields.status}`,
    why: why('invoice.table'),
  });
  if (e.invoice.lines)
    rows.push({
      object: 'Invoice items',
      from: e.invoice.lines.table,
      detail: `via ${e.invoice.lines.fk}; qty=${e.invoice.lines.fields.qty}, price=${e.invoice.lines.fields.unitPrice}`,
      why: why('invoice.lines') || why('invoice.lines.table'),
    });
  rows.push({
    object: 'Status meaning',
    from: e.invoice.fields.status,
    detail: `open=[${e.invoice.statusMap.open}] paid=[${e.invoice.statusMap.paid}] cancelled=[${e.invoice.statusMap.cancelled}]`,
    why: why('invoice.statusMap'),
  });
  rows.push({
    object: 'Send to PayPal',
    from: e.invoice.fields.status,
    detail: `when status in [${e.invoice.push}]`,
    why: why('invoice.push'),
  });
  const wb = Object.entries(e.invoice.writeBack)
    .map(([k, v]) => `${k}→${v}`)
    .join(', ');
  rows.push({
    object: 'Write back',
    from: e.invoice.table,
    detail: wb || 'nothing (links kept in retrofit state)',
    why: why('invoice.writeBack'),
  });
  if (e.subscription)
    rows.push({
      object: 'Subscription',
      from: e.subscription.table,
      detail: `amount=${e.subscription.fields.amount}/${e.subscription.interval.toLowerCase()}, create when [${e.subscription.push}]`,
      why: why('subscription.table'),
    });
  return table(rows, ['object', 'from', 'detail', 'why']);
}

export function issuesSummary(issues: MappingIssue[]): string {
  if (issues.length === 0) return c.green('  no issues');
  return issues
    .map((i) => `  ${i.level === 'error' ? c.red('error') : c.yellow('warn ')} ${c.dim(i.path)} ${i.message}`)
    .join('\n');
}

export function planSummary(plan: PlanItem[]): string {
  return table(
    plan.map((p) => ({
      action: p.kind,
      target: p.target.label ?? p.target.legacyPk,
      policy: p.policy,
      why: p.reason,
    })),
    ['action', 'target', 'policy', 'why'],
  );
}

export function resultSummary(r: SyncReport): string {
  return table(
    r.results.map(({ item, action }) => ({
      action: item.kind,
      target: item.target.label ?? item.target.legacyPk,
      status:
        action.status === 'executed'
          ? c.green('done')
          : action.status === 'pending'
            ? c.yellow('needs approval')
            : action.status === 'failed'
              ? c.red('failed')
              : action.status,
      detail:
        action.status === 'failed'
          ? (action.result as any)?.message
          : ((action.result as any)?.payLink ?? (action.result as any)?.paypalId ?? ''),
    })),
    ['action', 'target', 'status', 'detail'],
  );
}
