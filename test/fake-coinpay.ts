/** CoinPay, faked: OAuth, businesses, wallets, payments. */
export function fakeCoinPay() {
  const state = { businesses: [] as any[], accountWallets: [{ cryptocurrency: 'USDC_SOL', wallet_address: 'So1Payout' }] as any[], payments: new Map<string, any>(), refreshes: 0, lastPaymentBody: null as any, sessions: new Map<string, any>(), lastSessionBody: null as any, sessionAuth: [] as string[], invoices: new Map<string, any>(), clients: [] as any[], invoiceAuth: [] as string[], consents: [] as any[] }
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
    if (path === '/api/auth/login') return body.password === 'right' ? json(200, { success: true, token: 'cp-session' }) : json(401, { success: false, error: 'Invalid email or password' })
    if (path === '/api/oauth/authorize' && method === 'POST') {
      if (new Headers(init.headers).get('authorization') !== 'Bearer cp-session') return json(401, { error: 'login_required' })
      state.consents.push(body)
      return json(200, { redirect: `${body.redirect_uri}?code=c-headless&state=${body.state}` })
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
    if (path === '/api/checkout/sessions' && method === 'POST') {
      state.lastSessionBody = body
      state.sessionAuth.push(new Headers(init.headers).get('authorization') ?? '')
      if (!body.business_id) return json(400, { success: false, error: 'business_id is required' })
      const id = `cs_test${state.sessions.size + 1}`
      const sess = { id, url: `https://cp.test/checkout/${id}`, status: 'open', amount: body.amount, currency: body.currency, property: body.property, methods: ['USDC_SOL', 'BTC', 'PAYPAL'], expires_at: '2030-01-01T00:00:00Z' }
      state.sessions.set(id, sess)
      return json(201, { success: true, ...sess })
    }
    const cs = /^\/api\/checkout\/sessions\/(cs_test\d+)$/.exec(path)
    if (cs) {
      const sess = state.sessions.get(cs[1]!)
      return sess ? json(200, { success: true, session: sess }) : json(404, { success: false, error: 'Checkout session not found' })
    }
    if (path === '/api/clients' && method === 'POST') {
      const c = { id: `cl${state.clients.length + 1}`, ...body }
      state.clients.push(c)
      return json(201, { success: true, client: c })
    }
    if (path === '/api/invoices' && method === 'POST') {
      state.invoiceAuth.push(new Headers(init.headers).get('authorization') ?? '')
      const inv = { id: `inv-${state.invoices.size + 1}`, invoice_number: `INV-00${state.invoices.size + 1}`, status: 'draft', ...body }
      state.invoices.set(inv.id, inv)
      return json(201, { success: true, invoice: inv })
    }
    const ia = /^\/api\/invoices\/(inv-\d+)\/(send|publish|pay)$/.exec(path)
    if (ia) {
      const inv = state.invoices.get(ia[1]!)
      if (!inv) return json(404, { success: false, error: 'Invoice not found' })
      if (ia[2] === 'pay') return json(200, { success: true, invoice: { ...inv, crypto_amount: '49.000000', payment_address: 'So1Invoice' } })
      inv.status = 'sent'
      inv.action = ia[2]
      return json(200, { success: true, invoice: inv, paymentLink: `https://cp.test/now/${inv.id}` })
    }
    const m = /^\/api\/payments\/(pay\d+)$/.exec(path)
    if (m) return json(200, { success: true, payment: state.payments.get(m[1]!) })
    return json(404, { success: false, error: `no ${method} ${path}` })
  }) as typeof fetch
  return { state, fetchImpl }
}
