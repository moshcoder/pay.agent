/**
 * What pay.agent does, apart from pages: talk to CoinPay as each person,
 * onboard them, and make and follow payments.
 */
import { randomBytes } from 'node:crypto'
import { COINS, CoinPay, onboard, payableBy, payableCoins, readWebhook, walletCode, type CheckoutSession, type OnboardStep } from '@profullstack/coinpay-onboard'
import { refresh as refreshTokens } from '@profullstack/coinpay-onboard/oauth'
import { validHandle, type InvoiceRow, type Mode, type PaymentRow, type Store, type User } from './db.js'

export type Config = {
  coinpayBase: string
  clientId: string
  clientSecret?: string
  /** The public origin CoinPay posts events to: https://pay.agent */
  webhookOrigin: string
  fetch?: typeof fetch
}

export class SetupError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message)
  }
}

const MIN_USD = 0.5
const MAX_USD = 10_000

export function coinName(id: string): string {
  if (id.toLowerCase() === 'paypal') return 'PayPal'
  return COINS.find((c) => c.id === id)?.name ?? id.toUpperCase()
}

/** Stablecoins first: a payer thinking in dollars wants dollars. */
export function sortCoins(ids: string[]): string[] {
  const order = new Map<string, number>(COINS.map((c, i) => [c.id, i]))
  return [...new Set(ids)].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99))
}

export class PayAgent {
  private refreshing = new Map<string, Promise<CoinPay>>()

  constructor(readonly store: Store, readonly config: Config) {}

  /** A CoinPay client acting as this person, refreshing their token when it is about to lapse. */
  clientFor(sub: string): Promise<CoinPay> {
    const pending = this.refreshing.get(sub)
    if (pending) return pending
    const tokens = this.store.tokens(sub)
    if (!tokens) return Promise.reject(new SetupError('Sign in with CoinPay again.'))
    const make = (token: string) => new CoinPay({ base: this.config.coinpayBase, token, ...(this.config.fetch ? { fetch: this.config.fetch } : {}) })
    if (tokens.expiresAt - Date.now() > 60_000) return Promise.resolve(make(tokens.accessToken))
    if (!tokens.refreshToken) return Promise.reject(new SetupError('Your CoinPay sign-in has expired. Sign in again.'))
    // One refresh at a time per person: the refresh token is spent by using it.
    const job = refreshTokens({
      refreshToken: tokens.refreshToken,
      clientId: this.config.clientId,
      ...(this.config.clientSecret ? { clientSecret: this.config.clientSecret } : {}),
      base: this.config.coinpayBase,
      ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
    })
      .then((next) => {
        this.store.saveTokens(sub, { accessToken: next.accessToken, refreshToken: next.refreshToken ?? tokens.refreshToken, expiresAt: next.expiresAt })
        return make(next.accessToken)
      })
      .finally(() => this.refreshing.delete(sub))
    this.refreshing.set(sub, job)
    return job
  }

  /** What the wizard shows: their businesses and the coins their account wallets cover. */
  async wizardContext(sub: string): Promise<{ businesses: { id: string; name: string }[]; accountCoins: string[] }> {
    const client = await this.clientFor(sub)
    const [businesses, wallets] = await Promise.all([client.businesses().catch(() => []), client.wallets('account').catch(() => [])])
    return {
      businesses: businesses.map((b) => ({ id: b.id, name: b.name })),
      accountCoins: payableCoins(wallets.map((w) => String(w.cryptocurrency))),
    }
  }

