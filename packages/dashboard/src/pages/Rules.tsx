import { useState } from 'react';
import { api, type RuleChange, type RulesPreview } from '../api';
import { humanize, Pill } from '../cells';
import { useLive } from '../hooks';

const EXAMPLES = [
  'Refunds over $200 need me.',
  'Never chase schools before the 20th.',
  'No reminders after 7pm or at weekends.',
  'Agree plans up to $800 in 3 payments.',
  'Bills up to $500 run on their own.',
  '2% late fee after 30 days.',
];

/** The owner says how they want to be paid; retrofit shows what that changes today before anything is saved. */
export function Rules({ toast }: { toast: (m: string) => void }) {
  const current = useLive(() => api.rules());
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [result, setResult] = useState<{
    changes: RuleChange[];
    unsupported: string[];
    engine: string;
    warning?: string;
    preview: RulesPreview;
  } | null>(null);

  const preview = async () => {
    setBusy('preview');
    try {
      setResult(await api.previewRules(text));
    } catch (e) {
      toast((e as Error).message);
      setResult(null);
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    if (!result) return;
    setBusy('apply');
    try {
      await api.applyRules(result.changes);
      toast(`${result.changes.length} rule${result.changes.length === 1 ? '' : 's'} saved.`);
      setResult(null);
      setText('');
      current.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const p = result?.preview;

  return (
    <div className="rules-page">
      <section className="panel">
        <div className="panel-head">
          <h2>Say it in your own words</h2>
          <span className="muted small">Nothing is saved until you have seen what it changes.</span>
        </div>
        <div className="panel-body">
          <textarea
            rows={4}
            aria-label="Your rules"
            placeholder="e.g. Refunds over $200 need me. Never chase schools before the 20th."
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
          />
          <div className="actions-row">
            <button className="btn primary" disabled={!text.trim() || !!busy} onClick={preview}>
              {busy === 'preview' ? 'Reading…' : 'Show me what changes'}
            </button>
            {EXAMPLES.map((x) => (
              <button
                key={x}
                className="btn ghost sm"
                onClick={() => {
                  setText((t) => (t.trim() ? `${t.trim()} ${x}` : x));
                  setResult(null);
                }}
              >
                + {x}
              </button>
            ))}
          </div>
        </div>
      </section>

      {result && p && (
        <section className="panel">
          <div className="panel-head">
            <h2>What you said, as rules</h2>
            <Pill tone="info">read {result.engine === 'claude' ? 'by Claude' : 'with patterns'}</Pill>
          </div>
          <div className="panel-body">
            {result.warning && <div className="callout">{result.warning}</div>}
            {result.changes.length ? (
              <ol className="rule-changes">
                {result.changes.map((c, i) => (
                  <li key={i}>
                    <Pill>{humanize(c.type)}</Pill> {c.explanation}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">No rules found in that.</p>
            )}
            {result.unsupported.length > 0 && (
              <p className="muted">
                Not something retrofit can do: {result.unsupported.map((u) => `"${u}"`).join(', ')}
              </p>
            )}

            <div className="callout info">
              <b>{p.summary}</b>
            </div>
            {p.collections.length > 0 && (
              <div className="table-scroll">
                <table className="plain">
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Customer</th>
                      <th>Today</th>
                      <th>With these rules</th>
                      <th className="hide-sm">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.collections.map((c) => (
                      <tr key={c.number}>
                        <td>{c.number}</td>
                        <td>{c.customer}</td>
                        <td>{humanize(c.before)}</td>
                        <td>
                          <b>{humanize(c.after)}</b>
                        </td>
                        <td className="hide-sm muted small">{c.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(p.lateFees.added.length > 0 || p.lateFees.dropped.length > 0) && (
              <p>
                Late fees: {p.lateFees.added.length ? `added on ${p.lateFees.added.join(', ')}` : ''}
                {p.lateFees.added.length && p.lateFees.dropped.length ? '; ' : ''}
                {p.lateFees.dropped.length ? `no longer on ${p.lateFees.dropped.join(', ')}` : ''}.
              </p>
            )}
            {p.waiting.length > 0 && (
              <ul className="plain">
                {p.waiting.map((w) => (
                  <li key={w.id}>
                    {w.label}: {w.before === 'confirm' ? 'waits for you' : w.before} →{' '}
                    <b>
                      {w.after === 'auto'
                        ? 'runs on its own'
                        : w.after === 'confirm'
                          ? 'waits for you'
                          : 'never done'}
                    </b>
                  </li>
                ))}
              </ul>
            )}
            <div className="actions-row">
              <button className="btn primary" disabled={!result.changes.length || !!busy} onClick={apply}>
                {busy === 'apply' ? 'Saving…' : 'Use these rules'}
              </button>
              <button className="btn ghost" onClick={() => setResult(null)}>
                Change the wording
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Your rules now</h2>
        </div>
        <div className="panel-body">
          {current.data ? (
            <ul className="rule-list">
              {current.data.sentences.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </div>
      </section>
    </div>
  );
}
