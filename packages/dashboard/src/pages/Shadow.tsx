import { useState } from 'react';
import { api, fmtMoney, type Config } from '../api';
import { Pill } from '../cells';
import { useLive } from '../hooks';

const RUNS: Record<string, string> = { 'on its own': 'ok', 'waits for you': 'warn', held: '' };

/** What retrofit's current rules would have done with the last N days of invoices, without touching anything. */
export function Shadow({ config, onGo }: { config: Config; onGo: (tab: string) => void }) {
  const [days, setDays] = useState(90);
  const [after, setAfter] = useState(7);
  const { data, error } = useLive(() => api.shadow(days, after), [days, after]);
  const cur = config.currency;
  if (error) return <div className="callout">{error}</div>;
  if (!data) return <div className="empty">Replaying your invoices…</div>;
  const max = Math.max(1, ...data.weeks.map((w) => w.reminders));

  return (
    <div className="shadow-page">
      <section className="panel">
        <div className="panel-head">
          <h2>Shadow mode</h2>
          <span className="muted small">
            {data.window.from} to {data.window.to}. Nothing was sent; nothing in your system or PayPal
            changed.
          </span>
          <span className="spacer" />
          <div className="segmented" role="group" aria-label="Days">
            {[30, 60, 90, 180].map((d) => (
              <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
        </div>
        <div className="panel-body">
          <section className="kpis" aria-label="What would have happened">
            <div className="kpi">
              <div className="label">Invoices in play</div>
              <div className="value">{data.invoices}</div>
              <div className="sub">{data.sent} sent with a PayPal pay link</div>
            </div>
            <div className="kpi">
              <div className="label">Reminders</div>
              <div className="value">{data.reminders.total}</div>
              <div className="sub">
                {data.reminders.onTheirOwn} on their own · {data.reminders.needYou} for you
                {data.reminders.heldByRules ? ` · ${data.reminders.heldByRules} held by your rules` : ''}
              </div>
            </div>
            <div className="kpi">
              <div className="label">Late fees</div>
              <div className="value">{data.lateFees.count}</div>
              <div className="sub">{fmtMoney(data.lateFees.amount, cur)} under your terms</div>
            </div>
            <div className="kpi ok">
              <div className="label">Paid sooner (estimate)</div>
              <div className="value">{fmtMoney(data.estimate.amountSooner, cur)}</div>
              <div className="sub">
                {data.estimate.avgDaysSooner} days sooner on average, {data.estimate.overdueInvoices} overdue
                invoices
              </div>
            </div>
          </section>
          <div className="callout info">
            {data.assumption}{' '}
            <label className="inline">
              Assume a reminder gets paid within{' '}
              <select
                value={after}
                onChange={(e) => setAfter(Number(e.target.value))}
                aria-label="Days after a reminder"
              >
                {[3, 7, 14].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            {data.estimate.paidDateUnknown > 0 && (
              <span className="muted">
                {' '}
                {data.estimate.paidDateUnknown} paid invoices have no paid date, so they are left out.
              </span>
            )}
          </div>
          <div className="actions-row">
            <button className="btn sm" onClick={() => onGo('rules')}>
              Change the rules and replay
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Week by week</h2>
        </div>
        <div className="table-scroll">
          <table className="plain">
            <thead>
              <tr>
                <th>Week of</th>
                <th className="num">Sent</th>
                <th>Reminders</th>
                <th className="num">Late fees</th>
              </tr>
            </thead>
            <tbody>
              {data.weeks.map((w) => (
                <tr key={w.week}>
                  <td>{w.week}</td>
                  <td className="num">{w.sent}</td>
                  <td>
                    <span className="bar-cell">
                      <span className="bar" style={{ width: `${(100 * w.reminders) / max}%` }} />
                      <span className="num">{w.reminders}</span>
                    </span>
                  </td>
                  <td className="num">{w.lateFees}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Where it would have made the most difference</h2>
        </div>
        <ul className="shadow-examples">
          {data.examples.map((x) => (
            <li key={x.number}>
              <div className="ex-head">
                <b>
                  {x.number} · {x.customer}
                </b>
                <span className="num">{fmtMoney(x.amount, cur)}</span>
                <span className="spacer" />
                <span className="muted small">
                  due {x.due} · paid {x.actualPaid ?? 'not yet'}
                  {x.daysSooner > 0 && x.estimatedPaid
                    ? ` · estimate ${x.estimatedPaid} (${x.daysSooner} days sooner)`
                    : ''}
                </span>
              </div>
              <ol className="ex-steps">
                {x.steps.map((s, i) => (
                  <li key={i}>
                    <span className="mono">{s.on}</span> {s.what}{' '}
                    <Pill tone={RUNS[s.runs] ?? ''}>{s.runs}</Pill>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
