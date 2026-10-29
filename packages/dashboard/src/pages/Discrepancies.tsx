import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { ago, api, DISCREPANCY_LABEL, type Config, type Discrepancy, type LedgerRow } from '../api';
import { humanize, Pill } from '../cells';
import { useLive } from '../hooks';

export function Discrepancies(props: {
  dark: boolean;
  config: Config;
  rows: LedgerRow[] | null;
  toast: (m: string) => void;
  onAsk: (q: string) => void;
  onDraft: (disputeId: string) => void;
}) {
  const { dark, rows, toast, onAsk, onDraft, config } = props;
  const [all, setAll] = useState(false);
  const { data, reload } = useLive(() => api.discrepancies(all), [all]);
  const label = (d: Discrepancy) =>
    rows?.find((r) => r.legacyPk === d.legacyPk && r.entity === d.entity)?.number ?? d.legacyPk ?? '—';

  const cols = useMemo<ColDef<Discrepancy>[]>(
    () => [
      {
        field: 'kind',
        headerName: 'Problem',
        width: 210,
        cellRenderer: (p: any) => (
          <Pill tone={p.value === 'dispute' ? 'bad' : 'warn'}>
            {DISCREPANCY_LABEL[p.value] ?? humanize(p.value)}
          </Pill>
        ),
      },
      { headerName: 'Record', width: 130, valueGetter: (p) => (p.data ? label(p.data) : '') },
      { field: 'detail', flex: 1, minWidth: 280, wrapText: true },
      {
        field: 'suggestion',
        headerName: 'Suggested fix',
        flex: 1,
        minWidth: 220,
        wrapText: true,
      },
      { field: 'detectedAt', headerName: 'Found', width: 100, valueFormatter: (p) => ago(p.value) },
      {
        headerName: '',
        width: 260,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data: Discrepancy }) =>
          p.data.resolvedAt ? (
            <span className="muted">{p.data.resolution}</span>
          ) : (
            <div className="actions-row" style={{ paddingTop: 6 }}>
              {p.data.kind === 'dispute' && config.agentAvailable && p.data.paypalId && (
                <button className="btn primary sm" onClick={() => onDraft(p.data.paypalId!)}>
                  Draft response
                </button>
              )}
              {config.agentAvailable && (
                <button
                  className="btn sm"
                  onClick={() =>
                    onAsk(`Explain this problem with ${label(p.data)} and what I should do: ${p.data.detail}`)
                  }
                >
                  Ask agent
                </button>
              )}
              <button
                className="btn sm"
                onClick={async () => {
                  await api.resolve(p.data.id, 'Resolved by a person');
                  toast('Marked resolved');
                  reload();
                }}
              >
                Resolve
              </button>
            </div>
          ),
      },
    ],
    [rows, config.agentAvailable],
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Discrepancies</h2>
        <span className="muted">
          Found by webhooks and reconciliation. Safe fixes (a payment PayPal saw) are applied automatically;
          these need a decision.
        </span>
        <span className="spacer" />
        <label className="muted">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Include resolved
        </label>
      </div>
      <div className={`grid-wrap short ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
        <AgGridReact<Discrepancy>
          rowHeight={60}
          suppressAnimationFrame
          rowData={data ?? []}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => String(p.data.id)}
          overlayNoRowsTemplate={
            '<span class="muted">Everything matches. Run Reconcile to check again.</span>'
          }
        />
      </div>
    </div>
  );
}
