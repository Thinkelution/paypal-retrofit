import { useEffect, useState } from 'react';
import { ago, api, fmtMoney, type Config, type LedgerRow, type SetupStatus } from './api';
import { AgentPanel } from './components/AgentPanel';
import { DisputeDraft } from './components/DisputeDraft';
import { McpConnect } from './components/McpConnect';
import { RecordDrawer } from './components/RecordDrawer';
import { useDark, useLive, useToast } from './hooks';
import { Activity } from './pages/Activity';
import { Approvals } from './pages/Approvals';
import { Discrepancies } from './pages/Discrepancies';
import { Ledger } from './pages/Ledger';
import { Mapping } from './pages/Mapping';
import { Collections } from './pages/Collections';
import { Insights } from './pages/Insights';
import { Digest } from './pages/Digest';
import { Setup } from './pages/Setup';

type Tab =
  'ledger' | 'collections' | 'insights' | 'approvals' | 'digest' | 'discrepancies' | 'mapping' | 'activity';
const TABS: Tab[] = [
  'ledger',
  'collections',
  'insights',
  'approvals',
  'digest',
  'discrepancies',
  'mapping',
  'activity',
];
const tabFromHash = (): Tab => {
  const h = window.location.hash.slice(1) as Tab;
  return TABS.includes(h) ? h : 'ledger';
};

