/**
 * The pay.agent API from anywhere: the CLI, the TUI and the MCP server use this.
 * PAYAGENT_URL points it at another instance; PAYAGENT_KEY (pa_…) reads your own.
 */
export type ApiPayment = { id: string; handle: string; amount_usd: number; coin: string; amount_crypto: string; address: string; status: string; expires_at: string | null; checkout_url: string }
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

  user(handle: string): Promise<ApiUser> {
    return this.call('GET', `/api/v1/users/${encodeURIComponent(handle.replace(/^@/, ''))}`)
  }

  pay(handle: string, amountUsd: number, coin?: string, note?: string): Promise<ApiPayment> {
    return this.call('POST', `/api/v1/users/${encodeURIComponent(handle.replace(/^@/, ''))}/payments`, { amount_usd: amountUsd, ...(coin ? { coin } : {}), ...(note ? { note } : {}) })
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
