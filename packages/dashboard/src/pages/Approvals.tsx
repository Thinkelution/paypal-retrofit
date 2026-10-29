import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { ago, api, KIND_LABEL, type Action } from '../api';
import { ActionStatusCell, KindCell, Pill } from '../cells';
import { useLive } from '../hooks';

export function Approvals({ dark, toast }: { dark: boolean; toast: (m: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const { data, reload } = useLive(() => api.actions(showAll ? undefined : 'pending'), [showAll]);
  const [busy, setBusy] = useState<number | null>(null);

  const decide = async (a: Action, approve: boolean) => {
    setBusy(a.id);
    try {
      const r = approve ? await api.approve(a.id) : await api.reject(a.id);
      toast(
        `${KIND_LABEL[a.kind] ?? a.kind} for ${a.target.label}: ${r.status}${r.status === 'failed' ? ` (${r.result?.message})` : ''}`,
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };

  const approveAll = async () => {
    for (const a of (data ?? []).filter((x) => x.status === 'pending')) await decide(a, true);
  };

  const cols = useMemo<ColDef<Action>[]>(
    () => [
      { field: 'kind', headerName: 'Action', width: 170, cellRenderer: KindCell },
      {
        headerName: 'Target',
        width: 170,
        valueGetter: (p) => p.data?.target.label ?? p.data?.target.legacyPk,
      },
      { field: 'reason', flex: 1, minWidth: 260, tooltipField: 'reason', wrapText: true },
      {
        field: 'origin',
        headerName: 'Asked by',
        width: 110,
        cellRenderer: (p: any) => <Pill tone={p.value === 'agent' ? 'accent' : ''}>{p.value}</Pill>,
      },
      { field: 'status', width: 120, cellRenderer: ActionStatusCell },
      { field: 'createdAt', headerName: 'When', width: 110, valueFormatter: (p) => ago(p.value) },
      {
        headerName: '',
        width: 190,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data: Action }) =>
          p.data.status === 'pending' ? (
            <div className="actions-row" style={{ paddingTop: 6 }}>
              <button
                className="btn primary sm"
                disabled={busy === p.data.id}
                onClick={() => decide(p.data, true)}
              >
                Approve
              </button>
              <button className="btn sm" disabled={busy === p.data.id} onClick={() => decide(p.data, false)}>
                Reject
              </button>
            </div>
          ) : p.data.status === 'failed' ? (
            <span className="muted" title={p.data.result?.message}>
              {p.data.result?.message?.slice(0, 40)}
            </span>
          ) : null,
      },
    ],
    [busy],
  );

  const pending = (data ?? []).filter((a) => a.status === 'pending').length;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Approvals</h2>
        <span className="muted">
          Actions whose policy is “confirm” wait here. Nothing in PayPal changes until you approve.
        </span>
        <span className="spacer" />
        <label className="muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show
          history
        </label>
        {pending > 1 && (
          <button className="btn primary sm" onClick={approveAll}>
            Approve all {pending}
          </button>
        )}
      </div>
      <div className={`grid-wrap short ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
        <AgGridReact<Action>
          rowHeight={60}
          suppressAnimationFrame
          rowData={data ?? []}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => String(p.data.id)}
          overlayNoRowsTemplate={'<span class="muted">No actions waiting for approval.</span>'}
        />
      </div>
    </div>
  );
}
