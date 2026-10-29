import type { ColDef, GridApi, RowClassParams, SelectionChangedEvent } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useRef, useState } from 'react';
import { api, fmtMoney, type Config, type LedgerRow } from '../api';
import { LegacyStatusCell, OverdueCell, PayPalStatusCell, SyncCell, RiskCell } from '../cells';

type View = 'all' | 'open' | 'overdue' | 'attention' | 'paid' | 'subscriptions';

export function Ledger(props: {
  rows: LedgerRow[] | null;
  config: Config;
  dark: boolean;
  onOpen: (row: LedgerRow) => void;
  toast: (m: string) => void;
  onAsk: (q: string) => void;
}) {
  const { rows, config, dark, onOpen, toast } = props;
  const [view, setView] = useState<View>('open');
  const [quick, setQuick] = useState('');
  const [selected, setSelected] = useState<LedgerRow[]>([]);
  const grid = useRef<GridApi<LedgerRow> | null>(null);
  const cur = config.currency;

  const filtered = useMemo(() => {
    const r = rows ?? [];
    switch (view) {
      case 'open':
        return r.filter((x) => x.entity === 'invoice' && x.legacyState === 'open');
      case 'overdue':
        return r.filter((x) => (x.daysOverdue ?? 0) > 0);
      case 'attention':
        return r.filter((x) => x.discrepancies.length > 0 || x.pendingActions > 0);
      case 'paid':
        return r.filter((x) => x.entity === 'invoice' && x.legacyState === 'paid');
      case 'subscriptions':
        return r.filter((x) => x.entity === 'subscription');
      default:
        return r;
    }
  }, [rows, view]);

  const cols = useMemo<ColDef<LedgerRow>[]>(
    () => [
      {
        headerName: '',
        checkboxSelection: (p) =>
          !!p.data?.paypalId && p.data.entity === 'invoice' && p.data.legacyState === 'open',
        headerCheckboxSelection: true,
        headerCheckboxSelectionFilteredOnly: true,
        width: 44,
        pinned: 'left',
        sortable: false,
        filter: false,
        resizable: false,
      },
      {
        field: 'number',
        headerName: 'Invoice',
        pinned: 'left',
        width: 150,
        cellClass: 'num',
        filter: 'agTextColumnFilter',
      },
      { field: 'customer', flex: 1, minWidth: 160, filter: 'agTextColumnFilter' },
      {
        field: 'legacyTotal',
        headerName: 'Amount',
        width: 120,
        type: 'rightAligned',
        valueFormatter: (p) => fmtMoney(p.value, cur),
        filter: 'agNumberColumnFilter',
        cellClass: 'num',
      },
      {
        field: 'legacyStatus',
        headerName: 'Your system',
        width: 130,
        cellRenderer: LegacyStatusCell,
        filter: 'agTextColumnFilter',
      },
      {
        field: 'paypalStatus',
        headerName: 'PayPal',
        width: 150,
        cellRenderer: PayPalStatusCell,
        filter: 'agTextColumnFilter',
      },
      {
        field: 'daysOverdue',
        headerName: 'Overdue',
        width: 110,
        cellRenderer: OverdueCell,
        filter: 'agNumberColumnFilter',
        sort: view === 'overdue' ? 'desc' : undefined,
      },
      {
        field: 'riskScore',
        headerName: 'Risk',
        width: 120,
        cellRenderer: (p: any) => <RiskCell band={p.data?.riskBand} score={p.value} />,
        tooltipValueGetter: (p) => p.data?.riskFactors.join('\n'),
        filter: 'agNumberColumnFilter',
      },
      {
        field: 'expectedPayDate',
        headerName: 'Expected',
        width: 115,
        valueFormatter: (p) =>
          p.data?.plan ? `plan ${p.data.plan.covered}/${p.data.plan.installments}` : (p.value ?? ''),
      },
      {
        headerName: 'Sync',
        width: 190,
        cellRenderer: SyncCell,
        valueGetter: (p) => (p.data?.discrepancies.length ? 2 : p.data?.pendingActions ? 1 : 0),
        filter: false,
      },
      {
        field: 'paypalPaid',
        headerName: 'Received',
        width: 120,
        type: 'rightAligned',
        valueFormatter: (p) => (p.value ? fmtMoney(p.value, cur) : ''),
        cellClass: 'num',
        filter: 'agNumberColumnFilter',
      },
      {
        field: 'paypalPaidAt',
        headerName: 'Paid on',
        width: 120,
        filter: 'agDateColumnFilter',
        valueFormatter: (p) => (p.value ? String(p.value).slice(0, 10) : ''),
      },
      { field: 'due', headerName: 'Due', width: 115, filter: 'agDateColumnFilter' },
      { field: 'paypalId', headerName: 'PayPal id', width: 220, cellClass: 'mono', hide: false },
      { field: 'customerEmail', headerName: 'Email', width: 220, hide: true },
    ],
    [cur, view],
  );

  const remind = async () => {
    const pks = selected.map((s) => s.legacyPk);
    const out = await api.propose({
      kind: 'send_reminder',
      entity: 'invoice',
      legacyPks: pks,
      reason: 'Reminder requested from the ledger',
    });
    const executed = out.filter((a) => a.status === 'executed').length;
    const pending = out.filter((a) => a.status === 'pending').length;
    toast(
      `${executed ? `${executed} reminder(s) sent. ` : ''}${pending ? `${pending} waiting for approval.` : ''}` ||
        'Nothing to do',
    );
    grid.current?.deselectAll();
  };

  const counts = useMemo(() => {
    const r = rows ?? [];
    return {
      open: r.filter((x) => x.entity === 'invoice' && x.legacyState === 'open').length,
      overdue: r.filter((x) => (x.daysOverdue ?? 0) > 0).length,
      attention: r.filter((x) => x.discrepancies.length > 0 || x.pendingActions > 0).length,
      subs: r.filter((x) => x.entity === 'subscription').length,
    };
  }, [rows]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Ledger</h2>
        <div className="segmented" role="group" aria-label="View">
          {(
            [
              ['open', `Open ${counts.open}`],
              ['overdue', `Overdue ${counts.overdue}`],
              ['attention', `Needs attention ${counts.attention}`],
              ['paid', 'Paid'],
              ['subscriptions', `Retainers ${counts.subs}`],
              ['all', 'All'],
            ] as Array<[View, string]>
          ).map(([v, label]) => (
            <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {selected.length > 0 && (
          <button className="btn primary sm" onClick={remind}>
            Send {selected.length} reminder{selected.length > 1 ? 's' : ''}
          </button>
        )}
        <input
          className="search"
          placeholder="Search invoices, customers, ids…"
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          aria-label="Search"
        />
        <button
          className="btn sm hide-sm"
          onClick={() => grid.current?.exportDataAsCsv({ fileName: 'retrofit-ledger.csv' })}
        >
          Export CSV
        </button>
      </div>
      <div className={`grid-wrap ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
        <AgGridReact<LedgerRow>
          rowData={filtered}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true, floatingFilter: false }}
          getRowId={(p) => p.data.key}
          quickFilterText={quick}
          rowSelection="multiple"
          suppressRowClickSelection
          animateRows
          pagination
          paginationPageSize={50}
          paginationPageSizeSelector={[25, 50, 100]}
          tooltipShowDelay={300}
          onGridReady={(e) => (grid.current = e.api)}
          onSelectionChanged={(e: SelectionChangedEvent<LedgerRow>) => setSelected(e.api.getSelectedRows())}
          onRowClicked={(e) => e.data && onOpen(e.data)}
          getRowClass={(p: RowClassParams<LedgerRow>) =>
            p.data?.discrepancies.some((d) => /mismatch|dispute|refund/.test(d))
              ? 'row-mismatch'
              : p.data?.discrepancies.length || p.data?.pendingActions
                ? 'row-attention'
                : undefined
          }
          overlayNoRowsTemplate={'<span class="muted">Nothing here. Try another view, or run Sync.</span>'}
        />
      </div>
    </div>
  );
}
