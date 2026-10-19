/**
 * payagent: pay.agent from the terminal.
 *
 *   payagent                          the TUI
 *   payagent <handle> <usd> [coin]    pay someone: prints the address and exact amount
 *   payagent who <handle>             who they are and which coins they take
 *   payagent status <payment-id> [--wait]
 *   payagent me                       your link and payments (PAYAGENT_KEY)
 *   payagent invoice <email> <usd> <what for…> [--coin=x] [--due=YYYY-MM-DD] [--repeat=monthly] [--no-email]
 *   payagent invoices                 invoices you sent (PAYAGENT_KEY)
 *   payagent mcp                      MCP server on stdio
 *   payagent serve [--port N]         run your own pay.agent
 */
import { PAID, PayAgentClient } from './client.js'
import { VERSION } from './version.js'

export const HELP = `payagent ${VERSION}: get paid, and pay, in crypto (https://pay.agent)

  payagent                          interactive (TUI)
  payagent <handle> <usd> [coin]    pay someone: address + exact amount (coin e.g. usdc_sol)
  payagent who <handle>             their name and the coins they take
  payagent status <id> [--wait]     a payment's status; --wait until it settles
  payagent me                       your link and payments (PAYAGENT_KEY=pa_…)
  payagent invoice <email> <usd> <what for…>
           [--coin=usdc_sol] [--due=2026-11-30] [--repeat=monthly] [--no-email]
                                    send an invoice; CoinPay emails the pay link
  payagent invoices                 invoices you sent, and whether they are paid
  payagent invoice-status <id>      one invoice's status (public)
  payagent mcp                      MCP server: claude mcp add payagent -- bunx @profullstack/payagent mcp
  payagent serve [--port N]         run your own instance

  --json                            machine-readable output
  PAYAGENT_URL=https://…            another instance (default https://pay.agent.pit.world)
`

type Out = { log(text: string): void; error(text: string): void }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function main(argv = process.argv.slice(2), out: Out = console, client = new PayAgentClient()): Promise<number> {
  const json = argv.includes('--json')
  const wait = argv.includes('--wait')
  const args = argv.filter((a) => !a.startsWith('--'))
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const [command, ...rest] = args
  const show = (value: unknown, text: string) => out.log(json ? JSON.stringify(value, null, 2) : text)
  try {
    if (!command) {
      if (!process.stdout.isTTY) return out.log(HELP), 0
      const { runTui } = await import('./tui.js')
      await runTui(client)
      return 0
    }
    switch (command) {
      case 'help':
        out.log(HELP)
        return 0
      case 'version':
        out.log(VERSION)
        return 0
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp(client)
        return 0
      }
      case 'serve': {
        const i = argv.indexOf('--port')
        const { serve } = await import('./server.js')
        const s = serve(i >= 0 ? { port: Number(argv[i + 1]) } : {})
        out.log(`pay.agent listening on http://${s.hostname}:${s.port}`)
        return await new Promise<number>(() => {})
      }
      case 'who': {
        const u = await client.user(rest[0] ?? '')
        show(u, `${u.name || u.handle}  ${u.url}\ntakes: ${u.coins.join(', ') || 'nothing yet'}`)
        return 0
      }
      case 'me': {
        const me = await client.me()
        show(me, `${me.url}\n${me.payments.map((p) => `${p.created_at.slice(0, 16)}  $${p.amount_usd}  ${p.coin}  ${p.status}  ${p.note}`).join('\n') || 'no payments yet'}`)
        return 0
      }
      case 'invoice': {
        const [to, amount, ...what] = rest
        if (!to || !amount || !what.length) {
          out.error('usage: payagent invoice <email> <usd> <what for…> [--coin=x] [--due=YYYY-MM-DD] [--repeat=monthly] [--no-email]')
          return 2
        }
        const coin = flag('coin')
        const due = flag('due')
        const repeat = flag('repeat')
        const i = await client.invoice({ to_email: to, amount_usd: Number(amount), description: what.join(' '), ...(coin ? { coin } : {}), ...(due ? { due_date: due } : {}), ...(repeat ? { recurrence: repeat } : {}), ...(argv.includes('--no-email') ? { email: false } : {}) })
        show(i, `Invoice ${i.number} for $${i.amount_usd} to ${i.to_email ?? to}${i.recurrence ? `, repeats ${i.recurrence}` : ''}\n${i.url}${i.warning ? `\n${i.warning}` : ''}`)
        return 0
      }
      case 'invoices': {
        const r = await client.invoices()
        show(r, r.invoices.map((i) => `${i.created_at.slice(0, 10)}  ${i.number}  $${i.amount_usd}  ${i.to_email}  ${i.status}  ${i.description}`).join('\n') || 'no invoices yet')
        return 0
      }
      case 'invoice-status': {
        const i = await client.invoiceStatus(rest[0] ?? '')
        show(i, `${i.number || i.id}: ${i.status}  ${i.url}`)
        return 0
      }
      case 'status': {
        let p = await client.payment(rest[0] ?? '')
        while (wait && !['confirmed', 'forwarded', 'completed', 'expired', 'failed'].includes(p.status)) {
          await sleep(5000)
          p = await client.payment(p.id)
        }
        show(p, `${p.id}: ${PAID.includes(p.status) ? 'paid' : p.status}`)
        return PAID.includes(p.status) || !wait ? 0 : 1
      }
    }
    // payagent <handle> <usd> [coin] [note…]
    const [handle, usd, coin, ...note] = args
    if (!usd || !Number.isFinite(Number(usd))) {
      out.error(`payagent: unknown command "${command}"\n\n${HELP}`)
      return 2
    }
    const p = await client.pay(handle!, Number(usd), coin, note.join(' ') || undefined)
    show(p, `Send exactly ${p.amount_crypto} ${p.coin.toUpperCase()} to\n${p.address}\n\nGood until ${p.expires_at ?? 'an hour from now'}. Watch it: payagent status ${p.id} --wait\n${p.checkout_url}`)
    return 0
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
