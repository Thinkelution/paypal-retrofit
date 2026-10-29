import { openSource, type SourceAdapter } from './adapters/index.ts';
import { loadConfig, loadMapping, resolvePath, type ResolvedConfig } from './config.ts';
import {
  invoiceState,
  linesTotal,
  loadInvoices,
  loadSubscriptions,
  type LegacyInvoice,
  type LegacySubscription,
} from './entities.ts';
import { DEFAULT_POLICIES, type RetrofitMapping } from './mapping/schema.ts';
import {
  CANCELLED_STATUSES,
  OPEN_STATUSES,
  PAID_STATUSES,
  PayPalClient,
  PayPalError,
  payerViewUrl,
  type PayPalInvoice,
} from './paypal/client.ts';
import {
  invoiceDraft,
  planBody,
  productBody,
  subscriptionBody,
  type PayloadContext,
} from './paypal/payloads.ts';
import { StateStore, type LinkRecord } from './state/store.ts';
import type { ActionKind, ActionOrigin, ActionRecord, ActionTarget, PolicyMode, Row } from './types.ts';
import { cents, Logger, toMoney, todayIso } from './util.ts';

export interface PlanItem {
  kind: ActionKind;
  target: ActionTarget;
  reason: string;
  payload: Record<string, unknown>;
  policy: PolicyMode;
}

export interface SyncReport {
  plan: PlanItem[];
  skipped: Array<{ target: ActionTarget; reason: string }>;
  results: Array<{ item: PlanItem; action: ActionRecord }>;
}

export interface ProposeInput {
  origin: ActionOrigin;
  kind: ActionKind;
  target: ActionTarget;
  payload?: Record<string, unknown>;
  reason: string;
}

export interface RetrofitDeps {
  source?: SourceAdapter;
  paypal?: PayPalClient;
  state?: StateStore;
  mapping?: RetrofitMapping;
}

export class Retrofit {
  readonly source: SourceAdapter;
  readonly paypal: PayPalClient;
  readonly state: StateStore;
  mapping: RetrofitMapping;
  readonly log = new Logger('engine');
  private listeners = new Set<(e: { type: string; data?: unknown }) => void>();

  constructor(
    readonly config: ResolvedConfig,
    deps: RetrofitDeps = {},
  ) {
    this.mapping = deps.mapping ?? loadMapping(config);
    this.source = deps.source ?? openSource(config.source, config.baseDir);
    this.state = deps.state ?? new StateStore(resolvePath(config, config.state));
    this.paypal =
      deps.paypal ??
      new PayPalClient({
        environment: config.env.paypalEnvironment,
        clientId: config.env.paypalClientId,
        clientSecret: config.env.paypalClientSecret,
        baseUrl: config.env.paypalEnvironment === 'MOCK' ? config.env.paypalMockUrl : undefined,
      });
  }

  static open(configPath?: string, deps?: RetrofitDeps): Retrofit {
    return new Retrofit(loadConfig(configPath), deps);
  }

  async close() {
    await this.source.close();
    this.state.close();
  }

