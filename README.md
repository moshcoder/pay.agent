# pay.agent

Get paid in crypto with one link. Venmo for the agentic web, on CoinPay.

Sign in with CoinPay, pick a name, and share `pay.agent/you`. People and agents
pay you in USDC, BTC, ETH, SOL and more; it lands in your CoinPay wallet or
your CoinPay business. pay.agent never holds funds.

- **Web**: https://pay.agent (Moshpit DNS) or https://pay.agent.pit.world
- **API**: `POST /api/v1/users/:handle/payments {"amount_usd": 5, "payer_email": "me@example.com"}` → `checkout_url`, a CoinPay
  hosted checkout on the payee's own business: the payer picks any coin the payee takes, or PayPal when they connected it
- **Invoices**: `POST /api/v1/invoices {"to_email", "description", "amount_usd", "recurrence": "monthly"}` (your key) → a real
  CoinPay invoice sent as you; CoinPay emails the pay link and sends the repeats. `payagent invoice pat@example.com 49 Logo`,
  MCP `send_invoice`. Each one has a public page at `pay.agent/i/<id>`.
- **Webhooks**: pay.agent POSTs `payment.created`, `payment.paid`, `payment.expired`, `payment.failed`,
  `invoice.created`, `invoice.paid`, `invoice.overdue` and `invoice.cancelled` for your link to your URL, as
  CloudEvents signed per [Standard Webhooks](https://www.standardwebhooks.com/) (via
  [@profullstack/webhooks](https://github.com/profullstack/webhooks)), retried for about three days. Add one on
  `/me#webhooks`, `POST /api/v1/webhooks {"url", "events": ["payment.*"]}` (your key), `payagent webhook add <url>`,
  or MCP `create_webhook`. Signing secrets are sealed with `PAYAGENT_KEY`.
- **CLI / TUI**: `bunx @profullstack/payagent alice 5 --email=me@example.com`, or `bunx @profullstack/payagent`
- **MCP**: `claude mcp add payagent -- bunx @profullstack/payagent mcp`
- **Agents, no browser**: `COINPAY_EMAIL=… COINPAY_PASSWORD=… bunx @profullstack/payagent claim mybot` (or
  `COINPAY_TOKEN`, or MCP `claim`) signs in to CoinPay as you, approves pay.agent with that session, claims
  `pay.agent/mybot` and prints a `pa_` key. Run it again any time for a new key. By hand:
  `POST /api/v1/claim/start` → the PKCE-bound authorize request; `POST <consent.endpoint>` with
  `authorization: Bearer <CoinPay session>` and `consent.body` → `{ redirect }`; `POST /api/v1/claim
  {"redirect", "handle"}` → your link and `api_key`. Your CoinPay credentials only ever go to CoinPay.

Onboarding is [@profullstack/coinpay-onboard](https://github.com/profullstack/coinpay-onboard):
one pass makes the CoinPay business, payout wallets and webhook. The same
engine runs at every fleet site launch.

## Run it

```sh
bun install
PAYAGENT_KEY=$(openssl rand -hex 32) PAYAGENT_COINPAY_CLIENT_ID=cp_… bun src/server.ts
```

Settings: `PAYAGENT_KEY` (encrypts stored CoinPay tokens), `PAYAGENT_COINPAY_CLIENT_ID`
/ `_SECRET` (a CoinPay OAuth client with scopes `openid profile email wallet:read merchant`),
`PAYAGENT_DB` (SQLite path), `PORT` (8796), `COINPAY_BASE`, `PAYAGENT_WEBHOOK_ORIGIN`.

Deploy: `bin/install.sh` (OpenInstall) on the box, vault `profullstack/pay-agent--prod`.

MIT
