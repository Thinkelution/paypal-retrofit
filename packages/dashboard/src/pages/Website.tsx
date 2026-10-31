import { useState } from 'react';
import { BASE, type Config } from '../api';

/** PayPal on the business's existing website with one line, QR codes for paper, and the address for AI assistants. */
export function Website({ config }: { config: Config }) {
  const origin = `${window.location.origin}${BASE}`;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };
  const snippets: Array<[string, string, string, string]> = [
    [
      'float',
      'A "Pay a bill" button on every page',
      'Paste once, before </body>. Customers type their invoice number and email and pay with PayPal.',
      `<script src="${origin}/widget.js" data-float="pay-bill" async></script>`,
    ],
    [
      'inline',
      'The same form inside a page',
      'For a "Pay your bill" page. Needs the script above (without data-float, if you prefer).',
      `<div data-retrofit="pay-bill"></div>`,
    ],
    [
      'button',
      'A Pay button on an invoice page',
      'If your old system prints invoice pages, add this next to the total. It checks the email before sending anyone to PayPal.',
      `<span data-retrofit-pay="INV-1043" data-email="customer@example.com"></span>`,
    ],
    [
      'shop',
      'Your catalogue with Book and pay buttons',
      'Shows what you sell online (switch the shop on in Shop).',
      `<div data-retrofit="shop"></div>`,
    ],
  ];
  return (
    <div className="website">
      <section className="panel">
        <div className="panel-head">
          <h2>Add PayPal to your website</h2>
          <span className="spacer" />
          {config.demo && !config.demo.custom && (
            <a className="btn sm" href={`${BASE}/site`} target="_blank" rel="noreferrer">
              See it on {config.business.name}'s site ↗
            </a>
          )}
        </div>
        <div className="panel-body">
          <p className="muted" style={{ marginTop: 0 }}>
            No developer and no new website: one line works on WordPress, Wix, Squarespace or a hand-made
            page. Lookups need both the invoice number and the customer's email, and are rate limited.
          </p>
          <div className="snippets">
            {snippets.map(([id, title, help, code]) => (
              <div key={id} className="snip-card">
                <b>{title}</b>
                <p className="muted">{help}</p>
                <pre>{code}</pre>
                <button className="btn sm" onClick={() => copy(id, code)}>
                  {copied === id ? 'Copied' : 'Copy'}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Paper invoices and job sheets</h2>
          </div>
          <div className="panel-body">
            <p style={{ marginTop: 0 }}>
              Every invoice in PayPal has a <b>pay slip</b> with PayPal's own QR code: print it with the paper
              invoice or hand it over at the door. Scanning opens PayPal's pay page on the customer's phone.
            </p>
            <p className="muted">
              Open any invoice in <b>Invoices</b> and choose <b>Pay slip with QR</b>. Printed statements carry
              a QR code for the customer's portal.
            </p>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>For AI assistants</h2>
          </div>
          <div className="panel-body">
            <p style={{ marginTop: 0 }}>
              Customers' and buyers' assistants (Claude, and any MCP client) can find you, see a customer's
              bills and pay them, or buy from your catalogue. A person approves every payment at PayPal.
            </p>
            <pre>{`claude mcp add --transport http ${config.business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')} ${origin}/mcp/shop`}</pre>
            <p className="muted">
              Discovery for crawlers and assistants:{' '}
              <a href={`${origin}/llms.txt`} target="_blank" rel="noreferrer">
                llms.txt
              </a>{' '}
              ·{' '}
              <a href={`${origin}/shop/catalog.json`} target="_blank" rel="noreferrer">
                catalog.json
              </a>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
