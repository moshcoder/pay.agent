import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, chmodSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { UnlockStore } from '@profullstack/sealed-secrets'
import { Sealer, Store } from '../src/db.ts'
import { handleHandoffRequest, privateDirProblem, startHandoffSocket } from '../src/handoff.ts'
import { TokenVault } from '../src/vault.ts'

// Deploy handoff: the outgoing process gives its in-memory unlocks to the new
// one over a private Unix socket, keeping each original expiry.

const TOKENS = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_900_000_000 }
let clock = 1_800_000_000_000
const now = () => clock

function proc(store?: Store) {
  const s = store ?? new Store(':memory:', new Sealer('test-key-0123456789abcdef'))
  s.upsertUser('sub-a', 'A', 'a@example.com')
  return { store: s, vault: new TokenVault(s, { sessions: new UnlockStore({ now, useTimers: false }), log: () => {} }) }
}

// Two "processes" sharing one SQLite file (the sealed tokens persist; the keys do not).
function pair() {
  const old = proc()
  const fresh = { store: old.store, vault: new TokenVault(old.store, { sessions: new UnlockStore({ now, useTimers: false }), log: () => {} }) }
  return { old, fresh }
}

const scratch: string[] = []
function privDir() {
  const base = join(homedir(), '.cache')
  mkdirSync(base, { recursive: true })
  const d = mkdtempSync(join(base, 'payagent-handoff-test-'))
  chmodSync(d, 0o700)
  scratch.push(d)
  return d
}
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('vault handoff: export / import', () => {
  test('import keeps the ORIGINAL expiry, the tokens open, and it is never extended', async () => {
    const { old, fresh } = pair()
    const { expiresAt } = await old.vault.unlock('sub-a', TOKENS, 3600)
    clock += 600_500 // ten minutes and a half second later
    const exp = await handleHandoffRequest(old.vault, '{"op":"export"}', now)
    expect(exp.ok).toBe(true)
    const sessions = (exp as { sessions: unknown[] }).sessions
    expect(sessions).toHaveLength(1)
    const imp = await handleHandoffRequest(fresh.vault, JSON.stringify({ op: 'import', sessions }), now)
    expect(imp).toEqual({ ok: true, imported: 1, skipped: 0 })
    const got = fresh.vault.status('sub-a')
    expect(got.unlocked).toBe(true)
    expect(Date.parse(got.expiresAt!)).toBeLessThanOrEqual(Date.parse(expiresAt!))
    expect(Date.parse(expiresAt!) - Date.parse(got.expiresAt!)).toBeLessThan(1000)
    expect(await fresh.vault.read('sub-a')).toEqual(TOKENS)
  })

  test('refuses an unlock with under a minute left', async () => {
    const { old, fresh } = pair()
    await old.vault.unlock('sub-a', TOKENS, 3600)
    clock += 3600_000 - 59_000
    const { sessions } = (await handleHandoffRequest(old.vault, '{"op":"export"}', now)) as { sessions: unknown[] }
    expect(await handleHandoffRequest(fresh.vault, JSON.stringify({ op: 'import', sessions }), now)).toEqual({ ok: true, imported: 0, skipped: 1 })
    expect(fresh.vault.status('sub-a').unlocked).toBe(false)
  })

  test('refuses a key that does not open the sealed tokens, and junk', async () => {
    const { old, fresh } = pair()
    await old.vault.unlock('sub-a', TOKENS, 3600)
    const bad = [
      { sub: 'sub-a', dek: Buffer.alloc(32, 7).toString('base64'), expiresAt: clock + 3600_000 },
      { sub: 'nobody', dek: Buffer.alloc(32, 7).toString('base64'), expiresAt: clock + 3600_000 },
      { sub: 'sub-a', dek: 'short', expiresAt: clock + 3600_000 },
      null,
    ]
    expect(await handleHandoffRequest(fresh.vault, JSON.stringify({ op: 'import', sessions: bad }), now)).toEqual({ ok: true, imported: 0, skipped: 4 })
    expect(fresh.vault.status('sub-a').unlocked).toBe(false)
    expect(await handleHandoffRequest(fresh.vault, 'not json')).toEqual({ ok: false, error: 'bad json' })
    expect(await handleHandoffRequest(fresh.vault, '{"op":"nope"}')).toEqual({ ok: false, error: 'unknown op' })
  })

  test('a locked owner is not exported', async () => {
    const { old } = pair()
    await old.vault.unlock('sub-a', TOKENS, 3600)
    old.vault.lock('sub-a')
    expect(old.vault.exportSessions()).toEqual([])
  })
})

describe('vault handoff: the socket', () => {
  test('PAYAGENT_HANDOFF=off starts no socket', () => {
    const { vault } = proc()
    expect(startHandoffSocket(vault, { path: join(privDir(), 'h.sock'), env: { PAYAGENT_HANDOFF: 'off' }, log: () => {} })).toBeNull()
  })

  test('refuses a symlinked, shared or foreign-owned directory', () => {
    const real = privDir()
    const link = `${real}-link`
    symlinkSync(real, link)
    scratch.push(link)
    const logs: string[] = []
    const { vault } = proc()
    expect(startHandoffSocket(vault, { path: join(link, 'h.sock'), env: {}, log: (l) => logs.push(l) })).toBeNull()
    expect(logs.join()).toContain('symlink')
    const open = privDir()
    chmodSync(open, 0o755)
    expect(startHandoffSocket(vault, { path: join(open, 'h.sock'), env: {}, log: () => {} })).toBeNull()
    expect(privateDirProblem(real, (process.getuid?.() ?? 0) + 1)).toBe('is owned by another user')
    expect(privateDirProblem(real)).toBeNull()
  })

  test('round trip over the socket', async () => {
    clock = Date.now() // the socket uses the real clock
    const { old, fresh } = pair()
    await old.vault.unlock('sub-a', TOKENS, 3600)
    const dir = privDir()
    const ask = (path: string, line: string) =>
      new Promise<string>((resolve, reject) => {
        let out = ''
        const c = connect(path, () => c.write(`${line}\n`))
        c.setEncoding('utf8')
        c.on('data', (d) => (out += d))
        c.on('end', () => resolve(out))
        c.on('error', reject)
      })
    const a = startHandoffSocket(old.vault, { path: join(dir, 'a.sock'), env: {}, log: () => {} })!
    const b = startHandoffSocket(fresh.vault, { path: join(dir, 'b.sock'), env: {}, log: () => {} })!
    await new Promise((r) => setTimeout(r, 50))
    const exported = await ask(join(dir, 'a.sock'), '{"op":"export"}')
    const reply = JSON.parse(await ask(join(dir, 'b.sock'), exported.trim().replace(/^\{"ok":true,/, '{"op":"import",')))
    expect(reply).toEqual({ ok: true, imported: 1, skipped: 0 })
    expect(await fresh.vault.read('sub-a')).toEqual(TOKENS)
    a.close()
    b.close()
  })
})
