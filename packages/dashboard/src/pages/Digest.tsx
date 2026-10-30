import { useEffect, useState } from 'react';
import { ago, api, type Config, type DigestPreview } from '../api';
import { Pill } from '../cells';
import { useLive } from '../hooks';

const STATUS_TONE = { sent: 'ok', failed: 'bad', skipped: '' } as const;

/** The owner's morning digest: preview, delivery channels, schedule and the outbox. */
export function Digest({ config, toast }: { config: Config; toast: (m: string) => void }) {
  const info = useLive(() => api.digest());
  const [ai, setAi] = useState(false);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [view, setView] = useState<'email' | 'text'>('email');
  const [busy, setBusy] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);

  const load = async (withAi = ai) => {
    setBusy('preview');
    try {
      setPreview(await api.digestPreview(withAi));
      setHistoryId(null);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  useEffect(() => {
    void load(false);
  }, []);

  const send = async () => {
    setBusy('send');
    try {
      const r = await api.sendDigest(ai);
      const sent = r.deliveries.filter((d) => d.status === 'sent').map((d) => d.channel);
      toast(`Digest sent: ${sent.join(', ')}`);
      info.reload();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const d = info.data;
  const local = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat('en-US', {
          timeZone: d?.schedule.timezone,
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }).format(new Date(iso))
      : '—';

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Digest</h2>
        <span className="muted">
          A short morning email (or Slack post) for the owner: what came in, what needs a decision, who to
          call. Approval links open a page with Approve and Reject buttons.
        </span>
        <span className="spacer" />
        {config.agentAvailable && (
          <label className="muted">
            <input
              type="checkbox"
              checked={ai}
              onChange={(e) => {
                setAi(e.target.checked);
                void load(e.target.checked);
              }}
            />{' '}
            Claude writes the opening
          </label>
        )}
        <button className="btn sm" onClick={() => load()} disabled={!!busy}>
          {busy === 'preview' ? 'Building…' : 'Refresh preview'}
        </button>
        <button className="btn primary sm" onClick={send} disabled={!!busy}>
          {busy === 'send' ? 'Sending…' : 'Send now'}
        </button>
      </div>
      <div className="digest-grid">
        <aside className="digest-side">
          <h3>Schedule</h3>
          {d ? (
            <p>
              {d.schedule.enabled ? (
                <>
                  Every {d.schedule.weekdaysOnly ? 'weekday' : 'day'} at <b>{d.schedule.time}</b>{' '}
                  {d.schedule.timezone.replace(/_/g, ' ')}.
                  <br />
                  <span className="muted">
                    Next {local(d.schedule.nextAt)} · last{' '}
                    {d.schedule.lastSentAt ? ago(d.schedule.lastSentAt) : 'never'}
                  </span>
                </>
              ) : (
                <span className="muted">Turned off (digest.enabled in retrofit.config.yaml).</span>
              )}
            </p>
          ) : (
            <p className="muted">Loading…</p>
          )}
          <h3>Delivery</h3>
          {d && (
            <ul className="plain">
              <li>
                Email{' '}
                {d.channels.email.configured ? (
                  <Pill tone="ok">to {d.channels.email.to.join(', ')}</Pill>
                ) : (
                  <Pill tone="">{d.channels.email.reason}</Pill>
                )}
              </li>
              <li>
                Slack{' '}
                {d.channels.slack.configured ? (
                  <Pill tone="ok">webhook set</Pill>
                ) : (
                  <Pill tone="">set RETROFIT_SLACK_WEBHOOK_URL</Pill>
                )}
              </li>
              <li>
                Console outbox <Pill tone="ok">always</Pill>
              </li>
            </ul>
          )}
          <h3>Sent</h3>
          <ul className="plain digest-history">
            {(d?.history ?? []).map((h) => (
              <li key={h.id}>
                <button
                  className={`linkish ${historyId === h.id ? 'on' : ''}`}
                  onClick={() => setHistoryId(h.id)}
                >
                  {new Date(h.createdAt).toLocaleString()}
                </button>{' '}
                <span className="muted small">{h.trigger}</span>
                <div className="small">
                  {h.deliveries.map((x) => (
                    <Pill key={x.channel} tone={STATUS_TONE[x.status]}>
                      {x.channel} {x.status}
                    </Pill>
                  ))}
                </div>
              </li>
            ))}
            {d && !d.history.length && <li className="muted">Nothing sent yet.</li>}
          </ul>
        </aside>
        <div className="digest-preview">
          <div className="digest-preview-head">
            <span className="muted small">Subject</span>
            <b>{historyId ? d?.history.find((h) => h.id === historyId)?.subject : preview?.subject}</b>
            <span className="spacer" />
            {!historyId && (
              <div className="segmented" role="group" aria-label="Format">
                <button aria-pressed={view === 'email'} onClick={() => setView('email')}>
                  Email
                </button>
                <button aria-pressed={view === 'text'} onClick={() => setView('text')}>
                  Text
                </button>
              </div>
            )}
            {historyId && (
              <button className="btn sm" onClick={() => setHistoryId(null)}>
                Back to today
              </button>
            )}
          </div>
          {historyId ? (
            <iframe title="Sent digest" src={api.digestHtmlUrl(historyId)} sandbox="allow-popups" />
          ) : !preview ? (
            <div className="empty">Building the digest…</div>
          ) : view === 'email' ? (
            <iframe
              title="Digest preview"
              srcDoc={preview.html.replace('<head>', '<head><base target="_blank">')}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
            />
          ) : (
            <pre className="digest-text">{preview.text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
