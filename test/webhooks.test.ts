import { describe, expect, test } from 'bun:test'
import { signWebhook } from '@profullstack/coinpay-onboard'
import { verifySignature } from '@profullstack/webhooks'
import { Sealer, Store } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { PayAgent, type Config } from '../src/service.ts'
import { main } from '../src/cli.ts'
import { PayAgentClient } from '../src/client.ts'
import { fakeCoinPay } from './fake-coinpay.ts'

/** pay.agent with fake CoinPay, and a customer's webhook receiver at https://hooks.test (never a real endpoint). */
function setup() {
  const cp = fakeCoinPay()
  const received: { url: string; headers: Headers; body: string }[] = []
  let receiverStatus = 204
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    if (u.host === 'hooks.test') {
      received.push({ url: u.toString(), headers: new Headers(init.headers), body: String(init.body) })
      return new Response(null, { status: receiverStatus })
    }
    return cp.fetchImpl(url, init)
  }) as typeof fetch
  const store = new Store(':memory:', new Sealer('test-key-0123456789abcdef'))
  const config: Config = { coinpayBase: 'https://cp.test', clientId: 'cp_client', webhookOrigin: 'https://pay.agent.pit.world', fetch: fetchImpl, webhookGuard: { allowPrivate: true } }
  const agent = new PayAgent(store, config)
  const app = createApp({ store, key: 'test-key-0123456789abcdef', secureCookies: false, config, agent })
  let cookie = ''
  const req = async (path: string, init: RequestInit & { form?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers)
    headers.set('host', 'pay.agent')
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
  const events = () => received.map((r) => JSON.parse(r.body) as { type: string; subject: string; data: any })
  return { cp, store, agent, req, csrfFrom, received, events, setReceiver: (s: number) => (receiverStatus = s) }
}

/** Signed in, a wallet link called `handle`, and a pa_ key. */
async function owner(t: ReturnType<typeof setup>, handle = 'alice') {
  const start = await t.req('/auth/start')
  const state = new URL(start.headers.get('location')!).searchParams.get('state')
  await t.req(`/auth/callback?code=c1&state=${state}`)
  const csrf = await t.csrfFrom(await t.req('/start'))
  await t.req('/start', { method: 'POST', form: { csrf, handle, mode: 'wallet' } })
  const keyHtml = await (await t.req('/me/key', { method: 'POST', form: { csrf } })).text()
  const key = /(pa_[A-Za-z0-9_-]+)/.exec(keyHtml)![1]!
  const api = (method: string, path: string, body?: unknown, k: string | null = key) =>
    t.req(path, { method, ...(body ? { body: JSON.stringify(body) } : {}), headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) } })
  return { csrf, key, api }
}

