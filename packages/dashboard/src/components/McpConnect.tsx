import { useState } from 'react';

/** How to connect Claude (or any MCP client) to this retrofit instance. */
export function McpConnect({ business, onClose }: { business: string; onClose: () => void }) {
  const url = `${window.location.origin}/mcp`;
  const [copied, setCopied] = useState<string | null>(null);
  const snippets: Array<[string, string, string]> = [
    ['claude-code', 'Claude Code (HTTP)', `claude mcp add --transport http paypal-retrofit ${url}`],
    [
      'desktop',
      'Claude Desktop (stdio, claude_desktop_config.json)',
      JSON.stringify(
        {
          mcpServers: {
            'paypal-retrofit': {
              command: 'node',
              args: [
                '/path/to/paypal-retrofit/packages/cli/bin/paypal-retrofit.js',
                'mcp',
                '-c',
                '/path/to/retrofit.config.yaml',
              ],
            },
          },
        },
        null,
        2,
      ),
    ],
    [
      'curl',
      'Check it with curl',
      `curl -s ${url} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    ],
  ];
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked: the text is selectable */
    }
  };
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Connect an AI assistant">
        <header>
          <h3>Connect Claude to {business}</h3>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body">
          <p style={{ margin: 0 }}>
            retrofit is also an <b>MCP server</b>. Claude Desktop, Claude Code or any MCP client can ask about
            cash flow, overdue invoices and disputes, and queue reminders, refunds and payment plans. The same
            rules apply as in this console: anything that needs your OK still waits on the Approvals tab.
          </p>
          <ul className="plain">
            <li>
              <b>Tools:</b> owner_digest, business_summary, collections_plan, run_collections, cash_forecast,
              payment_risk, customer_history, month_end_summary, find_invoices, invoice_detail, legacy_sql,
              list_discrepancies, list_actions, propose_action, and PayPal reads.
            </li>
            <li>
              <b>Prompts:</b> morning_briefing, chase_overdue, month_end.
            </li>
            <li>
              <b>Approvals:</b> off by default. Start with <code>RETROFIT_MCP_ALLOW_APPROVE=1</code> (HTTP) or{' '}
              <code>mcp --allow-approve</code> (stdio) to let the client approve.
            </li>
            <li>
              <b>Security:</b> set <code>RETROFIT_MCP_TOKEN</code> and send it as a bearer token on a public
              server.
            </li>
          </ul>
          {snippets.map(([id, title, text]) => (
            <section key={id}>
              <div className="snippet-head">
                <b>{title}</b>
                <span className="spacer" />
                <button className="btn sm" onClick={() => copy(id, text)}>
                  {copied === id ? 'Copied' : 'Copy'}
                </button>
              </div>
              <pre className="snippet">{text}</pre>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}
