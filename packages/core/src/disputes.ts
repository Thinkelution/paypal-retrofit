import type { Retrofit } from './engine.ts';
import { loadInvoices } from './entities.ts';
import { textPdf } from './pdf.ts';
import type { DisputeCaseRecord, EvidenceDraft } from './state/store.ts';
import type { ActionOrigin } from './types.ts';
import { round2, toMoney, todayIso } from './util.ts';

/**
 * Dispute evidence autopilot. When a buyer opens a PayPal dispute, retrofit gathers what the business's own
 * records say about the invoice (what was sold, when it was sent, reminded and paid, what the customer wrote),
 * drafts a response (Claude when configured, otherwise from the records alone) and proposes sending it to
 * PayPal with a PDF of those records through the Disputes API. Sending always waits for the owner.
 */

export interface EvidenceFact {
  at: string | null;
  item: string;
  detail: string;
  source: string;
}

export interface EvidencePack {
  disputeId: string;
  status: string;
  stage: string | null;
  reason: string;
  reasonText: string;
  amount: number;
  currency: string;
  openedAt: string | null;
  respondBy: string | null;
  buyerSays: string[];
  invoice: {
    pk: string;
    number: string;
    issued: string | null;
    due: string | null;
    total: number;
    status: string;
    notes: string | null;
    lines: Array<{ description: string; qty: number; unitPrice: number }>;
  } | null;
  customer: { pk: string; name: string; email: string | null; paidBefore: number } | null;
  /** What the records show, oldest first. */
  facts: EvidenceFact[];
  /** The PayPal evidence_type that fits the reason. */
  evidenceType: string;
  /** What PayPal takes now: evidence with a document, a message to the buyer (inquiry stage), or nothing. */
  channel: 'evidence' | 'message' | 'none';
}

export type EvidenceDrafter = (pack: EvidencePack) => Promise<EvidenceDraft>;

/** Seller evidence types retrofit offers. PayPal has many more; these fit invoices for services and goods. */
export const SELLER_EVIDENCE_TYPES = [
  'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED',
  'DETAILS_OF_PURCHASE',
  'COPY_OF_CONTRACT',
  'ITEM_DESCRIPTION',
  'BILLING_AGREEMENT',
  'MERCHANT_RESPONSE',
  'OTHER',
] as const;

const EVIDENCE_FOR_REASON: Record<string, (typeof SELLER_EVIDENCE_TYPES)[number]> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED',
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: 'PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED',
  UNAUTHORISED: 'DETAILS_OF_PURCHASE',
  INCORRECT_AMOUNT: 'DETAILS_OF_PURCHASE',
  DUPLICATE_TRANSACTION: 'DETAILS_OF_PURCHASE',
  PAYMENT_BY_OTHER_MEANS: 'DETAILS_OF_PURCHASE',
  CANCELED_RECURRING_BILLING: 'BILLING_AGREEMENT',
};

const words = (code: string) => code.replace(/_/g, ' ').toLowerCase();

function channelOf(d: any): EvidencePack['channel'] {
  if (d.status === 'RESOLVED') return 'none';
  const links: any[] = Array.isArray(d.links) ? d.links : [];
  const has = (p: string) =>
    links.some((l) => String(l.href ?? '').endsWith(`/${p}`) || l.rel === p.replace(/-/g, '_'));
  if (links.length ? has('provide-evidence') : d.status === 'WAITING_FOR_SELLER_RESPONSE') return 'evidence';
  if (links.length ? has('send-message') : d.dispute_life_cycle_stage === 'INQUIRY') return 'message';
  return 'none';
}

