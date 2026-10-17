/**
 * pay.agent's state: one SQLite file.
 *
 * A person is their CoinPay account (`sub`). We keep their handle, which
 * business their link pays, which coins it takes, and their CoinPay tokens,
 * encrypted with PAYAGENT_KEY (AES-256-GCM). The refresh token is single-use,
 * so the newest one is written back on every refresh.
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
  coins: string[]
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
  expiresAt: string | null
  createdAt: number
  updatedAt: number
}

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number }

/** Names a handle can never be: they are pages. */
export const RESERVED = new Set([
  'api', 'auth', 'me', 'start', 'help', 'p', 'pay', 'hooks', 'health', 'login', 'logout', 'signup', 'settings', 'admin',
  'about', 'terms', 'privacy', 'style', 'favicon', 'robots', 'static', 'public', 'assets', 'well-known', 'ring', 'mcp',
  'coinpay', 'payagent', 'pay-agent', 'agent', 'agents', 'support', 'docs', 'new', 'u', 'www', 'root', 'null', 'undefined',
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
  constructor(path: string, private readonly sealer: Sealer) {
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
    `)
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
      apiKeyHash: row.api_key_hash,
      createdAt: row.created_at,
    }
  }

  upsertUser(sub: string, name: string, email: string, tokens: Tokens, now = Date.now()): User {
    this.db
      .query(
        `INSERT INTO users (sub, name, email, tokens, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sub) DO UPDATE SET name = excluded.name, email = excluded.email, tokens = excluded.tokens`,
      )
      .run(sub, name, email, this.sealer.seal(JSON.stringify(tokens)), now)
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

  setApiKey(sub: string, key: string): void {
    this.db.query('UPDATE users SET api_key_hash = ? WHERE sub = ?').run(hashKey(key), sub)
  }

  tokens(sub: string): Tokens | null {
    const row: any = this.db.query('SELECT tokens FROM users WHERE sub = ?').get(sub)
    return row?.tokens ? JSON.parse(this.sealer.open(row.tokens)) : null
  }

  saveTokens(sub: string, tokens: Tokens): void {
    this.db.query('UPDATE users SET tokens = ? WHERE sub = ?').run(this.sealer.seal(JSON.stringify(tokens)), sub)
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
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  addPayment(p: Omit<PaymentRow, 'createdAt' | 'updatedAt'>, now = Date.now()): void {
    this.db
      .query('INSERT OR IGNORE INTO payments (id, handle, amount_usd, coin, amount_crypto, address, status, note, payer, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.handle, p.amountUsd, p.coin, p.amountCrypto, p.address, p.status, p.note, p.payer, p.expiresAt, now, now)
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
}
