/**
 * What pay.agent does, apart from pages: talk to CoinPay as each person,
 * onboard them, and make and follow payments.
 */
import { randomBytes } from 'node:crypto'
import { COINS, CoinPay, CoinPayError, onboard, payableBy, payableCoins, readWebhook, walletCode, type CheckoutSession, type OnboardStep } from '@profullstack/coinpay-onboard'
import { refresh as refreshTokens } from '@profullstack/coinpay-onboard/oauth'
import { Webhooks, sqliteStore as webhookStore, type GuardOptions } from '@profullstack/webhooks'
import { LockedError, TokenVault, legacyKeyMigrationEnabled } from './vault.js'
import { validHandle, type InvoiceRow, type Mode, type PaymentRow, type Store, type User } from './db.js'

export type Config = {
  coinpayBase: string
  clientId: string
  clientSecret?: string
  /** The public origin CoinPay posts events to: https://pay.agent */
  webhookOrigin: string
  /** Checks on customer webhook URLs; tests allow private addresses. */
  webhookGuard?: GuardOptions
  fetch?: typeof fetch
  /** Tests inject one; serve() makes the real in-memory vault. */
  vault?: TokenVault
  /** Whether legacy PAYAGENT_KEY token copies may still be migrated (LEGACY_KEY_MIGRATION != off). */
  legacyKeyMigration?: boolean
}

export { LockedError }

/** HTTP status for an error from the service: 423 locked, 400 the caller's input, 502 CoinPay. */
export function errorStatus(e: unknown): 400 | 423 | 502 {
  if (e instanceof LockedError) return 423
  return e instanceof SetupError ? 400 : 502
}

/** What pay.agent tells its customers' webhooks about, for the payments and invoices of their link. */
export const WEBHOOK_EVENTS = ['payment.created', 'payment.paid', 'payment.expired', 'payment.failed', 'invoice.created', 'invoice.paid', 'invoice.overdue', 'invoice.cancelled']

export class SetupError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message)
  }
}

/** PayPal on a CoinPay checkout: PayPal accounts, and cards through PayPal's guest checkout. */
export const PAYPAL = 'paypal'

/** What a new link takes besides the owner's own coins: USDC where they already have an address on that chain. */
export const DEFAULT_STABLES = ['usdc_base', 'usdc_pol', 'usdc_sol']

const EVM_CODES = new Set(['ETH', 'POL', 'BNB', 'USDC', 'USDT', 'USDC_ETH', 'USDC_BASE', 'USDC_POL', 'USDT_ETH', 'USDT_POL'])
const SOLANA_CODES = new Set(['SOL', 'USDC_SOL', 'USDT_SOL'])
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/**
 * USDC a set of payout wallets could also take at an address it already has:
 * an EVM address takes USDC on Base, Polygon and Ethereum, a Solana address
 * takes USDC on Solana. Only for self-custody wallets: an exchange deposit
 * address may not credit a token or chain it was not made for.
 */
export function sameAddressStables(wallets: { cryptocurrency?: string; address: string }[], want: string[] = DEFAULT_STABLES): Record<string, string> {
  const code = (w: { cryptocurrency?: string }) => String(w.cryptocurrency ?? '').toUpperCase()
  const have = new Set(wallets.map(code))
  const evm = wallets.find((w) => EVM_CODES.has(code(w)) && EVM_ADDRESS.test(w.address.trim()))?.address.trim()
  const sol = wallets.find((w) => SOLANA_CODES.has(code(w)) && SOLANA_ADDRESS.test(w.address.trim()))?.address.trim()
  const out: Record<string, string> = {}
  for (const id of want) {
    const coin = COINS.find((c) => c.id === id)
    if (!coin || have.has(walletCode(id))) continue
    const address = coin.chain === 'SOL' ? sol : ['BASE', 'POL', 'ETH'].includes(coin.chain) ? evm : undefined
    if (address) out[id] = address
  }
  return out
}

