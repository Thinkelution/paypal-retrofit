import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ago,
  api,
  BASE,
  fmtMoney,
  type Config,
  type HostInfo,
  type LedgerRow,
  type SetupStatus,
} from './api';
import { AgentPanel } from './components/AgentPanel';
import { CommandPalette, type Command } from './components/CommandPalette';
import { McpConnect } from './components/McpConnect';
import { NewInvoice } from './components/NewInvoice';
import { RecordDrawer } from './components/RecordDrawer';
import { Tour, tourDone } from './components/Tour';
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
import { Customers } from './pages/Customers';
import { Shop } from './pages/Shop';
import { Practice } from './pages/Practice';
import { Today } from './pages/Today';
import { GoLive } from './pages/GoLive';
import { Website } from './pages/Website';
import { Inbox } from './pages/Inbox';
import { Rules } from './pages/Rules';
import { Shadow } from './pages/Shadow';
import { Bills } from './pages/Bills';
import { Disputes } from './pages/Disputes';

type Tab =
  | 'today'
  | 'ledger'
  | 'collections'
  | 'insights'
  | 'discrepancies'
  | 'disputes'
  | 'bills'
  | 'customers'
  | 'inbox'
  | 'shop'
  | 'website'
  | 'approvals'
  | 'rules'
  | 'shadow'
  | 'digest'
  | 'golive'
  | 'mapping'
  | 'activity';

/** The console's pages, grouped the way an owner thinks about them. */
const NAV: Array<{ group: string; items: Array<[Tab, string]> }> = [
  { group: '', items: [['today', 'Today']] },
  {
    group: 'Money',
    items: [
      ['ledger', 'Invoices'],
      ['collections', 'Collections'],
      ['insights', 'Cash & risk'],
      ['discrepancies', 'Mismatches'],
      ['disputes', 'Disputes'],
      ['bills', 'Bills to pay'],
    ],
  },
  {
    group: 'Customers',
    items: [
      ['customers', 'Customers'],
      ['inbox', 'Inbox'],
      ['shop', 'Shop'],
      ['website', 'Website & QR'],
    ],
  },
  {
    group: 'Your call',
    items: [
      ['approvals', 'Approvals'],
      ['rules', 'Rules'],
      ['shadow', 'Shadow mode'],
      ['digest', 'Morning digest'],
    ],
  },
  {
    group: 'Set-up',
    items: [
      ['golive', 'Go live'],
      ['mapping', 'Data mapping'],
      ['activity', 'Webhooks'],
    ],
  },
];
const TABS = NAV.flatMap((g) => g.items.map(([t]) => t));
const TITLE = Object.fromEntries(NAV.flatMap((g) => g.items)) as Record<Tab, string>;
const tabFromHash = (): Tab => {
  const h = window.location.hash.slice(1) as Tab;
  return TABS.includes(h) ? h : 'today';
};

