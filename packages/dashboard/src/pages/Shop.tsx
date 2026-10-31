import type { ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useEffect, useMemo, useState } from 'react';
import { ago, api, fmtMoney, type Config, type Order } from '../api';
import { Pill } from '../cells';
import { useLive } from '../hooks';

const CHANNEL: Record<string, [string, string]> = {
  agent: ['AI agent', 'accent'],
  shop: ['Shop page', 'info'],
  portal: ['Customer portal', 'ok'],
};

/** Agentic commerce: the catalogue buyers (and their AI agents) can check out through PayPal, and the orders. */
export function Shop({ dark, config, toast }: { dark: boolean; config: Config; toast: (m: string) => void }) {
  const cur = config.currency;
  const { data, reload } = useLive(() => api.shop());
  const [form, setForm] = useState({ enabled: false, maxOrderTotal: 2000, description: '' });
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (data)
      setForm({
        enabled: data.settings.enabled,
        maxOrderTotal: data.settings.maxOrderTotal,
        description: data.settings.description ?? '',
      });
  }, [data?.settings]);

  const save = async (patch: Partial<typeof form>) => {
    try {
      await api.saveShop({
        ...form,
        ...patch,
        description: (patch.description ?? form.description) || undefined,
      });
      toast(
        patch.enabled === undefined
          ? 'Shop settings saved'
          : patch.enabled
            ? 'Shop is open'
            : 'Shop is closed',
      );
    } catch (e) {
      toast((e as Error).message);
    } finally {
      reload();
    }
  };
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* visible anyway */
    }
  };

  const cols = useMemo<ColDef<Order>[]>(
    () => [
      { field: 'id', headerName: 'Order', width: 150, cellClass: 'mono' },
      {
        field: 'channel',
        width: 150,
        cellRenderer: (p: any) => (
          <Pill tone={CHANNEL[p.value]?.[1]}>{CHANNEL[p.value]?.[0] ?? p.value}</Pill>
        ),
      },
      {
        field: 'status',
        width: 130,
        cellRenderer: (p: any) => (
          <Pill
            tone={
              p.value === 'COMPLETED'
                ? 'ok'
                : p.value === 'APPROVED'
                  ? 'info'
                  : p.value === 'CANCELLED'
                    ? ''
                    : 'warn'
            }
          >
            {p.value === 'COMPLETED'
              ? 'paid'
              : p.value === 'CREATED'
                ? 'awaiting buyer'
                : p.value.toLowerCase()}
          </Pill>
        ),
      },
      {
        headerName: 'What',
        flex: 1.5,
        minWidth: 220,
        valueGetter: (p) =>
          p.data?.invoices?.length
            ? p.data.invoices.map((i) => i.number).join(', ')
            : p.data?.items.map((i) => `${i.name} × ${i.quantity}`).join(', '),
      },
      {
        headerName: 'Buyer',
        flex: 1,
        minWidth: 160,
        valueGetter: (p) => {
          const b = p.data?.buyer;
          if (!b) return '';
          return [b.name ?? b.email, b.agent ? `via ${b.agent}` : ''].filter(Boolean).join(' ');
        },
      },
      { field: 'total', width: 120, type: 'numericColumn', valueFormatter: (p) => fmtMoney(p.value, cur) },
      {
        field: 'fee',
        headerName: 'PayPal fee',
        width: 120,
        type: 'numericColumn',
        valueFormatter: (p) => (p.value == null ? '—' : fmtMoney(p.value, cur)),
      },
      {
        field: 'createdAt',
        headerName: 'When',
        width: 120,
        valueFormatter: (p) => ago(p.value),
        sort: 'desc',
      },
    ],
    [cur],
  );

  if (!data)
    return (
      <div className="panel">
        <div className="empty">Loading…</div>
      </div>
    );
  const sold = data.orders.filter((o) => o.status === 'COMPLETED' && o.channel !== 'portal');
  const byAgents = sold.filter((o) => o.channel === 'agent');
  const claudeCmd = `claude mcp add --transport http ${config.business.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-shop ${data.mcpUrl}`;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Shop</h2>
        <span className="muted">
          Sell the services in your own catalogue to new buyers and to their AI shopping agents. Prices come
          from your data; a buyer always approves the payment at PayPal.
        </span>
        <span className="spacer" />
        <label className="muted">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!data.hasCatalog}
            onChange={(e) => save({ enabled: e.target.checked })}
          />{' '}
          Open for orders
        </label>
      </div>
      {!data.hasCatalog && (
        <div className="callout info" style={{ margin: 16 }}>
          The mapping has no product table with prices, so there is nothing to sell yet. Map a products or
          services table (with a price column) on the Mapping tab.
        </div>
      )}
      <div className="shop-top">
        <section>
          <div className="mini-kpis three">
            <div>
              <span>Sold online</span>
              <b>
                {fmtMoney(
                  sold.reduce((t, o) => t + o.total, 0),
                  cur,
                )}
              </b>
              <small>
                {sold.length} order{sold.length === 1 ? '' : 's'}
              </small>
            </div>
            <div>
              <span>By AI agents</span>
              <b>
                {fmtMoney(
                  byAgents.reduce((t, o) => t + o.total, 0),
                  cur,
                )}
              </b>
              <small>
                {byAgents.length} order{byAgents.length === 1 ? '' : 's'} over MCP
              </small>
            </div>
            <div>
              <span>Portal payments</span>
              <b>
                {fmtMoney(
                  data.orders
                    .filter((o) => o.channel === 'portal' && o.status === 'COMPLETED')
                    .reduce((t, o) => t + o.total, 0),
                  cur,
                )}
              </b>
              <small>several invoices at once</small>
            </div>
          </div>
          <div className="form-row">
            <label className="field grow">
              <span>What you sell, in one line (shown to buyers' agents)</span>
              <input
                className="search"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Largest order ({cur})</span>
              <input
                className="search"
                type="number"
                min={1}
                value={form.maxOrderTotal}
                onChange={(e) => setForm({ ...form, maxOrderTotal: Number(e.target.value) })}
                style={{ width: 110 }}
              />
            </label>
            <button className="btn sm" onClick={() => save({})}>
              Save
            </button>
          </div>
          <h3>Catalogue ({data.catalog.length})</h3>
          <div className="catalog">
            {data.catalog.map((p) => (
              <div key={p.id} className="catalog-item">
                <b>{p.name}</b>
                <span className="muted small">{p.description}</span>
                <span className="price">{fmtMoney(p.price, p.currency)}</span>
              </div>
            ))}
          </div>
        </section>
        <aside className="shop-connect">
          <h3>Where buyers find you</h3>
          <ul className="plain">
            <li>
              Shop page{' '}
              <a href={data.shopUrl} target="_blank" rel="noreferrer">
                {data.shopUrl.replace(/^https?:\/\//, '')} ↗
              </a>
            </li>
            <li>
              Catalogue feed{' '}
              <a href={`${data.shopUrl}/catalog.json`} target="_blank" rel="noreferrer">
                catalog.json ↗
              </a>
            </li>
            <li>
              Buyer MCP endpoint <code>{data.mcpUrl}</code>
            </li>
          </ul>
          <p className="muted small">
            A shopping assistant (Claude or any MCP client) gets four tools: <code>list_products</code>,{' '}
            <code>search_catalog</code>, <code>create_checkout</code> (returns a PayPal link for the person to
            approve) and <code>get_checkout_status</code>. Orders above {fmtMoney(form.maxOrderTotal, cur)}{' '}
            are refused. Your existing customers' assistants use the same endpoint with their portal link:{' '}
            <code>my_invoices</code>, <code>pay_my_invoices</code> and <code>tell_the_business</code>.
          </p>
          <div className="snippet-head">
            <b>Try it with Claude Code</b>
            <span className="spacer" />
            <button className="btn sm" onClick={() => copy('cc', claudeCmd)}>
              {copied === 'cc' ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="snippet">{claudeCmd}</pre>
          <p className="muted small">Then ask: “Book me a portrait session with {config.business.name}.”</p>
        </aside>
      </div>
      <div className={`grid-wrap short ${dark ? 'ag-theme-quartz-dark' : 'ag-theme-quartz'}`}>
        <AgGridReact<Order>
          rowHeight={46}
          suppressAnimationFrame
          rowData={data.orders}
          columnDefs={cols}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          getRowId={(p) => p.data.id}
          overlayNoRowsTemplate={
            '<span class="muted">No orders yet. Open the shop page or connect a buyer agent.</span>'
          }
        />
      </div>
    </div>
  );
}
