import type { ActionRecord } from '@paypal-retrofit/core';

export interface ApprovalPageInput {
  business: string;
  currency: string;
  consoleUrl: string;
  /** Business time zone, for "goes out" times. */
  timezone: string;
  kindLabel: Record<string, string>;
  action?: ActionRecord;
  error?: string;
  /** Set after the owner clicked a button. */
  done?: 'approve' | 'reject';
}

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const STATUS: Record<string, string> = {
  executed: 'Done',
  scheduled: 'Scheduled',
  rejected: 'Rejected',
  failed: 'Failed',
  skipped: 'Skipped',
  pending: 'Waiting for you',
};

/** The small page behind a digest's "Review" link: what the action is, and Approve / Reject buttons (POST). */
export function approvalPage(p: ApprovalPageInput): string {
  const a = p.action;
  const money = (n: number) => {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency }).format(n);
    } catch {
      return n.toFixed(2);
    }
  };
  let body: string;
  if (!a) {
    body = `<h1>Link not valid</h1><p class="muted">${esc(p.error ?? 'This link cannot be used.')}</p>`;
  } else {
    const label = p.kindLabel[a.kind] ?? a.kind;
    const facts = [
      ['Invoice', a.target.label ?? a.target.legacyPk],
      ...(a.amount != null ? [['Amount', money(a.amount)]] : []),
      ['Why', a.reason],
      ...(a.policyReason ? [['Rule', a.policyReason]] : []),
      ['Status', STATUS[a.status] ?? a.status],
      ...(a.runAfter && a.status === 'scheduled'
        ? [
            [
              'Goes out',
              new Intl.DateTimeFormat('en-US', {
                timeZone: p.timezone,
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
                timeZoneName: 'short',
              }).format(new Date(a.runAfter)),
            ],
          ]
        : []),
    ];
    const note = typeof a.payload.note === 'string' ? a.payload.note : null;
    let banner = '';
    if (p.error) banner = `<div class="banner bad">${esc(p.error)}</div>`;
    else if (p.done === 'approve')
      banner = `<div class="banner ok">${a.status === 'scheduled' ? 'Approved. It is held for business hours and goes out automatically.' : a.status === 'executed' ? 'Approved and done.' : `Approved: ${esc(STATUS[a.status] ?? a.status)}.`}</div>`;
    else if (p.done === 'reject') banner = `<div class="banner">Rejected. Nothing was sent.</div>`;
    else if (a.status !== 'pending')
      banner = `<div class="banner">This action is no longer waiting (${esc(STATUS[a.status] ?? a.status)}).</div>`;
    body = `${banner}<h1>${esc(label)}</h1>
<dl>${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
${note ? `<div class="note"><div class="muted small">Message to the customer</div>${esc(note).replace(/\n/g, '<br>')}</div>` : ''}
${
  a.status === 'pending' && !p.done
    ? `<form method="post" class="row"><button name="decision" value="approve" class="primary">Approve</button><button name="decision" value="reject">Reject</button></form>`
    : ''
}`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(p.business)} · approval</title>
<style>
:root{--bg:#eef1f5;--card:#fff;--ink:#14171f;--muted:#5b6475;--line:#e3e6ec;--accent:#2a78d6;--ok:#1d7a4a;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--ink:#e8ebf1;--muted:#9aa3b5;--line:#2a303c;--accent:#3987e5;--ok:#4cc38a;--bad:#f97066}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px 16px}
main{max-width:520px;margin:0 auto;background:var(--card);border-radius:12px;padding:24px;border-top:4px solid var(--accent)}
.brand{font-size:13px;color:var(--muted)}h1{font-size:22px;margin:6px 0 16px}
dl{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px 12px;margin:0}dt{color:var(--muted);font-size:13px}dd{margin:0;overflow-wrap:anywhere}
.note{margin-top:16px;padding:12px;border:1px solid var(--line);border-radius:8px}.muted{color:var(--muted)}.small{font-size:12px;margin-bottom:4px}
.row{display:flex;gap:10px;margin-top:20px}button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.banner{padding:10px 12px;border-radius:8px;background:var(--bg);margin-bottom:14px}.banner.ok{color:var(--ok)}.banner.bad{color:var(--bad)}
footer{margin-top:22px;font-size:13px}a{color:var(--accent)}
</style></head><body><main><div class="brand">${esc(p.business)} · paypal-retrofit</div>${body}
<footer><a href="${esc(p.consoleUrl)}">Open the console</a></footer></main></body></html>`;
}
