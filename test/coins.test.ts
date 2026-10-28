import { describe, expect, test } from 'bun:test'
import { Sealer, Store } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { PayAgent, offered, parseAccepts, sameAddressStables } from '../src/service.ts'
import { PayAgentClient } from '../src/client.ts'
import { main } from '../src/cli.ts'
import { fakeCoinPay } from './fake-coinpay.ts'

const SOL = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7'

/** A PayAgentClient whose pay.agent is the app under test and whose CoinPay is the fake. */
function headless(accountWallets: any[] = [{ cryptocurrency: 'SOL', wallet_address: SOL }]) {
  const cp = fakeCoinPay()
  cp.state.accountWallets = accountWallets
  const store = new Store(':memory:', new Sealer('test-key-0123456789abcdef'))
  const config = { coinpayBase: 'https://cp.test', clientId: 'cp_client', webhookOrigin: 'https://pay.agent.pit.world', fetch: cp.fetchImpl }
  const agent = new PayAgent(store, config)
  const app = createApp({ store, key: 'test-key-0123456789abcdef', secureCookies: false, config, agent })
  const doFetch = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    if (u.host === 'cp.test') return cp.fetchImpl(url, init)
    const headers = new Headers(init.headers)
    headers.set('host', 'pay.agent')
    return app.fetch(new Request(`http://localhost${u.pathname}${u.search}`, { ...init, headers }), { ip: '1.2.3.4' })
  }) as typeof fetch
  const client = (key?: string) => new PayAgentClient('https://pay.agent', key, doFetch)
  return { cp, store, agent, client, doFetch }
}

