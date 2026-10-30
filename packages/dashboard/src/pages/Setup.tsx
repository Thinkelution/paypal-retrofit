import { useEffect, useMemo, useState } from 'react';
import {
  api,
  fmtMoney,
  KIND_LABEL,
  type SchemaView,
  type SetupControls,
  type SetupPreview,
  type SetupStatus,
} from '../api';
import { Pill } from '../cells';
import { useToast } from '../hooks';
import { Mapping } from './Mapping';

type Step = 0 | 1 | 2 | 3;
const STEPS = ['Connect your data', 'Check the mapping', 'Set your rules', 'Preview and go live'];

const guessTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const DEFAULT_CONTROLS = (tz: string): SetupControls => ({
  newInvoices: 'auto',
  refundsAutoUpTo: 100,
  refundsPerDay: 500,
  remindersPerDay: 40,
  quietHours: { enabled: true, start: '20:00', end: '08:00', weekends: true },
  timezone: tz,
  collections: { friendly: 3, firm: 14, final: 30 },
});

/**
 * The no-code setup wizard: connect data, let Claude map it, choose the rules in plain language,
 * preview the first sync, go live. Nothing reaches PayPal before the last step.
 */
export function Setup({
  status,
  dark,
  onCancel,
}: {
  status: SetupStatus;
  dark: boolean;
  /** Present when a console already exists (the demo): go back without changing anything. */
  onCancel?: () => void;
}) {
  const { msg, toast } = useToast();
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // step 1
  const [kind, setKind] = useState<'csv' | 'sample' | 'sqlite' | 'postgres'>('csv');
  const [files, setFiles] = useState<File[]>([]);
  const [sqlitePath, setSqlitePath] = useState('');
  const [pgUrl, setPgUrl] = useState('');
  const [session, setSession] = useState<{ id: string; label: string; schema: SchemaView } | null>(null);

  // step 2
  const [currency, setCurrency] = useState('USD');
  const [tz, setTz] = useState(guessTz());
  const [useAi, setUseAi] = useState(status.claude);
  const [mapped, setMapped] = useState<{ engine: string; warnings: string[]; issues: any[] } | null>(null);
  const [mapVersion, setMapVersion] = useState(0);

  // step 3
  const [business, setBusiness] = useState('');
  const [email, setEmail] = useState('');
  const [controls, setControls] = useState<SetupControls>(() => DEFAULT_CONTROLS(guessTz()));
  const [digestTo, setDigestTo] = useState('');
  const [digestTime, setDigestTime] = useState('08:00');

  // step 4
  const [preview, setPreview] = useState<SetupPreview | null>(null);
  const [syncNow, setSyncNow] = useState(status.environment === 'MOCK');

  useEffect(() => setControls((c) => ({ ...c, timezone: tz })), [tz]);

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    act('connect', async () => {
      let body: unknown;
      if (kind === 'csv') {
        if (!files.length) throw new Error('Choose one or more CSV files first.');
        body = {
          kind,
          files: await Promise.all(files.map(async (f) => ({ name: f.name, content: await f.text() }))),
        };
      } else if (kind === 'sample') body = { kind };
      else if (kind === 'sqlite') body = { kind, path: sqlitePath };
      else body = { kind, url: pgUrl };
      const s = await api.setup.source(body);
      setSession(s);
      setMapped(null);
      setPreview(null);
      if (kind === 'sample') setBusiness((b) => b || 'Brightside Plumbing');
    });

  const map = () =>
    act('map', async () => {
      if (!session) return;
      try {
        const r = await api.setup.map(session.id, { ai: useAi, currency, timezone: tz });
        setMapped({ engine: r.engine, warnings: r.warnings, issues: r.issues });
        setMapVersion((v) => v + 1);
      } catch (e: any) {
        setMapped(null);
        throw new Error(
          [e.message, ...(e.data?.issues ?? []).map((i: any) => `${i.path}: ${i.message}`)].join(' · '),
        );
      }
    });

  const loadPreview = () =>
    act('preview', async () => {
      if (!session) return;
      setPreview(await api.setup.preview(session.id, controls));
    });

  const finish = () =>
    act('finish', async () => {
      if (!session) return;
      const r = await api.setup.finish(session.id, {
        business: { name: business, email: email || undefined },
        controls,
        digest: { to: digestTo, time: digestTime },
        syncNow,
      });
      toast(
        r.synced
          ? `Live. ${r.synced.executed} actions ran${r.synced.pending ? `, ${r.synced.pending} wait for you` : ''}.`
          : 'Live. Opening the console…',
      );
      setTimeout(() => {
        window.location.hash = '';
        window.location.reload();
      }, 900);
    });

  const canNext =
    step === 0
      ? Boolean(session)
      : step === 1
        ? Boolean(mapped)
        : step === 2
          ? business.trim().length > 0
          : false;
  const next = () => {
    const n = Math.min(3, step + 1) as Step;
    setStep(n);
    if (n === 3) void loadPreview();
  };

  const setC = <K extends keyof SetupControls>(k: K, v: SetupControls[K]) =>
    setControls((c) => ({ ...c, [k]: v }));
  const cur = currency || 'USD';

  const rulesInWords = useMemo(() => {
    const out: string[] = [];
    out.push(
      controls.newInvoices === 'auto'
        ? 'New invoices are created in PayPal and emailed as soon as they are ready.'
        : 'New invoices wait for your OK before they go to PayPal.',
    );
    out.push(
      controls.refundsAutoUpTo > 0
        ? `Refunds up to ${fmtMoney(controls.refundsAutoUpTo, cur)} run on their own${controls.refundsPerDay > 0 ? `, at most ${fmtMoney(controls.refundsPerDay, cur)} a day` : ''}; bigger ones wait for you.`
        : 'Every refund waits for you.',
    );
    out.push(
      `Reminders are friendly after ${controls.collections.friendly} days, firm after ${controls.collections.firm}, final after ${controls.collections.final}${controls.remindersPerDay > 0 ? `, at most ${controls.remindersPerDay} a day` : ''}. You approve each one.`,
    );
    if (controls.quietHours.enabled)
      out.push(
        `Nothing goes to customers between ${controls.quietHours.start} and ${controls.quietHours.end}${controls.quietHours.weekends ? ' or at weekends' : ''} (${controls.timezone.replace(/_/g, ' ')}).`,
      );
    out.push('Disputes are never accepted automatically.');
    return out;
  }, [controls, cur]);

  return (
    <div className="setup">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            Retrofit <small>setup</small>
          </div>
        </div>
        <span className={`env ${status.environment}`} title="PayPal environment">
          {status.environment === 'MOCK' ? 'MOCK PAYPAL' : `PAYPAL ${status.environment}`}
        </span>
        <span className="spacer" />
        {onCancel && (
          <button className="btn sm" onClick={onCancel}>
            Back to the console
          </button>
        )}
      </header>

      <main className="setup-main">
        <div className="setup-intro">
          <h1>Connect your business to PayPal</h1>
          <p className="muted">
            Four steps, no code. Your data is read, never changed, until you press <b>Go live</b>. After that
            retrofit only writes PayPal ids, pay links and payment status into the columns you approve.
          </p>
        </div>

        <ol className="stepper" aria-label="Setup steps">
          {STEPS.map((label, i) => (
            <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''}>
              <button
                type="button"
                disabled={i > step}
                onClick={() => i < step && setStep(i as Step)}
                aria-current={i === step ? 'step' : undefined}
              >
                <span className="num">{i < step ? '✓' : i + 1}</span>
                <span>{label}</span>
              </button>
            </li>
          ))}
        </ol>

        {error && <div className="callout">{error}</div>}

        {step === 0 && (
          <section className="panel setup-card">
            <div className="choice-grid">
              <label className={`choice ${kind === 'csv' ? 'on' : ''}`}>
                <input type="radio" name="kind" checked={kind === 'csv'} onChange={() => setKind('csv')} />
                <b>Upload CSV exports</b>
                <span className="muted">
                  One file per table: customers, invoices, line items. Most invoicing tools and spreadsheets
                  can export these.
                </span>
              </label>
              <label className={`choice ${kind === 'sample' ? 'on' : ''}`}>
                <input
                  type="radio"
                  name="kind"
                  checked={kind === 'sample'}
                  onChange={() => setKind('sample')}
                />
                <b>Try the sample business</b>
                <span className="muted">
                  Brightside Plumbing: 12 clients, 30 bills, odd column names. Download:{' '}
                  {status.samples.map((f, i) => (
                    <span key={f}>
                      {i ? ', ' : ''}
                      <a href={api.setup.sampleUrl(f)}>{f}</a>
                    </span>
                  ))}
                </span>
              </label>
              {status.allowServerPaths && (
                <>
                  <label className={`choice ${kind === 'sqlite' ? 'on' : ''}`}>
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === 'sqlite'}
                      onChange={() => setKind('sqlite')}
                    />
                    <b>SQLite database</b>
                    <span className="muted">A .db file on this machine. Opened read-only for mapping.</span>
                  </label>
                  <label className={`choice ${kind === 'postgres' ? 'on' : ''}`}>
                    <input
                      type="radio"
                      name="kind"
                      checked={kind === 'postgres'}
                      onChange={() => setKind('postgres')}
                    />
                    <b>Postgres</b>
                    <span className="muted">
                      A connection URL. Agent queries run in read-only transactions.
                    </span>
                  </label>
                </>
              )}
            </div>

            {kind === 'csv' && (
              <label
                className="dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  setFiles([...e.dataTransfer.files].filter((f) => /\.csv$/i.test(f.name)));
                }}
              >
                <input
                  type="file"
                  accept=".csv,text/csv"
                  multiple
                  onChange={(e) => setFiles([...(e.target.files ?? [])])}
                />
                {files.length ? (
                  <span>
                    {files.map((f) => f.name).join(', ')}{' '}
                    <span className="muted">
                      ({Math.ceil(files.reduce((s, f) => s + f.size, 0) / 1024)} KB)
                    </span>
                  </span>
                ) : (
                  <span>
                    Drop CSV files here or <u>choose files</u>
                  </span>
                )}
              </label>
            )}
            {kind === 'sqlite' && (
              <input
                className="search wide"
                placeholder="/path/to/app.db"
                value={sqlitePath}
                onChange={(e) => setSqlitePath(e.target.value)}
              />
            )}
            {kind === 'postgres' && (
              <input
                className="search wide"
                placeholder="postgres://user:password@host:5432/db"
                value={pgUrl}
                onChange={(e) => setPgUrl(e.target.value)}
              />
            )}

            <div className="setup-actions">
              <button className="btn primary" onClick={connect} disabled={busy === 'connect'}>
                {busy === 'connect' ? 'Reading…' : session ? 'Read again' : 'Read my data'}
              </button>
            </div>

            {session && (
              <div className="schema-list">
                <div className="muted">
                  Found {session.schema.tables.length} table{session.schema.tables.length === 1 ? '' : 's'} in{' '}
                  {session.label}
                </div>
                {session.schema.tables.map((t) => (
                  <div key={t.name} className="schema-table">
                    <b className="mono">{t.name}</b> <span className="muted">{t.rows} rows</span>
                    <div className="mono muted small">{t.columns.join(' · ')}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {step === 1 && session && (
          <section className="panel setup-card">
            <div className="form-row">
              <label className="field">
                <span>Currency</span>
                <input
                  className="search"
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                />
              </label>
              <label className="field">
                <span>Time zone</span>
                <input className="search" value={tz} onChange={(e) => setTz(e.target.value)} />
              </label>
              <label className="field check">
                <input
                  type="checkbox"
                  checked={useAi}
                  disabled={!status.claude}
                  onChange={(e) => setUseAi(e.target.checked)}
                />
                <span>
                  Claude maps it{' '}
                  {!status.claude && (
                    <span className="muted">(set ANTHROPIC_API_KEY; the rule-based mapper is used)</span>
                  )}
                </span>
              </label>
              <span className="spacer" />
              <button className="btn primary" onClick={map} disabled={busy === 'map'}>
                {busy === 'map'
                  ? useAi
                    ? 'Claude is reading your schema…'
                    : 'Mapping…'
                  : mapped
                    ? 'Map again'
                    : 'Map my data'}
              </button>
            </div>
            {mapped && (
              <>
                <div className="map-meta">
                  <Pill tone={mapped.engine === 'claude' ? 'accent' : 'info'}>
                    {mapped.engine === 'claude'
                      ? `Mapped by Claude (${status.model})`
                      : 'Mapped by the rule-based mapper'}
                  </Pill>
                  {mapped.warnings.map((w, i) => (
                    <div key={i} className="callout info">
                      {w}
                    </div>
                  ))}
                  {mapped.issues
                    .filter((i) => i.level !== 'error')
                    .map((i, n) => (
                      <div key={n} className="callout info">
                        {i.path} {i.message}
                      </div>
                    ))}
                </div>
                <Mapping
                  key={mapVersion}
                  dark={dark}
                  toast={toast}
                  embedded
                  load={() => api.setup.mapping(session.id)}
                  save={(m) => api.setup.saveMapping(session.id, m)}
                />
              </>
            )}
          </section>
        )}

        {step === 2 && (
          <section className="panel setup-card">
            <div className="rules-grid">
              <div className="rules-form">
                <h3>Your business</h3>
                <div className="form-row">
                  <label className="field grow">
                    <span>Name on invoices</span>
                    <input
                      className="search"
                      value={business}
                      onChange={(e) => setBusiness(e.target.value)}
                    />
                  </label>
                  <label className="field grow">
                    <span>Reply-to email (optional)</span>
                    <input className="search" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                </div>

                <h3>Invoices</h3>
                <div className="segmented" role="radiogroup" aria-label="New invoices">
                  <button
                    aria-pressed={controls.newInvoices === 'auto'}
                    onClick={() => setC('newInvoices', 'auto')}
                  >
                    Send automatically
                  </button>
                  <button
                    aria-pressed={controls.newInvoices === 'confirm'}
                    onClick={() => setC('newInvoices', 'confirm')}
                  >
                    Ask me first
                  </button>
                </div>

                <h3>Refunds</h3>
                <div className="form-row">
                  <label className="field">
                    <span>Run on their own up to</span>
                    <input
                      className="search"
                      type="number"
                      min={0}
                      value={controls.refundsAutoUpTo}
                      onChange={(e) => setC('refundsAutoUpTo', Number(e.target.value))}
                    />
                  </label>
                  <label className="field">
                    <span>Daily cap for automatic refunds</span>
                    <input
                      className="search"
                      type="number"
                      min={0}
                      value={controls.refundsPerDay}
                      onChange={(e) => setC('refundsPerDay', Number(e.target.value))}
                    />
                  </label>
                </div>

                <h3>Reminders</h3>
                <div className="form-row">
                  {(['friendly', 'firm', 'final'] as const).map((t) => (
                    <label key={t} className="field">
                      <span>{t[0]!.toUpperCase() + t.slice(1)} after (days)</span>
                      <input
                        className="search"
                        type="number"
                        min={0}
                        value={controls.collections[t]}
                        onChange={(e) =>
                          setC('collections', { ...controls.collections, [t]: Number(e.target.value) })
                        }
                      />
                    </label>
                  ))}
                  <label className="field">
                    <span>At most per day</span>
                    <input
                      className="search"
                      type="number"
                      min={0}
                      value={controls.remindersPerDay}
                      onChange={(e) => setC('remindersPerDay', Number(e.target.value))}
                    />
                  </label>
                </div>
                <div className="form-row">
                  <label className="field check">
                    <input
                      type="checkbox"
                      checked={controls.quietHours.enabled}
                      onChange={(e) =>
                        setC('quietHours', { ...controls.quietHours, enabled: e.target.checked })
                      }
                    />
                    <span>Quiet hours</span>
                  </label>
                  <label className="field">
                    <span>From</span>
                    <input
                      className="search"
                      type="time"
                      value={controls.quietHours.start}
                      disabled={!controls.quietHours.enabled}
                      onChange={(e) => setC('quietHours', { ...controls.quietHours, start: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Until</span>
                    <input
                      className="search"
                      type="time"
                      value={controls.quietHours.end}
                      disabled={!controls.quietHours.enabled}
                      onChange={(e) => setC('quietHours', { ...controls.quietHours, end: e.target.value })}
                    />
                  </label>
                  <label className="field check">
                    <input
                      type="checkbox"
                      checked={controls.quietHours.weekends}
                      disabled={!controls.quietHours.enabled}
                      onChange={(e) =>
                        setC('quietHours', { ...controls.quietHours, weekends: e.target.checked })
                      }
                    />
                    <span>and weekends</span>
                  </label>
                </div>

                <h3>Morning digest</h3>
                <div className="form-row">
                  <label className="field">
                    <span>Time</span>
                    <input
                      className="search"
                      type="time"
                      value={digestTime}
                      onChange={(e) => setDigestTime(e.target.value)}
                    />
                  </label>
                  <label className="field grow">
                    <span>Email to (comma-separated)</span>
                    <input
                      className="search"
                      placeholder="owner@example.com"
                      value={digestTo}
                      onChange={(e) => setDigestTo(e.target.value)}
                    />
                  </label>
                </div>
                <p className="muted small">
                  {status.smtp
                    ? 'Email is configured on this server.'
                    : 'Email needs RETROFIT_SMTP_URL on the server; until then the digest is kept in the console.'}{' '}
                  {status.slack ? 'It is also posted to Slack.' : ''}
                </p>
              </div>
              <aside className="rules-words">
                <h3>In plain words</h3>
                <ul>
                  {rulesInWords.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p className="muted small">
                  You can change any of this later on the Mapping tab or in retrofit.map.json.
                </p>
              </aside>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="panel setup-card">
            {!preview ? (
              <div className="empty">
                {busy === 'preview' ? 'Working out the first sync…' : 'No preview yet.'}
              </div>
            ) : (
              <>
                <div className="mini-kpis three">
                  <div>
                    <span>Open invoices</span>
                    <b>{fmtMoney(preview.invoices.openAmount, preview.currency)}</b>
                    <small>
                      {preview.invoices.open} of {preview.invoices.total} invoices
                    </small>
                  </div>
                  <div>
                    <span>Sent on the first sync</span>
                    <b>{fmtMoney(preview.invoices.toSendAmount, preview.currency)}</b>
                    <small>{preview.invoices.toSend} invoices</small>
                  </div>
                  <div>
                    <span>Left alone</span>
                    <b>{preview.skippedTotal}</b>
                    <small>drafts and invoices without an email</small>
                  </div>
                </div>
                <div className="preview-grid">
                  <div>
                    <h3>What the first sync does</h3>
                    <ul className="plain">
                      {Object.entries(preview.byKind).map(([k, n]) => (
                        <li key={k}>
                          <b>{n}</b> × {KIND_LABEL[k] ?? k}{' '}
                          <Pill tone={controls.newInvoices === 'auto' ? 'ok' : 'accent'}>
                            {preview.items.find((i) => i.kind === k)?.policy === 'auto'
                              ? 'runs now'
                              : 'waits for you'}
                          </Pill>
                        </li>
                      ))}
                      {!Object.keys(preview.byKind).length && <li className="muted">Nothing to send yet.</li>}
                    </ul>
                    <h3>First invoices</h3>
                    <table className="mini-table">
                      <tbody>
                        {preview.invoices.sample.map((i) => (
                          <tr key={i.number}>
                            <td className="mono">{i.number}</td>
                            <td>
                              {i.customer}
                              <div className="muted small">{i.email}</div>
                            </td>
                            <td className="num">{fmtMoney(i.total, preview.currency)}</td>
                            <td className="muted small">{i.due ? `due ${i.due}` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <h3>Not sent</h3>
                    <ul className="plain">
                      {preview.skipped.slice(0, 10).map((x, i) => (
                        <li key={i}>
                          <span className="mono">{x.label}</span> <span className="muted">{x.reason}</span>
                        </li>
                      ))}
                      {!preview.skipped.length && <li className="muted">Nothing skipped.</li>}
                    </ul>
                    <h3>Connections</h3>
                    <ul className="plain">
                      <li>
                        PayPal{' '}
                        {status.environment === 'MOCK' ? (
                          <Pill tone="info">built-in PayPal simulator</Pill>
                        ) : status.paypalCredentials ? (
                          <Pill tone="ok">{status.environment.toLowerCase()} credentials found</Pill>
                        ) : (
                          <Pill tone="bad">set PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET</Pill>
                        )}
                      </li>
                      <li>
                        Claude agents{' '}
                        {status.claude ? (
                          <Pill tone="ok">on</Pill>
                        ) : (
                          <Pill tone="">off (no ANTHROPIC_API_KEY)</Pill>
                        )}
                      </li>
                    </ul>
                  </div>
                </div>
                <div className="setup-actions">
                  <label className="field check">
                    <input type="checkbox" checked={syncNow} onChange={(e) => setSyncNow(e.target.checked)} />
                    <span>Run the first sync right away</span>
                  </label>
                  <span className="spacer" />
                  <button
                    className="btn primary"
                    onClick={finish}
                    disabled={busy === 'finish' || (!status.paypalCredentials && syncNow)}
                  >
                    {busy === 'finish' ? 'Going live…' : 'Go live'}
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        <div className="setup-nav">
          <button
            className="btn"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1) as Step)}
          >
            Back
          </button>
          <span className="spacer" />
          {step < 3 && (
            <button className="btn primary" disabled={!canNext} onClick={next}>
              Next: {STEPS[step + 1]}
            </button>
          )}
        </div>
      </main>
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </div>
  );
}
