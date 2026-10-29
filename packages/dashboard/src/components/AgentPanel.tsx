import { useEffect, useRef, useState } from 'react';
import { api, chat, KIND_LABEL, type Action, type AgentEvent } from '../api';

type Item =
  | { kind: 'user'; text: string }
  | { kind: 'agent'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'trace'; tools: string[] }
  | { kind: 'proposal'; action: Action };

const SUGGESTIONS = [
  'How much is overdue, and who owes the most?',
  'Send reminders for everything more than 14 days overdue',
  'Is anything paid in PayPal that is not marked paid in our system?',
  'Which retainers are not on PayPal yet?',
];

export function AgentPanel(props: {
  open: boolean;
  onClose: () => void;
  pending: string | null;
  clearPending: () => void;
  available: boolean;
  model: string;
  onChanged: () => void;
}) {
  const { open, onClose, pending, clearPending, available, model, onChanged } = props;
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const session = useRef(`web-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [items]);

  useEffect(() => {
    if (open && pending && !busy) {
      void send(pending);
      clearPending();
    }
  }, [open, pending]);

  const send = async (q: string) => {
    if (!q.trim() || busy) return;
    setText('');
    setBusy(true);
    setItems((x) => [...x, { kind: 'user', text: q }]);
    let tools: string[] = [];
    const flushTools = () => {
      if (tools.length) {
        const t = tools;
        setItems((x) => [...x, { kind: 'trace', tools: t }]);
        tools = [];
      }
    };
    let lastText = '';
    try {
      await chat(session.current, q, (e: AgentEvent) => {
        if (e.type === 'tool_call') tools.push(describeTool(e.name, e.input));
        if (e.type === 'text') lastText = e.text;
        if (e.type === 'action_proposed') {
          flushTools();
          setItems((x) => [...x, { kind: 'proposal', action: e.action }]);
          onChanged();
        }
        if (e.type === 'done') {
          flushTools();
          setItems((x) => [...x, { kind: 'agent', text: e.text || lastText }]);
        }
        if (e.type === 'error') setItems((x) => [...x, { kind: 'error', text: e.message }]);
      });
    } catch (e) {
      setItems((x) => [...x, { kind: 'error', text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (a: Action, approve: boolean) => {
    const r = approve ? await api.approve(a.id) : await api.reject(a.id);
    setItems((x) =>
      x.map((it) => (it.kind === 'proposal' && it.action.id === a.id ? { ...it, action: r } : it)),
    );
    onChanged();
  };

  if (!open) return null;
  return (
    <section className="agent" aria-label="Ops agent">
      <header>
        <h3>Ops agent</h3>
        <span className="muted" style={{ fontSize: 12 }}>
          {model}
        </span>
        <span className="spacer" />
        <button
          className="btn ghost sm"
          onClick={() => {
            setItems([]);
            void api.resetAgent(session.current);
          }}
          disabled={busy}
        >
          New chat
        </button>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>
      <div className="log" ref={log}>
        {!available && (
          <div className="msg err">The agent is off. Set ANTHROPIC_API_KEY on the server to enable it.</div>
        )}
        {available && items.length === 0 && (
          <>
            <div className="msg agent">
              I can look up any invoice in your system and in PayPal, explain mismatches, and line up
              reminders, refunds or payments for your approval. What would you like to know?
            </div>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {items.map((it, i) =>
          it.kind === 'trace' ? (
            <div key={i} className="trace">
              {it.tools.map((t, j) => (
                <span key={j}>{t}</span>
              ))}
            </div>
          ) : it.kind === 'proposal' ? (
            <div key={i} className="proposal">
              <b>{KIND_LABEL[it.action.kind] ?? it.action.kind}</b>
              <span>{it.action.target.label}</span>
              <span className="spacer" />
              {it.action.status === 'pending' ? (
                <>
                  <button className="btn primary sm" onClick={() => decide(it.action, true)}>
                    Approve
                  </button>
                  <button className="btn sm" onClick={() => decide(it.action, false)}>
                    Reject
                  </button>
                </>
              ) : (
                <span
                  className={`pill ${it.action.status === 'executed' ? 'ok' : it.action.status === 'failed' ? 'bad' : ''}`}
                >
                  {it.action.status}
                </span>
              )}
            </div>
          ) : (
            <div key={i} className={`msg ${it.kind === 'error' ? 'err' : it.kind}`}>
              {it.text}
            </div>
          ),
        )}
        {busy && (
          <div className="trace">
            <span>thinking…</span>
          </div>
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <textarea
          value={text}
          placeholder={available ? 'Ask about invoices, payments, disputes…' : 'Agent unavailable'}
          disabled={!available || busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(text);
            }
          }}
          aria-label="Message"
        />
        <button className="btn primary" disabled={!available || busy || !text.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'find_invoices':
      return `searched the ledger ${Object.entries(i)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')}`.trim();
    case 'invoice_detail':
      return `opened ${i.number}`;
    case 'legacy_sql':
      return `queried your database`;
    case 'business_summary':
      return 'checked totals';
    case 'propose_action':
      return `proposed ${KIND_LABEL[String(i.kind)] ?? i.kind} for ${i.number}`;
    default:
      return name.startsWith('paypal_') ? `asked PayPal: ${name.slice(7).replace(/_/g, ' ')}` : name;
  }
}
