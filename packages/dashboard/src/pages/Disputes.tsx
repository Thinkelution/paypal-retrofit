import { useEffect, useState } from 'react';
import { ago, api, fmtMoney, type Config, type DisputeListItem, type LedgerRow } from '../api';
import { humanize, Pill } from '../cells';
import { useLive } from '../hooks';

const CASE: Record<string, [string, string]> = {
  drafting: ['Drafting', 'info'],
  ready: ['Drafted', 'info'],
  proposed: ['Evidence waits for you', 'warn'],
  submitted: ['Sent to PayPal', 'ok'],
  failed: ['Could not draft', 'bad'],
};
const RECOMMEND: Record<string, string> = {
  contest: 'Contest it with your records',
  offer_partial_refund: 'Offer a partial refund',
  accept: 'Accept the claim',
};

const stateOf = (d: DisputeListItem): [string, string] =>
  d.resolvedAt ? ['Resolved', ''] : d.case ? (CASE[d.case.status] ?? ['Open', 'warn']) : ['Open', 'bad'];

/** Buyer disputes: the response retrofit drafted from the business's records, edited and sent once approved. */
export function Disputes(props: {
  config: Config;
  rows: LedgerRow[] | null;
  initial: string | null;
  toast: (m: string) => void;
}) {
  const { config, rows, initial, toast } = props;
  const list = useLive(() => api.disputes());
  const [sel, setSel] = useState<string | null>(initial);
  const detail = useLive(() => (sel ? api.dispute(sel) : Promise.resolve(null)), [sel]);
  const [response, setResponse] = useState('');
  const [type, setType] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const cur = config.currency;

  useEffect(() => {
    if (!sel && list.data?.disputes.length)
      setSel((list.data.disputes.find((d) => !d.resolvedAt) ?? list.data.disputes[0])!.disputeId);
  }, [list.data]);
  useEffect(() => {
    const draft = detail.data?.case?.draft;
    setResponse(draft?.response ?? '');
    setType(draft?.evidenceType ?? '');
  }, [detail.data?.case?.updatedAt, sel]);

  const run = async (what: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try {
      await fn();
      toast(done);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      list.reload();
      detail.reload();
    }
  };
  const paid = rows?.find((r) => r.entity === 'invoice' && r.paypalStatus === 'PAID');
  if (list.error) return <div className="callout">{list.error}</div>;
  if (!list.data) return <div className="empty">Loading…</div>;
  if (!list.data.disputes.length)
    return (
      <div className="empty">
        <h3>No PayPal disputes</h3>
        <p>
          When a buyer opens one, retrofit gathers what your records say about the invoice, drafts a response
          and asks you before sending PayPal the evidence.
        </p>
        {config.demo && paid && (
          <button
            className="btn"
            onClick={() =>
              run(
                'open',
                () => api.demoDispute(paid.legacyPk),
                `A test dispute was opened on ${paid.number}.`,
              )
            }
          >
            Open a test dispute on {paid.number}
          </button>
        )}
      </div>
    );

  const d = detail.data;
  const c = d?.case;
  const draft = c?.draft;
  const pack = d?.pack;
  const edited = draft && (response !== draft.response || type !== draft.evidenceType);
  const waiting = d?.action?.status === 'pending' ? d.action : null;

  return (
    <div className="split">
      <ul className="split-list" aria-label="Disputes">
        {list.data.disputes.map((x) => {
          const [label, tone] = stateOf(x);
          return (
            <li key={x.disputeId}>
              <button
                className="split-item"
                aria-current={sel === x.disputeId ? 'true' : undefined}
                onClick={() => setSel(x.disputeId)}
              >
                <b>{x.number ?? x.disputeId}</b> {x.customer && <span className="muted">· {x.customer}</span>}
                <div className="muted small">{x.detail}</div>
                <Pill tone={tone}>{label}</Pill> <span className="muted small">{ago(x.openedAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <section className="panel split-detail">
        {!d || !pack ? (
          <div className="empty">{detail.error ?? 'Loading…'}</div>
        ) : (
          <>
            <div className="panel-head">
              <h2>
                {pack.invoice ? `Invoice ${pack.invoice.number}` : pack.disputeId}: {pack.reasonText}
              </h2>
              <span className="num">{fmtMoney(pack.amount, cur)}</span>
              <span className="spacer" />
              {c && <Pill tone={CASE[c.status]?.[1]}>{CASE[c.status]?.[0]}</Pill>}
            </div>
            <div className="panel-body dispute-body">
              <p className="muted small">
                {pack.disputeId} · PayPal status {humanize(pack.status)}
                {pack.respondBy ? ` · respond by ${pack.respondBy.slice(0, 10)}` : ''}
              </p>
              {pack.buyerSays.map((m, i) => (
                <blockquote key={i} className="buyer-says">
                  {m}
                </blockquote>
              ))}
              {c?.error && <div className="callout">{c.error}</div>}
              {draft && (
                <>
                  <div className={`callout ${draft.recommendation === 'contest' ? 'info' : ''}`}>
                    <b>{RECOMMEND[draft.recommendation]}.</b> {draft.reasoning}{' '}
                    <span className="muted">
                      · drafted {c?.engine === 'claude' ? 'by Claude' : 'from your records'}
                    </span>
                  </div>
                  <p>{draft.summary}</p>

                  <label className="field">
                    <span>Response to PayPal (sent with a PDF of your records)</span>
                    <textarea
                      rows={9}
                      value={response}
                      maxLength={2000}
                      onChange={(e) => setResponse(e.target.value)}
                    />
                  </label>
                  <div className="actions-row">
                    <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Evidence type">
                      {list.data!.evidenceTypes.map((t) => (
                        <option key={t} value={t}>
                          {humanize(t)}
                        </option>
                      ))}
                    </select>
                    <a
                      className="btn ghost sm"
                      href={api.disputePdfUrl(pack.disputeId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      See the PDF ↗
                    </a>
                    <span className="muted small">{response.length} / 2000</span>
                  </div>

                  <div className="checklist">
                    {draft.evidence.map((e) => (
                      <div key={e.item} className={e.available ? 'ok' : 'missing'}>
                        {e.available ? '✓' : '✗'} {e.item} <span className="muted">({e.source})</span>
                      </div>
                    ))}
                  </div>
                  {draft.missing.length > 0 && (
                    <p className="muted small">Worth adding: {draft.missing.join('; ')}</p>
                  )}

                  <div className="actions-row">
                    {c?.status !== 'submitted' && pack.channel !== 'none' && (
                      <>
                        {waiting && !edited ? (
                          <button
                            className="btn primary"
                            disabled={!!busy}
                            onClick={() =>
                              run('send', () => api.approve(waiting.id), 'Sent to PayPal with the evidence.')
                            }
                          >
                            {busy === 'send' ? 'Sending…' : 'Approve and send to PayPal'}
                          </button>
                        ) : (
                          <button
                            className="btn primary"
                            disabled={!!busy || !response.trim()}
                            onClick={() =>
                              run(
                                'save',
                                () => api.proposeEvidence(pack.disputeId, { response, evidenceType: type }),
                                'Saved. It now waits for your OK.',
                              )
                            }
                          >
                            {busy === 'save'
                              ? 'Saving…'
                              : edited
                                ? 'Save my changes'
                                : 'Get it ready to send'}
                          </button>
                        )}
                      </>
                    )}
                    <button
                      className="btn ghost"
                      disabled={!!busy}
                      onClick={() =>
                        run(
                          'redraft',
                          () => api.prepareDispute(pack.disputeId),
                          'Drafted again from your records.',
                        )
                      }
                    >
                      {busy === 'redraft' ? 'Drafting…' : 'Draft again'}
                    </button>
                  </div>
                  {c?.status === 'submitted' && d.action?.result && (
                    <p className="muted small">
                      Sent with{' '}
                      {d.action.result.via === 'provide-evidence'
                        ? `PayPal's provide-evidence (${d.action.result.document?.name})`
                        : 'a message to the buyer'}
                      .
                    </p>
                  )}
                </>
              )}
              {!draft && !c && (
                <button
                  className="btn primary"
                  disabled={!!busy}
                  onClick={() =>
                    run('redraft', () => api.prepareDispute(pack.disputeId), 'Drafted from your records.')
                  }
                >
                  Draft a response from my records
                </button>
              )}

              <h4>What your records show</h4>
              <ol className="trail">
                {pack.facts.map((f, i) => (
                  <li key={i}>
                    <span className="mono">{f.at ? f.at.slice(0, 10) : '          '}</span>
                    <div>
                      <b>{f.item}</b> <span className="muted small">{f.source}</span>
                      <div className="small">{f.detail}</div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