describe('customer webhooks', () => {
  test('the API needs a key, and an endpoint gets signed payment and invoice events once each', async () => {
    const t = setup()
    const o = await owner(t)
    expect((await o.api('GET', '/api/v1/webhooks', undefined, null)).status).toBe(401)
    expect((await o.api('GET', '/api/v1/webhooks', undefined, 'pa_wrong')).status).toBe(401)
    expect((await o.api('POST', '/api/v1/webhooks/x/test', undefined, null)).status).toBe(401)

    const list: any = await (await o.api('GET', '/api/v1/webhooks')).json()
    expect(list).toEqual({ endpoints: [], event_types: ['payment.created', 'payment.paid', 'payment.expired', 'payment.failed', 'invoice.created', 'invoice.paid', 'invoice.overdue', 'invoice.cancelled'] })
    // http and patterns that match nothing are refused.
    expect((await o.api('POST', '/api/v1/webhooks', { url: 'http://hooks.test/x' })).status).toBe(400)
    expect((await o.api('POST', '/api/v1/webhooks', { url: 'https://hooks.test/x', events: ['room.*'] })).status).toBe(400)
    const made = await o.api('POST', '/api/v1/webhooks', { url: 'https://hooks.test/pay', events: ['payment.*', 'invoice.*'] })
    expect(made.status).toBe(201)
    const { endpoint, secret } = (await made.json()) as any
    expect(secret).toMatch(/^whsec_/)
    // Sealed at rest with PAYAGENT_KEY, not stored in the clear.
    const raw = t.store.db.query('SELECT * FROM webhook_endpoints').get() as any
    expect(JSON.stringify(raw)).not.toContain(secret)
    expect(((await (await o.api('GET', `/api/v1/webhooks/${endpoint.id}/secret`)).json()) as any).secret).toBe(secret)

    // A stranger pays the link: payment.created.
    await t.req('/alice', { method: 'POST', form: { amount: '12.50', email: 'pat@example.com', note: 'pizza', payer: 'Pat' } })
    const pid = t.cp.state.lastSessionBody.metadata.payagent_id as string
    // CoinPay confirms, then forwards, then replays: one payment.paid.
    const cpSecret = t.cp.state.businesses[0].webhook_secret
    const hook = (type: string, status: string) => {
      const body = JSON.stringify({ id: `evt_${type}`, type, business_id: 'b1', data: { payment_id: 'pay_cp_9', status, checkout_session_id: 'cs_test1', blockchain: 'USDC_SOL', metadata: { payagent_id: pid } } })
      return t.req('/hooks/coinpay', { method: 'POST', body, headers: { 'x-coinpay-signature': signWebhook(body, cpSecret) } })
    }
    await hook('payment.confirmed', 'confirmed')
    await hook('payment.forwarded', 'forwarded')
    await hook('payment.confirmed', 'confirmed')
    await t.req(`/p/${pid}`)

    // An invoice, then CoinPay marks it paid; two reads, one invoice.paid.
    expect((await o.api('POST', '/api/v1/invoices', { to_email: 'ops@example.com', description: 'Hosting', amount_usd: 2, email: false })).status).toBe(201)
    t.cp.state.invoices.get('inv-1').status = 'paid'
    await Promise.all([t.req('/api/v1/invoices/inv-1'), t.req('/i/inv-1')])
    // A second invoice, cancelled on CoinPay (its public view 404s): one invoice.cancelled.
    expect((await o.api('POST', '/api/v1/invoices', { to_email: 'ops@example.com', description: 'Logo', amount_usd: 3, email: false })).status).toBe(201)
    t.cp.state.invoices.get('inv-2').status = 'cancelled'
    await Promise.all([t.req('/api/v1/invoices/inv-2'), t.req('/i/inv-2')])
    await t.req('/i/inv-2')

    await new Promise((r) => setTimeout(r, 20))
    expect(await t.agent.hooks.drain()).toBe(6)
    const evs = t.events()
    expect(evs.map((e) => e.type)).toEqual(['payment.created', 'payment.paid', 'invoice.created', 'invoice.paid', 'invoice.created', 'invoice.cancelled'])
    expect(evs[5]).toMatchObject({ subject: 'invoice:inv-2', data: { id: 'inv-2', status: 'cancelled' } })
    expect(evs[0]).toMatchObject({ subject: `payment:${pid}`, data: { id: pid, handle: 'alice', amount_usd: 12.5, status: 'pending', note: 'pizza', payer: 'Pat', session_id: 'cs_test1', checkout_url: 'https://cp.test/checkout/cs_test1', status_url: `https://pay.agent.pit.world/p/${pid}` } })
    expect(evs[0]!.data.payer_email).toBeUndefined()
    expect(evs[1]).toMatchObject({ data: { id: pid, status: 'confirmed', coin: 'usdc_sol', coinpay_payment_id: 'pay_cp_9' } })
    expect(evs[3]).toMatchObject({ subject: 'invoice:inv-1', data: { id: 'inv-1', status: 'paid', amount_usd: 2, to_email: 'ops@example.com', url: 'https://pay.agent.pit.world/i/inv-1' } })
    // Every delivery verifies with the endpoint's secret (Standard Webhooks).
    for (const r of t.received) expect(verifySignature({ headers: r.headers, body: r.body, secret }).ok).toBe(true)
    expect(t.received[0]!.headers.get('content-type')).toBe('application/cloudevents+json')

    // Nothing more queued; the log says delivered.
    expect(await t.agent.hooks.drain()).toBe(0)
    const log: any = await (await o.api('GET', '/api/v1/webhooks/deliveries')).json()
    expect(log.deliveries.map((d: any) => d.status)).toEqual(Array(6).fill('delivered'))
  })

  test('an expired checkout sends payment.expired; filters skip the rest; other owners hear nothing', async () => {
    const t = setup()
    const o = await owner(t)
    await o.api('POST', '/api/v1/webhooks', { url: 'https://hooks.test/ends', events: ['payment.expired'] })
    await t.req('/alice', { method: 'POST', form: { amount: '3', email: 'pat@example.com' } })
    const pid = t.cp.state.lastSessionBody.metadata.payagent_id as string
    t.cp.state.sessions.get('cs_test1').status = 'expired'
    await Promise.all([t.req(`/api/v1/payments/${pid}`), t.req(`/p/${pid}`)])
    await new Promise((r) => setTimeout(r, 20))
    await t.agent.hooks.drain()
    expect(t.events().map((e) => e.type)).toEqual(['payment.expired'])
    expect(t.events()[0]!.data).toMatchObject({ id: pid, status: 'expired' })
  })

  test('the settings page adds, tests, rotates and removes; deleting the account removes its webhooks', async () => {
    const t = setup()
    const o = await owner(t, 'studio')
    const page = await (await t.req('/me')).text()
    expect(page).toContain('id="webhooks"')
    expect(page).toContain('payment.paid')
    const stale = await t.req('/me/webhooks/add', { method: 'POST', form: { csrf: 'nope', url: 'https://hooks.test/a' } })
    expect(stale.status).toBe(400)
    const added = await (await t.req('/me/webhooks/add', { method: 'POST', form: { csrf: o.csrf, url: 'https://hooks.test/a', events: 'invoice.*' } })).text()
    const secret = /(whsec_[A-Za-z0-9+/=]+)/.exec(added)![1]!
    expect(added).toContain('https://hooks.test/a')
    const id = /name="id" value="([^"]+)"/.exec(added)![1]!
    const bad = await t.req('/me/webhooks/add', { method: 'POST', form: { csrf: o.csrf, url: 'https://hooks.test/b', events: 'nothing.here' } })
    expect(bad.status).toBe(400)

    const tested = await (await t.req('/me/webhooks/test', { method: 'POST', form: { csrf: o.csrf, id } })).text()
    expect(tested).toContain('Test delivered (HTTP 204)')
    expect(t.events()[0]!.type).toBe('webhook.test')
    expect(verifySignature({ headers: t.received[0]!.headers, body: t.received[0]!.body, secret }).ok).toBe(true)
    t.setReceiver(500)
    expect(await (await t.req('/me/webhooks/test', { method: 'POST', form: { csrf: o.csrf, id } })).text()).toContain('Test failed')

    const rotated = await (await t.req('/me/webhooks/rotate', { method: 'POST', form: { csrf: o.csrf, id } })).text()
    const fresh = /(whsec_[A-Za-z0-9+/=]+)/.exec(rotated)![1]!
    expect(fresh).not.toBe(secret)
    // Someone else's id is not found for this owner.
    expect((await t.req('/me/webhooks/delete', { method: 'POST', form: { csrf: o.csrf, id: 'whe_nope' } })).status).toBe(404)
    expect(await (await t.req('/me/webhooks/delete', { method: 'POST', form: { csrf: o.csrf, id } })).text()).toContain('Webhook removed.')
    expect(await t.agent.hooks.listEndpoints(t.store.byHandle('studio')!.sub)).toEqual([])

    await o.api('POST', '/api/v1/webhooks', { url: 'https://hooks.test/c' })
    const sub = t.store.byHandle('studio')!.sub
    expect((await t.agent.hooks.listEndpoints(sub)).length).toBe(1)
    await t.req('/me/delete', { method: 'POST', form: { csrf: o.csrf } })
    expect(t.store.user(sub)).toBeNull()
    expect((t.store.db.query('SELECT COUNT(*) AS n FROM webhook_endpoints').get() as any).n).toBe(0)
  })

  test('the CLI lists, adds and tests webhooks with the key', async () => {
    const t = setup()
    const o = await owner(t)
    const client = new PayAgentClient('https://pay.agent', o.key, ((url: string, init: RequestInit) => t.req(new URL(url).pathname, init)) as unknown as typeof fetch)
    const lines: string[] = []
    const out = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) }
    expect(await main(['webhook', 'add', 'https://hooks.test/cli', 'payment.paid'], out, client)).toBe(0)
    expect(lines.join('\n')).toMatch(/signing secret: whsec_/)
    expect(await main(['webhooks'], out, client)).toBe(0)
    expect(lines.join('\n')).toContain('https://hooks.test/cli  payment.paid')
    const id = (await client.webhooks()).endpoints[0]!.id
    expect(await main(['webhook', 'test', id], out, client)).toBe(0)
    expect(lines.join('\n')).toContain('delivered (HTTP 204)')
    expect(await main(['webhook', 'log'], out, client)).toBe(0)
    expect(lines.join('\n')).toContain('webhook.test')
    expect(await main(['webhook', 'rm', id], out, client)).toBe(0)
    expect((await client.webhooks()).endpoints).toEqual([])
    expect(await main(['webhooks'], out, new PayAgentClient('https://pay.agent', undefined, fetch))).toBe(1)
  })
})
