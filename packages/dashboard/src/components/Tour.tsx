import { useEffect, useLayoutEffect, useState } from 'react';

const STEPS: Array<{ target: string; title: string; text: string }> = [
  {
    target: 'today',
    title: 'Your day at a glance',
    text: "What you're owed, what came in this week and what needs you, in plain words.",
  },
  {
    target: 'needs',
    title: 'One decision, one button',
    text: 'Each card is something waiting for you. Nothing customer-facing runs without your rules.',
  },
  {
    target: 'new-invoice',
    title: 'Invoices in seconds',
    text: 'Type it, say it, or snap a paper job sheet. It goes into your own system and out through PayPal.',
  },
  {
    target: 'nav',
    title: 'Everything else, grouped',
    text: 'Money, customers, your approvals and set-up. Go live walks you from the simulator to real payments.',
  },
  {
    target: 'search',
    title: 'Ctrl+K for anything',
    text: 'Jump to a page, run collections, start an invoice from a sentence, or ask the agent a question.',
  },
];

const KEY = 'retrofit.tour.done';

export function tourDone() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

/** A five-step first-run tour that points at the real controls. */
export function Tour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const s = STEPS[step]!;

  useLayoutEffect(() => {
    const place = () => {
      const el = document.querySelector(`[data-tour="${s.target}"]`);
      if (el && el.getClientRects().length) {
        el.scrollIntoView({ block: 'nearest' });
        setBox(el.getBoundingClientRect());
      } else setBox(null);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [step]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const finish = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* private mode: the tour just shows again */
    }
    onClose();
  };
  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : finish());

  const pad = 6;
  const card: React.CSSProperties = box
    ? {
        top: Math.min(window.innerHeight - 200, box.bottom + 12),
        left: Math.max(12, Math.min(window.innerWidth - 332, box.left)),
      }
    : { top: '30%', left: 'calc(50% - 160px)' };
  return (
    <div className="tour" role="dialog" aria-label="Tour">
      {box ? (
        <div
          className="tour-spot"
          style={{
            top: box.top - pad,
            left: box.left - pad,
            width: box.width + pad * 2,
            height: box.height + pad * 2,
          }}
        />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" style={card}>
        <div className="muted small">
          {step + 1} of {STEPS.length}
        </div>
        <b>{s.title}</b>
        <p>{s.text}</p>
        <div className="row">
          <button className="btn ghost sm" onClick={finish}>
            Skip
          </button>
          <span className="spacer" />
          {step > 0 && (
            <button className="btn sm" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <button className="btn primary sm" onClick={next} autoFocus>
            {step < STEPS.length - 1 ? 'Next' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}