/** Everything the business's records say about the disputed payment. Reads PayPal once; writes nothing. */
export async function disputeEvidencePack(
  rf: Retrofit,
  disputeId: string,
  dispute?: any,
): Promise<EvidencePack> {
  const d = dispute ?? (await rf.paypal.getDispute(disputeId));
  const disc = rf.state.listDiscrepancies(true).find((x) => x.kind === 'dispute' && x.paypalId === disputeId);
  const pk = disc?.legacyPk ?? rf.state.getDisputeCase(disputeId)?.legacyPk ?? null;
  const inv = pk ? await rf.invoice(pk).catch(() => null) : null;
  const cur = rf.mapping.currency;
  const table = `your records (${rf.mapping.entities.invoice.table})`;
  const facts: EvidenceFact[] = [];

  let customer: EvidencePack['customer'] = null;
  if (inv) {
    const lines = inv.lines.map((l) => `${l.qty} × ${l.description} at ${toMoney(l.unitPrice)}`).join('; ');
    facts.push({
      at: inv.issued ?? null,
      item: `Invoice ${inv.number} issued`,
      detail: `${toMoney(inv.total)} ${cur}, due ${inv.due ?? 'on receipt'}${lines ? `: ${lines}` : ''}`,
      source: table,
    });
    if (inv.notes) facts.push({ at: null, item: 'Note on the invoice', detail: inv.notes, source: table });

    const actions = rf.state
      .listActions('executed', 2000)
      .filter(
        (a) =>
          (a.target.entity === 'invoice' && a.target.legacyPk === inv.pk) ||
          (a.target.entity === 'customer' &&
            a.target.legacyPk === inv.customerPk &&
            a.kind === 'send_statement'),
      );
    for (const a of actions) {
      const at = a.decidedAt ?? a.createdAt;
      if (a.kind === 'send_invoice' || (a.kind === 'create_invoice' && (a.result as any)?.sent))
        facts.push({
          at,
          item: 'Sent through PayPal',
          detail: `PayPal emailed the invoice and pay link to the customer`,
          source: 'PayPal',
        });
      else if (a.kind === 'send_reminder')
        facts.push({ at, item: 'Reminder sent', detail: a.reason, source: 'PayPal' });
      else if (a.kind === 'send_statement')
        facts.push({
          at,
          item: 'Statement emailed',
          detail: 'Statement of open invoices with pay links',
          source: 'retrofit',
        });
      else if (a.kind === 'offer_payment_plan')
        facts.push({ at, item: 'Payment plan agreed', detail: a.reason, source: 'retrofit' });
    }
    const link = rf.state.getLink('invoice', inv.pk);
    for (const p of rf.state.listPayments().filter((x) => x.entity === 'invoice' && x.legacyPk === inv.pk))
      facts.push({
        at: p.occurredAt,
        item:
          p.kind === 'payment'
            ? 'Paid through PayPal'
            : p.kind.includes('refund')
              ? 'Refund'
              : 'Payment recorded',
        detail: `${toMoney(p.gross)} ${p.currency}${p.method && p.method !== 'PAYPAL' ? ` by ${words(p.method)}` : ''}, transaction ${p.id}`,
        source: p.method === 'PAYPAL' ? 'PayPal (verified webhook)' : 'your records',
      });
    if (link?.paypalPaidAt && !facts.some((f) => f.item === 'Paid through PayPal'))
      facts.push({
        at: link.paypalPaidAt,
        item: 'Paid through PayPal',
        detail: `${toMoney(link.paypalPaid ?? inv.total)} ${cur}${link.paypalTransactionId ? `, transaction ${link.paypalTransactionId}` : ''}`,
        source: 'PayPal',
      });
    for (const r of rf.state.listRequests({ legacyPk: inv.pk }))
      facts.push({
        at: r.createdAt,
        item:
          r.kind === 'promise'
            ? 'Customer promised to pay'
            : r.kind === 'plan'
              ? 'Customer asked to pay in parts'
              : 'Customer wrote',
        detail: r.detail ?? (r.until ? `by ${r.until}` : ''),
        source: 'customer portal or email',
      });
    for (const m of rf.state.listInbox(500)) {
      if (m.customerPk !== inv.customerPk) continue;
      const named: string[] = m.reading?.invoices ?? [];
      if (named.length && !named.includes(inv.number)) continue;
      facts.push({
        at: m.receivedAt,
        item: `Email from the customer${m.subject ? `: "${m.subject}"` : ''}`,
        detail: m.body.replace(/\s+/g, ' ').trim().slice(0, 400),
        source: 'your inbox',
      });
    }
    const theirs = (await loadInvoices(rf.source, rf.mapping)).filter(
      (i) => i.customerPk === inv.customerPk && i.pk !== inv.pk && i.state === 'paid',
    );
    customer = inv.customer
      ? {
          pk: inv.customerPk,
          name: inv.customer.name,
          email: inv.customer.email || null,
          paidBefore: theirs.length,
        }
      : null;
    if (theirs.length)
      facts.push({
        at: null,
        item: 'Customer history',
        detail: `${theirs.length} earlier invoice${theirs.length === 1 ? '' : 's'} paid, ${toMoney(round2(theirs.reduce((s, i) => s + i.total, 0)))} ${cur} in all`,
        source: table,
      });
  }
  facts.sort((a, b) => (a.at ?? '9999').localeCompare(b.at ?? '9999'));

  const reason = String(d.reason ?? 'OTHER');
  return {
    disputeId,
    status: String(d.status ?? 'OPEN'),
    stage: d.dispute_life_cycle_stage ?? null,
    reason,
    reasonText: words(reason),
    amount: Number(d.dispute_amount?.value ?? 0),
    currency: d.dispute_amount?.currency_code ?? cur,
    openedAt: d.create_time ?? null,
    respondBy: d.seller_response_due_date ?? null,
    buyerSays: (d.messages ?? [])
      .filter((m: any) => m.posted_by === 'BUYER')
      .map((m: any) => String(m.content ?? '')),
    invoice: inv && {
      pk: inv.pk,
      number: inv.number,
      issued: inv.issued ?? null,
      due: inv.due ?? null,
      total: inv.total,
      status: inv.status,
      notes: inv.notes ?? null,
      lines: inv.lines.map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice })),
    },
    customer,
    facts,
    evidenceType: EVIDENCE_FOR_REASON[reason] ?? 'OTHER',
    channel: channelOf(d),
  };
}

