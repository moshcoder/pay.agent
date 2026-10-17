/**
 * The pay.agent API from anywhere: the CLI, the TUI and the MCP server use this.
 * PAYAGENT_URL points it at another instance; PAYAGENT_KEY (pa_…) reads your own.
 */
export type ApiPayment = { id: string; handle: string; amount_usd: number; coin: string; amount_crypto: string; address: string; status: string; expires_at: string | null; checkout_url: string }
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
}

export const PAID = ['confirmed', 'forwarded', 'completed']
