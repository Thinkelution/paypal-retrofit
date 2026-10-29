import { useEffect, useState } from 'react';
import { api, DISCREPANCY_LABEL, fmtMoney, type Config, type Discrepancy, type LedgerRow } from '../api';
import { humanize, Pill } from '../cells';

export function RecordDrawer(props: {
  row: LedgerRow;
  config: Config;
  onClose: () => void;
  toast: (m: string) => void;
  onAsk: (q: string) => void;
  onChanged: () => void;
}) {
  const { row, config, onClose, toast, onAsk, onChanged } = props;
  const [discrepancies, setDiscrepancies] = useState<Discrepancy[]>([]);
  const cur = config.currency;
  useEffect(() => {
    api
      .discrepancies(true)
      .then((d) => setDiscrepancies(d.filter((x) => x.entity === row.entity && x.legacyPk === row.legacyPk)));
  }, [row]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const propose = async (kind: string, payload: Record<string, unknown> = {}, reason?: string) => {
    try {
      const [a] = await api.propose({
        kind,
        entity: row.entity,
        legacyPks: [row.legacyPk],
        payload,
        reason: reason ?? `Requested from the dashboard for ${row.number}`,
      });
      toast(
        a
          ? `${humanize(kind)}: ${a.status === 'pending' ? 'waiting for approval' : a.status}${a.status === 'failed' ? ` (${a.result?.message})` : ''}`
          : 'Nothing to do',
      );
      onChanged();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const open = row.legacyState === 'open';
  const linked = !!row.paypalId;
  const ppOpen = ['SENT', 'UNPAID', 'PARTIALLY_PAID', 'SCHEDULED'].includes(row.paypalStatus ?? '');
  const paidPP = ['PAID'].includes(row.paypalStatus ?? '');

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${row.number} details`}>
        <header>
          <h3>{row.number}</h3>
          <Pill tone={row.inSync ? 'ok' : 'warn'}>{row.inSync ? 'In sync' : 'Needs attention'}</Pill>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">
          <div className="compare">
            <section>
              <h4>Your system</h4>
              <dl className="kv">
                <dt>Customer</dt>
                <dd>{row.customer}</dd>
                <dt>Email</dt>
                <dd>{row.customerEmail}</dd>
                <dt>Amount</dt>
                <dd className="num">
                  {fmtMoney(row.legacyTotal, cur)}
                  {row.entity === 'subscription' ? ' / period' : ''}
                </dd>
                <dt>Status</dt>
                <dd>{row.legacyStatus}</dd>
                {row.issued && (
                  <>
                    <dt>{row.entity === 'subscription' ? 'Started' : 'Issued'}</dt>
                    <dd>{row.issued}</dd>
                  </>
                )}
                {row.due && (
                  <>
                    <dt>Due</dt>
                    <dd>
                      {row.due}
                      {row.daysOverdue ? ` (${row.daysOverdue} days overdue)` : ''}
                    </dd>
                  </>
                )}
              </dl>
            </section>
            <section>
              <h4>PayPal</h4>
              {linked ? (
                <dl className="kv">
                  <dt>Status</dt>
                  <dd>{humanize(row.paypalStatus ?? '')}</dd>
                  <dt>Id</dt>
                  <dd className="mono">{row.paypalId}</dd>
                  {row.paypalAmount != null && (
                    <>
                      <dt>Amount</dt>
                      <dd className="num">{fmtMoney(row.paypalAmount, cur)}</dd>
                    </>
                  )}
                  {row.paypalPaid != null && (
                    <>
                      <dt>Received</dt>
                      <dd className="num">{fmtMoney(row.paypalPaid, cur)}</dd>
                    </>
                  )}
                  {row.paypalPaidAt && (
                    <>
                      <dt>Paid on</dt>
                      <dd>{row.paypalPaidAt.slice(0, 10)}</dd>
                    </>
                  )}
                  {row.paypalTransactionId && (
                    <>
                      <dt>Transaction</dt>
                      <dd className="mono">{row.paypalTransactionId}</dd>
                    </>
                  )}
                  {row.payLink && (
                    <>
                      <dt>{row.entity === 'subscription' ? 'Approve link' : 'Pay link'}</dt>
                      <dd>
                        <a href={row.payLink} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      </dd>
                    </>
                  )}
                </dl>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  {open
                    ? 'Not in PayPal yet. Run Sync to send it.'
                    : 'Not sent to PayPal (not an open invoice).'}
                </p>
              )}
            </section>
          </div>

          {discrepancies
            .filter((d) => !d.resolvedAt)
            .map((d) => (
              <div key={d.id} className="callout">
                <b>{DISCREPANCY_LABEL[d.kind] ?? humanize(d.kind)}.</b> {d.detail}
                {d.suggestion && (
                  <div className="muted" style={{ marginTop: 4 }}>
                    {d.suggestion}
                  </div>
                )}
              </div>
            ))}

          <div className="actions-row">
            {row.entity === 'invoice' && linked && ppOpen && (
              <button
                className="btn"
                onClick={() => propose('send_reminder', {}, `Reminder for ${row.number}`)}
              >
                Send reminder
              </button>
            )}
            {row.entity === 'invoice' && linked && ppOpen && (
              <button
                className="btn"
                onClick={() =>
                  propose(
                    'record_payment',
                    { amount: row.legacyTotal, method: 'BANK_TRANSFER' },
                    `${row.number} was paid outside PayPal`,
                  )
                }
              >
                Record payment received
              </button>
            )}
            {row.entity === 'invoice' && linked && ppOpen && (
              <button
                className="btn danger"
                onClick={() => propose('cancel_invoice', {}, `Cancel ${row.number}`)}
              >
                Cancel in PayPal
              </button>
            )}
            {row.entity === 'invoice' && paidPP && (
              <button
                className="btn danger"
                onClick={() => propose('create_refund', {}, `Refund ${row.number}`)}
              >
                Refund…
              </button>
            )}
            {row.entity === 'subscription' && !linked && (
              <button
                className="btn"
                onClick={() =>
                  propose('create_subscription', {}, `Create PayPal subscription for ${row.number}`)
                }
              >
                Create PayPal subscription
              </button>
            )}
            {row.entity === 'subscription' && linked && row.paypalStatus === 'ACTIVE' && (
              <button
                className="btn danger"
                onClick={() => propose('cancel_subscription', { reason: 'Cancelled by the business' })}
              >
                Cancel subscription
              </button>
            )}
            {row.payLink && config.demo?.mockPath && (ppOpen || row.paypalStatus === 'APPROVAL_PENDING') && (
              <a className="btn primary" href={row.payLink} target="_blank" rel="noreferrer">
                {row.entity === 'subscription' ? 'Approve as customer' : 'Pay as customer'} ↗
              </a>
            )}
            {config.demo?.mockPath && paidPP && (
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await api.demoDispute(row.legacyPk);
                    toast('A buyer dispute was opened in the mock');
                    onChanged();
                  } catch (e) {
                    toast((e as Error).message);
                  }
                }}
              >
                Simulate buyer dispute
              </button>
            )}
            {config.agentAvailable && (
              <button
                className="btn"
                onClick={() =>
                  onAsk(
                    `Tell me about ${row.number}: what is its status in both systems and is anything wrong?`,
                  )
                }
              >
                Ask the agent
              </button>
            )}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            Actions go through your policies (
            {Object.entries(config.policies).filter(([, v]) => v === 'confirm').length} need approval).{' '}
            {config.autoApprove ? 'Demo auto-approve is on.' : ''}
          </p>
        </div>
      </aside>
    </>
  );
}