  /**
   * The whole of onboarding in one call: claim the handle, and either make a
   * pay.agent business that pays out to their CoinPay wallet, or use a
   * business they already have. Payout addresses they typed are added first.
   */
  async setup(user: User, input: { handle: string; mode: Mode; businessId?: string; addresses?: Record<string, string> }): Promise<{ steps: OnboardStep[]; coins: string[] }> {
    const handle = input.handle.trim().toLowerCase().replace(/^@/, '')
    const problem = validHandle(handle)
    if (problem) throw new SetupError(problem, 'handle')
    if (this.store.handleTaken(handle, user.sub)) throw new SetupError('that one is taken', 'handle')
    const client = await this.clientFor(user.sub)
    const addresses = Object.fromEntries(Object.entries(input.addresses ?? {}).filter(([coin, a]) => COINS.some((c) => c.id === coin) && a.trim()))

    if (input.mode === 'business') {
      const business = (await client.businesses()).find((b) => b.id === input.businessId)
      if (!business) throw new SetupError('Pick one of your CoinPay businesses.', 'business')
      // Their business, their webhook: we never repoint it. Payments are
      // followed by asking CoinPay instead.
      const r = await onboard(client, { businessName: business.name, addresses, importWallets: Object.keys(addresses).length > 0 })
      const coins = sortCoins(r.coins.filter((c) => COINS.some((k) => k.id === c)))
      this.store.setup(user.sub, { handle, mode: 'business', businessId: business.id, businessName: business.name, coins, webhookSecret: null })
      return { steps: r.steps, coins }
    }

    const name = `pay.agent/${handle}`
    const r = await onboard(client, {
      businessName: name,
      category: 'freelance',
      description: `Payments to ${name}, made by pay.agent`,
      webhookUrl: `${this.config.webhookOrigin}/hooks/coinpay`,
      addresses,
      // The wallet mode settles to the account's own payout wallets: CoinPay
      // falls back to them when the business has none of its own.
      importWallets: false,
    })
    const coins = sortCoins(r.coins.filter((c) => COINS.some((k) => k.id === c)))
    this.store.setup(user.sub, { handle, mode: 'wallet', businessId: r.business.id, businessName: r.business.name, coins, webhookSecret: r.webhookSecret })
    return { steps: r.steps, coins }
  }

  /** What a re-check found, in words: what changed, and what a new wallet would add. */
  static recheckMessage(before: string[], after: string[]): string {
    const added = after.filter((c) => !before.includes(c))
    const dropped = before.filter((c) => !after.includes(c))
    const missing = COINS.filter((c) => !after.includes(c.id)).map((c) => c.name)
    const names = (ids: string[]) => ids.map(coinName).join(', ')
    const parts = [
      added.length || dropped.length
        ? [added.length ? `Added ${names(added)}.` : '', dropped.length ? `Dropped ${names(dropped)}: no wallet for it on CoinPay now.` : ''].filter(Boolean).join(' ')
        : after.length
          ? `Checked CoinPay: no change, your link still takes ${after.length} coin${after.length === 1 ? '' : 's'}.`
          : 'Checked CoinPay: still no payout wallet on your account.',
    ]
    if (missing.length) parts.push(`To take ${missing.join(', ')} too, add a wallet for it in CoinPay, then check again.`)
    return parts.join(' ')
  }

  /** Re-reads which coins the link can take (after they add a wallet in CoinPay). */
  async recheck(user: User): Promise<string[]> {
    if (!user.businessId) return []
    const client = await this.clientFor(user.sub)
    const coins = sortCoins(payableCoins(await payableBy(client, user.businessId)))
    this.store.setCoins(user.sub, coins)
    return coins
  }

  /**
   * A payment to `handle`: a CoinPay hosted checkout session on the payee's own
   * business, made as the payee over OAuth. The payer picks any coin the payee
   * can receive (or PayPal, when the payee connected it) on CoinPay's page and
   * comes back to /p/<id>. We keep a row to show and follow.
   */
  async pay(handle: string, input: { amountUsd: number; email: string; note?: string; payer?: string; origin: string }): Promise<PaymentRow> {
    const payee = this.store.byHandle(handle)
    if (!payee?.businessId || !payee.handle) throw new SetupError('No one has that pay link.')
    const amount = Math.round(Number(input.amountUsd) * 100) / 100
    if (!Number.isFinite(amount) || amount < MIN_USD || amount > MAX_USD) throw new SetupError(`Amount must be between $${MIN_USD} and $${MAX_USD.toLocaleString('en-US')}.`, 'amount')
    const email = clean(input.email, 254).toLowerCase()
    if (!EMAIL.test(email)) throw new SetupError('Your email, for the receipt.', 'email')
    if (this.store.pendingCount(payee.handle, Date.now() - 10 * 60_000) > 50) throw new SetupError('Too many unpaid payments to this link right now. Try again in a few minutes.')
    const note = clean(input.note, 140)
    const payer = clean(input.payer, 60)
    const id = `pl_${randomBytes(12).toString('hex')}`
    const origin = input.origin.replace(/\/+$/, '')
    const client = await this.clientFor(payee.sub)
    const session: CheckoutSession = await client.createCheckoutSession({
      businessId: payee.businessId,
      amount,
      currency: 'USD',
      description: note ? `pay.agent/${payee.handle}: ${note}` : `pay.agent/${payee.handle}`,
      customerEmail: email,
      accountId: email,
      property: PROPERTY,
      metadata: { via: 'pay.agent', handle: payee.handle, payagent_id: id, ...(note ? { note } : {}), ...(payer ? { payer } : {}) },
      successUrl: `${origin}/p/${id}?session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/${payee.handle}`,
      expiresInMinutes: 60,
      idempotencyKey: randomBytes(16).toString('hex'),
    })
    this.store.addPayment({
      id,
      handle: payee.handle,
      amountUsd: amount,
      coin: '',
      amountCrypto: '',
      address: '',
      status: 'pending',
      note,
      payer,
      payerEmail: email,
      sessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: session.expiresAt,
    })
    return this.store.payment(id)!
  }

