import { describe, expect, test } from 'bun:test'
import { UnlockStore } from '@profullstack/sealed-secrets'
import { Sealer, Store } from '../src/db.ts'
import { createApp } from '../src/server.ts'
import { PayAgent } from '../src/service.ts'
import { TokenVault } from '../src/vault.ts'
import { fakeCoinPay } from './fake-coinpay.ts'

// Unlock-on-use for the CoinPay tokens pay.agent acts with: sealed under a
// key that lives only in memory; restart / TTL / Lock pause the link (423).

const KEY = 'test-key-0123456789abcdef'

function setup(opts: { store?: Store; legacy?: boolean; now?: () => number; cp?: ReturnType<typeof fakeCoinPay> } = {}) {
  const cp = opts.cp ?? fakeCoinPay()
  const store = opts.store ?? new Store(':memory:', new Sealer(KEY))
  const config = { coinpayBase: 'https://cp.test', clientId: 'cp_client', webhookOrigin: 'https://pay.agent.pit.world', fetch: cp.fetchImpl }
  const sessions = new UnlockStore({ ...(opts.now ? { now: opts.now } : {}), useTimers: false })
  const vault = new TokenVault(store, { legacyMigration: opts.legacy ?? true, sessions, log: () => {} })
  const agent = new PayAgent(store, { ...config, vault })
  const app = createApp({ store, key: KEY, secureCookies: false, config, agent })
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
  return { cp, store, agent, vault, req, csrfFrom }
}

async function onboarded(t: ReturnType<typeof setup>, handle = 'alice') {
  const start = await t.req('/auth/start')
  const state = new URL(start.headers.get('location')!).searchParams.get('state')
  await t.req(`/auth/callback?code=c1&state=${state}`)
  const csrf = await t.csrfFrom(await t.req('/start'))
  expect((await t.req('/start', { method: 'POST', form: { csrf, handle, mode: 'wallet' } })).status).toBe(200)
  return csrf
}

const pay = (t: ReturnType<typeof setup>, handle = 'alice') =>
  t.req(`/api/v1/users/${handle}/payments`, { method: 'POST', body: JSON.stringify({ amount_usd: 5, payer_email: 'p@example.com' }), headers: { 'content-type': 'application/json' } })

describe('CoinPay tokens: unlock-on-use', () => {
  test('sign-in seals tokens under an in-memory key; nothing on disk opens them', async () => {
    const t = setup()
    await onboarded(t)
    const row = t.store.db.query('SELECT * FROM users').get() as Record<string, unknown>
    expect(row.tokens).toBeNull()
    expect(row.seal_version).toBe(2)
    const dump = JSON.stringify(row)
    expect(dump).not.toContain('at-first')
    expect(dump).not.toContain('rt-')
    // PAYAGENT_KEY (the server key) cannot open the sealed copy.
    expect(() => t.store.sealer.open(String(row.tokens_sealed))).toThrow()
    expect((await t.vault.read('merchant-1')).accessToken).toBe('at-first')
    expect((await pay(t)).status).toBe(201)
  })

  test('a restart locks every link: payments answer 423 and the pay page says paused', async () => {
    const first = setup()
    await onboarded(first)
    const after = setup({ store: first.store, cp: first.cp })
    const res = await pay(after)
    expect(res.status).toBe(423)
    expect(((await res.json()) as any).error).toContain('locked')
    expect(await (await after.req('/alice')).text()).toContain('This pay link is paused')
  })

  test('signing in again resumes', async () => {
    const first = setup()
    await onboarded(first)
    const after = setup({ store: first.store, cp: first.cp })
    expect((await pay(after)).status).toBe(423)
    const start = await after.req('/auth/start')
    await after.req(`/auth/callback?code=c2&state=${new URL(start.headers.get('location')!).searchParams.get('state')}`)
    expect((await pay(after)).status).toBe(201)
  })

  test('the TTL ends the unlock', async () => {
    let now = 1_000_000
    const t = setup({ now: () => now })
    await onboarded(t)
    expect((await pay(t)).status).toBe(201)
    now += 8 * 86400_000
    expect((await pay(t)).status).toBe(423)
  })

  test('Lock now, and the owner picks a shorter TTL', async () => {
    let now = 1_000_000
    const t = setup({ now: () => now })
    const csrf = await onboarded(t)
    await t.req('/me/ttl', { method: 'POST', form: { csrf, ttl: '8h' } })
    expect(t.vault.status('merchant-1').expiresAt).toBe(new Date(now + 8 * 3600_000).toISOString())
    const dash = await (await t.req('/me')).text()
    expect(dash).toContain('CoinPay access')
    await t.req('/me/lock', { method: 'POST', form: { csrf } })
    expect((await pay(t)).status).toBe(423)
    expect(await (await t.req('/me')).text()).toContain('Your link is paused')
  })

  test('legacy PAYAGENT_KEY copies migrate once, then are gone; LEGACY_KEY_MIGRATION=off leaves them', async () => {
    for (const legacy of [true, false]) {
      const first = setup()
      await onboarded(first)
      // A row as the pre-2026-10-28 code left it.
      first.store.db
        .query('UPDATE users SET tokens = ?, tokens_sealed = NULL, seal_version = 0')
        .run(first.store.sealer.seal(JSON.stringify({ accessToken: 'at-legacy', refreshToken: 'rt-legacy', expiresAt: Date.now() + 3600_000 })))
      const after = setup({ store: first.store, cp: first.cp, legacy })
      const res = await pay(after)
      const row = after.store.db.query('SELECT tokens, tokens_sealed FROM users').get() as Record<string, unknown>
      if (legacy) {
        expect(res.status).toBe(201)
        expect(row.tokens).toBeNull()
        expect(row.tokens_sealed).not.toBeNull()
        expect(after.store.legacyTokenCount()).toBe(0)
      } else {
        expect(res.status).toBe(423)
        expect(row.tokens).not.toBeNull()
        expect(after.store.legacyTokenCount()).toBe(1)
      }
    }
  })
})