/** A response written from the records alone, when Claude is not configured. Claims nothing the records lack. */
export function draftEvidenceFromRecords(pack: EvidencePack, business: string): EvidenceDraft {
  const inv = pack.invoice;
  const at = (f: EvidenceFact) => (f.at ? f.at.slice(0, 10) : '');
  const paid = pack.facts.find((f) => f.item === 'Paid through PayPal');
  const complaint = pack.facts.find(
    (f) =>
      f.item.startsWith('Email from the customer') &&
      /wrong|missing|not happy|never (received|got)|refund|incorrect|charged twice/i.test(f.detail),
  );
  const sent = pack.facts.find((f) => f.item === 'Sent through PayPal');
  const reminders = pack.facts.filter((f) => f.item === 'Reminder sent').length;
  const recommendation: EvidenceDraft['recommendation'] = complaint ? 'offer_partial_refund' : 'contest';

  const points = inv
    ? [
        `We issued invoice ${inv.number} on ${inv.issued ?? 'the agreed date'} for ${toMoney(inv.total)} ${pack.currency}${inv.lines.length ? `, for ${inv.lines.map((l) => `${l.description}${l.qty > 1 ? ` (× ${l.qty})` : ''}`).join(', ')}` : ''}.`,
        sent ? `It was sent through PayPal on ${at(sent)}.` : null,
        paid ? `It was paid through PayPal on ${at(paid)} (${paid.detail}).` : null,
        pack.customer?.paidBefore
          ? `${pack.customer.name} has paid ${pack.customer.paidBefore} earlier invoice${pack.customer.paidBefore === 1 ? '' : 's'} with us.`
          : null,
      ].filter(Boolean)
    : [];
  const response = [
    `Hello, thank you for raising this. Here is what our records show${inv ? ` for invoice ${inv.number}` : ''}:`,
    ...points.map((p) => `- ${p}`),
    complaint
      ? `We know you wrote to us about this on ${at(complaint)}, and we would rather put it right with you directly. Please reply here so we can agree a fair resolution.`
      : `The attached PDF has the invoice, its line items and the full timeline from our records. If something was not as you expected, please tell us here and we will work it out with you.`,
    `${business}`,
  ].join('\n');

  return {
    summary: `The buyer says: ${pack.reasonText}${pack.buyerSays[0] ? ` ("${pack.buyerSays[0].slice(0, 160)}")` : ''}. ${
      inv
        ? `Our records show invoice ${inv.number} for ${toMoney(inv.total)} ${pack.currency}${paid ? `, paid on ${at(paid)}` : ''}.`
        : 'No invoice in our records matches this payment.'
    }`,
    recommendation,
    reasoning: complaint
      ? `The customer raised a problem by email on ${at(complaint)} before disputing; settling directly is usually faster and cheaper than contesting.`
      : inv
        ? `The records show what was invoiced, when it was sent and that it was paid${reminders ? `, plus ${reminders} reminder${reminders === 1 ? '' : 's'}` : ''}. They do not show delivery: add proof of delivery to the response if you have it.`
        : 'There is no matching invoice, so there is nothing from the records to send. Respond in PayPal.',
    response: response.slice(0, 2000),
    evidenceType: pack.evidenceType,
    evidence: [
      { item: 'Invoice with line items', source: 'your records', available: Boolean(inv) },
      { item: 'PayPal payment record', source: 'PayPal', available: Boolean(paid) },
      { item: 'Invoice and reminders sent', source: 'PayPal', available: Boolean(sent) || reminders > 0 },
      {
        item: 'Messages from the customer',
        source: 'your inbox',
        available: pack.facts.some(
          (f) => f.item.startsWith('Email from the customer') || f.item === 'Customer wrote',
        ),
      },
      { item: 'Proof of delivery', source: 'you', available: false },
    ],
    missing: inv
      ? ['Proof the work was delivered (a delivery email, gallery or download link, or a signed sign-off)']
      : ['The invoice or order this payment was for'],
  };
}