  /**
   * A CoinPay event for `owner`'s business, already verified. Settles the row
   * its checkout session made (or, for payments made before sessions, the row
   * of that payment). Idempotent: confirmed then forwarded both land; a paid
   * row never goes back; events for other owners' rows are ignored.
   */
  settleEvent(owner: { handle: string | null }, payload: unknown): { matched: boolean; paid: boolean } {
    const w = readWebhook(payload)
    const localId = typeof w.metadata?.payagent_id === 'string' ? w.metadata.payagent_id : ''
    const row = this.store.bySession(w.checkoutSessionId ?? '') ?? (localId ? this.store.payment(localId) : null) ?? (w.paymentId ? this.store.payment(w.paymentId) : null)
    if (!row || row.handle !== owner.handle) return { matched: false, paid: false }
    const fromSession = Boolean(row.sessionId)
    if (w.paid) {
      const status = w.type === 'payment.forwarded' || w.status === 'forwarded' ? 'forwarded' : w.status === 'completed' ? 'completed' : 'confirmed'
      // Forwarded is the last word; a late confirmed does not undo it.
      const next = row.status === 'forwarded' ? 'forwarded' : status
      this.store.settle(row.id, { status: next, paymentId: w.paymentId, coin: w.method ? w.method.toLowerCase() : '' })
      return { matched: true, paid: true }
    }
    if (PAID.has(row.status)) return { matched: true, paid: true }
    // One session can see a payment expire (the payer switched coins) and still
    // be paid; the session itself says when it is over, so we ask it in follow().
    if (!fromSession) {
      const status = w.status || w.type.replace(/^payment\./, '')
      if (status) this.store.setStatus(row.id, status)
    }
    return { matched: true, paid: false }
  }

  /**
   * An invoice from `user` to someone's email: a CoinPay client and invoice on
   * their pay.agent business, then CoinPay activates its pay link and (unless
   * `email` is false) emails it. A recurrence makes CoinPay send the next ones.
   */
  async sendInvoice(user: User, input: InvoiceInput): Promise<{ invoice: InvoiceRow; warning?: string }> {
    if (!user.businessId || !user.handle) throw new SetupError('Set up your pay link first.')
    const toEmail = clean(input.toEmail, 254).toLowerCase()
    if (!EMAIL.test(toEmail)) throw new SetupError('Who is it for? An email address.', 'to_email')
    const description = clean(input.description, 500)
    if (!description) throw new SetupError('Say what it is for.', 'description')
    const amount = Math.round(Number(input.amountUsd) * 100) / 100
    if (!Number.isFinite(amount) || amount < MIN_USD || amount > MAX_USD) throw new SetupError(`Amount must be between $${MIN_USD} and $${MAX_USD.toLocaleString('en-US')}.`, 'amount')
    const coin = input.coin && user.coins.includes(input.coin) ? input.coin : user.coins[0]
    if (!coin) throw new SetupError('Add a payout address in CoinPay first, then re-check coins.')
    if (input.recurrence && !RECURRENCES.includes(input.recurrence)) throw new SetupError(`Repeat must be one of ${RECURRENCES.join(', ')}.`, 'recurrence')
    const due = input.dueDate ? new Date(`${input.dueDate}T00:00:00Z`) : new Date()
    if (Number.isNaN(due.getTime())) throw new SetupError('Due date must look like 2026-11-30.', 'due_date')
    if (this.store.invoicesSince(user.handle, Date.now() - 3600_000) >= 60) throw new SetupError('That is a lot of invoices in an hour. Try again later.')
    const toName = clean(input.toName, 80)

    const client = await this.clientFor(user.sub)
    const made = await client.call<{ client: { id: string } }>('POST', '/api/clients', { business_id: user.businessId, email: toEmail, ...(toName ? { name: toName } : {}) })
    const created = await client.call<{ invoice: { id: string; invoice_number?: string } }>(
      'POST',
      '/api/invoices',
      {
        business_id: user.businessId,
        client_id: made.client.id,
        currency: 'USD',
        amount,
        crypto_currency: walletCode(coin),
        due_date: due.toISOString(),
        notes: description,
        ...(input.recurrence ? { schedule: { recurrence: input.recurrence } } : {}),
      },
      { 'idempotency-key': randomBytes(16).toString('hex') },
    )
    const id = created.invoice.id
    const action = input.email === false ? 'publish' : 'send'
    const sent = await client.call<{ paymentLink?: string; warning?: string; invoice?: { invoice_number?: string } }>('POST', `/api/invoices/${encodeURIComponent(id)}/${action}`)
    this.store.addInvoice({
      id,
      handle: user.handle,
      number: String(sent.invoice?.invoice_number ?? created.invoice.invoice_number ?? ''),
      toEmail,
      toName,
      description,
      amountUsd: amount,
      coin,
      dueDate: due.toISOString().slice(0, 10),
      recurrence: input.recurrence ?? null,
      status: 'sent',
      payUrl: sent.paymentLink ?? `${this.config.coinpayBase}/now/${id}`,
    })
    return { invoice: this.store.invoice(id)!, ...(sent.warning ? { warning: sent.warning } : {}) }
  }

