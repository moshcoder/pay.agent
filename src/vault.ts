/**
 * Unlock-on-use for the CoinPay tokens pay.agent acts with (fleet rule,
 * 2026-10-28: no key stored on our servers may open a user's credentials).
 *
 * Signing in with CoinPay IS the unlock: the fresh tokens are sealed under a
 * random 32-byte data key that exists only in this process (an UnlockStore
 * session with a TTL), and the sealed copy goes to SQLite so refresh-token
 * rotation survives within the session. Nothing on disk opens it. A restart,
 * the TTL or the Lock button drops the key, and from then on that person's
 * pay link, invoices and API calls answer "locked" (HTTP 423) until they sign
 * in again. Nothing crashes and nothing falls back to an operator key.
 */
import {
  createSealer,
  randomBytes,
  wipe,
  UnlockStore,
  UNLOCK_MAX_TTL_SECONDS,
  type CipherBlob,
} from '@profullstack/sealed-secrets'
import type { Store, Tokens } from './db.js'

/** Pay links have to keep working while the owner is away, so a sign-in unlocks for the longest allowed TTL unless they pick less. */
export const SIGN_IN_TTL_SECONDS = UNLOCK_MAX_TTL_SECONDS

/** An unlock handed over on deploy with less than this left is refused (the owner signs in again). */
export const HANDOFF_MIN_REMAINING_SECONDS = 60

export type HandoffSession = { sub: string; dek: string; expiresAt: number }

export class LockedError extends Error {
  readonly locked = true
  constructor(message = 'locked: the owner of this pay link needs to sign in to pay.agent again to resume') {
    super(message)
  }
}

export function legacyKeyMigrationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.LEGACY_KEY_MIGRATION ?? '').trim().toLowerCase() !== 'off'
}

export class TokenVault {
  readonly sessions: UnlockStore
  private readonly sealer = createSealer({ app: 'payagent', scope: 'coinpay_tokens' })
  /** Who is unlocked right now (UnlockStore cannot list its sessions), for the deploy handoff. */
  private readonly unlocked = new Set<string>()

  constructor(
    private readonly store: Store,
    private readonly opts: { legacyMigration?: boolean; sessions?: UnlockStore; log?: (line: string) => void } = {},
  ) {
    this.sessions = opts.sessions ?? new UnlockStore()
    this.sessions.onChange((sub, unlocked) => {
      if (unlocked) {
        this.unlocked.add(sub)
        return
      }
      this.unlocked.delete(sub)
      const handle = this.store.user(sub)?.handle
      ;(this.opts.log ?? console.log)(`pay.agent: ${handle ?? 'an account'} locked; its pay link pauses until the owner signs in again`)
    })
  }

  /** A sign-in: seal these tokens under a new in-memory key for `ttlSeconds`. Drops any legacy copy. */
  async unlock(sub: string, tokens: Tokens, ttlSeconds: number = SIGN_IN_TTL_SECONDS): Promise<{ expiresAt: string | null }> {
    const dek = randomBytes(32)
    try {
      const blob = await this.sealer.sealJson(dek, tokens, sub)
      this.store.saveSealedTokens(sub, JSON.stringify(blob))
      this.store.clearLegacyTokens(sub)
      return this.sessions.unlock(sub, dek, ttlSeconds)
    } finally {
      wipe(dek)
    }
  }

  /** The person's tokens, or LockedError. Callers drop the result after the request. */
  async read(sub: string): Promise<Tokens> {
    const dek = this.sessions.get(sub)
    if (!dek) {
      // One-shot migration of a pre-2026-10-28 row: open the legacy copy once,
      // move it into an in-memory session, and NULL it. Closed by LEGACY_KEY_MIGRATION=off.
      if (this.opts.legacyMigration && this.store.hasLegacyTokens(sub)) {
        const legacy = this.store.legacyTokens(sub)
        if (legacy) {
          await this.unlock(sub, legacy)
          return legacy
        }
      }
      throw new LockedError()
    }
    const raw = this.store.sealedTokens(sub)
    if (!raw) throw new LockedError()
    return this.sealer.unsealJson<Tokens>(dek, JSON.parse(raw) as CipherBlob, sub)
  }

  /** Writes rotated tokens back under the same in-memory key. */
  async write(sub: string, tokens: Tokens): Promise<void> {
    const dek = this.sessions.get(sub)
    if (!dek) throw new LockedError()
    this.store.saveSealedTokens(sub, JSON.stringify(await this.sealer.sealJson(dek, tokens, sub)))
  }

  /** Change how long the current unlock lasts (the owner picks; clamped to 60 s..7 d). */
  extend(sub: string, ttlSeconds: number): { unlocked: boolean; expiresAt: string | null } {
    const dek = this.sessions.get(sub)
    if (!dek) return { unlocked: false, expiresAt: null }
    const copy = new Uint8Array(dek)
    try {
      return this.sessions.unlock(sub, copy, ttlSeconds)
    } finally {
      wipe(copy)
    }
  }

  lock(sub: string): void {
    this.sessions.lock(sub)
    this.store.saveSealedTokens(sub, null)
  }

  /**
   * Deploy handoff (src/handoff.ts): every live unlock with its ORIGINAL expiry.
   * The keys are base64 copies for one JSON line over a private socket; never log them.
   */
  exportSessions(): HandoffSession[] {
    const out: HandoffSession[] = []
    for (const sub of [...this.unlocked]) {
      const dek = this.sessions.get(sub)
      const { expiresAt } = this.sessions.status(sub)
      if (!dek || !expiresAt) continue
      out.push({ sub, dek: Buffer.from(dek).toString('base64'), expiresAt: Date.parse(expiresAt) })
    }
    return out
  }

  /**
   * Take one unlock from the previous process. Keeps its expiry (rounded DOWN
   * to the second, so it is never extended), refuses one with under a minute
   * left, one already unlocked here, and a key that does not open this
   * person's sealed tokens. The caller wipes `dek`.
   */
  async importSession(sub: string, dek: Uint8Array, expiresAt: number, now: number = Date.now()): Promise<boolean> {
    if (!sub || dek.length !== 32 || !Number.isFinite(expiresAt)) return false
    const ttlSeconds = Math.floor((expiresAt - now) / 1000)
    if (ttlSeconds < HANDOFF_MIN_REMAINING_SECONDS) return false
    if (this.sessions.get(sub)) return false
    const raw = this.store.sealedTokens(sub)
    if (!raw) return false
    try {
      await this.sealer.unsealJson<Tokens>(dek, JSON.parse(raw) as CipherBlob, sub)
    } catch {
      return false
    }
    const { expiresAt: got } = this.sessions.unlock(sub, dek, ttlSeconds)
    if (!got || Date.parse(got) > expiresAt) {
      this.sessions.lock(sub)
      return false
    }
    return true
  }

  status(sub: string): { unlocked: boolean; expiresAt: string | null } {
    return this.sessions.status(sub)
  }
}
