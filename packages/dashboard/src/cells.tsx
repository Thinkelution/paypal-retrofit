import type { ICellRendererParams } from 'ag-grid-community';
import { DISCREPANCY_LABEL, KIND_LABEL } from './api';

const PAYPAL_TONE: Record<string, string> = {
  PAID: 'ok',
  MARKED_AS_PAID: 'ok',
  SENT: 'info',
  UNPAID: 'info',
  SCHEDULED: 'info',
  DRAFT: '',
  PARTIALLY_PAID: 'warn',
  PAYMENT_PENDING: 'warn',
  CANCELLED: '',
  REFUNDED: 'bad',
  PARTIALLY_REFUNDED: 'warn',
  MARKED_AS_REFUNDED: 'bad',
  ACTIVE: 'ok',
  APPROVAL_PENDING: 'warn',
  SUSPENDED: 'bad',
  EXPIRED: '',
};
const LEGACY_TONE: Record<string, string> = {
  paid: 'ok',
  open: 'info',
  cancelled: '',
  unknown: 'warn',
  active: 'ok',
  pending: 'warn',
};

export const humanize = (s: string) =>
  s
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());

export function Pill({ tone, children }: { tone?: string; children: React.ReactNode }) {
  return <span className={`pill ${tone ?? ''}`}>{children}</span>;
}

export function PayPalStatusCell(p: ICellRendererParams) {
  if (!p.value) return <span className="muted">Not in PayPal</span>;
  return <Pill tone={PAYPAL_TONE[p.value] ?? ''}>{humanize(p.value)}</Pill>;
}

export function LegacyStatusCell(p: ICellRendererParams) {
  const state = p.data?.legacyState;
  const tone = state === 'open' && (p.data?.daysOverdue ?? 0) > 0 ? 'warn' : (LEGACY_TONE[state] ?? '');
  return <Pill tone={tone}>{p.value}</Pill>;
}

export function OverdueCell(p: ICellRendererParams) {
  if (p.value == null || p.value <= 0) return <span className="muted">—</span>;
  const tone = p.value > 30 ? 'bad' : p.value > 14 ? 'warn' : 'info';
  return <Pill tone={tone}>{p.value}d</Pill>;
}

export function SyncCell(p: ICellRendererParams) {
  const d: string[] = p.data?.discrepancies ?? [];
  if (d.length)
    return (
      <Pill tone={d.includes('dispute') ? 'bad' : 'warn'}>
        {DISCREPANCY_LABEL[d[0]!] ?? humanize(d[0]!)}
        {d.length > 1 ? ` +${d.length - 1}` : ''}
      </Pill>
    );
  if (p.data?.pendingActions) return <Pill tone="accent">{p.data.pendingActions} to approve</Pill>;
  if (p.data?.paypalId || p.data?.legacyState !== 'open')
    return (
      <Pill tone="ok">
        <span className="dot" />
        In sync
      </Pill>
    );
  return <span className="muted">—</span>;
}

export function KindCell(p: ICellRendererParams) {
  return <b>{KIND_LABEL[p.value] ?? humanize(p.value)}</b>;
}

export function ActionStatusCell(p: ICellRendererParams) {
  const tone =
    { executed: 'ok', pending: 'accent', scheduled: 'info', failed: 'bad', rejected: '', skipped: '' }[
      p.value as string
    ] ?? '';
  return <Pill tone={tone}>{humanize(p.value)}</Pill>;
}

export function RiskCell({ band, score }: { band?: string | null; score?: number | null }) {
  if (!band) return <span className="muted">—</span>;
  const tone = band === 'high' ? 'bad' : band === 'medium' ? 'warn' : 'ok';
  return (
    <Pill tone={tone}>
      {band}
      {score != null ? ` · ${score}` : ''}
    </Pill>
  );
}
