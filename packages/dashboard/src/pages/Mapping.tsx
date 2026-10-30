import type { CellValueChangedEvent, ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import { api, KIND_LABEL } from '../api';
import { Pill } from '../cells';

interface FieldRow {
  id: string;
  entity: string;
  field: string;
  table: string;
  column: string;
  required: boolean;
  path: string[];
  why: string;
}
interface StatusRow {
  id: string;
  entity: 'invoice' | 'subscription';
  value: string;
  meaning: string;
  push: boolean;
}

const INVOICE_FIELDS: Array<[string, string[], boolean]> = [
  ['number', ['fields', 'number'], true],
  ['customer', ['fields', 'customer'], true],
  ['total', ['fields', 'total'], true],
  ['status', ['fields', 'status'], true],
  ['issued', ['fields', 'issued'], false],
  ['due', ['fields', 'due'], false],
  ['notes', ['fields', 'notes'], false],
  ['write back: PayPal id', ['writeBack', 'paypalId'], false],
  ['write back: pay link', ['writeBack', 'payLink'], false],
  ['write back: status', ['writeBack', 'status'], false],
  ['write back: paid at', ['writeBack', 'paidAt'], false],
  ['write back: paid amount', ['writeBack', 'paidAmount'], false],
];

export function Mapping({
  dark,
  toast,
  load: loadFn = async () => {
    const [mapping, schema] = await Promise.all([api.mapping(), api.schema()]);
    return { mapping, schema };
  },
  save: saveFn = api.saveMapping,
  embedded = false,
}: {
  dark: boolean;
  toast: (m: string) => void;
  /** Where the mapping and schema come from (the setup wizard passes its own). */
  load?: () => Promise<{ mapping: any; schema: any }>;
  save?: (m: unknown) => Promise<any>;
  /** Inside the setup wizard: no panel title, a lighter save button. */
  embedded?: boolean;
}) {
  const [mapping, setMapping] = useState<any>(null);
  const [schema, setSchema] = useState<any>(null);
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [statuses, setStatuses] = useState<StatusRow[]>([]);
  const [policies, setPolicies] = useState<Array<{ kind: string; mode: string }>>([]);
  const [issues, setIssues] = useState<any[]>([]);
  const [dirty, setDirty] = useState(false);

  const load = async () => {
    const { mapping: m, schema: s } = await loadFn();
    setMapping(m);
    setSchema(s);
    setDirty(false);
  };
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!mapping) return;
    const e = mapping.entities;
    const why = (p: string) => mapping.rationale?.[p] ?? '';
    const rows: FieldRow[] = [];
    for (const [k, required] of [
      ['name', true],
      ['email', true],
      ['phone', false],
      ['line1', false],
      ['city', false],
      ['state', false],
      ['postal', false],
      ['country', false],
    ] as Array<[string, boolean]>) {
      rows.push({
        id: `customer.${k}`,
        entity: 'Customer',
        field: k,
        table: e.customer.table,
        column: e.customer.fields[k] ?? '',
        required,
        path: ['customer', 'fields', k],
        why: why(`customer.fields.${k}`) || (k === 'name' ? why('customer.table') : ''),
      });
    }
    for (const [label, p, required] of INVOICE_FIELDS) {
      rows.push({
        id: `invoice.${p.join('.')}`,
        entity: 'Invoice',
        field: label,
        table: e.invoice.table,
        column: e.invoice[p[0]!]?.[p[1]!] ?? '',
        required,
        path: ['invoice', ...p],
        why: why(`invoice.${p.join('.')}`) || (label === 'number' ? why('invoice.table') : ''),
      });
    }
    if (e.invoice.lines) {
      for (const k of ['description', 'qty', 'unitPrice', 'product']) {
        rows.push({
          id: `lines.${k}`,
          entity: 'Invoice line',
          field: k,
          table: e.invoice.lines.table,
          column: e.invoice.lines.fields[k] ?? '',
          required: k !== 'product',
          path: ['invoice', 'lines', 'fields', k],
          why: why(`invoice.lines.fields.${k}`),
        });
      }
    }
    if (e.subscription) {
      for (const k of ['customer', 'amount', 'title', 'startedAt', 'status']) {
        rows.push({
          id: `subscription.${k}`,
          entity: 'Subscription',
          field: k,
          table: e.subscription.table,
          column: e.subscription.fields[k] ?? '',
          required: ['customer', 'amount', 'status'].includes(k),
          path: ['subscription', 'fields', k],
          why: why(`subscription.fields.${k}`) || (k === 'amount' ? why('subscription.table') : ''),
        });
      }
    }
    setFields(rows);

    const table = (name: string) => schema?.tables?.find((t: any) => t.name === name);
    const inv = e.invoice;
    const invValues: string[] = table(inv.table)?.enums?.[inv.fields.status] ?? [
      ...inv.statusMap.open,
      ...inv.statusMap.paid,
      ...inv.statusMap.cancelled,
    ];
    const st: StatusRow[] = invValues.map((v) => ({
      id: `invoice:${v}`,
      entity: 'invoice',
      value: v,
      meaning: inv.statusMap.paid.includes(v)
        ? 'paid'
        : inv.statusMap.cancelled.includes(v)
          ? 'cancelled'
          : inv.statusMap.open.includes(v)
            ? 'open'
            : 'unmapped',
      push: inv.push.includes(v),
    }));
    if (e.subscription) {
      const s = e.subscription;
      const vals: string[] = table(s.table)?.enums?.[s.fields.status] ?? [
        ...s.statusMap.pending,
        ...s.statusMap.active,
        ...s.statusMap.cancelled,
      ];
      for (const v of vals) {
        st.push({
          id: `subscription:${v}`,
          entity: 'subscription',
          value: v,
          meaning: s.statusMap.active.includes(v)
            ? 'active'
            : s.statusMap.cancelled.includes(v)
              ? 'cancelled'
              : s.statusMap.pending.includes(v)
                ? 'pending'
                : 'unmapped',
          push: s.push.includes(v),
        });
      }
    }
    setStatuses(st);
    setPolicies(Object.keys(KIND_LABEL).map((k) => ({ kind: k, mode: mapping.policies?.[k] ?? '' })));
  }, [mapping, schema]);

  const columnsOf = (tableName: string) => [
    '',
    ...(schema?.tables?.find((t: any) => t.name === tableName)?.columns?.map((c: any) => c.name) ?? []),
  ];

  const fieldCols = useMemo<ColDef<FieldRow>[]>(
    () => [
      { field: 'entity', width: 120, rowGroup: false },
      {
        field: 'field',
        width: 170,
        cellRenderer: (p: any) => (
          <span>
            {p.value}
            {p.data.required ? <span className="muted"> *</span> : null}
          </span>
        ),
      },
      { field: 'table', width: 120, cellClass: 'mono' },
      {
        field: 'column',
        headerName: 'Column (click to change)',
        width: 210,
        editable: true,
        cellClass: 'mono',
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: (p: any) => ({ values: columnsOf(p.data.table) }),
        cellStyle: (p: any) => (p.data.required && !p.value ? { color: 'var(--bad)' } : null),
      },
      {
        field: 'why',
        headerName: 'Why (from the Mapper agent)',
        flex: 1,
        minWidth: 220,
        wrapText: true,
        cellClass: 'muted',
      },
    ],
    [schema],
  );

  const statusCols = useMemo<ColDef<StatusRow>[]>(
    () => [
      { field: 'entity', width: 110 },
      { field: 'value', headerName: 'Value in your system', width: 170, cellClass: 'mono' },
      {
        field: 'meaning',
        width: 140,
        editable: true,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: (p: any) => ({
          values:
            p.data.entity === 'invoice' ? ['open', 'paid', 'cancelled'] : ['pending', 'active', 'cancelled'],
        }),
        cellRenderer: (p: any) => (
          <Pill
            tone={
              { paid: 'ok', active: 'ok', open: 'info', pending: 'warn', cancelled: '', unmapped: 'bad' }[
                p.value as string
              ]
            }
          >
            {p.value}
          </Pill>
        ),
      },
      { field: 'push', headerName: 'Send to PayPal', width: 140, editable: true, cellDataType: 'boolean' },
    ],
    [],
  );

  const policyCols = useMemo<ColDef<{ kind: string; mode: string }>[]>(
    () => [
      { field: 'kind', headerName: 'Action', flex: 1, valueFormatter: (p) => KIND_LABEL[p.value] ?? p.value },
      {
        field: 'mode',
        headerName: 'Policy',
        width: 150,
        editable: true,
        cellEditor: 'agSelectCellEditor',
        cellEditorParams: { values: ['', 'auto', 'confirm', 'never'] },
        valueFormatter: (p) => p.value || 'default',
        cellRenderer: (p: any) => (
          <Pill tone={{ auto: 'ok', confirm: 'accent', never: 'bad' }[p.value as string]}>
            {p.value || 'default'}
          </Pill>
        ),
      },
    ],
    [],
  );

  const changed = (_e: CellValueChangedEvent) => setDirty(true);

  const save = async () => {
    const m = structuredClone(mapping);
    for (const f of fields) {
      let o: any = m.entities;
      for (const k of f.path.slice(0, -1)) o = o[k] ??= {};
      const last = f.path[f.path.length - 1]!;
      if (f.column) o[last] = f.column;
      else delete o[last];
    }
    const inv = m.entities.invoice;
    inv.statusMap = { open: [], paid: [], cancelled: [] };
    inv.push = [];
    if (m.entities.subscription) {
      m.entities.subscription.statusMap = { pending: [], active: [], cancelled: [] };
      m.entities.subscription.push = [];
    }
    for (const s of statuses) {
      const target = s.entity === 'invoice' ? inv : m.entities.subscription;
      if (!target || s.meaning === 'unmapped') continue;
      target.statusMap[s.meaning].push(s.value);
      if (s.push) target.push.push(s.value);
    }
    m.policies = Object.fromEntries(policies.filter((p) => p.mode).map((p) => [p.kind, p.mode]));
    m.generatedBy = `${mapping.generatedBy} + edited in dashboard`;
    try {
      const r = await saveFn(m);
      setIssues(r.issues ?? []);
      setMapping(r.mapping);
      setDirty(false);
      toast(embedded ? 'Changes kept' : 'Mapping saved');
    } catch (e: any) {
      setIssues(e.data?.issues ?? [{ level: 'error', path: '', message: e.message }]);
      toast('Mapping has errors; not saved');
    }
  };

  if (!mapping)
    return (
      <div className="panel">
        <div className="empty">Loading mapping…</div>
      </div>
    );
  const theme = dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz';
  return (
    <div className="panel">
      <div className="panel-head">
        {!embedded && <h2>Mapping</h2>}
        <span className="muted">
          How your tables become PayPal objects. Proposed by <b>{mapping.generatedBy}</b>. Retrofit never
          alters your schema; it only writes to the “write back” columns.
        </span>
        <span className="spacer" />
        <button className="btn sm" onClick={load} disabled={!dirty}>
          Discard
        </button>
        <button className="btn primary sm" onClick={save} disabled={!dirty}>
          {embedded ? 'Keep changes' : 'Save mapping'}
        </button>
      </div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {issues.length > 0 && (
          <div className="issues">
            {issues.map((i, n) => (
              <div key={n} className={`callout ${i.level === 'error' ? '' : 'info'}`}>
                <b>{i.level}</b> {i.path} {i.message}
              </div>
            ))}
          </div>
        )}
        <div className={theme} style={{ height: 460 }}>
          <AgGridReact<FieldRow>
            rowHeight={46}
            suppressAnimationFrame
            rowData={fields}
            columnDefs={fieldCols}
            getRowId={(p) => p.data.id}
            onCellValueChanged={changed}
            singleClickEdit
            stopEditingWhenCellsLoseFocus
            defaultColDef={{ resizable: true }}
          />
        </div>
        <div className="mapping-grid">
          <div className={theme} style={{ height: 300 }}>
            <AgGridReact<StatusRow>
              rowData={statuses}
              columnDefs={statusCols}
              getRowId={(p) => p.data.id}
              onCellValueChanged={changed}
              singleClickEdit
              stopEditingWhenCellsLoseFocus
              defaultColDef={{ resizable: true }}
            />
          </div>
          <div className={theme} style={{ height: 300 }}>
            <AgGridReact
              rowData={policies}
              columnDefs={policyCols}
              getRowId={(p) => p.data.kind}
              onCellValueChanged={changed}
              singleClickEdit
              stopEditingWhenCellsLoseFocus
              defaultColDef={{ resizable: true }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