  /** Subscribe to engine events (used by the dashboard's live updates). */
  on(fn: (e: { type: string; data?: unknown }) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners) fn({ type, data });
  }

  get payloadContext(): PayloadContext {
    return {
      currency: this.mapping.currency,
      businessName: this.config.business.name,
      businessEmail: this.config.business.email,
      website: this.config.business.website,
      invoicePrefix: this.config.paypal.invoicePrefix ?? '',
    };
  }

  policyFor(kind: ActionKind): PolicyMode {
    const p = this.mapping.policies[kind] ?? DEFAULT_POLICIES[kind];
    if (p === 'confirm' && this.config.env.autoApprove) return 'auto';
    return p;
  }

  // ------------------------------------------------------------------ planning

  async plan(): Promise<{ plan: PlanItem[]; skipped: SyncReport['skipped'] }> {
    const im = this.mapping.entities.invoice;
    const plan: PlanItem[] = [];
    const skipped: SyncReport['skipped'] = [];
    const add = (
      kind: ActionKind,
      target: ActionTarget,
      reason: string,
      payload: Record<string, unknown> = {},
    ) => plan.push({ kind, target, reason, payload, policy: this.policyFor(kind) });

    const links = new Map(this.state.listLinks('invoice').map((l) => [l.legacyPk, l]));
    const toPush = await loadInvoices(this.source, this.mapping, { statuses: im.push });
    const linkedPks = [...links.keys()].filter((pk) => !toPush.some((i) => i.pk === pk));
    const linked = linkedPks.length ? await loadInvoices(this.source, this.mapping, { pks: linkedPks }) : [];

    for (const inv of [...toPush, ...linked]) {
      const target: ActionTarget = { entity: 'invoice', legacyPk: inv.pk, label: inv.number };
      const link = links.get(inv.pk);
      const problem = this.invoiceProblem(inv);
      if (!link) {
        if (inv.state !== 'open' || !im.push.includes(inv.status)) continue;
        if (problem) {
          skipped.push({ target, reason: problem });
          this.state.openDiscrepancy({
            entity: 'invoice',
            legacyPk: inv.pk,
            paypalId: null,
            kind: 'invalid_source',
            detail: problem,
            suggestion: 'Fix the record in the legacy system; sync will pick it up.',
          });
          continue;
        }
        add(
          'create_invoice',
          target,
          `${inv.number} is "${inv.status}" in the legacy system and not yet in PayPal`,
        );
        continue;
      }
      target.paypalId = link.paypalId;
      const ppOpen = link.paypalStatus ? OPEN_STATUSES.includes(link.paypalStatus) : true;
      if (inv.state === 'open' && link.paypalStatus === 'DRAFT')
        add('send_invoice', target, `${inv.number} exists in PayPal as a draft`);
      if (inv.state === 'open' && ppOpen && link.sourceHash !== inv.hash && !problem) {
        add('update_invoice', target, `${inv.number} changed in the legacy system since it was synced`);
      }
      if (inv.state === 'cancelled' && ppOpen)
        add(
          'cancel_invoice',
          target,
          `${inv.number} was voided in the legacy system but is still open in PayPal`,
        );
      if (inv.state === 'paid' && ppOpen && !this.paidByPayPal(link)) {
        add(
          'record_payment',
          target,
          `${inv.number} was marked paid in the legacy system (paid outside PayPal)`,
          { amount: inv.total },
        );
      }
    }

    const sm = this.mapping.entities.subscription;
    if (sm) {
      const subLinks = new Map(this.state.listLinks('subscription').map((l) => [l.legacyPk, l]));
      for (const sub of await loadSubscriptions(this.source, this.mapping, { statuses: sm.push })) {
        if (subLinks.has(sub.pk)) continue;
        const target: ActionTarget = { entity: 'subscription', legacyPk: sub.pk, label: sub.title };
        if (!sub.customer?.email) {
          skipped.push({ target, reason: 'customer has no email address' });
          continue;
        }
        add(
          'create_subscription',
          target,
          `"${sub.title}" (${toMoney(sub.amount)} ${this.mapping.currency}/${sm.interval.toLowerCase()}) is ${sub.status} and has no PayPal subscription`,
        );
      }
    }
    return { plan, skipped };
  }

  private paidByPayPal(link: LinkRecord) {
    return link.paypalStatus ? PAID_STATUSES.includes(link.paypalStatus) : false;
  }

  invoiceProblem(inv: LegacyInvoice): string | null {
    if (!inv.customer) return `customer ${inv.customerPk} not found`;
    if (!inv.customer.email || !/@/.test(inv.customer.email))
      return `customer "${inv.customer.name}" has no email address`;
    if (inv.total <= 0) return 'total is zero or negative';
    if (inv.lines.length > 0 && linesTotal(inv) !== cents(inv.total)) {
      return `line items add up to ${(linesTotal(inv) / 100).toFixed(2)} but the invoice total is ${toMoney(inv.total)}`;
    }
    return null;
  }

  async sync(opts: { dryRun?: boolean; origin?: ActionOrigin } = {}): Promise<SyncReport> {
    const { plan, skipped } = await this.plan();
    const results: SyncReport['results'] = [];
    if (opts.dryRun) return { plan, skipped, results };
    for (const item of plan) {
      const action = await this.propose({
        origin: opts.origin ?? 'sync',
        kind: item.kind,
        target: item.target,
        payload: item.payload,
        reason: item.reason,
      });
      results.push({ item, action });
    }
    this.state.setMeta('lastSyncAt', new Date().toISOString());
    this.emit('sync', {
      planned: plan.length,
      executed: results.filter((r) => r.action.status === 'executed').length,
    });
    return { plan, skipped, results };
  }

  // ------------------------------------------------------------------ actions

  /** The only way anything (sync, agents, dashboard) causes a PayPal side effect. */
  async propose(input: ProposeInput): Promise<ActionRecord> {
    const policy = this.policyFor(input.kind);
    if (policy === 'never') {
      const a = this.state.createAction({
        ...input,
        payload: input.payload ?? {},
        policy,
        status: 'rejected',
      });
      this.state.finishAction(a.id, 'rejected', { reason: `Policy for ${input.kind} is "never"` });
      return this.state.getAction(a.id)!;
    }
    const a = this.state.createAction({ ...input, payload: input.payload ?? {}, policy, status: 'pending' });
    this.emit('action', a);
    if (policy === 'auto') return this.execute(a.id);
    return a;
  }

  async approve(id: number): Promise<ActionRecord> {
    const a = this.state.getAction(id);
    if (!a) throw new Error(`Action ${id} not found`);
    if (a.status !== 'pending') throw new Error(`Action ${id} is ${a.status}, not pending`);
    return this.execute(id);
  }

  reject(id: number, reason = 'Rejected by a person'): ActionRecord {
    const a = this.state.getAction(id);
    if (!a) throw new Error(`Action ${id} not found`);
    if (a.status !== 'pending') throw new Error(`Action ${id} is ${a.status}, not pending`);
    this.state.finishAction(id, 'rejected', { reason });
    const out = this.state.getAction(id)!;
    this.emit('action', out);
    return out;
  }

  private async execute(id: number): Promise<ActionRecord> {
    const a = this.state.getAction(id)!;
    try {
      const result = await this.run(a);
      this.state.finishAction(id, result?.skipped ? 'skipped' : 'executed', result);
    } catch (e) {
      const err =
        e instanceof PayPalError
          ? { message: e.message, debugId: e.debugId, status: e.status }
          : { message: (e as Error).message };
      this.log.warn(`action ${a.kind} ${a.target.label ?? a.target.legacyPk} failed: ${err.message}`);
      this.state.finishAction(id, 'failed', err);
    }
    const out = this.state.getAction(id)!;
    this.emit('action', out);
    return out;
  }

  private async run(a: ActionRecord): Promise<any> {
    const pk = a.target.legacyPk;
    switch (a.kind) {
      case 'create_invoice':
        return this.createInvoice(await this.invoice(pk));
      case 'send_invoice':
        return this.sendInvoice(await this.invoice(pk));
      case 'update_invoice':
        return this.updateInvoice(await this.invoice(pk));
      case 'send_reminder': {
        const link = this.requireLink('invoice', pk);
        await this.paypal.remindInvoice(link.paypalId, {
          subject: String(
            a.payload.subject ??
              `Reminder: invoice ${a.target.label ?? ''} from ${this.config.business.name}`,
          ).slice(0, 4000),
          note: a.payload.note ? String(a.payload.note).slice(0, 4000) : undefined,
        });
        return { reminded: link.paypalId };
      }
      case 'cancel_invoice': {
        const link = this.requireLink('invoice', pk);
        await this.paypal.cancelInvoice(link.paypalId, {
          note: a.payload.note ? String(a.payload.note) : 'Cancelled in our records',
        });
        await this.refreshInvoice(link.paypalId);
        return { cancelled: link.paypalId };
      }
      case 'record_payment': {
        const link = this.requireLink('invoice', pk);
        const inv = await this.invoice(pk);
        const amount = Number(a.payload.amount ?? inv.total);
        const r = await this.paypal.recordInvoicePayment(
          link.paypalId,
          {
            method: String(a.payload.method ?? 'OTHER'),
            payment_date: String(a.payload.date ?? todayIso()),
            amount: { currency_code: this.mapping.currency, value: toMoney(amount) },
            note: 'Recorded by paypal-retrofit: paid outside PayPal',
          },
          `retrofit-pay-${pk}-${cents(amount)}`,
        );
        await this.refreshInvoice(link.paypalId);
        return r;
      }
      case 'create_refund': {
        const link = this.requireLink('invoice', pk);
        const inv = await this.paypal.getInvoice(link.paypalId);
        const amount = a.payload.amount !== undefined ? Number(a.payload.amount) : undefined;
        const tx = inv.payments?.transactions?.find(
          (t) => t.type !== 'EXTERNAL' && (t.payment_id || t.transaction_id),
        );
        let r: unknown;
        if (tx) {
          r = await this.paypal.refundCapture(
            String(tx.payment_id ?? tx.transaction_id),
            {
              ...(amount !== undefined
                ? { amount: { currency_code: this.mapping.currency, value: toMoney(amount) } }
                : {}),
              note_to_payer: a.payload.note ? String(a.payload.note).slice(0, 255) : undefined,
            },
            `retrofit-refund-${pk}-${amount ?? 'full'}`,
          );
        } else {
          r = await this.paypal.recordInvoiceRefund(link.paypalId, {
            method: 'OTHER',
            refund_date: todayIso(),
            amount: {
              currency_code: this.mapping.currency,
              value: toMoney(amount ?? Number(inv.payments?.paid_amount?.value ?? 0)),
            },
          });
        }
        await this.refreshInvoice(link.paypalId);
        return r;
      }
      case 'create_subscription':
        return this.createSubscription(await this.subscription(pk));
      case 'cancel_subscription': {
        const link = this.requireLink('subscription', pk);
        await this.paypal.cancelSubscription(
          link.paypalId,
          String(a.payload.reason ?? 'Cancelled by the business'),
        );
        const s = await this.paypal.getSubscription(link.paypalId);
        await this.applySubscriptionStatus(link, s.status);
        return { cancelled: link.paypalId, status: s.status };
      }
      case 'accept_dispute': {
        const disputeId = String(a.payload.disputeId ?? '');
        if (!disputeId) throw new Error('disputeId is required');
        return this.paypal.acceptDisputeClaim(
          disputeId,
          String(a.payload.note ?? 'Accepted by the business'),
        );
      }
    }
  }

  private requireLink(entity: string, pk: string): LinkRecord {
    const l = this.state.getLink(entity, pk);
    if (!l) throw new Error(`${entity} ${pk} is not linked to PayPal yet. Run sync first.`);
    return l;
  }

  async invoice(pk: string): Promise<LegacyInvoice> {
    const [inv] = await loadInvoices(this.source, this.mapping, { pks: [pk] });
    if (!inv) throw new Error(`Invoice ${pk} not found in the legacy system`);
    return inv;
  }

  async subscription(pk: string): Promise<LegacySubscription> {
    const [s] = await loadSubscriptions(this.source, this.mapping, { pks: [pk] });
    if (!s) throw new Error(`Subscription ${pk} not found in the legacy system`);
    return s;
  }

  private async createInvoice(inv: LegacyInvoice) {
    const existing = this.state.getLink('invoice', inv.pk);
    if (existing) return { skipped: true, reason: 'already linked', paypalId: existing.paypalId };
    const problem = this.invoiceProblem(inv);
    if (problem) throw new Error(problem);
    const draft = invoiceDraft(inv, this.payloadContext);
    let created: PayPalInvoice;
    try {
      created = await this.paypal.createInvoice(draft, `retrofit-inv-${inv.pk}-${inv.hash}`);
    } catch (e) {
      const adopted =
        e instanceof PayPalError && JSON.stringify(e.body).includes('DUPLICATE_INVOICE_NUMBER')
          ? await this.adoptExisting(draft.detail.invoice_number)
          : null;
      if (!adopted) throw e;
      created = adopted;
    }
    const link = this.state.upsertLink({
      entity: 'invoice',
      legacyPk: inv.pk,
      paypalId: created.id,
      paypalKind: 'invoice',
      sourceHash: inv.hash,
      ...invoiceCache(created),
    });
    await this.writeBack('invoice', inv.pk, { paypalId: created.id });
    this.log.info(`created PayPal invoice ${created.id} for ${inv.number}`);
    if (created.status === 'DRAFT') {
      const sendPolicy = this.policyFor('send_invoice');
      if (sendPolicy === 'auto') {
        const sent = await this.sendInvoice(inv);
        return { paypalId: created.id, sent: true, payLink: sent.payLink };
      }
      await this.propose({
        origin: 'sync',
        kind: 'send_invoice',
        target: { entity: 'invoice', legacyPk: inv.pk, paypalId: created.id, label: inv.number },
        reason: `Send ${inv.number} to ${inv.customer?.name}`,
      });
    }
    return { paypalId: created.id, sent: false, status: link.paypalStatus };
  }

  private async adoptExisting(invoiceNumber: string): Promise<PayPalInvoice | null> {
    const found = await this.paypal.searchInvoices({ invoice_number: invoiceNumber });
    const match = found.items?.find((i) => i.detail?.invoice_number === invoiceNumber);
    if (!match) return null;
    if (this.state.findLinkByPayPalId(match.id)) return null;
    this.log.info(`adopting existing PayPal invoice ${match.id} for ${invoiceNumber}`);
    return this.paypal.getInvoice(match.id);
  }

  private async sendInvoice(inv: LegacyInvoice) {
    const link = this.requireLink('invoice', inv.pk);
    const current = await this.paypal.getInvoice(link.paypalId);
    if (current.status === 'DRAFT') {
      await this.paypal.sendInvoice(
        link.paypalId,
        { subject: `Invoice ${inv.number} from ${this.config.business.name}` },
        `retrofit-send-${inv.pk}`,
      );
    }
    const after = await this.paypal.getInvoice(link.paypalId);
    const payLink = payerViewUrl(after) ?? null;
    this.state.upsertLink({ ...link, ...invoiceCache(after), payLink });
    await this.writeBack('invoice', inv.pk, { payLink: payLink ?? undefined });
    return { paypalId: link.paypalId, payLink, status: after.status };
  }

  private async updateInvoice(inv: LegacyInvoice) {
    const link = this.requireLink('invoice', inv.pk);
    const current = await this.paypal.getInvoice(link.paypalId);
    if (!OPEN_STATUSES.includes(current.status) || current.payments?.paid_amount) {
      return { skipped: true, reason: `PayPal invoice is ${current.status}; not updating` };
    }
    const draft = invoiceDraft(inv, this.payloadContext);
    const updated = await this.paypal.updateInvoice(link.paypalId, {
      ...current,
      ...draft,
      id: current.id,
      status: current.status,
      detail: { ...current.detail, ...draft.detail },
    });
    this.state.upsertLink({ ...link, sourceHash: inv.hash, ...invoiceCache(updated ?? current) });
    return { updated: link.paypalId };
  }

  private async createSubscription(sub: LegacySubscription) {
    const sm = this.mapping.entities.subscription;
    if (!sm) throw new Error('No subscription mapping');
    if (this.state.getLink('subscription', sub.pk)) return { skipped: true, reason: 'already linked' };
    const ctx = this.payloadContext;
    let productId = this.state.getMeta('paypal.productId');
    if (!productId) {
      productId = (
        await this.paypal.createProduct(productBody(ctx), `retrofit-product-${this.config.business.name}`)
      ).id;
      this.state.setMeta('paypal.productId', productId);
    }
    const plan = await this.paypal.createPlan(
      planBody(sub, productId, sm.interval, ctx),
      `retrofit-plan-${sub.pk}-${sub.hash}`,
    );
    const returnUrl =
      this.config.paypal.returnUrl ?? this.config.business.website ?? 'https://example.com/thanks';
    const created = await this.paypal.createSubscription(
      subscriptionBody(sub, plan.id, { ...ctx, returnUrl }),
      `retrofit-sub-${sub.pk}-${sub.hash}`,
    );
    const approve = created.links?.find((l) => l.rel === 'approve')?.href ?? null;
    this.state.upsertLink({
      entity: 'subscription',
      legacyPk: sub.pk,
      paypalId: created.id,
      paypalKind: 'subscription',
      sourceHash: sub.hash,
      payLink: approve,
      paypalStatus: created.status,
      paypalAmount: sub.amount,
    });
    await this.writeBack('subscription', sub.pk, { paypalId: created.id });
    return { paypalId: created.id, planId: plan.id, approveLink: approve, status: created.status };
  }

  // ------------------------------------------------------------------ write-back + state

  /** Writes only the columns the mapping allows. Missing columns are silently kept in retrofit's state only. */
  async writeBack(
    entity: 'invoice' | 'subscription',
    pk: string,
    values: { paypalId?: string; payLink?: string; status?: string; paidAt?: string; paidAmount?: number },
  ) {
    const em = entity === 'invoice' ? this.mapping.entities.invoice : this.mapping.entities.subscription;
    if (!em) return;
    const wb = em.writeBack as Record<string, string | undefined>;
    const patch: Row = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue;
      const column = wb[k];
      if (column) patch[column] = v;
    }
    if (Object.keys(patch).length === 0) return;
    await this.source.update(em.table, em.pk, pk, patch);
    this.emit('writeback', { entity, pk, patch });
  }

  /** Pulls an invoice from PayPal and applies its state to retrofit and the legacy system. */
  async refreshInvoice(paypalId: string): Promise<{ summary: string } | null> {
    const link = this.state.findLinkByPayPalId(paypalId);
    if (!link) return null;
    const inv = await this.paypal.getInvoice(paypalId);
    return this.applyInvoiceState(link, inv);
  }

  async applyInvoiceState(link: LinkRecord, inv: PayPalInvoice): Promise<{ summary: string }> {
    const cache = invoiceCache(inv);
    this.state.upsertLink({ ...link, ...cache, payLink: payerViewUrl(inv) ?? link.payLink });
    const legacy = await this.invoice(link.legacyPk);
    const sm = this.mapping.entities.invoice.statusMap;
    let summary = `${legacy.number}: PayPal ${inv.status}`;
    if (PAID_STATUSES.includes(inv.status) && legacy.state !== 'paid') {
      await this.writeBack('invoice', legacy.pk, {
        status: sm.paid[0],
        paidAt: cache.paypalPaidAt ?? todayIso(),
        paidAmount: cache.paypalPaid ?? legacy.total,
      });
      this.state.resolveDiscrepanciesFor(
        'invoice',
        legacy.pk,
        ['paid_in_paypal_not_legacy', 'not_in_paypal'],
        'Payment written back',
      );
      summary = `${legacy.number} paid in PayPal (${toMoney(cache.paypalPaid ?? legacy.total)} ${this.mapping.currency}); legacy status set to "${sm.paid[0]}"`;
    } else if (inv.status === 'PARTIALLY_PAID') {
      await this.writeBack('invoice', legacy.pk, { paidAmount: cache.paypalPaid ?? undefined });
      this.state.openDiscrepancy({
        entity: 'invoice',
        legacyPk: legacy.pk,
        paypalId: inv.id,
        kind: 'partial_payment',
        detail: `${legacy.number} is partially paid in PayPal (${toMoney(cache.paypalPaid ?? 0)} of ${toMoney(legacy.total)})`,
        suggestion: 'Decide whether to chase the balance or record the rest as paid.',
      });
      summary = `${legacy.number} partially paid`;
    } else if (CANCELLED_STATUSES.includes(inv.status) && legacy.state === 'open') {
      await this.writeBack('invoice', legacy.pk, { status: sm.cancelled[0] });
      summary = `${legacy.number} cancelled in PayPal; legacy status set to "${sm.cancelled[0]}"`;
    } else if (/REFUNDED/.test(inv.status)) {
      this.state.openDiscrepancy({
        entity: 'invoice',
        legacyPk: legacy.pk,
        paypalId: inv.id,
        kind: 'refunded_in_paypal',
        detail: `${legacy.number} was refunded in PayPal (${inv.status}); the legacy system has no refund status`,
        suggestion: 'Record the refund in your books, then resolve this.',
      });
      summary = `${legacy.number} refunded in PayPal`;
    }
    this.emit('invoice', { pk: legacy.pk, status: inv.status });
    return { summary };
  }

  async applySubscriptionStatus(link: LinkRecord, status: string) {
    this.state.upsertLink({ ...link, paypalStatus: status });
    const sm = this.mapping.entities.subscription;
    if (!sm) return;
    const target =
      status === 'ACTIVE'
        ? sm.statusMap.active[0]
        : ['CANCELLED', 'EXPIRED'].includes(status)
          ? sm.statusMap.cancelled[0]
          : undefined;
    if (target) await this.writeBack('subscription', link.legacyPk, { status: target });
    this.emit('subscription', { pk: link.legacyPk, status });
  }

  invoiceStateOf(status: string) {
    return invoiceState(this.mapping, status);
  }
}

export function invoiceCache(inv: PayPalInvoice) {
  const tx = inv.payments?.transactions?.[inv.payments.transactions.length - 1];
  return {
    paypalStatus: inv.status,
    paypalAmount: inv.amount?.value !== undefined ? Number(inv.amount.value) : null,
    paypalPaid:
      inv.payments?.paid_amount?.value !== undefined ? Number(inv.payments.paid_amount.value) : null,
    paypalPaidAt: tx?.payment_date ?? null,
    paypalTransactionId: tx?.payment_id ?? tx?.transaction_id ?? null,
  };
}
