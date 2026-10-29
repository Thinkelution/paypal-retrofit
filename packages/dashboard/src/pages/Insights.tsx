import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  fmtMoney,
  type Config,
  type CustomerProfile,
  type Insights as InsightsData,
  type InvoiceRisk,
  type MonthSummary,
} from '../api';
import { Pill, RiskCell } from '../cells';
import { useLive } from '../hooks';

const short = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

function ForecastChart({ data, currency }: { data: InsightsData['forecast']; currency: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  // Draw at the container's real pixel width so text keeps its size on wide screens.
  const boxRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [asTable]);
  const H = 240;
  const pad = { l: 56, r: 12, t: 22, b: 28 };
  const max = Math.max(1, ...data.weeks.map((w) => w.expected));
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const iw = (W - pad.l - pad.r) / data.weeks.length;
  const bw = Math.min(46, iw * 0.62);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const peak = data.weeks.reduce((m, w, i) => (w.expected > (data.weeks[m]?.expected ?? 0) ? i : m), 0);
  const money = (v: number) => fmtMoney(v, currency);

  if (asTable)
    return (
      <div>
        <div className="chart-head">
          <Legend />
          <button className="btn sm" onClick={() => setAsTable(false)}>
            Show chart
          </button>
        </div>
        <div className="table-scroll">
          <table className="plain">
            <thead>
              <tr>
                <th>Week</th>
                <th>Invoices</th>
                <th>Retainers</th>
                <th>Expected</th>
              </tr>
            </thead>
            <tbody>
              {data.weeks.map((w) => (
                <tr key={w.start}>
                  <td>
                    {short(w.start)}–{short(w.end)}
                  </td>
                  <td className="num">{money(w.fromInvoices)}</td>
                  <td className="num">{money(w.fromSubscriptions)}</td>
                  <td className="num">
                    <b>{money(w.expected)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );

  const hw = hover !== null ? data.weeks[hover] : null;
  return (
    <div className="chart">
      <div className="chart-head">
        <Legend />
        <button className="btn sm" onClick={() => setAsTable(true)}>
          Show as table
        </button>
      </div>
      <div className="chart-box" ref={boxRef}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Expected cash per week for the next ${data.weeks.length} weeks. Peak week ${short(data.weeks[peak]!.start)}: ${money(data.weeks[peak]!.expected)}.`}
          onMouseLeave={() => setHover(null)}
        >
          {Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step).map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="axis">
                {compact(v)}
              </text>
            </g>
          ))}
          {data.weeks.map((w, i) => {
            const x = pad.l + i * iw + (iw - bw) / 2;
            const hInv = y(0) - y(w.fromInvoices);
            const hSub = y(0) - y(w.fromSubscriptions);
            const gap = hInv > 0 && hSub > 0 ? 2 : 0;
            const r = 4;
            return (
              <g key={w.start}>
                {hInv > 0 && (
                  <path
                    d={bar(x, y(0) - hInv, bw, hInv, hSub > 0 ? 0 : r)}
                    className="s1"
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                )}
                {hSub > 0 && (
                  <path
                    d={bar(x, y(0) - hInv - gap - hSub, bw, hSub, r)}
                    className="s2"
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                )}
                {i === peak && w.expected > 0 && (
                  <text x={x + bw / 2} y={y(w.expected) - 7} textAnchor="middle" className="value">
                    {compact(w.expected)}
                  </text>
                )}
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="axis">
                  {short(w.start)}
                </text>
                <rect
                  x={pad.l + i * iw}
                  y={pad.t}
                  width={iw}
                  height={H - pad.t - pad.b}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  tabIndex={0}
                  aria-label={`Week of ${short(w.start)}: ${money(w.expected)}`}
                />
              </g>
            );
          })}
          <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="baseline" />
        </svg>
        {hw && hover !== null && (
          <div className="tip" style={{ left: `${((pad.l + hover * iw + iw / 2) / W) * 100}%` }}>
            <b>
              {short(hw.start)}–{short(hw.end)}
            </b>
            <div className="tip-row">
              <i className="sw s1" />
              Invoices <span>{money(hw.fromInvoices)}</span>
            </div>
            <div className="tip-row">
              <i className="sw s2" />
              Retainers <span>{money(hw.fromSubscriptions)}</span>
            </div>
            <div className="tip-row total">
              Expected <span>{money(hw.expected)}</span>
            </div>
            {hw.items.slice(0, 5).map((it, k) => (
              <div key={k} className="tip-item">
                {it.label} · {money(it.amount)}
              </div>
            ))}
            {hw.items.length > 5 && <div className="tip-item">+{hw.items.length - 5} more</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend">
      <span>
        <i className="sw s1" />
        Invoices and instalments
      </span>
      <span>
        <i className="sw s2" />
        Retainers
      </span>
    </div>
  );
}

function bar(x: number, yTop: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${yTop + h} V${yTop + rr} Q${x},${yTop} ${x + rr},${yTop} H${x + w - rr} Q${x + w},${yTop} ${x + w},${yTop + rr} V${yTop + h} Z`;
}
function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? raw;
}
function compact(v: number) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `${Math.round(v)}`;
}

export function Insights({ dark, config }: { dark: boolean; config: Config }) {
  const { data } = useLive(() => api.insights());
  const cur = config.currency;
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [ms, setMs] = useState<MonthSummary | null>(null);
  useEffect(() => {
    api
      .monthSummary(month)
      .then(setMs)
      .catch(() => setMs(null));
  }, [month, data]);
  const theme = dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz';

  const riskCols = useMemo<ColDef<InvoiceRisk>[]>(
    () => [
      { field: 'number', headerName: 'Invoice', width: 115 },
      { field: 'customer', width: 150 },
      {
        field: 'amountDue',
        headerName: 'Due',
        width: 110,
        type: 'rightAligned',
        valueFormatter: (p) => fmtMoney(p.value, cur),
        cellClass: 'num',
      },
      {
        field: 'score',
        headerName: 'Risk',
        width: 120,
        sort: 'desc',
        cellRenderer: (p: any) => <RiskCell band={p.data?.band} score={p.value} />,
      },
      { field: 'expectedPayDate', headerName: 'Expected', width: 115 },
      {
        headerName: 'Why',
        flex: 1,
        minWidth: 260,
        valueGetter: (p) => p.data?.factors.join(' · '),
        wrapText: true,
        tooltipValueGetter: (p) => p.data?.factors.join('\n'),
      },
    ],
    [cur],
  );
  const custCols = useMemo<ColDef<CustomerProfile>[]>(
    () => [
      { field: 'name', headerName: 'Customer', width: 160 },
      {
        field: 'behaviour',
        width: 150,
        cellRenderer: (p: any) => (
          <Pill
            tone={
              { reliable: 'ok', 'sometimes late': 'info', 'usually late': 'warn', 'new customer': '' }[
                p.value as string
              ]
            }
          >
            {p.value}
          </Pill>
        ),
      },
      {
        field: 'onTimeRate',
        headerName: 'On time',
        width: 100,
        valueFormatter: (p) => (p.value == null ? '—' : `${Math.round(p.value * 100)}%`),
      },
      {
        field: 'medianDaysLate',
        headerName: 'Usually',
        width: 115,
        valueFormatter: (p) =>
          p.value == null
            ? '—'
            : p.value > 0
              ? `${Math.round(p.value)}d late`
              : `${Math.round(-p.value)}d early`,
      },
      {
        field: 'openAmount',
        headerName: 'Open',
        width: 110,
        type: 'rightAligned',
        valueFormatter: (p) => fmtMoney(p.value, cur),
        cellClass: 'num',
      },
      {
        field: 'overdueAmount',
        headerName: 'Overdue',
        width: 110,
        type: 'rightAligned',
        valueFormatter: (p) => fmtMoney(p.value, cur),
        cellClass: 'num',
        sort: 'desc',
      },
      { field: 'invoices', width: 95 },
    ],
    [cur],
  );

  if (!data)
    return (
      <div className="panel">
        <div className="empty">Working out the forecast…</div>
      </div>
    );
  const f = data.forecast;
  return (
    <div className="insights">
      <div className="panel">
        <div className="panel-head">
          <h2>Cash forecast</h2>
          <span className="muted">
            What to expect over the next 9 weeks, from each customer's own payment history.
          </span>
        </div>
        <div className="panel-body">
          <div className="mini-kpis">
            <div>
              <span>Next 30 days</span>
              <b>{fmtMoney(f.next30, cur)}</b>
            </div>
            <div>
              <span>Next 60 days</span>
              <b>{fmtMoney(f.next60, cur)}</b>
            </div>
            <div>
              <span>At high risk</span>
              <b className="bad">{fmtMoney(f.atRisk, cur)}</b>
            </div>
            <div>
              <span>Overdue now</span>
              <b>{fmtMoney(f.overdueTotal, cur)}</b>
            </div>
          </div>
          <ForecastChart data={f} currency={cur} />
          <ul className="assumptions">
            {f.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="insights-grid">
        <div className="panel">
          <div className="panel-head">
            <h2>Late-payment risk</h2>
            <span className="muted">Open invoices, riskiest first, with the reasons.</span>
          </div>
          <div className={theme} style={{ height: 380 }}>
            <AgGridReact<InvoiceRisk>
              rowData={data.risks}
              columnDefs={riskCols}
              rowHeight={56}
              suppressAnimationFrame
              getRowId={(p) => p.data.legacyPk}
              defaultColDef={{ sortable: true, resizable: true, filter: true }}
              tooltipShowDelay={300}
            />
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>How customers pay</h2>
            <span className="muted">Learned from paid invoices.</span>
          </div>
          <div className={theme} style={{ height: 380 }}>
            <AgGridReact<CustomerProfile>
              rowData={data.customers}
              columnDefs={custCols}
              suppressAnimationFrame
              getRowId={(p) => p.data.customerPk}
              defaultColDef={{ sortable: true, resizable: true, filter: true }}
            />
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Month-end books</h2>
          <span className="muted">
            Every PayPal payment with gross, PayPal fee and net, ready for your accountant.
          </span>
          <span className="spacer" />
          <input
            className="search"
            style={{ minWidth: 0, width: 150 }}
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Month"
          />
        </div>
        <div className="panel-body">
          {ms && (
            <div className="mini-kpis">
              <div>
                <span>Collected (gross)</span>
                <b>{fmtMoney(ms.grossCollected, cur)}</b>
                <small>{ms.paypalPayments} PayPal payments</small>
              </div>
              <div>
                <span>PayPal fees</span>
                <b>{fmtMoney(ms.fees, cur)}</b>
                <small>
                  {ms.effectiveFeeRate != null ? `${ms.effectiveFeeRate}% effective` : '—'}
                  {ms.feesMissing ? ` · ${ms.feesMissing} pending` : ''}
                </small>
              </div>
              <div>
                <span>Net to you</span>
                <b className="ok">{fmtMoney(ms.net, cur)}</b>
                <small>after fees</small>
              </div>
              <div>
                <span>Refunds</span>
                <b>{fmtMoney(ms.refunds, cur)}</b>
                <small>{fmtMoney(ms.paidOutsidePayPal, cur)} paid outside PayPal</small>
              </div>
            </div>
          )}
          <div className="actions-row" style={{ marginTop: 14 }}>
            <a className="btn sm" href={api.journalUrl(month, 'generic')}>
              Download CSV
            </a>
            <a className="btn sm" href={api.journalUrl(month, 'xero')}>
              Xero bank statement
            </a>
            <a className="btn sm" href={api.journalUrl(month, 'quickbooks')}>
              QuickBooks bank upload
            </a>
            <span className="muted" style={{ fontSize: 12 }}>
              Fees become their own lines, so the books reconcile to the PayPal payout.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
