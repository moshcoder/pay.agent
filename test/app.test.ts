import { describe, expect, test } from 'bun:test'
import { signWebhook } from '@profullstack/coinpay-onboard'
import { Sealer, Store, validHandle } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { onKey, initialState } from '../src/tui.ts'
import { main } from '../src/cli.ts'
import { PayAgentClient } from '../src/client.ts'

/** CoinPay, faked: OAuth, businesses, wallets, payments. */
function fakeCoinPay() {
  const state = { businesses: [] as any[], accountWallets: [{ cryptocurrency: 'USDC_SOL', wallet_address: 'So1Payout' }] as any[], payments: new Map<string, any>(), refreshes: 0, lastPaymentBody: null as any }
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    const method = init.method ?? 'GET'
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status })
    const raw = typeof init.body === 'string' ? init.body : ''
    const body: any = raw.startsWith('{') ? JSON.parse(raw) : raw ? Object.fromEntries(new URLSearchParams(raw)) : undefined
    const path = u.pathname
    if (path === '/api/oauth/token') {
      if (body.grant_type === 'refresh_token') state.refreshes++
      return json(200, { access_token: 'at-' + (body.grant_type === 'refresh_token' ? 'refreshed' : 'first'), refresh_token: 'rt-' + Math.random(), expires_in: 3600, scope: 'openid profile email wallet:read merchant' })
    }
    if (path === '/api/oauth/userinfo') return json(200, { sub: 'merchant-1', name: 'Alice Smith', email: 'alice@example.com' })
    if (path === '/api/businesses' && method === 'GET') return json(200, { success: true, businesses: state.businesses })
    if (path === '/api/businesses' && method === 'POST') {
      const b = { id: `b${state.businesses.length + 1}`, ...body }
      state.businesses.push(b)
      return json(201, { success: true, business: b })
    }
    if (path === '/api/wallets') return json(200, { success: true, wallets: state.accountWallets })
    if (path === '/api/payments/create') {
      state.lastPaymentBody = body
      const p = { id: `pay${state.payments.size + 1}`, status: 'pending', payment_address: 'So1Deposit', amount_usd: body.amount_usd, amount_crypto: String(body.amount_usd), currency: body.currency, blockchain: 'USDC_SOL', expires_at: '2030-01-01T00:00:00Z' }
      state.payments.set(p.id, p)
      return json(201, { success: true, payment: p })
    }
    const m = /^\/api\/payments\/(pay\d+)$/.exec(path)
    if (m) return json(200, { success: true, payment: state.payments.get(m[1]!) })
    return json(404, { success: false, error: `no ${method} ${path}` })
  }) as typeof fetch
  return { state, fetchImpl }
}

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

    // A stranger pays the link.
    const pay = await t.req('/alice', { method: 'POST', form: { amount: '$12.50', coin: 'usdc_sol', note: 'pizza' } })
    expect(pay.status).toBe(302)
    const pid = pay.headers.get('location')!.split('/').pop()!
    expect(t.cp.state.lastPaymentBody).toMatchObject({ business_id: 'b1', amount_usd: 12.5, currency: 'usdc_sol' })
    const checkout = await (await t.req(`/p/${pid}`)).text()
    expect(checkout).toContain('So1Deposit')
    expect(checkout).toContain('<svg class="qr"')
    expect(checkout).not.toContain('ad-unit')
    expect(await (await t.req('/alice')).text()).not.toContain('ad-unit')

    // CoinPay says it is paid.
    const event = JSON.stringify({ id: 'evt_1', type: 'payment.forwarded', business_id: 'b1', data: { payment_id: pid, status: 'forwarded' } })
    const secret = t.cp.state.businesses[0].webhook_secret
    expect((await t.req('/hooks/coinpay', { method: 'POST', body: event, headers: { 'x-coinpay-signature': signWebhook(event, 'wrong') } })).status).toBe(401)
    expect((await t.req('/hooks/coinpay', { method: 'POST', body: event, headers: { 'x-coinpay-signature': signWebhook(event, secret) } })).status).toBe(200)
    expect(t.store.payment(pid)!.status).toBe('forwarded')

    // The owner sees it, makes a key, reads it over the API.
    const meHtml = await (await t.req('/me')).text()
    expect(meHtml).toContain('$12.50 received')
    expect(meHtml).not.toContain('ad-unit')
    const keyPage = await (await t.req('/me/key', { method: 'POST', form: { csrf: /name="csrf" value="([0-9a-f]+)"/.exec(meHtml)![1]! } })).text()
    const key = /(pa_[A-Za-z0-9_-]+)/.exec(keyPage)![1]!
    const api = (await (await t.req('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).json()) as any
    expect(api.payments[0]).toMatchObject({ id: pid, status: 'forwarded', note: 'pizza', amount_usd: 12.5 })
  })

  test('agents pay over the API, and the relay gets relay links', async () => {
    const t = setup()
    const relay = { 'x-moshpit-name': 'pay.agent' }
    await signIn(t, 'pay.agent.pit.world')
    const csrf = await t.csrfFrom(await t.req('/start', { headers: relay }))
    await t.req('/start', { method: 'POST', form: { csrf, handle: 'bob', mode: 'wallet' }, headers: relay })
    const who = await (await t.req('/api/v1/users/bob', { headers: relay })).json()
    expect(who).toMatchObject({ handle: 'bob', coins: ['usdc_sol'], url: 'https://pay.agent.pit.world/bob' })
    const res = await t.req('/api/v1/users/bob/payments', { method: 'POST', body: JSON.stringify({ amount_usd: 3, coin: 'nope' }), headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(201)
    const p = (await res.json()) as any
    expect(p).toMatchObject({ address: 'So1Deposit', coin: 'usdc_sol', status: 'pending' })
    t.cp.state.payments.get(p.id).status = 'confirmed'
    expect(((await (await t.req(`/api/v1/payments/${p.id}`)).json()) as any).status).toBe('confirmed')
    expect((await t.req('/api/v1/users/bob/payments', { method: 'POST', body: JSON.stringify({ amount_usd: 0.1 }) })).status).toBe(400)
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
    expect(html).toContain('Start with CoinPay')
    const csp = home.headers.get('content-security-policy')!
    for (const d of ['script-src', 'connect-src', 'frame-src']) expect(csp).toMatch(new RegExp(`${d} [^;]*https://crawlproof\\.com`))
    expect(html).toContain('data-site="88fcc3cd-2374-47da-8fbb-5cc2ae2e7499"')
    expect(html).toContain('format=banner_300x250')
    expect(html).toContain('format=text_link')
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
    expect(onKey(s, { name: 'enter', key: 'enter' })).toBe('pay')
  })

  test('CLI pays by handle and prints the address', async () => {
    const lines: string[] = []
    const client = new PayAgentClient('https://x', undefined, (async () =>
      new Response(JSON.stringify({ id: 'p1', handle: 'bob', amount_usd: 5, coin: 'usdc_sol', amount_crypto: '5.0', address: 'So1', status: 'pending', expires_at: null, checkout_url: 'https://x/p/p1' }), { status: 201 })) as unknown as typeof fetch)
    expect(await main(['bob', '5', 'usdc_sol'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, client)).toBe(0)
    expect(lines.join('\n')).toContain('Send exactly 5.0 USDC_SOL')
  })
})