/** Opens the setup wizard when nothing is configured yet (or on #setup where the server allows it). */
export function App() {
  const dark = useDark();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [host, setHost] = useState<HostInfo | null>(null);
  const [wantSetup, setWantSetup] = useState(() => window.location.hash === '#setup');
  const [wantPractice, setWantPractice] = useState(() => window.location.hash === '#practice');
  useEffect(() => {
    api.setup
      .status()
      .then(setStatus)
      .catch((e) => setFailed((e as Error).message));
    api
      .host()
      .then(setHost)
      .catch(() => setHost({ mode: 'single', workspaces: [] }));
    const on = () => {
      setWantSetup(window.location.hash === '#setup');
      setWantPractice(window.location.hash === '#practice');
    };
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
  if (!status || !host) return <div className="empty">Loading…</div>;
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
  // A bookkeeper's practice has no single business at the root: show every client.
  if ((host.mode === 'practice' && !BASE) || wantPractice)
    return (
      <Practice
        dark={dark}
        host={host}
        onBack={
          host.mode === 'practice' && !BASE
            ? undefined
            : () => {
                window.location.hash = '';
                setWantPractice(false);
              }
        }
      />
    );
  return <Console dark={dark} canSetup={status.canSetup} host={host} />;
}

function Console({ dark, canSetup, host }: { dark: boolean; canSetup: boolean; host: HostInfo }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [navOpen, setNavOpen] = useState(false);
  const setTab = (t: Tab) => {
    setTabState(t);
    setNavOpen(false);
    window.history.replaceState(null, '', t === 'today' ? window.location.pathname : `#${t}`);
    window.scrollTo({ top: 0 });
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newInvoice, setNewInvoice] = useState<{ text?: string; mode?: 'say' | 'snap' | 'form' } | null>(
    null,
  );
  const [touring, setTouring] = useState(false);
  const { msg, toast } = useToast();
  const summary = useLive(() => api.summary());
  const ledger = useLive(() => api.ledger());
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch((e) => setConfigError((e as Error).message));
  }, []);
  useEffect(() => {
    if (selected && ledger.data) setSelected(ledger.data.find((r) => r.key === selected.key) ?? null);
  }, [ledger.data]);
  // Ctrl+K / Cmd+K opens the command palette; N starts a new invoice.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => !menu.current?.contains(e.target as Node) && setMenuOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menuOpen]);
  // First visit: a short tour (not under automation, so screenshots stay clean; ?tour=1 forces it).
  useEffect(() => {
    if (!config) return;
    const forced = new URLSearchParams(window.location.search).has('tour');
    if (forced || (!tourDone() && !navigator.webdriver && tab === 'today'))
      setTimeout(() => setTouring(true), 600);
  }, [config]);

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
  const runCollections = async () => {
    setBusy('collections');
    try {
      const r = await api.runCollections({ ai: config?.agentAvailable });
      const all = [
        ...r.proposed.map((p) => p.action),
        ...((r as any).autopay ?? []),
        ...((r as any).terms ?? []),
      ];
      const ran = all.filter((a) => a.status === 'executed').length;
      const waiting = all.filter((a) => a.status === 'pending').length;
      const later = all.filter((a) => a.status === 'scheduled').length;
      toast(
        all.length
          ? `Collections: ${ran} done${waiting ? `, ${waiting} waiting for your OK` : ''}${later ? `, ${later} held for business hours` : ''}.`
          : 'Nothing is due.',
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
  const resetDemo = async () => {
    if (!confirm('Reset the demo? This reseeds Fernhill and Brightside and clears PayPal mock data.')) return;
    await api.resetDemo();
    toast('Demo reset');
    refresh();
  };

  const s = summary.data;
  const badges: Partial<Record<Tab, number>> = {
    approvals: (s?.pendingActions ?? 0) + (s?.scheduledActions ?? 0),
    discrepancies: s?.discrepancies ?? 0,
  };
  const commands = useMemo<Command[]>(() => {
    if (!config) return [];
    const go: Command[] = TABS.map((t) => ({
      id: `go-${t}`,
      group: 'Go to',
      label: TITLE[t],
      keywords: t,
      run: () => setTab(t),
    }));
    const doIt: Command[] = [
      {
        id: 'new',
        group: 'Do',
        label: 'New invoice',
        keywords: 'create bill add',
        run: () => setNewInvoice({}),
      },
      {
        id: 'snap',
        group: 'Do',
        label: 'New invoice from a photo of a job sheet',
        keywords: 'snap camera picture paper',
        run: () => setNewInvoice({ mode: 'snap' }),
      },
      { id: 'sync', group: 'Do', label: 'Sync now', keywords: 'send paypal', run: runSync },
      {
        id: 'collections',
        group: 'Do',
        label: 'Run collections',
        keywords: 'reminders chase autopay late fees',
        run: runCollections,
      },
      {
        id: 'reconcile',
        group: 'Do',
        label: 'Reconcile with PayPal',
        keywords: 'check repair mismatch',
        run: runReconcile,
      },
      {
        id: 'statements',
        group: 'Do',
        label: 'Send statements to customers with a balance',
        keywords: 'statement email',
        run: async () => {
          const r = await api.runStatements();
          toast(`${r.length} statement${r.length === 1 ? '' : 's'} queued.`);
        },
      },
      {
        id: 'rules',
        group: 'Do',
        label: 'Change my rules in plain English',
        keywords: 'policy approve limit quiet hours late fee',
        run: () => setTab('rules'),
      },
      {
        id: 'shadow',
        group: 'Do',
        label: 'Replay the last 90 days with my rules (shadow mode)',
        keywords: 'simulate what if test',
        run: () => setTab('shadow'),
      },
      {
        id: 'email',
        group: 'Do',
        label: 'Read a customer email',
        keywords: 'inbox mail promise cheque',
        run: () => setTab('inbox'),
      },
      {
        id: 'bills',
        group: 'Do',
        label: 'Pay suppliers with PayPal',
        keywords: 'bills payouts contractors vendors',
        run: () => setTab('bills'),
      },
      {
        id: 'mcp',
        group: 'Do',
        label: 'Connect Claude (MCP)',
        keywords: 'assistant claude desktop code',
        run: () => setMcpOpen(true),
      },
      {
        id: 'tour',
        group: 'Do',
        label: 'Take the tour',
        keywords: 'help guide',
        run: () => {
          setTab('today');
          setTimeout(() => setTouring(true), 200);
        },
      },
      ...(canSetup
        ? [
            {
              id: 'setup',
              group: 'Do' as const,
              label: config.demo ? 'Try your own data' : 'Setup',
              keywords: 'wizard upload csv excel google sheet',
              run: () => (window.location.href = '/#setup'),
            },
          ]
        : []),
      ...(host.workspaces.length > 1
        ? host.workspaces.map((w) => ({
            id: `client-${w.id}`,
            group: 'Go to' as const,
            label: `Client: ${w.business}`,
            keywords: 'switch client business',
            run: () => (window.location.href = w.consoleUrl),
          }))
        : []),
      ...(config.demo?.mockPath && !config.demo.custom
        ? [{ id: 'reset', group: 'Do' as const, label: 'Reset the demo', run: resetDemo }]
        : []),
    ];
    const askIt: Command[] = [
      'Which invoices are more than two weeks overdue?',
      'How much should I expect to collect in the next 30 days?',
      'Who are my slowest-paying customers?',
    ].map((q, i) => ({ id: `ask-${i}`, group: 'Ask', label: q, run: () => ask(q) }));
    return [...go, ...doIt, ...askIt];
  }, [config, host]);

  if (configError)
    return (
      <div className="empty">
        <h3>Can't reach the retrofit server</h3>
        <p>{configError}</p>
      </div>
    );
  if (!config) return <div className="empty">Loading…</div>;
  const cur = config.currency;
  const nothingLinked = s && s.linked === 0;

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''}`}>
      <aside className="sidenav" aria-label="Pages">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            Retrofit <small>for {config.business.name}</small>
          </div>
        </div>
        {host.workspaces.length > 1 && (
          <select
            className="search client-switch"
            aria-label="Switch client"
            value={
              host.workspaces.find((w) => (BASE ? w.consoleUrl === `${BASE}/` : w.default))?.consoleUrl ?? ''
            }
            onChange={(e) => {
              window.location.href = e.target.value === '#practice' ? '/#practice' : e.target.value;
            }}
          >
            {host.workspaces.map((w) => (
              <option key={w.id} value={w.consoleUrl}>
                {w.business}
              </option>
            ))}
            <option value="#practice">All clients…</option>
          </select>
        )}
        <button className="btn primary block" onClick={() => setNewInvoice({})}>
          + New invoice
        </button>
        <nav data-tour="nav">
          {NAV.map((g) => (
            <div key={g.group || 'home'} className="nav-group">
              {g.group && <div className="nav-label">{g.group}</div>}
              {g.items.map(([t, label]) => (
                <button
                  key={t}
                  className="nav-item"
                  aria-current={tab === t ? 'page' : undefined}
                  onClick={() => setTab(t)}
                >
                  <span>{label}</span>
                  {badges[t] ? <span className="count hot">{badges[t]}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidenav-foot">
          <span className={`env ${config.environment}`} title="PayPal environment">
            {config.environment === 'MOCK' ? 'PAYPAL SIMULATOR' : `PAYPAL ${config.environment}`}
          </span>
          <span className="muted">
            Synced {ago(s?.lastSyncAt)} · webhook {ago(s?.lastWebhookAt)}
          </span>
          <button className="linkish" onClick={() => setMcpOpen(true)}>
            Connect Claude (MCP)
          </button>
        </div>
      </aside>
      <div className="overlay nav-overlay" onClick={() => setNavOpen(false)} />

      <div className="main">
        <header className="topbar">
          <button className="btn ghost sm menu-btn" aria-label="Menu" onClick={() => setNavOpen(true)}>
            ☰
          </button>
          <h1 className="page-title">{TITLE[tab]}</h1>
          <span className="spacer" />
          <button className="search-btn" onClick={() => setPaletteOpen(true)} data-tour="search">
            <span>Search, do or ask…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <button className="btn sm hide-sm" onClick={runSync} disabled={!!busy}>
            {busy === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
          <div className="menu" ref={menu}>
            <button
              className="btn sm"
              aria-label="More"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              ⋯
            </button>
            {menuOpen && (
              <div className="menu-list" role="menu" onClick={() => setMenuOpen(false)}>
                <button role="menuitem" className="show-sm" onClick={runSync}>
                  Sync now
                </button>
                <button role="menuitem" onClick={runReconcile}>
                  Reconcile with PayPal
                </button>
                <button role="menuitem" onClick={runCollections}>
                  Run collections
                </button>
                {config.demo && !config.demo.custom && (
                  <>
                    <a role="menuitem" href={config.demo.legacyAppPath} target="_blank" rel="noreferrer">
                      Legacy app ↗
                    </a>
                    <a role="menuitem" href={`${BASE}/site`} target="_blank" rel="noreferrer">
                      Business website ↗
                    </a>
                  </>
                )}
                {canSetup && (
                  <a role="menuitem" href="/#setup">
                    {config.demo ? 'Try your own data' : host.mode === 'practice' ? 'Add a client' : 'Setup'}
                  </a>
                )}
                <button role="menuitem" onClick={() => setTouring(true)}>
                  Take the tour
                </button>
                {config.demo?.mockPath && !config.demo.custom && (
                  <button role="menuitem" onClick={resetDemo}>
                    Reset demo
                  </button>
                )}
              </div>
            )}
          </div>
        </header>

        <main className="content">
          {tab === 'today' && (
            <Today
              config={config}
              busy={busy}
              onGo={(t) => setTab(t as Tab)}
              onRun={(w) => (w === 'sync' ? runSync() : runCollections())}
              onNewInvoice={(mode) => setNewInvoice({ mode })}
              onAsk={ask}
            />
          )}
          {tab === 'ledger' && (
            <>
              {nothingLinked && (
                <div className="hero">
                  <div>
                    <h2>{config.business.name} is mapped. Nothing has been sent to PayPal yet.</h2>
                    <p>
                      {s.open} open invoices worth {fmtMoney(s.openAmount, cur)} are waiting, {s.overdue} of
                      them overdue. Sync creates a PayPal invoice for the {s.readyToSend} that are ready
                      (drafts stay put), emails each customer a pay link, and writes the link back into your
                      system. Payments flow back automatically.
                    </p>
                  </div>
                  <button className="btn primary" onClick={runSync} disabled={!!busy}>
                    Send {s.readyToSend} invoices through PayPal
                  </button>
                </div>
              )}
              <section className="kpis" aria-label="Totals">
                <div className="kpi">
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
                    {fmtMoney(s?.atRisk, cur)} at high risk · {s ? `${s.linked}/${s.invoices}` : '—'} in
                    PayPal
                  </div>
                </div>
                <div
                  className={`kpi clickable ${s && s.discrepancies + s.pendingActions > 0 ? 'warn' : ''}`}
                  onClick={() => setTab(s && s.pendingActions ? 'approvals' : 'discrepancies')}
                >
                  <div className="label">Needs you</div>
                  <div className="value">{s ? s.pendingActions + s.discrepancies : '—'}</div>
                  <div className="sub">
                    {s?.pendingActions ?? 0} approval{s?.pendingActions === 1 ? '' : 's'} ·{' '}
                    {s?.discrepancies ?? 0} mismatch{s?.discrepancies === 1 ? '' : 'es'}
                  </div>
                </div>
              </section>
              <Ledger
                rows={ledger.data}
                config={config}
                dark={dark}
                onOpen={setSelected}
                toast={toast}
                onAsk={ask}
              />
            </>
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
              onDraft={(id) => {
                setDispute(id);
                setTab('disputes');
              }}
            />
          )}
          {tab === 'disputes' && (
            <Disputes config={config} rows={ledger.data} initial={dispute} toast={toast} />
          )}
          {tab === 'bills' && (
            <Bills
              config={config}
              toast={(m) => {
                toast(m);
                refresh();
              }}
              onGo={(t) => setTab(t as Tab)}
            />
          )}
          {tab === 'inbox' && <Inbox toast={toast} onGo={(t) => setTab(t as Tab)} />}
          {tab === 'rules' && <Rules toast={toast} />}
          {tab === 'shadow' && <Shadow config={config} onGo={(t) => setTab(t as Tab)} />}
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
          {tab === 'customers' && (
            <Customers
              dark={dark}
              config={config}
              toast={(m) => {
                toast(m);
                refresh();
              }}
            />
          )}
          {tab === 'shop' && <Shop dark={dark} config={config} toast={toast} />}
          {tab === 'website' && <Website config={config} />}
          {tab === 'golive' && <GoLive onGo={(t) => setTab(t as Tab)} toast={toast} />}
          {tab === 'mapping' && <Mapping dark={dark} toast={toast} />}
          {tab === 'activity' && <Activity dark={dark} />}

          <p className="muted foot">
            paypal-retrofit · open source (MIT) · {config.source.kind} source · agents{' '}
            {config.agentAvailable ? `on (${config.model})` : 'off'}
          </p>
        </main>
      </div>

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
      {newInvoice && (
        <NewInvoice
          initialText={newInvoice.text}
          initialMode={newInvoice.mode}
          onClose={() => setNewInvoice(null)}
          onDone={(r) => {
            toast(`${r.number} added${r.paypal ? ' and sent through PayPal' : ''}.`);
            refresh();
          }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          onClose={() => setPaletteOpen(false)}
          onAsk={ask}
          onInvoice={(text) => setNewInvoice({ text })}
        />
      )}
      {touring && <Tour onClose={() => setTouring(false)} />}
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
