import type { SchemaDescription, TableInfo } from '../types.ts';
import { RetrofitMapping } from './schema.ts';

const SPREADSHEETS = ['csv', 'excel', 'gsheet'];

export interface MappingIssue {
  path: string;
  level: 'error' | 'warning';
  message: string;
}

/**
 * Checks a mapping against the real schema. Errors make the mapping unusable; warnings are fixed in place
 * (for example a write-back column that does not exist is dropped, so retrofit keeps that link in its own
 * state store instead).
 */
export function validateMapping(
  input: unknown,
  schema: SchemaDescription,
): { mapping: RetrofitMapping; issues: MappingIssue[] } {
  const parsed = RetrofitMapping.safeParse(input);
  if (!parsed.success) {
    return {
      mapping: input as RetrofitMapping,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        level: 'error',
        message: i.message,
      })),
    };
  }
  const mapping = structuredClone(parsed.data);
  const issues: MappingIssue[] = [];
  const tables = new Map(schema.tables.map((t) => [t.name, t]));

  const table = (p: string, name: string): TableInfo | undefined => {
    const t = tables.get(name);
    if (!t) issues.push({ path: p, level: 'error', message: `Table "${name}" does not exist` });
    return t;
  };
  const column = (p: string, t: TableInfo | undefined, name: string | undefined, required: boolean) => {
    if (!t || name === undefined) return true;
    if (t.columns.some((c) => c.name === name)) return true;
    issues.push({
      path: p,
      level: required ? 'error' : 'warning',
      message: `Column "${t.name}.${name}" does not exist`,
    });
    return false;
  };

  const e = mapping.entities;
  const ct = table('customer.table', e.customer.table);
  column('customer.pk', ct, e.customer.pk, true);
  for (const [k, v] of Object.entries(e.customer.fields)) {
    if (!column(`customer.fields.${k}`, ct, v, k === 'name' || k === 'email'))
      delete (e.customer.fields as any)[k];
  }

  if (e.product) {
    const pt = table('product.table', e.product.table);
    column('product.pk', pt, e.product.pk, true);
    for (const [k, v] of Object.entries(e.product.fields)) {
      if (!column(`product.fields.${k}`, pt, v, k === 'name')) delete (e.product.fields as any)[k];
    }
  }

  const it = table('invoice.table', e.invoice.table);
  column('invoice.pk', it, e.invoice.pk, true);
  for (const [k, v] of Object.entries(e.invoice.fields)) {
    const required = ['number', 'customer', 'status', 'total'].includes(k);
    if (!column(`invoice.fields.${k}`, it, v, required)) delete (e.invoice.fields as any)[k];
  }
  // Spreadsheet sources get missing write-back columns added (in retrofit's copy, never the owner's file).
  if (!SPREADSHEETS.includes(schema.source))
    for (const [k, v] of Object.entries(e.invoice.writeBack)) {
      if (!column(`invoice.writeBack.${k}`, it, v, false)) delete (e.invoice.writeBack as any)[k];
    }
  if (it) {
    const fk = it.foreignKeys.find((f) => f.column === e.invoice.fields.customer);
    if (fk && fk.refTable !== e.customer.table) {
      issues.push({
        path: 'invoice.fields.customer',
        level: 'warning',
        message: `Foreign key points at ${fk.refTable}, not ${e.customer.table}`,
      });
    }
    const statuses = it.enums[e.invoice.fields.status];
    if (statuses) {
      const all = [
        ...e.invoice.statusMap.open,
        ...e.invoice.statusMap.paid,
        ...e.invoice.statusMap.cancelled,
      ];
      const unmapped = statuses.filter((s) => !all.includes(s));
      if (unmapped.length)
        issues.push({
          path: 'invoice.statusMap',
          level: 'warning',
          message: `Status values not mapped: ${unmapped.join(', ')}`,
        });
    }
  }
  const pushNotOpen = e.invoice.push.filter((s) => !e.invoice.statusMap.open.includes(s));
  if (pushNotOpen.length)
    issues.push({
      path: 'invoice.push',
      level: 'error',
      message: `push must only contain open statuses (got ${pushNotOpen.join(', ')})`,
    });

  if (e.invoice.lines) {
    const lt = table('invoice.lines.table', e.invoice.lines.table);
    column('invoice.lines.fk', lt, e.invoice.lines.fk, true);
    for (const [k, v] of Object.entries(e.invoice.lines.fields)) {
      if (!column(`invoice.lines.fields.${k}`, lt, v, k !== 'product'))
        delete (e.invoice.lines.fields as any)[k];
    }
  }

  if (e.subscription) {
    const st = table('subscription.table', e.subscription.table);
    column('subscription.pk', st, e.subscription.pk, true);
    for (const [k, v] of Object.entries(e.subscription.fields)) {
      const required = ['customer', 'amount', 'status'].includes(k);
      if (!column(`subscription.fields.${k}`, st, v, required)) delete (e.subscription.fields as any)[k];
    }
    for (const [k, v] of Object.entries(e.subscription.writeBack)) {
      if (!column(`subscription.writeBack.${k}`, st, v, false)) delete (e.subscription.writeBack as any)[k];
    }
  }

  return { mapping, issues };
}

export function hasErrors(issues: MappingIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