  /** An invoice and, while it is open, what to send where; CoinPay's invoice view is public. */
  async followInvoice(id: string): Promise<{ invoice: InvoiceRow; live: InvoiceLive | null } | null> {
    const row = this.store.invoice(id)
    if (!row) return null
    try {
      const body = await new CoinPay({ base: this.config.coinpayBase, ...(this.config.fetch ? { fetch: this.config.fetch } : {}) }).call<{ invoice: any }>('GET', `/api/invoices/${encodeURIComponent(id)}/pay`)
      const inv = body.invoice ?? {}
      const status = String(inv.status ?? row.status)
      if (status !== row.status) this.store.setInvoiceStatus(id, status)
      return {
        invoice: this.store.invoice(id)!,
        live: { status, amountCrypto: String(inv.crypto_amount ?? ''), address: String(inv.payment_address ?? ''), number: String(inv.invoice_number ?? row.number) },
      }
    } catch {
      // CoinPay unreachable: show what we last knew.
      return { invoice: row, live: null }
    }
  }

  /** A payment's status, asked of CoinPay when it is still open (the webhook may not reach us for a business we do not own). */
  async follow(id: string): Promise<PaymentRow | null> {
    const row = this.store.payment(id)
    if (!row) return null
    if (FINAL.has(row.status)) return row
    const coinpay = new CoinPay({ base: this.config.coinpayBase, ...(this.config.fetch ? { fetch: this.config.fetch } : {}) })
    try {
      if (row.sessionId) {
        // The session's public view: open, paid or expired.
        const s = await coinpay.checkoutSession(row.sessionId)
        if (s.status === 'paid') this.store.settle(id, { status: 'confirmed', paymentId: s.paymentId ?? '', coin: s.paidMethod ? s.paidMethod.toLowerCase() : '' })
        else if (s.status === 'expired' || s.status === 'canceled' || s.status === 'cancelled') this.store.setStatus(id, 'expired')
      } else {
        const fresh = await coinpay.payment(id)
        if (fresh.status && fresh.status !== row.status) this.store.setStatus(id, fresh.status)
      }
    } catch {
      // CoinPay unreachable: show what we last knew.
    }
    return this.store.payment(id)
  }
}

/** How often CoinPay can send an invoice again by itself. */
export const RECURRENCES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const
export type Recurrence = (typeof RECURRENCES)[number]

export type InvoiceInput = {
  toEmail: string
  toName?: string
  description: string
  amountUsd: number
  coin?: string
  /** YYYY-MM-DD; today when left out. */
  dueDate?: string
  recurrence?: Recurrence
  /** false: publish the pay link without CoinPay emailing it. */
  email?: boolean
}

/** What the payer needs to pay an invoice now, read from CoinPay's public invoice view. */
export type InvoiceLive = { status: string; amountCrypto: string; address: string; number: string }

/** The site the money is for, on every checkout session. */
export const PROPERTY = 'pay.agent.pit.world'
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)

export const FINAL = new Set(['confirmed', 'forwarded', 'completed', 'expired', 'failed', 'refunded'])
export const PAID = new Set(['confirmed', 'forwarded', 'completed'])
