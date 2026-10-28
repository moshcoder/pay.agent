import { describe, expect, test } from 'bun:test'
import { signWebhook } from '@profullstack/coinpay-onboard'
import { Sealer, Store, validHandle } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { onKey, initialState } from '../src/tui.ts'
import { main } from '../src/cli.ts'
import { PayAgentClient } from '../src/client.ts'
import { fakeCoinPay } from './fake-coinpay.ts'

function setup() {
  const cp = fakeCoinPay()
  const store = new Store(':memory:', new Sealer('test-key-0123456789abcdef'))
  const app = createApp({ store, key: 'test-key-0123456789abcdef', secureCookies: false, config: { coinpayBase: 'https://cp.test', clientId: 'cp_client', webhookOrigin: 'https://pay.agent.pit.world', fetch: cp.fetchImpl } })
  let cookie = ''
  const req = async (path: string, init: RequestInit & { form?: Record<string, string> } = {}, host = 'pay.agent') => {
    const headers = new Headers(init.headers)
    headers.set('host', host)
    if (cookie) headers.set('cookie', cookie)
    let body = init.body
    if (init.form) {
      body = new URLSearchParams(init.form).toString()
      headers.set('content-type', 'application/x-www-form-urlencoded')
    }
    const res = await app.fetch(new Request(`http://localhost${path}`, { ...init, headers, body, redirect: 'manual' }), { ip: '1.2.3.4' })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    return res
  }
  const csrfFrom = async (res: Response) => /name="csrf" value="([0-9a-f]+)"/.exec(await res.text())?.[1] ?? ''
  return { cp, store, req, csrfFrom }
}

async function signIn(t: ReturnType<typeof setup>, host = 'pay.agent') {
  const start = await t.req('/auth/start', {}, host)
  const loc = new URL(start.headers.get('location')!)
  return t.req(`/auth/callback?code=c1&state=${loc.searchParams.get('state')}`, {}, host)
}

