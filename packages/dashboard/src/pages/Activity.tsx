import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo } from 'react';
import { ago, api, type EventRec } from '../api';
import { Pill } from '../cells';
import { useLive } from '../hooks';

export function Activity({ dark }: { dark: boolean }) {
  const { data } = useLive(() => api.events());
  const cols = useMemo<ColDef<EventRec>[]>(
    () => [
      {
        field: 'receivedAt',
        headerName: 'Received',
        width: 120,
        valueFormatter: (p) => ago(p.value),
        sort: 'desc',
      },
      { field: 'type', headerName: 'PayPal event', width: 260, cellClass: 'mono' },
      {
        field: 'status',
        width: 120,
        cellRenderer: (p: any) => (
          <Pill tone={p.value === 'processed' ? 'ok' : p.value === 'failed' ? 'bad' : ''}>{p.value}</Pill>
        ),
      },
      {
        field: 'summary',
        headerName: 'What retrofit did',
        flex: 1,
        minWidth: 280,
        wrapText: true,
        autoHeight: true,
      },
      { field: 'error', width: 200, hide: !(data ?? []).some((e) => e.error) },
      { field: 'id', headerName: 'Event id', width: 220, cellClass: 'mono' },
    ],
    [data],
  );
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Webhook activity</h2>
        <span className="muted">
          Every PayPal event is signature-checked, stored once, and applied to your system before PayPal is
          told it arrived.
        </span>
      </div>
      <div className={`grid-wrap short ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
        <AgGridReact<EventRec>
          rowData={data ?? []}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => p.data.id}
          overlayNoRowsTemplate={
            '<span class="muted">No webhooks yet. Pay an invoice to see one arrive.</span>'
          }
        />
      </div>
    </div>
  );
}
