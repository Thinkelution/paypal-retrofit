import { ago, api, fmtMoney, type Config, type TodayNeed } from '../api';
import { useLive } from '../hooks';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/** Payments carry a date only: say "today" rather than "23h ago". */
const when = (at: string) => {
  if (at.length > 10) return ago(at);
  const days = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(at)) / 864e5);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;
};

const RECENT_ICON: Record<string, string> = { payment: '$', order: '🛒', action: '→', customer: '✉' };

/** The owner's home: what needs them today, how the money stands, and what happened. */
export function Today({
  config,
  busy,
  onGo,
  onRun,
  onNewInvoice,
  onAsk,
}: {
  config: Config;
  busy: string | null;
  onGo: (tab: string) => void;
  onRun: (what: 'sync' | 'collections') => void;
  onNewInvoice: (mode?: 'say' | 'snap') => void;
  onAsk: (q: string) => void;
}) {
  const { data, error } = useLive(() => api.today());
  if (error) return <div className="callout">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const cur = data.currency;
  const m = data.money;
  const act = (n: TodayNeed) => (n.run ? onRun(n.run) : n.go && onGo(n.go));

  return (
    <div className="today">
      <section className="today-head" data-tour="today">
        <div>
          <div className="muted">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <h1>
            {greeting()}, {data.business}
          </h1>
          <p>
            {fmtMoney(m.owed, cur)} is owed to you
            {m.overdue ? (
              <>
                , <b className="bad-ink">{fmtMoney(m.overdue, cur)}</b> of it overdue
              </>
            ) : null}
            .{' '}
            {data.needs.filter((n) => n.tone !== 'info').length
              ? `${data.needs.filter((n) => n.tone !== 'info').length} thing${data.needs.filter((n) => n.tone !== 'info').length === 1 ? ' needs' : 's need'} you.`
              : 'Nothing urgent.'}
          </p>
        </div>
        <div className="today-actions">
          <button className="btn primary" onClick={() => onNewInvoice()} data-tour="new-invoice">
            + New invoice
          </button>
          <button className="btn" onClick={() => onNewInvoice('snap')}>
            Snap a job sheet
          </button>
        </div>
      </section>

      <section className="kpis four" aria-label="Money">
        <button className="kpi clickable" onClick={() => onGo('ledger')}>
          <div className="label">Owed to you</div>
          <div className="value">{fmtMoney(m.owed, cur)}</div>
          <div className="sub">{m.open} open invoices</div>
        </button>
        <button className={`kpi clickable ${m.overdue ? 'bad' : ''}`} onClick={() => onGo('collections')}>
          <div className="label">Overdue</div>
          <div className="value">{fmtMoney(m.overdue, cur)}</div>
          <div className="sub">{m.overdueCount} invoices past due</div>
        </button>
        <button className="kpi clickable ok" onClick={() => onGo('insights')}>
          <div className="label">Collected this week</div>
          <div className="value">{fmtMoney(m.collected7d, cur)}</div>
          <div className="sub">
            {m.collected7dCount} payment{m.collected7dCount === 1 ? '' : 's'}
            {data.autopay.active ? ` · ${data.autopay.active} on autopay` : ''}
          </div>
        </button>
        <button className="kpi clickable" onClick={() => onGo('insights')}>
          <div className="label">Expected in 30 days</div>
          <div className="value">{fmtMoney(m.expected30, cur)}</div>
          <div className="sub">{fmtMoney(m.atRisk, cur)} at high risk</div>
        </button>
      </section>

      <div className="today-grid">
        <section className="panel" data-tour="needs">
          <div className="panel-head">
            <h2>Needs you</h2>
          </div>
          <div className="needs">
            {data.needs.length === 0 && (
              <div className="all-clear">
                <span aria-hidden>✓</span> All clear. Nothing needs you today.
              </div>
            )}
            {data.needs.map((n) => (
              <article key={n.id} className={`need ${n.tone}`}>
                <div className="need-body">
                  <b>{n.title}</b>
                  <p className="muted">{n.detail}</p>
                  {n.items?.length ? (
                    <ul>
                      {n.items.map((i, k) => (
                        <li key={k}>
                          <span>{i.label}</span>
                          {i.sub && <span className="muted"> · {i.sub}</span>}
                          {i.amount != null && <span className="num"> · {fmtMoney(i.amount, cur)}</span>}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <button
                  className={`btn sm ${n.tone === 'info' ? '' : 'primary'}`}
                  disabled={!!busy && !!n.run}
                  onClick={() => act(n)}
                >
                  {busy && n.run === busy ? 'Working…' : n.label}
                </button>
              </article>
            ))}
          </div>
        </section>

        <aside className="today-side">
          <section className="panel">
            <div className="panel-head">
              <h2>Recently</h2>
            </div>
            <ul className="recent">
              {data.recent.length === 0 && (
                <li className="muted none">Nothing yet. Payments and actions show up here.</li>
              )}
              {data.recent.map((r, i) => (
                <li key={i} className={r.kind}>
                  <span className="ricon" aria-hidden>
                    {RECENT_ICON[r.kind]}
                  </span>
                  <span>{r.text}</span>
                  <span className="muted when">{when(r.at)}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel try">
            <div className="panel-head">
              <h2>Try</h2>
            </div>
            <div className="try-list">
              <button onClick={() => onNewInvoice('say')}>
                <b>Say an invoice</b>
                <span className="muted">"Invoice Maya Okafor $250 for retouching, due Friday"</span>
              </button>
              <button onClick={() => onGo('website')}>
                <b>Pay a bill from your website</b>
                <span className="muted">One script tag, plus QR codes for paper invoices</span>
              </button>
              <button
                onClick={() => onAsk('Which customers are most likely to pay late this month, and why?')}
              >
                <b>Ask the agent</b>
                <span className="muted">"Which customers are most likely to pay late this month?"</span>
              </button>
              {config.environment !== 'PRODUCTION' && (
                <button onClick={() => onGo('golive')}>
                  <b>Go live</b>
                  <span className="muted">
                    {data.setup.done} of {data.setup.total} steps done
                    {data.setup.next
                      ? ` · next: ${data.setup.next[0]!.toLowerCase()}${data.setup.next.slice(1)}`
                      : ''}
                  </span>
                </button>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
