/**
 * pay.agent's state: one SQLite file.
 *
 * A person is their CoinPay account (`sub`). We keep their handle, which
 * business their link pays and which coins it takes.
 *
 * Their CoinPay tokens are NOT openable by anything stored here: since
 * 2026-10-28 they are sealed under a random per-sign-in data key that lives
 * only in process memory (src/vault.ts). The `tokens` column is the legacy
 * copy sealed with PAYAGENT_KEY; it is only read by the one-shot migration
 * (while LEGACY_KEY_MIGRATION is not "off") and is NULLed when used or on the
 * owner's next sign-in.
 */
import { Database } from 'bun:sqlite'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type Mode = 'wallet' | 'business'

export type User = {
  sub: string
  handle: string | null
  name: string
  email: string
  mode: Mode | null
  businessId: string | null
  businessName: string | null
  /** What CoinPay can pay this link in: coins with a payout wallet. */
  coins: string[]
  /**
   * What the owner chose to take (coin ids, and `paypal` for PayPal and cards
   * through PayPal); null takes everything CoinPay can.
   */
  accepts: string[] | null
  /** Whether the business has PayPal (so cards) on CoinPay, as its last checkout showed; null until one did. */
  card: boolean | null
  apiKeyHash: string | null
  createdAt: number
}

export type PaymentRow = {
  id: string
  handle: string
  amountUsd: number
  coin: string
  amountCrypto: string
  address: string
  status: string
  note: string
  payer: string
  /** The payer's email: CoinPay's checkout session needs one (and sends the receipt there). */
  payerEmail: string
  /** The CoinPay hosted checkout session (cs_...) this payment was made through; '' for older address payments. */
  sessionId: string
  /** Where the payer pays: the session's page on CoinPay. */
  checkoutUrl: string
  /** The CoinPay payment that settled the session, once one did. */
  paymentId: string
  expiresAt: string | null
  createdAt: number
  updatedAt: number
}

/** An invoice: a CoinPay invoice sent as this person, plus what we show for it. */
export type InvoiceRow = {
  id: string
  handle: string
  number: string
  toEmail: string
  toName: string
  description: string
  amountUsd: number
  coin: string
  dueDate: string | null
  recurrence: string | null
  status: string
  payUrl: string
  createdAt: number
  updatedAt: number
}

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number }

/** Names a handle can never be: they are pages. */
export const RESERVED = new Set([
  'api', 'auth', 'me', 'start', 'help', 'p', 'pay', 'hooks', 'health', 'login', 'logout', 'signup', 'settings', 'admin',
  'about', 'terms', 'privacy', 'style', 'favicon', 'robots', 'static', 'public', 'assets', 'well-known', 'ring', 'mcp',
  'coinpay', 'payagent', 'invoice', 'invoices', 'pay-agent', 'agent', 'agents', 'support', 'docs', 'new', 'u', 'www', 'root', 'null', 'undefined',
])

export function validHandle(handle: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(handle)) return '2 to 30 letters, numbers, - or _, starting with a letter or number'
  if (RESERVED.has(handle)) return 'that one is taken'
  return null
}

export class Sealer {
  private readonly key: Buffer
  constructor(secret: string) {
    if (!secret || secret.length < 16) throw new Error('PAYAGENT_KEY must be set (32 random bytes, hex)')
    this.key = createHash('sha256').update(secret).digest()
  }
  seal(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.')
  }
  open(sealed: string): string {
    const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64'))
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv!)
    decipher.setAuthTag(tag!)
    return Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8')
  }
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')