/** The owner's choice as stored: known coin ids and paypal, deduped; 'all' (or nothing) is null. */
export function parseAccepts(input: unknown): string[] | null {
  if (input === null || input === undefined || input === 'all' || (Array.isArray(input) && input.length === 1 && input[0] === 'all')) return null
  const list = (Array.isArray(input) ? input : String(input).split(/[\s,]+/)).map((c) => String(c).trim().toLowerCase()).filter(Boolean)
  if (list.includes('card')) list.splice(list.indexOf('card'), 1, PAYPAL)
  const unknown = list.filter((c) => c !== PAYPAL && !COINS.some((k) => k.id === c))
  if (unknown.length) throw new SetupError(`Unknown coin${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. Use ${COINS.map((c) => c.id).join(', ')}, paypal (cards go through PayPal), or all.`, 'coins')
  if (!list.length) throw new SetupError('Pick at least one coin, or all.', 'coins')
  return [...new Set(list)]
}

/** What a link offers payers now: the coins it can be paid in that its owner takes, and whether cards (PayPal) are on. */
export function offered(u: Pick<User, 'coins' | 'accepts' | 'card'>): { coins: string[]; card: boolean | null } {
  const coins = u.accepts ? u.coins.filter((c) => u.accepts!.includes(c)) : u.coins
  return { coins, card: !u.accepts || u.accepts.includes(PAYPAL) ? u.card : false }
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
  /** Customer webhooks (@profullstack/webhooks): endpoints per account, durable delivery, secrets sealed with PAYAGENT_KEY. */
  readonly hooks: Webhooks

  /** Where this process keeps each person's CoinPay tokens unlocked (memory only). */
  readonly vault: TokenVault

  constructor(readonly store: Store, readonly config: Config) {
    this.vault = config.vault ?? new TokenVault(store, { legacyMigration: config.legacyKeyMigration ?? legacyKeyMigrationEnabled() })
    this.hooks = new Webhooks({
      store: webhookStore(store.db as never),
      source: 'https://pay.agent',
      eventTypes: WEBHOOK_EVENTS,
      secretBox: { seal: (s) => store.sealer.seal(s), open: (s) => store.sealer.open(s) },
      ...(config.webhookGuard ? { guard: config.webhookGuard } : {}),
      ...(config.fetch ? { fetchImpl: config.fetch } : {}),
      log: (m) => console.log(m),
    })
  }

  /** Tell the link owner's webhooks; never in the way of a payment. */
  private hook(handle: string, type: string, data: Record<string, unknown>, subject: string): void {
    const owner = this.store.byHandle(handle)
    if (!owner) return
    void this.hooks.emit(owner.sub, type, data, { subject }).catch((e) => console.error('pay.agent: webhook:', e instanceof Error ? e.message : e))
  }

  private paymentData(p: PaymentRow): Record<string, unknown> {
    const origin = this.config.webhookOrigin.replace(/\/+$/, '')
    return {
      id: p.id,
      handle: p.handle,
      amount_usd: p.amountUsd,
      status: p.status,
      coin: p.coin || null,
      note: p.note,
      payer: p.payer,
      ...(p.sessionId ? { session_id: p.sessionId } : {}),
      ...(p.paymentId ? { coinpay_payment_id: p.paymentId } : {}),
      checkout_url: p.checkoutUrl || `${origin}/p/${p.id}`,
      status_url: `${origin}/p/${p.id}`,
      created_at: new Date(p.createdAt).toISOString(),
    }
  }

  private invoiceData(i: InvoiceRow): Record<string, unknown> {
    const origin = this.config.webhookOrigin.replace(/\/+$/, '')
    return {
      id: i.id,
      number: i.number,
      handle: i.handle,
      to_email: i.toEmail,
      to_name: i.toName,
      description: i.description,
      amount_usd: i.amountUsd,
      coin: i.coin,
      due_date: i.dueDate,
      recurrence: i.recurrence,
      status: i.status,
      url: `${origin}/i/${i.id}`,
      coinpay_url: i.payUrl,
      created_at: new Date(i.createdAt).toISOString(),
    }
  }

  /** A payment row changed: payment.paid the first time it is paid, payment.expired / payment.failed when it ends unpaid. */
  private paymentMoved(before: PaymentRow, id: string): void {
    const after = this.store.payment(id)
    if (!after || after.status === before.status) return
    if (PAID.has(after.status)) {
      if (!PAID.has(before.status)) this.hook(after.handle, 'payment.paid', this.paymentData(after), `payment:${id}`)
    } else if (after.status === 'expired' || after.status === 'failed') {
      this.hook(after.handle, `payment.${after.status}`, this.paymentData(after), `payment:${id}`)
    }
  }

  /** Whether pay.agent can act for this person on CoinPay right now (unlocked, or a legacy copy still to migrate). */
  canAct(sub: string): boolean {
    return this.vault.status(sub).unlocked || ((this.config.legacyKeyMigration ?? legacyKeyMigrationEnabled()) && this.store.hasLegacyTokens(sub))
  }

  /** The owner's view of their unlock. A pending legacy copy counts as live (it migrates on first use). */
  access(sub: string): { unlocked: boolean; expiresAt: string | null } {
    const s = this.vault.status(sub)
    return s.unlocked ? s : { unlocked: this.canAct(sub), expiresAt: null }
  }

  /** Every account's webhooks go with the account. */
  async forget(sub: string): Promise<void> {
    this.vault.lock(sub)
    for (const e of await this.hooks.listEndpoints(sub)) await this.hooks.deleteEndpoint(sub, e.id)
    this.store.deleteUser(sub)
  }

  /**
   * A CoinPay client acting as this person, refreshing their token when it is
   * about to lapse. Throws LockedError while their tokens are locked (after a
   * restart, the TTL, or Lock): they sign in again to resume.
   */
  clientFor(sub: string): Promise<CoinPay> {
    const pending = this.refreshing.get(sub)
    if (pending) return pending
    const make = (token: string) => new CoinPay({ base: this.config.coinpayBase, token, ...(this.config.fetch ? { fetch: this.config.fetch } : {}) })
    // One refresh at a time per person: the refresh token is spent by using it.
    const job = this.vault
      .read(sub)
      .then(async (tokens) => {
        if (tokens.expiresAt - Date.now() > 60_000) return make(tokens.accessToken)
        if (!tokens.refreshToken) throw new SetupError('Your CoinPay sign-in has expired. Sign in again.')
        const next = await refreshTokens({
          refreshToken: tokens.refreshToken,
          clientId: this.config.clientId,
          ...(this.config.clientSecret ? { clientSecret: this.config.clientSecret } : {}),
          base: this.config.coinpayBase,
          ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
        })
        await this.vault.write(sub, { accessToken: next.accessToken, refreshToken: next.refreshToken ?? tokens.refreshToken, expiresAt: next.expiresAt })
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
  async setup(user: User, input: { handle: string; mode: Mode; businessId?: string; addresses?: Record<string, string>; accepts?: string[] | null; stablecoins?: boolean }): Promise<{ steps: OnboardStep[]; coins: string[] }> {
    const accepts = input.accepts === undefined ? null : input.accepts
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
      // Their own business is theirs to change: USDC is added to it only when they ask.
      const steps = input.stablecoins === true ? [...r.steps, ...(await this.addStables(client, business.id))] : r.steps
      const coins = input.stablecoins === true ? sortCoins(payableCoins(await payableBy(client, business.id))) : sortCoins(r.coins.filter((c) => COINS.some((k) => k.id === c)))
      this.store.setup(user.sub, { handle, mode: 'business', businessId: business.id, businessName: business.name, coins, webhookSecret: null })
      this.store.setAccepts(user.sub, accepts)
      await this.refreshCard(client, user.sub, business.id)
      return { steps, coins }
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
    // New links take USDC on Base, Polygon and Solana too wherever the owner
    // already has an address on that chain (on the pay.agent business only).
    const steps = input.stablecoins === false ? r.steps : [...r.steps, ...(await this.addStables(client, r.business.id))]
    const coins = input.stablecoins === false ? sortCoins(r.coins.filter((c) => COINS.some((k) => k.id === c))) : sortCoins(payableCoins(await payableBy(client, r.business.id)))
    this.store.setup(user.sub, { handle, mode: 'wallet', businessId: r.business.id, businessName: r.business.name, coins, webhookSecret: r.webhookSecret })
    this.store.setAccepts(user.sub, accepts)
    await this.refreshCard(client, user.sub, r.business.id)
    return { steps, coins }
  }

  /** Adds the USDC the business's wallets can take at addresses they already have, as wallets of that business. */
  private async addStables(client: CoinPay, businessId: string): Promise<OnboardStep[]> {
    const [account, business] = await Promise.all([client.wallets('account').catch(() => []), client.wallets('business', businessId).catch(() => [])])
    const add = sameAddressStables([...business, ...account])
    const steps: OnboardStep[] = []
    for (const [coin, address] of Object.entries(add)) {
      try {
        await client.call('POST', `/api/businesses/${encodeURIComponent(businessId)}/wallets`, { cryptocurrency: walletCode(coin), wallet_address: address, is_active: true })
        steps.push({ step: `wallet:${coin}`, ok: true, detail: `${coinName(coin)} goes to ${address.slice(0, 6)}…${address.slice(-4)}, the address you already have on that chain` })
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        steps.push({ step: `wallet:${coin}`, ok: /exist|already|duplicate/i.test(message), detail: message })
      }
    }
    return steps
  }

  /** USDC at the owner's existing addresses (Base, Polygon, Solana), then a re-check. */
  async addStablecoins(user: User): Promise<{ steps: OnboardStep[]; coins: string[] }> {
    if (!user.businessId) throw new SetupError('Make your link first.')
    const client = await this.clientFor(user.sub)
    const steps = await this.addStables(client, user.businessId)
    return { steps, coins: await this.recheck(user) }
  }

  /** The owner picks what the link takes: coin ids and paypal, or null for everything CoinPay can. */
  setAccepts(user: User, input: unknown): { accepts: string[] | null; offered: { coins: string[]; card: boolean | null }; unavailable: string[] } {
    const accepts = parseAccepts(input)
    this.store.setAccepts(user.sub, accepts)
    const u = this.store.user(user.sub)!
    return { accepts, offered: offered(u), unavailable: (accepts ?? []).filter((c) => c !== PAYPAL && !u.coins.includes(c)) }
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
    await this.refreshCard(client, user.sub, user.businessId)
    return coins
  }

  /**
   * Whether the business takes cards: PayPal connected on CoinPay. Read from
   * CoinPay's PayPal status, which takes our OAuth token since CoinPay 0.6.17;
   * a checkout still updates it too. Left as it was when CoinPay cannot say.
   */
  private async refreshCard(client: CoinPay, sub: string, businessId: string): Promise<void> {
    try {
      const status = (await client.call('GET', `/api/paypal/connect/status/${encodeURIComponent(businessId)}`)) as { success?: boolean; connected?: boolean } | null
      if (status?.success === true && typeof status.connected === 'boolean') this.store.setCard(sub, status.connected)
    } catch {
      // Older CoinPay (403 to OAuth) or a blip: the next checkout tells us.
    }
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
    // The owner's choice, as CoinPay method codes; none set offers everything.
    const takes = offered(payee)
    const allowedMethods = payee.accepts ? [...takes.coins.map(walletCode), ...(payee.accepts.includes(PAYPAL) ? ['PAYPAL'] : [])] : undefined
    if (allowedMethods && !allowedMethods.length) throw new SetupError('This link takes nothing right now: its owner has no wallet for the coins they picked.')
    const client = await this.clientFor(payee.sub)
    const session: CheckoutSession = await client.createCheckoutSession({
      ...(allowedMethods ? { allowedMethods } : {}),
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
    // Whether cards work is only visible on a checkout: PayPal is there when the business connected it.
    if (!payee.accepts || payee.accepts.includes(PAYPAL)) {
      const card = session.methods.some((m) => m.toUpperCase() === 'PAYPAL')
      if (card !== payee.card) this.store.setCard(payee.sub, card)
    }
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
    const made = this.store.payment(id)!
    this.hook(payee.handle, 'payment.created', this.paymentData(made), `payment:${id}`)
    return made
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
      this.paymentMoved(row, row.id)
      return { matched: true, paid: true }
    }
    if (PAID.has(row.status)) return { matched: true, paid: true }
    // One session can see a payment expire (the payer switched coins) and still
    // be paid; the session itself says when it is over, so we ask it in follow().
    if (!fromSession) {
      const status = w.status || w.type.replace(/^payment\./, '')
      if (status) {
        this.store.setStatus(row.id, status)
        this.paymentMoved(row, row.id)
      }
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
    const invoice = this.store.invoice(id)!
    this.hook(user.handle, 'invoice.created', this.invoiceData(invoice), `invoice:${id}`)
    return { invoice, ...(sent.warning ? { warning: sent.warning } : {}) }
  }

  /** An invoice and, while it is open, what to send where; CoinPay's invoice view is public. */
  async followInvoice(id: string): Promise<{ invoice: InvoiceRow; live: InvoiceLive | null } | null> {
    const row = this.store.invoice(id)
    if (!row) return null
    // Paid and cancelled never change again: no need to ask.
    if (INVOICE_FINAL.has(row.status)) return { invoice: row, live: null }
    let status: string
    let inv: any = {}
    try {
      const body = await new CoinPay({ base: this.config.coinpayBase, ...(this.config.fetch ? { fetch: this.config.fetch } : {}) }).call<{ invoice: any }>('GET', `/api/invoices/${encodeURIComponent(id)}/pay`)
      inv = body.invoice ?? {}
      status = invoiceStatus(String(inv.status ?? row.status))
    } catch (e) {
      // The public view only shows sent, overdue and paid invoices. Every invoice we keep was sent,
      // so a 404 ("not available for payment", or deleted) means the merchant cancelled it.
      if (!(e instanceof CoinPayError && e.status === 404)) return { invoice: row, live: null } // CoinPay unreachable: show what we last knew.
      status = 'cancelled'
    }
    // Read again after the wait: two pages polling at once must not both report the change.
    const before = this.store.invoice(id)!
    if (status !== before.status) {
      this.store.setInvoiceStatus(id, status)
      const event = INVOICE_EVENTS[status]
      if (event) this.hook(before.handle, event, this.invoiceData(this.store.invoice(id)!), `invoice:${id}`)
    }
    const invoice = this.store.invoice(id)!
    if (INVOICE_FINAL.has(status)) return { invoice, live: null }
    return {
      invoice,
      live: { status, amountCrypto: String(inv.crypto_amount ?? ''), address: String(inv.payment_address ?? ''), number: String(inv.invoice_number ?? row.number) },
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
        // Read again after the wait: the webhook (or another poll) may have settled it meanwhile.
        const before = this.store.payment(id)!
        if (FINAL.has(before.status)) return before
        if (s.status === 'paid') this.store.settle(id, { status: 'confirmed', paymentId: s.paymentId ?? '', coin: s.paidMethod ? s.paidMethod.toLowerCase() : '' })
        else if (s.status === 'expired' || s.status === 'canceled' || s.status === 'cancelled') this.store.setStatus(id, 'expired')
        this.paymentMoved(before, id)
      } else {
        const fresh = await coinpay.payment(id)
        const before = this.store.payment(id)!
        if (fresh.status && fresh.status !== before.status && !FINAL.has(before.status)) {
          this.store.setStatus(id, fresh.status)
          this.paymentMoved(before, id)
        }
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

/** Invoice statuses CoinPay reports, and the event each one sends. */
const INVOICE_EVENTS: Record<string, string> = { paid: 'invoice.paid', overdue: 'invoice.overdue', cancelled: 'invoice.cancelled' }
/** Invoice statuses that never change again. */
export const INVOICE_FINAL = new Set(['paid', 'cancelled'])
/** CoinPay's invoice status, spelled one way. */
const invoiceStatus = (s: string) => (s.toLowerCase() === 'canceled' ? 'cancelled' : s.toLowerCase())

export const FINAL = new Set(['confirmed', 'forwarded', 'completed', 'expired', 'failed', 'refunded'])
export const PAID = new Set(['confirmed', 'forwarded', 'completed'])
