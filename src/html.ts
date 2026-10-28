/**
 * Server-rendered pages. One small script (public/pay.js) copies addresses and
 * follows a payment's status; everything works without it except the live update.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { COINS, type OnboardStep } from '@profullstack/coinpay-onboard'
import type { PublicEndpoint } from '@profullstack/webhooks'
import type { InvoiceRow, PaymentRow, User } from './db.js'
import { pitFooter } from './pit-footer.js'
import { ringFooter } from './ring-footer.js'
import { RING_PLACEHOLDER } from './ring.js'
import { coinName, PAID, RECURRENCES, WEBHOOK_EVENTS, type InvoiceLive } from './service.js'

export const SITE = 'https://pay.agent'
export const REPO = 'https://github.com/moshcoder/pay.agent'
const COINPAY = 'https://coinpayportal.com'

/** crawlproof analytics: one async script on every page. */
const TRACKER = '<script data-site="88fcc3cd-2374-47da-8fbb-5cc2ae2e7499" src="https://crawlproof.com/stats.js" async></script>'

/**
 * A crawlproof ad: a cross-origin, sandboxed iframe, so it can never read the
 * page. Only on public pages where nobody is paying, signing in or typing an
 * address. CRAWLPROOF_AD_SLOT overrides the slot; 'off' turns ads off.
 */
export const AD_SLOT = process.env.CRAWLPROOF_AD_SLOT ?? 'b479d9b7-3843-44f3-86f7-bbf0b4f76675'
export const adUnit = () =>
  AD_SLOT === 'off' ? '' : `<div class="ad-unit"><iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=text_link" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe></div>`

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('pay.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M9 23V9h8a5 5 0 0 1 0 10h-8" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23.5" cy="23.5" r="2.5" fill="currentColor"/></svg>`

export type Ctx = { user: User | null; origin: string; csrf: string }

/** ads: one text-link ad at the top of the content (never at the footer, never on the home page). Leave it off wherever someone pays, signs in or enters anything. */
type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; script?: boolean; ads?: boolean }

