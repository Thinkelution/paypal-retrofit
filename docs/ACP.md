# Agentic Commerce Protocol (ACP)

retrofit lets any AI agent that speaks the [Agentic Commerce Protocol](https://www.agenticcommerce.dev) buy from a retrofitted business's catalogue, paid through PayPal. The business turns it on with its shop (**Shop → Open for orders**; on in the demo); prices come only from its own product table and orders are capped by its own limit.

| | |
| --- | --- |
| Discovery | `GET /.well-known/acp.json` (public, cached for an hour) |
| REST API | `<base>/acp/checkout_sessions` |
| MCP binding | `POST <base>/acp/mcp`: `create_checkout_session`, `get_checkout_session`, `update_checkout_session`, `complete_checkout_session`, `cancel_checkout_session`, each taking `{meta, id, payload}` |
| Versions | `2026-01-16`, `2026-04-17` (`API-Version` header, or `meta.api_version` over MCP) |
| Auth | `Authorization: Bearer <RETROFIT_ACP_TOKEN>`. In the simulator any token is accepted, since no money moves; with a real PayPal environment the API is off until the token is set. |
| Payment handler | `io.github.thinkelution.retrofit.paypal_order` (id `paypal`): a PayPal order the buyer approves in PayPal. Spec at `<base>/acp/handlers/paypal_order`, schemas next to it. |

## A checkout with curl (against `pnpm retrofit demo`)

```bash
B=http://localhost:8787
H=(-H 'Authorization: Bearer test-agent' -H 'API-Version: 2026-04-17' -H 'Content-Type: application/json')

curl -s $B/.well-known/acp.json

# 1. Create a session for one portrait session (item ids are the business's product keys).
curl -s "${H[@]}" -H 'Idempotency-Key: create-1' -X POST $B/acp/checkout_sessions \
  -d '{"line_items":[{"id":"1","quantity":1}],"currency":"usd","capabilities":{},"buyer":{"email":"ada@example.com"}}'
```

The response is the authoritative cart, all amounts in cents:

```json
{
  "id": "cs_…",
  "status": "ready_for_payment",
  "currency": "usd",
  "line_items": [{ "id": "li_1", "item": { "id": "1" }, "quantity": 1, "name": "Portrait session", "unit_amount": 25000, "totals": [] }],
  "totals": [{ "type": "total", "display_text": "Total", "amount": 25000 }],
  "capabilities": { "payment": { "handlers": [{ "id": "paypal", "psp": "paypal", "config": { "order_id": "…", "approve_url": "…" } }] } },
  "continue_url": "<the PayPal approval link>",
  "messages": [{ "type": "info", "resolution": "requires_buyer_review", "content": "The buyer reviews and approves this payment in PayPal at continue_url…" }]
}
```

2. The buyer opens `continue_url` and approves the payment in PayPal (in the simulator: **Pay with PayPal**).
3. The agent completes the session with the order id from the handler config:

```bash
curl -s "${H[@]}" -H 'Idempotency-Key: complete-1' -X POST $B/acp/checkout_sessions/cs_…/complete \
  -d '{"payment_data":{"handler_id":"paypal","instrument":{"type":"paypal_order","credential":{"type":"paypal_order_id","order_id":"…"}}}}'
```

It returns `status: completed` and the `order` (`id`, `checkout_session_id`, `permalink_url`). The sale is in the business's payments ledger with its PayPal fee, like any other PayPal order.

## What retrofit enforces

- **Idempotency** on every POST: keys are scoped to the caller and the endpoint; the same key and body replays the stored response with its status (`Idempotent-Replayed: true`) and nothing runs twice; a different body is `422 idempotency_conflict`; a request still running is `409 idempotency_in_flight` with `Retry-After`; server errors are not stored. Missing key: `400 idempotency_key_required`.
- **Errors** are flat: `{type, code, message, param}` with JSONPath params, for example `approval_required` (`$.payment_data`) when the buyer has not approved yet, `not_found` (`$.line_items[0].id`) for an unknown item, `maximum_exceeded` above the business's order limit, `missing_api_version` with `supported_versions`.
- **The cart decides the PayPal order.** Changing the items creates a new PayPal order and approval link; the old one is cancelled, and a cancelled session's order is never captured, even if the buyer approves it later.
- Over MCP, the same session objects come back as the tool result (`structuredContent`); errors are JSON-RPC `-32000` with the ACP error in `data`.

## Not yet

Request signatures (`Signature`, `Timestamp`) are not verified, order webhooks to the agent are not sent, and only digital or service fulfillment is offered (`service`), since nothing is shipped.
