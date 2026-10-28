/**
 * The pay.agent API from anywhere: the CLI, the TUI and the MCP server use this.
 * PAYAGENT_URL points it at another instance; PAYAGENT_KEY (pa_…) reads your own.
 */
/** A payment: open checkout_url (CoinPay's hosted checkout) to pay it in any coin the payee takes, or PayPal. */
export type ApiPayment = { id: string; handle: string; amount_usd: number; status: string; expires_at: string | null; checkout_url: string; status_url: string; session_id?: string; coin: string | null; amount_crypto?: string; address?: string }
export type ApiInvoice = {
  id: string
  number: string
  handle: string
  to_name: string
  to_email?: string
  description: string
  amount_usd: number
  coin: string
  due_date: string | null
  recurrence: string | null
  status: string
  amount_crypto?: string
  address?: string
  url: string
  coinpay_url: string
  warning?: string
}
export type InvoiceRequest = { to_email: string; to_name?: string; description: string; amount_usd: number; coin?: string; due_date?: string; recurrence?: string; email?: boolean }
export type ApiUser = { handle: string; name: string; coins: string[]; url: string }
export type ClaimOptions = { handle?: string; mode?: 'wallet' | 'business'; businessId?: string; coinpayToken?: string; coinpayEmail?: string; coinpayPassword?: string; coinpayBase?: string }
export type ApiClaim = ApiUser & { mode: string | null; api_key: string; steps: unknown[]; new: boolean }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class PayAgentClient {
  readonly base: string
  constructor(base = process.env.PAYAGENT_URL ?? 'https://pay.agent.pit.world', private readonly key = process.env.PAYAGENT_KEY, private readonly doFetch: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '')
  }

  private async call<T>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
    const response = await this.doFetch(this.base + path, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(auth && this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new ApiError(data.error ?? `pay.agent answered ${response.status}`, response.status)
    return data as T
  }

  /**
   * Claim a handle (or get a fresh key for the one you have) with no browser:
   * sign in to CoinPay as yourself, approve pay.agent on CoinPay with that
   * session, and trade the code for the handle and a pa_ key. Credentials come
   * from the options or COINPAY_TOKEN / COINPAY_EMAIL + COINPAY_PASSWORD, and
   * go only to CoinPay. Approving gives pay.agent the same CoinPay access the
   * consent screen lists; CoinPay never lets it move funds.
   */
  async claim(options: ClaimOptions = {}): Promise<ApiClaim> {
    const start = await this.call<{ state: string; consent: { endpoint: string; body: Record<string, string> } }>('POST', '/api/v1/claim/start', {})
    const coinpay = new URL(start.consent.endpoint).origin
    let token = options.coinpayToken ?? process.env.COINPAY_TOKEN
    if (!token) {
      const email = options.coinpayEmail ?? process.env.COINPAY_EMAIL
      const password = options.coinpayPassword ?? process.env.COINPAY_PASSWORD
      if (!email || !password) throw new ApiError('set COINPAY_TOKEN, or COINPAY_EMAIL and COINPAY_PASSWORD, to sign in to CoinPay', 400)
      const login = await this.doFetch(`${options.coinpayBase ?? coinpay}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000) })
      const data = (await login.json().catch(() => ({}))) as { token?: string; error?: string }
      if (!login.ok || !data.token) throw new ApiError(`CoinPay sign-in: ${data.error ?? login.status}`, login.status || 401)
      token = data.token
    }
    const consent = await this.doFetch(start.consent.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(start.consent.body), signal: AbortSignal.timeout(30_000) })
    const approved = (await consent.json().catch(() => ({}))) as { redirect?: string; error_description?: string; error?: string }
    if (!consent.ok || !approved.redirect) throw new ApiError(`CoinPay consent: ${approved.error_description ?? approved.error ?? consent.status}`, consent.status || 400)
    return this.call('POST', '/api/v1/claim', {
      redirect: approved.redirect,
      ...(options.handle ? { handle: options.handle.replace(/^@/, '') } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.businessId ? { business_id: options.businessId } : {}),
    })
  }

  user(handle: string): Promise<ApiUser> {
    return this.call('GET', `/api/v1/users/${encodeURIComponent(handle.replace(/^@/, ''))}`)
  }

  /** Start paying `handle`: a CoinPay checkout for the amount. `email` gets the receipt (required). */
  pay(handle: string, amountUsd: number, email: string, note?: string): Promise<ApiPayment> {
    return this.call('POST', `/api/v1/users/${encodeURIComponent(handle.replace(/^@/, ''))}/payments`, { amount_usd: amountUsd, payer_email: email, ...(note ? { note } : {}) })
  }

  payment(id: string): Promise<ApiPayment> {
    return this.call('GET', `/api/v1/payments/${encodeURIComponent(id)}`)
  }

  me(): Promise<ApiUser & { payments: (ApiPayment & { note: string; created_at: string })[] }> {
    if (!this.key) throw new ApiError('Set PAYAGENT_KEY to your key from pay.agent/me', 401)
    return this.call('GET', '/api/v1/me', undefined, true)
  }

  /** Send an invoice from your link (needs PAYAGENT_KEY): CoinPay emails them a pay link. */
  invoice(input: InvoiceRequest): Promise<ApiInvoice> {
    if (!this.key) throw new ApiError('Set PAYAGENT_KEY to your key from pay.agent/me', 401)
    return this.call('POST', '/api/v1/invoices', input, true)
  }

  invoices(): Promise<{ invoices: (ApiInvoice & { created_at: string })[] }> {
    if (!this.key) throw new ApiError('Set PAYAGENT_KEY to your key from pay.agent/me', 401)
    return this.call('GET', '/api/v1/invoices', undefined, true)
  }

  invoiceStatus(id: string): Promise<ApiInvoice> {
    return this.call('GET', `/api/v1/invoices/${encodeURIComponent(id)}`)
  }
}

export const PAID = ['confirmed', 'forwarded', 'completed']
