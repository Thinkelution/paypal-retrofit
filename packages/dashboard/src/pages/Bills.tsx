import { useState } from 'react';
import { api, fmtMoney, type Bill, type Config } from '../api';
import { humanize, Pill } from '../cells';
import { useLive } from '../hooks';

const PAYOUT: Record<string, [string, string]> = {
  PENDING: ['Sending', 'info'],
  PROCESSING: ['Sending', 'info'],
  SUCCESS: ['Paid via PayPal', 'ok'],
  UNCLAIMED: ['Not claimed yet', 'warn'],
  ONHOLD: ['Held by PayPal', 'warn'],
};

function status(b: Bill): [string, string] {
  if (b.payout) return PAYOUT[b.payout.status] ?? [humanize(b.payout.status), 'bad'];
  if (b.action?.status === 'pending') return ['Waits for your OK', 'warn'];
  if (b.action?.status === 'failed') return ['Payment failed', 'bad'];
  if (b.state === 'paid') return ['Paid', 'ok'];
  if (b.state === 'cancelled') return [humanize(b.status), ''];
  if (b.daysToDue != null && b.daysToDue < 0) return [`${-b.daysToDue}d overdue`, 'bad'];
  return ['To pay', 'info'];
}

/** Bills from the business's own system, paid to each payee's PayPal email with PayPal Payouts. */
export function Bills({
  config,
  toast,
  onGo,
}: {
  config: Config;
  toast: (m: string) => void;
  onGo: (tab: string) => void;
}) {
  const { data, error, reload } = useLive(() => api.payables());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const cur = config.currency;
  if (error) return <div className="callout">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  if (!data.enabled)
    return (
      <div className="empty">
        <h3>No bills table is mapped</h3>
        <p>
          Retrofit pays suppliers and contractors from a table in your system that has a payee, the payee's
          PayPal email and an amount. Map one and it shows up here.
        </p>
        <button className="btn primary" onClick={() => onGo('mapping')}>
          Open data mapping
        </button>
      </div>
    );

  const payable = (b: Bill) => b.state === 'open' && !b.payout && b.action?.status !== 'pending';
  const chosen = data.bills.filter((b) => picked.has(b.pk) && payable(b));
  const total = chosen.reduce((s, b) => s + b.amount, 0);
  const pay = async () => {
    setBusy(true);
    try {
      const { results } = await api.payBills(chosen.map((b) => b.pk));
      const ran = results.filter((r) => r.action?.status === 'executed').length;
      const waits = results.filter((r) => r.action?.status === 'pending').length;
      const refused = results.filter((r) => r.error);
      toast(
        [
          ran ? `${ran} sent through PayPal` : '',
          waits ? `${waits} waiting for your OK` : '',
          refused.length ? `${refused.length} refused (${refused[0]!.error})` : '',
        ]
          .filter(Boolean)
          .join(', ') + '.',
      );
      setPicked(new Set());
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };

  return (
    <div className="bills-page">
      <section className="kpis" aria-label="Bills">
        <div className="kpi">
          <div className="label">To pay</div>
          <div className="value">{fmtMoney(data.totals?.open, cur)}</div>
          <div className="sub">from {data.table}</div>
        </div>
        <div className="kpi warn">
          <div className="label">Due this week</div>
          <div className="value">{fmtMoney(data.totals?.dueThisWeek, cur)}</div>
        </div>
        <div className={`kpi ${data.totals?.overdue ? 'bad' : ''}`}>
          <div className="label">Overdue</div>
          <div className="value">{fmtMoney(data.totals?.overdue, cur)}</div>
        </div>
        <div className="kpi ok">
          <div className="label">Paid through PayPal</div>
          <div className="value">{fmtMoney(data.totals?.paidThroughPayPal, cur)}</div>
          <div className="sub">marked paid in your system</div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Bills</h2>
          <span className="spacer" />
          <button className="btn primary" disabled={!chosen.length || busy} onClick={pay}>
            {busy
              ? 'Paying…'
              : chosen.length
                ? `Pay ${chosen.length} with PayPal (${fmtMoney(total, cur)})`
                : 'Pick bills to pay'}
          </button>
        </div>
        <div className="table-scroll">
          <table className="plain bills">
            <thead>
              <tr>
                <th aria-label="Pick" />
                <th>Bill</th>
                <th>Payee</th>
                <th className="hide-sm">For</th>
                <th className="num">Amount</th>
                <th>Due</th>
                <th>Status</th>
                <th>Check</th>
              </tr>
            </thead>
            <tbody>
              {data.bills.map((b) => {
                const [label, tone] = status(b);
                return (
                  <tr key={b.pk}>
                    <td>
                      {payable(b) && (
                        <input
                          type="checkbox"
                          aria-label={`Pay ${b.number}`}
                          checked={picked.has(b.pk)}
                          onChange={(e) => {
                            const next = new Set(picked);
                            if (e.target.checked) next.add(b.pk);
                            else next.delete(b.pk);
                            setPicked(next);
                          }}
                        />
                      )}
                    </td>
                    <td className="nowrap">{b.number}</td>
                    <td>
                      {b.payee}
                      <div className="muted small">{b.email}</div>
                    </td>
                    <td className="hide-sm">{b.description}</td>
                    <td className="num">{fmtMoney(b.amount, cur)}</td>
                    <td className="nowrap">{b.due ?? '—'}</td>
                    <td className="nowrap">
                      <Pill tone={tone}>{label}</Pill>
                      {b.payout?.status === 'UNCLAIMED' && (
                        <div className="muted small">PayPal emailed {b.payout.receiver} a claim link</div>
                      )}
                    </td>
                    <td className="small">
                      {b.state !== 'open' ? (
                        <span className="muted">—</span>
                      ) : b.check.hold ? (
                        <Pill tone="warn">{b.check.hold}</Pill>
                      ) : (
                        <span className="muted">Paid before at this email</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="panel-body">
          <p className="muted small">
            Each payment is a PayPal Payouts batch to the payee's PayPal email, for the amount on the bill. A
            first payment to someone, or a PayPal email that changed since the last payment (how
            invoice-redirect fraud works), always waits for you in{' '}
            <button className="linkish" onClick={() => onGo('approvals')}>
              Approvals
            </button>
            . The bill is marked paid in your system only when PayPal confirms the money arrived.
          </p>
        </div>
      </section>
    </div>
  );
}
