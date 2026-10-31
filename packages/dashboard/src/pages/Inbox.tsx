import { useState } from 'react';
import { ago, api, type InboxEmail, type Negotiation } from '../api';
import { Pill } from '../cells';
import { useLive } from '../hooks';

const INTENT: Record<string, string> = {
  promise: 'Promise to pay',
  plan: 'Wants to pay in parts',
  paid_elsewhere: 'Says they paid',
  statement: 'Wants a statement',
  dispute: 'Complaint',
  question: 'Question',
  other: 'Nothing to act on',
};
const STATUS: Record<InboxEmail['status'], [string, string]> = {
  needs_owner: ['Needs you', 'warn'],
  done: ['Handled', 'ok'],
  unknown_sender: ['Not a customer', ''],
  new: ['New', 'info'],
};
const PLAN: Record<Negotiation['status'], [string, string]> = {
  agreed: ['Agreed', 'ok'],
  owner: ['Waits for you', 'warn'],
  counter: ['Counter-offer', 'info'],
  declined: ['Declined', 'bad'],
  taken: ['Offer accepted', 'ok'],
};

/** Customer emails and customers' AI assistants: what they asked, what retrofit did, and the reply. */
export function Inbox({ toast, onGo }: { toast: (m: string) => void; onGo: (tab: string) => void }) {
  const { data, error, reload } = useLive(() => api.inbox());
  const plans = useLive(() => api.negotiations());
  const [view, setView] = useState<'email' | 'assistants'>('email');
  const [form, setForm] = useState({ from: '', subject: '', text: '' });
  const [replies, setReplies] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <div className="callout">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const take = async () => {
    setBusy('take');
    try {
      const m = await api.takeEmail(form);
      toast(
        m.reading
          ? `${INTENT[m.reading.intent] ?? m.reading.intent}: ${m.reading.summary}`
          : 'Kept for you to read',
      );
      setForm({ from: '', subject: '', text: '' });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const reply = async (m: InboxEmail) => {
    setBusy(`reply-${m.id}`);
    try {
      const r = await api.replyEmail(m.id, replies[m.id] ?? m.reply ?? undefined);
      toast(r.status === 'sent' ? 'Reply sent.' : r.detail);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const waiting = data.emails.filter((m) => m.status === 'needs_owner').length;

  return (
    <div className="inbox">
      <div className="tabs" role="tablist">
        <button className="tab" role="tab" aria-selected={view === 'email'} onClick={() => setView('email')}>
          Email
          {waiting ? <span className="count hot">{waiting}</span> : null}
        </button>
        <button
          className="tab"
          role="tab"
          aria-selected={view === 'assistants'}
          onClick={() => setView('assistants')}
        >
          Customers' assistants
          {plans.data?.length ? <span className="count">{plans.data.length}</span> : null}
        </button>
      </div>

      {view === 'email' ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Read a customer email</h2>
              <span className="muted small">
                Paste or forward one here, or point your mail provider's inbound webhook at{' '}
                <code>/inbound/email</code>.
              </span>
            </div>
            <div className="panel-body mail-form">
              <input
                className="search"
                placeholder="From (email address)"
                aria-label="From"
                value={form.from}
                onChange={(e) => setForm({ ...form, from: e.target.value })}
              />
              <input
                className="search"
                placeholder="Subject"
                aria-label="Subject"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
              />
              <textarea
                rows={4}
                placeholder="What the customer wrote"
                aria-label="Email text"
                value={form.text}
                onChange={(e) => setForm({ ...form, text: e.target.value })}
              />
              <div className="actions-row">
                <button className="btn primary" disabled={!form.from || !form.text || !!busy} onClick={take}>
                  {busy === 'take' ? 'Reading…' : 'Read it'}
                </button>
                {data.samples.map((s, i) => (
                  <button
                    key={i}
                    className="btn ghost sm"
                    onClick={() =>
                      setForm({
                        from: s.name ? `${s.name} <${s.from}>` : s.from,
                        subject: s.subject ?? '',
                        text: s.text,
                      })
                    }
                  >
                    Try: {s.subject}
                  </button>
                ))}
              </div>
              <p className="muted small">
                Promises, plan requests and questions are filed straight away and pause reminders. Anything
                that moves money or closes an invoice waits for you: an email can be forged.
              </p>
            </div>
          </section>

          {!data.emails.length && <div className="empty">No customer emails yet.</div>}
          <ul className="mail-list">
            {data.emails.map((m) => {
              const [label, tone] = STATUS[m.status];
              const r = m.reading;
              return (
                <li key={m.id} className="panel mail">
                  <header className="mail-head">
                    <b>{m.senderName ?? m.sender}</b>
                    {m.senderName && <span className="muted small">{m.sender}</span>}
                    <span className="spacer" />
                    <Pill tone={tone}>{label}</Pill>
                    <span className="muted small">{ago(m.receivedAt)}</span>
                  </header>
                  {m.subject && <div className="mail-subject">{m.subject}</div>}
                  <p className="mail-body">{m.body}</p>
                  {r && (
                    <div className="callout info">
                      <b>{INTENT[r.intent] ?? r.intent}.</b> {r.summary}
                      <span className="muted">
                        {' '}
                        · read {r.engine === 'claude' ? 'by Claude' : 'with rules'}
                      </span>
                      {r.warning && <div className="muted small">{r.warning}</div>}
                    </div>
                  )}
                  {m.outcome &&
                    (m.outcome.requests.length > 0 ||
                      m.outcome.actions.length > 0 ||
                      m.outcome.notes.length > 0) && (
                      <ul className="plain mail-outcome">
                        {m.outcome.requests.map((x) => (
                          <li key={x}>Filed: {x.replace(/_/g, ' ')}</li>
                        ))}
                        {m.outcome.actions.length > 0 && (
                          <li>
                            {m.outcome.actions.length} action{m.outcome.actions.length === 1 ? '' : 's'}{' '}
                            proposed{' '}
                            {m.status === 'needs_owner' && (
                              <button className="linkish" onClick={() => onGo('approvals')}>
                                waiting in Approvals →
                              </button>
                            )}
                          </li>
                        )}
                        {m.outcome.notes.map((x) => (
                          <li key={x} className="muted">
                            {x}
                          </li>
                        ))}
                      </ul>
                    )}
                  {m.customerPk && (m.reply || r?.reply) && (
                    <div className="mail-reply">
                      <textarea
                        rows={3}
                        aria-label="Reply"
                        value={replies[m.id] ?? m.reply ?? r?.reply ?? ''}
                        onChange={(e) => setReplies({ ...replies, [m.id]: e.target.value })}
                      />
                      <div className="actions-row">
                        <button className="btn sm" disabled={!!busy} onClick={() => reply(m)}>
                          {busy === `reply-${m.id}` ? 'Sending…' : m.repliedAt ? 'Send again' : 'Send reply'}
                        </button>
                        {m.repliedAt && <span className="muted small">Replied {ago(m.repliedAt)}</span>}
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2>Payment plans agreed with customers' assistants</h2>
            <span className="muted small">
              Inside your plan limits they are agreed at once; outside them, a counter-offer.
            </span>
          </div>
          {!plans.data?.length ? (
            <div className="empty">No assistant has asked for a plan yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="plain">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Invoice</th>
                    <th>Asked</th>
                    <th>Outcome</th>
                    <th className="hide-sm">Why</th>
                    <th className="hide-sm">When</th>
                  </tr>
                </thead>
                <tbody>
                  {plans.data.map((n) => (
                    <tr key={n.id}>
                      <td>{n.customer}</td>
                      <td>{n.invoice}</td>
                      <td>
                        {n.ask.installments} payments
                        {n.offer && n.offer.installments !== n.ask.installments && (
                          <div className="muted small">offered {n.offer.installments}</div>
                        )}
                      </td>
                      <td>
                        <Pill tone={PLAN[n.status][1]}>{PLAN[n.status][0]}</Pill>
                      </td>
                      <td className="hide-sm muted small">{n.reason}</td>
                      <td className="hide-sm muted small">{ago(n.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
