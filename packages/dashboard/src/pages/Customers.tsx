import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import { ago, api, fmtMoney, type Config, type CustomerRow, type Terms } from '../api';
import { Pill } from '../cells';
import { useLive } from '../hooks';

const REQUEST_LABEL = {
  promise: 'Promised a date',
  plan: 'Wants a payment plan',
  question: 'Asked a question',
} as const;

/** Customers: balances, statements, portal links, what customers asked for, and the owner's payment terms. */
export function Customers({
  dark,
  config,
  toast,
}: {
  dark: boolean;
  config: Config;
  toast: (m: string) => void;
}) {
  const cur = config.currency;
  const customers = useLive(() => api.customers());
  const requests = useLive(() => api.requests());
  const terms = useLive(() => api.terms());
  const [open, setOpen] = useState<CustomerRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (name: string, fn: () => Promise<string>) => {
    setBusy(name);
    try {
      toast(await fn());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      customers.reload();
      requests.reload();
      terms.reload();
    }
  };
  const nameOf = (pk: string) => customers.data?.find((c) => c.pk === pk)?.name ?? `#${pk}`;
  const withBalance = (customers.data ?? []).filter((c) => c.balance > 0);

  const cols = useMemo<ColDef<CustomerRow>[]>(
    () => [
      { field: 'name', headerName: 'Customer', flex: 1.4, minWidth: 180, pinned: 'left' },
      { field: 'openInvoices', headerName: 'Open', width: 90, type: 'numericColumn' },
      {
        field: 'balance',
        width: 130,
        type: 'numericColumn',
        valueFormatter: (p) => fmtMoney(p.value, cur),
        sort: 'desc',
      },
      {
        field: 'overdue',
        width: 130,
        type: 'numericColumn',
        valueFormatter: (p) => fmtMoney(p.value, cur),
        cellClass: (p) => (p.value > 0 ? 'bad-text' : ''),
      },
      {
        field: 'oldestDaysOverdue',
        headerName: 'Oldest',
        width: 100,
        type: 'numericColumn',
        valueFormatter: (p) => (p.value ? `${p.value}d` : '—'),
      },
      {
        field: 'behaviour',
        headerName: 'How they pay',
        width: 150,
        cellRenderer: (p: any) =>
          p.value ? (
            <Pill tone={/late/.test(p.value) ? 'warn' : /on time/.test(p.value) ? 'ok' : ''}>{p.value}</Pill>
          ) : (
            '—'
          ),
      },
      {
        field: 'openRequests',
        headerName: 'Asked',
        width: 90,
        cellRenderer: (p: any) => (p.value ? <Pill tone="accent">{p.value}</Pill> : ''),
      },
      {
        field: 'lastStatement',
        headerName: 'Last statement',
        width: 140,
        valueFormatter: (p) => (p.value ? ago(p.value) : 'never'),
      },
      {
        headerName: '',
        width: 210,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) => (
          <span className="actions-row">
            <button className="btn sm" onClick={() => setOpen(p.data)}>
              Statement
            </button>
            {p.data.portalUrl && (
              <a className="btn sm" href={p.data.portalUrl} target="_blank" rel="noreferrer">
                Portal ↗
              </a>
            )}
          </span>
        ),
      },
    ],
    [cur],
  );

  const reqs = requests.data ?? [];
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Customers</h2>
        <span className="muted">
          Every customer has a private portal link: they see all their invoices, pay several at once, promise
          a date, ask for a plan or ask a question. Statements carry the link.
        </span>
        <span className="spacer" />
        <button
          className="btn primary sm"
          disabled={!!busy || !withBalance.length}
          onClick={() =>
            act('statements', async () => {
              const r = await api.runStatements();
              const waiting = r.filter((a) => a.status === 'pending').length;
              return `${r.length} statement${r.length === 1 ? '' : 's'} queued${waiting ? `, ${waiting} waiting for approval` : ''}`;
            })
          }
        >
          Send statements ({withBalance.length})
        </button>
      </div>

      <div className="customers-top">
        <section className="requests">
          <h3>Asked in the portal</h3>
          {reqs.length === 0 && (
            <p className="muted">Nothing new. Requests from the portal appear here and in the digest.</p>
          )}
          {reqs.map((r) => (
            <div key={r.id} className="request">
              <div>
                <b>{nameOf(r.customerPk)}</b>{' '}
                <Pill tone={r.kind === 'question' ? 'warn' : 'accent'}>{REQUEST_LABEL[r.kind]}</Pill>
                <div className="muted small">
                  {r.kind === 'promise' && `Will pay by ${r.until}. Reminders are held until then.`}
                  {r.kind === 'plan' &&
                    `Wants ${r.installments ?? 2} instalments. The plan offer is in Approvals.`}
                  {r.kind === 'question' && `“${r.detail}”. Reminders are held until you mark it answered.`} ·{' '}
                  {ago(r.createdAt)}
                </div>
              </div>
              <button
                className="btn sm"
                onClick={() =>
                  act(`req${r.id}`, async () => (await api.resolveRequest(r.id), 'Marked as done'))
                }
              >
                {r.kind === 'question' ? 'Answered' : 'Done'}
              </button>
            </div>
          ))}
        </section>
        <TermsCard
          info={terms.data}
          currency={cur}
          busy={!!busy}
          onSave={(t) => act('terms', async () => (await api.saveTerms(t), 'Payment terms saved'))}
          onRun={() =>
            act('runterms', async () => {
              const r = await api.runTerms();
              return r.length
                ? `${r.length} late fee${r.length === 1 ? '' : 's'} or discount change${r.length === 1 ? '' : 's'} queued`
                : 'Nothing due today';
            })
          }
        />
      </div>

      <div className={`grid-wrap ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
        <AgGridReact<CustomerRow>
          rowHeight={48}
          suppressAnimationFrame
          rowData={customers.data ?? []}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => p.data.pk}
          overlayNoRowsTemplate={'<span class="muted">No customers yet.</span>'}
        />
      </div>
      {open && (
        <StatementDrawer
          customer={open}
          onClose={() => setOpen(null)}
          onSend={() =>
            act('send', async () => {
              const a = await api.sendStatement(open.pk);
              return `Statement for ${open.name}: ${a.status === 'pending' ? 'waiting for approval' : a.status}`;
            })
          }
        />
      )}
    </div>
  );
}

function TermsCard({
  info,
  currency,
  busy,
  onSave,
  onRun,
}: {
  info: import('../api').TermsInfo | null;
  currency: string;
  busy: boolean;
  onSave: (t: Terms) => void;
  onRun: () => void;
}) {
  const [fee, setFee] = useState({
    on: false,
    kind: 'percent' as 'percent' | 'flat',
    amount: 2,
    afterDays: 30,
  });
  const [disc, setDisc] = useState({ on: false, percent: 2, withinDays: 10 });
  useEffect(() => {
    const t = info?.terms;
    if (!t) return;
    setFee((f) => ({ ...f, on: !!t.lateFee, ...(t.lateFee ?? {}) }));
    setDisc((d) => ({ ...d, on: !!t.earlyDiscount, ...(t.earlyDiscount ?? {}) }));
  }, [info?.terms]);
  const fees = info?.applied.filter((a) => a.kind === 'late_fee') ?? [];
  const discounts = info?.applied.filter((a) => a.kind === 'early_discount') ?? [];
  const due = info?.due ?? [];
  return (
    <section className="terms">
      <h3>Payment terms</h3>
      <div className="form-row">
        <label className="field check">
          <input
            type="checkbox"
            checked={fee.on}
            onChange={(e) => setFee({ ...fee, on: e.target.checked })}
          />
          <span>Late fee</span>
        </label>
        <label className="field">
          <span>Amount</span>
          <input
            className="search"
            type="number"
            min={0}
            step="0.5"
            value={fee.amount}
            disabled={!fee.on}
            onChange={(e) => setFee({ ...fee, amount: Number(e.target.value) })}
            style={{ width: 80 }}
          />
        </label>
        <label className="field">
          <span>As</span>
          <select
            className="search"
            value={fee.kind}
            disabled={!fee.on}
            onChange={(e) => setFee({ ...fee, kind: e.target.value as 'percent' | 'flat' })}
          >
            <option value="percent">% of balance</option>
            <option value="flat">{currency} flat</option>
          </select>
        </label>
        <label className="field">
          <span>After (days late)</span>
          <input
            className="search"
            type="number"
            min={0}
            value={fee.afterDays}
            disabled={!fee.on}
            onChange={(e) => setFee({ ...fee, afterDays: Number(e.target.value) })}
            style={{ width: 80 }}
          />
        </label>
      </div>
      <div className="form-row">
        <label className="field check">
          <input
            type="checkbox"
            checked={disc.on}
            onChange={(e) => setDisc({ ...disc, on: e.target.checked })}
          />
          <span>Early-payment discount</span>
        </label>
        <label className="field">
          <span>Percent</span>
          <input
            className="search"
            type="number"
            min={0}
            max={50}
            step="0.5"
            value={disc.percent}
            disabled={!disc.on}
            onChange={(e) => setDisc({ ...disc, percent: Number(e.target.value) })}
            style={{ width: 80 }}
          />
        </label>
        <label className="field">
          <span>If paid within (days)</span>
          <input
            className="search"
            type="number"
            min={1}
            value={disc.withinDays}
            disabled={!disc.on}
            onChange={(e) => setDisc({ ...disc, withinDays: Number(e.target.value) })}
            style={{ width: 80 }}
          />
        </label>
        <span className="spacer" />
        <button
          className="btn sm"
          disabled={busy}
          onClick={() =>
            onSave({
              ...(fee.on
                ? {
                    lateFee: {
                      kind: fee.kind,
                      amount: fee.amount,
                      afterDays: fee.afterDays,
                      label:
                        fee.kind === 'percent' ? `Late payment fee (${fee.amount}%)` : 'Late payment fee',
                    },
                  }
                : {}),
              ...(disc.on ? { earlyDiscount: { percent: disc.percent, withinDays: disc.withinDays } } : {}),
            })
          }
        >
          Save terms
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Fees are added to the PayPal invoice (the customer is told), never for customers on a plan, disputing,
        or who have promised a date. New invoices get the discount while the window is open; it comes off by
        itself afterwards. Currently {fees.length} fee{fees.length === 1 ? '' : 's'} and {discounts.length}{' '}
        discount{discounts.length === 1 ? '' : 's'} in force.
      </p>
      <div className="form-row">
        <span>
          {due.length ? (
            <>
              <b>{due.length}</b> due today:{' '}
              {due
                .slice(0, 3)
                .map(
                  (d) =>
                    `${d.number} (${d.kind === 'late_fee' ? `+${d.amount.toFixed(2)}` : 'discount ends'})`,
                )
                .join(', ')}
              {due.length > 3 ? '…' : ''}
            </>
          ) : (
            <span className="muted">Nothing due today.</span>
          )}
        </span>
        <span className="spacer" />
        <button className="btn primary sm" disabled={busy || !due.length} onClick={onRun}>
          Queue them
        </button>
      </div>
    </section>
  );
}

function StatementDrawer({
  customer,
  onClose,
  onSend,
}: {
  customer: CustomerRow;
  onClose: () => void;
  onSend: () => void;
}) {
  const [data, setData] = useState<{ subject: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api
      .statement(customer.pk)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [customer.pk]);
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer wide" role="dialog" aria-label={`Statement for ${customer.name}`}>
        <header>
          <h3>{customer.name}</h3>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">
          {error && <div className="callout">{error}</div>}
          <div className="actions-row">
            <button className="btn primary sm" onClick={onSend}>
              Send statement
            </button>
            {customer.portalUrl && (
              <>
                <a className="btn sm" href={customer.portalUrl} target="_blank" rel="noreferrer">
                  Open their portal ↗
                </a>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(customer.portalUrl!);
                      setCopied(true);
                    } catch {
                      /* the link is visible in the statement */
                    }
                  }}
                >
                  {copied ? 'Copied' : 'Copy portal link'}
                </button>
              </>
            )}
          </div>
          {data ? (
            <>
              <div className="muted small">Subject: {data.subject}</div>
              <iframe
                className="statement-frame"
                title="Statement preview"
                srcDoc={data.html.replace('<head>', '<head><base target="_blank">')}
                sandbox="allow-popups allow-popups-to-escape-sandbox"
              />
            </>
          ) : (
            !error && <p className="muted">Building the statement…</p>
          )}
        </div>
      </aside>
    </>
  );
}