export class Store {
  readonly db: Database
  constructor(path: string, readonly sealer: Sealer) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        sub TEXT PRIMARY KEY,
        handle TEXT UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        mode TEXT,
        business_id TEXT,
        business_name TEXT,
        coins TEXT NOT NULL DEFAULT '[]',
        tokens TEXT,
        webhook_secret TEXT,
        api_key_hash TEXT UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS users_business ON users(business_id);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, sub TEXT NOT NULL REFERENCES users(sub) ON DELETE CASCADE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, verifier TEXT NOT NULL, redirect_uri TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        amount_usd REAL NOT NULL,
        coin TEXT NOT NULL,
        amount_crypto TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        note TEXT NOT NULL DEFAULT '',
        payer TEXT NOT NULL DEFAULT '',
        expires_at TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payments_handle ON payments(handle, created_at DESC);
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        number TEXT NOT NULL DEFAULT '',
        to_email TEXT NOT NULL,
        to_name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        amount_usd REAL NOT NULL,
        coin TEXT NOT NULL,
        due_date TEXT,
        recurrence TEXT,
        status TEXT NOT NULL DEFAULT 'sent',
        pay_url TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS invoices_handle ON invoices(handle, created_at DESC);
    `)
    // Hosted checkout sessions (0.3.0): added to databases made before them.
    const cols = new Set((this.db.query('PRAGMA table_info(payments)').all() as { name: string }[]).map((c) => c.name))
    for (const col of ['payer_email', 'session_id', 'checkout_url', 'payment_id']) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE payments ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`)
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS payments_session ON payments(session_id) WHERE session_id != ''")
    // Unlock-on-use (2026-10-28): tokens sealed under an in-memory data key.
    const userCols = new Set((this.db.query('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name))
    if (!userCols.has('tokens_sealed')) this.db.exec('ALTER TABLE users ADD COLUMN tokens_sealed TEXT')
    if (!userCols.has('seal_version')) this.db.exec('ALTER TABLE users ADD COLUMN seal_version INTEGER NOT NULL DEFAULT 0')
    // Owner-chosen methods and card (0.7.0).
    if (!userCols.has('accepts')) this.db.exec('ALTER TABLE users ADD COLUMN accepts TEXT')
    if (!userCols.has('card')) this.db.exec('ALTER TABLE users ADD COLUMN card INTEGER')
  }

  private toUser(row: any): User | null {
    if (!row) return null
    return {
      sub: row.sub,
      handle: row.handle,
      name: row.name,
      email: row.email,
      mode: row.mode,
      businessId: row.business_id,
      businessName: row.business_name,
      coins: JSON.parse(row.coins || '[]'),
      accepts: row.accepts ? JSON.parse(row.accepts) : null,
      card: row.card === null || row.card === undefined ? null : Boolean(row.card),
      apiKeyHash: row.api_key_hash,
      createdAt: row.created_at,
    }
  }

  /** Creates or refreshes the account. Tokens are never passed here: see TokenVault. */
  upsertUser(sub: string, name: string, email: string, now = Date.now()): User {
    this.db
      .query(
        `INSERT INTO users (sub, name, email, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET name = excluded.name, email = excluded.email`,
      )
      .run(sub, name, email, now)
    return this.user(sub)!
  }

  user(sub: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE sub = ?').get(sub))
  }

  byHandle(handle: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE handle = ?').get(handle.toLowerCase()))
  }

  byBusiness(businessId: string): (User & { webhookSecret: string | null }) | null {
    const row: any = this.db.query('SELECT * FROM users WHERE business_id = ?').get(businessId)
    const user = this.toUser(row)
    return user ? { ...user, webhookSecret: row.webhook_secret ? this.sealer.open(row.webhook_secret) : null } : null
  }

  byApiKey(key: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE api_key_hash = ?').get(hashKey(key)))
  }

  handleTaken(handle: string, sub: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM users WHERE handle = ? AND sub != ?').get(handle, sub))
  }

  setup(sub: string, input: { handle: string; mode: Mode; businessId: string; businessName: string; coins: string[]; webhookSecret: string | null }): void {
    this.db
      .query('UPDATE users SET handle = ?, mode = ?, business_id = ?, business_name = ?, coins = ?, webhook_secret = COALESCE(?, webhook_secret) WHERE sub = ?')
      .run(input.handle, input.mode, input.businessId, input.businessName, JSON.stringify(input.coins), input.webhookSecret ? this.sealer.seal(input.webhookSecret) : null, sub)
  }

  setCoins(sub: string, coins: string[]): void {
    this.db.query('UPDATE users SET coins = ? WHERE sub = ?').run(JSON.stringify(coins), sub)
  }

  /** null: take everything CoinPay can. */
  setAccepts(sub: string, accepts: string[] | null): void {
    this.db.query('UPDATE users SET accepts = ? WHERE sub = ?').run(accepts ? JSON.stringify(accepts) : null, sub)
  }

  setCard(sub: string, card: boolean): void {
    this.db.query('UPDATE users SET card = ? WHERE sub = ?').run(card ? 1 : 0, sub)
  }

  setApiKey(sub: string, key: string): void {
    this.db.query('UPDATE users SET api_key_hash = ? WHERE sub = ?').run(hashKey(key), sub)
  }

  /** The tokens sealed under this person's in-memory data key (JSON CipherBlob), if any. */
  sealedTokens(sub: string): string | null {
    const row: any = this.db.query('SELECT tokens_sealed FROM users WHERE sub = ?').get(sub)
    return row?.tokens_sealed ?? null
  }

  saveSealedTokens(sub: string, blob: string | null): void {
    this.db.query('UPDATE users SET tokens_sealed = ?, seal_version = 2 WHERE sub = ?').run(blob, sub)
  }

  /** LEGACY: the pre-2026-10-28 copy under PAYAGENT_KEY. Only the one-shot migration reads it. */
  legacyTokens(sub: string): Tokens | null {
    const row: any = this.db.query('SELECT tokens FROM users WHERE sub = ?').get(sub)
    return row?.tokens ? JSON.parse(this.sealer.open(row.tokens)) : null
  }

  hasLegacyTokens(sub: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM users WHERE sub = ? AND tokens IS NOT NULL').get(sub))
  }

  clearLegacyTokens(sub: string): void {
    this.db.query('UPDATE users SET tokens = NULL WHERE sub = ?').run(sub)
  }

  /** How many accounts still have a legacy token copy (the cutoff report). */
  legacyTokenCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM users WHERE tokens IS NOT NULL').get() as { n: number }).n
  }

  deleteUser(sub: string): void {
    this.db.query('DELETE FROM users WHERE sub = ?').run(sub)
  }

  newSession(sub: string, now = Date.now()): string {
    const id = randomBytes(24).toString('base64url')
    this.db.query('INSERT INTO sessions (id, sub, created_at) VALUES (?, ?, ?)').run(hashKey(id), sub, now)
    return id
  }

  session(id: string | undefined, now = Date.now(), maxAgeMs = 30 * 86400_000): User | null {
    if (!id) return null
    const row: any = this.db.query('SELECT sub, created_at FROM sessions WHERE id = ?').get(hashKey(id))
    if (!row || now - row.created_at > maxAgeMs) return null
    return this.user(row.sub)
  }

  endSession(id: string | undefined): void {
    if (id) this.db.query('DELETE FROM sessions WHERE id = ?').run(hashKey(id))
  }

  saveState(state: string, verifier: string, redirectUri: string, now = Date.now()): void {
    this.db.query('DELETE FROM oauth_states WHERE created_at < ?').run(now - 15 * 60_000)
    this.db.query('INSERT INTO oauth_states (state, verifier, redirect_uri, created_at) VALUES (?, ?, ?, ?)').run(state, this.sealer.seal(verifier), redirectUri, now)
  }

  takeState(state: string, now = Date.now()): { verifier: string; redirectUri: string } | null {
    const row: any = this.db.query('DELETE FROM oauth_states WHERE state = ? RETURNING verifier, redirect_uri, created_at').get(state)
    if (!row || now - row.created_at > 15 * 60_000) return null
    return { verifier: this.sealer.open(row.verifier), redirectUri: row.redirect_uri }
  }

  private toPayment(row: any): PaymentRow | null {
    if (!row) return null
    return {
      id: row.id,
      handle: row.handle,
      amountUsd: row.amount_usd,
      coin: row.coin,
      amountCrypto: row.amount_crypto,
      address: row.address,
      status: row.status,
      note: row.note,
      payer: row.payer,
      payerEmail: row.payer_email ?? '',
      sessionId: row.session_id ?? '',
      checkoutUrl: row.checkout_url ?? '',
      paymentId: row.payment_id ?? '',
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  addPayment(p: Omit<PaymentRow, 'createdAt' | 'updatedAt' | 'payerEmail' | 'sessionId' | 'checkoutUrl' | 'paymentId'> & Partial<Pick<PaymentRow, 'payerEmail' | 'sessionId' | 'checkoutUrl' | 'paymentId'>>, now = Date.now()): void {
    this.db
      .query('INSERT OR IGNORE INTO payments (id, handle, amount_usd, coin, amount_crypto, address, status, note, payer, payer_email, session_id, checkout_url, payment_id, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.handle, p.amountUsd, p.coin, p.amountCrypto, p.address, p.status, p.note, p.payer, p.payerEmail ?? '', p.sessionId ?? '', p.checkoutUrl ?? '', p.paymentId ?? '', p.expiresAt, now, now)
  }

  bySession(sessionId: string): PaymentRow | null {
    if (!sessionId) return null
    return this.toPayment(this.db.query("SELECT * FROM payments WHERE session_id = ? AND session_id != ''").get(sessionId))
  }

  /** What a settled session tells us: the status, and which CoinPay payment and method paid it. */
  settle(id: string, s: { status: string; paymentId?: string; coin?: string }, now = Date.now()): void {
    this.db
      .query("UPDATE payments SET status = ?, payment_id = COALESCE(NULLIF(?, ''), payment_id), coin = COALESCE(NULLIF(?, ''), coin), updated_at = ? WHERE id = ?")
      .run(s.status, s.paymentId ?? '', s.coin ?? '', now, id)
  }

  payment(id: string): PaymentRow | null {
    return this.toPayment(this.db.query('SELECT * FROM payments WHERE id = ?').get(id))
  }

  setStatus(id: string, status: string, now = Date.now()): void {
    this.db.query('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
  }

  payments(handle: string, limit = 50): PaymentRow[] {
    return (this.db.query('SELECT * FROM payments WHERE handle = ? ORDER BY created_at DESC LIMIT ?').all(handle, limit) as any[]).map((r) => this.toPayment(r)!)
  }

  pendingCount(handle: string, sinceMs: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM payments WHERE handle = ? AND status = 'pending' AND created_at > ?").get(handle, sinceMs) as { n: number }).n
  }

  private toInvoice(row: any): InvoiceRow | null {
    if (!row) return null
    return {
      id: row.id,
      handle: row.handle,
      number: row.number,
      toEmail: row.to_email,
      toName: row.to_name,
      description: row.description,
      amountUsd: row.amount_usd,
      coin: row.coin,
      dueDate: row.due_date,
      recurrence: row.recurrence,
      status: row.status,
      payUrl: row.pay_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  addInvoice(i: Omit<InvoiceRow, 'createdAt' | 'updatedAt'>, now = Date.now()): void {
    this.db
      .query('INSERT OR IGNORE INTO invoices (id, handle, number, to_email, to_name, description, amount_usd, coin, due_date, recurrence, status, pay_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.id, i.handle, i.number, i.toEmail, i.toName, i.description, i.amountUsd, i.coin, i.dueDate, i.recurrence, i.status, i.payUrl, now, now)
  }

  invoice(id: string): InvoiceRow | null {
    return this.toInvoice(this.db.query('SELECT * FROM invoices WHERE id = ?').get(id))
  }

  setInvoiceStatus(id: string, status: string, now = Date.now()): void {
    this.db.query('UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id)
  }

  invoices(handle: string, limit = 50): InvoiceRow[] {
    return (this.db.query('SELECT * FROM invoices WHERE handle = ? ORDER BY created_at DESC LIMIT ?').all(handle, limit) as any[]).map((r) => this.toInvoice(r)!)
  }

  invoicesSince(handle: string, sinceMs: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM invoices WHERE handle = ? AND created_at > ?').get(handle, sinceMs) as { n: number }).n
  }
}