/** The document sent with the evidence: the response, the invoice, and the timeline from the records. */
export function evidencePdf(pack: EvidencePack, response: string, business: string): Buffer {
  const day = (s: string | null) => (s ? s.slice(0, 10) : '          ');
  const inv = pack.invoice;
  const lines = [
    `Dispute ${pack.disputeId}: ${pack.reasonText}, ${toMoney(pack.amount)} ${pack.currency}${pack.openedAt ? `, opened ${day(pack.openedAt)}` : ''}.`,
    `Prepared on ${todayIso()} from ${business}'s own records.`,
    '',
    'OUR RESPONSE',
    ...response.split('\n'),
    '',
  ];
  if (inv) {
    lines.push(
      'THE INVOICE',
      `Invoice ${inv.number}, issued ${inv.issued ?? '-'}, due ${inv.due ?? '-'}, status ${inv.status}.`,
      ...(pack.customer ? [`Bill to: ${pack.customer.name}`] : []),
      ...inv.lines.map(
        (l) =>
          `  ${l.qty} × ${l.description} at ${toMoney(l.unitPrice)} = ${toMoney(round2(l.qty * l.unitPrice))}`,
      ),
      `  Total ${toMoney(inv.total)} ${pack.currency}`,
      ...(inv.notes ? [`Note: ${inv.notes}`] : []),
      '',
    );
  }
  if (pack.facts.length)
    lines.push(
      'TIMELINE FROM OUR RECORDS',
      ...pack.facts.map((f) => `${day(f.at)}  ${f.item}: ${f.detail} [${f.source}]`),
      '',
    );
  if (pack.buyerSays.length) lines.push('WHAT THE BUYER WROTE', ...pack.buyerSays.map((m) => `"${m}"`));
  return textPdf(`${business}: response to PayPal dispute ${pack.disputeId}`, lines);
}

