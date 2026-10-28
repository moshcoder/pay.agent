/**
 * `payagent mcp`: pay.agent for an agent, on stdio.
 *
 *   claude mcp add payagent -- bunx @profullstack/payagent mcp
 *
 * Paying needs no key: ask for a payment, pay it at the CoinPay checkout URL it
 * returns, then check it. PAYAGENT_KEY (pa_…) adds `my_payments`, `send_invoice` and `my_invoices`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { PayAgentClient } from './client.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const handle = z.string().min(2).max(31).describe('A pay.agent handle, e.g. alice (pay.agent/alice)')

export function createMcpServer(client = new PayAgentClient()): McpServer {
  const server: any = new McpServer({ name: 'pay.agent', version: VERSION })
  server.tool('lookup', 'Who a pay.agent handle belongs to and which coins they take.', { handle }, async ({ handle }: { handle: string }) => {
    try { return text(await client.user(handle)) } catch (e) { return failure(e) }
  })
  server.tool(
    'request_payment',
    'Start paying a pay.agent handle: returns checkout_url, a CoinPay hosted checkout open for an hour where the payer picks any coin the payee takes (or PayPal) and gets the exact amount and address. Pay it there, then call payment_status.',
    { handle, amount_usd: z.number().min(0.5).max(10000), payer_email: z.string().email().describe('The payer\'s email: CoinPay sends the receipt there'), note: z.string().max(140).optional() },
    async ({ handle, amount_usd, payer_email, note }: { handle: string; amount_usd: number; payer_email: string; note?: string }) => {
      try { return text(await client.pay(handle, amount_usd, payer_email, note)) } catch (e) { return failure(e) }
    },
  )
  server.tool('payment_status', 'A payment\'s status: pending, confirmed, forwarded or completed (paid), expired or failed.', { payment_id: z.string().min(1) }, async ({ payment_id }: { payment_id: string }) => {
    try { return text(await client.payment(payment_id)) } catch (e) { return failure(e) }
  })
  server.tool(
    'claim',
    'Claim your own pay.agent link with no browser, or get a new API key for the one you have. Signs in to CoinPay with COINPAY_TOKEN or COINPAY_EMAIL + COINPAY_PASSWORD from the environment and approves pay.agent as you (it can never move your funds). Returns the link and a pa_ key: set it as PAYAGENT_KEY.',
    { handle: handle.optional().describe('The handle to claim; leave out to get a new key for the one you have'), business_id: z.string().optional().describe('Take payments into this CoinPay business of yours instead of a new pay.agent one') },
    async ({ handle, business_id }: { handle?: string; business_id?: string }) => {
      try { return text(await client.claim({ ...(handle ? { handle } : {}), ...(business_id ? { mode: 'business' as const, businessId: business_id } : {}) })) } catch (e) { return failure(e) }
    },
  )
  server.tool('my_payments', 'Your own pay.agent link and the payments made to it (needs PAYAGENT_KEY).', {}, async () => {
    try { return text(await client.me()) } catch (e) { return failure(e) }
  })
  server.tool(
    'send_invoice',
    'Send an invoice from your pay.agent link (needs PAYAGENT_KEY). CoinPay emails the payer a link to pay the exact amount in crypto; recurrence makes CoinPay send the next ones itself.',
    {
      to_email: z.string().email(),
      to_name: z.string().max(80).optional(),
      description: z.string().min(1).max(500),
      amount_usd: z.number().min(0.5).max(10000),
      coin: z.string().optional().describe('e.g. usdc_sol; default: your first'),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      recurrence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']).optional(),
      email: z.boolean().optional().describe('false: make the pay link without emailing it'),
    },
    async (input: any) => {
      try { return text(await client.invoice(input)) } catch (e) { return failure(e) }
    },
  )
  server.tool('invoice_status', 'An invoice\'s status (sent, paid, overdue) and, while open, the address and exact amount.', { invoice_id: z.string().min(1) }, async ({ invoice_id }: { invoice_id: string }) => {
    try { return text(await client.invoiceStatus(invoice_id)) } catch (e) { return failure(e) }
  })
  server.tool('my_invoices', 'Invoices you sent from your pay.agent link (needs PAYAGENT_KEY).', {}, async () => {
    try { return text(await client.invoices()) } catch (e) { return failure(e) }
  })
  return server
}

export async function runMcp(client = new PayAgentClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