describe('pay.agent end to end', () => {
  test('sign in, make a link, get paid, see it', async () => {
    const t = setup()
    const start = await t.req('/auth/start')
    expect(start.status).toBe(302)
    const loc = new URL(start.headers.get('location')!)
    expect(loc.origin + loc.pathname).toBe('https://cp.test/api/oauth/authorize')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://pay.agent/auth/callback')
    expect(loc.searchParams.get('scope')).toContain('merchant')
    expect(loc.searchParams.get('prompt')).toBe('select_account')

    const cb = await t.req(`/auth/callback?code=c1&state=${loc.searchParams.get('state')}`)
    expect(cb.headers.get('location')).toBe('/start')

    const wizard = await t.req('/start')
    expect(wizard.status).toBe(200)
    const csrf = await t.csrfFrom(wizard.clone())
    const wizardHtml = await wizard.text()
    expect(wizardHtml).toContain('crawlproof.com/stats.js')
    expect(wizardHtml).not.toContain('ad-unit')
    const made = await t.req('/start', { method: 'POST', form: { csrf, handle: 'Alice', mode: 'wallet' } })
    const done = await made.text()
    expect(made.status).toBe(200)
    expect(done).toContain('You can get paid.')
    expect(t.cp.state.businesses[0]).toMatchObject({ name: 'pay.agent/alice', webhook_url: 'https://pay.agent.pit.world/hooks/coinpay' })

    // A bot fills the hidden honeypot: no payment is made.
    const bot = await t.req('/alice', { method: 'POST', form: { amount: '$12.50', email: 'bot@example.com', website: 'https://spam.example' } })
    expect(bot.status).toBe(303)
    expect(bot.headers.get('location')).toBe('/alice')
    expect(t.cp.state.lastSessionBody).toBeNull()
    const payHtml = await (await t.req('/alice')).text()
    expect(payHtml).toContain('name="website"')
    expect(payHtml).toContain('name="email" type="email" required')
    // No coin picker of our own: CoinPay's checkout offers every coin, and PayPal.
    expect(payHtml).not.toContain('name="coin"')

    // No email, no checkout.
    const noEmail = await t.req('/alice', { method: 'POST', form: { amount: '5' } })
    expect(noEmail.status).toBe(400)
    expect(await noEmail.text()).toContain('Your email, for the receipt.')
    expect(t.cp.state.lastSessionBody).toBeNull()

    // A stranger pays the link: a checkout session on alice's own business, as alice.
    const pay = await t.req('/alice', { method: 'POST', form: { amount: '$12.50', email: 'Pat@Example.com', note: 'pizza', payer: 'Pat' } })
    expect(pay.status).toBe(303)
    expect(pay.headers.get('location')).toBe('https://cp.test/checkout/cs_test1')
    const sb = t.cp.state.lastSessionBody
    expect(sb).toMatchObject({ business_id: 'b1', amount: 12.5, currency: 'USD', customer_email: 'pat@example.com', account_id: 'pat@example.com', property: 'pay.agent.pit.world', cancel_url: 'https://pay.agent/alice', description: 'pay.agent/alice: pizza' })
    expect(sb.metadata).toMatchObject({ via: 'pay.agent', handle: 'alice', note: 'pizza', payer: 'Pat' })
    const pid = sb.metadata.payagent_id as string
    expect(pid).toMatch(/^pl_[0-9a-f]{24}$/)
    expect(sb.success_url).toBe(`https://pay.agent/p/${pid}?session={CHECKOUT_SESSION_ID}`)
    expect(t.cp.state.sessionAuth[0]).toMatch(/^Bearer at-/)
    expect(sb.payment_method).toBeUndefined()
    expect(t.cp.state.lastPaymentBody).toBeNull()
    expect(t.store.payment(pid)).toMatchObject({ sessionId: 'cs_test1', checkoutUrl: 'https://cp.test/checkout/cs_test1', payerEmail: 'pat@example.com', status: 'pending', handle: 'alice' })
    const checkout = await (await t.req(`/p/${pid}?session=cs_test1`)).text()
    expect(checkout).toContain('https://cp.test/checkout/cs_test1')
    expect(checkout).not.toContain('ad-unit')
    expect(await (await t.req('/alice')).text()).not.toContain('ad-unit')

    const secret = t.cp.state.businesses[0].webhook_secret
    const hook = (event: unknown, sig?: string) => {
      const body = JSON.stringify(event)
      return t.req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': sig ?? signWebhook(body, secret) } })
    }
    const nested = (type: string, status: string, extra: Record<string, unknown> = {}) => ({ id: `evt_${type}`, type, business_id: 'b1', data: { payment_id: 'pay_cp_9', status, amount_usd: 12.5, checkout_session_id: 'cs_test1', customer_email: 'pat@example.com', account_id: 'pat@example.com', property: 'pay.agent.pit.world', metadata: { via: 'pay.agent', handle: 'alice', payagent_id: pid }, ...extra } })

    // Bad signature: refused, nothing changes.
    expect((await hook(nested('payment.confirmed', 'confirmed'), signWebhook('{}', 'wrong'))).status).toBe(401)
    expect(t.store.payment(pid)!.status).toBe('pending')
    // An expired payment inside the session does not end it (the payer may switch coins).
    expect((await hook(nested('payment.expired', 'expired'))).status).toBe(200)
    expect(t.store.payment(pid)!.status).toBe('pending')
    // Confirmed, then forwarded: paid, by checkout_session_id; replays change nothing.
    expect((await hook(nested('payment.confirmed', 'confirmed', { blockchain: 'USDC_SOL' }))).status).toBe(200)
    expect(t.store.payment(pid)).toMatchObject({ status: 'confirmed', paymentId: 'pay_cp_9', coin: 'usdc_sol' })
    expect((await hook(nested('payment.forwarded', 'forwarded'))).status).toBe(200)
    expect(t.store.payment(pid)!.status).toBe('forwarded')
    expect((await hook(nested('payment.confirmed', 'confirmed'))).status).toBe(200)
    expect((await hook(nested('payment.expired', 'expired'))).status).toBe(200)
    expect(t.store.payment(pid)!.status).toBe('forwarded')
    expect(await (await t.req(`/p/${pid}`)).text()).toContain('Paid. Thank you.')

    // The owner sees it, makes a key, reads it over the API.
    const meHtml = await (await t.req('/me')).text()
    expect(meHtml).toContain('$12.50 received')
    expect(meHtml).not.toContain('ad-unit')
    const keyPage = await (await t.req('/me/key', { method: 'POST', form: { csrf: /name="csrf" value="([0-9a-f]+)"/.exec(meHtml)![1]! } })).text()
    const key = /(pa_[A-Za-z0-9_-]+)/.exec(keyPage)![1]!
    const api = (await (await t.req('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).json()) as any
    expect(api.payments[0]).toMatchObject({ id: pid, status: 'forwarded', note: 'pizza', amount_usd: 12.5, session_id: 'cs_test1', coin: 'usdc_sol' })
  })

  test('agents pay over the API, and the relay gets relay links', async () => {
    const t = setup()
    const relay = { 'x-moshpit-name': 'pay.agent' }
    await signIn(t, 'pay.agent.pit.world')
    const csrf = await t.csrfFrom(await t.req('/start', { headers: relay }))
    await t.req('/start', { method: 'POST', form: { csrf, handle: 'bob', mode: 'wallet' }, headers: relay })
    const who = await (await t.req('/api/v1/users/bob', { headers: relay })).json()
    expect(who).toMatchObject({ handle: 'bob', coins: ['usdc_sol'], url: 'https://pay.agent.pit.world/bob' })
    expect((await t.req('/api/v1/users/bob/payments', { method: 'POST', body: JSON.stringify({ amount_usd: 3 }), headers: { 'content-type': 'application/json' } })).status).toBe(400)
    const res = await t.req('/api/v1/users/bob/payments', { method: 'POST', body: JSON.stringify({ amount_usd: 3, payer_email: 'agent@example.com', coin: 'ignored' }), headers: { 'content-type': 'application/json', ...relay } })
    expect(res.status).toBe(201)
    const p = (await res.json()) as any
    expect(p).toMatchObject({ checkout_url: 'https://cp.test/checkout/cs_test1', session_id: 'cs_test1', status: 'pending', coin: null, status_url: `https://pay.agent.pit.world/p/${p.id}` })
    expect(t.cp.state.lastSessionBody).toMatchObject({ success_url: `https://pay.agent.pit.world/p/${p.id}?session={CHECKOUT_SESSION_ID}`, cancel_url: 'https://pay.agent.pit.world/bob', account_id: 'agent@example.com' })
    // Following asks CoinPay's session: paid by PayPal.
    Object.assign(t.cp.state.sessions.get('cs_test1'), { status: 'paid', paid_method: 'PAYPAL' })
    expect(((await (await t.req(`/api/v1/payments/${p.id}`)).json()) as any)).toMatchObject({ status: 'confirmed', coin: 'paypal' })
    expect((await t.req('/api/v1/users/bob/payments', { method: 'POST', body: JSON.stringify({ amount_usd: 0.1, payer_email: 'a@b.co' }) })).status).toBe(400)
    expect((await t.req('/api/v1/users/nobody')).status).toBe(404)
  })

  test('guards: CSRF, reserved handles, an expiring token refreshes once', async () => {
    const t = setup()
    await signIn(t)
    expect((await t.req('/start', { method: 'POST', form: { csrf: 'nope', handle: 'carol', mode: 'wallet' } })).status).toBe(400)
    const csrf = await t.csrfFrom(await t.req('/start'))
    expect((await t.req('/start', { method: 'POST', form: { csrf, handle: 'help', mode: 'wallet' } })).status).toBe(400)
    expect(validHandle('a')).not.toBeNull()
    expect(validHandle('ok_name-1')).toBeNull()
    t.store.saveTokens('merchant-1', { accessToken: 'old', refreshToken: 'rt-old', expiresAt: Date.now() })
    expect((await t.req('/start', { method: 'POST', form: { csrf, handle: 'carol', mode: 'wallet' } })).status).toBe(200)
    expect(t.cp.state.refreshes).toBe(1)
    expect(t.store.tokens('merchant-1')!.accessToken).toBe('at-refreshed')
  })

  test('plain http on the Moshpit name signs in through the relay', async () => {
    const t = setup()
    const res = await t.req('/auth/start', { headers: { 'x-forwarded-proto': 'http' } })
    expect(res.headers.get('location')).toBe('https://pay.agent.pit.world/auth/start')
  })

  test('pages render, unknown links 404, security headers on', async () => {
    const t = setup()
    const home = await t.req('/')
    expect(home.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    const html = await home.text()
    expect(html).toContain('ring-bar')
    expect(html).toContain('<a class="ring-start" href="https://pit.world/start">Start building here…</a>')
    expect(html).toContain('Start with CoinPay')
    const csp = home.headers.get('content-security-policy')!
    for (const d of ['script-src', 'connect-src', 'frame-src']) expect(csp).toMatch(new RegExp(`${d} [^;]*https://crawlproof\\.com`))
    expect(html).toContain('data-site="88fcc3cd-2374-47da-8fbb-5cc2ae2e7499"')
    // No ad on the home page; /help carries one low-profile text_link line.
    expect(html).not.toContain('crawlproof.com/api/ads')
    const helpHtml = await (await t.req('/help')).text()
    expect(helpHtml).toContain('format=text_link')
    expect(helpHtml).not.toContain('format=banner_300x250')
    // No ad in or pressed against the footer.
    expect(html.slice(html.indexOf('<footer'))).not.toContain('ad-unit')
    expect(html).not.toMatch(/<\/iframe><\/div>\s*<\/main>/)
    const help = await t.req('/help')
    expect(help.status).toBe(200)
    expect(await help.text()).toContain('format=text_link')
    expect((await t.req('/zzz-nobody')).status).toBe(404)
    expect((await t.req('/health')).status).toBe(200)
    expect((await t.req('/style.css')).headers.get('content-type')).toContain('text/css')
  })
})

describe('terminal', () => {
  test('TUI keys: type, tab to amount (looks up), digits only, enter pays', () => {
    const s = initialState()
    for (const ch of 'Bob') onKey(s, { name: ch, key: ch, char: ch })
    expect(s.handle).toBe('bob')
    expect(onKey(s, { name: 'tab', key: 'tab' })).toBe('lookup')
    onKey(s, { name: 'x', key: 'x', char: 'x' })
    onKey(s, { name: '5', key: '5', char: '5' })
    expect(s.amount).toBe('5')
    expect(onKey(s, { name: 'tab', key: 'tab' })).toBeNull()
    for (const ch of 'me@x.co') onKey(s, { name: ch, key: ch, char: ch })
    expect(s.email).toBe('me@x.co')
    expect(onKey(s, { name: 'enter', key: 'enter' })).toBe('pay')
  })

  test('CLI pays by handle and prints the CoinPay checkout link', async () => {
    const lines: string[] = []
    let sent: any = null
    const client = new PayAgentClient('https://x', undefined, (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ id: 'pl_1', handle: 'bob', amount_usd: 5, coin: null, status: 'pending', expires_at: null, checkout_url: 'https://coinpayportal.com/checkout/cs_1', status_url: 'https://x/p/pl_1' }), { status: 201 })
    }) as unknown as typeof fetch)
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(t) }
    const before = process.env.PAYAGENT_EMAIL
    delete process.env.PAYAGENT_EMAIL
    expect(await main(['bob', '5'], out, client)).toBe(2)
    if (before !== undefined) process.env.PAYAGENT_EMAIL = before
    expect(await main(['bob', '5', 'for', 'lunch', '--email=me@example.com'], out, client)).toBe(0)
    expect(sent).toEqual({ amount_usd: 5, payer_email: 'me@example.com', note: 'for lunch' })
    expect(lines.join('\n')).toContain('https://coinpayportal.com/checkout/cs_1')
  })

  test('invoices: send from the page and the API, CoinPay emails, repeats, paid shows', async () => {
    const t = setup()
    await signIn(t)
    let csrf = await t.csrfFrom(await t.req('/start'))
    await t.req('/start', { method: 'POST', form: { csrf, handle: 'studio', mode: 'wallet' } })
    csrf = await t.csrfFrom(await t.req('/me'))

    const bad = await t.req('/me/invoice', { method: 'POST', form: { csrf, to_email: 'nope', description: 'x', amount: '49' } })
    expect(await bad.text()).toContain('An email address')
    expect(t.cp.state.invoices.size).toBe(0)

    const sent = await t.req('/me/invoice', { method: 'POST', form: { csrf, to_email: 'Pat@Example.com', to_name: 'Pat', description: 'App build + first 30 days', amount: '$49', coin: 'usdc_sol', due_date: '2026-11-01', recurrence: 'none' } })
    expect(sent.status).toBe(302)
    expect(sent.headers.get('location')).toBe('/i/inv-1')
    const inv = t.cp.state.invoices.get('inv-1')
    expect(inv).toMatchObject({ amount: 49, currency: 'USD', crypto_currency: 'USDC_SOL', client_id: 'cl1', notes: 'App build + first 30 days', due_date: '2026-11-01T00:00:00.000Z', action: 'send' })
    expect(inv.schedule).toBeUndefined()
    expect(t.cp.state.clients[0]).toMatchObject({ email: 'pat@example.com', name: 'Pat', business_id: 'b1' })
    // CoinPay is called as the signed-in merchant, never with a key of ours.
    expect(t.cp.state.invoiceAuth[0]).toMatch(/^Bearer at-/)

    const view = await (await t.req('/i/inv-1')).text()
    expect(view).toContain('<p class="amount">$49</p>')
    expect(view).toContain('So1Invoice')
    expect(view).toContain('49.000000')
    expect(view).toContain('https://cp.test/now/inv-1')
    expect(await (await t.req('/me')).text()).toContain('INV-001')

    // The API, with a key: monthly, no email.
    const keyHtml = await (await t.req('/me/key', { method: 'POST', form: { csrf } })).text()
    const key = /(pa_[A-Za-z0-9_-]+)/.exec(keyHtml)![1]!
    expect((await t.req('/api/v1/invoices', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401)
    const api = await t.req('/api/v1/invoices', { method: 'POST', body: JSON.stringify({ to_email: 'ops@example.com', description: 'Hosting', amount_usd: 2, recurrence: 'monthly', email: false }), headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } })
    expect(api.status).toBe(201)
    const made: any = await api.json()
    expect(made).toMatchObject({ id: 'inv-2', amount_usd: 2, recurrence: 'monthly', status: 'sent', url: 'https://pay.agent/i/inv-2' })
    expect(t.cp.state.invoices.get('inv-2')).toMatchObject({ schedule: { recurrence: 'monthly' }, action: 'publish' })
    expect((await t.req('/api/v1/invoices', { method: 'POST', body: JSON.stringify({ to_email: 'a@b.co', description: 'x', amount_usd: 5, recurrence: 'hourly' }), headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` } })).status).toBe(400)

    const list: any = await (await t.req('/api/v1/invoices', { headers: { authorization: `Bearer ${key}` } })).json()
    expect(list.invoices.map((i: any) => i.id)).toEqual(['inv-2', 'inv-1'])

    // CoinPay marks it paid: the public read and the page follow.
    t.cp.state.invoices.get('inv-1').status = 'paid'
    const pub: any = await (await t.req('/api/v1/invoices/inv-1')).json()
    expect(pub.status).toBe('paid')
    expect(pub.to_email).toBeUndefined()
    expect(await (await t.req('/i/inv-1')).text()).toContain('Paid. Thank you.')
    expect((await t.req('/i/nope')).status).toBe(404)
    expect(validHandle('invoices')).toBe('that one is taken')
  })
})

describe('webhook settling', () => {
  test('PayPal completed settles; other owners and old address payments', async () => {
    const t = setup()
    await signIn(t)
    const csrf = await t.csrfFrom(await t.req('/start'))
    await t.req('/start', { method: 'POST', form: { csrf, handle: 'dana', mode: 'wallet' } })
    await t.req('/dana', { method: 'POST', form: { amount: '20', email: 'buyer@example.com' } })
    const pid = t.cp.state.lastSessionBody.metadata.payagent_id
    const secret = t.cp.state.businesses[0].webhook_secret
    const post = (event: unknown) => {
      const body = JSON.stringify(event)
      return t.req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': signWebhook(body, secret) } })
    }
    // Unknown business: no secret to check against.
    expect((await post({ id: 'evt_x', type: 'payment.confirmed', business_id: 'nope', data: { checkout_session_id: 'cs_test1', status: 'confirmed' } })).status).toBe(401)
    // A PayPal capture: confirmed with status completed, rail paypal.
    const r = await post({ id: 'evt_pp', type: 'payment.confirmed', business_id: 'b1', data: { payment_id: 'pp_1', status: 'completed', rail: 'paypal', amount_usd: 20, checkout_session_id: 'cs_test1', metadata: { payagent_id: pid } } })
    expect(r.status).toBe(200)
    expect(t.store.payment(pid)).toMatchObject({ status: 'completed', coin: 'paypal', paymentId: 'pp_1' })
    // A payment made before sessions still settles by its payment id.
    t.store.addPayment({ id: 'pay_old', handle: 'dana', amountUsd: 1, coin: 'usdc_sol', amountCrypto: '1', address: 'So1', status: 'pending', note: '', payer: '', expiresAt: null })
    expect((await post({ id: 'evt_o', type: 'payment.forwarded', business_id: 'b1', data: { payment_id: 'pay_old', status: 'forwarded' } })).status).toBe(200)
    expect(t.store.payment('pay_old')!.status).toBe('forwarded')
    // A row belonging to someone else is never touched by this owner's events.
    t.store.addPayment({ id: 'pay_other', handle: 'someone', amountUsd: 1, coin: 'btc', amountCrypto: '1', address: 'x', status: 'pending', note: '', payer: '', expiresAt: null })
    const other = await (await post({ id: 'evt_s', type: 'payment.confirmed', business_id: 'b1', data: { payment_id: 'pay_other', status: 'confirmed' } })).json()
    expect(other).toMatchObject({ ok: true, matched: false })
    expect(t.store.payment('pay_other')!.status).toBe('pending')
  })
})

describe('claiming without a browser', () => {
  /** A PayAgentClient whose pay.agent is the app under test and whose CoinPay is the fake. */
  function headless() {
    const cp = fakeCoinPay()
    const store = new Store(':memory:', new Sealer('test-key-0123456789abcdef'))
    const app = createApp({ store, key: 'test-key-0123456789abcdef', secureCookies: false, config: { coinpayBase: 'https://cp.test', clientId: 'cp_client', webhookOrigin: 'https://pay.agent.pit.world', fetch: cp.fetchImpl } })
    const doFetch = (async (url: string | URL, init: RequestInit = {}) => {
      const u = new URL(String(url))
      if (u.host === 'cp.test') return cp.fetchImpl(url, init)
      const headers = new Headers(init.headers)
      headers.set('host', 'pay.agent')
      return app.fetch(new Request(`http://localhost${u.pathname}${u.search}`, { ...init, headers }), { ip: '1.2.3.4' })
    }) as typeof fetch
    const client = (key?: string) => new PayAgentClient('https://pay.agent', key, doFetch)
    return { cp, store, client }
  }

  test('an agent with CoinPay credentials claims a handle and gets a working key', async () => {
    const h = headless()
    const c = await h.client().claim({ handle: '@Bot', coinpayEmail: 'bot@example.com', coinpayPassword: 'right' })
    expect(c).toMatchObject({ handle: 'bot', url: 'https://pay.agent/bot', mode: 'wallet', new: true })
    expect(c.api_key).toMatch(/^pa_/)
    // The consent went to CoinPay bound to PKCE, with the scopes the browser flow asks for.
    expect(h.cp.state.consents[0]).toMatchObject({ client_id: 'cp_client', redirect_uri: 'https://pay.agent/auth/callback', code_challenge_method: 'S256', action: 'approve' })
    expect(h.cp.state.consents[0].scope).toContain('merchant')
    expect(h.cp.state.businesses[0]).toMatchObject({ name: 'pay.agent/bot' })
    const me = await h.client(c.api_key).me()
    expect(me.handle).toBe('bot')
  })

  test('claiming again mints a new key for the same handle, and the old one stops working', async () => {
    const h = headless()
    const first = await h.client().claim({ handle: 'bot', coinpayToken: 'cp-session' })
    const again = await h.client().claim({ coinpayToken: 'cp-session' })
    expect(again).toMatchObject({ handle: 'bot', new: false })
    expect(again.api_key).not.toBe(first.api_key)
    expect(h.cp.state.businesses).toHaveLength(1)
    await expect(h.client(first.api_key).me()).rejects.toThrow()
    expect((await h.client(again.api_key).me()).handle).toBe('bot')
  })

  test('a code is good once, a wrong password never reaches pay.agent, and a first claim needs a handle', async () => {
    const h = headless()
    await expect(h.client().claim({ handle: 'bot', coinpayEmail: 'bot@example.com', coinpayPassword: 'wrong' })).rejects.toThrow(/CoinPay sign-in/)
    await expect(h.client().claim({ coinpayToken: 'cp-session' })).rejects.toThrow(/handle/)
    const start = await (await h.client() as any).call('POST', '/api/v1/claim/start', {})
    const redirect = `https://pay.agent/auth/callback?code=c1&state=${start.state}`
    await (h.client() as any).call('POST', '/api/v1/claim', { redirect, handle: 'bot' })
    await expect((h.client() as any).call('POST', '/api/v1/claim', { redirect, handle: 'bot' })).rejects.toThrow(/expired or was used/)
  })

  test('the CLI prints the link and the key', async () => {
    const h = headless()
    const lines: string[] = []
    process.env.COINPAY_TOKEN = 'cp-session'
    try {
      const code = await main(['claim', 'clibot'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, h.client())
      expect(code).toBe(0)
    } finally {
      delete process.env.COINPAY_TOKEN
    }
    expect(lines.join('\n')).toContain('Claimed https://pay.agent/clibot')
    expect(lines.join('\n')).toMatch(/PAYAGENT_KEY=pa_/)
  })
})
