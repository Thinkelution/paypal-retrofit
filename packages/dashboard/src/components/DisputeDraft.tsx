import { useEffect, useState } from 'react';
import { api } from '../api';
import { humanize, Pill } from '../cells';

export function DisputeDraft({ disputeId, onClose }: { disputeId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api
      .draftDispute(disputeId)
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [disputeId]);
  const d = data?.draft;
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Dispute response draft">
        <header>
          <h3>Dispute {disputeId}</h3>
          {data?.invoiceNumber && <Pill>{data.invoiceNumber}</Pill>}
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">
          {!data && !error && (
            <p className="muted">The Support agent is reading the dispute and your invoice records…</p>
          )}
          {error && <div className="callout">{error}</div>}
          {d && (
            <>
              <div className="callout info">
                <b>Recommendation: {humanize(d.recommendation)}.</b> {d.reasoning}
              </div>
              <p style={{ margin: 0 }}>{d.summary}</p>
              <section>
                <h4 className="muted" style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase' }}>
                  Draft response
                </h4>
                <div className="panel" style={{ padding: 12, whiteSpace: 'pre-wrap' }}>
                  {d.response}
                </div>
                <div className="actions-row" style={{ marginTop: 8 }}>
                  <button
                    className="btn primary sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(d.response);
                      setCopied(true);
                    }}
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    Review it, then respond in PayPal's Resolution Center. Retrofit never submits dispute
                    responses for you.
                  </span>
                </div>
              </section>
              <section>
                <h4 className="muted" style={{ margin: '0 0 6px', fontSize: 12, textTransform: 'uppercase' }}>
                  Evidence
                </h4>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {d.evidence.map((e: any, i: number) => (
                    <li key={i}>
                      {e.available ? '✔' : '✘'} {e.item} <span className="muted">({e.source})</span>
                    </li>
                  ))}
                </ul>
                {d.missing.length > 0 && <p className="muted">Still needed: {d.missing.join('; ')}</p>}
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
