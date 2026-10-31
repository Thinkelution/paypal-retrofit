import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  fmtMoney,
  type AddedInvoice,
  type DraftLine,
  type InvoiceDraft,
  type NewInvoiceContext,
} from '../api';

type Mode = 'say' | 'snap' | 'form';

const SOURCE_LABEL: Record<string, string> = {
  sqlite: 'database',
  postgres: 'database',
  mysql: 'database',
  csv: 'CSV files',
  excel: 'spreadsheet',
  gsheet: 'Google Sheet',
};

/**
 * New invoice from a sentence, a photo of a paper job sheet, or a form. The owner checks the draft; it is then
 * written into their own system (numbering, statuses, line items) and sent through PayPal by the next sync.
 */
export function NewInvoice({
  initialText,
  initialMode,
  onClose,
  onDone,
}: {
  initialText?: string;
  initialMode?: Mode;
  onClose: () => void;
  onDone: (r: AddedInvoice) => void;
}) {
  const [ctx, setCtx] = useState<NewInvoiceContext | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode ?? 'say');
  const [text, setText] = useState(initialText ?? '');
  const [photo, setPhoto] = useState<{ url: string; data: string } | null>(null);
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [send, setSend] = useState(true);
  const [done, setDone] = useState<AddedInvoice | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.invoices
      .context()
      .then(setCtx)
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (initialText && ctx) void read({ text: initialText });
  }, [ctx]);

  const example = useMemo(() => {
    const c = ctx?.customers.find((x) => x.name) ?? { name: 'Harbor View Apartments' };
    const p = ctx?.products[0];
    return p
      ? `Invoice ${c.name} for a ${p.name.toLowerCase()}, due in ${ctx?.usualTermsDays ?? 14} days`
      : `Invoice ${c.name} $240 for replacing the water heater valve, due in 14 days`;
  }, [ctx]);

  const read = async (body: { text?: string; image?: { data: string; mediaType: string } }) => {
    setBusy('read');
    setError(null);
    try {
      setDraft(await api.invoices.draft(body));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const blank = (): InvoiceDraft => ({
    customer: { name: '' },
    lines: [{ description: '', qty: 1, unitPrice: 0 }],
    questions: [],
    engine: 'manual',
  });

  const onPhoto = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const data = await shrink(f);
      setPhoto({ url: `data:image/jpeg;base64,${data}`, data });
    } catch {
      setError('That file could not be read as a photo. Try a JPEG or PNG.');
    }
  };

  const add = async () => {
    if (!draft) return;
    setBusy('add');
    setError(null);
    try {
      const r = await api.invoices.add({
        customer: draft.customer,
        lines: draft.lines.filter((l) => l.description.trim() || l.unitPrice),
        due: draft.due,
        notes: draft.notes,
        send,
      });
      setDone(r);
      onDone(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cur = ctx?.currency ?? 'USD';
  const known =
    draft && ctx?.customers.find((c) => c.name.toLowerCase() === draft.customer.name.trim().toLowerCase());
  const total = draft
    ? draft.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0)
    : 0;
  const where = SOURCE_LABEL[ctx?.source ?? ''] ?? 'system';
  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) => d && { ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer wide new-invoice" role="dialog" aria-label="New invoice">
        <header>
          <h3>New invoice</h3>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">
          {done ? (
            <div className="ni-done">
              <div className="ni-check" aria-hidden>
                ✓
              </div>
              <h4>
                {done.number} for {fmtMoney(done.total, cur)} is in your {where}
                {done.paypal ? ' and on its way through PayPal' : ''}.
              </h4>
              <p className="muted">
                {done.newCustomer ? 'A new customer was added too. ' : ''}
                {done.paypal
                  ? `PayPal invoice ${done.paypal.id} was emailed to the customer; payments will be written back automatically.`
                  : done.status === 'draft' || !send
                    ? 'Saved as a draft. It goes to PayPal when you mark it ready.'
                    : 'It goes to PayPal on the next sync, or once it is approved.'}
              </p>
              <div className="row">
                {done.paypal?.link && (
                  <a className="btn" href={done.paypal.link} target="_blank" rel="noreferrer">
                    Customer's pay page ↗
                  </a>
                )}
                <button
                  className="btn primary"
                  onClick={() => {
                    setDone(null);
                    setDraft(null);
                    setText('');
                    setPhoto(null);
                  }}
                >
                  Another invoice
                </button>
                <button className="btn" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          ) : !draft ? (
            <>
              <p className="muted" style={{ margin: 0 }}>
                It goes into {ctx?.business ?? 'your business'}'s {where}, numbered and filed like any other
                invoice, and out to the customer through PayPal.
              </p>
              <div className="seg" role="tablist" aria-label="How to start">
                {(
                  [
                    ['say', 'Say it'],
                    ['snap', 'Snap a job sheet'],
                    ['form', 'Fill it in'],
                  ] as Array<[Mode, string]>
                ).map(([m, label]) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    className={mode === m ? 'on' : ''}
                    onClick={() => setMode(m)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {mode === 'say' && (
                <>
                  <textarea
                    className="ni-text"
                    rows={3}
                    autoFocus
                    placeholder={example}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void read({ text });
                    }}
                  />
                  <div className="row">
                    <button
                      className="btn primary"
                      disabled={!text.trim() || !!busy}
                      onClick={() => read({ text })}
                    >
                      {busy === 'read' ? 'Reading…' : 'Read it'}
                    </button>
                    <button className="btn ghost sm" onClick={() => setText(example)}>
                      Use an example
                    </button>
                    <span className="muted small">
                      {ctx?.claude ? 'Claude reads it.' : 'Read with rules: Claude is off.'}
                    </span>
                  </div>
                </>
              )}
              {mode === 'snap' && (
                <>
                  <label
                    className="dropzone ni-photo"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void onPhoto(e.dataTransfer.files[0]);
                    }}
                  >
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={(e) => onPhoto(e.target.files?.[0])}
                    />
                    {photo ? (
                      <img src={photo.url} alt="The job sheet to read" />
                    ) : (
                      <span>
                        Take a photo of a paper job sheet, quote or invoice, or <u>choose one</u>
                      </span>
                    )}
                  </label>
                  <div className="row">
                    <button
                      className="btn primary"
                      disabled={!photo || !!busy || !ctx?.claude}
                      onClick={() => photo && read({ image: { data: photo.data, mediaType: 'image/jpeg' } })}
                    >
                      {busy === 'read' ? 'Reading the photo…' : 'Read the photo'}
                    </button>
                    <span className="muted small">
                      {ctx?.claude
                        ? 'Claude reads handwriting and asks about anything unclear.'
                        : 'Reading photos needs Claude: set ANTHROPIC_API_KEY on the server.'}
                    </span>
                  </div>
                </>
              )}
              {mode === 'form' && (
                <div className="row">
                  <button className="btn primary" onClick={() => setDraft(blank())}>
                    Start a blank invoice
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="ni-form">
              {draft.questions.length > 0 && (
                <div className="callout warn">
                  <b>Check before sending</b>
                  <ul>
                    {draft.questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </div>
              )}
              {draft.warning && <div className="callout">{draft.warning}</div>}
              <div className="ni-grid">
                <label>
                  <span>Customer</span>
                  <input
                    list="ni-customers"
                    value={draft.customer.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const k = ctx?.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
                      setDraft({
                        ...draft,
                        customer: k
                          ? { key: k.key, name: k.name, email: k.email }
                          : { name, email: draft.customer.key ? '' : draft.customer.email },
                      });
                    }}
                  />
                  <datalist id="ni-customers">
                    {ctx?.customers.map((c) => (
                      <option key={c.key} value={c.name} />
                    ))}
                  </datalist>
                </label>
                <label>
                  <span>
                    Email{' '}
                    <span className={`pill ${known ? 'ok' : 'info'}`}>
                      {known ? 'existing customer' : 'new customer'}
                    </span>
                  </span>
                  <input
                    type="email"
                    value={draft.customer.email ?? ''}
                    readOnly={Boolean(known)}
                    placeholder="where PayPal sends the invoice"
                    onChange={(e) =>
                      setDraft({ ...draft, customer: { ...draft.customer, email: e.target.value } })
                    }
                  />
                </label>
              </div>
              <table className="ni-lines">
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="num">Qty</th>
                    <th className="num">Unit price</th>
                    <th className="num">Amount</th>
                    <th aria-label="Remove" />
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          value={l.description}
                          onChange={(e) => setLine(i, { description: e.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={l.qty}
                          onChange={(e) => setLine(i, { qty: Number(e.target.value) })}
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.01"
                          value={l.unitPrice}
                          onChange={(e) => setLine(i, { unitPrice: Number(e.target.value) })}
                        />
                      </td>
                      <td className="num">
                        {fmtMoney((Number(l.qty) || 0) * (Number(l.unitPrice) || 0), cur)}
                      </td>
                      <td>
                        <button
                          className="btn ghost sm"
                          aria-label="Remove line"
                          onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, j) => j !== i) })}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            lines: [...draft.lines, { description: '', qty: 1, unitPrice: 0 }],
                          })
                        }
                      >
                        + Add line
                      </button>
                    </td>
                    <td className="num">
                      <b>{fmtMoney(total, cur)}</b>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
              <div className="ni-grid">
                <label>
                  <span>Due</span>
                  <input
                    type="date"
                    value={draft.due ?? ''}
                    placeholder={`in ${ctx?.usualTermsDays ?? 14} days`}
                    onChange={(e) => setDraft({ ...draft, due: e.target.value || undefined })}
                  />
                  {!draft.due && <small className="muted">Your usual {ctx?.usualTermsDays ?? 14} days</small>}
                </label>
                <label>
                  <span>Note to the customer</span>
                  <input
                    value={draft.notes ?? ''}
                    onChange={(e) => setDraft({ ...draft, notes: e.target.value || undefined })}
                  />
                </label>
              </div>
              <label className="check">
                <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Send it
                through PayPal now
              </label>
              <div className="row">
                <button className="btn primary" disabled={!!busy || total <= 0} onClick={add}>
                  {busy === 'add'
                    ? 'Adding…'
                    : send
                      ? `Add and send ${fmtMoney(total, cur)}`
                      : `Add as a draft`}
                </button>
                <button className="btn" onClick={() => setDraft(null)}>
                  Back
                </button>
                <span className="muted small">
                  {draft.engine === 'claude'
                    ? 'Read by Claude'
                    : draft.engine === 'rules'
                      ? 'Read with rules'
                      : ''}
                </span>
              </div>
            </div>
          )}
          {error && <div className="callout">{error}</div>}
        </div>
      </aside>
    </>
  );
}

/** Photos go to Claude as a JPEG at most 1600 px on the long side: sharp enough for handwriting, small to send. */
async function shrink(f: File): Promise<string> {
  const bitmap = await createImageBitmap(f);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1]!;
}