/**
 * Drafts the response for a dispute and, when the records support contesting it, proposes sending the
 * evidence. Runs once per dispute unless `redraft` is set. Never throws: problems end up on the case.
 */
export async function prepareDisputeCase(
  rf: Retrofit,
  disputeId: string,
  opts: { drafter?: EvidenceDrafter; origin?: ActionOrigin; redraft?: boolean } = {},
): Promise<DisputeCaseRecord> {
  const prior = rf.state.getDisputeCase(disputeId);
  if (prior && !opts.redraft && prior.status !== 'failed') return prior;
  rf.state.saveDisputeCase({ disputeId, status: 'drafting', error: null });
  try {
    const pack = await disputeEvidencePack(rf, disputeId);
    const business = rf.config.business.name;
    let draft: EvidenceDraft;
    let engine: 'claude' | 'records' = 'records';
    let warning: string | null = null;
    if (opts.drafter) {
      try {
        draft = await opts.drafter(pack);
        engine = 'claude';
      } catch (e) {
        draft = draftEvidenceFromRecords(pack, business);
        warning = `Claude was unavailable (${(e as Error).message}); drafted from your records.`;
      }
    } else draft = draftEvidenceFromRecords(pack, business);
    draft.response = draft.response.slice(0, 2000);
    if (!(SELLER_EVIDENCE_TYPES as readonly string[]).includes(draft.evidenceType))
      draft.evidenceType = pack.evidenceType;
    const c = rf.state.saveDisputeCase({
      disputeId,
      legacyPk: pack.invoice?.pk ?? null,
      status: 'ready',
      draft,
      engine,
      error:
        warning ??
        (pack.invoice ? null : 'No invoice in your records matches this dispute; respond in PayPal.'),
    });
    rf.emit('dispute', { disputeId });
    if (pack.invoice && draft.recommendation === 'contest' && pack.channel !== 'none')
      return await proposeEvidence(rf, disputeId, { origin: opts.origin ?? 'sync', pack });
    const pending = c.actionId ? rf.state.getAction(c.actionId) : undefined;
    if (pending && (pending.status === 'pending' || pending.status === 'scheduled')) {
      rf.reject(
        pending.id,
        `Redrafted: the new draft recommends to ${draft.recommendation.replace(/_/g, ' ')}`,
      );
      return rf.state.saveDisputeCase({ disputeId, actionId: null });
    }
    return c;
  } catch (e) {
    return rf.state.saveDisputeCase({ disputeId, status: 'failed', error: (e as Error).message });
  }
}

/**
 * Proposes sending the case's response to PayPal, optionally edited by the owner first. A pending proposal
 * for the same dispute is replaced.
 */
export async function proposeEvidence(
  rf: Retrofit,
  disputeId: string,
  opts: { origin: ActionOrigin; response?: string; evidenceType?: string; pack?: EvidencePack },
): Promise<DisputeCaseRecord> {
  const c = rf.state.getDisputeCase(disputeId);
  if (!c?.draft) throw new Error(`No draft for dispute ${disputeId} yet`);
  if (!c.legacyPk) throw new Error('No invoice in your records matches this dispute; respond in PayPal.');
  const response = (opts.response ?? c.draft.response).trim().slice(0, 2000);
  if (!response) throw new Error('The response is empty');
  const evidenceType = opts.evidenceType ?? c.draft.evidenceType;
  if (!(SELLER_EVIDENCE_TYPES as readonly string[]).includes(evidenceType))
    throw new Error(`Evidence type must be one of ${SELLER_EVIDENCE_TYPES.join(', ')}`);
  const pack = opts.pack ?? (await disputeEvidencePack(rf, disputeId));
  if (pack.channel === 'none')
    throw new Error(`PayPal is not taking a response on ${disputeId} now (${words(pack.status)})`);
  const previous = c.actionId ? rf.state.getAction(c.actionId) : undefined;
  if (previous && (previous.status === 'pending' || previous.status === 'scheduled'))
    rf.reject(previous.id, 'Replaced by an edited response');
  const a = await rf.propose({
    origin: opts.origin,
    kind: 'submit_dispute_evidence',
    target: { entity: 'invoice', legacyPk: c.legacyPk, label: pack.invoice?.number },
    payload: { disputeId, response, evidenceType, amount: pack.amount },
    reason: `Buyer dispute ${disputeId} (${pack.reasonText}): send PayPal ${
      pack.channel === 'evidence'
        ? 'the response with a PDF of your records'
        : 'the response as a message to the buyer'
    }`,
  });
  return rf.state.saveDisputeCase({
    disputeId,
    draft: { ...c.draft, response, evidenceType },
    status: a.status === 'executed' ? 'submitted' : a.status === 'rejected' ? 'ready' : 'proposed',
    actionId: a.id,
  });
}

