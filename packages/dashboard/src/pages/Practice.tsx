import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import { ago, api, fmtMoney, type HostInfo, type PracticeRow } from '../api';
import { Pill } from '../cells';

/**
 * The bookkeeper's view: every client business on one screen, sorted by what needs attention, with a
 * way into each client's own console. Clients are added with the setup wizard.
 */
export function Practice({ dark, host, onBack }: { dark: boolean; host: HostInfo; onBack?: () => void }) {
  const [rows, setRows] = useState<PracticeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api
      .practice()
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const sum = (f: (r: PracticeRow) => number | undefined) =>
    (rows ?? []).reduce((t, r) => t + (f(r) ?? 0), 0);
  const cur = rows?.find((r) => r.currency)?.currency ?? 'USD';
  const multiCurrency = new Set((rows ?? []).map((r) => r.currency).filter(Boolean)).size > 1;

  const cols = useMemo<ColDef<PracticeRow>[]>(
    () => [
      {
        field: 'business',
        headerName: 'Client',
        flex: 1.4,
        minWidth: 200,
        pinned: 'left',
        cellRenderer: (p: any) => (
          <a href={p.data.consoleUrl} className="client-link">
            {p.value}
          </a>
        ),
      },
      {
        field: 'attention',
        headerName: 'Needs you',
        width: 135,
        sort: 'desc',
        cellRenderer: (p: any) =>
          p.data.error ? (
            <Pill tone="bad">error</Pill>
          ) : p.value ? (
            <Pill tone="warn">{p.value}</Pill>
          ) : (
            <Pill tone="ok">clear</Pill>
          ),
      },
      { field: 'pendingActions', headerName: 'Approvals', width: 110, type: 'numericColumn' },
      { field: 'requests', headerName: 'Asked', width: 90, type: 'numericColumn' },
      { field: 'discrepancies', headerName: 'Mismatches', width: 120, type: 'numericColumn' },
      {
        field: 'openAmount',
        headerName: 'Owed',
        width: 130,
        type: 'numericColumn',
        valueFormatter: (p) => fmtMoney(p.value, p.data?.currency),
      },
      {
        field: 'overdueAmount',
        headerName: 'Overdue',
        width: 130,
        type: 'numericColumn',
        valueFormatter: (p) => fmtMoney(p.value, p.data?.currency),
        cellClass: (p) => (p.value > 0 ? 'bad-text' : ''),
      },
      {
        field: 'expectedNext30',
        headerName: 'Next 30 days',
        width: 140,
        type: 'numericColumn',
        valueFormatter: (p) => fmtMoney(p.value, p.data?.currency),
      },
      {
        field: 'paidViaPayPalAmount',
        headerName: 'Via PayPal',
        width: 130,
        type: 'numericColumn',
        valueFormatter: (p) => fmtMoney(p.value, p.data?.currency),
      },
      {
        headerName: 'In PayPal',
        width: 110,
        valueGetter: (p) => (p.data?.invoices ? `${p.data.linked}/${p.data.invoices}` : ''),
      },
      { field: 'source', width: 100 },
      {
        field: 'environment',
        headerName: 'PayPal',
        width: 110,
        cellRenderer: (p: any) =>
          p.value ? <Pill tone={p.value === 'MOCK' ? 'info' : 'ok'}>{p.value.toLowerCase()}</Pill> : '',
      },
      {
        field: 'lastDigestAt',
        headerName: 'Last digest',
        width: 130,
        valueFormatter: (p) => (p.value ? ago(p.value) : 'never'),
      },
      {
        headerName: '',
        width: 110,
        sortable: false,
        filter: false,
        cellRenderer: (p: any) => (
          <a className="btn sm" href={p.data.consoleUrl}>
            Open
          </a>
        ),
      },
    ],
    [],
  );

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">R</div>
          <div>
            Retrofit <small>{host.mode === 'practice' ? 'practice' : 'all clients'}</small>
          </div>
        </div>
        <span className="spacer" />
        {onBack && (
          <button className="btn sm" onClick={onBack}>
            Back to the console
          </button>
        )}
        <a className="btn primary sm" href="#setup">
          Add a client
        </a>
      </header>
      <main className="content">
        <div className="setup-intro">
          <h1 style={{ fontSize: 24 }}>Every client, one screen</h1>
          <p className="muted">
            For bookkeepers and accountants who look after several small businesses. Each client keeps its own
            data, PayPal account, rules and morning digest; this view shows who needs you first.
          </p>
        </div>
        {error && <div className="callout">{error}</div>}
        <section className="kpis" aria-label="Totals across clients">
          <div className="kpi">
            <div className="label">Clients</div>
            <div className="value">{rows?.length ?? '—'}</div>
            <div className="sub">
              {rows?.filter((r) => (r.attention ?? 0) > 0).length ?? 0} need you today
            </div>
          </div>
          <div className="kpi">
            <div className="label">Owed to clients</div>
            <div className="value">
              {multiCurrency
                ? '—'
                : fmtMoney(
                    sum((r) => r.openAmount),
                    cur,
                  )}
            </div>
            <div className="sub">{multiCurrency ? 'several currencies' : 'across all clients'}</div>
          </div>
          <div className="kpi bad">
            <div className="label">Overdue</div>
            <div className="value">
              {multiCurrency
                ? '—'
                : fmtMoney(
                    sum((r) => r.overdueAmount),
                    cur,
                  )}
            </div>
            <div className="sub">{sum((r) => r.overdue)} invoices</div>
          </div>
          <div className="kpi warn">
            <div className="label">Waiting for approval</div>
            <div className="value">{sum((r) => r.pendingActions)}</div>
            <div className="sub">{sum((r) => r.requests)} customer requests</div>
          </div>
          <div className="kpi ok">
            <div className="label">Expected in 30 days</div>
            <div className="value">
              {multiCurrency
                ? '—'
                : fmtMoney(
                    sum((r) => r.expectedNext30),
                    cur,
                  )}
            </div>
            <div className="sub">
              {fmtMoney(
                sum((r) => r.atRisk),
                cur,
              )}{' '}
              at high risk
            </div>
          </div>
        </section>
        <div className={`grid-wrap short ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
          <AgGridReact<PracticeRow>
            rowHeight={48}
            suppressAnimationFrame
            rowData={rows ?? []}
            columnDefs={cols}
            defaultColDef={{ sortable: true, resizable: true, filter: true }}
            getRowId={(p) => p.data.id}
            overlayNoRowsTemplate={
              '<span class="muted">No clients yet. Add one with the setup wizard.</span>'
            }
          />
        </div>
        <p className="muted small">
          Each client also has its own morning digest, MCP endpoint (<code>/c/&lt;client&gt;/mcp</code>) and
          customer portal. Run this view for real with <code>paypal-retrofit practice --dir clients</code>.
        </p>
      </main>
    </div>
  );
}
