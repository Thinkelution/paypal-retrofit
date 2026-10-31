import { useState } from 'react';
import { api, type GoLiveCheck } from '../api';
import { useLive } from '../hooks';

const MARK: Record<GoLiveCheck['status'], string> = { done: '✓', todo: '', warn: '!', info: 'i' };
const STAGES: Array<[string, string]> = [
  ['simulator', 'Simulator'],
  ['sandbox', 'PayPal sandbox'],
  ['live', 'Live'],
];

/** From the simulator to real payments, one checked step at a time. */
export function GoLive({ onGo, toast }: { onGo: (tab: string) => void; toast: (m: string) => void }) {
  const { data, error, reload } = useLive(() => api.golive());
  const [busy, setBusy] = useState<string | null>(null);
  if (error) return <div className="callout">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const run = async (c: GoLiveCheck) => {
    const f = c.fix;
    if (!f) return;
    if (f.tab) return onGo(f.tab);
    if (!f.action) return;
    setBusy(c.id);
    try {
      if (f.action === 'sync') {
        const r = await api.sync();
        toast(`Sync: ${r.results.length} action(s).`);
      } else if (f.action === 'reconcile') {
        const r = await api.reconcile();
        toast(`Checked ${r.checked} invoices; repaired ${r.fixed.length}.`);
      } else {
        const r = await api.registerWebhook();
        toast(`Webhook ${r.id} registered for ${r.events} PayPal events.`);
      }
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const stageIndex = STAGES.findIndex(([s]) => s === data.stage);

  return (
    <div className="golive">
      <section className="panel golive-head">
        <div>
          <h2>Go live with PayPal</h2>
          <p className="muted">
            {data.done} of {data.total} steps done. Each step is checked against what retrofit actually sees,
            not just what is configured.
          </p>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={data.total}
            aria-valuenow={data.done}
          >
            <span style={{ width: `${(100 * data.done) / data.total}%` }} />
          </div>
        </div>
        <ol className="stages" aria-label="Where you are">
          {STAGES.map(([s, label], i) => (
            <li key={s} className={i < stageIndex ? 'past' : i === stageIndex ? 'now' : ''}>
              {label}
            </li>
          ))}
        </ol>
      </section>
      <ol className="checks">
        {data.checks.map((c) => (
          <li key={c.id} className={`check-row ${c.status}`}>
            <span className="mark" aria-label={c.status}>
              {MARK[c.status]}
            </span>
            <div>
              <b>{c.title}</b>
              <p className="muted">{c.detail}</p>
              {c.fix?.how && (
                <ol className="how">
                  {c.fix.how.map((h) =>
                    /^https?:\/\//.test(h) ? (
                      <li key={h}>
                        <a href={h} target="_blank" rel="noreferrer">
                          {h.length > 70 ? `${h.slice(0, 70)}…` : h}
                        </a>
                      </li>
                    ) : (
                      <li key={h}>{h}</li>
                    ),
                  )}
                </ol>
              )}
            </div>
            {c.fix && (c.fix.action || c.fix.tab) && (
              <button
                className={`btn sm ${c.status === 'todo' ? 'primary' : ''}`}
                disabled={!!busy}
                onClick={() => run(c)}
              >
                {busy === c.id ? 'Working…' : c.fix.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
