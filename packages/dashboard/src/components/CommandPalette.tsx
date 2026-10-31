import { useEffect, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  group: 'Go to' | 'Do' | 'Ask';
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

/**
 * Ctrl+K / Cmd+K: jump to any page, run any action, start an invoice from a sentence ("invoice Maya $250 for
 * retouching") or ask the agent anything.
 */
export function CommandPalette({
  commands,
  onClose,
  onAsk,
  onInvoice,
}: {
  commands: Command[];
  onClose: () => void;
  onAsk: (q: string) => void;
  onInvoice: (text: string) => void;
}) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo<Command[]>(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (c: Command) =>
      words.every((w) => `${c.label} ${c.keywords ?? ''} ${c.group}`.toLowerCase().includes(w));
    const found = commands.filter(match);
    const text = q.trim();
    const extra: Command[] = [];
    if (/^(invoice|bill|charge)\b/i.test(text) && text.split(/\s+/).length > 2)
      extra.push({
        id: 'new-invoice-text',
        group: 'Do',
        label: `New invoice: "${text}"`,
        hint: 'reads it into a draft',
        run: () => onInvoice(text),
      });
    if (text.length > 3)
      extra.push({
        id: 'ask',
        group: 'Ask',
        label: `Ask the agent: "${text}"`,
        hint: 'Enter',
        run: () => onAsk(text),
      });
    return [...extra.filter((e) => e.group === 'Do'), ...found, ...extra.filter((e) => e.group === 'Ask')];
  }, [q, commands]);
  useEffect(() => setActive(0), [q]);

  const go = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <>
      <div className="overlay palette-overlay" onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Search and commands">
        <input
          ref={input}
          value={q}
          placeholder='Go to a page, run something, "invoice Maya $250 for retouching", or ask a question'
          aria-label="Search or ask"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(items.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') go(items[active]);
          }}
        />
        <ul role="listbox">
          {items.length === 0 && <li className="muted empty-row">Type a question to ask the agent.</li>}
          {items.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(c)}
            >
              <span className="group">{c.group}</span>
              <span className="label">{c.label}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </li>
          ))}
        </ul>
        <div className="palette-foot muted">↑↓ to move · Enter to run · Esc to close</div>
      </div>
    </>
  );
}
