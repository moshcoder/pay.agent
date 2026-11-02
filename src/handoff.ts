/**
 * Deploy handoff for pay.agent's in-memory unlocks (src/vault.ts).
 *
 * Each owner's CoinPay tokens are sealed under a per-sign-in key that lives in
 * this process only, so a restart used to pause every pay link (423 "locked")
 * until its owner signed in again. Now bin/deploy.sh asks the running process
 * for its unlocks just before the restart, holds them in a shell variable
 * (never on disk) and gives them to the new process once /health answers
 * (scripts/vault-handoff.sh).
 *
 * The channel is a Unix socket in a private 0700 directory owned by this
 * process's user (socket 0600), never a shared directory like /tmp: whoever can
 * reach it can already read this process's memory. Imported unlocks keep their
 * ORIGINAL expiry and are never extended; under a minute left is refused.
 * PAYAGENT_HANDOFF=off turns the socket off.
 *
 * Protocol: one JSON line in, one JSON line out.
 *   {"op":"export"}                  -> {"ok":true,"sessions":[{sub,dek,expiresAt}]}
 *   {"op":"import","sessions":[...]} -> {"ok":true,"imported":n,"skipped":m}
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HandoffSession, TokenVault } from './vault.js'

export const DEFAULT_HANDOFF_SOCKET = join(homedir(), '.payagent-vault', 'handoff.sock')
const MAX_LINE = 4 * 1024 * 1024

type Reply =
  | { ok: true; sessions: HandoffSession[] }
  | { ok: true; imported: number; skipped: number }
  | { ok: false; error: string }

export function handoffEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.PAYAGENT_HANDOFF ?? '').trim().toLowerCase() !== 'off'
}

export async function handleHandoffRequest(vault: TokenVault, line: string, now: () => number = Date.now): Promise<Reply> {
  let req: { op?: unknown; sessions?: unknown }
  try {
    req = JSON.parse(line)
  } catch {
    return { ok: false, error: 'bad json' }
  }
  if (req?.op === 'export') return { ok: true, sessions: vault.exportSessions() }
  if (req?.op === 'import') {
    if (!Array.isArray(req.sessions)) return { ok: false, error: 'sessions missing' }
    let imported = 0
    let skipped = 0
    for (const s of req.sessions as Array<Partial<HandoffSession> | null>) {
      const dek = new Uint8Array(Buffer.from(String(s?.dek ?? ''), 'base64'))
      try {
        if (await vault.importSession(String(s?.sub ?? ''), dek, Number(s?.expiresAt), now())) imported += 1
        else skipped += 1
      } catch {
        skipped += 1
      } finally {
        dek.fill(0)
      }
    }
    console.log(`pay.agent: ${imported} unlock(s) handed over from the previous process (${skipped} skipped)`)
    return { ok: true, imported, skipped }
  }
  return { ok: false, error: 'unknown op' }
}

/** Why `dir` is not safe for the socket, or null when it is: a real directory, ours, 0700. */
export function privateDirProblem(dir: string, uid: number | undefined = process.getuid?.()): string | null {
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return 'missing'
  }
  if (st.isSymbolicLink()) return 'is a symlink'
  if (!st.isDirectory()) return 'is not a directory'
  if (uid !== undefined && st.uid !== uid) return 'is owned by another user'
  if ((st.mode & 0o077) !== 0) return 'is reachable by other users'
  return null
}

/** Listen on the handoff socket. PAYAGENT_HANDOFF=off, or an unsafe directory, means no socket (null). */
export function startHandoffSocket(
  vault: TokenVault,
  opts: { path?: string; env?: Record<string, string | undefined>; log?: (line: string) => void } = {},
): Server | null {
  const env = opts.env ?? process.env
  const log = opts.log ?? console.error
  if (!handoffEnabled(env)) return null
  const path = opts.path ?? (env.PAYAGENT_HANDOFF_SOCKET || DEFAULT_HANDOFF_SOCKET)
  const dir = dirname(path)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    /* checked below */
  }
  const problem = privateDirProblem(dir)
  if (problem) {
    log(`pay.agent: handoff socket NOT started: ${dir} ${problem}`)
    return null
  }
  try {
    if (lstatSync(path).isSocket()) unlinkSync(path)
    else {
      log(`pay.agent: handoff socket NOT started: ${path} exists and is not a socket`)
      return null
    }
  } catch {
    /* no stale socket */
  }
  const server = createServer((conn) => {
    let buf = ''
    conn.setEncoding('utf8')
    conn.setTimeout(10_000, () => conn.destroy())
    conn.on('data', (chunk: string) => {
      buf += chunk
      if (buf.length > MAX_LINE) return conn.destroy()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      buf = ''
      conn.pause()
      handleHandoffRequest(vault, line).then(
        (reply) => conn.end(`${JSON.stringify(reply)}\n`),
        () => conn.end(`${JSON.stringify({ ok: false, error: 'failed' })}\n`),
      )
    })
    conn.on('error', () => conn.destroy())
  })
  server.on('error', (err) => log(`pay.agent: handoff socket error: ${err.message}`))
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {
      /* the directory is 0700 already */
    }
  })
  server.unref()
  return server
}