function layout(o: LayoutOptions): string {
  const signedIn = Boolean(o.ctx.user)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#07090c">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(SITE + o.path)}">`}
<meta property="og:type" content="website">
<meta property="og:site_name" content="pay.agent">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="${STYLE_URL}">
${o.script ? `<script src="${SCRIPT_URL}" defer></script>` : ''}
${TRACKER}
</head>
<body>
${RING_PLACEHOLDER}
<header class="top">
  <a class="brand" href="/">${LOGO}<span>pay<b>.</b>agent</span></a>
  <nav aria-label="Site">
    <a href="/help">Help</a>
    <a href="/help#agents">Agents</a>
    ${signedIn ? `<a href="/me">My link</a><form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="${esc(o.ctx.csrf)}"><button class="linkish">Sign out</button></form>` : '<a href="/auth/start">Sign in</a>'}
  </nav>
</header>
<main>
${o.ads ? adUnit() : ''}
${o.body}
</main>
${ringFooter()}
${pitFooter()}
</body>
</html>`
}

export function homePage(ctx: Ctx): string {
  return layout({
    ctx,
    title: 'pay.agent: get paid in crypto with one link',
    description: 'Your own pay link in a minute. Anyone, person or agent, pays you in USDC, BTC, ETH, SOL and more, straight to your CoinPay wallet or business.',
    path: '/',
    body: `<section class="hero">
  <h1>Get paid in crypto.<br>One link.</h1>
  <p class="tag">Sign in with CoinPay, pick a name, and share <b>pay.agent/you</b>. People and agents pay you in USDC, BTC, ETH, SOL and more. It lands in your CoinPay wallet or business.</p>
  <a class="btn big" href="${ctx.user ? (ctx.user.handle ? '/me' : '/start') : '/auth/start'}">${ctx.user ? (ctx.user.handle ? 'Open my link' : 'Finish setting up') : 'Start with CoinPay'}</a>
  <p class="muted small">No CoinPay account? You make one on the way. Free to set up.</p>
</section>
<div class="grid3">
  <div class="card"><h2><span class="step-n">1</span>Sign in</h2><p class="muted">With your CoinPay account. We set up everything CoinPay needs for you.</p></div>
  <div class="card"><h2><span class="step-n">2</span>Pick a name</h2><p class="muted"><code>pay.agent/yourname</code>, and where the money goes: your wallet or your business.</p></div>
  <div class="card"><h2><span class="step-n">3</span>Share it</h2><p class="muted">Paste it anywhere. Payers enter an amount and pay on CoinPay in any coin you take, or PayPal. You see it arrive.</p></div>
</div>
<div class="card" id="agents">
  <h2>Built for agents too</h2>
  <p class="muted">Every pay link is an API. An agent asks for a checkout, pays it on CoinPay, and checks it landed:</p>
  <pre>curl -X POST https://pay.agent/api/v1/users/alice/payments \\
  -H 'content-type: application/json' -d '{"amount_usd": 5, "payer_email": "me@example.com"}'</pre>
  <p class="muted small">Also a CLI (<code>bunx @profullstack/payagent</code>) and an MCP server (<code>bunx @profullstack/payagent mcp</code>). <a href="/help#agents">How</a></p>
</div>`,
  })
}

export function helpPage(ctx: Ctx): string {
  const coins = COINS.map((c) => `<code>${esc(c.id)}</code> ${esc(c.name)}`).join('<br>')
  return layout({
    ctx,
    title: 'Help · pay.agent',
    description: 'How pay.agent works: Sign in with CoinPay, your pay link, coins, fees, agents, and the API.',
    path: '/help',
    ads: true,
    body: `<section class="hero"><h1>Help</h1><p class="tag">Everything about pay.agent on one page.</p></section>
<div class="card"><h2>What is it?</h2><p>pay.agent gives you a link, <code>pay.agent/yourname</code>, that anyone can pay in crypto. It is a simple front door to <a href="${COINPAY}">CoinPay</a>, which holds the addresses and moves the money. pay.agent never holds your funds.</p></div>
<div class="card"><h2>Getting started</h2><ol>
  <li><a href="/auth/start">Sign in with CoinPay</a> (or make a CoinPay account; it takes a minute).</li>
  <li>Pick your name.</li>
  <li>Choose where money lands:
    <ul><li><b>My CoinPay wallet</b>: payments go to your CoinPay account's payout addresses. We make a small CoinPay business named <code>pay.agent/yourname</code> to take them; you do not have to do anything with it.</li>
    <li><b>My CoinPay business</b>: payments go to a business you already run on CoinPay, using its payout wallets and keeping its settings.</li></ul></li>
  <li>No payout address yet? Paste one during setup (for example a Solana address for USDC on Solana). You can add more later in CoinPay and press <b>Re-check coins</b>.</li>
</ol></div>
<div class="card"><h2>Paying someone</h2><p>Open their link, enter an amount in dollars and your email (CoinPay sends the receipt there), and continue to CoinPay's checkout. Pick any coin they take, or PayPal when they connected it, and pay. CoinPay brings you back to pay.agent, and the page turns green when the payment lands. A checkout is open for one hour.</p></div>
<div class="card"><h2>Fees</h2><p>pay.agent adds no fee. CoinPay takes its normal fee when it forwards the payment to you, and the payer pays their own network fee.</p></div>
<div class="card"><h2>Coins</h2><p class="small">${coins}</p><p class="muted small">A link only offers coins its owner has a payout address for.</p></div>
<div class="card" id="agents"><h2>Agents, API, CLI, MCP</h2>
<p>Every link is an API, no key needed to pay someone:</p>
<pre>GET  /api/v1/users/:handle                 who, and which coins
POST /api/v1/users/:handle/payments        {"amount_usd": 5, "payer_email": "me@example.com", "note": "thanks"}
                                           -> {id, status, expires_at, checkout_url, status_url}
                                           open checkout_url (CoinPay) to pay in any coin they take, or PayPal
GET  /api/v1/payments/:id                  status: pending, confirmed, forwarded, completed (PayPal), expired</pre>
<p>Your own payments, with the API key from <a href="/me">My link</a>:</p>
<pre>GET  /api/v1/me                            -H 'authorization: Bearer pa_…'</pre>
<p id="webhooks">Webhooks: pay.agent POSTs ${WEBHOOK_EVENTS.map((e) => `<code>${esc(e)}</code>`).join(', ')} for your link to your URL, as signed CloudEvents (<a href="https://www.standardwebhooks.com/">Standard Webhooks</a>, via <code>@profullstack/webhooks</code>), retried for about three days. Add one on <a href="/me#webhooks">My link</a> or with your key:</p>
<pre>GET    /api/v1/webhooks                    your endpoints and the event types
POST   /api/v1/webhooks                    {"url": "https://example.com/hook", "events": ["payment.*"]} -> {endpoint, secret}
POST   /api/v1/webhooks/:id/test           send webhook.test now
POST   /api/v1/webhooks/:id/rotate         a new signing secret
GET    /api/v1/webhooks/deliveries         the delivery log
DELETE /api/v1/webhooks/:id</pre>
<p id="invoices">Invoices, sent through CoinPay as you (CoinPay emails the pay link; a repeat sends the next ones):</p>
<pre>POST /api/v1/invoices                      {"to_email": "pat@example.com", "description": "Logo", "amount_usd": 49,
                                            "due_date": "2026-11-30", "recurrence": "monthly", "email": true}
GET  /api/v1/invoices                      yours, with the key
GET  /api/v1/invoices/:id                  public: status (sent, paid, overdue), address, exact amount</pre>
<pre>bunx @profullstack/payagent alice 5 --email=me@example.com  pay alice $5: prints the CoinPay checkout link
bunx @profullstack/payagent status &lt;payment-id&gt;
bunx @profullstack/payagent invoice pat@example.com 49 Logo --repeat=monthly
bunx @profullstack/payagent webhook add https://example.com/hook payment.paid
bunx @profullstack/payagent                               the TUI
claude mcp add payagent -- bunx @profullstack/payagent mcp</pre></div>
<div class="card"><h2>Your data</h2><p>We keep your CoinPay name and email, your handle, which business your link pays, and your CoinPay sign-in (encrypted). Payments to you are listed for you only. Sign out removes the session; to delete everything, use <b>Delete my link</b> on <a href="/me">My link</a>.</p></div>
<div class="card"><h2>Reaching pay.agent</h2><p><code>pay.agent</code> is a <a href="https://pit.world">Moshpit</a> name. Without Moshpit DNS, use <a href="https://pay.agent.pit.world/">pay.agent.pit.world</a>: the same site.</p></div>`,
  })
}

export function wizardPage(ctx: Ctx, o: { businesses: { id: string; name: string }[]; accountCoins: string[]; error?: { message: string; field?: string }; values?: Record<string, string>; coinpayError?: string }): string {
  const v = o.values ?? {}
  const hasWallets = o.accountCoins.length > 0
  const suggested = (ctx.user?.name || ctx.user?.email.split('@')[0] || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '').slice(0, 30)
  const mode = v.mode ?? 'wallet'
  return layout({
    ctx,
    noindex: true,
    title: 'Set up your link · pay.agent',
    description: 'Pick your pay.agent name and where payments land.',
    path: '/start',
    body: `<section class="hero"><h1>Your pay link</h1><p class="tag">Two choices and you are done. We set up everything on CoinPay for you.</p></section>
${o.error ? `<p class="note error">${esc(o.error.message)}</p>` : ''}
${o.coinpayError ? `<p class="note">${esc(o.coinpayError)}</p>` : ''}
<form method="post" action="/start" class="card">
  <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
  <h2><span class="step-n">1</span>Your name</h2>
  <label for="handle">Your link</label>
  <div class="handle-input"><span>pay.agent/</span><input id="handle" name="handle" required minlength="2" maxlength="30" pattern="[a-z0-9][a-z0-9_\\-]{1,29}" autocomplete="off" autocapitalize="none" spellcheck="false" value="${esc(v.handle ?? suggested)}"></div>
  <h2 style="margin-top:1.4rem"><span class="step-n">2</span>Where money lands</h2>
  <label class="choice"><input type="radio" name="mode" value="wallet" ${mode === 'wallet' ? 'checked' : ''}><span><b>My CoinPay wallet</b><span class="muted">Payments go to your CoinPay account's payout addresses.${hasWallets ? ` You have ${esc(o.accountCoins.map(coinName).join(', '))}.` : ''}</span></span></label>
  ${o.businesses.length
    ? `<label class="choice"><input type="radio" name="mode" value="business" ${mode === 'business' ? 'checked' : ''}><span><b>My CoinPay business</b><span class="muted">Payments go to a business you run on CoinPay.</span>
  <select name="business_id" aria-label="Business">${o.businesses.map((b) => `<option value="${esc(b.id)}" ${v.business_id === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></span></label>`
    : `<p class="muted small">Have a business on CoinPay? It will show up here too.</p>`}
  <details ${hasWallets ? '' : 'open'} style="margin-top:1rem">
    <summary>${hasWallets ? 'Add another payout address (optional)' : 'Add a payout address (you need at least one)'}</summary>
    <p class="muted small">Where CoinPay sends what you are paid. Paste an address from any wallet you control.</p>
    <div class="row">
      <select name="address_coin" aria-label="Coin">${COINS.map((c) => `<option value="${c.id}" ${v.address_coin === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <input name="address" placeholder="Address" autocomplete="off" spellcheck="false" value="${esc(v.address ?? '')}">
    </div>
    <p class="muted small">Or <a href="${COINPAY}/web-wallet" target="_blank" rel="noopener">make a CoinPay wallet</a>, then come back and press the button.</p>
  </details>
  <p style="margin-top:1.4rem"><button class="btn wide big">Make my link</button></p>
</form>`,
  })
}

export function setupDonePage(ctx: Ctx, o: { handle: string; steps: OnboardStep[]; coins: string[] }): string {
  return layout({
    ctx,
    noindex: true,
    title: 'Your link is ready · pay.agent',
    description: 'Your pay.agent link is ready.',
    path: '/start',
    script: true,
    body: `<section class="hero"><h1>${o.coins.length ? 'You can get paid.' : 'Almost there.'}</h1>
<p class="tag">${o.coins.length ? `Share your link. It takes ${esc(o.coins.map(coinName).join(', '))}.` : 'Your link is made, but it needs a payout address before anyone can pay it.'}</p></section>
<div class="card center">${linkBox(ctx.origin, o.handle)}</div>
${o.coins.length ? '' : `<p class="note">Add a payout address in <a href="${COINPAY}/dashboard/wallets" target="_blank" rel="noopener">CoinPay</a> (or <a href="/start">here</a>), then press <b>Re-check coins</b> on <a href="/me">My link</a>.</p>`}
<div class="card"><h2>What we set up on CoinPay</h2><ul class="steps">${o.steps.map((s) => `<li><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '✓' : '✗'}</span> ${esc(s.detail)}</li>`).join('')}</ul></div>
<p class="center"><a class="btn" href="/me">Go to my link</a></p>`,
  })
}

function linkBox(origin: string, handle: string): string {
  const url = `${origin}/${handle}`
  return `<p class="muted small" style="margin:0">Your link</p>
<p style="font-size:1.4rem;font-weight:800;margin:.3rem 0 .8rem;word-break:break-all"><a href="/${esc(handle)}">${esc(url.replace(/^https:\/\//, ''))}</a></p>
<div class="address"><code>${esc(url)}</code><button class="copy" type="button" data-copy="${esc(url)}">Copy</button></div>`
}

export function dashboardPage(ctx: Ctx, o: { user: User; payments: PaymentRow[]; invoices?: InvoiceRow[]; apiKey?: string; qr: string; flash?: string; coinsNote?: string; invoiceForm?: Record<string, string>; webhooks?: PublicEndpoint[]; webhookSecret?: string; webhookNote?: string }): string {
  const f = o.invoiceForm ?? {}
  const csrf = `<input type="hidden" name="csrf" value="${esc(ctx.csrf)}">`
  const invoices = o.invoices ?? []
  const u = o.user
  const received = o.payments.filter((p) => PAID.has(p.status)).reduce((sum, p) => sum + p.amountUsd, 0)
  return layout({
    ctx,
    noindex: true,
    title: `pay.agent/${u.handle}`,
    description: 'Your pay.agent link, payments and settings.',
    path: '/me',
    script: true,
    body: `<section class="hero" style="padding-bottom:1rem"><h1>Hi${u.name ? `, ${esc(u.name.split(' ')[0])}` : ''}.</h1><p class="tag">${received ? `${usd(received)} received through your link so far.` : 'Share your link to get paid.'}</p></section>
${o.flash ? `<p class="note">${esc(o.flash)}</p>` : ''}
<div class="card center" id="coins">${linkBox(ctx.origin, u.handle!)}${o.qr}
<p class="muted small">Takes ${u.coins.length ? esc(u.coins.map(coinName).join(', ')) : '<b>nothing yet: add a payout address</b>'} · pays ${u.mode === 'business' ? `your business <b>${esc(u.businessName)}</b>` : 'your CoinPay wallet'}</p>
<form method="post" action="/me/recheck#coins"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><button class="copy">Re-check coins</button></form>
${o.coinsNote ? `<p class="note" role="status">${esc(o.coinsNote)}</p>` : ''}</div>
<div class="card"><h2>Ask for an amount</h2><p class="muted small">A link with the amount filled in.</p>
<form method="get" action="/${esc(u.handle)}" class="row"><input name="amount" inputmode="decimal" placeholder="Amount (USD)"><input name="note" maxlength="140" placeholder="What for (optional)"><button class="btn">Make link</button></form></div>
<div class="card" id="invoice"><h2>Send an invoice</h2><p class="muted small">CoinPay emails them a pay link for the exact amount. Repeat it and CoinPay sends the next ones by itself.</p>
<form method="post" action="/me/invoice"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
<div class="row"><input name="to_email" type="email" required maxlength="254" placeholder="Their email" value="${esc(f.to_email ?? '')}"><input name="to_name" maxlength="80" placeholder="Their name (optional)" value="${esc(f.to_name ?? '')}"></div>
<input name="description" required maxlength="500" placeholder="What for" value="${esc(f.description ?? '')}">
<div class="row"><input name="amount" required inputmode="decimal" placeholder="Amount (USD)" value="${esc(f.amount ?? '')}"><select name="coin" aria-label="Paid in">${u.coins.map((c) => `<option value="${esc(c)}" ${f.coin === c ? 'selected' : ''}>${esc(coinName(c))}</option>`).join('')}</select></div>
<div class="row"><label class="small">Due <input name="due_date" type="date" value="${esc(f.due_date ?? '')}"></label><label class="small">Repeat <select name="recurrence">${['none', ...RECURRENCES].map((r) => `<option value="${r}" ${f.recurrence === r ? 'selected' : ''}>${r === 'none' ? 'once' : r}</option>`).join('')}</select></label></div>
<p><button class="btn"${u.coins.length ? '' : ' disabled'}>Send invoice</button></p></form>
${invoices.length ? `<table><thead><tr><th>No.</th><th>To</th><th>Amount</th><th>For</th><th>Status</th></tr></thead><tbody>${invoices
      .map((i) => `<tr><td>${esc(i.number)}</td><td>${esc(i.toName || i.toEmail)}</td><td>${usd(i.amountUsd)}${i.recurrence ? ` <span class="muted small">${esc(i.recurrence)}</span>` : ''}</td><td>${esc(i.description.slice(0, 60))}</td><td><a class="status ${esc(i.status)}" href="/i/${esc(i.id)}">${esc(i.status)}</a></td></tr>`)
      .join('')}</tbody></table>` : ''}</div>
<div class="card"><h2>Payments</h2>${o.payments.length ? `<table><thead><tr><th>When</th><th>Amount</th><th>Paid with</th><th>Note</th><th>Status</th></tr></thead><tbody>${o.payments
      .map((p) => `<tr><td>${esc(new Date(p.createdAt).toISOString().slice(0, 16).replace('T', ' '))}</td><td>${usd(p.amountUsd)}</td><td>${esc(p.coin ? coinName(p.coin) : '-')}</td><td>${esc(p.note)}</td><td><a class="status ${esc(p.status)}" href="/p/${esc(p.id)}">${esc(p.status)}</a></td></tr>`)
      .join('')}</tbody></table>` : '<p class="muted">None yet.</p>'}</div>
<div class="card"><h2>API key</h2>${o.apiKey ? `<p>Your key, shown once:</p><div class="address"><code>${esc(o.apiKey)}</code><button class="copy" type="button" data-copy="${esc(o.apiKey)}">Copy</button></div>` : `<p class="muted small">For <code>GET /api/v1/me</code>, the CLI and MCP. ${u.apiKeyHash ? 'You have one; making a new one replaces it.' : ''}</p>`}
<form method="post" action="/me/key"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><button class="copy">${u.apiKeyHash ? 'Replace my key' : 'Make a key'}</button></form></div>
<div class="card" id="webhooks"><h2>Webhooks</h2><p class="muted small">pay.agent POSTs what happens on your link to your URL: ${WEBHOOK_EVENTS.map((e) => `<code>${esc(e)}</code>`).join(', ')}. CloudEvents JSON, signed per <a href="https://www.standardwebhooks.com/">Standard Webhooks</a> (verify with <code>@profullstack/webhooks</code> or any Standard Webhooks library); retried for about three days.</p>
${o.webhookNote ? `<p class="note" role="status">${esc(o.webhookNote)}</p>` : ''}
${o.webhookSecret ? `<p>Signing secret:</p><div class="address"><code>${esc(o.webhookSecret)}</code><button class="copy" type="button" data-copy="${esc(o.webhookSecret)}">Copy</button></div>` : ''}
${(o.webhooks ?? [])
      .map(
        (w) => `<div class="row"><code>${esc(w.url)}</code> <span class="muted small">${esc(w.events.join(', '))}${w.enabled ? '' : ` · <span class="bad">off: ${esc(w.disabled_reason ?? 'disabled')}</span>`}</span>
${(['test', 'rotate', 'delete'] as const).map((a) => `<form method="post" action="/me/webhooks/${a}#webhooks">${csrf}<input type="hidden" name="id" value="${esc(w.id)}"><button class="copy${a === 'delete' ? ' bad' : ''}">${a === 'test' ? 'Send a test' : a === 'rotate' ? 'New secret' : 'Remove'}</button></form>`).join('')}</div>`,
      )
      .join('')}
<form method="post" action="/me/webhooks/add#webhooks" class="row">${csrf}<input name="url" type="url" required maxlength="2000" placeholder="https://example.com/webhooks/payagent" aria-label="Webhook URL"><input name="events" maxlength="300" placeholder="Events (blank = all, or payment.*)" aria-label="Events"><button class="btn">Add webhook</button></form>
<p class="muted small">Also from the CLI (<code>payagent webhooks</code>), MCP (<code>create_webhook</code>) and <code>/api/v1/webhooks</code> with your key.</p></div>
<details class="card"><summary>Change or delete</summary>
<p><a href="/start">Change my name or where money lands</a></p>
<form method="post" action="/me/delete"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><button class="copy bad">Delete my link and everything pay.agent keeps</button></form>
<p class="muted small">Your CoinPay account, wallets and businesses stay as they are.</p></details>`,
  })
}

export function payPage(ctx: Ctx, o: { payee: User; amount?: string; note?: string; email?: string; payer?: string; error?: string }): string {
  const p = o.payee
  const initial = (p.name || p.handle || '?').trim().charAt(0).toUpperCase()
  return layout({
    ctx,
    title: `Pay ${p.name || p.handle} · pay.agent`,
    description: `Pay ${p.name || p.handle} in crypto${p.coins.length ? `: ${p.coins.map(coinName).join(', ')}` : ''}, through CoinPay.`,
    path: `/${p.handle}`,
    body: `<section class="payee"><div class="avatar" aria-hidden="true">${esc(initial)}</div><h1>${esc(p.name || p.handle)}</h1><p class="muted">pay.agent/${esc(p.handle)}</p></section>
${o.error ? `<p class="note error">${esc(o.error)}</p>` : ''}
<form method="post" action="/${esc(p.handle)}" class="card">
  <label for="amount" class="center">Amount in USD</label>
  <input id="amount" class="amount-input" name="amount" required inputmode="decimal" placeholder="0" value="${esc(o.amount ?? '')}" autofocus>
  <label for="email">Your email <span class="muted">(for the receipt)</span></label>
  <input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(o.email ?? '')}">
  <label for="note">What for <span class="muted">(optional)</span></label>
  <input id="note" name="note" maxlength="140" value="${esc(o.note ?? '')}">
  <label for="payer">Your name <span class="muted">(optional)</span></label>
  <input id="payer" name="payer" maxlength="60" value="${esc(o.payer ?? '')}">
  <input class="hp" name="website" type="text" tabindex="-1" autocomplete="off" aria-hidden="true">
  <p style="margin-top:1.2rem"><button class="btn wide big">Continue to pay</button></p>
  <p class="muted small center">You pick the coin (or PayPal, when ${esc(p.name || p.handle)} takes it) on CoinPay's secure checkout.</p>
</form>
<p class="center muted small">Want your own? <a href="/">Get a pay link</a></p>`,
  })
}

export function checkoutPage(ctx: Ctx, o: { payment: PaymentRow; payee: User | null; qr: string }): string {
  const p = o.payment
  const paid = PAID.has(p.status)
  const over = !paid && (p.status === 'expired' || p.status === 'failed')
  const who = o.payee?.name || p.handle
  // Payments made before checkout sessions: an address and an exact amount.
  const legacy = Boolean(p.address)
  const payBox = legacy
    ? `<p class="center">Send exactly</p>
  <p class="amount" style="font-size:1.6rem">${esc(p.amountCrypto)} <span class="muted">${esc(coinName(p.coin))}</span></p>
  <div class="address"><code>${esc(p.amountCrypto)}</code><button class="copy" type="button" data-copy="${esc(p.amountCrypto)}">Copy amount</button></div>
  ${o.qr}
  <p class="center muted small">to this address</p>
  <div class="address"><code>${esc(p.address)}</code><button class="copy" type="button" data-copy="${esc(p.address)}">Copy</button></div>
  <p class="muted small center">${p.expiresAt ? `Good until ${esc(new Date(p.expiresAt).toUTCString().replace(' GMT', ' UTC'))}. ` : ''}Send it in one payment, on the right network, from a wallet you control. This page updates by itself.</p>`
    : over
      ? `<p class="center">This checkout has expired. <a href="/${esc(p.handle)}">Start again</a>.</p>`
      : `<p class="center">Not paid yet. If you have not finished, pick up where you left off on CoinPay.</p>
  <p class="center"><a class="btn big" href="${esc(p.checkoutUrl)}">Continue to pay</a></p>
  <p class="muted small center">${p.expiresAt ? `Open until ${esc(new Date(p.expiresAt).toUTCString().replace(' GMT', ' UTC'))}. ` : ''}Already sent it? This page updates by itself once CoinPay sees it.</p>`
  return layout({
    ctx,
    noindex: true,
    script: true,
    title: `Pay ${usd(p.amountUsd)} to ${p.handle} · pay.agent`,
    description: legacy ? 'Send the exact amount to the address shown.' : `Your payment to ${who} through CoinPay.`,
    path: `/p/${p.id}`,
    body: `<section class="payee" style="padding-top:2rem"><p class="muted" style="margin:0">Paying ${esc(who)} · pay.agent/${esc(p.handle)}</p>
<p class="amount">${usd(p.amountUsd)}</p>${p.note ? `<p class="muted">${esc(p.note)}</p>` : ''}
<p><span class="status ${esc(p.status)}" id="status" data-payment="${esc(p.id)}">${paid ? 'paid' : esc(p.status)}</span></p></section>
<div class="card" id="pay-box" ${paid ? 'hidden' : ''}>
  ${payBox}
</div>
<div class="card center" id="paid-box" ${paid ? '' : 'hidden'}><h2 class="ok">Paid. Thank you.</h2><p class="muted">CoinPay has the payment and forwards it to ${esc(who)}.${p.payerEmail ? ' Your receipt goes to your email.' : ''}</p></div>
<p class="center muted small"><a href="/${esc(p.handle)}">Back</a> · Payment ${esc(p.id)}</p>`,
  })
}

export function invoicePage(ctx: Ctx, o: { invoice: InvoiceRow; live: InvoiceLive | null; payee: User | null; qr: string; emailed: boolean }): string {
  const i = o.invoice
  const paid = i.status === 'paid'
  const from = o.payee?.name || i.handle
  const open = !paid && o.live?.address
  return layout({
    ctx,
    noindex: true,
    title: `Invoice ${i.number || ''} from ${from} · pay.agent`.replace('  ', ' '),
    description: `${usd(i.amountUsd)} for ${i.description}`,
    path: `/i/${i.id}`,
    body: `<section class="payee" style="padding-top:2rem"><p class="muted" style="margin:0">Invoice${i.number ? ` ${esc(i.number)}` : ''} from ${esc(from)} · pay.agent/${esc(i.handle)}</p>
<p class="amount">${usd(i.amountUsd)}</p><p>${esc(i.description)}</p>
<p class="muted small">To ${esc(i.toName || 'you')}${i.dueDate ? ` · due ${esc(i.dueDate)}` : ''}${i.recurrence ? ` · repeats ${esc(i.recurrence)}` : ''}</p>
<p><span class="status ${esc(i.status)}">${esc(i.status)}</span></p></section>
${o.emailed ? '' : '<p class="note">The invoice is live, but CoinPay did not email it. Send them this page.</p>'}
${open ? `<div class="card">
  <p class="center">Send exactly</p>
  <p class="amount" style="font-size:1.6rem">${esc(o.live!.amountCrypto)} <span class="muted">${esc(coinName(i.coin))}</span></p>
  <div class="address"><code>${esc(o.live!.amountCrypto)}</code><button class="copy" type="button" data-copy="${esc(o.live!.amountCrypto)}">Copy amount</button></div>
  ${o.qr}
  <p class="center muted small">to this address</p>
  <div class="address"><code>${esc(o.live!.address)}</code><button class="copy" type="button" data-copy="${esc(o.live!.address)}">Copy</button></div>
  <p class="muted small center">In one payment, on the right network. Or <a href="${esc(i.payUrl)}">pay it on CoinPay</a>, where you can also download a PDF.</p>
</div>` : paid ? `<div class="card center"><h2 class="ok">Paid. Thank you.</h2><p class="muted">CoinPay has the payment and forwards it to ${esc(from)}.</p></div>` : `<p class="center"><a class="btn big" href="${esc(i.payUrl)}">Pay on CoinPay</a></p>`}
<p class="center muted small">Paid in crypto through <a href="https://coinpayportal.com">CoinPay</a>. Want to send invoices too? <a href="/">Get a pay link</a></p>`,
  })
}

export function messagePage(ctx: Ctx, o: { title: string; message: string; status?: number }): string {
  return layout({ ctx, noindex: true, title: `${o.title} · pay.agent`, description: o.message, path: '/', body: `<section class="hero"><h1>${esc(o.title)}</h1><p class="tag">${esc(o.message)}</p><a class="btn" href="/">Home</a></section>` })
}
