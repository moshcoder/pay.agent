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
- **Coins and cards** (0.7.0): a new link also takes USDC on Base, Polygon and Solana at an address the owner
  already has on that chain (added as wallets of the `pay.agent/<handle>` business only; `"stablecoins": false`
  on claim, or untick it in the wizard, to skip). The owner picks what the link takes on `/me#takes`,
  `PUT /api/v1/me/coins {"coins": ["usdc_base", "sol", "paypal"] | "all"}`, `{"add_stablecoins": true}`,
  `payagent coins set|add-usdc|recheck`, or MCP `my_coins`; checkouts pass the pick as `allowed_methods`.
  Cards go through PayPal guest checkout once the owner connects their own PayPal REST app to that CoinPay
  business (`/help#cards`); `card` in the API turns true at the first checkout that offers it. No Stripe.

Onboarding is [@profullstack/coinpay-onboard](https://github.com/profullstack/coinpay-onboard):
one pass makes the CoinPay business, payout wallets and webhook. The same
engine runs at every fleet site launch.

## Run it

```sh
bun install
PAYAGENT_KEY=$(openssl rand -hex 32) PAYAGENT_COINPAY_CLIENT_ID=cp_… bun src/server.ts
```

Settings: `PAYAGENT_KEY` (seals webhook secrets and sign-in state; it can NOT open anyone's CoinPay tokens: those are sealed under a per-sign-in key kept in memory only, so a restart pauses every link until its owner signs in again, and `/me` + `GET /api/v1/me` show `locked`), `LEGACY_KEY_MIGRATION` (`off` stops migrating pre-0.6 token copies; `sqlite3 pay-agent.db 'select count(*) from users where tokens is not null'` counts what is left), `PAYAGENT_COINPAY_CLIENT_ID`
/ `_SECRET` (a CoinPay OAuth client with scopes `openid profile email wallet:read merchant`),
`PAYAGENT_DB` (SQLite path), `PORT` (8796), `COINPAY_BASE`, `PAYAGENT_WEBHOOK_ORIGIN`.

Deploy: `bin/install.sh` (OpenInstall) on the box, vault `profullstack/pay-agent--prod`.

MIT
