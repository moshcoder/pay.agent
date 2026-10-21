/**
 * `payagent` with no arguments: pay someone from the terminal.
 *
 * Type a handle, Tab to the amount, Tab to your email (for the receipt), Enter
 * makes a CoinPay checkout and shows its link; open it to pay in any coin they
 * take (or PayPal). It then follows the status until it settles.
 */
import { createApp } from '@profullstack/hqtui'
import { PAID, PayAgentClient, type ApiPayment, type ApiUser } from './client.js'

export type Field = 'handle' | 'amount' | 'email'
export type TuiState = { field: Field; handle: string; amount: string; email: string; payee: ApiUser | null; payment: ApiPayment | null; busy: boolean; error: string | null }

export const initialState = (): TuiState => ({ field: 'handle', handle: '', amount: '', email: process.env.PAYAGENT_EMAIL ?? '', payee: null, payment: null, busy: false, error: null })

const ORDER: Field[] = ['handle', 'amount', 'email']

/** Pure key handling, testable without a terminal. */
export function onKey(s: TuiState, key: { name: string; key: string; char?: string }): 'lookup' | 'pay' | 'quit' | null {
  if (key.key === 'ctrl+c' || (key.name === 'escape' && !s.payment)) return 'quit'
  if (key.name === 'escape') return (s.payment = null), null
  if (key.name === 'tab' || key.name === 'down') {
    const next = ORDER[(ORDER.indexOf(s.field) + 1) % ORDER.length]!
    const leaving = s.field
    s.field = next
    return leaving === 'handle' ? 'lookup' : null
  }
  if (key.name === 'up') return (s.field = ORDER[(ORDER.indexOf(s.field) + ORDER.length - 1) % ORDER.length]!), null
  if (key.name === 'enter') return s.field === 'handle' ? ((s.field = 'amount'), 'lookup') : s.busy ? null : 'pay'
  const target = s.field
  if (key.name === 'backspace') s[target] = s[target].slice(0, -1)
  else if (key.char && key.char.length === 1 && !key.key.startsWith('ctrl+')) {
    if (target === 'amount' && !/[0-9.]/.test(key.char)) return null
    if (target !== 'email' && key.char === ' ') return null
    s[target] += key.char.toLowerCase()
  }
  return null
}

export async function runTui(client = new PayAgentClient()): Promise<void> {
  const s = initialState()
  const app = await createApp({ title: 'pay.agent', quitKeys: [] })
  const lookup = async () => {
    if (!s.handle) return
    s.error = null
    try {
      s.payee = await client.user(s.handle)
    } catch (e) {
      s.payee = null
      s.error = e instanceof Error ? e.message : String(e)
    }
    app.invalidate()
  }
  const follow = async (id: string) => {
    while (s.payment?.id === id && !['confirmed', 'forwarded', 'completed', 'expired', 'failed'].includes(s.payment.status)) {
      await new Promise((r) => setTimeout(r, 5000))
      try {
        const p = await client.payment(id)
        if (s.payment?.id === id) s.payment = p
      } catch {}
      app.invalidate()
    }
  }
  const pay = async () => {
    s.busy = true
    s.error = null
    app.invalidate()
    try {
      s.payment = await client.pay(s.handle, Number(s.amount), s.email.trim())
      void follow(s.payment.id)
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = false
      app.invalidate()
    }
  }
  app.on('key', (event: any) => {
    const action = onKey(s, event)
    if (action === 'quit') app.quit()
    else if (action === 'lookup') void lookup()
    else if (action === 'pay') void pay()
    app.invalidate()
  })
  app.render(({ ui, theme }: any) => {
    ui.row({ size: 1 }, (h: any) => {
      h.text(' pay.agent', { fg: theme.accent, bold: true, size: 11 })
      h.text('get paid, and pay, in crypto', { fg: theme.muted })
      h.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    const mark = (f: Field) => (s.field === f && !s.payment ? '▏' : '')
    ui.panel({ title: 'Pay', size: 5 }, (p: any) => {
      p.text(`to      pay.agent/${s.handle}${mark('handle')}${s.payee ? `   ${s.payee.name}` : ''}`, { fg: s.field === 'handle' ? theme.accent : theme.text })
      p.text(`amount  $${s.amount}${mark('amount')}`, { fg: s.field === 'amount' ? theme.accent : theme.text })
      p.text(`email   ${s.email}${mark('email')}   (for the receipt)`, { fg: s.field === 'email' ? theme.accent : theme.text })
    })
    ui.panel({ title: s.busy ? 'Asking CoinPay…' : s.payment ? `Payment ${s.payment.id}` : 'Send' }, (p: any) => {
      if (s.error) p.text(s.error, { fg: theme.danger ?? theme.accent })
      else if (!s.payment) p.text('Type a handle, Tab, an amount, Tab, your email, Enter.', { fg: theme.muted })
      else {
        const paid = PAID.includes(s.payment.status)
        p.text(paid ? 'Paid. Thank you.' : 'Open this link to pay on CoinPay (any coin they take, or PayPal):', { fg: paid ? theme.accent : theme.text, bold: true })
        if (!paid) p.text(s.payment.checkout_url, { fg: theme.text })
        p.text(`status: ${s.payment.status}${s.payment.expires_at ? `   open until ${s.payment.expires_at}` : ''}`, { fg: theme.muted })
        p.text(s.payment.status_url, { fg: theme.muted })
      }
    })
    ui.statusBar({ items: s.payment ? [{ key: 'Esc', label: 'new payment' }, { key: 'Ctrl+C', label: 'quit' }] : [{ key: 'Tab', label: 'next' }, { key: 'Enter', label: 'pay' }, { key: 'Esc', label: 'quit' }], right: [{ label: 'payments by CoinPay' }] })
  })
  await app.start()
}
