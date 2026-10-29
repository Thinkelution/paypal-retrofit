import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { ago, api, fmtMoney, type CollectionItem, type Config } from '../api';
import { Pill, RiskCell } from '../cells';
import { useLive } from '../hooks';

const DECISION: Record<CollectionItem['decision'], { label: string; tone: string }> = {
  remind: { label: 'Remind', tone: 'warn' },
  plan: { label: 'Offer plan', tone: 'accent' },
  escalate: { label: 'Call them', tone: 'bad' },
  hold: { label: 'Hold', tone: 'info' },
  wait: { label: 'Wait', tone: '' },
};

export function Collections(props: {
  dark: boolean;
  config: Config;
  toast: (m: string) => void;
  onAsk: (q: string) => void;
  lastRun: string | null;
}) {
  const { dark, config, toast, onAsk } = props;
  const { data, reload } = useLive(() => api.collections());
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState(config.agentAvailable);
  const cur = config.currency;
  const c = config.controls;

  const counts = useMemo(() => {
    const out: Record<string, number> = { remind: 0, plan: 0, escalate: 0, hold: 0, wait: 0 };
    for (const i of data ?? []) out[i.decision] = (out[i.decision] ?? 0) + 1;
    return out;
  }, [data]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.runCollections({ ai });
      const pending = r.proposed.filter((p) => p.action.status === 'pending').length;
      const scheduled = r.proposed.filter((p) => p.action.status === 'scheduled').length;
      const sent = r.proposed.filter((p) => p.action.status === 'executed').length;
      toast(
        r.proposed.length === 0
          ? 'Nothing to send today.'
          : `Queued ${r.proposed.length}: ${sent ? `${sent} sent, ` : ''}${pending} waiting for approval${scheduled ? `, ${scheduled} held for quiet hours` : ''}. ${r.writer === 'ai' ? 'Reminders written by Claude.' : 'Template reminders.'}`,
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };

  const cols = useMemo<ColDef<CollectionItem>[]>(
    () => [
      { field: 'number', headerName: 'Invoice', width: 120, pinned: 'left' },
      { field: 'customer', width: 160 },
      {
        field: 'amountDue',
        headerName: 'Due',
        width: 110,
        type: 'rightAligned',
        valueFormatter: (p) => fmtMoney(p.value, cur),
        cellClass: 'num',
      },
      {
        field: 'daysOverdue',
        headerName: 'Overdue',
        width: 100,
        valueFormatter: (p) => (p.value ? `${p.value}d` : '—'),
      },
      {
        field: 'decision',
        width: 130,
        cellRenderer: (p: any) => (
          <Pill tone={DECISION[p.value as CollectionItem['decision']].tone}>
            {DECISION[p.value as CollectionItem['decision']].label}
          </Pill>
        ),
      },
      { field: 'tone', width: 110, valueFormatter: (p) => p.value ?? '' },
      { field: 'reason', headerName: 'Why', flex: 1, minWidth: 300, wrapText: true, tooltipField: 'reason' },
      { field: 'remindersSent', headerName: 'Sent', width: 80 },
      { field: 'nextReminderOn', headerName: 'Next', width: 115, valueFormatter: (p) => p.value ?? '' },
      {
        field: 'risk',
        headerName: 'Risk',
        width: 120,
        cellRenderer: (p: any) => <RiskCell band={p.value} score={p.data?.score} />,
      },
      {
        headerName: '',
        width: 120,
        sortable: false,
        filter: false,
        cellRenderer: (p: { data: CollectionItem }) =>
          config.agentAvailable ? (
            <button
              className="btn sm"
              style={{ marginTop: 14 }}
              onClick={() =>
                onAsk(
                  `What should I do about ${p.data.number} (${p.data.customer})? The playbook says: ${p.data.reason}`,
                )
              }
            >
              Ask agent
            </button>
          ) : null,
      },
    ],
    [cur, config.agentAvailable],
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Collections</h2>
        <span className="muted">
          The playbook a careful bookkeeper follows every morning. Reminders still go through your approval
          rules.
        </span>
        <span className="spacer" />
        {config.agentAvailable && (
          <label className="muted">
            <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} /> Claude writes the
            reminders
          </label>
        )}
        <button className="btn primary sm" onClick={run} disabled={busy || !(counts.remind || counts.plan)}>
          {busy ? 'Queuing…' : `Run playbook (${(counts.remind ?? 0) + (counts.plan ?? 0)})`}
        </button>
      </div>
      <div className="playbook">
        <div className="playbook-steps">
          {c.collections.steps.map((s, i) => (
            <div key={i} className="pb-step">
              <b>Day {s.afterDaysOverdue}</b>
              <span>{s.tone} reminder</span>
            </div>
          ))}
          <div className="pb-step">
            <b>After that</b>
            <span>call the customer</span>
          </div>
        </div>
        <div className="playbook-meta">
          <span>
            At least <b>{c.collections.minDaysBetween} days</b> between reminders
          </span>
          {c.quietHours && (
            <span>
              Quiet hours{' '}
              <b>
                {c.quietHours.start}–{c.quietHours.end}
              </b>{' '}
              {c.quietHours.timezone.replace('_', ' ')}
              {c.quietHours.weekends ? ' and weekends' : ''} ·{' '}
              {c.quietNow ? (
                <Pill tone="info">quiet now: reminders wait</Pill>
              ) : (
                <Pill tone="ok">open now</Pill>
              )}
            </span>
          )}
          <span>Holds on disputes and promises to pay · offers a plan when a customer asks to split</span>
          {props.lastRun && <span className="muted">Last run {ago(props.lastRun)}</span>}
        </div>
        <div className="playbook-counts">
          {(['remind', 'plan', 'escalate', 'hold', 'wait'] as const).map((d) => (
            <span key={d}>
              <Pill tone={DECISION[d].tone}>{DECISION[d].label}</Pill> {counts[d] ?? 0}
            </span>
          ))}
        </div>
      </div>
      <div className={`grid-wrap ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
        <AgGridReact<CollectionItem>
          rowHeight={56}
          suppressAnimationFrame
          rowData={data ?? []}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => p.data.legacyPk}
          tooltipShowDelay={300}
          overlayNoRowsTemplate={'<span class="muted">No open PayPal invoices. Run Sync first.</span>'}
        />
      </div>
    </div>
  );
}