describe('same-address USDC', () => {
  test('a Solana address takes USDC on Solana; an 0x address takes USDC on Base and Polygon', () => {
    expect(sameAddressStables([{ cryptocurrency: 'SOL', address: SOL }])).toEqual({ usdc_sol: SOL })
    expect(sameAddressStables([{ cryptocurrency: 'ETH', address: EVM }])).toEqual({ usdc_base: EVM, usdc_pol: EVM })
    expect(sameAddressStables([{ cryptocurrency: 'BNB', address: EVM }, { cryptocurrency: 'USDC_SOL', address: SOL }])).toEqual({ usdc_base: EVM, usdc_pol: EVM })
  })

  test('nothing for coins already there, other chains, or addresses that do not look right', () => {
    expect(sameAddressStables([{ cryptocurrency: 'SOL', address: SOL }, { cryptocurrency: 'USDC_SOL', address: SOL }])).toEqual({})
    expect(sameAddressStables([{ cryptocurrency: 'BTC', address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh' }])).toEqual({})
    expect(sameAddressStables([{ cryptocurrency: 'SOL', address: 'So1Payout' }, { cryptocurrency: 'ETH', address: '0x123' }])).toEqual({})
  })
})

describe('the owner picks coins', () => {
  test('parseAccepts: ids, paypal, card means paypal, all is null, unknown refused', () => {
    expect(parseAccepts('usdc_sol, SOL,card')).toEqual(['usdc_sol', 'sol', 'paypal'])
    expect(parseAccepts(['usdc_base', 'usdc_base'])).toEqual(['usdc_base'])
    expect(parseAccepts('all')).toBeNull()
    expect(parseAccepts(['all'])).toBeNull()
    expect(() => parseAccepts('doge2')).toThrow(/Unknown coin: doge2/)
    expect(() => parseAccepts([])).toThrow(/at least one/)
  })

  test('offered: payable coins within the pick; card only when paypal is picked', () => {
    expect(offered({ coins: ['usdc_sol', 'sol'], accepts: null, card: true })).toEqual({ coins: ['usdc_sol', 'sol'], card: true })
    expect(offered({ coins: ['usdc_sol', 'sol'], accepts: ['sol', 'usdc_base'], card: true })).toEqual({ coins: ['sol'], card: false })
    expect(offered({ coins: ['usdc_sol'], accepts: ['usdc_sol', 'paypal'], card: null })).toEqual({ coins: ['usdc_sol'], card: null })
  })
})

describe('new links take USDC by default', () => {
  test('a SOL-only agent claims and its link takes USDC on Solana, on the pay.agent business only', async () => {
    const h = headless()
    const c = await h.client().claim({ handle: 'seller', coinpayToken: 'cp-session' })
    expect(c.coins).toEqual(['usdc_sol', 'sol'])
    const biz = h.cp.state.businesses[0].id
    expect(h.cp.state.businessWallets.get(biz)).toEqual([{ cryptocurrency: 'USDC_SOL', wallet_address: SOL, business_id: biz }])
    // The account's own wallets are untouched.
    expect(h.cp.state.accountWallets).toEqual([{ cryptocurrency: 'SOL', wallet_address: SOL }])
    expect((c.steps as any[]).find((s) => s.step === 'wallet:usdc_sol')).toMatchObject({ ok: true })
  })

  test('stablecoins: false keeps the old behaviour, and coins picks at claim time', async () => {
    const h = headless([{ cryptocurrency: 'SOL', wallet_address: SOL }, { cryptocurrency: 'ETH', wallet_address: EVM }])
    const c = await h.client().claim({ handle: 'plain', coinpayToken: 'cp-session', stablecoins: false, coins: ['sol'] })
    expect(h.cp.state.businessWallets.size).toBe(0)
    expect(c).toMatchObject({ coins: ['sol'], accepts: ['sol'], payable: ['eth', 'sol'] })
  })
})

describe('/api/v1/me/coins', () => {
  test('an existing SOL-only link adds USDC, picks coins, and the checkout only offers the pick', async () => {
    const h = headless()
    const c = await h.client().claim({ handle: 'old', coinpayToken: 'cp-session', stablecoins: false })
    expect(c.coins).toEqual(['sol'])
    const me = h.client(c.api_key)

    const before = await me.coins()
    expect(before).toMatchObject({ coins: ['sol'], payable: ['sol'], accepts: 'all', card: null })
    expect(before.add_stablecoins).toContain('add_stablecoins')

    const added = await me.setCoins({ addStablecoins: true })
    expect(added.coins).toEqual(['usdc_sol', 'sol'])
    expect(added.steps).toHaveLength(1)

    const picked = await me.setCoins({ coins: ['usdc_sol', 'paypal', 'usdc_base'] })
    expect(picked).toMatchObject({ coins: ['usdc_sol'], accepts: ['usdc_sol', 'paypal', 'usdc_base'], unavailable: ['usdc_base'] })

    // A payment: CoinPay is asked for exactly the pick, and the link learns cards are on.
    await h.client().pay('old', 5, 'buyer@example.com')
    expect(h.cp.state.lastSessionBody.allowed_methods).toEqual(['USDC_SOL', 'PAYPAL'])
    expect((await h.client().user('old')).card).toBe(true)

    // Back to everything: no allowed_methods at all.
    await me.setCoins({ coins: 'all' })
    await h.client().pay('old', 5, 'buyer@example.com')
    expect(h.cp.state.lastSessionBody.allowed_methods).toBeUndefined()
  })

  test('no PayPal on the business: card is false; paypal-only with no PayPal is refused by CoinPay', async () => {
    const h = headless()
    h.cp.state.paypal = false
    const c = await h.client().claim({ handle: 'nocard', coinpayToken: 'cp-session' })
    await h.client().pay('nocard', 5, 'buyer@example.com')
    expect((await h.client().user('nocard')).card).toBe(false)
    await h.client(c.api_key).setCoins({ coins: ['paypal'] })
    await expect(h.client().pay('nocard', 5, 'buyer@example.com')).rejects.toThrow(/No payment methods/)
  })

  test('a pick with no wallet behind it is refused before CoinPay', async () => {
    const h = headless()
    const c = await h.client().claim({ handle: 'empty', coinpayToken: 'cp-session' })
    await h.client(c.api_key).setCoins({ coins: ['btc'] })
    await expect(h.client().pay('empty', 5, 'buyer@example.com')).rejects.toThrow(/takes nothing right now/)
  })

  test('needs the key; bad coins are a 400', async () => {
    const h = headless()
    expect((await h.doFetch('https://pay.agent/api/v1/me/coins')).status).toBe(401)
    const c = await h.client().claim({ handle: 'bad', coinpayToken: 'cp-session' })
    await expect(h.client(c.api_key).setCoins({ coins: ['nope'] })).rejects.toThrow(/Unknown coin/)
  })

  test('the CLI shows and sets coins', async () => {
    const h = headless()
    const c = await h.client().claim({ handle: 'cli', coinpayToken: 'cp-session' })
    const lines: string[] = []
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(t) }
    expect(await main(['coins', 'set', 'usdc_sol,card'], out, h.client(c.api_key))).toBe(0)
    expect(lines.join('\n')).toContain('your pick: usdc_sol, paypal')
    expect(await main(['coins'], out, h.client(c.api_key))).toBe(0)
    expect(lines.at(-1)).toContain('takes: usdc_sol')
  })
})

describe('the pages', () => {
  test('the wizard ticks USDC by default; the dashboard picks coins', async () => {
    const h = headless()
    const app = createApp({ store: h.store, key: 'test-key-0123456789abcdef', secureCookies: false, config: { coinpayBase: 'https://cp.test', clientId: 'cp_client', webhookOrigin: 'https://pay.agent.pit.world', fetch: h.cp.fetchImpl }, agent: h.agent })
    let cookie = ''
    const req = async (path: string, form?: Record<string, string>) => {
      const headers = new Headers({ host: 'pay.agent', ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) })
      const res = await app.fetch(new Request(`http://localhost${path}`, { method: form ? 'POST' : 'GET', headers, ...(form ? { body: new URLSearchParams(form).toString() } : {}), redirect: 'manual' }), { ip: '1.2.3.4' })
      const set = res.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]!
      return res
    }
    const loc = new URL((await req('/auth/start')).headers.get('location')!)
    await req(`/auth/callback?code=c1&state=${loc.searchParams.get('state')}`)
    const wizard = await (await req('/start')).text()
    expect(wizard).toContain('name="stablecoins" checked')
    const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(wizard)![1]!
    const done = await (await req('/start', { csrf, handle: 'page', mode: 'wallet', stablecoins: 'on' })).text()
    expect(done).toContain('USDC on Solana')

    const me = await (await req('/me')).text()
    expect(me).toContain('What your link takes')
    expect(me).toContain('name="take_paypal" checked')
    const saved = await (await req('/me/coins', { csrf, take_sol: 'on' })).text()
    expect(saved).toContain('Saved: your link takes Solana.')
    expect(h.store.byHandle('page')!.accepts).toEqual(['sol'])
    const all = await (await req('/me/coins', { csrf, all: 'on' })).text()
    expect(all).toContain('takes everything')
    expect(h.store.byHandle('page')!.accepts).toBeNull()
    const help = await (await req('/help')).text()
    expect(help).toContain('id="cards"')
    expect(help).toContain('/api/paypal/connect')
  })
})
