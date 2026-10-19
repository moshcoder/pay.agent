/**
 * The pay.agent web server: pages, the JSON API, Sign in with CoinPay, and
 * CoinPay's webhook.
 *
 * pay.agent is a Moshpit name. Visitors on Moshpit DNS reach https://pay.agent
 * directly; everyone else comes through the pit.world relay at
 * https://pay.agent.pit.world, which says so with an x-moshpit-name header.
 * Links, cookies and the OAuth callback follow whichever one the visitor used.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import QRCode from 'qrcode'
import { verifyWebhook, eventPaymentId, type WebhookEvent } from '@profullstack/coinpay-onboard'
import { authorizeUrl, exchangeCode, pkce } from '@profullstack/coinpay-onboard/oauth'
import { CoinPay } from '@profullstack/coinpay-onboard'
import { Sealer, Store, type User } from './db.js'
import { checkoutPage, dashboardPage, helpPage, homePage, messagePage, payPage, setupDonePage, wizardPage, type Ctx } from './html.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { PayAgent, SetupError, type Config } from './service.js'
import { VERSION } from './version.js'

export { VERSION }

const SELF = 'pay.agent'
const DIRECT_ORIGIN = 'https://pay.agent'
const RELAY_ORIGIN = 'https://pay.agent.pit.world'
const SESSION = 'pa_session'

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' https://crawlproof.com; img-src 'self' data:; connect-src 'self' https://crawlproof.com; frame-src https://crawlproof.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
}

export type Deps = { store: Store; config: Config; key: string; publicDir?: string; secureCookies?: boolean }

type Env = { Bindings: { ip?: string } }

/** A small fixed-window limit per key, in memory: enough to stop a loop, not a fortress. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    h.n += 1
    return h.n <= this.max
  }
}

async function qrSvg(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  return svg.replace('<svg ', '<svg class="qr" role="img" aria-label="QR code" ')
}

export function createApp(deps: Deps) {
  const { store, config } = deps
  const agent = new PayAgent(store, config)
  const app = new Hono<Env>()
  const payLimit = new Limiter(20, 10 * 60_000)
  const authLimit = new Limiter(30, 10 * 60_000)

  const direct = (c: Context) => visitorOnMoshpit(SELF, c.req.header('host'), c.req.header('x-moshpit-name'))
  // nginx serves the Moshpit name on port 80 too, for clients that cannot check its certificate.
  const https = (c: Context) => (c.req.header('x-forwarded-proto') ?? 'https') === 'https'
  const origin = (c: Context) => (direct(c) && https(c) ? DIRECT_ORIGIN : RELAY_ORIGIN)
  const ip = (c: Context<Env>) => c.env?.ip ?? 'local'
  const sessionId = (c: Context) => getCookie(c, SESSION)
  const csrfFor = (sid: string | undefined) => (sid ? createHmac('sha256', deps.key).update(`csrf:${sid}`).digest('hex').slice(0, 32) : '')
  const userOf = (c: Context) => store.session(sessionId(c))
  const ctxOf = (c: Context): Ctx => ({ user: userOf(c), origin: origin(c), csrf: csrfFor(sessionId(c)) })
  const csrfOk = (c: Context, given: unknown) => {
    const expected = csrfFor(sessionId(c))
    const g = Buffer.from(String(given ?? ''))
    const e = Buffer.from(expected)
    return expected !== '' && g.length === e.length && timingSafeEqual(g, e)
  }
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, direct(c))), status as 200)

  app.use('*', async (c, next) => {
    await next()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }))

  // Static files: the stylesheet, the script, the icon, the Moshpit root.
  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', crt: 'application/x-x509-ca-cert' }
  app.get('/:file{(style\\.css|pay\\.js|favicon\\.svg|moshpit-root-ca\\.crt)}', async (c) => {
    const name = c.req.param('file')
    const file = Bun.file(new URL(`../public/${name}`, import.meta.url))
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': 'public, max-age=86400' })
  })

  app.get('/', (c) => page(c, homePage(ctxOf(c))))
  app.get('/help', (c) => page(c, helpPage(ctxOf(c))))

  // Sign in with CoinPay.
  app.get('/auth/start', (c) => {
    // Over plain http there is no callback CoinPay will send a code to: sign in through the relay.
    if (direct(c) && !https(c)) return c.redirect(`${RELAY_ORIGIN}/auth/start`)
    if (!authLimit.allow(`auth:${ip(c)}`)) return page(c, messagePage(ctxOf(c), { title: 'Slow down', message: 'Too many sign-in attempts. Try again in a few minutes.' }), 429)
    const state = randomBytes(16).toString('base64url')
    const { verifier, challenge } = pkce()
    const redirectUri = `${origin(c)}/auth/callback`
    store.saveState(state, verifier, redirectUri)
    return c.redirect(authorizeUrl({ clientId: config.clientId, redirectUri, state, challenge, base: config.coinpayBase }))
  })

  app.get('/auth/callback', async (c) => {
    const ctx = ctxOf(c)
    const error = c.req.query('error')
    if (error) return page(c, messagePage(ctx, { title: 'Not signed in', message: c.req.query('error_description') ?? 'CoinPay did not sign you in.' }), 400)
    const saved = store.takeState(c.req.query('state') ?? '')
    const code = c.req.query('code')
    if (!saved || !code) return page(c, messagePage(ctx, { title: 'Sign-in expired', message: 'That sign-in link is old. Start again.' }), 400)
    try {
      const tokens = await exchangeCode({ code, verifier: saved.verifier, clientId: config.clientId, ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}), redirectUri: saved.redirectUri, base: config.coinpayBase, ...(config.fetch ? { fetch: config.fetch } : {}) })
      if (!tokens.scope.split(' ').includes('merchant')) {
        return page(c, messagePage(ctx, { title: 'One more permission', message: 'pay.agent needs to set up payments on your CoinPay account. Sign in again and allow it.' }), 400)
      }
      const me = await new CoinPay({ base: config.coinpayBase, token: tokens.accessToken, ...(config.fetch ? { fetch: config.fetch } : {}) }).userinfo()
      const user = store.upsertUser(me.sub, me.name ?? '', me.email ?? '', tokens)
      const sid = store.newSession(user.sub)
      setCookie(c, SESSION, sid, { httpOnly: true, secure: deps.secureCookies ?? https(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
      return c.redirect(user.handle ? '/me' : '/start')
    } catch (e) {
      return page(c, messagePage(ctx, { title: 'Sign-in failed', message: e instanceof Error ? e.message : 'CoinPay did not answer.' }), 502)
    }
  })

  app.post('/auth/logout', async (c) => {
    const form = await c.req.parseBody()
    if (csrfOk(c, form.csrf)) store.endSession(sessionId(c))
    deleteCookie(c, SESSION, { path: '/' })
    return c.redirect('/')
  })

  // The wizard.
  const wizard = async (c: Context, extra: { error?: { message: string; field?: string }; values?: Record<string, string> } = {}, status = 200) => {
    const ctx = ctxOf(c)
    try {
      const context = await agent.wizardContext(ctx.user!.sub)
      return page(c, wizardPage(ctx, { ...context, ...extra }), status)
    } catch (e) {
      return page(c, wizardPage(ctx, { businesses: [], accountCoins: [], ...extra, coinpayError: e instanceof Error ? `CoinPay: ${e.message}` : 'CoinPay did not answer.' }), status)
    }
  }

  app.get('/start', async (c) => {
    if (!userOf(c)) return c.redirect('/auth/start')
    return wizard(c)
  })

  app.post('/start', async (c) => {
    const user = userOf(c)
    if (!user) return c.redirect('/auth/start')
    const form = (await c.req.parseBody()) as Record<string, string>
    if (!csrfOk(c, form.csrf)) return wizard(c, { error: { message: 'That form went stale. Try again.' } }, 400)
    const mode = form.mode === 'business' ? 'business' : 'wallet'
    try {
      const r = await agent.setup(user, {
        handle: form.handle ?? '',
        mode,
        ...(form.business_id ? { businessId: form.business_id } : {}),
        ...(form.address?.trim() && form.address_coin ? { addresses: { [form.address_coin]: form.address } } : {}),
      })
      return page(c, setupDonePage(ctxOf(c), { handle: store.user(user.sub)!.handle!, steps: r.steps, coins: r.coins }))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      return wizard(c, { error: { message, ...(e instanceof SetupError && e.field ? { field: e.field } : {}) }, values: form }, e instanceof SetupError ? 400 : 502)
    }
  })

  // The owner's page.
  const dashboard = async (c: Context, extra: { apiKey?: string; flash?: string } = {}) => {
    const ctx = ctxOf(c)
    const user = ctx.user!
    if (!user.handle) return c.redirect('/start')
    const qr = await qrSvg(`${ctx.origin}/${user.handle}`)
    return page(c, dashboardPage(ctx, { user, payments: store.payments(user.handle), qr, ...extra }))
  }

  app.get('/me', (c) => (userOf(c) ? dashboard(c) : c.redirect('/auth/start')))

  app.post('/me/:action{(recheck|key|delete)}', async (c) => {
    const user = userOf(c)
    if (!user) return c.redirect('/auth/start')
    const form = await c.req.parseBody()
    if (!csrfOk(c, form.csrf)) return dashboard(c, { flash: 'That form went stale. Try again.' })
    switch (c.req.param('action')) {
      case 'recheck':
        try {
          const coins = await agent.recheck(user)
          return dashboard(c, { flash: coins.length ? `Your link takes ${coins.length} coin(s).` : 'Still no payout address on your CoinPay account.' })
        } catch (e) {
          return dashboard(c, { flash: `CoinPay: ${e instanceof Error ? e.message : e}` })
        }
      case 'key': {
        const key = `pa_${randomBytes(24).toString('base64url')}`
        store.setApiKey(user.sub, key)
        return dashboard(c, { apiKey: key })
      }
      case 'delete':
        store.deleteUser(user.sub)
        deleteCookie(c, SESSION, { path: '/' })
        return c.redirect('/')
    }
    return c.redirect('/me')
  })

  // CoinPay's events, for the businesses pay.agent made (wallet mode).
  app.post('/hooks/coinpay', async (c) => {
    const raw = await c.req.text()
    let event: WebhookEvent
    try {
      event = JSON.parse(raw)
    } catch {
      return c.json({ error: 'not JSON' }, 400)
    }
    const owner = event.business_id ? store.byBusiness(String(event.business_id)) : null
    if (!owner?.webhookSecret || !verifyWebhook(raw, c.req.header('x-coinpay-signature'), owner.webhookSecret)) return c.json({ error: 'bad signature' }, 401)
    const id = eventPaymentId(event)
    const status = String(event.data?.status ?? event.type?.replace(/^payment\./, '') ?? '')
    if (id && status && store.payment(id)) store.setStatus(id, status)
    return c.json({ ok: true })
  })

  // The API: anyone may pay anyone; an owner reads their own with a key.
  const publicUser = (u: User, o: string) => ({ handle: u.handle, name: u.name, coins: u.coins, url: `${o}/${u.handle}` })
  const publicPayment = (p: NonNullable<ReturnType<Store['payment']>>, o: string) => ({
    id: p.id,
    handle: p.handle,
    amount_usd: p.amountUsd,
    coin: p.coin,
    amount_crypto: p.amountCrypto,
    address: p.address,
    status: p.status,
    expires_at: p.expiresAt,
    checkout_url: `${o}/p/${p.id}`,
  })

  app.get('/api/v1/users/:handle', (c) => {
    const u = store.byHandle(c.req.param('handle'))
    return u?.handle ? c.json(publicUser(u, origin(c))) : c.json({ error: 'no such pay link' }, 404)
  })

  app.post('/api/v1/users/:handle/payments', async (c) => {
    if (!payLimit.allow(`pay:${ip(c)}`)) return c.json({ error: 'too many payments from you; wait a few minutes' }, 429)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    try {
      const p = await agent.pay(c.req.param('handle'), { amountUsd: Number(body.amount_usd), ...(typeof body.coin === 'string' ? { coin: body.coin } : {}), ...(typeof body.note === 'string' ? { note: body.note } : {}), ...(typeof body.payer === 'string' ? { payer: body.payer } : {}) })
      return c.json(publicPayment(p, origin(c)), 201)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, e instanceof SetupError ? 400 : 502)
    }
  })

  app.get('/api/v1/payments/:id', async (c) => {
    const p = await agent.follow(c.req.param('id'))
    return p ? c.json(publicPayment(p, origin(c))) : c.json({ error: 'no such payment' }, 404)
  })

  app.get('/api/v1/me', (c) => {
    const key = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const u = key.startsWith('pa_') ? store.byApiKey(key) : null
    if (!u?.handle) return c.json({ error: 'send your API key: authorization: Bearer pa_…' }, 401)
    return c.json({ ...publicUser(u, origin(c)), mode: u.mode, business: u.businessName, payments: store.payments(u.handle).map((p) => ({ ...publicPayment(p, origin(c)), note: p.note, payer: p.payer, created_at: new Date(p.createdAt).toISOString() })) })
  })

  // A payment's own page.
  app.get('/p/:id', async (c) => {
    const p = await agent.follow(c.req.param('id'))
    if (!p) return page(c, messagePage(ctxOf(c), { title: 'No such payment', message: 'That payment does not exist.' }), 404)
    return page(c, checkoutPage(ctxOf(c), { payment: p, payee: store.byHandle(p.handle), qr: await qrSvg(p.address) }))
  })

  // A pay link.
  app.get('/:handle', (c) => {
    const payee = store.byHandle(c.req.param('handle'))
    if (!payee?.handle) return page(c, messagePage(ctxOf(c), { title: 'No such pay link', message: 'Nobody has that name yet. It could be yours.' }), 404)
    return page(c, payPage(ctxOf(c), { payee, amount: c.req.query('amount'), note: c.req.query('note'), coin: c.req.query('coin') }))
  })

  app.post('/:handle', async (c) => {
    const payee = store.byHandle(c.req.param('handle'))
    if (!payee?.handle) return page(c, messagePage(ctxOf(c), { title: 'No such pay link', message: 'Nobody has that name yet.' }), 404)
    const form = (await c.req.parseBody()) as Record<string, string>
    if (!payLimit.allow(`pay:${ip(c)}`)) return page(c, payPage(ctxOf(c), { payee, ...form, error: 'Too many payments from you. Wait a few minutes.' }), 429)
    try {
      const p = await agent.pay(payee.handle, { amountUsd: Number(String(form.amount ?? '').replace(/[$,\s]/g, '')), coin: form.coin, note: form.note, payer: form.payer })
      return c.redirect(`/p/${p.id}`)
    } catch (e) {
      return page(c, payPage(ctxOf(c), { payee, amount: form.amount, note: form.note, coin: form.coin, error: e instanceof Error ? e.message : String(e) }), e instanceof SetupError ? 400 : 502)
    }
  })

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : page(c, messagePage(ctxOf(c), { title: 'Not found', message: 'That page does not exist.' }), 404)))
  app.onError((error, c) => {
    console.error(error instanceof Error ? error.message : error)
    return c.req.path.startsWith('/api/') ? c.json({ error: 'Something went wrong.' }, 500) : page(c, messagePage(ctxOf(c), { title: 'Something went wrong', message: 'Try again in a moment.' }), 500)
  })
  return app
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const key = env.PAYAGENT_KEY ?? ''
  const store = new Store(env.PAYAGENT_DB ?? `${env.HOME}/.local/share/pay-agent/pay-agent.db`, new Sealer(key))
  if (!env.PAYAGENT_COINPAY_CLIENT_ID) throw new Error('PAYAGENT_COINPAY_CLIENT_ID must be set (the CoinPay OAuth client)')
  const app = createApp({
    store,
    key,
    config: {
      coinpayBase: env.COINPAY_BASE ?? 'https://coinpayportal.com',
      clientId: env.PAYAGENT_COINPAY_CLIENT_ID,
      ...(env.PAYAGENT_COINPAY_CLIENT_SECRET ? { clientSecret: env.PAYAGENT_COINPAY_CLIENT_SECRET } : {}),
      // CoinPay's servers are on the public DNS: they reach us through the relay.
      webhookOrigin: env.PAYAGENT_WEBHOOK_ORIGIN ?? RELAY_ORIGIN,
    },
  })
  const trustProxy = (env.PAYAGENT_TRUST_PROXY ?? '1') === '1'
  startRingRefresh()
  return Bun.serve({
    port: options.port ?? Number(env.PORT ?? 8796),
    hostname: options.hostname ?? env.HOST ?? '127.0.0.1',
    idleTimeout: 60,
    fetch(request, srv) {
      const peer = srv.requestIP(request)?.address ?? ''
      const forwarded = trustProxy && (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') ? request.headers.get('x-real-ip') : null
      return app.fetch(request, { ip: forwarded || peer })
    },
  })
}

if (import.meta.main) {
  const server = serve()
  console.log(`pay.agent listening on http://${server.hostname}:${server.port}`)
}
