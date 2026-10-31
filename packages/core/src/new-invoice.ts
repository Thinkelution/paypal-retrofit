import { loadCatalog } from './commerce.ts';
import type { Retrofit } from './engine.ts';
import type { ActionRecord, ColumnInfo, Row, TableInfo } from './types.ts';
import { addDaysIso, daysBetween, round2, todayIso } from './util.ts';

/**
 * New invoices written straight into the business's own system (its database, spreadsheet or exports),
 * from a sentence, a photo of a paper job sheet (read by Claude in the agents package) or a form. The
 * next sync turns them into PayPal invoices, exactly as if the owner had typed them into the old app.
 */

export interface DraftLine {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface InvoiceDraft {
  customer: { key?: string; name: string; email?: string };
  lines: DraftLine[];
  /** YYYY-MM-DD; the business's usual terms when missing. */
  due?: string;
  notes?: string;
  /** What the owner should check before sending (unreadable amounts, a missing email...). */
  questions: string[];
  engine: 'claude' | 'rules' | 'manual';
}

export interface IntakeContext {
  business: string;
  currency: string;
  today: string;
  /** Days between invoice date and due date the business usually gives. */
  usualTermsDays: number;
  customers: Array<{ key: string; name: string; email: string }>;
  products: Array<{ name: string; price: number }>;
}

export async function intakeContext(rf: Retrofit, today = todayIso()): Promise<IntakeContext> {
  const cm = rf.mapping.entities.customer;
  const im = rf.mapping.entities.invoice;
  const seen = new Set<string>();
  const customers: IntakeContext['customers'] = [];
  for (const r of await rf.source.readTable(cm.table)) {
    const key = String(r[cm.pk] ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    customers.push({
      key,
      name: String(r[cm.fields.name] ?? '').trim(),
      email: String(r[cm.fields.email] ?? '').trim(),
    });
  }
  // The business's usual payment terms, from its own invoices.
  let usualTermsDays = 14;
  if (im.fields.issued && im.fields.due) {
    const counts = new Map<number, number>();
    for (const r of await rf.source.readTable(im.table)) {
      const a = String(r[im.fields.issued] ?? '').slice(0, 10);
      const b = String(r[im.fields.due] ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) continue;
      const d = daysBetween(a, b);
      if (d > 0 && d <= 120) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const best = [...counts].sort((x, y) => y[1] - x[1])[0];
    if (best) usualTermsDays = best[0];
  }
  return {
    business: rf.config.business.name,
    currency: rf.mapping.currency,
    today,
    usualTermsDays,
    customers,
    products: (await loadCatalog(rf)).map((p) => ({ name: p.name, price: p.price })),
  };
}

// ---------------------------------------------------------------- reading a sentence without Claude

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONEY = String.raw`\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;

/**
 * A rule-based reading of sentences such as "Invoice Harbor View Apartments $420 for replacing the water
 * heater valve, due in 14 days" or "Bill Maya Okafor 2 hours at $85 for retouching". Used when Claude is not
 * configured; Claude handles everything else, including photos.
 */
export function parseInvoiceText(text: string, ctx: IntakeContext): InvoiceDraft {
  const questions: string[] = [];
  let rest = ` ${text.replace(/\s+/g, ' ').trim()} `;

  // Due date first, so its numbers are not read as prices.
  let due: string | undefined;
  const dueRe =
    /,?\s*(?:due|payable|pay(?:ment)? by)\s+(?:in\s+(\d+)\s*(day|week|month)s?|on\s+(\d{4}-\d{2}-\d{2})|(\d{4}-\d{2}-\d{2})|(?:on\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)|(tomorrow|today))|,?\s*\bnet\s*(\d+)\b/i;
  const dm = rest.match(dueRe);
  if (dm) {
    if (dm[1])
      due = addDaysIso(
        ctx.today,
        Number(dm[1]) * ({ day: 1, week: 7, month: 30 } as any)[dm[2]!.toLowerCase()],
      );
    else if (dm[3] || dm[4]) due = dm[3] ?? dm[4];
    else if (dm[5]) {
      const want = WEEKDAYS.indexOf(dm[5].toLowerCase());
      const now = new Date(`${ctx.today}T12:00:00Z`).getUTCDay();
      due = addDaysIso(ctx.today, (want - now + 7) % 7 || 7);
    } else if (dm[6]) due = dm[6].toLowerCase() === 'tomorrow' ? addDaysIso(ctx.today, 1) : ctx.today;
    else if (dm[7]) due = addDaysIso(ctx.today, Number(dm[7]));
    rest = rest.replace(dm[0], ' ');
  }

  // The customer: an email in the text, else the longest known customer name it mentions.
  const email = rest.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0];
  if (email) rest = rest.replace(email, ' ');
  const lower = rest.toLowerCase();
  let customer: InvoiceDraft['customer'] | undefined;
  const byEmail = email && ctx.customers.find((c) => c.email.toLowerCase() === email.toLowerCase());
  if (byEmail) customer = { key: byEmail.key, name: byEmail.name, email: byEmail.email };
  else {
    const named = ctx.customers
      .filter((c) => c.name && lower.includes(c.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (named) customer = { key: named.key, name: named.name, email: named.email };
  }
  if (customer) rest = rest.replace(new RegExp(escapeRe(customer.name), 'i'), ' ');
  else {
    // "Invoice <Name> $420 for ..." / "Bill <Name>: ..."
    const m = rest.match(
      /^\s*(?:please\s+)?(?:invoice|bill|charge)\s+(?:to\s+)?([A-Za-z][^:,$]*?)(?=\s*[:,]|\s+\$|\s+\d|\s+for\b|\s*$)/i,
    );
    // ...or "<Name>: drain cleaning 145, ..."
    const lead = m ? undefined : rest.match(/^\s*([A-Za-z][^:,$\d]{1,60}?)\s*:/);
    const name = (m ?? lead)?.[1]?.trim() || (email ? email.split('@')[0]! : '');
    if (m ?? lead) rest = rest.replace((m ?? lead)![0], ' ');
    customer = { name, email };
    if (!name) questions.push('Who is this invoice for?');
  }
  if (email && !customer.email) customer.email = email;
  if (!customer.email)
    questions.push(
      `What is ${customer.name || 'the customer'}'s email address? PayPal sends the invoice there.`,
    );

  // Lines: each comma-separated part with a price, "2 hours at $85", or a catalogue item.
  rest = rest.replace(/^\s*(?:please\s+)?(?:invoice|bill|charge)\b\s*:?/i, ' ');
  const lines: DraftLine[] = [];
  for (const raw of rest.split(/[,;\n]|\s+\band\b\s+(?=[^,]*\d)/i)) {
    const part = raw.replace(/^[\s:–-]+|[\s:.–-]+$/g, '');
    if (!part) continue;
    const rate = part.match(
      new RegExp(
        String.raw`(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|days?|units?|items?|sessions?|pcs?|x)?\s*(?:at|@|x)\s*${MONEY}`,
        'i',
      ),
    );
    if (rate) {
      const qty = Number(rate[1]);
      const unitPrice = money(rate[3]!, rate[4]);
      const desc = cleanDescription(part.replace(rate[0], ' ')) || unitLabel(rate[2]) || 'Work';
      lines.push({ description: desc, qty, unitPrice });
      continue;
    }
    const amount = [
      ...part.matchAll(new RegExp(String.raw`(?:^|\s)${MONEY}(?:\s*(?:dollars|usd|eur|gbp))?(?=\s|$)`, 'gi')),
    ].pop();
    if (amount) {
      const desc = cleanDescription(part.replace(amount[0], ' '));
      lines.push({ description: desc || 'Work done', qty: 1, unitPrice: money(amount[1]!, amount[2]) });
      continue;
    }
    const product = ctx.products
      .filter((p) => part.toLowerCase().includes(p.name.toLowerCase()))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (product) {
      lines.push({ description: product.name, qty: 1, unitPrice: product.price });
      continue;
    }
    // "for replacing the valve" after the price belongs to the line before it.
    const last = lines[lines.length - 1];
    const desc = cleanDescription(part);
    if (last && desc && /^(work done|work)$/i.test(last.description)) last.description = desc;
  }
  if (!lines.length) questions.push('What should this invoice charge? Add a line with a price.');
  return { customer, lines, due, notes: undefined, questions, engine: 'rules' };
}

function money(whole: string, cents?: string) {
  return Number(`${whole.replace(/,/g, '')}.${(cents ?? '0').padEnd(2, '0')}`);
}

function unitLabel(u?: string) {
  if (!u) return '';
  if (/^h/i.test(u)) return 'Labour';
  if (/^session/i.test(u)) return 'Session';
  return '';
}

function cleanDescription(s: string) {
  const d = s
    .replace(/\s+/g, ' ')
    .replace(/^[\s:–-]+|[\s:.–-]+$/g, '')
    .replace(/^(?:for|of|to)\s+/i, '')
    .trim();
  return d ? d[0]!.toUpperCase() + d.slice(1) : '';
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------- writing into the legacy system

/** The next key or number after the existing ones: 41 -> 42, INV-1042 -> INV-1043, BP-0099 -> BP-0100. */
export function nextKey(values: unknown[]): string | number {
  const vs = values.filter((v) => v !== null && v !== undefined && v !== '').map(String);
  if (!vs.length) return 1;
  if (vs.every((v) => /^\d+$/.test(v))) return Math.max(...vs.map(Number)) + 1;
  let best: { prefix: string; n: number; width: number; suffix: string } | null = null;
  for (const v of vs) {
    const m = v.match(/^(.*?)(\d+)(\D*)$/);
    if (m && (!best || Number(m[2]) > best.n))
      best = { prefix: m[1]!, n: Number(m[2]), width: m[2]!.length, suffix: m[3]! };
  }
  if (!best) return `${vs[vs.length - 1]}-2`;
  return `${best.prefix}${String(best.n + 1).padStart(best.width, '0')}${best.suffix}`;
}

/** A value for a required column retrofit does not map (created dates, flags, counters). */
function filler(c: ColumnInfo, today: string): unknown {
  if (/(_at|time|stamp)$/i.test(c.name) || /timestamp|datetime/i.test(c.type))
    return new Date().toISOString();
  if (/(date|_on|created|updated|day)$/i.test(c.name) || /date/i.test(c.type)) return today;
  if (/int|real|num|dec|float|double|money|bool/i.test(c.type)) return 0;
  return '';
}

function complete(table: TableInfo | undefined, row: Row, today: string, pkColumn: string) {
  for (const c of table?.columns ?? []) {
    if (c.name in row || c.nullable || c.hasDefault || c.name === pkColumn) continue;
    row[c.name] = filler(c, today);
  }
  return row;
}

export interface AddInvoiceInput {
  customer: { key?: string; name: string; email?: string };
  lines: DraftLine[];
  due?: string;
  notes?: string;
  /** Mark it ready to send, so the next sync sends it through PayPal (default true). */
  send?: boolean;
}

export interface AddInvoiceResult {
  legacyPk: string;
  number: string;
  customerKey: string;
  newCustomer: boolean;
  total: number;
  status: string;
  due: string;
  actions: ActionRecord[];
  paypal?: { id: string; link?: string; status?: string };
}

/**
 * Writes the invoice (and the customer, when new) into the business's own system with its own numbering
 * and statuses, then syncs it to PayPal.
 */
export async function addInvoice(
  rf: Retrofit,
  input: AddInvoiceInput,
  opts: { today?: string; sync?: boolean } = {},
): Promise<AddInvoiceResult> {
  const today = opts.today ?? todayIso();
  const m = rf.mapping;
  const cm = m.entities.customer;
  const im = m.entities.invoice;
  const lines = input.lines
    .map((l) => ({
      description: String(l.description ?? '').trim() || 'Work done',
      qty: Number(l.qty) || 1,
      unitPrice: round2(Number(l.unitPrice) || 0),
    }))
    .filter((l) => l.unitPrice !== 0);
  if (!lines.length) throw new Error('Add at least one line with a price.');
  const total = round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  if (total <= 0) throw new Error('The invoice total must be more than zero.');
  const name = input.customer.name.trim();
  const email = input.customer.email?.trim();

  const schema = await rf.source.introspect(0);
  const tableInfo = (t: string) => schema.tables.find((x) => x.name === t);
  const keyFor = async (table: string, pkColumn: string) => {
    const col = tableInfo(table)?.columns.find((c) => c.name === pkColumn);
    if (col?.hasDefault) return undefined; // the database numbers it
    return nextKey((await rf.source.readTable(table)).map((r) => r[pkColumn]));
  };
  const ctx = await intakeContext(rf, today);

  // ---- customer
  const inline = cm.table === im.table; // one sheet: the invoice row carries the customer
  let customerKey = input.customer.key;
  let known = customerKey ? ctx.customers.find((c) => c.key === customerKey) : undefined;
  known ??= email ? ctx.customers.find((c) => c.email.toLowerCase() === email.toLowerCase()) : undefined;
  known ??= name ? ctx.customers.find((c) => c.name.toLowerCase() === name.toLowerCase()) : undefined;
  let newCustomer = false;
  if (known) customerKey = known.key;
  else {
    if (!name) throw new Error('Who is this invoice for?');
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new Error(`Add ${name}'s email address: PayPal sends the invoice there.`);
    newCustomer = true;
    if (inline) customerKey = email;
    else {
      const row: Row = { [cm.fields.name]: name, [cm.fields.email]: email };
      const key = await keyFor(cm.table, cm.pk);
      if (key !== undefined) row[cm.pk] = key;
      const stored = await rf.source.insert(
        cm.table,
        cm.pk,
        complete(tableInfo(cm.table), row, today, cm.pk),
      );
      customerKey = String(stored[cm.pk]);
    }
  }

  // ---- invoice, in the business's own numbering and statuses
  const sendStatus =
    im.push.find((s) => /sent|bill|issu|open|unpaid|invoic|due/i.test(s) && !/overdue|past|late/i.test(s)) ??
    im.push[0]!;
  const draftStatus = im.statusMap.open.find((s) => !im.push.includes(s));
  const status = input.send === false && draftStatus ? draftStatus : sendStatus;
  const due =
    input.due && /^\d{4}-\d{2}-\d{2}$/.test(input.due) ? input.due : addDaysIso(today, ctx.usualTermsDays);
  const existing = await rf.source.readTable(im.table);
  const row: Row = {
    [im.fields.customer]: customerKey,
    [im.fields.status]: status,
    [im.fields.total]: total,
  };
  if (im.fields.issued) row[im.fields.issued] = today;
  if (im.fields.due) row[im.fields.due] = due;
  if (im.fields.notes && input.notes) row[im.fields.notes] = input.notes;
  if (inline) {
    row[cm.fields.name] = known?.name ?? name;
    row[cm.fields.email] = known?.email ?? email;
  }
  const pk = await keyFor(im.table, im.pk);
  if (pk !== undefined) row[im.pk] = pk;
  if (im.fields.number !== im.pk) row[im.fields.number] = nextKey(existing.map((r) => r[im.fields.number]));
  // Without a line-item table the description goes in the notes.
  if (!im.lines && im.fields.notes && !input.notes)
    row[im.fields.notes] = lines
      .map((l) => (l.qty === 1 ? l.description : `${l.qty} × ${l.description}`))
      .join('; ');
  const stored = await rf.source.insert(im.table, im.pk, complete(tableInfo(im.table), row, today, im.pk));
  const legacyPk = String(stored[im.pk]);

  if (im.lines) {
    const lm = im.lines;
    const lt = tableInfo(lm.table);
    const lpk = lt?.columns.find((c) => c.pk)?.name;
    for (const l of lines) {
      const lr: Row = {
        [lm.fk]: stored[im.pk],
        [lm.fields.description]: l.description,
        [lm.fields.qty]: l.qty,
        [lm.fields.unitPrice]: l.unitPrice,
      };
      if (lpk) {
        const k = await keyFor(lm.table, lpk);
        if (k !== undefined) lr[lpk] = k;
      }
      await rf.source.insert(lm.table, lpk ?? lm.fk, complete(lt, lr, today, lpk ?? ''));
    }
  }

  let actions: ActionRecord[] = [];
  if (opts.sync !== false && status === sendStatus) {
    const report = await rf.sync({ origin: 'dashboard' });
    actions = report.results
      .filter((r) => r.item.target.entity === 'invoice' && r.item.target.legacyPk === legacyPk)
      .map((r) => r.action);
  }
  rf.emit('change', { kind: 'invoice_added', legacyPk });
  const link = rf.state.getLink('invoice', legacyPk);
  return {
    legacyPk,
    number: String(stored[im.fields.number] ?? legacyPk),
    customerKey: String(customerKey),
    newCustomer,
    total,
    status,
    due,
    actions,
    paypal: link
      ? { id: link.paypalId, link: link.payLink ?? undefined, status: link.paypalStatus ?? undefined }
      : undefined,
  };
}