/** Runs an approved submit_dispute_evidence action. */
export async function submitDisputeEvidence(rf: Retrofit, payload: Record<string, unknown>) {
  const disputeId = String(payload.disputeId ?? '');
  if (!disputeId) throw new Error('disputeId is required');
  const response = String(payload.response ?? '')
    .trim()
    .slice(0, 2000);
  if (!response) throw new Error('The response is empty');
  const d = await rf.paypal.getDispute(disputeId);
  const pack = await disputeEvidencePack(rf, disputeId, d);
  const evidenceType = String(payload.evidenceType ?? pack.evidenceType);
  let out: {
    disputeId: string;
    via: string;
    evidenceType: string;
    document: { name: string; bytes: number } | null;
  };
  if (pack.channel === 'evidence') {
    const pdf = evidencePdf(pack, response, rf.config.business.name);
    const name = `${disputeId}-evidence.pdf`;
    await rf.paypal.provideDisputeEvidence(disputeId, [{ evidence_type: evidenceType, notes: response }], {
      name,
      type: 'application/pdf',
      data: pdf,
    });
    out = { disputeId, via: 'provide-evidence', evidenceType, document: { name, bytes: pdf.length } };
  } else if (pack.channel === 'message') {
    await rf.paypal.sendDisputeMessage(disputeId, response);
    out = { disputeId, via: 'send-message', evidenceType, document: null };
  } else {
    throw new Error(
      `PayPal is not taking a response on ${disputeId} now (${words(pack.status)}); answer it in PayPal's Resolution Center`,
    );
  }
  if (rf.state.getDisputeCase(disputeId))
    rf.state.saveDisputeCase({ disputeId, status: 'submitted', error: null });
  rf.emit('dispute', { disputeId });
  return out;
}

/** Every dispute PayPal reported, with the case retrofit prepared and where its approval stands. */
export async function listDisputes(rf: Retrofit) {
  const out = [];
  for (const d of rf.state.listDiscrepancies(true).filter((x) => x.kind === 'dispute' && x.paypalId)) {
    const c = rf.state.getDisputeCase(d.paypalId!);
    const a = c?.actionId ? rf.state.getAction(c.actionId) : undefined;
    const inv = d.legacyPk ? await rf.invoice(d.legacyPk).catch(() => null) : null;
    out.push({
      disputeId: d.paypalId!,
      legacyPk: d.legacyPk,
      number: inv?.number ?? null,
      customer: inv?.customer?.name ?? null,
      detail: d.detail,
      openedAt: d.detectedAt,
      resolvedAt: d.resolvedAt,
      resolution: d.resolution,
      case: c,
      action: a ? { id: a.id, status: a.status, policyReason: a.policyReason, result: a.result } : null,
    });
  }
  return out;
}

/** Prepares a case for every new dispute PayPal reports. Returns a function that stops it. */
export function startDisputeAutopilot(rf: Retrofit, drafter?: () => EvidenceDrafter | undefined): () => void {
  return rf.on((e) => {
    const data = e.data as { disputeId?: string; created?: boolean } | undefined;
    if (e.type !== 'dispute' || !data?.created || !data.disputeId) return;
    void prepareDisputeCase(rf, data.disputeId, { drafter: drafter?.(), origin: 'sync' });
  });
}