/** Opens the setup wizard when nothing is configured yet (or on #setup where the server allows it). */
export function App() {
  const dark = useDark();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [wantSetup, setWantSetup] = useState(() => window.location.hash === '#setup');
  useEffect(() => {
    api.setup
      .status()
      .then(setStatus)
      .catch((e) => setFailed((e as Error).message));
    const on = () => setWantSetup(window.location.hash === '#setup');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (failed)
    return (
      <div className="empty">
        <h3>Can't reach the retrofit server</h3>
        <p>{failed}</p>
      </div>
    );
  if (!status) return <div className="empty">Loading…</div>;
  if (!status.configured) return <Setup status={status} dark={dark} />;
  if (wantSetup && status.canSetup)
    return (
      <Setup
        status={status}
        dark={dark}
        onCancel={() => {
          window.location.hash = '';
          setWantSetup(false);
        }}
      />
    );
  return <Console dark={dark} canSetup={status.canSetup} />;
}

function Console({ dark, canSetup }: { dark: boolean; canSetup: boolean }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const setTab = (t: Tab) => {
    setTabState(t);
    window.history.replaceState(null, '', t === 'ledger' ? window.location.pathname : `#${t}`);
  };
  useEffect(() => {
    const on = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [selected, setSelected] = useState<LedgerRow | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentQ, setAgentQ] = useState<string | null>(null);
  const [dispute, setDispute] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const { msg, toast } = useToast();
  const summary = useLive(() => api.summary());
  const ledger = useLive(() => api.ledger());

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((e) => setConfigError((e as Error).message));
  }, []);
  useEffect(() => {
    if (selected && ledger.data) setSelected(ledger.data.find((r) => r.key === selected.key) ?? null);
  }, [ledger.data]);

  const refresh = () => {
    summary.reload();
    ledger.reload();
  };
  const ask = (q: string) => {
    setAgentQ(q);
    setAgentOpen(true);
    setSelected(null);
  };

  const runSync = async () => {
    setBusy('sync');
    try {
      const r = await api.sync();
      const done = r.results.filter((x: any) => x.action.status === 'executed').length;
      const pending = r.results.filter((x: any) => x.action.status === 'pending').length;
      const failed = r.results.filter((x: any) => x.action.status === 'failed').length;
      toast(
        r.plan.length === 0
          ? 'Already in sync. Nothing to send.'
          : `Sync: ${done} done${pending ? `, ${pending} waiting for approval` : ''}${failed ? `, ${failed} failed` : ''}.`,
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const runReconcile = async () => {
    setBusy('reconcile');
    try {
      const r = await api.reconcile();
      toast(
        `Checked ${r.checked} invoices. ${r.fixed.length ? `Repaired ${r.fixed.length}. ` : ''}${r.discrepancies} discrepanc${r.discrepancies === 1 ? 'y' : 'ies'} open.`,
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      refresh();
    }
  };

  if (configError)
    return (
      <div className="empty">
        <h3>Can't reach the retrofit server</h3>
        <p>{configError}</p>
      </div>
    );
  if (!config) return <div className="empty">Loading…</div>;
  const s = summary.data;
  const cur = config.currency;
  const nothingLinked = s && s.linked === 0;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            Retrofit <small>for {config.business.name}</small>
          </div>
        </div>
        <span className={`env ${config.environment}`} title="PayPal environment">
          {config.environment === 'MOCK' ? 'MOCK PAYPAL' : `PAYPAL ${config.environment}`}
        </span>
        <span className="spacer" />
        <span className="muted hide-sm" style={{ fontSize: 12 }}>
          Synced {ago(s?.lastSyncAt)} · webhook {ago(s?.lastWebhookAt)}
        </span>
        {config.demo && !config.demo.custom && (
          <a className="btn sm" href={config.demo.legacyAppPath} target="_blank" rel="noreferrer">
            Legacy app ↗
          </a>
        )}
        {canSetup && (
          <a className="btn sm" href="#setup">
            {config.demo ? 'Try your own data' : 'Setup'}
          </a>
        )}
        {config.demo?.mockPath && (
          <button
            className="btn sm"
            onClick={async () => {
              if (
                !confirm(
                  config.demo?.custom
                    ? 'Go back to the Fernhill demo? Your uploaded workspace stays on the server but is no longer shown.'
                    : 'Reset the demo? This reseeds Fernhill and clears PayPal mock data.',
                )
              )
                return;
              await api.resetDemo();
              if (config.demo?.custom) return window.location.reload();
              toast('Demo reset');
              refresh();
            }}
          >
            {config.demo.custom ? 'Back to Fernhill' : 'Reset demo'}
          </button>
        )}
        <button className="btn sm" onClick={runReconcile} disabled={!!busy}>
          {busy === 'reconcile' ? 'Reconciling…' : 'Reconcile'}
        </button>
        <button className="btn primary sm" onClick={runSync} disabled={!!busy}>
          {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </button>
      </header>

      <main className="content">
        {nothingLinked && (
          <div className="hero">
            <div>
              <h2>{config.business.name} is mapped. Nothing has been sent to PayPal yet.</h2>
              <p>
                {s.open} open invoices worth {fmtMoney(s.openAmount, cur)} are waiting, {s.overdue} of them
                overdue. Sync creates a PayPal invoice for the {s.readyToSend} that are ready (drafts stay
                put), emails each customer a pay link, and writes the link back into your system. Payments
                flow back automatically.
              </p>
            </div>
            <button className="btn primary" onClick={runSync} disabled={!!busy}>
              Send {s.readyToSend} invoices through PayPal
            </button>
          </div>
        )}

        <section className="kpis" aria-label="Totals">
          <div className="kpi clickable" onClick={() => setTab('ledger')}>
            <div className="label">Owed to you</div>
            <div className="value">{fmtMoney(s?.openAmount, cur)}</div>
            <div className="sub">{s?.open ?? 0} open invoices</div>
          </div>
          <div className={`kpi ${s && s.overdue > 0 ? 'bad' : ''}`}>
            <div className="label">Overdue</div>
            <div className="value">{fmtMoney(s?.overdueAmount, cur)}</div>
            <div className="sub">{s?.overdue ?? 0} invoices past due</div>
          </div>
          <div className="kpi ok">
            <div className="label">Collected via PayPal</div>
            <div className="value">{fmtMoney(s?.paidViaPayPalAmount, cur)}</div>
            <div className="sub">{s?.paidViaPayPal ?? 0} payments, written back automatically</div>
          </div>
          <div className="kpi clickable" onClick={() => setTab('insights')}>
            <div className="label">Expected in 30 days</div>
            <div className="value">{fmtMoney(s?.expectedNext30, cur)}</div>
            <div className="sub">
              {fmtMoney(s?.atRisk, cur)} at high risk · {s ? `${s.linked}/${s.invoices}` : '—'} in PayPal
            </div>
          </div>
          <div
            className={`kpi clickable ${s && s.discrepancies + s.pendingActions > 0 ? 'warn' : ''}`}
            onClick={() => setTab(s && s.pendingActions ? 'approvals' : 'discrepancies')}
          >
            <div className="label">Needs you</div>
            <div className="value">{s ? s.pendingActions + s.discrepancies : '—'}</div>
            <div className="sub">
              {s?.pendingActions ?? 0} approval{s?.pendingActions === 1 ? '' : 's'} · {s?.discrepancies ?? 0}{' '}
              mismatch{s?.discrepancies === 1 ? '' : 'es'}
            </div>
          </div>
        </section>

        <nav className="tabs" role="tablist">
          {(
            [
              ['ledger', 'Ledger', null],
              ['collections', 'Collections', null],
              ['insights', 'Insights', null],
              ['approvals', 'Approvals', (s?.pendingActions ?? 0) + (s?.scheduledActions ?? 0)],
              ['digest', 'Digest', null],
              ['discrepancies', 'Discrepancies', s?.discrepancies],
              ['mapping', 'Mapping', null],
              ['activity', 'Webhooks', null],
            ] as Array<[Tab, string, number | null | undefined]>
          ).map(([t, label, n]) => (
            <button key={t} className="tab" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {label}
              {n ? <span className="count hot">{n}</span> : null}
            </button>
          ))}
        </nav>

        {tab === 'ledger' && (
          <Ledger
            rows={ledger.data}
            config={config}
            dark={dark}
            onOpen={setSelected}
            toast={toast}
            onAsk={ask}
          />
        )}
        {tab === 'approvals' && (
          <Approvals
            dark={dark}
            toast={(m) => {
              toast(m);
              refresh();
            }}
          />
        )}
        {tab === 'discrepancies' && (
          <Discrepancies
            dark={dark}
            config={config}
            rows={ledger.data}
            toast={toast}
            onAsk={ask}
            onDraft={setDispute}
          />
        )}
        {tab === 'collections' && (
          <Collections
            dark={dark}
            config={config}
            lastRun={s?.lastCollectionsAt ?? null}
            toast={(m) => {
              toast(m);
              refresh();
            }}
            onAsk={ask}
          />
        )}
        {tab === 'insights' && <Insights dark={dark} config={config} />}
        {tab === 'digest' && <Digest config={config} toast={toast} />}
        {tab === 'mapping' && <Mapping dark={dark} toast={toast} />}
        {tab === 'activity' && <Activity dark={dark} />}

        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          paypal-retrofit · open source (MIT) · {config.source.kind} source · agents{' '}
          {config.agentAvailable ? `on (${config.model})` : 'off'} ·{' '}
          <button className="linkish" onClick={() => setMcpOpen(true)}>
            Connect Claude (MCP)
          </button>
        </p>
      </main>

      {selected && (
        <RecordDrawer
          row={selected}
          config={config}
          onClose={() => setSelected(null)}
          toast={toast}
          onAsk={ask}
          onChanged={refresh}
        />
      )}
      {dispute && <DisputeDraft disputeId={dispute} onClose={() => setDispute(null)} />}
      {mcpOpen && <McpConnect business={config.business.name} onClose={() => setMcpOpen(false)} />}
      {!agentOpen && (
        <button className="btn primary fab" onClick={() => setAgentOpen(true)}>
          Ask the agent
        </button>
      )}
      <AgentPanel
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        pending={agentQ}
        clearPending={() => setAgentQ(null)}
        available={config.agentAvailable}
        model={config.model}
        onChanged={refresh}
      />
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </div>
  );
}
