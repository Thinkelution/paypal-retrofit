import type { LegacyInvoice } from './entities.ts';
import type { CustomerRule, RetrofitMapping } from './mapping/schema.ts';

/** The owner's rules that cover this invoice's customer (by key, words in the name, or email domain). */
export function rulesFor(
  m: RetrofitMapping,
  inv: Pick<LegacyInvoice, 'customerPk' | 'customer'>,
): CustomerRule[] {
  const name = (inv.customer?.name ?? '').toLowerCase();
  const domain = (inv.customer?.email ?? '').toLowerCase().split('@')[1] ?? '';
  return m.customerRules.filter(
    (r) =>
      r.match.customers?.includes(inv.customerPk) ||
      r.match.nameContains?.some((w) => name.includes(w.toLowerCase())) ||
      r.match.emailDomains?.some((d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`)),
  );
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st... */
export const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
